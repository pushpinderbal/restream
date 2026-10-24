package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestExpiredBrowseReturnsSavedPageWhileUsersShareOneRefresh(t *testing.T) {
	s, ts, p := newChangingLibrary(t, 24*time.Hour)
	path := "/api/browse?kind=movie&category=8&page=1"
	libraryItems(t, ts, path, 1)
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=? WHERE kind='movie'`, time.Now().Add(-25*time.Hour).UnixNano()); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	p.mu.Lock()
	p.oldGate = gate
	p.mu.Unlock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		var users sync.WaitGroup
		for range 20 {
			users.Add(1)
			go func() { defer users.Done(); libraryItems(t, ts, path, 1) }()
		}
		users.Wait()
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("cached responses waited for the provider")
	}
	select {
	case <-p.browseStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("expired page never started revalidation")
	}
	p.mu.Lock()
	calls := p.browseCalls
	p.mu.Unlock()
	if calls != 2 {
		t.Fatal("users did not share the refresh", calls)
	}
	release.Do(func() { close(gate) })
	waitForLibraryItems(t, ts, path, 2)
	for range 10 {
		libraryItems(t, ts, path, 2)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.browseCalls != 2 {
		t.Fatal("settled cache was fetched again", p.browseCalls)
	}
}

func TestShutdownCancelsSharedBackgroundBrowse(t *testing.T) {
	p := &fixtureProvider{}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	categories, err := p.Categories(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setCategories(categories); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	path := "/api/browse?kind=movie&category=8&page=1"
	libraryItems(t, ts, path, 1)
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0`); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	p.mu.Lock()
	p.browseGate = gate
	p.mu.Unlock()
	code, body := request(t, ts.URL, "GET", path, "")
	if code != 200 || !strings.Contains(body, "Film") {
		t.Fatal(code, body)
	}
	waitFor(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.browseCalls == 2 })
	stopped := make(chan struct{})
	go func() { s.Close(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		close(gate)
		t.Fatal("shutdown waited for blocked background provider request")
	}
	restored, err := openStore(cfg.DataDir, cfg.PortalURL, cfg.MAC)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.close()
	state, err := restored.cacheRetry(pageKey(model.BrowseQuery{Kind: "movie", Category: "8", Page: 1}))
	if err != nil || state.failures != 0 || state.attempts != 1 || state.started.IsZero() {
		t.Fatal("shutdown cancellation lost actual attempt or counted a failure", state, err)
	}
}

type pagedLibraryProvider struct {
	fixtureProvider
	pageMu   sync.Mutex
	failed   bool
	failure  error
	inserted bool
	calls    map[int]int
	gatePage int
	gate     <-chan struct{}
	started  chan struct{}
}

func (p *pagedLibraryProvider) Browse(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
	p.pageMu.Lock()
	if p.calls == nil {
		p.calls = map[int]int{}
	}
	p.calls[q.Page]++
	inserted, gate, gatePage, failed, failure := p.inserted, p.gate, p.gatePage, p.failed, p.failure
	p.pageMu.Unlock()
	if failed {
		if failure != nil {
			return model.BrowsePage{}, failure
		}
		return model.BrowsePage{}, errors.New("private provider failure token=secret")
	}
	if gate != nil && q.Page == gatePage && !inserted {
		select {
		case p.started <- struct{}{}:
		default:
		}
		select {
		case <-gate:
		case <-ctx.Done():
			return model.BrowsePage{}, ctx.Err()
		}
	}
	names := []string{"A", "B", "C", "D", "E", "F", "G", "H", "I"}
	if inserted {
		names = append([]string{"X"}, names...)
	}
	items := []model.Item{}
	for i := (q.Page - 1) * 3; i < min(q.Page*3, len(names)); i++ {
		name := names[i]
		if q.Search != "" {
			name = q.Search + name
		}
		items = append(items, model.Item{ID: "movie:" + name, Kind: "movie", Name: name, CategoryID: "8"})
	}
	return model.BrowsePage{Items: items, Page: q.Page, Total: len(names), HasMore: q.Page*3 < len(names)}, nil
}

