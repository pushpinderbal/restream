package app

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type stagedDiscoveryProvider struct {
	fixtureProvider
	browse func(context.Context, model.BrowseQuery) (model.BrowsePage, error)
	calls  atomic.Int32
}

func (p *stagedDiscoveryProvider) Browse(ctx context.Context, query model.BrowseQuery) (model.BrowsePage, error) {
	p.calls.Add(1)
	return p.browse(ctx, query)
}

func stagedMetadata(s *Server, movies []tmdbTitle) *atomic.Int32 {
	calls := &atomic.Int32{}
	s.discoveryService.client.Transport = discoveryTransport(func(req *http.Request) (*http.Response, error) {
		calls.Add(1)
		titles := []tmdbTitle{}
		if req.URL.Path != "/3/trending/tv/week" {
			titles = movies
		}
		data, _ := json.Marshal(map[string]any{"results": titles})
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})
	return calls
}

func TestDiscoveryGlobalSearchFiltersHomeCategoriesAndRechecksOldMiss(t *testing.T) {
	allowed := model.Item{ID: "series:allowed", Kind: "series", Name: "New Show", Year: 2025, CategoryID: "1"}
	excluded := model.Item{ID: "series:excluded", Kind: "series", Name: "New Show", Year: 2025, CategoryID: "2"}
	queries := make(chan model.BrowseQuery, 8)
	p := &stagedDiscoveryProvider{browse: func(_ context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
		queries <- q
		page := model.BrowsePage{Items: []model.Item{}, Page: 1}
		if q.Search == "New Show" {
			page.Items = []model.Item{excluded, allowed}
			page.Total = len(page.Items)
		}
		return page, nil
	}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	if err := s.cache.setCategories([]model.Category{
		{ID: "1", Kind: "series", Name: "Home shows", SourceType: "vod"},
		{ID: "2", Kind: "series", Name: "Other shows", SourceType: "vod"},
	}); err != nil {
		t.Fatal(err)
	}
	deployTestConfiguration(t, s, 21600, CategoryPreference{Kind: "series", ID: "2", Visibility: "show", Dashboard: false})
	s.discoveryService.client.Transport = discoveryTransport(func(*http.Request) (*http.Response, error) {
		t.Error("fresh metadata should have been reused")
		return nil, nil
	})
	title := tmdbTitle{ID: 123, Name: "New Show", FirstAirDate: "2025-01-01"}
	policy := s.preferencesSnapshot().updatedAt
	s.discoveryService.mu.Lock()
	s.discoveryService.record = discoveryRecord{
		Version: 1, Revision: s.cache.libraryRevision(), PreferencesUpdatedAt: policy,
		HadMetadata: true, UpdatedAt: time.Now().Add(-time.Hour), NextAttempt: time.Now().Add(time.Hour),
		Metadata: map[string]discoveryMetadata{"series": {Titles: []tmdbTitle{title}, FetchedAt: time.Now()}},
		Matches: map[string]discoveryMatch{discoveryMatchKey("series", title.ID): {
			CheckedAt: time.Now(), Revision: s.cache.libraryRevision(), Policy: policy,
		}},
	}
	s.discoveryService.mu.Unlock()

	result := waitDiscovery(t, ts)
	if len(result.TrendingSeries) != 1 || result.TrendingSeries[0].Item.ID != allowed.ID {
		t.Fatal("provider-wide match escaped Home policy or old miss was reused", result.TrendingSeries)
	}
	searches := 0
	for len(queries) > 0 {
		q := <-queries
		if q.Search == "" {
			if q.Category != "1" {
				t.Fatal("unfiltered discovery fetched an excluded category", q)
			}
			continue
		}
		searches++
		if q.Category != "*" || q.Kind != "series" || q.SourceType != "vod" || q.Search != title.name() {
			t.Fatal("search was not provider-wide", q)
		}
	}
	if searches != 1 {
		t.Fatal("expected one provider-wide search", searches)
	}
	readDiscovery(t, ts)
	if len(queries) != 0 {
		t.Fatal("saved discovery searched again before its refresh deadline")
	}
}

func TestDiscoveryPublishesMatchesBeforeSlowSearchAndResumesAfterRestart(t *testing.T) {
	first := model.Item{ID: "movie:first", Kind: "movie", Name: "First film", Year: 2025}
	second := model.Item{ID: "movie:second", Kind: "movie", Name: "Second film", Year: 2025}
	gate := make(chan struct{})
	var waiting atomic.Bool
	p := &stagedDiscoveryProvider{browse: func(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
		page := model.BrowsePage{Page: 1, Items: []model.Item{}}
		if q.Search == first.Name {
			page.Items = []model.Item{first}
		}
		if q.Search == second.Name {
			waiting.Store(true)
			select {
			case <-gate:
				page.Items = []model.Item{second}
			case <-ctx.Done():
				return page, ctx.Err()
			}
		}
		return page, nil
	}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	movies := []tmdbTitle{{ID: 1, Title: first.Name, ReleaseDate: "2025-01-01"}, {ID: 2, Title: second.Name, ReleaseDate: "2025-01-01"}}
	stagedMetadata(s, movies)
	readDiscovery(t, ts)
	waitFor(t, waiting.Load)
	partial := readDiscovery(t, ts)
	if !partial.Refreshing || len(partial.TrendingMovies) != 1 || partial.TrendingMovies[0].Item.ID != first.ID {
		t.Fatal("first confirmed title waited for the slow search", partial)
	}
	before := p.calls.Load()
	for i := 0; i < 8; i++ {
		readDiscovery(t, ts)
	}
	if p.calls.Load() != before {
		t.Fatal("users started duplicate refreshes")
	}
	// Cancellation leaves the partial snapshot and independent metadata cache
	// persisted, with an unfinished deadline that can resume after a restart.
	ts.Close()
	s.Close()
	close(gate)
	resumed, resumedTS := discoveryTestServer(t, s.cfg, p)
	metadataCalls := stagedMetadata(resumed, movies)
	restored := readDiscovery(t, resumedTS)
	if len(restored.TrendingMovies) == 0 || restored.TrendingMovies[0].Item.ID != first.ID {
		t.Fatal("restart lost the partial rail", restored)
	}
	complete := waitDiscovery(t, resumedTS)
	if len(complete.TrendingMovies) != 2 || metadataCalls.Load() != 1 {
		t.Fatal("restart repeated cached movie metadata or lost matches", complete, metadataCalls.Load())
	}
}

func TestDiscoveryKeepsCachedRailAndArtworkUntilRemovalIsConfirmed(t *testing.T) {
	film := model.Item{ID: "movie:film", Kind: "movie", Name: "Known film", Year: 2025}
	var removed, held, incomplete atomic.Bool
	gate := make(chan struct{})
	p := &stagedDiscoveryProvider{browse: func(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
		if held.Load() {
			select {
			case <-gate:
			case <-ctx.Done():
				return model.BrowsePage{}, ctx.Err()
			}
		}
		page := model.BrowsePage{Page: 1, Items: []model.Item{}, HasMore: incomplete.Load()}
		if q.Kind == "movie" && !removed.Load() {
			page.Items = []model.Item{film}
		}
		return page, nil
	}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	metadata := stagedMetadata(s, []tmdbTitle{{ID: 1, Title: film.Name, ReleaseDate: "2025-01-01", Poster: "/poster.jpg"}})
	s.artwork.client.Transport = discoveryTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader("GIF89a"))}, nil
	})
	warm := waitDiscovery(t, ts)
	poster := warm.TrendingMovies[0].Poster
	removed.Store(true)
	held.Store(true)
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	stale := readDiscovery(t, ts)
	if !stale.Refreshing || len(stale.TrendingMovies) != 1 {
		t.Fatal("refresh blanked the saved rail", stale)
	}
	if image := getArtwork(t, ts.URL+poster); image.status != 200 {
		t.Fatal("saved artwork disappeared during refresh", image.status)
	}
	// The superseded builder must not publish into this newer revision.
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	incomplete.Store(true)
	held.Store(false)
	close(gate)
	waitFor(t, func() bool {
		s.discoveryService.mu.Lock()
		defer s.discoveryService.mu.Unlock()
		return !s.discoveryService.refreshing
	})
	uncertain := waitDiscovery(t, ts)
	if len(uncertain.TrendingMovies) != 1 {
		t.Fatal("incomplete search falsely removed a saved title", uncertain)
	}
	incomplete.Store(false)
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	complete := waitDiscovery(t, ts)
	if len(complete.TrendingMovies) != 0 {
		t.Fatal("confirmed removal stayed on Trending", complete)
	}
	if _, exists := s.cache.item(film.ID); !exists {
		t.Fatal("availability check deleted a playback record")
	}
	if image := getArtwork(t, ts.URL+poster); image.status != 404 {
		t.Fatal("removed title retained a discovery asset", image.status)
	}
	if metadata.Load() != 2 {
		t.Fatal("library refresh unnecessarily refetched TMDB", metadata.Load())
	}
}

