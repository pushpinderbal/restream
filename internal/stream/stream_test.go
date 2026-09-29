package stream

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func waitState(t *testing.T, m *Manager, id string, want ...string) Session {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		s, err := m.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		for _, w := range want {
			if s.State == w {
				return s
			}
		}
		if s.State == "failed" {
			t.Fatalf("stream failed: %s", s.Error)
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %v", want)
	return Session{}
}

func TestFFmpegSessionLifecycle(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	encoderList, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
	if err != nil {
		t.Skip("cannot inspect ffmpeg encoders")
	}
	encoder := "libopenh264"
	if strings.Contains(string(encoderList), " libx264 ") {
		encoder = "libx264"
	} else if !strings.Contains(string(encoderList), " libopenh264 ") {
		t.Skip("no H.264 encoder")
	}
	video := filepath.Join(t.TempDir(), "source.mp4")
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-c:v", encoder, "-g", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", video)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fixture ffmpeg: %v: %s", err, out)
	}
	upstream := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(video))))
	defer upstream.Close()
	m, err := New(Config{MaxStreams: 1, SessionTTL: 20 * time.Second, TranscodeMode: "auto"}, func(ctx context.Context, item model.Item) (model.Source, error) {
		return model.Source{URL: upstream.URL + "/source.mp4", Duration: 90}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	mode, probed := m.probe(context.Background(), model.Source{URL: upstream.URL + "/source.mp4"})
	if mode != "copy" || probed < 7.5 || probed > 8.5 {
		t.Fatalf("probe: mode=%s duration=%v", mode, probed)
	}
	item := model.Item{ID: "v", Kind: "movie", Duration: 60}
	s, err := m.Start(context.Background(), item, 0)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != "starting" {
		t.Fatalf("initial state: %s", s.State)
	}
	if _, err = m.Start(context.Background(), item, 0); !errors.Is(err, ErrCapacity) {
		t.Fatalf("capacity: %v", err)
	}
	s = waitState(t, m, s.ID, "ready", "ended")
	if s.Duration < 7.5 || s.Duration > 8.5 {
		t.Fatalf("probed duration: %v", s.Duration)
	}
	media := httptest.NewServer(m.MediaHandler())
	defer media.Close()
	resp, err := http.Get(media.URL + s.URL)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("playlist status: %d", resp.StatusCode)
	}
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	resp.Body.Close()
	if !strings.Contains(string(buf[:n]), "seg-") {
		t.Fatal("no generated segments")
	}
	oldURL := s.URL
	s, err = m.Seek(context.Background(), s.ID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if s.Offset != 2 || s.URL == oldURL {
		t.Fatalf("bad seek result: %+v", s)
	}
	resp, err = http.Get(media.URL + oldURL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("stale generation status: %d", resp.StatusCode)
	}
	s = waitState(t, m, s.ID, "ended")
	resp, err = http.Get(media.URL + s.URL)
	if err != nil {
		t.Fatal(err)
	}
	n, _ = resp.Body.Read(buf)
	resp.Body.Close()
	if !strings.Contains(string(buf[:n]), "#EXT-X-ENDLIST") {
		t.Fatal("VOD playlist lacks end marker")
	}
	if err = m.Heartbeat(s.ID); err != nil {
		t.Fatal(err)
	}
	if err = m.Stop(s.ID); err != nil {
		t.Fatal(err)
	}
	if m.Active() != 0 {
		t.Fatal("slot not released")
	}
	if _, err = m.Get(s.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after stop: %v", err)
	}
	if _, err = m.Start(context.Background(), item, 0); err != nil {
		t.Fatalf("slot not reusable: %v", err)
	}
}

func TestFailureTTLAndMediaValidation(t *testing.T) {
	m, err := New(Config{MaxStreams: 1, SessionTTL: 300 * time.Millisecond}, func(context.Context, model.Item) (model.Source, error) {
		return model.Source{URL: "file:///etc/passwd"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s, err := m.Start(context.Background(), model.Item{Kind: "live"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, _ := m.Get(s.ID)
		if got.State == "failed" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, _ := m.Get(s.ID)
	if got.State != "failed" {
		t.Fatalf("state: %s", got.State)
	}
	if m.Active() != 0 {
		t.Fatal("failed session holds capacity")
	}
	replacement, err := m.Start(context.Background(), model.Item{Kind: "live"}, 0)
	if err != nil {
		t.Fatalf("failed session blocked replacement: %v", err)
	}
	if err := m.Stop(replacement.ID); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	m.MediaHandler().ServeHTTP(w, httptest.NewRequest("GET", "/api/streams/"+s.ID+"/2/../secret", nil))
	if w.Code != 404 {
		t.Fatalf("traversal status: %d", w.Code)
	}
	deadline = time.Now().Add(2 * time.Second)
	for m.Active() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if m.Active() != 0 {
		t.Fatal("abandoned stream did not expire")
	}
	if _, err := os.Stat(filepath.Join(m.dir, s.ID)); !os.IsNotExist(err) {
		t.Fatalf("session files remain: %v", err)
	}
}

func TestStartupDiagnosticsDoNotExposeProviderData(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)

	const secret = "private-stream-token-987"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("source header missing")
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer upstream.Close()
	m, err := New(Config{MaxStreams: 1, SessionTTL: time.Minute}, func(context.Context, model.Item) (model.Source, error) {
		return model.Source{URL: upstream.URL + "/video.m3u8?token=" + secret, Headers: map[string]string{"Authorization": "Bearer " + secret}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s, err := m.Start(context.Background(), model.Item{ID: "episode:229631:128470:2592568", Kind: "episode"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got, err := m.Get(s.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.State == "failed" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	got, _ := m.Get(s.ID)
	if got.State != "failed" || got.Error != "Unable to start this stream." {
		t.Fatalf("unexpected session failure: %+v", got)
	}
	logText := logs.String()
	for _, want := range []string{"stage=probe", "stage=ffmpeg_exit", "reason=upstream_forbidden", "session_id=" + s.ID, "item_id=episode:229631:128470:2592568"} {
		if !strings.Contains(logText, want) {
			t.Errorf("missing %q in logs: %s", want, logText)
		}
	}
	for _, forbidden := range []string{secret, upstream.URL, "Authorization", "/video.m3u8"} {
		if strings.Contains(logText, forbidden) {
			t.Errorf("sensitive provider data in logs: %s", logText)
		}
	}
}

func TestResolverDiagnosticDoesNotLogErrorText(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	m, err := New(Config{MaxStreams: 1, SessionTTL: time.Minute}, func(context.Context, model.Item) (model.Source, error) {
		return model.Source{}, fmt.Errorf("resolver URL https://private.invalid/?token=secret-token")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s, err := m.Start(context.Background(), model.Item{ID: "episode:1:2:3", Kind: "episode"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got, _ := m.Get(s.ID)
		if got.State == "failed" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got, _ := m.Get(s.ID); got.State != "failed" {
		t.Fatalf("state: %s", got.State)
	}
	logText := logs.String()
	if !strings.Contains(logText, "stage=resolve") || !strings.Contains(logText, "reason=error") || strings.Contains(logText, "secret-token") || strings.Contains(logText, "private.invalid") {
		t.Fatalf("unsafe or incomplete resolver diagnostic: %s", logText)
	}
}

func TestMissingUpstreamStreamHasSpecificSessionError(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	defer upstream.Close()
	m, err := New(Config{MaxStreams: 1, SessionTTL: time.Minute}, func(context.Context, model.Item) (model.Source, error) {
		return model.Source{URL: upstream.URL + "/missing.m3u8"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s, err := m.Start(context.Background(), model.Item{ID: "episode:1:2:3", Kind: "episode"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got, _ := m.Get(s.ID)
		if got.State == "failed" {
			if got.Error != "The provider could not find this stream (HTTP 404)." {
				t.Fatalf("session error: %q", got.Error)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("missing upstream did not fail stream")
}

func TestStopKeepsSlotUntilResolverExits(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	calls := 0
	var mu sync.Mutex
	m, err := New(Config{MaxStreams: 1, SessionTTL: time.Minute}, func(ctx context.Context, _ model.Item) (model.Source, error) {
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		if first {
			close(entered)
			<-ctx.Done()
			<-release
			return model.Source{}, ctx.Err()
		}
		return model.Source{URL: "https://example.invalid/video.mp4"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	item := model.Item{Kind: "movie"}
	s, err := m.Start(context.Background(), item, 0)
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	stopped := make(chan error, 1)
	go func() { stopped <- m.Stop(s.ID) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, err = m.Get(s.ID); errors.Is(err, ErrNotFound) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if !errors.Is(err, ErrNotFound) {
		close(release)
		t.Fatal("stop did not remove session")
	}
	if _, err = m.Start(context.Background(), item, 0); !errors.Is(err, ErrCapacity) {
		t.Fatalf("slot was released before resolver exited: %v", err)
	}
	close(release)
	if err = <-stopped; err != nil {
		t.Fatal(err)
	}
	if _, err = m.Start(context.Background(), item, 0); err != nil {
		t.Fatalf("slot not released after stop: %v", err)
	}
}

func TestPersistentDataDirCleansOnlyOwnedStreams(t *testing.T) {
	base := t.TempDir()
	stale := filepath.Join(base, "streams", "old-session", "seg-000001.ts")
	if err := os.MkdirAll(filepath.Dir(stale), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(base, "catalog.json")
	if err := os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{MaxStreams: 1, DataDir: base}, func(context.Context, model.Item) (model.Source, error) { return model.Source{}, nil })
	if err != nil {
		t.Fatal(err)
	}
	if m.dir != filepath.Join(base, "streams") {
		t.Fatalf("owned dir: %s", m.dir)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale segment remains: %v", err)
	}
	if b, err := os.ReadFile(sentinel); err != nil || string(b) != "keep" {
		t.Fatalf("sibling changed: %q, %v", b, err)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(sentinel); err != nil || string(b) != "keep" {
		t.Fatalf("sibling changed on close: %q, %v", b, err)
	}
}
