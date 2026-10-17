package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

const statusPrivateError = "provider failure https://private-provider.invalid/?token=status-secret"

func seedStatusAccessFixture(t *testing.T, s *Server) {
	t.Helper()
	s.provider = &fixtureProvider{}
	start := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	if err := s.cache.setCategories([]model.Category{{ID: "allowed", Kind: "live", Name: "Allowed"}, {ID: "blocked", Kind: "live", Name: "Blocked"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setCatalog([]model.Item{{ID: "live:allowed", Kind: "live", CategoryID: "allowed"}, {ID: "live:blocked", Kind: "live", CategoryID: "blocked"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setEPG([]model.Program{{ChannelID: "live:allowed", Start: start, End: start.Add(time.Hour)}, {ChannelID: "live:blocked", Start: start.Add(-time.Hour), End: start.Add(2 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	s.cache.mu.Lock()
	for _, kind := range []string{"movie", "series"} {
		s.cache.byID[kind+":allowed"] = model.Item{ID: kind + ":allowed", Kind: kind, CategoryID: "allowed"}
		s.cache.byID[kind+":blocked"] = model.Item{ID: kind + ":blocked", Kind: kind, CategoryID: "blocked"}
	}
	s.cache.libraryRefreshedAt = start
	s.cache.portalCooldownUntil = time.Now().Add(time.Hour)
	s.cache.mu.Unlock()
	s.preferencesService.mu.Lock()
	policy := *s.preferencesService.snapshot
	policy.environment.blocked = []categorySelector{{value: "blocked"}}
	s.preferencesService.snapshot = &policy
	s.preferencesService.mu.Unlock()
	s.stateMu.Lock()
	s.catalogError = statusPrivateError
	s.epgError = statusPrivateError
	s.catalogSync.Running = true
	s.stateMu.Unlock()
}

func TestStatusAccessSeparatesViewerDiagnostics(t *testing.T) {
	p := newAuthTestProvider(t)
	for _, role := range []string{"viewer", "admin", "none", "unauthenticated"} {
		t.Run(role, func(t *testing.T) {
			var a *authTestApp
			if role == "none" {
				app, err := NewRuntime(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: time.Hour})
				if err != nil {
					t.Fatal(err)
				}
				ts := httptest.NewServer(app)
				t.Cleanup(func() { ts.Close(); app.Close() })
				a = &authTestApp{server: ts, app: app, client: &http.Client{}}
			} else {
				p.role = role
				a = newAuthTestApp(t, p, nil)
				if role != "unauthenticated" {
					a.login(t)
				}
			}
			seedStatusAccessFixture(t, a.app.server)
			resp := a.get(t, "/api/status?role=admin&manage=1&details=1&admin=true")
			body := authResponseBody(t, resp)
			if role == "unauthenticated" {
				if resp.StatusCode != 401 || strings.Contains(body, statusPrivateError) {
					t.Fatalf("unauthenticated status: %d %s", resp.StatusCode, body)
				}
				return
			}
			if resp.StatusCode != 200 {
				t.Fatalf("status: %d %s", resp.StatusCode, body)
			}
			var data map[string]json.RawMessage
			if err := json.Unmarshal([]byte(body), &data); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"configured", "refreshing", "library", "preferencesUpdatedAt", "catalogUpdatedAt", "libraryUpdatedAt", "catalogRefreshCompletedAt", "epgUpdatedAt", "error"} {
				if _, ok := data[key]; !ok {
					t.Errorf("missing shared status field %s", key)
				}
			}
			var library struct {
				Live       int       `json:"liveChannels"`
				Categories int       `json:"categories"`
				Movies     int       `json:"cachedMovies"`
				Series     int       `json:"cachedSeries"`
				Programmes int       `json:"programmes"`
				Start      time.Time `json:"guideStartsAt"`
				End        time.Time `json:"guideEndsAt"`
			}
			if err := json.Unmarshal(data["library"], &library); err != nil {
				t.Fatal(err)
			}
			if library.Live != 1 || library.Categories != 1 || library.Movies != 1 || library.Series != 1 || library.Programmes != 1 || library.End.Sub(library.Start) != time.Hour {
				t.Errorf("status ignored category policy: %+v", library)
			}
			private := []string{"sync", "portalCooldownUntil", "activeStreams", "maxStreams", "timezone", "guideHours", "playback"}
			for _, key := range private {
				_, present := data[key]
				if present == (role == "viewer") {
					t.Errorf("%s presence=%t for %s", key, present, role)
				}
			}
			if role == "viewer" {
				if strings.Contains(body, "status-secret") || strings.Contains(body, "private-provider") {
					t.Fatalf("viewer provider diagnostics leaked: %s", body)
				}
				if string(data["error"]) != `"Library updates are temporarily unavailable."` {
					t.Errorf("viewer error: %s", data["error"])
				}
				for _, endpoint := range []struct{ method, path string }{{"GET", "/api/settings?role=admin"}, {"PATCH", "/api/settings?admin=true"}, {"POST", "/api/refresh?role=admin"}, {"GET", "/api/categories?manage=1&role=admin"}} {
					req, _ := http.NewRequest(endpoint.method, a.server.URL+endpoint.path, strings.NewReader(`{}`))
					req.Header.Set("Origin", a.server.URL)
					denied, err := a.client.Do(req)
					if err != nil {
						t.Fatal(err)
					}
					denied.Body.Close()
					if denied.StatusCode != 403 {
						t.Errorf("viewer %s %s: %d", endpoint.method, endpoint.path, denied.StatusCode)
					}
				}
			} else {
				if !strings.Contains(body, "status-secret") {
					t.Errorf("admin diagnostics missing: %s", body)
				}
				settings := a.get(t, "/api/settings")
				settings.Body.Close()
				if settings.StatusCode != 200 {
					t.Errorf("settings: %d", settings.StatusCode)
				}
			}
		})
	}
}