func TestDiscoveryPersistsIdentityAndMissesWithoutRescanningPagesOnReads(t *testing.T) {
	film := model.Item{ID: "movie:identity", Kind: "movie", Name: "Unique title"}
	p := &discoveryFixtureProvider{items: []model.Item{film}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	metadata := stagedMetadata(s, []tmdbTitle{{ID: 1, Title: film.Name}, {ID: 2, Title: "Missing title"}})
	if result := waitDiscovery(t, ts); len(result.TrendingMovies) != 1 {
		t.Fatal("identity fixture did not match", result)
	}
	initialCalls := metadata.Load()
	if err := s.cache.invalidateLibrary(); err != nil {
		t.Fatal(err)
	}
	if result := waitDiscovery(t, ts); len(result.TrendingMovies) != 1 || metadata.Load() != initialCalls {
		t.Fatal("confirmed identity or raw trends were fetched again", result, metadata.Load())
	}
	// A forced recheck of the same revision reuses both positive identity and
	// ambiguous/absent outcomes, including the expensive no-year TMDB lookup.
	s.discoveryService.mu.Lock()
	s.discoveryService.record.NextAttempt = time.Time{}
	s.discoveryService.mu.Unlock()
	waitDiscovery(t, ts)
	if metadata.Load() != initialCalls {
		t.Fatal("known identity was re-resolved")
	}
	// A broken, unrelated browse page must not break a saved Trending read.
	if _, err := s.cache.db.Exec(`UPDATE pages SET data='invalid page'`); err != nil {
		t.Fatal(err)
	}
	before := p.calls.Load()
	for i := 0; i < 8; i++ {
		if result := readDiscovery(t, ts); len(result.TrendingMovies) != 1 {
			t.Fatal("saved read rescanned browse pages", result)
		}
	}
	if p.calls.Load() != before {
		t.Fatal("warm reads reached the provider")
	}
	restored, restoredTS := discoveryTestServer(t, s.cfg, p)
	restoredMetadata := stagedMetadata(restored, nil)
	result := readDiscovery(t, restoredTS)
	if result.Refreshing || len(result.TrendingMovies) != 1 || restoredMetadata.Load() != 0 {
		t.Fatal("warm snapshot did not survive restart", result)
	}
}

func TestDiscoveryKeepsPreviousRailWhenTrendingMembershipChanges(t *testing.T) {
	oldFilm := model.Item{ID: "movie:old", Kind: "movie", Name: "Previous trend", Year: 2025}
	newFilm := model.Item{ID: "movie:new", Kind: "movie", Name: "New trend", Year: 2025}
	var updated, waiting atomic.Bool
	gate := make(chan struct{})
	p := &stagedDiscoveryProvider{browse: func(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
		page := model.BrowsePage{Page: 1, Items: []model.Item{}}
		if q.Kind == "movie" && q.Search == "" {
			page.Items = []model.Item{oldFilm}
		}
		if q.Search == newFilm.Name {
			waiting.Store(true)
			select {
			case <-gate:
				page.Items = []model.Item{newFilm}
			case <-ctx.Done():
				return page, ctx.Err()
			}
		}
		return page, nil
	}}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, p)
	s.discoveryService.client.Transport = discoveryTransport(func(req *http.Request) (*http.Response, error) {
		movies := []tmdbTitle{}
		if req.URL.Path == "/3/trending/movie/week" {
			film, id := oldFilm, 1
			if updated.Load() {
				film, id = newFilm, 2
			}
			movies = []tmdbTitle{{ID: id, Title: film.Name, ReleaseDate: "2025-01-01"}}
		}
		data, _ := json.Marshal(map[string]any{"results": movies})
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(data)))}, nil
	})
	warm := waitDiscovery(t, ts)
	if len(warm.TrendingMovies) != 1 {
		t.Fatal("initial trend missing", warm)
	}
	updated.Store(true)
	s.discoveryService.mu.Lock()
	metadata := s.discoveryService.record.Metadata["movie"]
	metadata.FetchedAt = time.Now().Add(-25 * time.Hour)
	s.discoveryService.record.Metadata["movie"] = metadata
	s.discoveryService.mu.Unlock()
	if err := s.cache.publishLibrary(); err != nil {
		t.Fatal(err)
	}
	readDiscovery(t, ts)
	waitFor(t, waiting.Load)
	partial := readDiscovery(t, ts)
	if !partial.Refreshing || len(partial.TrendingMovies) != 1 || partial.TrendingMovies[0].Item.ID != oldFilm.ID {
		t.Fatal("new metadata blanked the rail before matching completed", partial)
	}
	close(gate)
	complete := waitDiscovery(t, ts)
	if len(complete.TrendingMovies) != 1 || complete.TrendingMovies[0].Item.ID != newFilm.ID {
		t.Fatal("new membership did not replace the old rail", complete)
	}
	s.discoveryService.mu.Lock()
	_, oldLinkRetained := s.discoveryService.record.Matches[discoveryMatchKey("movie", 1)]
	s.discoveryService.mu.Unlock()
	if !oldLinkRetained {
		t.Fatal("a title leaving Trending erased its confirmed identity")
	}
}