func TestPagedRevalidationReplacesLoadedRangeWithoutMixingOldPages(t *testing.T) {
	p := &pagedLibraryProvider{started: make(chan struct{}, 1)}
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	categories, _ := p.Categories(context.Background())
	if err := s.cache.setCategories(categories); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	base := "/api/browse?kind=movie&category=8&page="
	for page := 1; page <= 3; page++ {
		libraryItems(t, ts, base+strconv.Itoa(page), 3)
	}
	libraryItems(t, ts, base+"1&search=other", 3)
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0 WHERE search=''`); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	p.pageMu.Lock()
	p.gate, p.gatePage = gate, 2
	p.pageMu.Unlock()
	libraryItems(t, ts, base+"2", 3)
	select {
	case <-p.started:
	case <-time.After(2 * time.Second):
		t.Fatal("old page request did not start")
	}
	p.pageMu.Lock()
	p.inserted = true
	p.pageMu.Unlock()
	rangePath := base + "1&through=3"
	assertListing := func(body string, want []string) bool {
		var result model.BrowsePage
		if json.Unmarshal([]byte(body), &result) != nil || len(result.Items) != len(want) {
			return false
		}
		for i, item := range result.Items {
			if item.Name != want[i] {
				return false
			}
		}
		return true
	}
	updated := []string{"X", "A", "B", "C", "D", "E", "F", "G", "H"}
	started := time.Now()
	code, body := request(t, ts.URL, "GET", rangePath, "")
	var initial model.BrowsePage
	if code != 200 || json.Unmarshal([]byte(body), &initial) != nil || time.Since(started) > time.Second {
		t.Fatal("cached range was not returned promptly", code, body)
	}
	if initial.Stale && !initial.Refreshing {
		t.Fatal("stale range did not advertise revalidation", body)
	}
	if !initial.Stale && !initial.Refreshing && !assertListing(body, updated) {
		t.Fatal("settled range mixed listing generations", body)
	}
	waitFor(t, func() bool {
		_, body := request(t, ts.URL, "GET", rangePath, "")
		var page model.BrowsePage
		return json.Unmarshal([]byte(body), &page) == nil && !page.Stale && !page.Refreshing && assertListing(body, updated)
	})
	release.Do(func() { close(gate) })
	settled := make(chan struct{})
	go func() { s.browseWG.Wait(); close(settled) }()
	select {
	case <-settled:
	case <-time.After(2 * time.Second):
		t.Fatal("old page refresh did not finish")
	}
	// A late old response must not replace the new page or its item details.
	waitFor(t, func() bool {
		_, body := request(t, ts.URL, "GET", base+"2", "")
		return assertListing(body, []string{"C", "D", "E"})
	})
	_, body = request(t, ts.URL, "GET", base+"1&search=other", "")
	if !assertListing(body, []string{"otherA", "otherB", "otherC"}) {
		t.Fatal("another search cache was invalidated", body)
	}
	p.pageMu.Lock()
	defer p.pageMu.Unlock()
	for page := range p.calls {
		if page > 3 {
			t.Fatal("fetched beyond loaded range", p.calls)
		}
	}
}

func TestFailedBrowseRefreshKeepsSavedDataAndRetryDeadlineAfterRestart(t *testing.T) {
	p := &pagedLibraryProvider{}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	s.provider = p
	categories, _ := p.Categories(context.Background())
	if err := s.cache.setCategories(categories); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close() })
	path := "/api/browse?kind=movie&category=8&page=1"
	libraryItems(t, ts, path, 3)
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0`); err != nil {
		t.Fatal(err)
	}
	p.pageMu.Lock()
	p.failed = true
	p.pageMu.Unlock()
	libraryItems(t, ts, path, 3)
	waitFor(t, func() bool {
		var count int
		err := s.cache.db.QueryRow(`SELECT COUNT(*) FROM cache_retries WHERE retry_at>0`).Scan(&count)
		return err == nil && count == 1
	})
	for range 20 {
		libraryItems(t, ts, path, 3)
	}
	p.pageMu.Lock()
	if p.calls[1] != 2 {
		t.Error("failed refresh repeated provider work", p.calls)
	}
	p.pageMu.Unlock()
	ts.Close()
	s.Close()
	s, err = New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	ts = httptest.NewServer(s)
	for range 10 {
		libraryItems(t, ts, path, 3)
	}
	p.pageMu.Lock()
	if p.calls[1] != 2 {
		t.Error("restart forgot failed refresh deadline", p.calls)
	}
	p.failed, p.inserted = false, true
	p.pageMu.Unlock()
	if _, err := s.cache.db.Exec(`UPDATE cache_retries SET retry_at=0`); err != nil {
		t.Fatal(err)
	}
	libraryItems(t, ts, path, 3)
	waitFor(t, func() bool {
		_, body := request(t, ts.URL, "GET", path, "")
		var result model.BrowsePage
		return json.Unmarshal([]byte(body), &result) == nil && len(result.Items) == 3 && result.Items[0].Name == "X"
	})
	p.pageMu.Lock()
	defer p.pageMu.Unlock()
	if p.calls[1] != 3 {
		t.Fatal("successful refresh was not shared", p.calls)
	}
}

