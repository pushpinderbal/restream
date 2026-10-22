package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

	"golang.org/x/sync/singleflight"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

type Streams interface {
	Start(context.Context, model.Item, float64) (stream.Session, error)
	Get(string) (stream.Session, error)
	Heartbeat(string) error
	Seek(context.Context, string, float64) (stream.Session, error)
	SetPlaybackRate(context.Context, string, float64, float64) (stream.Session, error)
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
	artwork                *artworkCache
	discoveryService       *discoveryService
	preferencesService     *preferencesService
	sessionItemsMu         sync.Mutex
	sessionItems           map[string]model.Item
	sessionOwners          map[string]string
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
	Failures         int        `json:"failures"`
	Paused           bool       `json:"paused"`
	Configuration    string     `json:"-"`
}

func New(cfg Config, provider model.Provider, streams Streams) (*Server, error) {
	if cfg.RefreshInterval <= 0 {
		cfg.RefreshInterval = 24 * time.Hour
	}
	cache, err := openStore(cfg.DataDir, cfg.PortalURL, cfg.MAC)
	if err != nil {
		return nil, err
	}
	if err := initWatchHistory(cache.db); err != nil {
		_ = cache.close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	artwork, err := newArtworkCache(ctx, cache.db)
	if err != nil {
		cancel()
		_ = cache.close()
		return nil, err
	}
	s := &Server{cfg: cfg, provider: provider, streams: streams, cache: cache, ctx: ctx, cancel: cancel, artwork: artwork}
	if err := s.initPreferences(); err != nil {
		cancel()
		artwork.close()
		_ = cache.close()
		return nil, err
	}
	if err := s.initDiscovery(); err != nil {
		cancel()
		artwork.close()
		_ = cache.close()
		return nil, err
	}
	if err := s.initScheduledRefresh(); err != nil {
		cancel()
		artwork.close()
		_ = cache.close()
		return nil, err
	}
	s.refreshWake = [2]chan struct{}{make(chan struct{}, 1), make(chan struct{}, 1)}
	s.sessionItems = make(map[string]model.Item)
	s.sessionOwners = make(map[string]string)
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
			if err := cache.setPortalCooldown(next); err != nil {
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
	mux.HandleFunc("/api/preferences", s.getPreferences)
	mux.HandleFunc("/api/watch-history", s.watchHistory)
	mux.HandleFunc("POST /api/watch-history/record", s.recordWatchHistory)
	mux.HandleFunc("PATCH /api/watch-history/progress", s.progressWatchHistory)
	mux.HandleFunc("POST /api/watch-history/undo", s.undoWatchHistory)
	mux.HandleFunc("POST /api/refresh", s.refresh)
	mux.HandleFunc("GET /api/catalog", s.catalog)
	mux.HandleFunc("GET /api/categories", s.categories)
	mux.HandleFunc("GET /api/browse", s.browse)
	mux.HandleFunc("GET /api/discovery", s.discover)
	mux.HandleFunc("GET /api/discovery/images/{id}/{type}", s.discoveryImage)
	mux.HandleFunc("GET /api/epg", s.epg)
	mux.HandleFunc("GET /api/series/{id}/episodes", s.episodes)
	mux.HandleFunc("GET /api/items/{id}", s.item)
	mux.HandleFunc("GET /api/images/{id}", s.image)
	mux.HandleFunc("POST /api/sessions", s.start)
	mux.HandleFunc("GET /api/sessions/{id}", s.session)
	mux.HandleFunc("POST /api/sessions/{id}/heartbeat", s.heartbeat)
	mux.HandleFunc("POST /api/sessions/{id}/seek", s.seek)
	mux.HandleFunc("POST /api/sessions/{id}/speed", s.playbackSpeed)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.stop)
	if streams != nil {
		mux.Handle("/api/streams/", s.policyMedia(streams.MediaHandler()))
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "not_found", "Not found.") })
	mux.Handle("/", s.static())
	guard := http.NewCrossOriginProtection()
	guard.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail(w, 403, "origin", "Cross-origin requests are not allowed.")
	}))
	s.handler = s.headers(guard.Handler(mux))
	if provider != nil {
		// A warm library may not be due for hours after a restart or a settings
		// change. Repair due discovery now without waiting for a dashboard read.
		cache.mu.RLock()
		last := cache.catalogAt
		if _, ok := provider.(model.BrowseProvider); ok && cache.categoriesAt.Before(last) {
			last = cache.categoriesAt
		}
		cache.mu.RUnlock()
		if s.tmdbConfigured() && s.nextScheduledRefresh(last).After(time.Now()) {
			s.queueDiscovery(cache.libraryRevision())
		}
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
	s.discoveryService.mu.Lock()
	s.discoveryService.closed = true
	if s.discoveryService.retryTimer != nil {
		s.discoveryService.retryTimer.Stop()
	}
	s.discoveryService.mu.Unlock()
	s.cancel()
	s.wg.Wait()
	s.browseWG.Wait()
	s.discoveryService.wg.Wait()
	s.artwork.close()
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
				http.Error(w, "Web interface files are missing.", http.StatusServiceUnavailable)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
}
func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	policy := s.preferencesSnapshot()
	s.cache.mu.RLock()
	cat, fullCat, epg, libraryUpdated := s.cache.catalogPublishedAt, s.cache.catalogAt, s.cache.epgAt, s.cache.libraryRefreshedAt
	metadataAt := fullCat
	if _, ok := s.provider.(model.BrowseProvider); ok && s.cache.categoriesAt.Before(metadataAt) {
		metadataAt = s.cache.categoriesAt
	}
	cooldown := s.cache.portalCooldownUntil
	library := map[string]any{"liveChannels": len(s.cache.items), "categories": len(s.cache.categories), "programmes": len(s.cache.programs)}
	if policy.restricted() {
		live, categories := 0, 0
		for _, item := range s.cache.items {
			if s.itemPreferenceLocked(item, policy).Visibility == "show" {
				live++
			}
		}
		for _, category := range s.cache.categories {
			if policy.category(category.Kind, category.ID, category.Name).Visibility == "show" {
				categories++
			}
		}
		library["liveChannels"], library["categories"] = live, categories
	}
	movies, series := 0, 0
	for _, item := range s.cache.byID {
		if policy.restricted() && s.itemPreferenceLocked(item, policy).Visibility != "show" {
			continue
		}
		if item.Kind == "movie" {
			movies++
		}
		if item.Kind == "series" {
			series++
		}
	}
	library["cachedMovies"], library["cachedSeries"] = movies, series
	var guideStart, guideEnd time.Time
	visiblePrograms := 0
	for _, program := range s.cache.programs {
		if policy.restricted() {
			channel, known := s.cache.byID[program.ChannelID]
			if !known || s.itemPreferenceLocked(channel, policy).Visibility != "show" {
				continue
			}
		}
		visiblePrograms++
		if guideStart.IsZero() || program.Start.Before(guideStart) {
			guideStart = program.Start
		}
		if program.End.After(guideEnd) {
			guideEnd = program.End
		}
	}
	library["programmes"] = visiblePrograms
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
	catSync.IntervalSeconds, epgSync.IntervalSeconds = s.refreshInterval().Seconds(), s.refreshInterval().Seconds()
	catSync.Error, epgSync.Error = catErr, epgErr
	s.discoveryService.mu.Lock()
	discoveryRecord := s.discoveryService.record
	discoverySync := refreshState{Running: s.discoveryService.refreshing, Queued: discoveryRecord.Pending && discoveryRecord.Error == "", Paused: discoveryRecord.Paused, Failures: discoveryRecord.Failures, Error: discoveryRecord.Error, IntervalSeconds: s.discoveryRefreshInterval().Seconds()}
	if !discoveryRecord.UpdatedAt.IsZero() {
		discoverySync.LastSuccessfulAt = &discoveryRecord.UpdatedAt
	}
	if !discoveryRecord.NextAttempt.IsZero() {
		discoverySync.NextRefreshAt = &discoveryRecord.NextAttempt
	}
	s.discoveryService.mu.Unlock()
	discoveryRefreshing := discoverySync.Running || discoverySync.Queued
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
	busy := catSync.Queued || catSync.Running || epgSync.Queued || epgSync.Running || discoveryRefreshing
	out := map[string]any{"configured": s.provider != nil, "refreshing": busy, "library": library}
	if updated := policy.updatedAt; !updated.IsZero() {
		out["preferencesUpdatedAt"] = updated
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
	if user := authenticatedUser(r); user != nil && user.Role == "viewer" {
		if catErr != "" || epgErr != "" {
			out["error"] = "Library updates are temporarily unavailable."
		}
		respond(w, 200, out)
		return
	}
	active := 0
	if s.streams != nil {
		active = s.streams.Active()
	}
	out["activeStreams"], out["maxStreams"] = active, s.cfg.MaxStreams
	out["sync"] = map[string]any{"catalog": catSync, "epg": epgSync, "discovery": discoverySync}
	out["timezone"], out["guideHours"] = s.cfg.Timezone, s.cfg.EPGHours
	out["playback"] = map[string]any{"transcodeMode": s.cfg.TranscodeMode, "sessionTimeoutSeconds": s.cfg.SessionTTL.Seconds()}
	if cooldown.After(time.Now()) {
		out["portalCooldownUntil"] = cooldown
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
		fail(w, 503, "unconfigured", "Connect your provider in Settings first.")
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
	if input.Target != "epg" && !s.catalogSync.Running && !s.catalogSync.Queued {
		if err := s.cache.invalidateLibrary(); err != nil {
			s.stateMu.Unlock()
			fail(w, 500, "cache", "Could not prepare the library refresh.")
			return
		}
	}
	for idx, state := range []*refreshState{&s.catalogSync, &s.epgSync} {
		if (idx == 0 && input.Target == "epg") || (idx == 1 && input.Target == "catalog") {
			continue
		}
		if !state.Running && !state.Queued {
			state.Queued = true
			state.Failures, state.Paused, state.Error = 0, false, ""
			now := time.Now().UTC()
			state.NextRefreshAt = &now
			kind := "epg"
			if idx == 0 {
				kind = "metadata"
			}
			if err := s.saveScheduledRefresh(kind, *state); err != nil {
				state.Queued = false
				s.stateMu.Unlock()
				fail(w, 500, "cache", "Could not prepare the refresh.")
				return
			}
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
		if i.Logo != "" {
			version := sha256.Sum256([]byte(i.Logo))
			i.Image += "?v=" + hex.EncodeToString(version[:8])
		}
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
	if s.blockedItem(i) {
		blocked(w)
		return
	}
	respond(w, 200, map[string]any{"item": publicItems([]model.Item{i})[0]})
}
func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.RLock()
	data, tag := s.cache.catalogJSON, s.cache.catalogETag
	items := append([]model.Item(nil), s.cache.items...)
	s.cache.mu.RUnlock()
	if s.preferencesSnapshot().restricted() {
		var err error
		data, tag, err = catalogSnapshot(s.visibleItems(items, r.URL.Query().Get("dashboard") == "1"))
		if err != nil {
			fail(w, 500, "cache", "Could not read the library.")
			return
		}
	}
	writeSnapshot(w, r, data, tag)
}
func (s *Server) epg(w http.ResponseWriter, r *http.Request) {
	s.cache.mu.RLock()
	data, tag := s.cache.epgJSON, s.cache.epgETag
	programs := append([]model.Program(nil), s.cache.programs...)
	items := append([]model.Item(nil), s.cache.items...)
	s.cache.mu.RUnlock()
	if s.preferencesSnapshot().restricted() {
		channels := map[string]bool{}
		for _, item := range s.visibleItems(items, false) {
			channels[item.ID] = true
		}
		visible := make([]model.Program, 0, len(programs))
		for _, program := range programs {
			if channels[program.ChannelID] {
				visible = append(visible, program)
			}
		}
		var err error
		data, tag, err = epgSnapshot(visible)
		if err != nil {
			fail(w, 500, "cache", "Could not read the programme guide.")
			return
		}
	}
	writeSnapshot(w, r, data, tag)
}
func writeSnapshot(w http.ResponseWriter, r *http.Request, data []byte, tag string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", tag)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}
func (s *Server) episodes(w http.ResponseWriter, r *http.Request) {
	if s.provider == nil {
		fail(w, 503, "unconfigured", "Connect your provider in Settings first.")
		return
	}
	id := r.PathValue("id")
	item, ok := s.cache.item(id)
	if !ok || item.Kind != "series" {
		fail(w, 404, "not_found", "Series not found.")
		return
	}
	if s.blockedItem(item) {
		blocked(w)
		return
	}
	if r.URL.Query().Has("season") {
		s.seasonEpisodes(w, r, item)
		return
	}
	items, status, err := s.loadEpisodeList(r, item, id, s.cache.cacheRevision(), func(ctx context.Context) ([]model.Item, error) { return s.provider.Episodes(ctx, item) })
	if err != nil {
		seasonFailure(w, err)
		return
	}
	if s.blockedItem(item) {
		blocked(w)
		return
	}
	respond(w, 200, map[string]any{"items": publicItems(items), "refreshing": status.Refreshing, "stale": status.Stale, "refreshAfterSeconds": status.RefreshAfterSeconds})
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
func providerFailureReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "response exceeds configured size limit"):
		return "response_too_large"
	case strings.Contains(message, "http 429"), strings.Contains(message, "rate limit"):
		return "rate_limited"
	case strings.Contains(message, "authorization"), strings.Contains(message, "unauthorized"), strings.Contains(message, "http 401"), strings.Contains(message, "http 403"), strings.Contains(message, "handshake returned no token"):
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
func (s *Server) refreshInterval() time.Duration {
	return time.Duration(s.preferencesSnapshot().value.RefreshIntervalSeconds) * time.Second
}
func (s *Server) doRefresh(catalog, epg bool) error {
	var refreshErr error
	if catalog {
		started := time.Now()
		slog.Info("Portal metadata refresh started")
		ctx, cancel := context.WithTimeout(s.ctx, refreshAttemptTimeout)
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
			err = s.cache.publishLibrary()
		}
		message := ""
		if err != nil {
			if s.ctx.Err() != nil {
				return err
			}
			message = "Portal metadata refresh failed. Showing saved data."
			refreshErr = err
		} else {
			slog.Info("Portal metadata refresh completed", "liveChannels", len(items), "elapsed", time.Since(started).Round(time.Millisecond))
		}
		s.stateMu.Lock()
		s.catalogError = message
		s.stateMu.Unlock()
		if err == nil && s.tmdbConfigured() {
			if _, ok := s.provider.(model.BrowseProvider); ok {
				// Discovery records its own outcome and retry details.
				_ = s.refreshDiscoveryAfterLibrary(s.cache.libraryRevision())
			}
		}
	}
	if epg && s.ctx.Err() == nil {
		started := time.Now()
		slog.Info("Program guide refresh started")
		ctx, cancel := context.WithTimeout(s.ctx, refreshAttemptTimeout)
		programs, err := s.provider.EPG(ctx)
		cancel()
		if err == nil {
			programs = usableGuide(programs, time.Now())
			if len(programs) == 0 {
				err = guideUnavailableError{}
			}
		}
		message := ""
		if err != nil {
			if s.ctx.Err() != nil {
				return err
			}
			message = "Program guide refresh failed. Showing saved data."
			refreshErr = err
		} else if err = s.cache.setEPG(programs); err != nil {
			message = "Program guide cache could not be saved."
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
	if r.URL.Query().Get("manage") != "1" {
		p := s.preferencesSnapshot()
		visible := make([]model.Category, 0, len(categories))
		for _, category := range categories {
			if p.category(category.Kind, category.ID, category.Name).Visibility == "show" {
				visible = append(visible, category)
			}
		}
		categories = visible
	}
	respond(w, 200, map[string]any{"categories": categories})
}
func (s *Server) browse(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.provider.(model.BrowseProvider)
	if !ok {
		fail(w, 503, "unconfigured", "Connect your provider in Settings first.")
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
	if !s.browseCategoryAllowed(q.Kind, q.Category) {
		respond(w, 200, model.BrowsePage{Items: []model.Item{}, Page: q.Page})
		return
	}

	s.cache.mu.RLock()
	q.SourceType = s.cache.browseSourceTypeLocked(q)
	s.cache.mu.RUnlock()
	through := q.Page
	if raw := r.URL.Query().Get("through"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < q.Page || n > 10000 || n-q.Page >= 100 {
			fail(w, 400, "invalid", "Invalid page range.")
			return
		}
		through = n
	}
	page, err := s.loadBrowseRange(r.Context(), provider, q, through)
	if err != nil {
		fail(w, 502, "upstream", "Could not load this page from the portal. Try again.")
		return
	}
	page.Items = publicItems(s.visibleItems(page.Items, false))
	respond(w, 200, page)
}
func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	if s.provider == nil || s.streams == nil {
		fail(w, 503, "unconfigured", "Connect your provider in Settings first.")
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
	if s.blockedItem(item) {
		blocked(w)
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
	ctx := stream.WithLogger(r.Context(), slog.With(activityAttrs(r)...))
	session, err := s.streams.Start(ctx, item, body.Start)
	if err != nil {
		if r.Context().Err() == nil {
			reason := "stream_unavailable"
			if errors.Is(err, stream.ErrCapacity) {
				reason = "capacity_reached"
			} else if errors.Is(err, stream.ErrInvalid) {
				reason = "invalid_request"
			}
			slog.Warn("Stream start rejected", append(activityAttrs(r), "kind", item.Kind, "reason", reason)...)
		}
		streamError(w, err)
		return
	}
	if !s.rememberSession(r, session.ID, item) {
		blocked(w)
		return
	}
	slog.Info("Stream starting", append(activityAttrs(r), "session_id", session.ID, "kind", item.Kind, "offset", body.Start)...)
	respond(w, 201, session)
}
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	if !s.sessionAllowed(w, r, r.PathValue("id")) {
		return
	}
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
	if !s.sessionAllowed(w, r, r.PathValue("id")) {
		return
	}
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
	if !s.sessionAllowed(w, r, r.PathValue("id")) {
		return
	}
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
func (s *Server) playbackSpeed(w http.ResponseWriter, r *http.Request) {
	if !s.sessionAllowed(w, r, r.PathValue("id")) {
		return
	}
	if s.streams == nil {
		streamError(w, stream.ErrNotFound)
		return
	}
	var body struct {
		Position float64 `json:"position"`
		Rate     float64 `json:"rate"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !validPosition(body.Position) || math.IsNaN(body.Rate) || body.Rate < 0.5 || body.Rate > 2 {
		fail(w, 400, "invalid", "Choose a playback speed between 0.5× and 2× and a valid position.")
		return
	}
	session, err := s.streams.SetPlaybackRate(r.Context(), r.PathValue("id"), body.Position, body.Rate)
	if err != nil {
		streamError(w, err)
		return
	}
	respond(w, 200, session)
}

func (s *Server) stop(w http.ResponseWriter, r *http.Request) {
	if !s.sessionOwned(w, r, r.PathValue("id")) {
		return
	}
	if s.streams != nil {
		err := s.streams.Stop(r.PathValue("id"))
		if err != nil && !errors.Is(err, stream.ErrNotFound) {
			streamError(w, err)
			return
		}
	}
	s.sessionItemsMu.Lock()
	delete(s.sessionItems, r.PathValue("id"))
	delete(s.sessionOwners, r.PathValue("id"))
	s.sessionItemsMu.Unlock()
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
	if s.blockedItem(item) {
		blocked(w)
		return
	}
	result := s.artwork.get(r.Context(), item.Logo)
	if s.blockedItem(item) {
		blocked(w)
		return
	}
	writeArtwork(w, result)
}
