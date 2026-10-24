package app

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func (s *Server) providerCoolingDown(w http.ResponseWriter) bool {
	s.cache.mu.RLock()
	until := s.cache.portalCooldownUntil
	s.cache.mu.RUnlock()
	if !until.After(time.Now()) {
		return false
	}
	w.Header().Set("Retry-After", strconv.Itoa(max(1, int(time.Until(until).Seconds())+1)))
	fail(w, http.StatusTooManyRequests, "cooldown", "The provider is cooling down. Try again after the waiting period.")
	return true
}

func (s *Server) retryBrowse(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.provider.(model.BrowseProvider); !ok {
		fail(w, 503, "unconfigured", "Connect your provider in Settings first.")
		return
	}
	var input struct {
		Kind     string `json:"kind"`
		Category string `json:"category"`
		Search   string `json:"search"`
		Page     int    `json:"page"`
		Through  *int   `json:"through"`
	}
	if !decode(w, r, &input) {
		return
	}
	values := url.Values{"kind": {input.Kind}, "category": {input.Category}, "search": {input.Search}, "page": {strconv.Itoa(input.Page)}}
	if input.Through != nil {
		values.Set("through", strconv.Itoa(*input.Through))
	}
	parsed := r.Clone(r.Context())
	copiedURL := *r.URL
	parsed.URL = &copiedURL
	parsed.URL.RawQuery = values.Encode()
	q, through, ok := s.parseBrowseQuery(w, parsed)
	if !ok {
		return
	}
	if !s.browseCategoryAllowed(q.Kind, q.Category) {
		blocked(w)
		return
	}
	if s.providerCoolingDown(w) {
		return
	}
	keys := make([]string, 0, through-q.Page+1)
	for page := q.Page; page <= through; page++ {
		current := q
		current.Page = page
		keys = append(keys, pageKey(current))
	}
	if err := s.cache.resetCacheRetries(keys); err != nil {
		fail(w, 500, "cache", "Could not prepare this retry.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) retryEpisodes(w http.ResponseWriter, r *http.Request) {
	if s.provider == nil {
		fail(w, 503, "unconfigured", "Connect your provider in Settings first.")
		return
	}
	series, ok := s.cache.item(r.PathValue("id"))
	if !ok || series.Kind != "series" {
		fail(w, 404, "not_found", "Series not found.")
		return
	}
	if s.blockedItem(series) {
		blocked(w)
		return
	}
	var input struct {
		Season json.RawMessage `json:"season"`
	}
	if !decode(w, r, &input) {
		return
	}
	keys := []string{"episodes:" + series.ID}
	if len(input.Season) > 0 {
		first := string(input.Season) == `"first"`
		var number int
		if !first && (json.Unmarshal(input.Season, &number) != nil || number < 0 || string(input.Season) == "null") {
			fail(w, 400, "invalid", "Choose a valid season.")
			return
		}
		if _, supported := s.provider.(model.SeasonProvider); supported {
			nav := series.ID + "#seasons"
			keys = []string{"episodes:" + nav}
			rows, _, _ := s.cache.episodeSnapshot(nav, 0)
			sort.SliceStable(rows, func(i, j int) bool { return rows[i].Season < rows[j].Season })
			for _, row := range rows {
				if row.Kind == "season" && (first || row.Season == number) {
					keys = append(keys, "episodes:"+series.ID+"#season:"+row.ID)
					break
				}
			}
		}
	}
	if s.providerCoolingDown(w) {
		return
	}
	if err := s.cache.resetCacheRetries(keys); err != nil {
		fail(w, 500, "cache", "Could not prepare this retry.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// A retry grants only the requested operation a new recovery episode. Saved
// pages and episodes remain visible throughout it.
func (s *store) resetCacheRetries(keys []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, key := range keys {
		if _, err = tx.Exec(`DELETE FROM cache_retries WHERE entry=?`, key); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for _, key := range keys {
		delete(s.retryFallback, key)
	}
	return nil
}