type permanentCacheFailure struct{}

func (permanentCacheFailure) Error() string   { return "provider authentication rejected" }
func (permanentCacheFailure) Permanent() bool { return true }

func TestBrowseAuthenticationPauseSurvivesRestartUntilManualRefresh(t *testing.T) {
	p := &pagedLibraryProvider{}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	categories, _ := p.Categories(context.Background())
	if err := s.cache.setCategories(categories); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	path := "/api/browse?kind=movie&category=8&page=1"
	libraryItems(t, ts, path, 3)
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0`); err != nil {
		t.Fatal(err)
	}
	p.pageMu.Lock()
	p.failed, p.failure = true, permanentCacheFailure{}
	p.pageMu.Unlock()
	libraryItems(t, ts, path, 3)
	waitFor(t, func() bool {
		state, err := s.cache.cacheRetry(pageKey(model.BrowseQuery{Kind: "movie", Category: "8", Page: 1}))
		return err == nil && state.paused
	})
	ts.Close()
	s.Close()
	s, err = New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	ts = httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	// An expired timestamp cannot bypass a permanent authentication pause.
	if _, err := s.cache.db.Exec(`UPDATE cache_retries SET retry_at=0`); err != nil {
		t.Fatal(err)
	}
	for range 8 {
		libraryItems(t, ts, path, 3)
	}
	p.pageMu.Lock()
	if p.calls[1] != 2 {
		t.Error("restart lost authentication pause", p.calls)
	}
	p.failed = false
	p.pageMu.Unlock()
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	libraryItems(t, ts, path, 3)
	waitFor(t, func() bool { p.pageMu.Lock(); defer p.pageMu.Unlock(); return p.calls[1] == 3 })
}

func TestBrowsePersistenceFailureDoesNotRepeatedlyFetchProvider(t *testing.T) {
	p := &pagedLibraryProvider{}
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.provider = p
	categories, _ := p.Categories(context.Background())
	if err := s.cache.setCategories(categories); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	path := "/api/browse?kind=movie&category=8&page=1"
	libraryItems(t, ts, path, 3)
	if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0;
 CREATE TRIGGER reject_page_save BEFORE INSERT ON pages BEGIN SELECT RAISE(FAIL,'simulated storage failure'); END;
 CREATE TRIGGER reject_retry_save BEFORE INSERT ON cache_retries BEGIN SELECT RAISE(FAIL,'simulated storage failure'); END;`); err != nil {
		t.Fatal(err)
	}
	libraryItems(t, ts, path, 3)
	waitFor(t, func() bool { s.cache.mu.RLock(); defer s.cache.mu.RUnlock(); return len(s.cache.retryFallback) == 1 })
	for range 12 {
		libraryItems(t, ts, path, 3)
	}
	p.pageMu.Lock()
	defer p.pageMu.Unlock()
	if p.calls[1] != 1 {
		t.Fatal("provider work started without persisting its recovery budget", p.calls)
	}
}

type sourceSwitchProvider struct {
	fixtureProvider
	sourceMu sync.Mutex
	sources  []string
	started  chan struct{}
	gate     <-chan struct{}
}

func (p *sourceSwitchProvider) Browse(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
	if q.Kind == "movie" {
		return p.fixtureProvider.Browse(ctx, q)
	}
	p.sourceMu.Lock()
	p.sources = append(p.sources, q.SourceType)
	p.sourceMu.Unlock()
	if q.SourceType == "vod" {
		select {
		case p.started <- struct{}{}:
		default:
		}
		select {
		case <-p.gate:
		case <-ctx.Done():
			return model.BrowsePage{}, ctx.Err()
		}
	}
	return model.BrowsePage{Items: []model.Item{{ID: "series:2", Kind: "series", Name: q.SourceType + " source", CategoryID: "7", SourceType: q.SourceType}}, Page: q.Page, Total: 1}, nil
}

