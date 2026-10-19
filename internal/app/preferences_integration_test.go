package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

type policyProvider struct {
	fixtureProvider
	queryMu sync.Mutex
	queries []model.BrowseQuery
	items   []model.Item
}

func (p *policyProvider) Browse(_ context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
	p.queryMu.Lock()
	p.queries = append(p.queries, q)
	p.queryMu.Unlock()
	items := []model.Item{}
	for _, item := range p.items {
		if item.Kind == q.Kind && (q.Category == "*" || q.Category == item.CategoryID) && (q.Search == "" || strings.Contains(strings.ToLower(item.Name), strings.ToLower(q.Search))) {
			items = append(items, item)
		}
	}
	return model.BrowsePage{Items: items, Page: 1, Total: len(items)}, nil
}

type policyStreams struct {
	mu      sync.Mutex
	next    int
	values  map[string]stream.Session
	started chan struct{}
	gate    <-chan struct{}
}

func (p *policyStreams) Start(ctx context.Context, _ model.Item, start float64) (stream.Session, error) {
	if p.started != nil {
		select {
		case p.started <- struct{}{}:
		default:
		}
	}
	if p.gate != nil {
		select {
		case <-p.gate:
		case <-ctx.Done():
			return stream.Session{}, ctx.Err()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.next++
	id := fmt.Sprintf("test-%d", p.next)
	value := stream.Session{ID: id, URL: "/api/streams/" + id + "/1/index.m3u8", State: "ready", Duration: 1000, Offset: start}
	p.values[id] = value
	return value, nil
}

func (p *policyStreams) Get(id string) (stream.Session, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if value, ok := p.values[id]; ok {
		return value, nil
	}
	return stream.Session{}, stream.ErrNotFound
}
func (p *policyStreams) Heartbeat(id string) error { _, err := p.Get(id); return err }
func (p *policyStreams) Seek(_ context.Context, id string, _ float64) (stream.Session, error) {
	return p.Get(id)
}
func (p *policyStreams) Stop(id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.values, id)
	return nil
}
func (p *policyStreams) Active() int { p.mu.Lock(); defer p.mu.Unlock(); return len(p.values) }
func (p *policyStreams) MediaHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("segment")) })
}

func policyTestServer(t *testing.T, cfg Config, p *policyProvider, streams *policyStreams) (*Server, *httptest.Server) {
	t.Helper()
	if cfg.DataDir == "" {
		cfg.DataDir = t.TempDir()
	}
	if cfg.WebDir == "" {
		cfg.WebDir = t.TempDir()
	}
	if cfg.RefreshInterval == 0 {
		cfg.RefreshInterval = 6 * time.Hour
	}
	if streams == nil {
		streams = &policyStreams{}
	}
	streams.values = make(map[string]stream.Session)
	s, err := New(cfg, nil, streams)
	if err != nil {
		t.Fatal(err)
	}
	if p != nil {
		s.provider = p
	}
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	return s, ts
}

func policyFixture(t *testing.T) (*Server, *httptest.Server, *policyProvider, *policyStreams) {
	return policyFixtureWithConfig(t, Config{})
}

