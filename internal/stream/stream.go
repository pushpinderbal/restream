package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

var (
	ErrCapacity = errors.New("stream capacity reached")
	ErrNotFound = errors.New("stream session not found")
	ErrInvalid  = errors.New("invalid stream request")
)

type Config struct {
	MaxStreams    int
	SessionTTL    time.Duration
	DataDir       string
	TranscodeMode string // auto, copy, transcode
}

type Resolver func(context.Context, model.Item) (model.Source, error)

type Session struct {
	ID       string  `json:"id"`
	URL      string  `json:"url"`
	State    string  `json:"state"`
	Duration float64 `json:"duration"`
	Offset   float64 `json:"offset"`
	Error    string  `json:"error,omitempty"`
}

type generation struct {
	number uint64
	cancel context.CancelFunc
	dir    string
	done   chan struct{}
}

type probeResult struct {
	mode     string
	duration float64
}

type entry struct {
	session   Session
	item      model.Item
	gen       *generation
	heartbeat time.Time
	probe     *probeResult
}

type Manager struct {
	mu       sync.Mutex
	cfg      Config
	encoder  string
	resolve  Resolver
	dir      string
	sessions map[string]*entry
	stopping int
	next     uint64
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	closed   bool
}

func New(cfg Config, resolve Resolver) (*Manager, error) {
	if resolve == nil || cfg.MaxStreams <= 0 {
		return nil, fmt.Errorf("%w: resolver and positive MaxStreams required", ErrInvalid)
	}
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = 45 * time.Second
	}
	if cfg.TranscodeMode == "" {
		cfg.TranscodeMode = "auto"
	}
	switch cfg.TranscodeMode {
	case "auto", "copy", "transcode":
	default:
		return nil, fmt.Errorf("%w: transcode mode", ErrInvalid)
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		return nil, fmt.Errorf("ffmpeg unavailable: %w", err)
	}
	encoders, err := exec.Command("ffmpeg", "-hide_banner", "-encoders").Output()
	if err != nil {
		return nil, fmt.Errorf("cannot inspect ffmpeg encoders: %w", err)
	}
	encoder := ""
	if strings.Contains(string(encoders), " libx264 ") {
		encoder = "libx264"
	} else if strings.Contains(string(encoders), " libopenh264 ") {
		encoder = "libopenh264"
	}
	if encoder == "" && cfg.TranscodeMode != "copy" {
		return nil, fmt.Errorf("ffmpeg has no supported H.264 encoder")
	}
	var dir string
	if cfg.DataDir == "" {
		dir, err = os.MkdirTemp("", "restream-")
		if err != nil {
			return nil, err
		}
	} else {
		if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
			return nil, err
		}
		// DataDir belongs to one server instance. Only the streams child is owned here.
		dir = filepath.Join(cfg.DataDir, "streams")
		if err := os.RemoveAll(dir); err != nil {
			return nil, err
		}
		if err := os.Mkdir(dir, 0700); err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{cfg: cfg, encoder: encoder, resolve: resolve, dir: dir, sessions: map[string]*entry{}, ctx: ctx, cancel: cancel}
	m.wg.Add(1)
	go m.sweep()
	return m, nil
}

func (m *Manager) Start(ctx context.Context, item model.Item, start float64) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	if invalidPosition(start) || (item.Kind == "live" && start != 0) || (item.Kind != "live" && item.Kind != "movie" && item.Kind != "episode") {
		return Session{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Session{}, ErrNotFound
	}
	if m.activeLocked() >= m.cfg.MaxStreams {
		return Session{}, ErrCapacity
	}
	m.next++
	id := strconv.FormatUint(uint64(time.Now().UnixNano()), 36) + "-" + strconv.FormatUint(m.next, 36)
	e := &entry{item: item, heartbeat: time.Now()}
	e.session = Session{ID: id, Duration: validDuration(item.Duration)}
	m.sessions[id] = e
	m.launchLocked(e, start, nil)
	return e.session, nil
}

