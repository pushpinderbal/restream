package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type discoveryFixtureProvider struct {
	fixtureProvider
	items []model.Item
	gate  <-chan struct{}
	calls atomic.Int32
}

func (p *discoveryFixtureProvider) Browse(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
	p.calls.Add(1)
	if p.gate != nil {
		select {
		case <-p.gate:
		case <-ctx.Done():
			return model.BrowsePage{}, ctx.Err()
		}
	}
	items := []model.Item{}
	for _, item := range p.items {
		if item.Kind == q.Kind {
			items = append(items, item)
		}
	}
	// Include all same-kind rows even for a search, as a portal can return noisy
	// search results. Discovery must still verify each identity itself.
	return model.BrowsePage{Items: items, Page: 1, Total: len(items)}, nil
}

type discoveryTransport func(*http.Request) (*http.Response, error)

func (f discoveryTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func discoveryTestServer(t *testing.T, cfg Config, p model.Provider) (*Server, *httptest.Server) {
	t.Helper()
	if cfg.DataDir == "" {
		cfg.DataDir = t.TempDir()
	}
	if cfg.WebDir == "" {
		cfg.WebDir = t.TempDir()
	}
	// Keep the scheduled live/EPG refresh out of these discovery fixtures. The
	// API and its real cache/background-refresh lifecycle remain under test.
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	return s, ts
}

func readDiscovery(t *testing.T, ts *httptest.Server) discoveryResponse {
	t.Helper()
	code, body := request(t, ts.URL, "GET", "/api/discovery", "")
	var result discoveryResponse
	if err := json.Unmarshal([]byte(body), &result); err != nil || code != 200 {
		t.Fatalf("discovery: %d %s %v", code, body, err)
	}
	if strings.Contains(body, "private-command") || strings.Contains(body, "private-token") || strings.Contains(body, "provider.invalid") {
		t.Fatal("discovery exposed a credential or provider-only field", body)
	}
	return result
}

func waitDiscovery(t *testing.T, ts *httptest.Server) discoveryResponse {
	t.Helper()
	var result discoveryResponse
	waitFor(t, func() bool {
		result = readDiscovery(t, ts)
		return !result.Refreshing && result.UpdatedAt != nil
	})
	return result
}

func TestDiscoveryUnconfiguredReturnsImmediatelyWarmsOnceAndPersists(t *testing.T) {
	gate := make(chan struct{})
	p := &discoveryFixtureProvider{gate: gate, items: []model.Item{
		{ID: "movie:1", Kind: "movie", Name: "A film", Command: "private-command", Logo: "http://provider.invalid/private-poster"},
		{ID: "series:1", Kind: "series", Name: "A show"},
	}}
	s, ts := discoveryTestServer(t, Config{}, p)
	started := time.Now()
	first := readDiscovery(t, ts)
	if time.Since(started) > 500*time.Millisecond || !first.Refreshing || first.Configured || len(first.TrendingMovies) != 0 || len(first.TrendingSeries) != 0 {
		t.Fatal("cold response blocked or fabricated trends", first)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); readDiscovery(t, ts) }()
	}
	wg.Wait()
	waitFor(t, func() bool { return p.calls.Load() == 1 })
	close(gate)
	result := waitDiscovery(t, ts)
	if p.calls.Load() != 2 || len(result.ExploreMovies) != 1 || len(result.ExploreSeries) != 1 || len(result.TrendingMovies) != 0 {
		t.Fatal("provider warming was not bounded/shared", p.calls.Load(), result)
	}
	if !strings.HasPrefix(result.ExploreMovies[0].Poster, "/api/images/movie:1?v=") {
		t.Fatal("provider artwork was not local", result.ExploreMovies)
	}
	readDiscovery(t, ts)
	if p.calls.Load() != 2 {
		t.Fatal("warm discovery fetched provider again")
	}
	// Restarting preserves both the available listing and the refresh deadline.
	saved, savedTS := discoveryTestServer(t, s.cfg, &discoveryFixtureProvider{})
	restored := readDiscovery(t, savedTS)
	if restored.Refreshing || len(restored.ExploreMovies) != 1 || len(restored.ExploreSeries) != 1 || restored.UpdatedAt == nil {
		t.Fatal("discovery snapshot did not survive restart", restored)
	}
	saved.discoveryService.mu.Lock()
	deadline := saved.discoveryService.record.NextAttempt
	saved.discoveryService.mu.Unlock()
	if !deadline.After(time.Now()) {
		t.Fatal("refresh deadline was not saved")
	}
}

