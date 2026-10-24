package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestSubtitleCooldownIsSharedByTracksAndKeepsPlaybackUsable(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			var calls atomic.Int32
			var recovered atomic.Bool
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if !recovered.Load() {
					w.Header().Set("Retry-After", "90")
					w.WriteHeader(status)
					return
				}
				fmt.Fprint(w, "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nRecovered captions\n")
			}))
			defer provider.Close()
			redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, provider.URL+"/one.vtt", http.StatusFound)
			}))
			defer redirector.Close()
			other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprint(w, "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nOther captions\n")
			}))
			defer other.Close()
			state := newSubtitleState(context.Background(), model.Source{}, 0, t.TempDir(), &sync.Mutex{}, &subtitleCooldowns{})
			state.tracks = []providerSubtitle{
				{source: model.SubtitleSource{URL: redirector.URL + "/one.vtt"}},
				{source: model.SubtitleSource{URL: provider.URL + "/two.vtt"}},
				{source: model.SubtitleSource{URL: other.URL + "/other.vtt"}},
			}
			m := &Manager{sessions: map[string]*entry{"session": {
				session: Session{ID: "session", State: "ready"},
				gen:     &generation{number: 1, subtitles: state},
			}}}
			get := func(track string, want int) *httptest.ResponseRecorder {
				t.Helper()
				w := httptest.NewRecorder()
				m.serveSubtitles(w, httptest.NewRequest("GET", "/?start=0", nil), "session", "1", track)
				if w.Code != want {
					t.Fatalf("track %s: status %d, body %s", track, w.Code, w.Body.String())
				}
				return w
			}
			first := get("0", http.StatusTooManyRequests)
			seconds, err := strconv.Atoi(first.Header().Get("Retry-After"))
			if err != nil || seconds < 89 {
				t.Fatalf("provider wait was lost: %q", first.Header().Get("Retry-After"))
			}
			get("0", http.StatusTooManyRequests)
			get("1", http.StatusTooManyRequests)
			get("2", http.StatusOK)
			replacement := newSubtitleState(context.Background(), model.Source{}, 0, t.TempDir(), &sync.Mutex{}, state.cooldowns)
			target, _ := url.Parse(provider.URL + "/one.vtt")
			_, _, err = replacement.fetch(context.Background(), target, model.SubtitleSource{URL: target.String()})
			var limited *subtitleCooldownError
			if !errors.As(err, &limited) {
				t.Fatalf("replacement generation lost the provider cooldown: %v", err)
			}
			if calls.Load() != 1 {
				t.Fatalf("retries or track changes bypassed provider cooldown: %d calls", calls.Load())
			}
			if current, _ := m.Get("session"); current.State != "ready" {
				t.Fatalf("subtitle failure interrupted playback: %+v", current)
			}
			recovered.Store(true)
			u, _ := url.Parse(provider.URL)
			state.cooldowns.mu.Lock()
			delete(state.cooldowns.hosts, u.Scheme+"://"+u.Host)
			state.cooldowns.mu.Unlock()
			get("0", http.StatusOK)
			if calls.Load() != 2 {
				t.Fatalf("retry after cooldown did not recover: %d calls", calls.Load())
			}
		})
	}
}

func subtitleFixture(t *testing.T) (string, float64) {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	dir := t.TempDir()
	// Match provider streams with a nonzero timestamp origin, B frames, and long
	// keyframe intervals. Seeking between keyframes retains preroll in copy mode.
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=sample_rate=48000", "-t", "90", "-c:v", "libx264", "-preset", "ultrafast", "-g", "80", "-sc_threshold", "0", "-bf", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-output_ts_offset", "600", "-f", "hls", "-hls_time", "8", "-hls_playlist_type", "vod", "-hls_segment_filename", filepath.Join(dir, "video-%03d.ts"), filepath.Join(dir, "video.m3u8"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("subtitle media fixture: %v %s", err, out)
	}
	out, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=start_time", "-of", "default=nw=1:nk=1", filepath.Join(dir, "video.m3u8")).Output()
	if err != nil {
		t.Fatal(err)
	}
	origin, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil {
		t.Fatal(err)
	}
	return dir, origin
}

