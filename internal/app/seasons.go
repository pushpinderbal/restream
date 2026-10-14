package app

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

// loadEpisodeList shares provider work and keeps navigation and each season in
// separate persistent cache entries. A disconnected browser can stop waiting.
func (s *Server) loadEpisodeList(r *http.Request, series model.Item, key string, revision time.Time, load func(context.Context) ([]model.Item, error)) ([]model.Item, error) {
	if items, ok := s.cache.getEpisodes(key, s.cfg.EpisodeCacheTTL); ok {
		return items, nil
	}
	result := s.episodeFlights.DoChan(key+"\x00"+revision.Format(time.RFC3339Nano), func() (any, error) {
		s.browseMu.Lock()
		if s.browseClosed {
			s.browseMu.Unlock()
			return nil, context.Canceled
		}
		s.browseWG.Add(1)
		s.browseMu.Unlock()
		defer s.browseWG.Done()
		if items, ok := s.cache.getEpisodes(key, s.cfg.EpisodeCacheTTL); ok {
			return items, nil
		}
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
		defer cancel()
		started := time.Now()
		items, err := load(ctx)
		if err != nil {
			if s.ctx.Err() == nil {
				slog.Warn("Episode load failed", "seriesID", safeEpisodeLogID(series.ID), "stage", "provider", "reason", episodeFailureReason(err), "elapsed", time.Since(started).Round(time.Millisecond))
			}
			return nil, err
		}
		if err = s.cache.setEpisodeListAtRevision(series.ID, key, items, revision); err != nil {
			return nil, err
		}
		return items, nil
	})
	select {
	case <-r.Context().Done():
		return nil, r.Context().Err()
	case loaded := <-result:
		if loaded.Err != nil {
			return nil, loaded.Err
		}
		return loaded.Val.([]model.Item), nil
	}
}

func (s *Server) seasonEpisodes(w http.ResponseWriter, r *http.Request, series model.Item) {
	requested := r.URL.Query().Get("season")
	number, err := strconv.Atoi(requested)
	if requested != "first" && (err != nil || number < 0) {
		fail(w, 400, "invalid", "Choose a valid season.")
		return
	}
	revision := s.cache.libraryRevision()
	// Reuse a fresh complete list from an older browser or provider when possible.
	rows, complete := s.cache.getEpisodes(series.ID, s.cfg.EpisodeCacheTTL)
	provider, supportsSeasons := s.provider.(model.SeasonProvider)
	if !complete {
		key := series.ID
		load := func(ctx context.Context) ([]model.Item, error) { return s.provider.Episodes(ctx, series) }
		if supportsSeasons {
			key += "#seasons"
			load = func(ctx context.Context) ([]model.Item, error) { return provider.Seasons(ctx, series) }
		}
		rows, err = s.loadEpisodeList(r, series, key, revision, load)
		if err != nil {
			seasonFailure(w, err)
			return
		}
	}
	set := map[int]bool{}
	for _, row := range rows {
		value := row.Season
		if value == 0 && row.Kind != "season" {
			value = 1
		}
		set[value] = true
	}
	seasons := make([]int, 0, len(set))
	for value := range set {
		seasons = append(seasons, value)
	}
	sort.Ints(seasons)
	if requested == "first" && len(seasons) > 0 {
		number = seasons[0]
	}
	if len(seasons) > 0 && !set[number] {
		fail(w, 404, "not_found", "Season not found.")
		return
	}
	items := make([]model.Item, 0)
	for _, row := range rows {
		value := row.Season
		if value == 0 && row.Kind != "season" {
			value = 1
		}
		if value != number {
			continue
		}
		if row.Kind == "season" && supportsSeasons {
			key := series.ID + "#season:" + row.ID
			items, err = s.loadEpisodeList(r, series, key, revision, func(ctx context.Context) ([]model.Item, error) {
				return provider.SeasonEpisodes(ctx, series, row)
			})
			if err != nil {
				seasonFailure(w, err)
				return
			}
			break
		}
		items = append(items, row)
	}
	items = append([]model.Item{}, items...)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Episode == 0 || items[j].Episode == 0 {
			return items[i].Episode > items[j].Episode
		}
		return items[i].Episode < items[j].Episode
	})
	respond(w, 200, map[string]any{"items": publicItems(items), "seasons": seasons, "season": number})
}

func seasonFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, errSeriesRemoved) {
		fail(w, 404, "not_found", "Series not found.")
		return
	}
	fail(w, 502, "upstream", "Could not load this season. Try again.")
}