func configureDiscoveryMetadata(t *testing.T, s *Server, fail *atomic.Bool) *atomic.Int32 {
	t.Helper()
	calls := &atomic.Int32{}
	s.discoveryService.client.Transport = discoveryTransport(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		if req.URL.Scheme != "https" || req.URL.Host != "api.themoviedb.org" || req.Header.Get("Authorization") != "Bearer private-token" || req.URL.Query().Has("api_key") || strings.Contains(req.URL.RawQuery, "private-token") {
			t.Error("invalid metadata request identity", req.URL.Host)
		}
		if fail != nil && fail.Load() {
			return nil, errors.New("failed metadata request using Bearer private-token")
		}
		var titles []tmdbTitle
		switch req.URL.Path {
		case "/3/trending/movie/week":
			titles = []tmdbTitle{
				{ID: 101, Title: "Available Movie", ReleaseDate: "2025-01-01", Poster: "/poster.jpg", Backdrop: "/backdrop.jpg", Overview: "A real movie", Rating: 8.1},
				{ID: 102, Title: "Absent Movie", ReleaseDate: "2025-01-01"},
				{ID: 103, Title: "Ambiguous", ReleaseDate: "2025-01-01"},
				{ID: 104, Title: "Wrong Year", ReleaseDate: "2025-01-01"},
				{ID: 105, Title: "Provider ID", ReleaseDate: "2025-01-01"},
				{ID: 106, Title: "Variants", ReleaseDate: "2024-01-01"},
				{ID: 107, Title: "Unsafe Image", ReleaseDate: "2025-01-01", Poster: "/../../private.png", Backdrop: "https://elsewhere.invalid/private.jpg"},
			}
		case "/3/trending/tv/week":
			titles = []tmdbTitle{{ID: 201, Name: "Night Shift", FirstAirDate: "2022-01-01", Poster: "/night.jpg"}}
		case "/3/search/movie":
			if req.URL.Query().Get("query") == "Ambiguous" {
				titles = []tmdbTitle{{ID: 103, Title: "Ambiguous", ReleaseDate: "2025-01-01"}, {ID: 900, Title: "Ambiguous", ReleaseDate: "2000-01-01"}}
			}
		default:
			t.Error("unexpected metadata path", req.URL.Path)
		}
		data, _ := json.Marshal(map[string]any{"results": titles})
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(bytes.NewReader(data)), Request: req}, nil
	})
	return calls
}

func matchingDiscoveryProvider() *discoveryFixtureProvider {
	return &discoveryFixtureProvider{items: []model.Item{
		{ID: "movie:1", Kind: "movie", Name: "Available Movie (2025) HD - ENGLISH MOVIES", Category: "ENGLISH MOVIES", Command: "private-command"},
		{ID: "movie:2", Kind: "movie", Name: "Ambiguous"},
		{ID: "movie:3", Kind: "movie", Name: "Wrong Year", Year: 2010},
		{ID: "movie:4", Kind: "movie", Name: "A translated provider title", TMDBID: 105},
		{ID: "movie:5", Kind: "movie", Name: "Variants (2024) 1080p"},
		{ID: "movie:6", Kind: "movie", Name: "Variants (2024) 720p"},
		{ID: "movie:7", Kind: "movie", Name: "Unsafe Image", Year: 2025},
		{ID: "series:1", Kind: "series", Name: "Night Shift (2022) - ENGLISH TV SHOWS", Category: "ENGLISH TV SHOWS"},
	}}
}

