package app

import (
	"bytes"
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
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dgraph-io/ristretto/v2"
	"golang.org/x/sync/singleflight"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

type Streams interface {
	Start(context.Context, model.Item, float64) (stream.Session, error)
	Get(string) (stream.Session, error)
	Heartbeat(string) error
	Seek(context.Context, string, float64) (stream.Session, error)
	Stop(string) error
	Active() int
	MediaHandler() http.Handler
}

type Server struct {
	cfg                    Config
	provider               model.Provider
	streams                Streams
	cache                  *store
	handler                http.Handler
	ctx                    context.Context
	cancel                 context.CancelFunc
	wg                     sync.WaitGroup
	stateMu                sync.RWMutex
	catalogSync, epgSync   refreshState
	refreshWake            [2]chan struct{}
	catalogError, epgError string
	episodeFlights         singleflight.Group
	browseFlights          singleflight.Group
	browseMu               sync.Mutex
	browseWG               sync.WaitGroup
	browseClosed           bool
	imageClient            *http.Client
	imageCache             *ristretto.Cache[string, imageData]
	imageFlights           singleflight.Group
	imageFailureTTL        time.Duration
}

type refreshState struct {
	Queued           bool       `json:"queued"`
	Running          bool       `json:"running"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
	FinishedAt       *time.Time `json:"finishedAt,omitempty"`
	NextRefreshAt    *time.Time `json:"nextRefreshAt,omitempty"`
	LastSuccessfulAt *time.Time `json:"lastSuccessfulAt,omitempty"`
	IntervalSeconds  float64    `json:"intervalSeconds"`
	Error            string     `json:"error,omitempty"`
}

type imageData struct {
	data     []byte
	mime     string
	fallback bool
}

const imageCacheTTL = time.Hour
const defaultImageFailureTTL = 5 * time.Minute

// The artwork endpoint always has a usable image for a known item, including
// channels whose portal does not publish a logo.
const defaultArtwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" role="img" aria-label="Artwork unavailable"><rect width="320" height="180" fill="#172033"/><rect x="109" y="55" width="102" height="70" rx="14" fill="#27354d" stroke="#536a92" stroke-width="2"/><path d="m147 77 37 13-37 13z" fill="#aec3e8"/></svg>`

var fallbackArtwork = imageData{data: []byte(defaultArtwork), mime: "image/svg+xml", fallback: true}

func New(cfg Config, provider model.Provider, streams Streams) (*Server, error) {
	if cfg.EpisodeCacheTTL <= 0 {
		cfg.EpisodeCacheTTL = time.Hour
	}
	cache, err := openStore(cfg.DataDir, cfg.PortalURL, cfg.MAC)
	if err != nil {
		return nil, err
	}
	imageCache, err := ristretto.NewCache(&ristretto.Config[string, imageData]{NumCounters: 1024, MaxCost: 32 << 20, BufferItems: 64})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{cfg: cfg, provider: provider, streams: streams, cache: cache, ctx: ctx, cancel: cancel, imageClient: &http.Client{Timeout: 12 * time.Second}, imageCache: imageCache, imageFailureTTL: defaultImageFailureTTL}
	s.refreshWake = [2]chan struct{}{make(chan struct{}, 1), make(chan struct{}, 1)}
	cache.mu.RLock()
	slog.Info("Cache restored", "liveChannels", len(cache.items), "categories", len(cache.categories), "programs", len(cache.programs))
	if until := cache.portalCooldownUntil; until.After(time.Now()) {
		slog.Info("Portal cooldown restored", "until", until, "wait", time.Until(until).Round(time.Second))
	}
	cache.mu.RUnlock()
	if cooldownProvider, ok := provider.(model.PortalCooldownProvider); ok {
		cache.mu.RLock()
		until := cache.portalCooldownUntil
		cache.mu.RUnlock()
		cooldownProvider.ConfigureCooldown(until, func(next time.Time) error {
			if err := cache.setRetryDeadline(false, next, true); err != nil {
				return err
			}
			slog.Debug("Portal cooldown saved", "until", next, "wait", max(0, time.Until(next)).Round(time.Second))
			return nil
		})
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /api/status", s.status)
	mux.HandleFunc("POST /api/refresh", s.refresh)
	mux.HandleFunc("GET /api/catalog", s.catalog)
	mux.HandleFunc("GET /api/categories", s.categories)
	mux.HandleFunc("GET /api/browse", s.browse)
	mux.HandleFunc("GET /api/epg", s.epg)
	mux.HandleFunc("GET /api/series/{id}/episodes", s.episodes)
	mux.HandleFunc("GET /api/items/{id}", s.item)
	mux.HandleFunc("GET /api/images/{id}", s.image)
	mux.HandleFunc("POST /api/sessions", s.start)
	mux.HandleFunc("GET /api/sessions/{id}", s.session)
	mux.HandleFunc("POST /api/sessions/{id}/heartbeat", s.heartbeat)
	mux.HandleFunc("POST /api/sessions/{id}/seek", s.seek)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.stop)
	if streams != nil {
		mux.Handle("/api/streams/", streams.MediaHandler())
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "Not found.") })
	mux.Handle("/", s.static())
	guard := http.NewCrossOriginProtection()
	guard.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail(w, 403, "origin", "Cross-origin requests are not allowed.")
	}))
	s.handler = s.headers(guard.Handler(mux))
	if provider != nil {
		s.wg.Add(1)
		go s.scheduler(true)
		s.wg.Add(1)
		go s.scheduler(false)
	}
	return s, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.handler.ServeHTTP(w, r) }
