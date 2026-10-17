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

// Navigation and each selected season have independent shared cooldowns.
func (s *Server) loadEpisodeList(r *http.Request, series model.Item, key string, revision time.Time, load func(context.Context) ([]model.Item, error)) ([]model.Item, cacheStatus, error) {
	items, cached, fresh := s.cache.episodeSnapshot(key, s.episodeTTL())
	if fresh {
		return items, cacheStatus{}, nil
	}
	status := cacheStatus{Stale: true}
	entry := "episodes:" + key
	eligible, err := s.cacheEligible(entry)
	if err != nil {
		return items, status, err
	}
	if !eligible {
		if cached {
			return items, status, nil
		}
		return nil, status, errCacheRetry
	}
	result := s.cacheFlight(&s.episodeFlights, entry+"\x00"+revision.Format(time.RFC3339Nano), func() (any, error) {
		if saved, fresh := s.cache.getEpisodes(key, s.episodeTTL()); fresh {
			return saved, nil
		}
		eligible, err := s.cacheEligible(entry)
		if err != nil {
			return nil, err
		}
		if !eligible {
			return nil, errCacheRetry
		}
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
		defer cancel()
		started := time.Now()
		loaded, err := load(ctx)
		if err != nil {
			if s.ctx.Err() == nil {
				slog.Warn("Episode load failed", "seriesID", safeEpisodeLogID(series.ID), "stage", "provider", "reason", episodeFailureReason(err), "elapsed", time.Since(started).Round(time.Millisecond))
			}
			if saveErr := s.cache.cacheFailed(entry, err); saveErr != nil {
				return nil, saveErr
			}
			return nil, err
		}
		if err = s.cache.setEpisodeListAtRevision(series.ID, key, loaded, revision); err != nil {
			return nil, err
		}
		if _, err = s.cache.db.Exec(`DELETE FROM cache_retries WHERE entry=?`, entry); err != nil {
			return nil, err
		}
		return loaded, nil
	})
	if cached {
		status.Refreshing = true
		return items, status, nil
	}
	value, err := waitCache(r.Context(), result)
	if err != nil {
		return nil, status, err
	}
	return value.([]model.Item), cacheStatus{}, nil
}

func (s *Server) seasonEpisodes(w http.ResponseWriter, r *http.Request, series model.Item) {
	requested := r.URL.Query().Get("season")
	number, err := strconv.Atoi(requested)
	if requested != "first" && (err != nil || number < 0) {
		fail(w, 400, "invalid", "Choose a valid season.")
		return
	}
	revision := s.cache.cacheRevision()
	provider, supportsSeasons := s.provider.(model.SeasonProvider)
	key := series.ID
	load := func(ctx context.Context) ([]model.Item, error) { return s.provider.Episodes(ctx, series) }
	if supportsSeasons {
		key += "#seasons"
		load = func(ctx context.Context) ([]model.Item, error) { return provider.Seasons(ctx, series) }
	}
	rows, status, err := s.loadEpisodeList(r, series, key, revision, load)
	if err != nil {
		seasonFailure(w, err)
		return
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
			var episodeStatus cacheStatus
			items, episodeStatus, err = s.loadEpisodeList(r, series, key, revision, func(ctx context.Context) ([]model.Item, error) {
				return provider.SeasonEpisodes(ctx, series, row)
			})
			status.Stale = status.Stale || episodeStatus.Stale
			status.Refreshing = status.Refreshing || episodeStatus.Refreshing
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
	if s.blockedItem(series) {
		blocked(w)
		return
	}
	respond(w, 200, map[string]any{"items": publicItems(items), "seasons": seasons, "season": number, "refreshing": status.Refreshing, "stale": status.Stale})
}

func seasonFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, errSeriesRemoved) {
		fail(w, 404, "not_found", "Series not found.")
		return
	}
	fail(w, 502, "upstream", "Could not load this season. Try again.")
}