func awaitSubtitles(t *testing.T, m *Manager, id string, count int) Session {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s, err := m.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if len(s.Subtitles) == count {
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("provider subtitles were not discovered")
	return Session{}
}

func TestProviderHLSSubtitlesAcrossPlaybackModes(t *testing.T) {
	dir, origin := subtitleFixture(t)
	// Read the independently known segment beginning at the preceding 40-second
	// keyframe, rather than using the seek probe under test to calculate expected timing.
	packet, err := exec.Command("ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "packet=dts_time", "-of", "csv=p=0", filepath.Join(dir, "video-005.ts")).Output()
	if err != nil {
		t.Fatal(err)
	}
	stamp, err := strconv.ParseFloat(strings.Split(strings.TrimSpace(string(packet)), ",")[0], 64)
	if err != nil {
		t.Fatal(err)
	}
	copyOffset := stamp - origin
	var subtitleRequests atomic.Int32
	var broken atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-subtitle-token" {
			http.Error(w, "unauthorized", 401)
			return
		}
		switch r.URL.Path {
		case "/master.m3u8":
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,AUTOSELECT=YES,URI=\"subtitles.m3u8?token=private-link\"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"Spanish\",LANGUAGE=\"es\",AUTOSELECT=YES,URI=\"subtitles.m3u8?language=es&token=private-link\"\n#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS=\"avc1.42c00a,mp4a.40.2\",SUBTITLES=\"subs\"\nvideo.m3u8\n")
		case "/subtitles.m3u8":
			fmt.Fprint(w, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:15\n#EXT-X-MEDIA-SEQUENCE:0\n")
			for i := 0; i < 6; i++ {
				fmt.Fprintf(w, "#EXTINF:15.000,\nsub-%d.vtt?token=private-link\n", i)
			}
			fmt.Fprint(w, "#EXT-X-ENDLIST\n")
		default:
			if strings.HasSuffix(r.URL.Path, ".vtt") {
				subtitleRequests.Add(1)
				if broken.Load() {
					http.Error(w, "provider failure: private-link", 503)
					return
				}
				var index int
				fmt.Sscanf(r.URL.Path, "/sub-%d.vtt", &index)
				start := index*15 + 2
				fmt.Fprintf(w, "WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:%d\n\n00:%02d:%02d.000 --> 00:%02d:%02d.000\nProvider caption %d\nSecond line\n\n", int64(origin*90000), start/60, start%60, (start+8)/60, (start+8)%60, index)
				return
			}
			http.FileServer(http.Dir(dir)).ServeHTTP(w, r)
		}
	}))
	defer upstream.Close()
	for _, mode := range []string{"copy", "transcode"} {
		t.Run(mode, func(t *testing.T) {
			m, err := New(Config{MaxStreams: 1, SessionTTL: time.Minute, DataDir: t.TempDir(), TranscodeMode: mode}, func(context.Context, model.Item) (model.Source, error) {
				return model.Source{URL: upstream.URL + "/master.m3u8?token=private-link", Headers: map[string]string{"Authorization": "Bearer private-subtitle-token"}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			server := httptest.NewServer(m.MediaHandler())
			defer server.Close()
			s, err := m.Start(context.Background(), model.Item{Kind: "episode", ID: "episode:1:1:1"}, 0)
			if err != nil {
				t.Fatal(err)
			}
			waitState(t, m, s.ID, "ready", "ended")
			s = awaitSubtitles(t, m, s.ID, 2)
			if s.Subtitles[0].Language != "en" || s.Subtitles[1].Label != "Spanish" {
				t.Fatalf("track metadata: %+v", s.Subtitles)
			}
			encoded, _ := json.Marshal(s)
			if strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), upstream.URL) {
				t.Fatal("provider identity leaked in session")
			}
			get := func(path string, want int) string {
				t.Helper()
				resp, err := http.Get(server.URL + path)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				body, _ := io.ReadAll(resp.Body)
				if resp.StatusCode != want {
					t.Fatalf("%s: %d %s", path, resp.StatusCode, body)
				}
				return string(body)
			}
			body := get(s.Subtitles[0].URL+"?start=0", 200)
			var response struct {
				Cues []subtitleCue `json:"cues"`
			}
			if err = json.Unmarshal([]byte(body), &response); err != nil {
				t.Fatal(err)
			}
			if len(response.Cues) == 0 || math.Abs(response.Cues[0].Start-2) > 0.001 || response.Cues[0].Text != "Provider caption 0\nSecond line" {
				t.Fatalf("subtitle timing or text: %s", body)
			}
			before := subtitleRequests.Load()
			get(s.Subtitles[0].URL+"?start=0", 200)
			if subtitleRequests.Load() != before {
				t.Fatal("cached subtitle segments were downloaded again")
			}
			cache, err := filepath.Glob(filepath.Join(m.dir, s.ID, "*", "subtitles", "*.vtt"))
			if err != nil || len(cache) == 0 {
				t.Fatal("subtitle segments were not cached")
			}
			get(s.Subtitles[0].URL+"?start=NaN", 400)
			get(strings.TrimSuffix(s.URL, "index.m3u8")+"subtitles-999.json", 404)
			oldTrack := s.Subtitles[0].URL
			if _, err = m.Seek(context.Background(), s.ID, 43); err != nil {
				t.Fatal(err)
			}
			waitState(t, m, s.ID, "ready", "ended")
			s = awaitSubtitles(t, m, s.ID, 2)
			if s.Offset != 43 {
				t.Fatalf("subtitle correction changed playback position: %v", s.Offset)
			}
			if mode == "copy" {
				if s.SubtitleOffset == nil || math.Abs(*s.SubtitleOffset-copyOffset) > 0.001 {
					t.Fatalf("copy subtitle origin = %v, want preceding keyframe DTS %v", s.SubtitleOffset, copyOffset)
				}
				if 43-*s.SubtitleOffset < 2 {
					t.Fatal("fixture did not retain enough preroll to exercise early captions")
				}
			} else if s.SubtitleOffset != nil {
				t.Fatalf("accurately transcoded playback received copy correction: %v", *s.SubtitleOffset)
			}
			get(oldTrack, 404)
			body = get(s.Subtitles[0].URL+"?start=60", 200)
			if !strings.Contains(body, "Provider caption 4") {
				t.Fatal("resumed subtitle window missing", body)
			}
			if _, err = os.Stat(cache[0]); !os.IsNotExist(err) {
				t.Fatal("seek left stale subtitle files", err)
			}
			broken.Store(true)
			get(s.Subtitles[1].URL+"?start=0", 502)
			broken.Store(false)
			if current, _ := m.Get(s.ID); current.State == "failed" {
				t.Fatal("subtitle failure stopped video")
			}
			body = get(s.Subtitles[1].URL+"?start=0", 200)
			if strings.Contains(body, "private") {
				t.Fatal("subtitle response leaked provider URL")
			}
			if err = m.Stop(s.ID); err != nil {
				t.Fatal(err)
			}
			get(s.Subtitles[0].URL, 404)
			if _, err = os.Stat(filepath.Join(m.dir, s.ID)); !os.IsNotExist(err) {
				t.Fatal("stopped subtitle cache remains", err)
			}
			// A later visit starts a new session at the saved position with fresh links.
			resumed, err := m.Start(context.Background(), model.Item{Kind: "episode", ID: "episode:1:1:1"}, 43)
			if err != nil {
				t.Fatal(err)
			}
			waitState(t, m, resumed.ID, "ready", "ended")
			resumed = awaitSubtitles(t, m, resumed.ID, 2)
			if resumed.Offset != 43 || resumed.ID == s.ID {
				t.Fatal("resume did not create a fresh session")
			}
			if mode == "copy" && (resumed.SubtitleOffset == nil || math.Abs(*resumed.SubtitleOffset-copyOffset) > 0.001) {
				t.Fatal("later resume lost copy subtitle timing correction")
			}
			get(resumed.Subtitles[0].URL+"?start=30", 200)
			if mode == "copy" {
				m.mu.Lock()
				m.sessions[resumed.ID].heartbeat = time.Now().Add(-time.Hour)
				m.mu.Unlock()
				deadline := time.Now().Add(7 * time.Second)
				for time.Now().Before(deadline) {
					_, err := os.Stat(filepath.Join(m.dir, resumed.ID))
					if os.IsNotExist(err) {
						break
					}
					time.Sleep(50 * time.Millisecond)
				}
				if _, err = os.Stat(filepath.Join(m.dir, resumed.ID)); !os.IsNotExist(err) {
					t.Fatal("expired subtitle cache remains", err)
				}
				get(resumed.Subtitles[0].URL, 404)
			} else if err = m.Stop(resumed.ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProviderSubtitleCredentialsStayOnOrigin(t *testing.T) {
	// Cross-origin HLS renditions must not receive the video's authorization headers.
	var leaked atomic.Bool
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			leaked.Store(true)
		}
		fmt.Fprint(w, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nCaption\n")
	}))
	defer cdn.Close()
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"s\",NAME=\"English\",URI=\"%s/sub.vtt\"\n#EXT-X-STREAM-INF:BANDWIDTH=100000,SUBTITLES=\"s\"\nvideo.m3u8\n", cdn.URL)
	}))
	defer portal.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var filesMu sync.Mutex
	s := newSubtitleState(ctx, model.Source{URL: portal.URL + "/master.m3u8", Headers: map[string]string{"Authorization": "Bearer private", "Cookie": "private=identity"}}, 0, t.TempDir(), &filesMu, &subtitleCooldowns{})
	if len(s.discover(true, "/api/streams/session/1/")) != 1 {
		t.Fatal("track not discovered")
	}
	cues, err := s.cues(ctx, 0, 0)
	if err != nil || len(cues) != 1 {
		t.Fatal("cross-origin subtitle unavailable", err)
	}
	if leaked.Load() {
		t.Fatal("credentials sent to subtitle CDN")
	}
}