func TestSeriesSourceChangeRejectsInflightPagesAndPreservesMovieCache(t *testing.T) {
	for _, cached := range []bool{false, true} {
		name := "cold"
		if cached {
			name = "cached"
		}
		t.Run(name, func(t *testing.T) {
			gate := make(chan struct{})
			p := &sourceSwitchProvider{started: make(chan struct{}, 1), gate: gate}
			s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			s.provider = p
			ts := httptest.NewServer(s)
			t.Cleanup(func() { ts.Close(); s.Close() })
			var release sync.Once
			t.Cleanup(func() { release.Do(func() { close(gate) }) })
			categories, _ := p.Categories(context.Background())
			if err := s.cache.setCategories(categories); err != nil {
				t.Fatal(err)
			}
			moviePath := "/api/browse?kind=movie&category=8&page=1"
			libraryItems(t, ts, moviePath, 1)
			path := "/api/browse?kind=series&category=7&page=1"
			if cached {
				q := model.BrowseQuery{Kind: "series", Category: "7", Page: 1, SourceType: "vod"}
				page := model.BrowsePage{Items: []model.Item{{ID: "series:2", Kind: "series", Name: "vod source", CategoryID: "7", SourceType: "vod"}}, Page: 1, Total: 1}
				if err := seedBrowsePage(s.cache, q, page); err != nil {
					t.Fatal(err)
				}
				if _, err := s.cache.db.Exec(`UPDATE pages SET fetched_at=0 WHERE kind='series'`); err != nil {
					t.Fatal(err)
				}
			}
			oldDone := make(chan int, 1)
			go func() { code, _ := request(t, ts.URL, "GET", path, ""); oldDone <- code }()
			select {
			case <-p.started:
			case <-time.After(2 * time.Second):
				t.Fatal("old source request did not start")
			}
			var generations int
			if err := s.cache.db.QueryRow(`SELECT COUNT(*) FROM listing_revisions WHERE listing=?`, listingKey(model.BrowseQuery{Kind: "series", Category: "7"})).Scan(&generations); err != nil || (!cached && generations != 0) {
				t.Fatal("cold fixture unexpectedly has a listing generation", generations, err)
			}
			seriesQuery := model.BrowseQuery{Kind: "series", Category: "7"}
			movieQuery := model.BrowseQuery{Kind: "movie", Category: "8"}
			previousSeriesRevision, err := s.cache.listingRevision(seriesQuery)
			if err != nil {
				t.Fatal(err)
			}
			previousMovieRevision, err := s.cache.listingRevision(movieQuery)
			if err != nil {
				t.Fatal(err)
			}
			for i := range categories {
				if categories[i].Kind == "series" {
					categories[i].SourceType = "series"
				}
			}
			if err := s.cache.setCategories(categories); err != nil {
				t.Fatal(err)
			}
			freshDone := make(chan string, 1)
			go func() {
				var body string
				for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
					code, result := request(t, ts.URL, "GET", path, "")
					body = result
					var page model.BrowsePage
					if code != 200 || json.Unmarshal([]byte(body), &page) != nil || (!page.Stale && !page.Refreshing) {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				freshDone <- body
			}()
			select {
			case body := <-freshDone:
				if !strings.Contains(body, "series source") || strings.Contains(body, "vod source") {
					t.Fatal("new source request returned old data", body)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("new source request joined the old in-flight listing")
			}
			release.Do(func() { close(gate) })
			select {
			case <-oldDone:
			case <-time.After(2 * time.Second):
				t.Fatal("old source request did not finish")
			}
			settled := make(chan struct{})
			go func() { s.browseWG.Wait(); close(settled) }()
			select {
			case <-settled:
			case <-time.After(2 * time.Second):
				t.Fatal("old source refresh did not finish")
			}
			_, body := request(t, ts.URL, "GET", path, "")
			if !strings.Contains(body, "series source") || strings.Contains(body, "vod source") {
				t.Fatal("old source overwrote the refreshed listing", body)
			}
			item, ok := s.cache.item("series:2")
			if !ok || item.SourceType != "series" || item.Name != "series source" {
				t.Fatal("old source replaced current playback details", item)
			}
			currentSeriesRevision, err := s.cache.listingRevision(seriesQuery)
			if err != nil || cached && currentSeriesRevision <= previousSeriesRevision {
				t.Fatal("source change did not advance existing series listing generation", previousSeriesRevision, currentSeriesRevision, err)
			}
			currentMovieRevision, err := s.cache.listingRevision(movieQuery)
			if err != nil || currentMovieRevision != previousMovieRevision {
				t.Fatal("series source change advanced unrelated movie generation", previousMovieRevision, currentMovieRevision, err)
			}
			libraryItems(t, ts, moviePath, 1)
			p.mu.Lock()
			movieCalls := p.browseCalls
			p.mu.Unlock()
			if movieCalls != 1 {
				t.Fatal("series source change invalidated movie cache", movieCalls)
			}
			p.sourceMu.Lock()
			defer p.sourceMu.Unlock()
			if len(p.sources) != 2 || p.sources[0] != "vod" || p.sources[1] != "series" {
				t.Fatal("unexpected series source fetches", p.sources)
			}
		})
	}
}
