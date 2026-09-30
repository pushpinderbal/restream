package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type changingLibraryProvider struct {
	*fixtureProvider
	version        int
	oldGate        <-chan struct{}
	browseStarted  chan struct{}
	episodeStarted chan struct{}
}

func (p *changingLibraryProvider) Browse(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
	p.mu.Lock()
	p.browseCalls++
	version, gate := p.version, p.oldGate
	p.mu.Unlock()
	if version == 0 && gate != nil {
		select {
		case p.browseStarted <- struct{}{}:
		default:
		}
		select {
		case <-gate:
		case <-ctx.Done():
			return model.BrowsePage{}, ctx.Err()
		}
	}
	id, categoryID := "series:2", "7"
	if q.Kind == "movie" {
		id, categoryID = "movie:2", "8"
	}
	items := []model.Item{{ID: id, Kind: q.Kind, Name: "Original title", CategoryID: categoryID}}
	if version > 0 {
		items[0].Name = "Updated title"
		items = append(items, model.Item{ID: id + "-new", Kind: q.Kind, Name: "New title", CategoryID: categoryID})
	} else if gate != nil {
		items = append(items, model.Item{ID: id + "-old", Kind: q.Kind, Name: "Previous title", CategoryID: categoryID})
	}
	return model.BrowsePage{Items: items, Page: 1, Total: len(items)}, nil
}

func (p *changingLibraryProvider) Episodes(ctx context.Context, _ model.Item) ([]model.Item, error) {
	p.mu.Lock()
	p.episodeCalls++
	version, gate := p.version, p.oldGate
	p.mu.Unlock()
	if version == 0 && gate != nil {
		select {
		case p.episodeStarted <- struct{}{}:
		default:
		}
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	items := []model.Item{{ID: "episode:2:1:1", Kind: "episode", Name: "Pilot", Season: 1, Episode: 1}}
	if version > 0 {
		items[0].Name = "Updated pilot"
		items = append(items, model.Item{ID: "episode:2:1:2", Kind: "episode", Name: "New episode", Season: 1, Episode: 2})
	} else if gate != nil {
		items = append(items, model.Item{ID: "episode:2:1:3", Kind: "episode", Name: "Previous episode", Season: 1, Episode: 3})
	}
	return items, nil
}

type libraryStatus struct {
	LibraryUpdatedAt time.Time               `json:"libraryUpdatedAt"`
	Refreshing       bool                    `json:"refreshing"`
	Sync             map[string]refreshState `json:"sync"`
}

func readLibraryStatus(t *testing.T, ts *httptest.Server) libraryStatus {
	t.Helper()
	code, body := request(t, ts.URL, "GET", "/api/status", "")
	var status libraryStatus
	if err := json.Unmarshal([]byte(body), &status); err != nil || code != 200 {
		t.Fatalf("status: %d %s %v", code, body, err)
	}
	return status
}

func newChangingLibrary(t *testing.T, ttl time.Duration) (*Server, *httptest.Server, *changingLibraryProvider) {
	t.Helper()
	p := &changingLibraryProvider{fixtureProvider: &fixtureProvider{}, browseStarted: make(chan struct{}, 1), episodeStarted: make(chan struct{}, 1)}
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), CatalogRefresh: 24 * time.Hour, EPGRefresh: 24 * time.Hour, EpisodeCacheTTL: ttl}, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	waitFor(t, func() bool {
		status := readLibraryStatus(t, ts)
		return !status.Refreshing && !status.LibraryUpdatedAt.IsZero()
	})
	return s, ts, p
}

func libraryItems(t *testing.T, ts *httptest.Server, path string, count int) {
	t.Helper()
	code, body := request(t, ts.URL, "GET", path, "")
	var result struct {
		Items []model.Item `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil || code != 200 || len(result.Items) != count {
		t.Fatalf("%s: %d %s %v", path, code, body, err)
	}
}

func refreshLibrary(t *testing.T, ts *httptest.Server) time.Time {
	t.Helper()
	previous := readLibraryStatus(t, ts).LibraryUpdatedAt
	code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`)
	if code != 202 {
		t.Fatal(code, body)
	}
	waitFor(t, func() bool {
		status := readLibraryStatus(t, ts)
		return !status.Refreshing && status.LibraryUpdatedAt.After(previous)
	})
	return readLibraryStatus(t, ts).LibraryUpdatedAt
}