func TestDiscoveryMatchesOnlyConfirmedTitlesAndProxiesKnownArtwork(t *testing.T) {
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, matchingDiscoveryProvider())
	configureDiscoveryMetadata(t, s, nil)
	result := waitDiscovery(t, ts)
	if !result.Configured || result.Error != "" || len(result.TrendingMovies) != 4 || len(result.TrendingSeries) != 1 {
		t.Fatalf("unexpected available trends: %+v", result)
	}
	want := []int{101, 105, 106, 107}
	for i, title := range result.TrendingMovies {
		if title.TMDBID != want[i] {
			t.Fatal("unmatched/ambiguous/wrong-year title shown", result.TrendingMovies)
		}
	}
	if result.TrendingMovies[2].Item.ID != "movie:5" {
		t.Fatal("provider variants were not chosen deterministically", result.TrendingMovies[2])
	}
	if result.TrendingMovies[3].Poster != "" || result.TrendingMovies[3].Backdrop != "" {
		t.Fatal("unsafe metadata image URL accepted")
	}
	first := result.TrendingMovies[0]
	if first.Name != "Available Movie" || first.Year != 2025 || first.ReleaseDate != "2025-01-01" || first.Rating != 8.1 || !strings.HasPrefix(first.Poster, "/api/discovery/images/") {
		t.Fatal("canonical metadata missing", first)
	}
	if result.TrendingSeries[0].ReleaseDate != "2022-01-01" {
		t.Fatal("show first-air date missing", result.TrendingSeries[0])
	}
	pixel, _ := base64.StdEncoding.DecodeString("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")
	var imageCalls atomic.Int32
	s.artwork.client.Transport = discoveryTransport(func(req *http.Request) (*http.Response, error) {
		imageCalls.Add(1)
		if req.URL.Scheme != "https" || req.URL.Host != "image.tmdb.org" || req.URL.Path != "/t/p/w500/poster.jpg" || req.Header.Get("Authorization") != "" || req.URL.Query().Get("api_key") != "" {
			t.Error("unsafe image fetch or credential forwarding")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(pixel)), Header: http.Header{}, Request: req}, nil
	})
	for i := 0; i < 2; i++ {
		image := getArtwork(t, ts.URL+first.Poster)
		if image.status != 200 || image.mime != "image/gif" {
			t.Fatal("proxy image failed", image)
		}
	}
	if imageCalls.Load() != 1 {
		t.Fatal("metadata artwork was not shared/cached", imageCalls.Load())
	}
	for _, path := range []string{"/api/discovery/images/missing/poster", strings.TrimSuffix(first.Poster, "/poster") + "/arbitrary"} {
		if image := getArtwork(t, ts.URL+path); image.status != 404 {
			t.Fatal("unknown client-selected image accepted", path)
		}
	}
	// Browse expiry must not discard the saved discovery rail or playback items.
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=? WHERE kind='movie'`, time.Now().Add(-25*time.Hour).UnixNano()); err != nil {
		t.Fatal(err)
	}
	cached := readDiscovery(t, ts)
	if len(cached.TrendingMovies) != len(result.TrendingMovies) || len(cached.ExploreMovies) != len(result.ExploreMovies) || len(cached.TrendingSeries) != len(result.TrendingSeries) {
		t.Fatal("page expiry discarded the saved rail", cached)
	}
	if _, exists := s.cache.item("movie:1"); !exists {
		t.Fatal("expiry removed the existing playback record")
	}
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	if image := getArtwork(t, ts.URL+first.Poster); image.status != 200 {
		t.Fatal("cached metadata image disappeared during library invalidation")
	}
}

func TestDiscoverySavedFallbackBackoffAndProviderInvalidation(t *testing.T) {
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token", PortalURL: "https://provider.invalid", MAC: "00:11:22:33:44:55"}, matchingDiscoveryProvider())
	var failed atomic.Bool
	calls := configureDiscoveryMetadata(t, s, &failed)
	warm := waitDiscovery(t, ts)
	failed.Store(true)
	s.discoveryService.mu.Lock()
	s.discoveryService.record.NextAttempt = time.Time{}
	for kind, metadata := range s.discoveryService.record.Metadata {
		metadata.FetchedAt = time.Now().Add(-25 * time.Hour)
		s.discoveryService.record.Metadata[kind] = metadata
	}
	s.discoveryService.mu.Unlock()
	readDiscovery(t, ts)
	var fallback discoveryResponse
	waitFor(t, func() bool {
		fallback = readDiscovery(t, ts)
		return !fallback.Refreshing && fallback.Error != ""
	})
	if len(fallback.TrendingMovies) != len(warm.TrendingMovies) || fallback.UpdatedAt == nil || !fallback.UpdatedAt.Equal(*warm.UpdatedAt) {
		t.Fatal("metadata failure discarded saved available titles", fallback)
	}
	previousCalls := calls.Load()
	for i := 0; i < 5; i++ {
		readDiscovery(t, ts)
	}
	if calls.Load() != previousCalls {
		t.Fatal("failure retry was not backed off")
	}
	restored, restoredTS := discoveryTestServer(t, s.cfg, &discoveryFixtureProvider{})
	configureDiscoveryMetadata(t, restored, &failed)
	read := readDiscovery(t, restoredTS)
	if read.Refreshing || read.Error == "" || len(read.TrendingMovies) != len(warm.TrendingMovies) {
		t.Fatal("failure/backoff snapshot was not persistent", read)
	}
	// A new revision keeps saved rail entries visible while availability is
	// rechecked. Provider failure must not blank the cached rail.
	gate := make(chan struct{})
	restored.provider = &discoveryFixtureProvider{gate: gate}
	if err := restored.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	cold := readDiscovery(t, restoredTS)
	if len(cold.TrendingMovies) != len(warm.TrendingMovies) || len(cold.ExploreMovies) == 0 || !cold.Refreshing {
		t.Fatal("saved discovery disappeared while revalidating", cold)
	}
	close(gate)
	waitFor(t, func() bool {
		restored.discoveryService.mu.Lock()
		defer restored.discoveryService.mu.Unlock()
		return !restored.discoveryService.refreshing
	})
	// A changed portal/MAC resets discovery alongside all provider cache data.
	changedCfg := s.cfg
	changedCfg.MAC = "00:11:22:33:44:66"
	changed, changedTS := discoveryTestServer(t, changedCfg, nil)
	other := readDiscovery(t, changedTS)
	if len(other.TrendingMovies) != 0 || len(other.ExploreMovies) != 0 || changed.discoveryService.record.Version != 0 {
		t.Fatal("provider discovery leaked across portal identity")
	}
}

func TestDiscoveryShutdownCancelsHeldProviderAndRejectsMetadataRedirects(t *testing.T) {
	gate := make(chan struct{})
	p := &discoveryFixtureProvider{gate: gate}
	s, ts := discoveryTestServer(t, Config{}, p)
	readDiscovery(t, ts)
	waitFor(t, func() bool { return p.calls.Load() == 1 })
	stopped := make(chan struct{})
	go func() { s.Close(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown waited on discovery provider request")
	}
	// Shutdown leaves the discovery service closed and rejects new work.
	s.discoveryService.mu.Lock()
	closed := s.discoveryService.closed
	s.discoveryService.mu.Unlock()
	if !closed {
		t.Fatal("discovery remained open on shutdown")
	}
	for _, uri := range []string{"https://elsewhere.invalid/3/movie", "http://api.themoviedb.org/3/movie"} {
		req, _ := http.NewRequest("GET", uri, nil)
		if s.discoveryService.client.CheckRedirect(req, nil) == nil {
			t.Fatal("metadata credential redirect accepted", uri)
		}
	}
}