func (m *Manager) launchLocked(e *entry, pos float64, prior <-chan struct{}) {
	m.next++
	number := m.next
	ctx, cancel := context.WithCancel(m.ctx)
	g := &generation{number: number, cancel: cancel, dir: filepath.Join(m.dir, e.session.ID, strconv.FormatUint(number, 10)), done: make(chan struct{})}
	e.gen = g
	e.session.State = "starting"
	e.session.Offset = pos
	e.session.Error = ""
	e.session.URL = "/api/streams/" + e.session.ID + "/" + strconv.FormatUint(number, 10) + "/index.m3u8"
	m.wg.Add(1)
	go m.run(ctx, e, g, pos, prior)
}

func invalidPosition(v float64) bool { return v < 0 || v != v || v > 1e12 }
func validDuration(v float64) float64 {
	if v <= 0 || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func (m *Manager) Get(id string) (Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.sessions[id]
	if e == nil {
		return Session{}, ErrNotFound
	}
	return e.session, nil
}

func (m *Manager) Heartbeat(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.sessions[id]
	if e == nil {
		return ErrNotFound
	}
	if e.session.State != "failed" {
		e.heartbeat = time.Now()
	}
	return nil
}

func (m *Manager) Seek(ctx context.Context, id string, position float64) (Session, error) {
	if err := ctx.Err(); err != nil {
		return Session{}, err
	}
	if invalidPosition(position) {
		return Session{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.sessions[id]
	if e == nil {
		return Session{}, ErrNotFound
	}
	if e.session.State == "failed" {
		return Session{}, ErrInvalid
	}
	if e.item.Kind != "movie" && e.item.Kind != "episode" {
		return Session{}, ErrInvalid
	}
	if e.session.Duration > 0 && position >= e.session.Duration {
		return Session{}, ErrInvalid
	}
	old := e.gen
	old.cancel()
	go discard(old)
	m.launchLocked(e, position, old.done)
	return e.session, nil
}

func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	e := m.sessions[id]
	if e != nil {
		delete(m.sessions, id)
		e.gen.cancel()
		m.stopping++
	}
	m.mu.Unlock()
	if e == nil {
		return ErrNotFound
	}
	discard(e.gen)
	m.mu.Lock()
	m.stopping--
	m.mu.Unlock()
	return nil
}

func (m *Manager) activeLocked() int {
	n := m.stopping
	for _, e := range m.sessions {
		if e.session.State != "failed" {
			n++
		}
	}
	return n
}
func (m *Manager) Active() int { m.mu.Lock(); defer m.mu.Unlock(); return m.activeLocked() }

func (m *Manager) Close() error {
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		m.cancel()
		for id, e := range m.sessions {
			e.gen.cancel()
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()
	m.wg.Wait()
	return os.RemoveAll(m.dir)
}

func (m *Manager) sweep() {
	defer m.wg.Done()
	interval := m.cfg.SessionTTL / 3
	if interval > 5*time.Second {
		interval = 5 * time.Second
	}
	if interval < 100*time.Millisecond {
		interval = 100 * time.Millisecond
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case now := <-t.C:
			m.mu.Lock()
			for id, e := range m.sessions {
				if now.Sub(e.heartbeat) >= m.cfg.SessionTTL {
					delete(m.sessions, id)
					e.gen.cancel()
					m.stopping++
					go m.retire(e.gen)
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *Manager) update(e *entry, g *generation, fn func(*Session)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions[e.session.ID] == e && e.gen == g {
		fn(&e.session)
	}
}

func discard(g *generation) {
	<-g.done
	_ = os.RemoveAll(g.dir)
	// Remove the session directory only once every generation has been discarded.
	_ = os.Remove(filepath.Dir(g.dir))
}

func (m *Manager) retire(g *generation) { discard(g); m.mu.Lock(); m.stopping--; m.mu.Unlock() }

func (m *Manager) run(ctx context.Context, e *entry, g *generation, pos float64, prior <-chan struct{}) {
	defer m.wg.Done()
	defer close(g.done)
	started := time.Now()
	if prior != nil {
		select {
		case <-prior:
		case <-ctx.Done():
			return
		}
	}
	startupCtx, startupCancel := context.WithTimeout(ctx, 15*time.Second)
	defer startupCancel()
	source, err := m.resolve(startupCtx, e.item)
	if err != nil {
		m.fail(e, g, ctx, "resolve", errorClass(err), started)
		return
	}
	u, err := url.Parse(source.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		m.fail(e, g, ctx, "source_validation", "invalid_url", started)
		return
	}
	if err := os.MkdirAll(g.dir, 0700); err != nil {
		m.fail(e, g, ctx, "output_directory", errorClass(err), started)
		return
	}
	// Reuse title metadata on seek, but resolve fresh provider links as they may expire.
	m.mu.Lock()
	cached := e.probe
	m.mu.Unlock()
	mode, probedDuration := "transcode", 0.0
	if cached != nil {
		mode, probedDuration = cached.mode, cached.duration
	} else {
		var reason string
		mode, probedDuration, reason = m.probeWithDiagnostics(startupCtx, source)
		if reason != "" && ctx.Err() == nil {
			m.logFailure(e, "probe", reason, started)
		} else if reason == "" && ctx.Err() == nil {
			m.mu.Lock()
			if m.sessions[e.session.ID] == e && e.gen == g {
				e.probe = &probeResult{mode: mode, duration: probedDuration}
			}
			m.mu.Unlock()
		}
	}
	duration := 0.0
	if !source.Live && e.item.Kind != "live" {
		duration = validDuration(probedDuration)
		if duration <= 0 {
			duration = validDuration(source.Duration)
		}
		if duration <= 0 {
			duration = validDuration(e.item.Duration)
		}
	}
	m.update(e, g, func(s *Session) { s.Duration = duration })
	if m.cfg.TranscodeMode != "auto" {
		mode = m.cfg.TranscodeMode
	}
	live := source.Live || e.item.Kind == "live"
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-readrate", "1"}
	if !live {
		// Fill initial segments immediately, then pace the relay.
		args = append(args, "-readrate_initial_burst", "8")
	}
	args = append(args, "-rw_timeout", "10000000", "-protocol_whitelist", "http,https,tcp,tls,crypto")
	if pos > 0 {
		args = append(args, "-ss", strconv.FormatFloat(pos, 'f', 3, 64))
	}
	if len(source.Headers) > 0 {
		var hs strings.Builder
		for k, v := range source.Headers {
			if !validHeader(k, v) {
				m.fail(e, g, ctx, "source_validation", "invalid_header", started)
				return
			}
			hs.WriteString(k)
			hs.WriteString(": ")
			hs.WriteString(v)
			hs.WriteString("\r\n")
		}
		args = append(args, "-headers", hs.String())
	}
	args = append(args, "-i", source.URL, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn")
	if mode == "copy" {
		args = append(args, "-c:v", "copy", "-c:a", "copy")
	} else {
		args = append(args, "-c:v", m.encoder)
		if m.encoder == "libx264" {
			args = append(args, "-preset", "veryfast", "-tune", "zerolatency")
		}
		args = append(args, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k")
		args = append(args, "-force_key_frames", "expr:gte(t,n_forced*1)")
	}
	args = append(args, "-f", "hls", "-hls_time", "1")
	if live {
		args = append(args, "-hls_list_size", "6", "-hls_delete_threshold", "2", "-hls_flags", "delete_segments+temp_file+omit_endlist")
	} else {
		// Retain segments for local seeking and pause/resume until session cleanup.
		args = append(args, "-hls_playlist_type", "event", "-hls_list_size", "0", "-hls_flags", "temp_file")
	}
	args = append(args, "-hls_segment_filename", filepath.Join(g.dir, "seg-%06d.ts"), filepath.Join(g.dir, "index.m3u8"))
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	// Diagnostics can contain upstream URLs and authorization headers. Only classify them.
	stderr := &boundedOutput{limit: 16 * 1024}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		m.fail(e, g, ctx, "ffmpeg_start", errorClass(err), started)
		return
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	startupTimer := time.NewTimer(15 * time.Second)
	defer startupTimer.Stop()
	ready := false
	for {
		select {
		case <-ctx.Done():
			<-done
			return
		case err := <-done:
			if !ready && playable(g.dir) {
				ready = true
			}
			if ready && err == nil && !live {
				m.update(e, g, func(s *Session) { s.State = "ended" })
			} else if live && ctx.Err() == nil {
				reason := exitClass(err, stderr.String())
				m.logFailure(e, "ffmpeg_exit", reason, started)
				message := "Live stream ended. Try again."
				if reason == "upstream_not_found" {
					message = failureMessage(reason)
				}
				m.update(e, g, func(s *Session) { s.State = "failed"; s.Error = message })
			} else if ctx.Err() == nil {
				m.fail(e, g, ctx, "ffmpeg_exit", exitClass(err, stderr.String()), started)
			}
			return
		case <-tick.C:
			if !ready && playable(g.dir) {
				ready = true
				tick.Stop()
				startupTimer.Stop()
				m.update(e, g, func(s *Session) { s.State = "ready" })
			}
		case <-startupTimer.C:
			if !ready {
				g.cancel()
				<-done
				m.fail(e, g, context.Background(), "ffmpeg_startup", "timeout", started)
				return
			}
		}
	}
}

func playable(dir string) bool {
	b, err := os.ReadFile(filepath.Join(dir, "index.m3u8"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "seg-") && strings.HasSuffix(line, ".ts") {
			fi, err := os.Stat(filepath.Join(dir, line))
			if err == nil && fi.Size() > 0 {
				return true
			}
		}
	}
	return false
}

func (m *Manager) fail(e *entry, g *generation, ctx context.Context, stage, reason string, started time.Time) {
	if ctx.Err() != nil {
		return
	}
	m.logFailure(e, stage, reason, started)
	m.update(e, g, func(s *Session) { s.State = "failed"; s.Error = failureMessage(reason) })
}

func failureMessage(reason string) string {
	if reason == "upstream_not_found" {
		return "The provider could not find this stream (HTTP 404)."
	}
	return "Unable to start this stream."
}

func (m *Manager) logFailure(e *entry, stage, reason string, started time.Time) {
	message := "Stream startup failed"
	if stage == "probe" {
		message = "Stream probe failed; using transcode fallback"
	}
	slog.Warn(message, "session_id", e.session.ID, "item_id", safeLogID(e.item.ID), "stage", stage, "reason", reason, "elapsed", time.Since(started).Round(time.Millisecond))
}

func safeLogID(id string) string {
	if len(id) > 96 {
		return "invalid"
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == ':' || c == '-' || c == '_' || c == '.') {
			return "invalid"
		}
	}
	return id
}

func errorClass(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, os.ErrPermission):
		return "permission_denied"
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, os.ErrNotExist):
		return "not_found"
	default:
		return "error"
	}
}

func exitClass(err error, diagnostic string) string {
	s := strings.ToLower(diagnostic)
	switch {
	case strings.Contains(s, "403 forbidden"), strings.Contains(s, "http error 403"), strings.Contains(s, "server returned 403"):
		return "upstream_forbidden"
	case strings.Contains(s, "401 unauthorized"), strings.Contains(s, "http error 401"), strings.Contains(s, "server returned 401"):
		return "upstream_unauthorized"
	case strings.Contains(s, "404 not found"), strings.Contains(s, "http error 404"), strings.Contains(s, "server returned 404"):
		return "upstream_not_found"
	case strings.Contains(s, "protocol") && strings.Contains(s, "not on whitelist"):
		return "protocol_rejected"
	case strings.Contains(s, "extension") && strings.Contains(s, "not") && strings.Contains(s, "allowed"):
		return "extension_rejected"
	case strings.Contains(s, "matches no streams"), strings.Contains(s, "does not contain any stream"):
		return "missing_stream"
	case strings.Contains(s, "unknown decoder"), strings.Contains(s, "unsupported codec"), strings.Contains(s, "decoder not found"):
		return "unsupported_codec"
	case strings.Contains(s, "unknown encoder"), strings.Contains(s, "error while opening encoder"):
		return "encoder_failed"
	case strings.Contains(s, "invalid data found when processing input"):
		return "invalid_media"
	case err == nil:
		return "stream_ended"
	default:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
			return "exit_status_" + strconv.Itoa(exitErr.ExitCode())
		}
		return errorClass(err)
	}
}

type boundedOutput struct {
	data  []byte
	limit int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) >= b.limit {
		b.data = append(b.data[:0], p[len(p)-b.limit:]...)
	} else {
		overflow := len(b.data) + len(p) - b.limit
		if overflow > 0 {
			b.data = append(b.data[:0], b.data[overflow:]...)
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}

func (b *boundedOutput) String() string { return string(b.data) }

var _ io.Writer = (*boundedOutput)(nil)

func validHeader(k, v string) bool {
	if k == "" || strings.ContainsAny(k, "\r\n:") || strings.ContainsAny(v, "\r\n") {
		return false
	}
	for _, c := range k {
		if c < 33 || c > 126 {
			return false
		}
	}
	return true
}

func (m *Manager) probeWithDiagnostics(ctx context.Context, source model.Source) (string, float64, string) {
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	args := []string{"-v", "error", "-rw_timeout", "10000000", "-protocol_whitelist", "http,https,tcp,tls,crypto", "-show_entries", "stream=codec_name,codec_type,pix_fmt,duration:format=duration", "-of", "json"}
	if len(source.Headers) > 0 {
		var hs strings.Builder
		for k, v := range source.Headers {
			if !validHeader(k, v) {
				return "transcode", 0, "invalid_header"
			}
			hs.WriteString(k + ": " + v + "\r\n")
		}
		args = append(args, "-headers", hs.String())
	}
	args = append(args, source.URL)
	cmd := exec.CommandContext(pctx, "ffprobe", args...)
	stderr := &boundedOutput{limit: 16 * 1024}
	cmd.Stderr = stderr
	out, err := cmd.Output()
	if err != nil {
		if pctx.Err() != nil {
			return "transcode", 0, errorClass(pctx.Err())
		}
		return "transcode", 0, exitClass(err, stderr.String())
	}
	var data struct {
		Streams []struct {
			CodecName string `json:"codec_name"`
			CodecType string `json:"codec_type"`
			PixFmt    string `json:"pix_fmt"`
			Duration  string `json:"duration"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if json.Unmarshal(out, &data) != nil {
		return "transcode", 0, "invalid_probe_output"
	}
	duration, _ := strconv.ParseFloat(data.Format.Duration, 64)
	if duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		duration = 0
		for _, s := range data.Streams {
			d, _ := strconv.ParseFloat(s.Duration, 64)
			if d > duration && !math.IsInf(d, 0) && !math.IsNaN(d) {
				duration = d
			}
		}
	}
	video, audio := false, true
	videoSeen, audioSeen := false, false
	for _, s := range data.Streams {
		if s.CodecType == "video" && !videoSeen {
			videoSeen = true
			video = s.CodecName == "h264" && (s.PixFmt == "yuv420p" || s.PixFmt == "yuvj420p")
		}
		if s.CodecType == "audio" && !audioSeen {
			audioSeen = true
			audio = s.CodecName == "aac"
		}
	}
	if video && audio {
		return "copy", duration, ""
	}
	return "transcode", duration, ""
}

func (m *Manager) MediaHandler() http.Handler { return http.HandlerFunc(m.serveMedia) }

func (m *Manager) serveMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 5 || parts[0] != "api" || parts[1] != "streams" {
		http.NotFound(w, r)
		return
	}
	id, gen, file := parts[2], parts[3], parts[4]
	if file != "index.m3u8" && !(strings.HasPrefix(file, "seg-") && strings.HasSuffix(file, ".ts") && digits(file[4:len(file)-3])) {
		http.NotFound(w, r)
		return
	}
	m.mu.Lock()
	e := m.sessions[id]
	var path string
	if e != nil && strconv.FormatUint(e.gen.number, 10) == gen {
		path = filepath.Join(e.gen.dir, file)
	}
	m.mu.Unlock()
	if path == "" {
		http.NotFound(w, r)
		return
	}
	if file == "index.m3u8" {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-store")
	} else {
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Cache-Control", "no-store")
	}
	http.ServeFile(w, r, path)
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
