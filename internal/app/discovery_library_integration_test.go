package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestLibraryRefreshRenewsTrendingWithoutDashboardRequests(t *testing.T) {
	var phase, metadataCalls atomic.Int32
	started := make(chan int, 2)
	gates := []chan struct{}{nil, make(chan struct{}), make(chan struct{})}
	name := func(n int) string { return fmt.Sprintf("Trending film %d", n) }
	p := &stagedDiscoveryProvider{browse: func(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
		page := model.BrowsePage{Items: []model.Item{}, Page: 1}
		n := int(phase.Load())
		if q.Kind != "movie" || q.Search != name(n) {
			return page, nil
		}
		if q.Category != "*" {
			t.Error("Trending search was scoped to a category", q)
		}
		if n > 0 {
			started <- n
			select {
			case <-gates[n]:
			case <-ctx.Done():
				return page, ctx.Err()
			}
		}
		page.Items = []model.Item{{ID: fmt.Sprintf("movie:%d", n), Kind: "movie", Name: name(n), CategoryID: "8", Year: 2025}}
		page.Total = 1
		return page, nil
	}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	s.discoveryService.client.Transport = discoveryTransport(func(req *http.Request) (*http.Response, error) {
		metadataCalls.Add(1)
		titles := []tmdbTitle{}
		if req.URL.Path == "/3/trending/movie/week" {
			n := int(phase.Load())
			titles = append(titles, tmdbTitle{ID: n + 1, Title: name(n), ReleaseDate: "2025-01-01"})
		}
		data, _ := json.Marshal(map[string]any{"results": titles})
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})
	finished := func(n int) bool {
		s.discoveryService.mu.Lock()
		defer s.discoveryService.mu.Unlock()
		record := s.discoveryService.record
		return !s.discoveryService.refreshing && len(record.Movies) == 1 && record.Movies[0].TMDBID == n+1
	}
	// Seed a saved rail and fresh TMDB lists without opening the dashboard.
	s.queueDiscovery(s.cache.libraryRevision())
	waitFor(t, func() bool { return finished(0) })
	if metadataCalls.Load() != 2 {
		t.Fatal("initial metadata requests", metadataCalls.Load())
	}

	// The real library scheduler must renew those still-fresh lists and link
	// them before marking its job complete, without a discovery GET to start it.
	phase.Store(1)
	s.wg.Add(1)
	go s.scheduler(true)
	for n := 1; n <= 2; n++ {
		if n == 2 {
			phase.Store(2)
			if code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`); code != 202 {
				t.Fatal(code, body)
			}
		}
		select {
		case got := <-started:
			if got != n {
				t.Fatal("unexpected linking job", got, n)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("library refresh did not start Trending linking without a dashboard request")
		}
		stale := readDiscovery(t, ts)
		if !stale.Refreshing || len(stale.TrendingMovies) != 1 || stale.TrendingMovies[0].TMDBID != n {
			t.Fatal("saved Trending disappeared before its replacement was ready", stale)
		}
		if !readLibraryStatus(t, ts).Sync["catalog"].Running {
			t.Fatal("library job finished before Trending linking")
		}
		if code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`); code != 202 {
			t.Fatal(code, body)
		}
		close(gates[n])
		waitFor(t, func() bool {
			state := readLibraryStatus(t, ts).Sync["catalog"]
			return finished(n) && !state.Running && state.NextRefreshAt != nil
		})
		if metadataCalls.Load() != int32(2*(n+1)) {
			t.Fatal("refresh reused a fresh TMDB list or fetched it repeatedly", metadataCalls.Load())
		}
		p.mu.Lock()
		catalogs := p.catalogs
		p.mu.Unlock()
		if catalogs != n {
			t.Fatal("joining an active refresh queued another library job", catalogs, n)
		}
	}
}

func TestDiscoveryFailureRetriesInBackgroundWhileServingSavedRail(t *testing.T) {
	film := model.Item{ID: "movie:retry", Kind: "movie", Name: "Saved film", Year: 2025}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, &discoveryFixtureProvider{items: []model.Item{film}})
	stagedMetadata(s, []tmdbTitle{{ID: 1, Title: film.Name, ReleaseDate: "2025-01-01"}})
	warm := waitDiscovery(t, ts)
	var failed atomic.Bool
	failed.Store(true)
	var calls atomic.Int32
	s.discoveryService.client.Transport = discoveryTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		if failed.Load() {
			return nil, errors.New("metadata unavailable")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"results":[]}`))}, nil
	})
	if err := s.refreshDiscoveryAfterLibrary(s.cache.libraryRevision()); err == nil {
		t.Fatal("forced refresh did not report the metadata failure")
	}
	fallback := readDiscovery(t, ts)
	if fallback.Error == "" || len(fallback.TrendingMovies) != 1 || fallback.UpdatedAt == nil || !fallback.UpdatedAt.Equal(*warm.UpdatedAt) {
		t.Fatal("failed refresh discarded the saved rail", fallback)
	}
	// Move the persisted retry deadline close enough to exercise the real
	// timer without a five-minute wait or any dashboard request to trigger it.
	failed.Store(false)
	s.discoveryService.mu.Lock()
	if len(s.discoveryService.record.Metadata["movie"].Titles) != 1 {
		s.discoveryService.mu.Unlock()
		t.Fatal("failed forced refresh discarded the saved TMDB list")
	}
	if s.discoveryService.retryTimer == nil {
		s.discoveryService.mu.Unlock()
		t.Fatal("failed refresh did not schedule a background retry")
	}
	s.discoveryService.retryTimer.Stop()
	s.discoveryService.retryTimer = nil
	s.discoveryService.record.NextAttempt = time.Now().Add(20 * time.Millisecond)
	s.scheduleDiscoveryRetryLocked(time.Time{})
	s.discoveryService.mu.Unlock()
	waitFor(t, func() bool {
		s.discoveryService.mu.Lock()
		defer s.discoveryService.mu.Unlock()
		return calls.Load() >= 3 && !s.discoveryService.refreshing && s.discoveryService.record.Error == "" && s.discoveryService.record.Failures == 0
	})
}

func TestDiscoveryRetryBackoffAndLimitSurviveRestart(t *testing.T) {
	film := model.Item{ID: "movie:bounded", Kind: "movie", Name: "Saved film", Year: 2025}
	p := &discoveryFixtureProvider{items: []model.Item{film}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	stagedMetadata(s, []tmdbTitle{{ID: 1, Title: film.Name, ReleaseDate: "2025-01-01"}})
	warm := waitDiscovery(t, ts)
	var calls atomic.Int32
	failedTransport := discoveryTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("metadata unavailable")
	})
	s.discoveryService.client.Transport = failedTransport
	for failure := 1; failure <= discoveryRetryLimit+1; failure++ {
		if failure == 1 {
			if err := s.refreshDiscoveryAfterLibrary(s.cache.libraryRevision()); err == nil {
				t.Fatal("expected the forced metadata refresh to fail")
			}
		} else {
			// Advance only the retry deadline; the real builder, persisted
			// failure count, and request guard determine the next attempt.
			s.discoveryService.mu.Lock()
			s.discoveryService.retryTimer.Stop()
			s.discoveryService.retryTimer = nil
			s.discoveryService.record.NextAttempt = time.Time{}
			s.discoveryService.mu.Unlock()
			s.queueDiscovery(s.cache.libraryRevision())
			waitFor(t, func() bool {
				s.discoveryService.mu.Lock()
				defer s.discoveryService.mu.Unlock()
				return !s.discoveryService.refreshing && s.discoveryService.record.Failures == failure
			})
		}
		s.discoveryService.mu.Lock()
		record := s.discoveryService.record
		timer := s.discoveryService.retryTimer
		s.discoveryService.mu.Unlock()
		if record.Failures != failure || len(record.Movies) != 1 || !record.UpdatedAt.Equal(*warm.UpdatedAt) {
			t.Fatal("failure count or saved recommendations changed incorrectly", record.Failures, record.Movies)
		}
		if failure <= discoveryRetryLimit {
			base := 5 * time.Minute << (failure - 1)
			remaining := time.Until(record.NextAttempt)
			if timer == nil || remaining < base*8/10-time.Second || remaining > base*12/10 {
				t.Fatal("retry did not use bounded exponential backoff", failure, remaining)
			}
		} else if timer != nil || !record.NextAttempt.IsZero() || !strings.Contains(record.Error, "paused") {
			t.Fatal("exhausted refresh kept retrying", record.Failures, record.NextAttempt, record.Error)
		}
	}
	if calls.Load() != int32(1+discoveryRetryLimit) {
		t.Fatal("unexpected number of failed attempts", calls.Load())
	}
	for range 5 {
		readDiscovery(t, ts)
	}
	if calls.Load() != int32(1+discoveryRetryLimit) {
		t.Fatal("dashboard reads bypassed the retry limit", calls.Load())
	}
	ts.Close()
	s.Close()
	restored, restoredTS := discoveryTestServer(t, s.cfg, p)
	restored.discoveryService.client.Transport = failedTransport
	if result := readDiscovery(t, restoredTS); result.Refreshing || len(result.TrendingMovies) != 1 {
		t.Fatal("restart bypassed the retry limit or lost saved recommendations", result)
	}
	restored.discoveryService.mu.Lock()
	failures, timer := restored.discoveryService.record.Failures, restored.discoveryService.retryTimer
	restored.discoveryService.mu.Unlock()
	if failures != 1+discoveryRetryLimit || timer != nil || calls.Load() != int32(1+discoveryRetryLimit) {
		t.Fatal("exhausted retry state did not persist", failures, calls.Load())
	}
	// A new library/manual refresh starts a new retry cycle immediately.
	if err := restored.refreshDiscoveryAfterLibrary(restored.cache.libraryRevision()); err == nil {
		t.Fatal("expected the new refresh cycle to fail")
	}
	restored.discoveryService.mu.Lock()
	failures, timer = restored.discoveryService.record.Failures, restored.discoveryService.retryTimer
	restored.discoveryService.mu.Unlock()
	if failures != 1 || timer == nil || calls.Load() != int32(2+discoveryRetryLimit) {
		t.Fatal("new library refresh did not reset the retry cycle", failures, calls.Load())
	}
}

func TestDiscoveryContinuesBudgetAcrossRestart(t *testing.T) {
	titles := make([]tmdbTitle, discoveryTrendCandidates)
	for index := range titles {
		titles[index] = tmdbTitle{ID: index + 1, Title: fmt.Sprintf("Budget title %d", index+1), ReleaseDate: "2025-01-01"}
	}
	var searches atomic.Int32
	p := &stagedDiscoveryProvider{browse: func(_ context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
		page := model.BrowsePage{Page: 1, Items: []model.Item{}}
		if q.Search == "" {
			return page, nil
		}
		searches.Add(1)
		for _, title := range titles {
			if q.Search == title.name() {
				page.Items = []model.Item{{ID: fmt.Sprintf("movie:budget-%d", title.ID), Kind: "movie", Name: title.name(), Year: 2025}}
				break
			}
		}
		return page, nil
	}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	stagedMetadata(s, titles)
	s.queueDiscovery(s.cache.libraryRevision())
	waitFor(t, func() bool {
		s.discoveryService.mu.Lock()
		defer s.discoveryService.mu.Unlock()
		return !s.discoveryService.refreshing && s.discoveryService.record.Pending
	})
	s.discoveryService.mu.Lock()
	partial := s.discoveryService.record
	s.discoveryService.mu.Unlock()
	if len(partial.Movies) != discoverySearchBudget/2 || partial.Cursors["movie"] != discoverySearchBudget/2 || partial.Failures != 0 || partial.Error != "" {
		t.Fatal("budget did not persist unfinished progress", len(partial.Movies), partial.Cursors, partial.Error)
	}
	if !readDiscovery(t, ts).Refreshing {
		t.Fatal("pending continuation was reported as complete")
	}
	// Restore a warm library and a pending retry deadline. Startup must resume
	// this work itself, without a discovery request from any browser.
	if err := s.cache.setCatalog([]model.Item{{ID: "live:1", Kind: "live", Name: "News"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setCategories([]model.Category{{ID: "8", Kind: "movie", Name: "Films"}, {ID: "7", Kind: "series", Name: "Shows"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setEPG([]model.Program{{ChannelID: "live:1", Start: time.Now(), End: time.Now().Add(24 * time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	partial.NextAttempt = time.Now().Add(100 * time.Millisecond)
	if err := s.publishDiscovery(partial); err != nil {
		t.Fatal(err)
	}
	ts.Close()
	s.Close()
	restored, err := New(s.cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	waitFor(t, func() bool {
		restored.discoveryService.mu.Lock()
		defer restored.discoveryService.mu.Unlock()
		return !restored.discoveryService.refreshing && !restored.discoveryService.record.Pending
	})
	restored.discoveryService.mu.Lock()
	complete := restored.discoveryService.record
	restored.discoveryService.mu.Unlock()
	if len(complete.Movies) != discoveryTrendCandidates || searches.Load() != discoveryTrendCandidates || complete.Failures != 0 {
		t.Fatal("continuation repeated completed work or skipped candidates", len(complete.Movies), searches.Load(), complete.Error)
	}
}

func TestDiscoveryFinalStorageFailureRetriesAndStopsAtLimit(t *testing.T) {
	for _, recoverStorage := range []bool{true, false} {
		t.Run(fmt.Sprintf("recover=%t", recoverStorage), func(t *testing.T) {
			s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, &discoveryFixtureProvider{})
			stagedMetadata(s, nil)
			warm := waitDiscovery(t, ts)
			// Only the final publication advances updatedAt. Intermediate title
			// checkpoints still succeed, reproducing a final commit outage.
			_, err := s.cache.db.Exec(`CREATE TRIGGER reject_discovery_completion BEFORE UPDATE ON discovery
WHEN json_extract(NEW.data,'$.updatedAt') <> json_extract(OLD.data,'$.updatedAt')
BEGIN SELECT RAISE(FAIL, 'simulated storage outage'); END`)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.refreshDiscoveryAfterLibrary(s.cache.libraryRevision()); err == nil {
				t.Fatal("storage failure was not reported")
			}
			lastFailure := discoveryRetryLimit + 1
			if recoverStorage {
				lastFailure = 1
			}
			for failure := 1; failure <= lastFailure; failure++ {
				if failure > 1 {
					s.discoveryService.mu.Lock()
					s.discoveryService.retryTimer.Stop()
					s.discoveryService.retryTimer = nil
					s.discoveryService.record.NextAttempt = time.Time{}
					s.discoveryService.mu.Unlock()
					s.queueDiscovery(s.cache.libraryRevision())
					waitFor(t, func() bool {
						s.discoveryService.mu.Lock()
						defer s.discoveryService.mu.Unlock()
						return !s.discoveryService.refreshing && s.discoveryService.record.Failures == failure
					})
				}
				s.discoveryService.mu.Lock()
				record, timer := s.discoveryService.record, s.discoveryService.retryTimer
				s.discoveryService.mu.Unlock()
				if record.Failures != failure || !record.UpdatedAt.Equal(*warm.UpdatedAt) || record.Error == "" {
					t.Fatal("storage failure reset recovery state", record.Failures, record.Error)
				}
				if failure <= discoveryRetryLimit && (timer == nil || record.NextAttempt.IsZero()) {
					t.Fatal("storage failure needs an automatic retry")
				}
				if failure > discoveryRetryLimit && (!record.Paused || timer != nil) {
					t.Fatal("storage retries must stop at the limit")
				}
			}
			if !recoverStorage {
				// A manual/library cycle gets its own retry allowance even if
				// its final write fails before that reset can reach SQLite.
				if err := s.refreshDiscoveryAfterLibrary(s.cache.libraryRevision()); err == nil {
					t.Fatal("expected the new cycle's final storage write to fail")
				}
				s.discoveryService.mu.Lock()
				record, timer := s.discoveryService.record, s.discoveryService.retryTimer
				s.discoveryService.mu.Unlock()
				if record.Failures != 1 || record.Paused || timer == nil || record.NextAttempt.IsZero() {
					t.Fatal("new cycle inherited exhausted storage retries", record.Failures, record.Paused, record.NextAttempt)
				}
				return
			}
			if _, err := s.cache.db.Exec(`DROP TRIGGER reject_discovery_completion`); err != nil {
				t.Fatal(err)
			}
			// Exercise timer recovery without opening the dashboard.
			s.discoveryService.mu.Lock()
			s.discoveryService.retryTimer.Stop()
			s.discoveryService.retryTimer = nil
			s.discoveryService.record.NextAttempt = time.Now().Add(20 * time.Millisecond)
			s.scheduleDiscoveryRetryLocked(time.Time{})
			s.discoveryService.mu.Unlock()
			waitFor(t, func() bool {
				s.discoveryService.mu.Lock()
				defer s.discoveryService.mu.Unlock()
				return !s.discoveryService.refreshing && s.discoveryService.record.Failures == 0 && s.discoveryService.record.Error == "" && s.discoveryService.record.UpdatedAt.After(*warm.UpdatedAt)
			})
		})
	}
}

func TestDiscoveryHonorsMetadataRetryAfter(t *testing.T) {
	for _, header := range []string{"3600", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat)} {
		t.Run(header, func(t *testing.T) {
			s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, &discoveryFixtureProvider{})
			stagedMetadata(s, nil)
			waitDiscovery(t, ts)
			s.discoveryService.client.Transport = discoveryTransport(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: http.StatusTooManyRequests, Header: http.Header{"Retry-After": []string{header}}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
			})
			started := time.Now()
			if err := s.refreshDiscoveryAfterLibrary(s.cache.libraryRevision()); err == nil {
				t.Fatal("expected metadata rate limit")
			}
			s.discoveryService.mu.Lock()
			record := s.discoveryService.record
			s.discoveryService.mu.Unlock()
			if record.Failures != 1 || record.Paused || record.NextAttempt.Before(started.Add(59*time.Minute)) {
				t.Fatal("metadata Retry-After was ignored", record.Failures, record.NextAttempt, record.Paused)
			}
		})
	}
}
