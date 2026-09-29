package app

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

type failingEpisodeProvider struct {
	fixtureProvider
	calls   atomic.Int32
	healthy atomic.Bool
}

func (p *failingEpisodeProvider) Episodes(_ context.Context, _ model.Item) ([]model.Item, error) {
	p.calls.Add(1)
	if p.healthy.Load() {
		return []model.Item{{ID: "episode:229631:1:1", Kind: "episode", Name: "Pilot", Command: "private-playback"}}, nil
	}
	return nil, errors.New("portal list incomplete: received 135 distinct items and 135 counted rows of 136; token=private-token http://private.invalid")
}

func TestEpisodeFailureLoggedOnceWithoutPrivateDetails(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	p := &failingEpisodeProvider{}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55", CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	q := model.BrowseQuery{Kind: "series", Category: "*", Page: 1}
	if err := s.cache.setBrowse(q, model.BrowsePage{Items: []model.Item{{ID: "series:229631", Kind: "series", Name: "Cached series", ProviderID: "229631"}}, Page: 1}, time.Hour); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	status, body := request(t, ts.URL, "GET", "/api/series/series:229631/episodes", "")
	if status != 502 || strings.Contains(body, "private-token") {
		t.Fatalf("episode response: %d %s", status, body)
	}
	text := logs.String()
	if strings.Count(text, "Episode load failed") != 1 || !strings.Contains(text, "seriesID=series:229631") || !strings.Contains(text, "stage=provider") || !strings.Contains(text, "reason=list_incomplete") {
		t.Fatal("missing sanitized episode failure log", text)
	}
	if strings.Contains(text, "private-token") || strings.Contains(text, "private.invalid") {
		t.Fatal("private provider error leaked into log")
	}
	p.healthy.Store(true)
	status, body = request(t, ts.URL, "GET", "/api/series/series:229631/episodes", "")
	if status != 200 || !strings.Contains(body, "Pilot") || strings.Contains(body, "private-playback") || p.calls.Load() != 2 {
		t.Fatal("episode retry did not save public result", status, body, p.calls.Load())
	}
	status, _ = request(t, ts.URL, "GET", "/api/series/series:229631/episodes", "")
	if status != 200 || p.calls.Load() != 2 {
		t.Fatal("episode success was not cached", status, p.calls.Load())
	}
}

func TestCachedEpisodePlaybackRetainsProviderIdentityAfterRestart(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{DataDir: dataDir, WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55", MaxStreams: 1, CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	cache, err := openStore(dataDir, cfg.PortalURL, cfg.MAC)
	if err != nil {
		t.Fatal(err)
	}
	series := model.Item{ID: "series:229631", Kind: "series", Name: "Show", ProviderID: "229631"}
	if err := cache.setBrowse(model.BrowseQuery{Kind: "series", Category: "*", Page: 1}, model.BrowsePage{Page: 1, Items: []model.Item{series}}, time.Hour); err != nil {
		t.Fatal(err)
	}
	episode := model.Item{ID: "episode:229631:16659:730024", Kind: "episode", Name: "Pilot", Season: 1, Episode: 1, ProviderID: "730024", SeriesID: "229631", EpisodeID: "730024"}
	if err := cache.setEpisodes(series.ID, []model.Item{episode}); err != nil {
		t.Fatal(err)
	}
	if err := cache.close(); err != nil {
		t.Fatal(err)
	}
	resolved := make(chan model.Item, 1)
	manager, err := stream.New(stream.Config{MaxStreams: 1, DataDir: dataDir}, func(_ context.Context, selected model.Item) (model.Source, error) {
		resolved <- selected
		return model.Source{}, errors.New("stop before media fetch")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	s, err := New(cfg, &fixtureProvider{}, manager)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	status, body := request(t, ts.URL, "GET", "/api/series/series:229631/episodes", "")
	if status != 200 || !strings.Contains(body, episode.ID) || strings.Contains(body, "providerId") || strings.Contains(body, "seriesId") || strings.Contains(body, "episodeId") {
		t.Fatal("episode API lost ID or leaked provider fields", status, body)
	}
	status, body = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"episode:229631:16659:730024"}`)
	if status != 201 {
		t.Fatal("cached episode playback was not admitted", status, body)
	}
	select {
	case selected := <-resolved:
		if selected.ID != episode.ID || selected.ProviderID != episode.ProviderID || selected.SeriesID != episode.SeriesID || selected.EpisodeID != episode.EpisodeID || selected.Command != "" {
			t.Fatalf("resolver got wrong cached episode: %+v", selected)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cached episode never reached resolver")
	}
}
