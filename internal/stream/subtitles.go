package stream

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	astisub "github.com/asticode/go-astisub"
	"github.com/bluenviron/gohlslib/v2/pkg/playlist"
	"github.com/pushpinderbal/restream/internal/model"
)

const (
	subtitleResourceLimit = 2 << 20
	subtitleCacheLimit    = 16 << 20
	subtitleTrackLimit    = 16
)

var errSubtitle = errors.New("provider subtitles unavailable")

type subtitleCooldownError struct{ until time.Time }

func (e *subtitleCooldownError) Error() string             { return "provider subtitles are cooling down" }
func (e *subtitleCooldownError) RetryDelay() time.Duration { return max(0, time.Until(e.until)) }

// Input seeking retains keyframe preroll in copy mode. HLS playback normalizes
// the first video DTS to zero, so captions need that actual media origin rather
// than the requested seek position. Decode only one packet; never log source URLs.
func probeCopySubtitleOffset(ctx context.Context, source model.Source, position, origin float64) (float64, bool) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := []string{"-v", "error", "-rw_timeout", "5000000", "-protocol_whitelist", "http,https,tcp,tls,crypto", "-select_streams", "v:0", "-read_intervals", strconv.FormatFloat(position+origin, 'f', 6, 64) + "%+#1", "-show_entries", "packet=pts_time,dts_time", "-of", "json"}
	if len(source.Headers) > 0 {
		var headers strings.Builder
		for k, v := range source.Headers {
			if !validHeader(k, v) {
				return 0, false
			}
			headers.WriteString(k + ": " + v + "\r\n")
		}
		args = append(args, "-headers", headers.String())
	}
	args = append(args, source.URL)
	cmd := exec.CommandContext(ctx, "ffprobe", args...)
	cmd.Stderr = io.Discard
	body, err := cmd.Output()
	if err != nil {
		return 0, false
	}
	var data struct {
		Packets []struct {
			DTS string `json:"dts_time"`
			PTS string `json:"pts_time"`
		} `json:"packets"`
	}
	if json.Unmarshal(body, &data) != nil || len(data.Packets) == 0 {
		return 0, false
	}
	stamp := data.Packets[0].DTS
	if stamp == "" || stamp == "N/A" {
		stamp = data.Packets[0].PTS
	}
	value, err := strconv.ParseFloat(stamp, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value - origin, true
}

// SubtitleTrack contains only local URLs, never provider links or credentials.
type SubtitleTrack struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Language string `json:"language,omitempty"`
	URL      string `json:"url"`
	Default  bool   `json:"default,omitempty"`
	Forced   bool   `json:"forced,omitempty"`
}

type subtitleCue struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

type providerSubtitle struct {
	source model.SubtitleSource
	media  *playlist.Media
	base   *url.URL
	file   []byte
}

type subtitleCacheEntry struct {
	path string
	size int
	used time.Time
}

// Keep provider waits across track changes, seeks, and replacement sessions.
// Subtitle failures remain independent of the video transport.
type subtitleCooldowns struct {
	mu    sync.Mutex
	hosts map[string]time.Time
}

func (c *subtitleCooldowns) check(u *url.URL) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	host := strings.ToLower(u.Scheme + "://" + u.Host)
	if until := c.hosts[host]; until.After(time.Now()) {
		return &subtitleCooldownError{until: until}
	}
	delete(c.hosts, host)
	return nil
}

func (c *subtitleCooldowns) hold(u *url.URL, until time.Time) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.hosts == nil {
		c.hosts = make(map[string]time.Time)
	}
	host := strings.ToLower(u.Scheme + "://" + u.Host)
	if previous := c.hosts[host]; previous.After(until) {
		return previous
	}
	c.hosts[host] = until
	return until
}

type subtitleState struct {
	mu        sync.Mutex
	cooldowns *subtitleCooldowns
	filesMu   *sync.Mutex
	ctx       context.Context
	source    model.Source
	origin    float64
	dir       string
	tracks    []providerSubtitle
	cache     map[string]subtitleCacheEntry
	cacheSize int
}

func newSubtitleState(ctx context.Context, source model.Source, origin float64, dir string, filesMu *sync.Mutex, cooldowns *subtitleCooldowns) *subtitleState {
	return &subtitleState{ctx: ctx, source: source, origin: origin, dir: dir, cache: map[string]subtitleCacheEntry{}, cooldowns: cooldowns, filesMu: filesMu}
}

