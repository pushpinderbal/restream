package stream

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestPlaybackConfigurationPreservesActiveSessions(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg not installed")
	}
	encoders, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
	if err != nil {
		t.Fatal(err)
	}
	encoder := "libx264"
	if !strings.Contains(string(encoders), " libx264 ") {
		encoder = "libopenh264"
		if !strings.Contains(string(encoders), " libopenh264 ") {
			t.Skip("no H.264 encoder")
		}
	}
	video := filepath.Join(t.TempDir(), "source.ts")
	// MP2 audio makes copying observably different from browser transcoding.
	fixture := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", encoder, "-g", "10", "-pix_fmt", "yuv420p", "-c:a", "mp2", "-f", "mpegts", "-y", video)
	if out, err := fixture.CombinedOutput(); err != nil {
		t.Fatalf("fixture ffmpeg: %v: %s", err, out)
	}
	upstream := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(video))))
	defer upstream.Close()
	m, err := New(Config{MaxStreams: 1, TranscodeMode: "copy", SessionTTL: time.Minute}, func(context.Context, model.Item) (model.Source, error) {
		return model.Source{URL: upstream.URL + "/source.ts"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	media := httptest.NewServer(m.MediaHandler())
	defer media.Close()
	item := model.Item{ID: "movie", Kind: "movie"}
	start := func() Session {
		t.Helper()
		s, err := m.Start(context.Background(), item, 0)
		if err != nil {
			t.Fatal(err)
		}
		return waitState(t, m, s.ID, "ended")
	}
	assertAudio := func(session Session, want string) {
		t.Helper()
		probe := exec.Command("ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "json", media.URL+session.URL)
		out, err := probe.CombinedOutput()
		if err != nil {
			t.Fatalf("probe output: %v: %s", err, out)
		}
		var info struct {
			Streams []struct {
				Codec string `json:"codec_name"`
			} `json:"streams"`
		}
		if err := json.Unmarshal(out, &info); err != nil || len(info.Streams) != 1 || info.Streams[0].Codec != want {
			t.Fatalf("audio codec want %s: %s (%v)", want, out, err)
		}
	}
	first := start()
	assertAudio(first, "mp2")
	if err := m.Configure(2, "transcode"); err != nil {
		t.Fatal(err)
	}
	second := start()
	assertAudio(second, "aac")
	unchanged, err := m.Get(first.ID)
	if err != nil || !reflect.DeepEqual(unchanged, first) {
		t.Fatalf("configuration changed active session: %+v, %v", unchanged, err)
	}
	if _, err := m.Seek(context.Background(), first.ID, 2); err != nil {
		t.Fatal(err)
	}
	first = waitState(t, m, first.ID, "ended")
	assertAudio(first, "mp2")
	if err := m.Configure(1, "auto"); err != nil {
		t.Fatal(err)
	}
	if m.Active() != 2 {
		t.Fatal("lowering capacity interrupted active sessions")
	}
	if _, err := m.Start(context.Background(), item, 0); !errors.Is(err, ErrCapacity) {
		t.Fatalf("lowered capacity: %v", err)
	}
	if err := m.Configure(3, "invalid"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid configuration: %v", err)
	}
	if err := m.Stop(first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(context.Background(), item, 0); !errors.Is(err, ErrCapacity) {
		t.Fatalf("rejected configuration changed capacity: %v", err)
	}
	if err := m.Stop(second.ID); err != nil {
		t.Fatal(err)
	}
	assertAudio(start(), "aac")
}