func TestLibraryRefreshExpiresListsAndPreservesPlaybackItems(t *testing.T) {
	s, ts, p := newChangingLibrary(t, time.Hour)
	paths := []string{"/api/browse?kind=series&category=*&page=1", "/api/browse?kind=movie&category=*&page=1", "/api/series/series:2/episodes"}
	for _, path := range paths {
		libraryItems(t, ts, path, 1)
	}
	p.mu.Lock()
	p.version = 1
	p.mu.Unlock()
	for _, path := range paths {
		libraryItems(t, ts, path, 1)
	}
	revision := refreshLibrary(t, ts)
	if _, ok := s.cache.item("episode:2:1:1"); !ok {
		t.Fatal("refresh removed a playback item")
	}
	// Expiry and the revision survive a server restart; item records remain.
	saved, err := openStore(s.cfg.DataDir, s.cfg.PortalURL, s.cfg.MAC)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := saved.browse(model.BrowseQuery{Kind: "series", Category: "*", Page: 1}, 24*time.Hour); err != nil || ok {
		t.Fatal("saved page remained fresh", err)
	}
	if _, ok := saved.getEpisodes("series:2", time.Hour); ok {
		t.Fatal("saved episodes remained fresh")
	}
	if !saved.libraryRevision().Equal(revision) {
		t.Fatal("refresh revision was not saved")
	}
	saved.close()
	for _, path := range paths {
		libraryItems(t, ts, path, 2)
		libraryItems(t, ts, path, 2)
	}
	p.mu.Lock()
	browseCalls, episodeCalls := p.browseCalls, p.episodeCalls
	p.fail = true
	p.mu.Unlock()
	if browseCalls != 4 || episodeCalls != 2 {
		t.Fatal("fresh lists were not cached", browseCalls, episodeCalls)
	}
	request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`)
	waitFor(t, func() bool {
		status := readLibraryStatus(t, ts)
		return !status.Refreshing && status.Sync["catalog"].Error != ""
	})
	if !readLibraryStatus(t, ts).LibraryUpdatedAt.Equal(revision) {
		t.Fatal("failed refresh expired saved lists")
	}
	for _, path := range paths {
		libraryItems(t, ts, path, 2)
	}
}

func TestEpisodeCacheExpiresIndependentlyOfSeriesPages(t *testing.T) {
	for _, tc := range []struct {
		name     string
		ttl      time.Duration
		expected int
	}{{"default_hour", 0, 1}, {"custom_fifteen_minutes", 15 * time.Minute, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			s, ts, p := newChangingLibrary(t, tc.ttl)
			libraryItems(t, ts, "/api/browse?kind=series&category=*&page=1", 1)
			libraryItems(t, ts, "/api/series/series:2/episodes", 1)
			p.mu.Lock()
			p.version = 1
			p.mu.Unlock()
			s.cache.mu.Lock()
			s.cache.episodesAt["series:2"] = time.Now().Add(-30 * time.Minute)
			s.cache.mu.Unlock()
			libraryItems(t, ts, "/api/series/series:2/episodes", tc.expected)
			s.cache.mu.Lock()
			s.cache.episodesAt["series:2"] = time.Now().Add(-90 * time.Minute)
			s.cache.mu.Unlock()
			libraryItems(t, ts, "/api/series/series:2/episodes", 2)
			libraryItems(t, ts, "/api/browse?kind=series&category=*&page=1", 1)
			p.mu.Lock()
			defer p.mu.Unlock()
			if p.browseCalls != 1 {
				t.Fatal("episode expiry refreshed unrelated series pages")
			}
		})
	}
}

func TestRefreshDoesNotJoinOrCacheOlderListRequests(t *testing.T) {
	s, ts, p := newChangingLibrary(t, time.Hour)
	if err := s.cache.setBrowseAtRevision(model.BrowseQuery{Kind: "series", Category: "seed", Page: 1}, model.BrowsePage{Items: []model.Item{{ID: "series:2", Kind: "series"}}}, 24*time.Hour, s.cache.libraryRevision()); err != nil {
		t.Fatal(err)
	}
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	p.mu.Lock()
	p.oldGate = gate
	p.mu.Unlock()
	paths := []string{"/api/browse?kind=series&category=*&page=1", "/api/series/series:2/episodes"}
	oldDone := make(chan struct{}, 2)
	for _, path := range paths {
		go func() { libraryItems(t, ts, path, 2); oldDone <- struct{}{} }()
	}
	for _, started := range []chan struct{}{p.browseStarted, p.episodeStarted} {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("old request did not start")
		}
	}
	p.mu.Lock()
	p.version = 1
	p.mu.Unlock()
	refreshLibrary(t, ts)
	freshDone := make(chan struct{}, 2)
	for _, path := range paths {
		go func() { libraryItems(t, ts, path, 2); freshDone <- struct{}{} }()
	}
	for range paths {
		select {
		case <-freshDone:
		case <-time.After(3 * time.Second):
			t.Fatal("fresh request joined an older fetch")
		}
	}
	release.Do(func() { close(gate) })
	for range paths {
		select {
		case <-oldDone:
		case <-time.After(3 * time.Second):
			t.Fatal("old request did not finish")
		}
	}
	for _, path := range paths {
		libraryItems(t, ts, path, 2)
	}
	for _, id := range []string{"series:2-old", "episode:2:1:3"} {
		code, body := request(t, ts.URL, "GET", "/api/items/"+id, "")
		if code != 200 {
			t.Fatalf("old response title cannot be played: %d %s", code, body)
		}
	}
	for id, name := range map[string]string{"series:2": "Updated title", "episode:2:1:1": "Updated pilot"} {
		item, ok := s.cache.item(id)
		if !ok || item.Name != name {
			t.Fatal("old response replaced newer title details", id, item.Name)
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.browseCalls != 2 || p.episodeCalls != 2 {
		t.Fatal("older fetch overwrote the fresh cache", p.browseCalls, p.episodeCalls)
	}
}