func (s *Server) Close() {
	s.browseMu.Lock()
	s.browseClosed = true
	s.browseMu.Unlock()
	s.cancel()
	s.wg.Wait()
	s.browseWG.Wait()
	s.imageCache.Close()
	_ = s.cache.close()
}
func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
		if r.URL.Path == "/api/catalog" || r.URL.Path == "/api/epg" {
			w.Header().Set("Cache-Control", "private, no-cache")
		} else if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}
func (s *Server) static() http.Handler {
	root, err := filepath.Abs(s.cfg.WebDir)
	if err != nil {
		root = s.cfg.WebDir
	}
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(405)
			return
		}
		if r.URL.Path == "/" {
			if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
				http.Error(w, "Web interface files are missing from the container image.", 503)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.RLock()
	cat, fullCat, epg, libraryUpdated := s.cache.catalogPublishedAt, s.cache.catalogAt, s.cache.epgAt, s.cache.libraryRefreshedAt
	metadataAt := fullCat
	if _, ok := s.provider.(model.BrowseProvider); ok && s.cache.categoriesAt.Before(metadataAt) {
		metadataAt = s.cache.categoriesAt
	}
	cooldown := s.cache.portalCooldownUntil
	library := map[string]any{"liveChannels": len(s.cache.items), "categories": len(s.cache.categories), "programmes": len(s.cache.programs)}
	movies, series := 0, 0
	for _, item := range s.cache.byID {
		if item.Kind == "movie" {
			movies++
		}
		if item.Kind == "series" {
			series++
		}
	}
	library["cachedMovies"], library["cachedSeries"] = movies, series
	var guideStart, guideEnd time.Time
	for _, program := range s.cache.programs {
		if guideStart.IsZero() || program.Start.Before(guideStart) {
			guideStart = program.Start
		}
		if program.End.After(guideEnd) {
			guideEnd = program.End
		}
	}
	if !guideStart.IsZero() {
		library["guideStartsAt"] = guideStart
	}
	if !guideEnd.IsZero() {
		library["guideEndsAt"] = guideEnd
	}
	s.cache.mu.RUnlock()
	s.stateMu.RLock()
	catSync, epgSync := s.catalogSync, s.epgSync
	catErr, epgErr := s.catalogError, s.epgError
	s.stateMu.RUnlock()
	catSync.IntervalSeconds, epgSync.IntervalSeconds = s.refreshInterval(true).Seconds(), s.refreshInterval(false).Seconds()
	catSync.Error, epgSync.Error = catErr, epgErr
	if cooldown.After(time.Now()) {
		for _, state := range []*refreshState{&catSync, &epgSync} {
			if state.NextRefreshAt != nil && cooldown.After(*state.NextRefreshAt) {
				state.NextRefreshAt = &cooldown
			}
		}
	}
	if catSync.LastSuccessfulAt == nil && !metadataAt.IsZero() {
		catSync.LastSuccessfulAt = &metadataAt
	}
	if epgSync.LastSuccessfulAt == nil && !epg.IsZero() {
		epgSync.LastSuccessfulAt = &epg
	}
	busy := catSync.Queued || catSync.Running || epgSync.Queued || epgSync.Running
	active := 0
	if s.streams != nil {
		active = s.streams.Active()
	}
	out := map[string]any{"configured": s.provider != nil, "refreshing": busy, "activeStreams": active, "maxStreams": s.cfg.MaxStreams}
	out["sync"] = map[string]any{"catalog": catSync, "epg": epgSync}
	out["library"] = library
	out["timezone"], out["guideHours"] = s.cfg.Timezone, s.cfg.EPGHours
	out["playback"] = map[string]any{"transcodeMode": s.cfg.TranscodeMode, "sessionTimeoutSeconds": s.cfg.SessionTTL.Seconds()}
	if cooldown.After(time.Now()) {
		out["portalCooldownUntil"] = cooldown
	}
	if !cat.IsZero() {
		out["catalogUpdatedAt"] = cat
	}
	if !libraryUpdated.IsZero() {
		out["libraryUpdatedAt"] = libraryUpdated
	}
	if !fullCat.IsZero() {
		out["catalogRefreshCompletedAt"] = fullCat
	}
	if !epg.IsZero() {
		out["epgUpdatedAt"] = epg
	}
	if catErr != "" {
		out["error"] = catErr
	} else if epgErr != "" {
		out["error"] = epgErr
	}
	respond(w, 200, out)
}

