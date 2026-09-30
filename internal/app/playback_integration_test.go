package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/stalker"
	"github.com/pushpinderbal/restream/internal/stream"
)

// Exercise the actual provider, HTTP application, FFprobe, FFmpeg, and HLS
// serving together. The only substitute is the external IPTV portal.
func TestPortalToBrowserPlayback(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe required")
	}
	movie := filepath.Join(t.TempDir(), "sample.mp4")
	// Leave enough footage after the browser's late seek to check that settings
	// and library filtering preserve playback before the fixture reaches its end.
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "60", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac", "-movflags", "+faststart", movie)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate test media: %v: %s", err, b)
	}
	var mediaRequests atomic.Int32
	var portal *httptest.Server
	portal = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/media/sample.mp4" {
			if !strings.Contains(r.Header.Get("Cookie"), "mac=00%3A11%3A22%3A33%3A44%3A55") {
				t.Error("server did not forward provider media identity")
			}
			mediaRequests.Add(1)
			http.ServeFile(w, r, movie)
			return
		}
		q := r.URL.Query()
		var data any
		switch q.Get("action") {
		case "handshake":
			data = map[string]any{"token": "private-token"}
		case "get_profile":
			data = map[string]any{"id": 1}
		case "get_all_channels":
			data = map[string]any{"data": []any{
				map[string]any{"id": "1", "name": "Test live", "cmd": "private-live-command"},
				map[string]any{"id": "3", "name": "Test live two", "cmd": "private-second-live-command"},
			}}
		case "get_genres":
			data = []any{}
		case "get_categories":
			data = []any{}
			if q.Get("type") == "vod" {
				data = []any{map[string]any{"id": "7", "title": "Test films"}}
			}
		case "get_ordered_list":
			data = map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "2", "name": "Test movie", "cmd": "private-vod-command"}}}
		case "get_epg_info":
			data = map[string]any{"1": []any{map[string]any{"name": "Fixture guide", "start_timestamp": time.Now().Unix(), "stop_timestamp": time.Now().Add(time.Hour).Unix()}}}
		case "create_link":
			data = map[string]any{"cmd": "ffmpeg " + portal.URL + "/media/sample.mp4"}
		default:
			t.Errorf("unexpected action %q", q.Get("action"))
			http.Error(w, "unsupported", 400)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"js": data})
	}))
	defer portal.Close()
	cfg := Config{PortalURL: portal.URL + "/stalker_portal/c/", MAC: "00:11:22:33:44:55", DataDir: t.TempDir(), WebDir: t.TempDir(), MaxStreams: 1, CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	if os.Getenv("RESTREAM_BROWSER_TESTS") == "1" {
		var err error
		cfg.WebDir, err = filepath.Abs("../../web/dist")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = os.Stat(filepath.Join(cfg.WebDir, "index.html")); err != nil {
			t.Fatal("build frontend before browser integration: mise run frontend")
		}
	}
	provider, err := stalker.New(stalker.Config{PortalURL: cfg.PortalURL, MAC: cfg.MAC, RequestInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	manager, err := stream.New(stream.Config{MaxStreams: 1, SessionTTL: time.Minute, DataDir: cfg.DataDir}, provider.Resolve)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	app, err := New(cfg, provider, manager)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	server := httptest.NewServer(app)
	defer server.Close()
	waitFor(t, func() bool { _, ok := app.cache.item("live:1"); return ok })
	status, browseBody := request(t, server.URL, "GET", "/api/browse?kind=movie&category=7&page=1", "")
	if status != 200 || !strings.Contains(browseBody, "Test movie") {
		t.Fatal(status, browseBody)
	}
	_, body := request(t, server.URL, "GET", "/api/catalog", "")
	if strings.Contains(body, "private-") || strings.Contains(body, portal.URL) {
		t.Fatal("provider credentials leaked in catalog")
	}
	status, body = request(t, server.URL, "POST", "/api/sessions", `{"itemId":"movie:2"}`)
	if status != 201 {
		t.Fatal(status, body)
	}
	var session stream.Session
	if err := json.Unmarshal([]byte(body), &session); err != nil {
		t.Fatal(err)
	}
	status, body = request(t, server.URL, "POST", "/api/sessions", `{"itemId":"live:1"}`)
	if status != 409 || !strings.Contains(body, "No room available") {
		t.Fatal(status, body)
	}
	session = awaitPlayable(t, server.URL, session.ID)
	if session.Duration < 59 || session.Duration > 61 {
		t.Fatalf("duration not probed: %+v", session)
	}
	assertLocalMedia(t, server.URL, session.URL, portal.URL)
	if mediaRequests.Load() == 0 {
		t.Fatal("media bypassed central server")
	}
	previous := session.URL
	status, body = request(t, server.URL, "POST", "/api/sessions/"+session.ID+"/seek", `{"position":5}`)
	if status != 200 {
		t.Fatal(status, body)
	}
	session = awaitPlayable(t, server.URL, session.ID)
	if session.URL == previous || session.Offset != 5 || manager.Active() != 1 {
		t.Fatalf("seek lost slot or timeline: %+v", session)
	}
	assertLocalMedia(t, server.URL, session.URL, portal.URL)
	status, _ = request(t, server.URL, "DELETE", "/api/sessions/"+session.ID, "")
	if status != 204 || manager.Active() != 0 {
		t.Fatalf("stop did not release: %d", status)
	}
	status, _ = request(t, server.URL, "GET", session.URL, "")
	if status != 404 {
		t.Fatal("stopped media still accessible")
	}
	if os.Getenv("RESTREAM_BROWSER_TESTS") == "1" {
		script, err := filepath.Abs("../../web/tests/real-playback.mjs")
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "bun", script, server.URL)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("real browser playback failed: %v\n%s", err, output)
		}
		t.Log(string(output))
	}

}
func awaitPlayable(t *testing.T, base, id string) stream.Session {
	t.Helper()
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		status, body := request(t, base, "GET", "/api/sessions/"+id, "")
		if status != 200 {
			t.Fatal(status, body)
		}
		var s stream.Session
		if err := json.Unmarshal([]byte(body), &s); err != nil {
			t.Fatal(err)
		}
		if s.State == "failed" {
			t.Fatalf("stream failed: %+v", s)
		}
		if s.State == "ready" || s.State == "ended" {
			return s
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("stream never became playable")
	return stream.Session{}
}
func assertLocalMedia(t *testing.T, base, playlist, upstream string) {
	t.Helper()
	status, body := request(t, base, "GET", playlist, "")
	if status != 200 || !strings.HasPrefix(body, "#EXTM3U") || strings.Contains(body, upstream) || strings.Contains(body, "private") {
		t.Fatalf("invalid relay playlist %d %s", status, body)
	}
	segment := ""
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "seg-") {
			segment = line
			break
		}
	}
	if segment == "" {
		t.Fatal("playlist has no segments")
	}
	media := base + playlist[:strings.LastIndex(playlist, "/")+1] + segment
	res, err := http.Get(media)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	bytes, err := io.Copy(io.Discard, res.Body)
	if err != nil || res.StatusCode != 200 || bytes < 188 {
		t.Fatal(fmt.Sprintf("media response: %d %d %v", res.StatusCode, bytes, err))
	}
}
