package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestCategoryEnvironmentAppliesCSVNamesIDsAndScopedRulesAcrossAPI(t *testing.T) {
	t.Setenv("DASHBOARD_CATEGORIES", ` "live:SPORTS", movie:1, series:comedy, `)
	t.Setenv("BLOCKED_CATEGORIES", "movie:BLOCKED FILMS,series:Drama,movie:Hidden films,movie:Future adult,live:General")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = t.TempDir()
	s, ts, _, _ := policyFixtureWithConfig(t, cfg)
	code, body := request(t, ts.URL, "GET", "/api/preferences", "")
	var preferences preferenceResponse
	if code != 200 || json.Unmarshal([]byte(body), &preferences) != nil || len(preferences.Configuration.DashboardCategories) != 3 || len(preferences.Configuration.BlockedCategories) != 5 {
		t.Fatalf("environment preferences: %d %s", code, body)
	}
	for _, path := range []string{"/api/catalog", "/api/epg", "/api/categories", "/api/browse?kind=movie&category=*&page=1"} {
		code, body := request(t, ts.URL, "GET", path, "")
		if code != 200 || strings.Contains(body, "Hidden channel") || strings.Contains(body, "Hidden programme") || strings.Contains(body, "Hidden film") || strings.Contains(body, "Blocked film") {
			t.Fatalf("filtered %s: %d %s", path, code, body)
		}
	}
	code, body = request(t, ts.URL, "GET", "/api/categories?manage=1", "")
	if code != 200 || !strings.Contains(body, "Hidden films") {
		t.Fatal(code, body)
	}
	// The same list hides titles and denies playback. Section-scoped rules
	// must not accidentally exclude a title with the same ID in another kind.
	startPolicySession(t, ts, "live:l2")
	for _, id := range []string{"live:l1", "movie:m2", "movie:m3", "episode:s1:1:1", "opaque-episode", "orphan-episode"} {
		code, body := request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"`+id+`"}`)
		if code != 403 {
			t.Fatalf("blocked %s: %d %s", id, code, body)
		}
	}
	record, err := s.buildDiscovery(context.Background(), s.cache.libraryRevision())
	if err != nil {
		t.Fatal(err)
	}
	if len(record.ExploreMovies) != 1 || record.ExploreMovies[0].Item.ID != "movie:m1" || len(record.ExploreSeries) != 1 || record.ExploreSeries[0].Item.ID != "series:s2" {
		t.Fatalf("allowlisted discovery: %+v %+v", record.ExploreMovies, record.ExploreSeries)
	}
	// Rules also apply when the provider adds matching categories later.
	s.cache.mu.RLock()
	categories := append([]model.Category(nil), s.cache.categories...)
	s.cache.mu.RUnlock()
	categories = append(categories, model.Category{Kind: "movie", ID: "future", Name: "Future adult"})
	if err := s.cache.setCategories(categories); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setBrowseAtRevision(model.BrowseQuery{Kind: "movie", Category: "future", Page: 1}, model.BrowsePage{Items: []model.Item{{ID: "movie:future", Kind: "movie", Name: "Future title", CategoryID: "future"}}, Page: 1}, time.Hour, s.cache.libraryRevision()); err != nil {
		t.Fatal(err)
	}
	code, body = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"movie:future"}`)
	if code != 403 {
		t.Fatalf("new category bypassed environment: %d %s", code, body)
	}
	// No UI/API request can weaken deployment restrictions.
	if code, body := request(t, ts.URL, "PUT", "/api/preferences", `{"refreshIntervalSeconds":43200,"categories":[]}`); code != 405 {
		t.Fatal(code, body)
	}
	code, body = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"movie:m3"}`)
	if code != 403 {
		t.Fatal(code, body)
	}
}

func TestEnvironmentIgnoresAllPreviouslySavedPreferences(t *testing.T) {
	dir := t.TempDir()
	s, ts, _, _ := policyFixtureWithConfig(t, Config{DataDir: dir})
	if _, err := s.cache.db.Exec(`CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY,data BLOB); INSERT OR REPLACE INTO preferences(id,data) VALUES(1,?)`, `{"refreshIntervalSeconds":60,"categories":[{"kind":"movie","id":"1","visibility":"block","dashboard":false}]}`); err != nil {
		t.Fatal(err)
	}
	ts.Close()
	s.Close()
	t.Setenv("REFRESH_INTERVAL", "12h")
	t.Setenv("DASHBOARD_CATEGORIES", "movie:Films")
	t.Setenv("BLOCKED_CATEGORIES", "movie:Hidden films,series:Drama")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = dir
	s, ts = policyTestServer(t, cfg, nil, nil)
	if s.categoryPolicy("movie", "1").Visibility != "show" || !s.categoryPolicy("movie", "1").Dashboard || s.categoryPolicy("movie", "2").Visibility != "block" || s.categoryPolicy("series", "1").Visibility != "block" || s.preferencesSnapshot().value.RefreshIntervalSeconds != 43200 {
		t.Fatal("saved preferences overrode environment")
	}
	// Corrupt saved rows are also irrelevant and must not prevent startup.
	if _, err := s.cache.db.Exec(`UPDATE preferences SET data='not JSON' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	ts.Close()
	s.Close()
	for _, name := range []string{"DASHBOARD_CATEGORIES", "BLOCKED_CATEGORIES"} {
		t.Setenv(name, "")
	}
	cfg, err = LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = dir
	s, ts = policyTestServer(t, cfg, nil, nil)
	if s.categoryPolicy("movie", "1").Visibility != "show" || !s.categoryPolicy("movie", "4").Dashboard || s.preferencesSnapshot().value.RefreshIntervalSeconds != 43200 {
		t.Fatal("removing environment rules restored stale saved choices")
	}
	code, body := request(t, ts.URL, "GET", "/api/preferences", "")
	if code != 200 || !strings.Contains(body, `"categories":[]`) || !strings.Contains(body, `"dashboardCategories":[]`) {
		t.Fatal(code, body)
	}
}