func subtitleHeaders(original string, target *url.URL, headers map[string]string) map[string]string {
	base, err := url.Parse(original)
	if err != nil {
		return nil
	}
	result := map[string]string{}
	for k, v := range headers {
		if base.Scheme == target.Scheme && strings.EqualFold(base.Host, target.Host) || strings.EqualFold(k, "User-Agent") {
			result[k] = v
		}
	}
	return result
}

// Only provider-advertised resources are accepted; browser requests contain no URLs.
func subtitleURL(base *url.URL, ref string) (*url.URL, error) {
	u, err := base.Parse(ref)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errSubtitle
	}
	return u, nil
}

func (s *subtitleState) fetch(ctx context.Context, target *url.URL, source model.SubtitleSource) ([]byte, *url.URL, error) {
	if err := s.cooldowns.check(target); err != nil {
		return nil, nil, err
	}
	origin, err := url.Parse(source.URL)
	if err != nil {
		return nil, nil, errSubtitle
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, nil, errSubtitle
	}
	for k, v := range source.Headers {
		if !validHeader(k, v) {
			return nil, nil, errSubtitle
		}
		// Provider credentials belong to their original origin, including redirects.
		if strings.EqualFold(target.Host, origin.Host) && target.Scheme == origin.Scheme || strings.EqualFold(k, "User-Agent") {
			req.Header.Set(k, v)
		}
	}
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(next *http.Request, via []*http.Request) error {
		if len(via) >= 5 || (next.URL.Scheme != "http" && next.URL.Scheme != "https") || next.URL.User != nil {
			return errSubtitle
		}
		if err := s.cooldowns.check(next.URL); err != nil {
			return err
		}
		if !strings.EqualFold(next.URL.Host, origin.Host) || next.URL.Scheme != origin.Scheme {
			for k := range next.Header {
				if !strings.EqualFold(k, "User-Agent") {
					next.Header.Del(k)
				}
			}
		}
		return nil
	}}
	resp, err := client.Do(req)
	if err != nil {
		var limited *subtitleCooldownError
		if errors.As(err, &limited) {
			return nil, nil, limited
		}
		return nil, nil, errSubtitle
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable && resp.Header.Get("Retry-After") != "" {
		delay := 5 * time.Second
		value := strings.TrimSpace(resp.Header.Get("Retry-After"))
		if seconds, err := strconv.ParseUint(value, 10, 64); err == nil {
			if seconds > uint64(math.MaxInt64/int64(time.Second)) {
				delay = time.Duration(math.MaxInt64)
			} else {
				delay = max(delay, time.Duration(seconds)*time.Second)
			}
		} else if value != "" && strings.Trim(value, "0123456789") == "" {
			delay = time.Duration(math.MaxInt64)
		} else if deadline, err := http.ParseTime(value); err == nil {
			delay = max(delay, time.Until(deadline))
		}
		until := s.cooldowns.hold(resp.Request.URL, time.Now().Add(delay))
		return nil, nil, &subtitleCooldownError{until: until}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, nil, errSubtitle
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, subtitleResourceLimit+1))
	if err != nil || len(body) > subtitleResourceLimit {
		return nil, nil, errSubtitle
	}
	return body, resp.Request.URL, nil
}

