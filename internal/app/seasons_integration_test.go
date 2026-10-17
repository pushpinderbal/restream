package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type seasonFixture struct {
	fixtureProvider
	seasonMu   sync.Mutex
	navigation int
	newSeason  bool
	gate       <-chan struct{}
	loaded     []int
}

func (p *seasonFixture) Seasons(ctx context.Context, series model.Item) ([]model.Item, error) {
	p.seasonMu.Lock()
	p.navigation++
	gate, newSeason := p.gate, p.newSeason
	p.seasonMu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	items := []model.Item{
		{ID: "season:2:55", Kind: "season", ProviderID: "55", Season: 5, SourceType: "vod"},
		{ID: "season:2:11", Kind: "season", ProviderID: "11", Season: 1, SourceType: "vod"},
	}
	if newSeason {
		items = append(items, model.Item{ID: "season:2:66", Kind: "season", ProviderID: "66", Season: 6})
	}
	return items, nil
}

func (p *seasonFixture) SeasonEpisodes(_ context.Context, series, season model.Item) ([]model.Item, error) {
	p.seasonMu.Lock()
	defer p.seasonMu.Unlock()
	p.loaded = append(p.loaded, season.Season)
	return []model.Item{{ID: "episode:2:" + season.ProviderID + ":1", Kind: "episode", Name: "A named episode", Season: season.Season, Episode: 1, ProviderID: "1", SeriesID: "2", EpisodeID: "1", Command: "private-command"}}, nil
}

func TestSelectedSeasonIsLazySharedAndPersistent(t *testing.T) {
	p := &seasonFixture{}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55", RefreshInterval: time.Hour}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	waitFor(t, func() bool { return !s.cache.libraryRevision().IsZero() })
	status, _ := request(t, ts.URL, "GET", "/api/browse?kind=series&category=7&page=1", "")
	if status != 200 {
		t.Fatal(status)
	}
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, body := request(t, ts.URL, "GET", "/api/series/series:2/episodes?season=first", "")
			var data struct {
				Items   []model.Item `json:"items"`
				Seasons []int        `json:"seasons"`
				Season  int          `json:"season"`
			}
			if json.Unmarshal([]byte(body), &data) != nil || status != 200 || data.Season != 1 || len(data.Items) != 1 || data.Items[0].Name != "A named episode" || len(data.Seasons) != 2 || data.Seasons[0] != 1 || strings.Contains(body, "private-command") || strings.Contains(body, "sourceType") {
				t.Errorf("first season: %d %s", status, body)
			}
		}()
	}
	wg.Wait()
	p.seasonMu.Lock()
	if p.navigation != 1 || len(p.loaded) != 1 || p.loaded[0] != 1 {
		t.Errorf("eager or repeated fetch: navigation=%d seasons=%v", p.navigation, p.loaded)
	}
	p.seasonMu.Unlock()
	status, body := request(t, ts.URL, "GET", "/api/series/series:2/episodes?season=5", "")
	if status != 200 || !strings.Contains(body, `"season":5`) {
		t.Fatal(status, body)
	}
	status, _ = request(t, ts.URL, "GET", "/api/series/series:2/episodes?season=-1", "")
	if status != 400 {
		t.Fatal(status)
	}
	status, _ = request(t, ts.URL, "GET", "/api/series/series:2/episodes?season=2", "")
	if status != 404 {
		t.Fatal(status)
	}
	ts.Close()
	s.Close()
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts = httptest.NewServer(s)
	defer ts.Close()
	status, body = request(t, ts.URL, "GET", "/api/series/series:2/episodes?season=5", "")
	if status != 200 || !strings.Contains(body, "A named episode") {
		t.Fatal(status, body)
	}
	p.seasonMu.Lock()
	defer p.seasonMu.Unlock()
	if p.navigation != 1 || len(p.loaded) != 2 {
		t.Fatalf("persistent cache missed: navigation=%d seasons=%v", p.navigation, p.loaded)
	}
	episode, ok := s.cache.item("episode:2:55:1")
	if !ok || episode.Command != "private-command" || episode.EpisodeID != "1" {
		t.Fatal("playback identity lost")
	}
}

func TestSeasonNavigationAndSelectedEpisodesRevalidateIndependently(t *testing.T) {
	p := &seasonFixture{}
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	t.Cleanup(func() { ts.Close(); s.Close() })
	waitFor(t, func() bool { return !s.cache.libraryRevision().IsZero() })
	libraryItems(t, ts, "/api/browse?kind=series&category=7&page=1", 1)
	path := "/api/series/series:2/episodes?season=1"
	libraryItems(t, ts, path, 1)
	gate := make(chan struct{})
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(gate) }) })
	p.seasonMu.Lock()
	p.newSeason, p.gate = true, gate
	p.seasonMu.Unlock()
	s.cache.mu.Lock()
	s.cache.episodesAt["series:2#seasons"] = time.Now().Add(-31 * time.Minute)
	s.cache.mu.Unlock()
	for range 12 {
		libraryItems(t, ts, path, 1)
	}
	waitFor(t, func() bool { p.seasonMu.Lock(); defer p.seasonMu.Unlock(); return p.navigation == 2 })
	p.seasonMu.Lock()
	if len(p.loaded) != 1 {
		t.Error("navigation check fetched episode lists", p.loaded)
	}
	p.seasonMu.Unlock()
	release.Do(func() { close(gate) })
	waitFor(t, func() bool {
		_, body := request(t, ts.URL, "GET", path, "")
		return strings.Contains(body, `"seasons":[1,5,6]`)
	})
	s.cache.mu.Lock()
	s.cache.episodesAt["series:2#season:season:2:11"] = time.Now().Add(-31 * time.Minute)
	s.cache.mu.Unlock()
	libraryItems(t, ts, path, 1)
	waitFor(t, func() bool { p.seasonMu.Lock(); defer p.seasonMu.Unlock(); return len(p.loaded) == 2 })
	for range 12 {
		libraryItems(t, ts, path, 1)
	}
	p.seasonMu.Lock()
	defer p.seasonMu.Unlock()
	if p.navigation != 2 || len(p.loaded) != 2 || p.loaded[0] != 1 || p.loaded[1] != 1 {
		t.Fatal("cooldowns repeated work or eagerly loaded other seasons", p.navigation, p.loaded)
	}
}
