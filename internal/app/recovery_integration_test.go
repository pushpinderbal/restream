package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stalker"
)

func TestBrowseRecoveryBudgetPersistsAndExplicitRetryIsTargeted(t *testing.T) {
	for _, ceiling := range []string{"attempts", "elapsed"} {
		t.Run(ceiling, func(t *testing.T) {
			cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
			p := &pagedLibraryProvider{}
			s, err := New(cfg, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			s.provider = p
			categories, _ := p.Categories(context.Background())
			if err = s.cache.setCategories(categories); err != nil {
				t.Fatal(err)
			}
			ts := httptest.NewServer(s)
			path := "/api/browse?kind=movie&category=8&page=1"
			libraryItems(t, ts, path, 3)
			libraryItems(t, ts, path+"&search=other", 3)
			q := model.BrowseQuery{Kind: "movie", Category: "8", Page: 1}
			other := q
			other.Search = "other"
			// An unrelated stopped listing must not be reopened by this retry.
			for range recoveryAttemptLimit {
				if err = s.cache.cacheFailed(pageKey(other), errors.New("other listing unavailable")); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = s.cache.db.Exec(`UPDATE pages SET fetched_at=0 WHERE search=''`); err != nil {
				t.Fatal(err)
			}
			p.pageMu.Lock()
			p.failed = true
			p.failure = &stalker.AuthenticationError{Message: "temporary session rejection"}
			p.pageMu.Unlock()
			failures := recoveryAttemptLimit
			if ceiling == "elapsed" {
				failures = 1
			}
			for n := 1; n <= failures; n++ {
				libraryItems(t, ts, path, 3)
				waitFor(t, func() bool { state, _ := s.cache.cacheRetry(pageKey(q)); return state.failures == n })
				if _, err = s.cache.db.Exec(`UPDATE cache_retries SET retry_at=0 WHERE entry=?`, pageKey(q)); err != nil {
					t.Fatal(err)
				}
			}
			if ceiling == "elapsed" {
				if _, err = s.cache.db.Exec(`UPDATE cache_retries SET started_at=? WHERE entry=?`, time.Now().Add(-recoveryElapsedLimit-time.Second).UnixNano(), pageKey(q)); err != nil {
					t.Fatal(err)
				}
			}
			ts.Close()
			s.Close()
			s, err = New(cfg, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			s.provider = p
			ts = httptest.NewServer(s)
			defer ts.Close()
			defer s.Close()
			for range 4 {
				code, body := request(t, ts.URL, "GET", path, "")
				var page model.BrowsePage
				if json.Unmarshal([]byte(body), &page) != nil || code != 200 || !page.RetryStopped || page.Refreshing || len(page.Items) != 3 || page.RefreshError == "" {
					t.Fatalf("stopped cached listing: %d %s", code, body)
				}
			}
			p.pageMu.Lock()
			calls := p.calls[1]
			p.failed = false
			p.pageMu.Unlock()
			if calls != 2+failures {
				t.Fatalf("GET or restart renewed recovery: %d calls", calls)
			}
			code, body := request(t, ts.URL, "POST", "/api/browse/retry", `{"kind":"movie","category":"8","search":"","page":1}`)
			if code != 204 {
				t.Fatal(code, body)
			}
			libraryItems(t, ts, path, 3)
			waitFor(t, func() bool { page, ok, _ := s.cache.browseSnapshot(q, 24*time.Hour); return ok && !page.Stale })
			unrelated, _ := s.cache.cacheRetry(pageKey(other))
			if !unrelated.stopped() {
				t.Fatal("targeted retry reset unrelated listing")
			}
			if page, ok, _ := s.cache.browseSnapshot(other, 24*time.Hour); !ok || page.Stale {
				t.Fatal("targeted retry invalidated saved listing")
			}
		})
	}
}

func TestTargetedRetriesHonorProviderCooldownAndValidation(t *testing.T) {
	s, ts, _ := newChangingLibrary(t, 24*time.Hour)
	libraryItems(t, ts, "/api/browse?kind=series&category=7&page=1", 1)
	key := pageKey(model.BrowseQuery{Kind: "movie", Category: "8", Page: 1})
	if err := s.cache.cacheFailed(key, errors.New("failed")); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setPortalCooldown(time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, value := range []struct{ path, body string }{
		{"/api/browse/retry", `{"kind":"movie","category":"8","page":1}`},
		{"/api/series/series:2/episodes/retry", `{}`},
	} {
		req, _ := http.NewRequest("POST", ts.URL+value.path, strings.NewReader(value.body))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 429 || res.Header.Get("Retry-After") == "" {
			t.Fatal("retry bypassed provider cooldown", res.StatusCode)
		}
	}
	state, _ := s.cache.cacheRetry(key)
	if state.failures != 1 {
		t.Fatal("rejected retry reset failure budget")
	}
	for _, body := range []string{`{"kind":"movie","page":0}`, `{"kind":"live","page":1}`, `{"kind":"movie","page":1,"through":101}`} {
		code, response := request(t, ts.URL, "POST", "/api/browse/retry", body)
		if code != 400 {
			t.Fatal(code, response)
		}
	}
	for _, body := range []string{`{"season":-1}`, `{"season":1.5}`, `{"season":null}`, `{"season":"all"}`} {
		code, response := request(t, ts.URL, "POST", "/api/series/series:2/episodes/retry", body)
		if code != 400 {
			t.Fatal(code, response)
		}
	}
}

func TestSeasonRetryResetsOnlyNavigationAndSelectedSeason(t *testing.T) {
	p := &seasonFixture{}
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.provider = p
	series := model.Item{ID: "series:2", Kind: "series", Name: "Show"}
	if err = seedBrowsePage(s.cache, model.BrowseQuery{Kind: "series", Category: "*", Page: 1}, model.BrowsePage{Items: []model.Item{series}, Page: 1}); err != nil {
		t.Fatal(err)
	}
	nav := series.ID + "#seasons"
	rows, _ := p.Seasons(context.Background(), series)
	if err = s.cache.setEpisodeListAtRevision(series.ID, nav, rows, s.cache.cacheRevision()); err != nil {
		t.Fatal(err)
	}
	selected := "episodes:" + series.ID + "#season:season:2:11"
	unrelated := "episodes:" + series.ID + "#season:season:2:55"
	for _, key := range []string{"episodes:" + nav, selected, unrelated, "episodes:series:other"} {
		for range recoveryAttemptLimit {
			if err = s.cache.cacheFailed(key, errors.New("failed season")); err != nil {
				t.Fatal(err)
			}
		}
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	code, body := request(t, ts.URL, "POST", "/api/series/series:2/episodes/retry", `{"season":"first"}`)
	if code != 204 {
		t.Fatal(code, body)
	}
	code, body = request(t, ts.URL, "GET", "/api/series/series:2/episodes?season=first", "")
	if code != 200 || !strings.Contains(body, "A named episode") {
		t.Fatal(code, body)
	}
	for _, key := range []string{"episodes:" + nav, selected} {
		state, _ := s.cache.cacheRetry(key)
		if state.failures != 0 {
			t.Fatal("requested retry stayed stopped", key)
		}
	}
	for _, key := range []string{unrelated, "episodes:series:other"} {
		state, _ := s.cache.cacheRetry(key)
		if !state.stopped() {
			t.Fatal("retry reopened unrelated season", key)
		}
	}
}

func TestScheduledRecoveryStopsUntilConfiguredCadenceAndSurvivesRestart(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	p := &fixtureProvider{fail: true}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	s.wg.Add(1)
	go s.scheduler(true)
	// Advance only the test scheduler's due time, keeping its persisted episode
	// counters and actual failed provider workflow intact.
	for failure := 1; failure <= recoveryAttemptLimit; failure++ {
		waitFor(t, func() bool {
			s.stateMu.RLock()
			defer s.stateMu.RUnlock()
			return !s.catalogSync.Running && s.catalogSync.Failures == failure
		})
		s.stateMu.Lock()
		if failure < recoveryAttemptLimit {
			now := time.Now()
			s.catalogSync.NextRefreshAt = &now
			s.refreshWake[0] <- struct{}{}
		}
		s.stateMu.Unlock()
	}
	s.stateMu.RLock()
	before := s.catalogSync
	s.stateMu.RUnlock()
	if !before.Paused || before.NextRefreshAt == nil || before.NextRefreshAt.Sub(*before.FinishedAt) != cfg.RefreshInterval {
		t.Fatal("exhausted recovery did not wait for configured cadence", before)
	}
	s.Close()
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.stateMu.RLock()
	restored := s.catalogSync
	s.stateMu.RUnlock()
	p.mu.Lock()
	calls := p.catalogs
	p.mu.Unlock()
	if !restored.Paused || restored.Failures != recoveryAttemptLimit || !restored.NextRefreshAt.Equal(*before.NextRefreshAt) || calls != recoveryAttemptLimit {
		t.Fatal("restart renewed exhausted scheduled episode", restored, calls)
	}
	// Its next configured run may start a fresh bounded episode.
	s.stateMu.Lock()
	now := time.Now()
	s.catalogSync.NextRefreshAt = &now
	s.refreshWake[0] <- struct{}{}
	s.stateMu.Unlock()
	waitFor(t, func() bool {
		s.stateMu.RLock()
		defer s.stateMu.RUnlock()
		return !s.catalogSync.Running && s.catalogSync.Failures == 1 && !s.catalogSync.Paused
	})
}

func TestLastAdmittedBrowseAttemptStaysRefreshingUntilItFinishes(t *testing.T) {
	s, ts, p := newChangingLibrary(t, 24*time.Hour)
	path := "/api/browse?kind=movie&category=8&page=1"
	libraryItems(t, ts, path, 1)
	key := pageKey(model.BrowseQuery{Kind: "movie", Category: "8", Page: 1})
	for range recoveryAttemptLimit - 1 {
		if err := s.cache.cacheFailed(key, errors.New("earlier failure")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0; UPDATE cache_retries SET retry_at=0`); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	var release sync.Once
	defer release.Do(func() { close(gate) })
	p.mu.Lock()
	p.oldGate = gate
	p.mu.Unlock()
	libraryItems(t, ts, path, 1)
	select {
	case <-p.browseStarted:
	case <-time.After(time.Second):
		t.Fatal("last admitted attempt never started")
	}
	for range 4 {
		code, body := request(t, ts.URL, "GET", path, "")
		var page model.BrowsePage
		if json.Unmarshal([]byte(body), &page) != nil || code != 200 || page.RetryStopped || !page.Refreshing || page.RefreshError != "" {
			t.Fatalf("active final attempt reported stopped: %d %s", code, body)
		}
	}
	p.mu.Lock()
	p.oldGate = nil
	p.mu.Unlock()
	release.Do(func() { close(gate) })
	waitFor(t, func() bool {
		page, ok, _ := s.cache.browseSnapshot(model.BrowseQuery{Kind: "movie", Category: "8", Page: 1}, 24*time.Hour)
		return ok && !page.Stale
	})
	libraryItems(t, ts, path, 2)
	p.mu.Lock()
	calls := p.browseCalls
	p.mu.Unlock()
	if calls != 2 {
		t.Fatal("polling started more than one final attempt", calls)
	}
}

func TestInterruptedRecoveryStartsRemainSpentAfterRestart(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	p := &pagedLibraryProvider{}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	q := model.BrowseQuery{Kind: "movie", Category: "8", Page: 1}
	started := time.Now().Add(-time.Minute)
	// These are persisted starts from an uncleanly interrupted process; no
	// completed failure was available to write an outcome.
	if _, err = s.cache.db.Exec(`INSERT INTO cache_retries(entry,failures,retry_at,paused,started_at,attempts) VALUES(?,0,0,0,?,?)`, pageKey(q), started.UnixNano(), recoveryAttemptLimit); err != nil {
		t.Fatal(err)
	}
	if err = s.saveScheduledRefresh("metadata", refreshState{Running: true, StartedAt: &started, RecoveryStartedAt: &started, Failures: recoveryAttemptLimit - 1, Configuration: s.refreshConfiguration(true)}); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	code, body := request(t, ts.URL, "GET", "/api/browse?kind=movie&category=8&page=1", "")
	if code != 502 {
		t.Fatal(code, body)
	}
	p.pageMu.Lock()
	calls := p.calls[1]
	p.pageMu.Unlock()
	if calls != 0 {
		t.Fatal("restart erased reserved page attempts", calls)
	}
	s.stateMu.RLock()
	state := s.catalogSync
	s.stateMu.RUnlock()
	if !state.Paused || state.Failures != recoveryAttemptLimit-1 || state.RecoveryAttempts != recoveryAttemptLimit || state.NextRefreshAt == nil || time.Until(*state.NextRefreshAt) < 23*time.Hour {
		t.Fatal("restart erased unfinished scheduled attempt", state)
	}
	p.mu.Lock()
	catalogCalls := p.catalogs
	p.mu.Unlock()
	if catalogCalls != 0 {
		t.Fatal("restart probed exhausted catalog", catalogCalls)
	}
	code, body = request(t, ts.URL, "POST", "/api/browse/retry", `{"kind":"movie","category":"8","page":1}`)
	if code != 204 {
		t.Fatal(code, body)
	}
	libraryItems(t, ts, "/api/browse?kind=movie&category=8&page=1", 3)
}

func TestColdViewersShareTheFinalBrowseOrEpisodeAttempt(t *testing.T) {
	for _, kind := range []string{"browse", "episodes"} {
		t.Run(kind, func(t *testing.T) {
			s, ts, p := newChangingLibrary(t, 24*time.Hour)
			if err := seedBrowsePage(s.cache, model.BrowseQuery{Kind: "series", Category: "*", Page: 1}, model.BrowsePage{Items: []model.Item{{ID: "series:2", Kind: "series", Name: "Show"}}, Page: 1}); err != nil {
				t.Fatal(err)
			}
			key := pageKey(model.BrowseQuery{Kind: "movie", Category: "8", Page: 1})
			path := "/api/browse?kind=movie&category=8&page=1"
			started := p.browseStarted
			if kind == "episodes" {
				key = "episodes:series:2"
				path = "/api/series/series:2/episodes"
				started = p.episodeStarted
			}
			for range recoveryAttemptLimit - 1 {
				if err := s.cache.cacheFailed(key, errors.New("prior failed request")); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.cache.db.Exec(`UPDATE cache_retries SET retry_at=0`); err != nil {
				t.Fatal(err)
			}
			gate := make(chan struct{})
			var release sync.Once
			defer release.Do(func() { close(gate) })
			p.mu.Lock()
			p.oldGate = gate
			p.mu.Unlock()
			type outcome struct {
				status int
				body   string
			}
			results := make(chan outcome, 2)
			load := func() { code, body := request(t, ts.URL, "GET", path, ""); results <- outcome{code, body} }
			go load()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("final cold attempt never started")
			}
			go load()
			select {
			case result := <-results:
				t.Fatal("cold viewer did not wait for shared final attempt", result)
			case <-time.After(30 * time.Millisecond):
			}
			release.Do(func() { close(gate) })
			for range 2 {
				select {
				case result := <-results:
					if result.status != 200 {
						t.Fatal("shared final attempt did not recover", result)
					}
				case <-time.After(time.Second):
					t.Fatal("shared final attempt did not finish")
				}
			}
			p.mu.Lock()
			calls := p.browseCalls
			if kind == "episodes" {
				calls = p.episodeCalls
			}
			p.mu.Unlock()
			if calls != 1 {
				t.Fatal("cold concurrent viewers started an extra attempt", calls)
			}
		})
	}
}