// Manual refreshes wake the existing schedulers; they never create a second
// refresh worker or tie shared work to the requesting browser's lifetime.
func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	if s.provider == nil {
		fail(w, 503, "unconfigured", "Configure the portal on the server first.")
		return
	}
	var input struct {
		Target string `json:"target"`
	}
	if !decode(w, r, &input) {
		return
	}
	if input.Target == "" {
		input.Target = "all"
	}
	if input.Target != "all" && input.Target != "catalog" && input.Target != "epg" {
		fail(w, 400, "invalid", "Choose library, programme guide, or all.")
		return
	}
	s.cache.mu.RLock()
	cooldown := s.cache.portalCooldownUntil
	s.cache.mu.RUnlock()
	if cooldown.After(time.Now()) {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(time.Until(cooldown).Seconds()))))
		fail(w, 429, "cooldown", "The provider is cooling down. Refresh will resume automatically.")
		return
	}
	s.stateMu.Lock()
	if s.ctx.Err() != nil {
		s.stateMu.Unlock()
		fail(w, 503, "unavailable", "The server is shutting down.")
		return
	}
	for idx, state := range []*refreshState{&s.catalogSync, &s.epgSync} {
		if (idx == 0 && input.Target == "epg") || (idx == 1 && input.Target == "catalog") {
			continue
		}
		if !state.Running && !state.Queued {
			state.Queued = true
			select {
			case s.refreshWake[idx] <- struct{}{}:
			default:
			}
		}
	}
	s.stateMu.Unlock()
	respond(w, 202, map[string]any{"accepted": true})
}
func publicItems(items []model.Item) []model.Item {
	out := make([]model.Item, 0, len(items))
	for _, i := range items {
		i.Image = "/api/images/" + url.PathEscape(i.ID)
		out = append(out, i)
	}
	return out
}
func (s *Server) item(w http.ResponseWriter, r *http.Request) {
	i, ok := s.cache.item(r.PathValue("id"))
	if !ok {
		fail(w, 404, "not_found", "Title not found in the library.")
		return
	}
	respond(w, 200, map[string]any{"item": publicItems([]model.Item{i})[0]})
}
func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.RLock()
	data, tag := s.cache.catalogJSON, s.cache.catalogETag
	s.cache.mu.RUnlock()
	writeSnapshot(w, r, data, tag)
}
func (s *Server) epg(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.RLock()
	data, tag := s.cache.epgJSON, s.cache.epgETag
	s.cache.mu.RUnlock()
	writeSnapshot(w, r, data, tag)
}
func writeSnapshot(w http.ResponseWriter, r *http.Request, data []byte, tag string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", tag)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}
func (s *Server) episodes(w http.ResponseWriter, r *http.Request) {
	if s.provider == nil {
		fail(w, 503, "unconfigured", "Configure the portal on the server first.")
		return
	}
	id := r.PathValue("id")
	item, ok := s.cache.item(id)
	if !ok || item.Kind != "series" {
		fail(w, 404, "not_found", "Series not found.")
		return
	}
	revision := s.cache.libraryRevision()
	items, cached := s.cache.getEpisodes(id, s.cfg.EpisodeCacheTTL)
	if !cached {
		key := id + "\x00" + revision.Format(time.RFC3339Nano)
		value, err, _ := s.episodeFlights.Do(key, func() (any, error) {
			cachedItems, exists := s.cache.getEpisodes(id, s.cfg.EpisodeCacheTTL)
			if exists {
				return cachedItems, nil
			}
			started := time.Now()
			ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
			defer cancel()
			loaded, err := s.provider.Episodes(ctx, item)
			if err != nil {
				if s.ctx.Err() == nil {
					slog.Warn("Episode load failed", "seriesID", safeEpisodeLogID(id), "stage", "provider", "reason", episodeFailureReason(err), "elapsed", time.Since(started).Round(time.Millisecond))
				}
				return nil, err
			}
			if err = s.cache.setEpisodesAtRevision(id, loaded, revision); err != nil {
				if !errors.Is(err, errSeriesRemoved) {
					slog.Warn("Episode load failed", "seriesID", safeEpisodeLogID(id), "stage", "cache", "reason", "write_failed", "elapsed", time.Since(started).Round(time.Millisecond))
				}
				return nil, err
			}
			return loaded, nil
		})
		if err != nil {
			if errors.Is(err, errSeriesRemoved) {
				fail(w, 404, "not_found", "Series not found.")
				return
			}
			fail(w, 502, "upstream", "Could not load episodes from the portal. Try again.")
			return
		}
		items = value.([]model.Item)
	}
	respond(w, 200, map[string]any{"items": publicItems(items)})
}
func safeEpisodeLogID(id string) string {
	value, ok := strings.CutPrefix(id, "series:")
	if !ok || value == "" {
		return "unknown"
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return "unknown"
		}
	}
	return id
}
func episodeFailureReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "http 429"), strings.Contains(message, "rate limit"):
		return "rate_limited"
	case strings.Contains(message, "authorization"), strings.Contains(message, "unauthorized"):
		return "authorization"
	case strings.Contains(message, "invalid data"), strings.Contains(message, "invalid portal list"), strings.Contains(message, "invalid portal ordered list"), strings.Contains(message, "invalid portal episode list"):
		return "invalid_portal_data"
	case strings.Contains(message, "portal list incomplete"):
		return "list_incomplete"
	case strings.Contains(message, "pagination limit"):
		return "pagination_limit"
	case strings.Contains(message, "request failed"):
		return "request_failed"
	default:
		return "provider_error"
	}
}
func (s *Server) refreshInterval(catalog bool) time.Duration {
	interval := s.cfg.EPGRefresh
	if catalog {
		interval = s.cfg.CatalogRefresh
	}
	if interval <= 0 {
		interval = 6 * time.Hour
		if catalog {
			interval = 24 * time.Hour
		}
	}
	return interval
}
func (s *Server) scheduler(catalog bool) {
	defer s.wg.Done()
	interval := s.refreshInterval(catalog)
	kind, idx, state := "epg", 1, &s.epgSync
	if catalog {
		kind, idx, state = "metadata", 0, &s.catalogSync
	}
	s.cache.mu.RLock()
	last := s.cache.epgAt
	if catalog {
		last = s.cache.catalogAt
		if _, ok := s.provider.(model.BrowseProvider); ok && s.cache.categoriesAt.Before(last) {
			last = s.cache.categoriesAt
		}
	}
	cooldown := s.cache.portalCooldownUntil
	s.cache.mu.RUnlock()
	next := last.Add(interval)
	if last.IsZero() {
		next = time.Now()
	}
	if cooldown.After(next) {
		next = cooldown
	}
	failures := 0
	for {
		s.stateMu.Lock()
		nextAt := next
		state.NextRefreshAt = &nextAt
		s.stateMu.Unlock()
		timer := time.NewTimer(max(0, time.Until(next)))
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-s.refreshWake[idx]:
			timer.Stop()
		}
		// A different worker can discover a shared provider cooldown while this
		// scheduler is waiting. Recheck it before any provider request.
		s.cache.mu.RLock()
		cooldown = s.cache.portalCooldownUntil
		s.cache.mu.RUnlock()
		if cooldown.After(time.Now()) {
			next = cooldown
			s.stateMu.Lock()
			select {
			case <-s.refreshWake[idx]:
			default:
			}
			state.Queued = false
			s.stateMu.Unlock()
			continue
		}
		s.stateMu.Lock()
		// If the timer and a manual request arrived together, consume the wake
		// here so it cannot trigger another refresh after this one completes.
		select {
		case <-s.refreshWake[idx]:
		default:
		}
		started := time.Now().UTC()
		state.Queued, state.Running, state.StartedAt = false, true, &started
		state.NextRefreshAt = nil
		s.stateMu.Unlock()
		err := s.doRefresh(catalog, !catalog)
		s.stateMu.Lock()
		finished := time.Now().UTC()
		state.Running, state.FinishedAt = false, &finished
		if err == nil {
			state.LastSuccessfulAt = &finished
		}
		s.stateMu.Unlock()
		if s.ctx.Err() != nil {
			return
		}
		if err != nil {
			failures++
			next = time.Now().Add(retryCooldown(err, failures))
			var limited interface{ RetryDelay() time.Duration }
			if errors.As(err, &limited) && limited.RetryDelay() > 0 {
				_ = s.cache.setRetryDeadline(false, next, true)
			}
			slog.Info("Refresh retry scheduled", "kind", kind, "nextAt", next, "failures", failures)
		} else {
			failures = 0
			next = time.Now().Add(interval)
		}
	}
}
func retryCooldown(err error, failures int) time.Duration {
	var limited interface{ RetryDelay() time.Duration }
	if errors.As(err, &limited) && limited.RetryDelay() > 0 {
		return limited.RetryDelay()
	}
	return min(time.Minute<<min(max(failures-1, 0), 5), 30*time.Minute)
}
func (s *Server) doRefresh(catalog, epg bool) error {
	var refreshErr error
	if catalog {
		started := time.Now()
		ctx, cancel := context.WithTimeout(s.ctx, 5*time.Minute)
		items, err := s.provider.Catalog(ctx)
		if err == nil {
			err = s.cache.setCatalog(items)
		}
		if err == nil {
			if provider, ok := s.provider.(model.BrowseProvider); ok {
				var categories []model.Category
				categories, err = provider.Categories(ctx)
				if err == nil {
					err = s.cache.setCategories(categories)
				}
			}
		}
		cancel()
		if err == nil {
			err = s.cache.invalidateLibrary()
		}
		message := ""
		if err != nil {
			if s.ctx.Err() != nil {
				return err
			}
			message = "Portal metadata refresh failed. Showing saved data."
			slog.Warn("Portal metadata refresh failed", "error", err, "elapsed", time.Since(started).Round(time.Millisecond))
			refreshErr = err
		} else {
			slog.Info("Portal metadata refresh completed", "liveChannels", len(items), "elapsed", time.Since(started).Round(time.Millisecond))
		}
		s.stateMu.Lock()
		s.catalogError = message
		s.stateMu.Unlock()
	}
	if epg && s.ctx.Err() == nil {
		started := time.Now()
		ctx, cancel := context.WithTimeout(s.ctx, 5*time.Minute)
		programs, err := s.provider.EPG(ctx)
		cancel()
		message := ""
		if err != nil {
			if s.ctx.Err() != nil {
				return err
			}
			message = "Program guide refresh failed. Showing saved data."
			slog.Warn("Program guide refresh failed", "error", err, "elapsed", time.Since(started).Round(time.Millisecond))
			refreshErr = err
		} else if err = s.cache.setEPG(programs); err != nil {
			message = "Program guide cache could not be saved."
			slog.Warn("Could not persist program guide cache", "error", err)
			refreshErr = err
		} else {
			slog.Info("Program guide refresh completed", "programs", len(programs), "elapsed", time.Since(started).Round(time.Millisecond))
		}
		s.stateMu.Lock()
		s.epgError = message
		s.stateMu.Unlock()
	}
	return refreshErr
}
func (s *Server) categories(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.RLock()
	categories := append([]model.Category(nil), s.cache.categories...)
	s.cache.mu.RUnlock()
	if categories == nil {
		categories = []model.Category{}
	}
	respond(w, 200, map[string]any{"categories": categories})
}
func (s *Server) browse(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.provider.(model.BrowseProvider)
	if !ok {
		fail(w, 503, "unconfigured", "Configure the portal on the server first.")
		return
	}
	q := model.BrowseQuery{Kind: r.URL.Query().Get("kind"), Category: r.URL.Query().Get("category"), Search: strings.TrimSpace(r.URL.Query().Get("search")), Page: 1}
	if q.Kind != "movie" && q.Kind != "series" {
		fail(w, 400, "invalid", "Choose movies or series.")
		return
	}
	if len(q.Search) > 120 || len(q.Category) > 80 {
		fail(w, 400, "invalid", "Search or category is too long.")
		return
	}
	if q.Category == "" {
		q.Category = "*"
	}
	if raw := r.URL.Query().Get("page"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 10000 {
			fail(w, 400, "invalid", "Invalid page.")
			return
		}
		q.Page = n
	}

	s.cache.mu.RLock()
	if q.Kind == "series" {
		for _, c := range s.cache.categories {
			if c.Kind == "series" && (q.Category == "*" || q.Category == c.ID) {
				q.SourceType = c.SourceType
				break
			}
		}
	}
	s.cache.mu.RUnlock()
	page, found, err := s.cache.browse(q, s.cfg.CatalogRefresh)
	if err != nil {
		fail(w, 500, "cache", "Could not read the saved page.")
		return
	}
	if found {
		page.Items = publicItems(page.Items)
		respond(w, 200, page)
		return
	}
	// The fetch belongs to the server lifetime, so disconnecting one browser does
	// not cancel work shared by other viewers.
	revision := s.cache.libraryRevision()
	key := q.Kind + "\x00" + q.Category + "\x00" + q.Search + "\x00" + strconv.Itoa(q.Page) + "\x00" + revision.Format(time.RFC3339Nano)
	s.browseMu.Lock()
	if s.browseClosed {
		s.browseMu.Unlock()
		fail(w, 503, "unavailable", "Server is stopping.")
		return
	}
	s.browseWG.Add(1)
	result := s.browseFlights.DoChan(key, func() (any, error) {

		if saved, ok, err := s.cache.browse(q, s.cfg.CatalogRefresh); err != nil {
			return nil, err
		} else if ok {
			return saved, nil
		}
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
		defer cancel()
		loaded, err := provider.Browse(ctx, q)
		if err != nil {
			return nil, err
		}
		s.cache.mu.RLock()
		categoryNames := make(map[string]string)
		for _, c := range s.cache.categories {
			if c.Kind == q.Kind {
				categoryNames[c.ID] = c.Name
			}
		}
		s.cache.mu.RUnlock()
		for n := range loaded.Items {
			item := &loaded.Items[n]
			if item.CategoryID == "" && q.Category != "*" {
				item.CategoryID = q.Category
			}
			if name := categoryNames[item.CategoryID]; name != "" {
				item.Category = name
			}
		}
		if err = s.cache.setBrowseAtRevision(q, loaded, s.cfg.CatalogRefresh, revision); err != nil {
			return nil, err
		}
		return loaded, nil
	})
	s.browseMu.Unlock()
	done := make(chan singleflight.Result, 1)
	go func() { res := <-result; done <- res; s.browseWG.Done() }()
	select {
	case <-r.Context().Done():
		return
	case res := <-done:
		if res.Err != nil {
			fail(w, 502, "upstream", "Could not load this page from the portal. Try again.")
			return
		}
		page = res.Val.(model.BrowsePage)
		page.Items = publicItems(page.Items)
		respond(w, 200, page)
	}
}
func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	if s.provider == nil || s.streams == nil {
		fail(w, 503, "unconfigured", "Configure the portal on the server first.")
		return
	}
	var body struct {
		ItemID string  `json:"itemId"`
		Start  float64 `json:"start"`
	}
	if !decode(w, r, &body) {
		return
	}
	item, ok := s.cache.item(body.ItemID)
	if !ok {
		fail(w, 404, "not_found", "This item is no longer available. Choose another title.")
		return
	}
	if item.Kind == "series" {
		fail(w, 400, "invalid", "Choose an episode to play.")
		return
	}
	if !validPosition(body.Start) {
		fail(w, 400, "invalid", "Invalid start position.")
		return
	}
	session, err := s.streams.Start(r.Context(), item, body.Start)
	if err != nil {
		streamError(w, err)
		return
	}
	respond(w, 201, session)
}
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	if s.streams == nil {
		streamError(w, stream.ErrNotFound)
		return
	}
	session, err := s.streams.Get(r.PathValue("id"))
	if err != nil {
		streamError(w, err)
		return
	}
	respond(w, 200, session)
}
func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	if s.streams == nil {
		streamError(w, stream.ErrNotFound)
		return
	}
	if err := s.streams.Heartbeat(r.PathValue("id")); err != nil {
		streamError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) seek(w http.ResponseWriter, r *http.Request) {
	if s.streams == nil {
		streamError(w, stream.ErrNotFound)
		return
	}
	var body struct {
		Position float64 `json:"position"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !validPosition(body.Position) {
		fail(w, 400, "invalid", "Invalid seek position.")
		return
	}
	session, err := s.streams.Seek(r.Context(), r.PathValue("id"), body.Position)
	if err != nil {
		streamError(w, err)
		return
	}
	respond(w, 200, session)
}
func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	if s.streams != nil {
		err := s.streams.Stop(r.PathValue("id"))
		if err != nil && !errors.Is(err, stream.ErrNotFound) {
			streamError(w, err)
			return
		}
	}
	w.WriteHeader(204)
}
func validPosition(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 }
func streamError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, stream.ErrCapacity):
		fail(w, 409, "capacity", "No room available. All streaming slots are in use. Try again when someone stops watching.")
	case errors.Is(err, stream.ErrNotFound):
		fail(w, 404, "not_found", "This playback session has ended. Play again to reconnect.")
	case errors.Is(err, stream.ErrInvalid):
		fail(w, 400, "invalid", "That playback request is not valid.")
	default:
		fail(w, 502, "stream", "Could not start playback. Please try again.")
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		fail(w, 400, "invalid", "Invalid request.")
		return false
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		fail(w, 400, "invalid", "Invalid request.")
		return false
	}
	return true
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, code, message string) {
	respond(w, status, map[string]string{"error": message, "code": code})
}

func (s *Server) image(w http.ResponseWriter, r *http.Request) {
	item, ok := s.cache.item(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	if item.Logo == "" {
		writeImage(w, fallbackArtwork, s.imageFailureTTL)
		return
	}
	u, err := url.Parse(item.Logo)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		writeImage(w, fallbackArtwork, s.imageFailureTTL)
		return
	}
	key := u.String()
	if cached, ok := s.imageCache.Get(key); ok {
		writeImage(w, cached, s.imageFailureTTL)
		return
	}
	value, err, _ := s.imageFlights.Do(key, func() (any, error) {
		if cached, ok := s.imageCache.Get(key); ok {
			return cached, nil
		}
		image, err := s.fetchImage(key)
		ttl := imageCacheTTL
		if err != nil {
			image = fallbackArtwork
			ttl = s.imageFailureTTL
		}
		s.imageCache.SetWithTTL(key, image, int64(len(image.data)), ttl)
		s.imageCache.Wait()
		return image, nil
	})
	if err != nil {
		writeImage(w, fallbackArtwork, s.imageFailureTTL)
		return
	}
	writeImage(w, value.(imageData), s.imageFailureTTL)
}
func (s *Server) fetchImage(rawURL string) (imageData, error) {
	req, err := http.NewRequestWithContext(s.ctx, "GET", rawURL, nil)
	if err != nil {
		return imageData{}, err
	}
	req.Header.Set("User-Agent", "Restream/1.0")
	res, err := s.imageClient.Do(req)
	if err != nil {
		return imageData{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return imageData{}, fmt.Errorf("image upstream returned %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, (5<<20)+1))
	if err != nil || len(data) > 5<<20 {
		return imageData{}, fmt.Errorf("image too large or unreadable: %w", err)
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif":
	default:
		return imageData{}, fmt.Errorf("invalid image type: %s", mime)
	}
	return imageData{data: data, mime: mime}, nil
}
func writeImage(w http.ResponseWriter, image imageData, failureTTL time.Duration) {
	w.Header().Set("Content-Type", image.mime)
	w.Header().Set("Content-Length", fmt.Sprint(len(image.data)))
	ttl := imageCacheTTL
	if image.fallback {
		ttl = failureTTL
	}
	w.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", int(ttl.Seconds())))
	w.Write(image.data)
}