func TestDashboardEnvironmentNameScopesCSVAndValidation(t *testing.T) {
	t.Setenv("DASHBOARD_CATEGORIES", `"movie:Action, Adventure", SERIES:Comedy, live:2`)
	t.Setenv("BLOCKED_CATEGORIES", "movie:Hidden films,series:Drama,movie:3,movie:Private")
	t.Setenv("EXPLORE_CATEGORIES", `not a valid " CSV`)
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir = t.TempDir()
	s, ts, _, _ := policyFixtureWithConfig(t, cfg)
	if !s.preferencesSnapshot().category("movie", "99", "Action, Adventure").Dashboard || s.preferencesSnapshot().category("series", "99", "Action, Adventure").Dashboard || !s.categoryPolicy("series", "2").Dashboard || !s.categoryPolicy("live", "2").Dashboard || s.categoryPolicy("movie", "2").Dashboard {
		t.Fatal("CSV/case/section scope mismatch")
	}
	_, body := request(t, ts.URL, "GET", "/api/preferences", "")
	if !strings.Contains(body, `"movie:Action, Adventure"`) || !strings.Contains(body, `"SERIES:Comedy"`) {
		t.Fatal("configuration labels lost original tokens", body)
	}
	s.cache.mu.RLock()
	categories := append([]model.Category(nil), s.cache.categories...)
	s.cache.mu.RUnlock()
	if err := s.cache.setCategories(append(categories, model.Category{Kind: "movie", ID: "abc", Name: "Private"})); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setBrowseAtRevision(model.BrowseQuery{Kind: "movie", Category: "*", Page: 2}, model.BrowsePage{Page: 2, Items: []model.Item{
		{ID: "movie:case-name", Kind: "movie", Name: "Case name", Category: "bLoCkEd FiLmS"},
		{ID: "movie:case-id", Kind: "movie", Name: "Case ID", CategoryID: "AbC"},
	}}, time.Hour, s.cache.libraryRevision()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"movie:case-name", "movie:case-id"} {
		if code, body := request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"`+id+`"}`); code != 403 {
			t.Fatal("case variant bypassed category resolution", id, code, body)
		}
	}
	t.Setenv("DASHBOARD_CATEGORIES", "")
	cfg, err = LoadConfig()
	if err != nil || len(cfg.categoryEnvironment.dashboard) != 0 {
		t.Fatal("removed EXPLORE_CATEGORIES alias still affected dashboard", err)
	}
	for _, value := range []string{`movie:`, `"unclosed`, `Movies
Shows`} {
		t.Setenv("DASHBOARD_CATEGORIES", value)
		if _, err := LoadConfig(); err == nil {
			t.Fatal("invalid selector accepted", value)
		}
	}
	t.Setenv("DASHBOARD_CATEGORIES", "*")
	for _, value := range []string{"0", "59s", "169h"} {
		t.Setenv("REFRESH_INTERVAL", value)
		if _, err := LoadConfig(); err == nil {
			t.Fatal("invalid refresh cadence accepted", value)
		}
	}
}

func TestBlockedEnvironmentDoesNotRequireUnrelatedKindCategoryMetadata(t *testing.T) {
	for _, test := range []struct {
		name, blocked string
		movies, shows bool
	}{
		{"live-only", "live:General", true, true},
		{"movie-only", "movie:Private", false, true},
		{"unscoped", "Private", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			rules, err := parseCategorySelectors("BLOCKED_CATEGORIES", test.blocked)
			if err != nil {
				t.Fatal(err)
			}
			s, ts, provider, _ := policyFixtureWithConfig(t, Config{categoryEnvironment: categoryEnvironment{blocked: rules}})
			// Some providers expose browsable titles without movie/show category
			// metadata. A rule for another kind must not disable those catalogs.
			if err := s.cache.setCategories([]model.Category{{Kind: "live", ID: "1", Name: "General"}}); err != nil {
				t.Fatal(err)
			}
			if err := s.cache.invalidateLibrary(); err != nil {
				t.Fatal(err)
			}
			discovery := waitDiscovery(t, ts)
			if (len(discovery.ExploreMovies) > 0) != test.movies || (len(discovery.ExploreSeries) > 0) != test.shows {
				t.Fatalf("discovery scope mismatch: movies=%d shows=%d", len(discovery.ExploreMovies), len(discovery.ExploreSeries))
			}
			for kind, allowed := range map[string]bool{"movie": test.movies, "series": test.shows} {
				code, body := request(t, ts.URL, "GET", "/api/browse?kind="+kind+"&category=*&page=1", "")
				var page model.BrowsePage
				if code != 200 || json.Unmarshal([]byte(body), &page) != nil || (len(page.Items) > 0) != allowed {
					t.Fatalf("browse %s: %d %s", kind, code, body)
				}
			}
			provider.queryMu.Lock()
			defer provider.queryMu.Unlock()
			for _, query := range provider.queries {
				if query.Kind == "movie" && !test.movies || query.Kind == "series" && !test.shows {
					t.Fatalf("restricted kind with unknown categories reached provider: %+v", query)
				}
			}
		})
	}
}

func TestDashboardIDAllowlistResolvesNameOnlyItemsConservatively(t *testing.T) {
	for _, test := range []struct {
		name, dashboard, blocked                    string
		duplicate, dashboardVisible, libraryVisible bool
	}{
		{"unique-name", "live:1", "", false, true, true},
		{"ambiguous-name", "live:1", "", true, false, true},
		{"both-allowed", "live:1,live:3", "", true, true, true},
		{"block-dominates", "live:1,live:3", "live:3", true, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			dashboard, err := parseCategorySelectors("DASHBOARD_CATEGORIES", test.dashboard)
			if err != nil {
				t.Fatal(err)
			}
			blocked, err := parseCategorySelectors("BLOCKED_CATEGORIES", test.blocked)
			if err != nil {
				t.Fatal(err)
			}
			s, ts, _, _ := policyFixtureWithConfig(t, Config{categoryEnvironment: categoryEnvironment{dashboard: dashboard, blocked: blocked}})
			categories := []model.Category{{Kind: "live", ID: "1", Name: "General"}}
			if test.duplicate {
				categories = append(categories, model.Category{Kind: "live", ID: "3", Name: "GENERAL"})
			}
			if err := s.cache.setCategories(categories); err != nil {
				t.Fatal(err)
			}
			if err := s.cache.setCatalog([]model.Item{{ID: "live:name-only", Kind: "live", Name: "Name only channel", Category: "General"}}); err != nil {
				t.Fatal(err)
			}
			for path, visible := range map[string]bool{"/api/catalog": test.libraryVisible, "/api/catalog?dashboard=1": test.dashboardVisible} {
				code, body := request(t, ts.URL, "GET", path, "")
				if code != 200 || strings.Contains(body, "Name only channel") != visible {
					t.Fatalf("%s: %d %s", path, code, body)
				}
			}
		})
	}
}