func (s *subtitleState) discover(hls bool, prefix string) []SubtitleTrack {
	ctx, cancel := context.WithTimeout(s.ctx, 8*time.Second)
	defer cancel()
	tracks := append([]model.SubtitleSource(nil), s.source.Subtitles...)
	if hls {
		base, err := url.Parse(s.source.URL)
		if err == nil {
			body, final, err := s.fetch(ctx, base, model.SubtitleSource{URL: s.source.URL, Headers: s.source.Headers})
			if err == nil {
				parsed, err := playlist.Unmarshal(body)
				if master, ok := parsed.(*playlist.Multivariant); err == nil && ok {
					for _, r := range master.Renditions {
						if r.Type != playlist.MultivariantRenditionTypeSubtitles || r.URI == nil {
							continue
						}
						u, err := subtitleURL(final, *r.URI)
						if err != nil {
							continue
						}
						tracks = append(tracks, model.SubtitleSource{URL: u.String(), Label: r.Name, Language: r.Language, Default: r.Default, Forced: r.Forced, Headers: subtitleHeaders(s.source.URL, u, s.source.Headers)})
					}
				}
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var result []SubtitleTrack
	seen := map[string]bool{}
	for _, track := range tracks {
		if len(result) >= subtitleTrackLimit {
			break
		}
		u, err := url.Parse(track.URL)
		if err != nil {
			continue
		}
		if _, err = subtitleURL(u, ""); err != nil || seen[track.URL] {
			continue
		}
		seen[track.URL] = true
		id := strconv.Itoa(len(result))
		label := strings.TrimSpace(track.Label)
		if label == "" {
			label = track.Language
		}
		if label == "" {
			label = "Subtitles " + strconv.Itoa(len(result)+1)
		}
		s.tracks = append(s.tracks, providerSubtitle{source: track})
		result = append(result, SubtitleTrack{ID: id, Label: label, Language: track.Language, URL: prefix + "subtitles-" + id + ".json", Default: track.Default, Forced: track.Forced})
	}
	return result
}

func (s *subtitleState) cached(ctx context.Context, target *url.URL, source model.SubtitleSource) ([]byte, error) {
	key := target.String()
	if entry, ok := s.cache[key]; ok {
		body, err := os.ReadFile(entry.path)
		if err == nil {
			entry.used = time.Now()
			s.cache[key] = entry
			return body, nil
		}
		delete(s.cache, key)
		s.cacheSize -= entry.size
	}
	body, _, err := s.fetch(ctx, target, source)
	if err != nil {
		return nil, err
	}
	s.filesMu.Lock()
	defer s.filesMu.Unlock()
	if s.ctx.Err() != nil || ctx.Err() != nil {
		return nil, errSubtitle
	}
	for s.cacheSize+len(body) > subtitleCacheLimit || len(s.cache) >= 256 {
		oldKey := ""
		var oldest time.Time
		for k, e := range s.cache {
			if oldKey == "" || e.used.Before(oldest) {
				oldKey, oldest = k, e.used
			}
		}
		if oldKey == "" {
			break
		}
		entry := s.cache[oldKey]
		_ = os.Remove(entry.path)
		delete(s.cache, oldKey)
		s.cacheSize -= entry.size
	}
	if err = os.MkdirAll(s.dir, 0700); err != nil {
		return nil, errSubtitle
	}
	sum := sha256.Sum256([]byte(key))
	path := filepath.Join(s.dir, hex.EncodeToString(sum[:])+".vtt")
	if err = os.WriteFile(path, body, 0600); err != nil {
		return nil, errSubtitle
	}
	s.cache[key] = subtitleCacheEntry{path: path, size: len(body), used: time.Now()}
	s.cacheSize += len(body)
	return body, nil
}

func parseSubtitleCues(body []byte, origin, segmentStart float64, segmented bool) ([]subtitleCue, error) {
	var subs *astisub.Subtitles
	var err error
	if bytes.HasPrefix(bytes.TrimSpace(bytes.TrimPrefix(body, astisub.BytesBOM)), []byte("WEBVTT")) {
		subs, err = astisub.ReadFromWebVTT(bytes.NewReader(body))
	} else if !segmented {
		subs, err = astisub.ReadFromSRT(bytes.NewReader(body))
	} else {
		return nil, errSubtitle
	}
	if err != nil {
		return nil, errSubtitle
	}
	shift := 0.0
	if segmented && subs.Metadata != nil && subs.Metadata.WebVTTTimestampMap != nil {
		shift = subs.Metadata.WebVTTTimestampMap.Offset().Seconds() - origin
		// MPEG-TS timestamps wrap every 2^33 ticks. Choose the cycle near this segment.
		if len(subs.Items) > 0 {
			const wrap = float64(uint64(1)<<33) / 90000
			shift += math.Round((segmentStart-subs.Items[0].StartAt.Seconds()-shift)/wrap) * wrap
		}
	}
	result := make([]subtitleCue, 0, len(subs.Items))
	for _, item := range subs.Items {
		start, end := item.StartAt.Seconds()+shift, item.EndAt.Seconds()+shift
		if end <= start || end <= 0 {
			continue
		}
		lines := make([]string, 0, len(item.Lines))
		for _, line := range item.Lines {
			lines = append(lines, html.EscapeString(line.String()))
		}
		result = append(result, subtitleCue{Start: math.Max(0, start), End: end, Text: strings.Join(lines, "\n")})
	}
	return result, nil
}

// cues fetches only the subtitle segments around the requested original-media time.
// The cache is bounded and belongs to this generation's normal stream cleanup.
func (s *subtitleState) cues(ctx context.Context, index int, start float64) ([]subtitleCue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if index < 0 || index >= len(s.tracks) {
		return nil, ErrNotFound
	}
	if s.ctx.Err() != nil {
		return nil, errSubtitle
	}
	track := &s.tracks[index]
	if track.media == nil && track.file == nil {
		u, _ := url.Parse(track.source.URL)
		body, base, err := s.fetch(ctx, u, track.source)
		if err != nil {
			return nil, err
		}
		if bytes.HasPrefix(bytes.TrimSpace(body), []byte("#EXTM3U")) {
			parsed, err := playlist.Unmarshal(body)
			if err != nil {
				return nil, errSubtitle
			}
			media, ok := parsed.(*playlist.Media)
			if !ok || !media.Endlist {
				return nil, errSubtitle
			}
			track.media, track.base = media, base
		} else {
			if _, err = parseSubtitleCues(body, 0, 0, false); err != nil {
				return nil, err
			}
			track.file = body
		}
	}
	from, to := math.Max(0, start-5), start+65
	all := []subtitleCue{}
	if track.file != nil {
		var err error
		all, err = parseSubtitleCues(track.file, 0, 0, false)
		if err != nil {
			return nil, err
		}
	} else {
		position := 0.0
		fetched := 0
		for _, segment := range track.media.Segments {
			end := position + segment.Duration.Seconds()
			if end >= from && position <= to && !segment.Gap {
				if segment.Key != nil && segment.Key.Method != playlist.MediaKeyMethodNone || segment.ByteRangeLength != nil {
					return nil, errSubtitle
				}
				fetched++
				if fetched > 128 {
					return nil, errSubtitle
				}
				u, err := subtitleURL(track.base, segment.URI)
				if err != nil {
					return nil, err
				}
				body, err := s.cached(ctx, u, track.source)
				if err != nil {
					return nil, err
				}
				cues, err := parseSubtitleCues(body, s.origin, position, true)
				if err != nil {
					return nil, err
				}
				all = append(all, cues...)
			}
			position = end
			if position > to {
				break
			}
		}
	}
	result := []subtitleCue{}
	seen := map[subtitleCue]bool{}
	for _, cue := range all {
		if cue.End > from && cue.Start < to && !seen[cue] {
			result = append(result, cue)
			seen[cue] = true
		}
		if len(result) > 4096 {
			return nil, errSubtitle
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Start < result[j].Start })
	return result, nil
}

func (m *Manager) serveSubtitles(w http.ResponseWriter, r *http.Request, id, gen, track string) {
	w.Header().Set("Cache-Control", "no-store")
	if !digits(track) {
		http.NotFound(w, r)
		return
	}
	index, err := strconv.Atoi(track)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	start := 0.0
	if raw := r.URL.Query().Get("start"); raw != "" {
		start, err = strconv.ParseFloat(raw, 64)
	}
	if err != nil || invalidPosition(start) {
		http.Error(w, "Invalid subtitle position", http.StatusBadRequest)
		return
	}
	m.mu.Lock()
	e := m.sessions[id]
	var state *subtitleState
	if e != nil && strconv.FormatUint(e.gen.number, 10) == gen {
		state = e.gen.subtitles
	}
	m.mu.Unlock()
	if state == nil {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	stop := context.AfterFunc(state.ctx, cancel)
	defer stop()
	cues, err := state.cues(ctx, index, start)
	if err != nil {
		var limited *subtitleCooldownError
		if errors.As(err, &limited) {
			w.Header().Set("Retry-After", strconv.FormatInt(int64(math.Ceil(limited.RetryDelay().Seconds())), 10))
			http.Error(w, "Provider subtitles are cooling down", http.StatusTooManyRequests)
		} else if state.ctx.Err() != nil || errors.Is(err, ErrNotFound) {
			http.NotFound(w, r)
		} else {
			http.Error(w, "Provider subtitles are temporarily unavailable", http.StatusBadGateway)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"cues": cues, "start": math.Max(0, start-5), "end": start + 65})
}