func policyFixtureWithConfig(t *testing.T, cfg Config) (*Server, *httptest.Server, *policyProvider, *policyStreams) {
	t.Helper()
	p := &policyProvider{items: []model.Item{
		{ID: "movie:m1", Kind: "movie", Name: "Available film", CategoryID: "1", Category: "Films"},
		{ID: "movie:m2", Kind: "movie", Name: "Hidden film", CategoryID: "2", Category: "Hidden films"},
		{ID: "movie:m3", Kind: "movie", Name: "Blocked film", CategoryID: "3", Category: "Blocked films"},
		{ID: "movie:m4", Kind: "movie", Name: "Off dashboard film", CategoryID: "4", Category: "More films"},
		{ID: "series:s1", Kind: "series", Name: "Restricted show", CategoryID: "1", Category: "Drama", ProviderID: "s1"},
		{ID: "series:s2", Kind: "series", Name: "Open show", CategoryID: "2", Category: "Comedy", ProviderID: "s2"},
	}}
	streams := &policyStreams{}
	s, ts := policyTestServer(t, cfg, p, streams)
	if err := s.cache.setCategories([]model.Category{
		{ID: "1", Kind: "live", Name: "General"}, {ID: "2", Kind: "live", Name: "Sports"},
		{ID: "1", Kind: "movie", Name: "Films"}, {ID: "2", Kind: "movie", Name: "Hidden films"}, {ID: "3", Kind: "movie", Name: "Blocked films"}, {ID: "4", Kind: "movie", Name: "More films"},
		{ID: "1", Kind: "series", Name: "Drama", SourceType: "vod"}, {ID: "2", Kind: "series", Name: "Comedy", SourceType: "vod"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setCatalog([]model.Item{
		{ID: "live:l1", Kind: "live", Name: "Hidden channel", CategoryID: "1", Category: "General"},
		{ID: "live:l2", Kind: "live", Name: "Open channel", CategoryID: "2", Category: "Sports"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setEPG([]model.Program{
		{ChannelID: "live:l1", Title: "Hidden programme", Start: time.Now(), End: time.Now().Add(time.Hour)},
		{ChannelID: "live:l2", Title: "Visible programme", Start: time.Now(), End: time.Now().Add(time.Hour)},
	}); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"movie", "series"} {
		items := []model.Item{}
		for _, item := range p.items {
			if item.Kind == kind {
				items = append(items, item)
			}
		}
		if err := seedBrowsePage(s.cache, model.BrowseQuery{Kind: kind, Category: "*", Page: 1}, model.BrowsePage{Items: items, Page: 1, Total: len(items)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.cache.setEpisodesAtRevision("series:s1", []model.Item{
		{ID: "episode:s1:1:1", Kind: "episode", Name: "Pilot", SeriesID: "s1", Season: 1, Episode: 1},
		{ID: "opaque-episode", Kind: "episode", Name: "Opaque episode", Season: 1, Episode: 2},
	}, s.cache.libraryRevision()); err != nil {
		t.Fatal(err)
	}
	// An unparented legacy row must not masquerade as an allowed child when
	// any series category has been blocked.
	if err := seedBrowsePage(s.cache, model.BrowseQuery{Kind: "series", Category: "orphan", Page: 1}, model.BrowsePage{Items: []model.Item{{ID: "orphan-episode", Kind: "episode", Name: "Orphan", CategoryID: "2"}}, Page: 1}); err != nil {
		t.Fatal(err)
	}
	return s, ts, p, streams
}

// Policy fixtures replace the effective snapshot directly. Runtime settings
// updates are covered by the application settings integration tests.
func deployTestConfiguration(t *testing.T, s *Server, seconds int64, categories ...CategoryPreference) {
	t.Helper()
	environment := categoryEnvironment{}
	byID := map[string]CategoryPreference{}
	filterDashboard := false
	for _, category := range categories {
		byID[categoryPreferenceKey(category.Kind, category.ID)] = category
		selector := categorySelector{kind: category.Kind, value: strings.ToLower(category.ID)}
		if category.Visibility == "block" {
			environment.blocked = append(environment.blocked, selector)
		}
		filterDashboard = filterDashboard || !category.Dashboard
	}
	if filterDashboard {
		s.cache.mu.RLock()
		for _, category := range s.cache.categories {
			rule, exists := byID[categoryPreferenceKey(category.Kind, category.ID)]
			if !exists || rule.Dashboard {
				environment.dashboard = append(environment.dashboard, categorySelector{kind: category.Kind, value: strings.ToLower(category.ID)})
			}
		}
		s.cache.mu.RUnlock()
	}
	s.preferencesService.mu.Lock()
	s.preferencesService.snapshot = &preferenceSnapshot{
		value:     Preferences{RefreshIntervalSeconds: seconds, Categories: []CategoryPreference{}},
		updatedAt: time.Now().UTC(), environment: environment, blocked: len(environment.blocked) > 0,
	}
	s.preferencesService.mu.Unlock()
	// Retained session guards must enforce the updated policy too.
	s.stopBlockedSessions()
}

func startPolicySession(t *testing.T, ts *httptest.Server, id string) stream.Session {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"itemId": id, "start": 0})
	code, body := request(t, ts.URL, "POST", "/api/sessions", string(data))
	var value stream.Session
	if code != 201 || json.Unmarshal([]byte(body), &value) != nil {
		t.Fatalf("start fixture: %d %s", code, body)
	}
	return value
}

func TestDefaultRefreshCadenceAndLegacyPreferenceView(t *testing.T) {
	for _, name := range []string{"REFRESH_INTERVAL", "CATALOG_REFRESH_INTERVAL", "EPG_REFRESH_INTERVAL", "EPISODE_CACHE_TTL"} {
		t.Setenv(name, "invalid-removed-setting")
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = t.TempDir()
	s, ts, _, _ := policyFixtureWithConfig(t, cfg)
	code, body := request(t, ts.URL, "GET", "/api/preferences", "")
	var value preferenceResponse
	if code != 200 || json.Unmarshal([]byte(body), &value) != nil || value.RefreshIntervalSeconds != 86400 || len(value.Categories) != 0 || value.Configuration.DashboardCategories == nil || value.Configuration.BlockedCategories == nil {
		t.Fatal(code, body)
	}
	if s.refreshInterval() != 24*time.Hour || s.discoveryRefreshInterval() != 24*time.Hour {
		t.Fatal("configured cadence did not drive derived freshness")
	}
	for _, data := range []string{`{"refreshIntervalSeconds":60,"categories":[]}`, `not valid JSON`} {
		if code, body := request(t, ts.URL, "PUT", "/api/preferences", data); code != 405 || !strings.Contains(body, `"code":"read_only"`) {
			t.Fatal("legacy preferences endpoint accepted an HTTP edit", code, body)
		}
	}
	_, after := request(t, ts.URL, "GET", "/api/preferences", "")
	if after != body {
		t.Fatal("rejected HTTP edits changed effective configuration", after)
	}
	_, status := request(t, ts.URL, "GET", "/api/status", "")
	if !strings.Contains(status, `"preferencesUpdatedAt"`) {
		t.Fatal("configuration revision missing", status)
	}

}

func TestBlockedCategoriesFilterListsAndDenyDirectPlayback(t *testing.T) {
	s, ts, p, _ := policyFixture(t)
	deployTestConfiguration(t, s, 21600,
		CategoryPreference{Kind: "live", ID: "1", Visibility: "block", Dashboard: true},
		CategoryPreference{Kind: "movie", ID: "2", Visibility: "block", Dashboard: true},
		CategoryPreference{Kind: "movie", ID: "3", Visibility: "block", Dashboard: true},
		CategoryPreference{Kind: "movie", ID: "4", Visibility: "show", Dashboard: false},
	)
	for _, path := range []string{"/api/catalog", "/api/epg", "/api/browse?kind=movie&category=*&page=1"} {
		code, body := request(t, ts.URL, "GET", path, "")
		if code != 200 || strings.Contains(body, "Hidden channel") || strings.Contains(body, "Hidden programme") || strings.Contains(body, "Hidden film") || strings.Contains(body, "Blocked film") {
			t.Fatal(path, code, body)
		}
	}
	code, body := request(t, ts.URL, "GET", "/api/browse?kind=movie&category=2&search=Hidden&page=1", "")
	if code != 200 || !strings.Contains(body, `"items":[]`) {
		t.Fatal(code, body)
	}
	p.queryMu.Lock()
	calls := len(p.queries)
	p.queryMu.Unlock()
	if calls != 0 {
		t.Fatal("explicit hidden category was fetched", calls)
	}
	code, body = request(t, ts.URL, "GET", "/api/categories", "")
	if code != 200 || strings.Contains(body, "Hidden films") || strings.Contains(body, "Blocked films") || strings.Contains(body, "General") {
		t.Fatal(code, body)
	}
	_, body = request(t, ts.URL, "GET", "/api/categories?manage=1", "")
	if !strings.Contains(body, "Hidden films") || !strings.Contains(body, "Blocked films") || !strings.Contains(body, "General") {
		t.Fatal("management categories incomplete", body)
	}
	for _, id := range []string{"movie:m2", "live:l1", "movie:m3"} {
		if code, body := request(t, ts.URL, "GET", "/api/items/"+id, ""); code != 403 {
			t.Fatal("blocked title exposed direct details", code, body)
		}
		if code, body := request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"`+id+`"}`); code != 403 || !strings.Contains(body, `"code":"blocked"`) {
			t.Fatal("blocked title allowed direct playback", code, body)
		}
	}
	discovery := waitDiscovery(t, ts)
	if len(discovery.ExploreMovies) != 1 || discovery.ExploreMovies[0].Item.ID != "movie:m1" {
		t.Fatal("dashboard policy not applied to cached/provider entries", discovery.ExploreMovies)
	}
	if len(s.visibleItems(p.items, false)) != 4 {
		t.Fatal("dashboard-only exclusion removed library entries")
	}
}

func TestCategoryBlockDeniesEpisodeBypassesAndStopsActiveMedia(t *testing.T) {
	s, ts, _, streams := policyFixture(t)
	episode := startPolicySession(t, ts, "episode:s1:1:1")
	channel := startPolicySession(t, ts, "live:l1")
	allowed := startPolicySession(t, ts, "movie:m1")
	if code, _ := request(t, ts.URL, "GET", episode.URL, ""); code != 200 {
		t.Fatal("fixture media unavailable", code)
	}
	deployTestConfiguration(t, s, 21600, CategoryPreference{Kind: "series", ID: "1", Visibility: "block", Dashboard: true}, CategoryPreference{Kind: "live", ID: "1", Visibility: "block", Dashboard: true})
	if streams.Active() != 1 {
		t.Fatal("blocked active sessions were not stopped", streams.Active())
	}
	for _, path := range []string{
		"/api/items/series:s1", "/api/items/episode:s1:1:1", "/api/items/opaque-episode", "/api/items/orphan-episode",
		"/api/series/series:s1/episodes", "/api/series/series:s1/episodes?season=first", "/api/series/series:s1/episodes?season=1",
		"/api/images/series:s1", "/api/images/episode:s1:1:1", "/api/images/opaque-episode",
		"/api/sessions/" + episode.ID, "/api/sessions/" + channel.ID, episode.URL, strings.TrimSuffix(episode.URL, "index.m3u8") + "seg-000001.ts",
	} {
		if code, body := request(t, ts.URL, "GET", path, ""); code != 403 || !strings.Contains(body, `"code":"blocked"`) {
			t.Fatal("blocked path bypass", path, code, body)
		}
	}
	for _, id := range []string{"episode:s1:1:1", "opaque-episode", "orphan-episode", "live:l1"} {
		data, _ := json.Marshal(map[string]any{"itemId": id})
		if code, body := request(t, ts.URL, "POST", "/api/sessions", string(data)); code != 403 {
			t.Fatal("blocked direct start bypass", id, code, body)
		}
	}
	for _, action := range []string{"heartbeat", "seek"} {
		if code, body := request(t, ts.URL, "POST", "/api/sessions/"+episode.ID+"/"+action, `{"position":1}`); code != 403 {
			t.Fatal("blocked session action", action, code, body)
		}
	}
	if code, body := request(t, ts.URL, "GET", allowed.URL, ""); code != 200 || body != "segment" {
		t.Fatal("unrelated media was blocked", code, body)
	}
}

func TestCategoryBlockStopsAConcurrentPendingStart(t *testing.T) {
	s, ts, _, streams := policyFixture(t)
	gate := make(chan struct{})
	streams.gate = gate
	streams.started = make(chan struct{}, 1)
	result := make(chan int, 1)
	go func() {
		code, _ := request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"movie:m1"}`)
		result <- code
	}()
	select {
	case <-streams.started:
	case <-time.After(time.Second):
		t.Fatal("start did not reach stream manager")
	}
	deployTestConfiguration(t, s, 21600, CategoryPreference{Kind: "movie", ID: "1", Visibility: "block", Dashboard: true})
	close(gate)
	select {
	case code := <-result:
		if code != 403 {
			t.Fatal("pending start escaped policy", code)
		}
	case <-time.After(time.Second):
		t.Fatal("pending start did not finish")
	}
	if streams.Active() != 0 {
		t.Fatal("pending blocked session leaked")
	}
}

func TestDiscoveryCategoryPolicyWarmsOnlyEligibleCategoriesAndRefiltersCache(t *testing.T) {
	s, ts, p, _ := policyFixture(t)
	for n := 0; n < 25; n++ {
		p.items = append(p.items, model.Item{ID: fmt.Sprintf("movie:extra-%d", n), Kind: "movie", Name: fmt.Sprintf("Extra film %d", n), CategoryID: "1"})
	}
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	deployTestConfiguration(t, s, 21600,
		CategoryPreference{Kind: "movie", ID: "2", Visibility: "show", Dashboard: false},
		CategoryPreference{Kind: "movie", ID: "3", Visibility: "block", Dashboard: true},
		CategoryPreference{Kind: "series", ID: "1", Visibility: "block", Dashboard: true},
		CategoryPreference{Kind: "series", ID: "2", Visibility: "show", Dashboard: false},
	)
	warm := waitDiscovery(t, ts)
	seen := map[string]bool{}
	for _, title := range warm.ExploreMovies {
		seen[title.Item.CategoryID] = true
	}
	if !seen["1"] || !seen["4"] || seen["2"] || seen["3"] || len(warm.ExploreSeries) != 0 {
		t.Fatal("eligible category diversity/filter missing", seen, warm)
	}
	p.queryMu.Lock()
	queries := append([]model.BrowseQuery(nil), p.queries...)
	p.queryMu.Unlock()
	if len(queries) != 2 {
		t.Fatal("warming queried excluded kinds/categories", queries)
	}
	for _, q := range queries {
		if q.Kind != "movie" || q.Category != "1" && q.Category != "4" {
			t.Fatal("excluded category was fetched", q)
		}
	}
	deployTestConfiguration(t, s, 21600,
		CategoryPreference{Kind: "movie", ID: "1", Visibility: "block", Dashboard: true}, CategoryPreference{Kind: "movie", ID: "2", Visibility: "block", Dashboard: true},
		CategoryPreference{Kind: "movie", ID: "3", Visibility: "block", Dashboard: true}, CategoryPreference{Kind: "movie", ID: "4", Visibility: "show", Dashboard: false},
		CategoryPreference{Kind: "series", ID: "1", Visibility: "block", Dashboard: true}, CategoryPreference{Kind: "series", ID: "2", Visibility: "show", Dashboard: false},
	)
	cold := readDiscovery(t, ts)
	if len(cold.ExploreMovies) != 0 || len(cold.ExploreSeries) != 0 || len(cold.TrendingMovies) != 0 {
		t.Fatal("cached discovery ignored new preferences", cold)
	}
	waitFor(t, func() bool {
		s.discoveryService.mu.Lock()
		defer s.discoveryService.mu.Unlock()
		return !s.discoveryService.refreshing
	})
	p.queryMu.Lock()
	defer p.queryMu.Unlock()
	if len(p.queries) != len(queries) {
		t.Fatal("fully excluded dashboard performed provider requests", p.queries)
	}
}

func TestBlockedMetadataArtworkAndFullyExcludedDiscoveryStayLocal(t *testing.T) {
	s, ts, _, _ := policyFixture(t)
	s.discoveryService.mu.Lock()
	s.discoveryService.record = discoveryRecord{Version: 1, Revision: s.cache.libraryRevision(), Assets: map[string]discoveryAsset{
		"known":  {ItemID: "movie:m1", Poster: "/poster.jpg"},
		"legacy": {Poster: "/legacy.jpg"},
		"orphan": {Poster: "/orphan.jpg"},
	}, Movies: []DiscoveryTitle{{Item: model.Item{ID: "movie:m3", Kind: "movie"}, Poster: "/api/discovery/images/legacy/poster"}}}
	s.discoveryService.mu.Unlock()
	deployTestConfiguration(t, s, 21600, CategoryPreference{Kind: "movie", ID: "1", Visibility: "block", Dashboard: true}, CategoryPreference{Kind: "movie", ID: "3", Visibility: "block", Dashboard: true})
	for _, id := range []string{"known", "legacy", "orphan"} {
		if code, body := request(t, ts.URL, "GET", "/api/discovery/images/"+id+"/poster", ""); code != 403 {
			t.Fatal("blocked/unclassified metadata image escaped policy", id, code, body)
		}
	}

	p := &policyProvider{}
	other, otherTS := policyTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p, nil)
	if err := other.cache.setCategories([]model.Category{{ID: "1", Kind: "movie", Name: "Films"}, {ID: "1", Kind: "series", Name: "Shows"}}); err != nil {
		t.Fatal(err)
	}
	var metadataCalls atomic.Int32
	other.discoveryService.client.Transport = discoveryTransport(func(r *http.Request) (*http.Response, error) {
		metadataCalls.Add(1)
		return nil, errors.New("metadata should not be requested")
	})
	deployTestConfiguration(t, other, 21600, CategoryPreference{Kind: "movie", ID: "1", Visibility: "block", Dashboard: true}, CategoryPreference{Kind: "series", ID: "1", Visibility: "show", Dashboard: false})
	result := waitDiscovery(t, otherTS)
	p.queryMu.Lock()
	defer p.queryMu.Unlock()
	if metadataCalls.Load() != 0 || len(p.queries) != 0 || len(result.TrendingMovies) != 0 || len(result.ExploreMovies) != 0 {
		t.Fatal("fully excluded discovery made unnecessary upstream requests", metadataCalls.Load(), p.queries, result)
	}
}