func TestDiscoveryRecognizesCleanedProviderNamesWithoutAcceptingReusedIDs(t *testing.T) {
	film := model.Item{ID: "movie:renamed", Kind: "movie", Name: "Known film (2025) HD - Drama", Category: "Drama"}
	s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-token"}, &discoveryFixtureProvider{items: []model.Item{film}})
	stagedMetadata(s, []tmdbTitle{{ID: 1, Title: "Known film", ReleaseDate: "2025-01-01"}})
	if warm := waitDiscovery(t, ts); len(warm.TrendingMovies) != 1 {
		t.Fatal("initial title was not matched", warm)
	}
	film.Name, film.Year = "Known film", 2025
	query := model.BrowseQuery{Kind: "movie", Category: "*", Page: 1}
	if err := seedBrowsePage(s.cache, query, model.BrowsePage{Page: 1, Items: []model.Item{film}}); err != nil {
		t.Fatal(err)
	}
	if saved := readDiscovery(t, ts); len(saved.TrendingMovies) != 1 {
		t.Fatal("provider formatting change hid the confirmed title", saved)
	}
	film.Name = "Another film"
	if err := seedBrowsePage(s.cache, query, model.BrowsePage{Page: 1, Items: []model.Item{film}}); err != nil {
		t.Fatal(err)
	}
	if changed := readDiscovery(t, ts); len(changed.TrendingMovies) != 0 {
		t.Fatal("reused provider identity showed the wrong title", changed)
	}
}
