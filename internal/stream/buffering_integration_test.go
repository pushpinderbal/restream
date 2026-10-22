package stream

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestPlaybackBufferFollowsSpeed(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	video := filepath.Join(t.TempDir(), "source.mp4")
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "150", "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate media: %v: %s", err, out)
	}
	upstream := httptest.NewServer(http.FileServer(http.Dir(filepath.Dir(video))))
	defer upstream.Close()
	m, err := New(Config{MaxStreams: 1, TranscodeMode: "copy", SessionTTL: time.Minute}, func(context.Context, model.Item) (model.Source, error) {
		return model.Source{URL: upstream.URL + "/source.mp4"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	media := httptest.NewServer(m.MediaHandler())
	defer media.Close()
	s, err := m.Start(context.Background(), model.Item{ID: "episode", Kind: "episode"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	s = waitState(t, m, s.ID, "ready")
	if s.PlaybackRate != 1 {
		t.Fatalf("default speed: %+v", s)
	}
	edge := func() float64 {
		t.Helper()
		response, err := http.Get(media.URL + s.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != 200 {
			t.Fatalf("read playlist: %d %v", response.StatusCode, err)
		}
		duration := 0.0
		for _, line := range strings.Split(string(body), "\n") {
			if value, ok := strings.CutPrefix(line, "#EXTINF:"); ok {
				seconds, err := strconv.ParseFloat(strings.TrimSuffix(value, ","), 64)
				if err != nil {
					t.Fatal(err)
				}
				duration += seconds
			}
		}
		return duration
	}
	waitEdge := func(want float64) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if edge() >= want {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("initial buffer did not reach %v seconds: %v", want, edge())
	}
	assertPacing := func(rate float64) {
		t.Helper()
		before, started := edge(), time.Now()
		// Ten seconds separates the 20% headroom from real-time pacing even
		// when the playlist advances in whole one-second segments.
		time.Sleep(10 * time.Second)
		got := (edge() - before) / time.Since(started).Seconds()
		if math.Abs(got-rate) > 0.15 {
			t.Fatalf("relay advanced at %.2fx; want %.2fx", got, rate)
		}
	}
	waitEdge(30)
	assertPacing(1.2)
	for _, rate := range []float64{0, 0.49, 2.01, math.NaN(), math.Inf(1)} {
		if _, err := m.SetPlaybackRate(context.Background(), s.ID, 10, rate); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid speed %v accepted: %v", rate, err)
		}
	}
	previous := s.URL
	s, err = m.SetPlaybackRate(context.Background(), s.ID, 10, 2)
	if err != nil || s.Offset != 10 || s.PlaybackRate != 2 || s.URL == previous || m.Active() != 1 {
		t.Fatalf("speed change lost position or slot: %+v %v", s, err)
	}
	s = waitState(t, m, s.ID, "ready")
	waitEdge(60)
	assertPacing(2.4)
	previous = s.URL
	s, err = m.Seek(context.Background(), s.ID, 20)
	if err != nil || s.PlaybackRate != 2 || s.Offset != 20 || s.URL == previous {
		t.Fatalf("seek lost selected speed: %+v %v", s, err)
	}
	s = waitState(t, m, s.ID, "ready")
	previous = s.URL
	s, err = m.SetPlaybackRate(context.Background(), s.ID, 20, 1)
	if err != nil || s.PlaybackRate != 1 || s.Offset != 20 || s.URL == previous {
		t.Fatalf("return to normal speed: %+v %v", s, err)
	}
	if err := m.Stop(s.ID); err != nil || m.Active() != 0 {
		t.Fatalf("stop sped-up playback: %v", err)
	}
	s, err = m.Start(context.Background(), model.Item{ID: "live", Kind: "live"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.SetPlaybackRate(context.Background(), s.ID, 0, 2); !errors.Is(err, ErrInvalid) {
		t.Fatalf("live speed change accepted: %v", err)
	}
}
