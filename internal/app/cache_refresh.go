package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"golang.org/x/sync/singleflight"
)

var errCacheChanged = errors.New("listing changed during refresh")
var errCacheRetry = errors.New("cached request is cooling down")

type cacheStatus struct {
	Stale               bool
	Refreshing          bool
	RefreshAfterSeconds int
	RetryStopped        bool
	RefreshError        string
}

func listingKey(q model.BrowseQuery) string {
	b, _ := json.Marshal([]string{q.Kind, q.Category, q.Search})
	return string(b)
}
func pageKey(q model.BrowseQuery) string {
	key := "page:" + listingKey(q) + ":" + strconv.Itoa(q.Page)
	if q.Kind == "series" && q.SourceType != "" {
		key += ":" + q.SourceType
	}
	return key
}

// Caller holds mu. Browsing and cache writes must use the same source identity.
func (s *store) browseSourceTypeLocked(q model.BrowseQuery) string {
	if q.Kind == "series" {
		for _, category := range s.categories {
			if category.Kind == "series" && (q.Category == "*" || q.Category == category.ID) {
				return category.SourceType
			}
		}
	}
	return ""
}

func (s *store) listingRevision(q model.BrowseQuery) (int64, error) {
	var revision int64
	err := s.db.QueryRow(`SELECT revision FROM listing_revisions WHERE listing=?`, listingKey(q)).Scan(&revision)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return revision, err
}

// Page content remains available after expiry. Freshness only controls provider work.
func (s *store) browseSnapshot(q model.BrowseQuery, ttl time.Duration) (model.BrowsePage, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok, err := s.browse(q, 0)
	if err != nil {
		return p, ok, err
	}
	p.Revision, err = s.listingRevision(q)
	if err != nil || !ok {
		return p, ok, err
	}
	var at int64
	err = s.db.QueryRow(`SELECT fetched_at FROM pages WHERE kind=? AND category=? AND search=? AND page=?`, q.Kind, q.Category, q.Search, q.Page).Scan(&at)
	p.Stale = at == 0 || time.Since(time.Unix(0, at)) >= ttl
	return p, true, err
}

func samePageStructure(a, b model.BrowsePage) bool {
	if a.Total != b.Total || a.HasMore != b.HasMore || len(a.Items) != len(b.Items) {
		return false
	}
	for i := range a.Items {
		if a.Items[i].ID != b.Items[i].ID {
			return false
		}
	}
	return true
}

func (s *store) setBrowsePage(q model.BrowseQuery, p model.BrowsePage, library time.Time, generation int64) error {
	b, err := encodePage(p)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.listingRevision(q)
	if err != nil {
		return err
	}
	if library.Before(s.libraryInvalidatedAt) || current != generation || q.SourceType != "" && q.SourceType != s.browseSourceTypeLocked(q) {
		return errCacheChanged
	}
	old, exists, err := s.browse(q, 0)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if exists && !samePageStructure(old, p) {
		generation++
		if _, err = tx.Exec(`UPDATE pages SET fetched_at=0 WHERE kind=? AND category=? AND search=? AND page>?`, q.Kind, q.Category, q.Search, q.Page); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO listing_revisions(listing,revision) VALUES(?,?) ON CONFLICT(listing) DO UPDATE SET revision=excluded.revision`, listingKey(q), generation); err != nil {
		return err
	}
	for _, item := range p.Items {
		if err = insertItem(tx, item); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO pages(kind,category,search,page,data,fetched_at)VALUES(?,?,?,?,?,?) ON CONFLICT(kind,category,search,page)DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at`, q.Kind, q.Category, q.Search, q.Page, b, time.Now().UnixNano()); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM cache_retries WHERE entry=?`, pageKey(q)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	delete(s.retryFallback, pageKey(q))
	delete(s.activeCacheAttempts, pageKey(q))
	for _, item := range p.Items {
		s.byID[item.ID] = item
	}
	return nil
}

type cacheRetryState struct {
	failures int
	attempts int
	next     time.Time
	paused   bool
	started  time.Time
	active   bool
}

func (s *store) cacheRetry(key string) (cacheRetryState, error) {
	s.mu.RLock()
	fallback, found := s.retryFallback[key]
	active := s.activeCacheAttempts[key]
	s.mu.RUnlock()
	if found {
		fallback.active = active
		return fallback, nil
	}
	var state cacheRetryState
	var at, started int64
	err := s.db.QueryRow(`SELECT failures,retry_at,paused,started_at,attempts FROM cache_retries WHERE entry=?`, key).Scan(&state.failures, &at, &state.paused, &started, &state.attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return state, nil
	}
	state.active = active
	state.next = time.Unix(0, at)
	if started > 0 {
		state.started = time.Unix(0, started)
	}
	return state, err
}
func (s *store) cacheFailed(key string, failure error) error {
	defer func() { s.mu.Lock(); delete(s.activeCacheAttempts, key); s.mu.Unlock() }()
	if errors.Is(failure, context.Canceled) {
		return nil
	}
	if errors.Is(failure, errCacheChanged) || errors.Is(failure, errCacheRetry) || errors.Is(failure, errSeriesRemoved) {
		return nil
	}
	state, err := s.cacheRetry(key)
	if err != nil {
		return err
	}
	if state.started.IsZero() {
		state.started = time.Now()
	}
	state.failures++
	state.attempts = max(state.attempts, state.failures)
	state.next = time.Now().Add(retryCooldown(failure, state.failures))
	state.paused = retryPaused(failure) || recoveryExhausted(state.attempts, state.started, recoveryAttemptLimit, recoveryElapsedLimit)
	var limited interface{ RetryDelay() time.Duration }
	if errors.As(failure, &limited) && limited.RetryDelay() > 0 {
		if err = s.setPortalCooldown(state.next); err != nil {
			s.rememberCacheRetry(key, state)
			return err
		}
	}
	_, err = s.db.Exec(`INSERT INTO cache_retries(entry,failures,retry_at,paused,started_at,attempts) VALUES(?,?,?,?,?,?) ON CONFLICT(entry) DO UPDATE SET failures=excluded.failures,retry_at=excluded.retry_at,paused=excluded.paused,started_at=excluded.started_at,attempts=excluded.attempts`, key, state.failures, state.next.UnixNano(), state.paused, state.started.UnixNano(), state.attempts)
	if err != nil {
		// A disk error must not turn each browser request into another fetch.
		s.rememberCacheRetry(key, state)
	} else {
		s.mu.Lock()
		delete(s.retryFallback, key)
		s.mu.Unlock()
	}
	return err
}
func (s *store) rememberCacheRetry(key string, state cacheRetryState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.retryFallback == nil {
		s.retryFallback = map[string]cacheRetryState{}
	}
	s.retryFallback[key] = state
}
func (s *Server) cacheEligible(key string) (bool, error) {
	retry, err := s.cache.cacheRetry(key)
	if err != nil {
		return false, err
	}
	s.cache.mu.RLock()
	cooldown := s.cache.portalCooldownUntil
	s.cache.mu.RUnlock()
	return !retry.exhausted() && !time.Now().Before(maxTime(retry.next, cooldown)), nil
}

func (r cacheRetryState) stopped() bool { return !r.active && r.exhausted() }
func (r cacheRetryState) exhausted() bool {
	return r.paused || recoveryExhausted(max(r.attempts, r.failures), r.started, recoveryAttemptLimit, recoveryElapsedLimit)
}

// Save the episode start before provider work so a slow request/restart cannot
// manufacture a fresh elapsed-time allowance.
func (s *store) beginCacheAttempt(key string) error {
	state, err := s.cacheRetry(key)
	if err != nil {
		return err
	}
	if state.started.IsZero() {
		state.started = time.Now()
	}
	state.attempts++
	_, err = s.db.Exec(`INSERT INTO cache_retries(entry,failures,retry_at,paused,started_at,attempts) VALUES(?,0,0,0,?,1) ON CONFLICT(entry) DO UPDATE SET attempts=attempts+1,started_at=CASE WHEN started_at=0 THEN excluded.started_at ELSE started_at END`, key, state.started.UnixNano())
	if err != nil {
		state.paused = true
		s.rememberCacheRetry(key, state)
	} else {
		s.mu.Lock()
		if s.activeCacheAttempts == nil {
			s.activeCacheAttempts = map[string]bool{}
		}
		s.activeCacheAttempts[key] = true
		s.mu.Unlock()
	}
	return err
}

func (s *Server) cacheAttemptTimeout(key string) time.Duration {
	state, err := s.cache.cacheRetry(key)
	if err != nil || state.started.IsZero() {
		return 2 * time.Minute
	}
	return min(2*time.Minute, max(0, time.Until(state.started.Add(recoveryElapsedLimit))))
}

func (s *Server) failedCacheStatus(key string) cacheStatus {
	state, err := s.cache.cacheRetry(key)
	if err != nil {
		return cacheStatus{Stale: true, RetryStopped: true, RefreshError: "Could not read recovery state. Retry this request."}
	}
	if state.active {
		return cacheStatus{Stale: true, Refreshing: true, RefreshAfterSeconds: 1}
	}
	status := cacheStatus{Stale: true}
	if state.failures > 0 || state.stopped() {
		status.RetryStopped = state.stopped()
		status.RefreshError = "Refresh failed. Showing saved data."
		if status.RetryStopped {
			status.RefreshError = "Automatic retries stopped. Retry to try again."
		}
	}
	s.cache.mu.RLock()
	cooldown := s.cache.portalCooldownUntil
	s.cache.mu.RUnlock()
	if !status.RetryStopped {
		status.RefreshAfterSeconds = max(1, int(time.Until(maxTime(state.next, cooldown)).Seconds())+1)
	}
	return status
}

// Register before spawning so shutdown waits for every server-owned refresh.
func (s *Server) cacheFlight(group *singleflight.Group, key string, load func() (any, error)) <-chan singleflight.Result {
	s.browseMu.Lock()
	defer s.browseMu.Unlock()
	if s.browseClosed {
		ch := make(chan singleflight.Result, 1)
		ch <- singleflight.Result{Err: context.Canceled}
		return ch
	}
	s.browseWG.Add(1)
	result := group.DoChan(key, load)
	done := make(chan singleflight.Result, 1)
	go func() {
		res := <-result
		done <- res
		s.browseWG.Done()
	}()
	return done
}
func waitCache(ctx context.Context, result <-chan singleflight.Result) (any, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-result:
		return res.Val, res.Err
	}
}

func (s *Server) refreshBrowsePage(ctx context.Context, provider model.BrowseProvider, q model.BrowseQuery) error {
	key := pageKey(q)
	generation, err := s.cache.listingRevision(q)
	if err != nil {
		return err
	}
	library := s.cache.cacheRevision()
	flightKey := fmt.Sprintf("%s:%d:%d", key, generation, library.UnixNano())
	_, err = waitCache(ctx, s.cacheFlight(&s.browseFlights, flightKey, func() (any, error) {
		saved, found, err := s.cache.browseSnapshot(q, s.refreshInterval())
		if err != nil || found && !saved.Stale {
			return nil, err
		}
		eligible, err := s.cacheEligible(key)
		if err != nil {
			return nil, err
		}
		if !eligible {
			return nil, errCacheRetry
		}
		if err := s.cache.beginCacheAttempt(key); err != nil {
			return nil, err
		}
		requestCtx, cancel := context.WithTimeout(s.ctx, s.cacheAttemptTimeout(key))
		defer cancel()
		if !s.browseCategoryAllowed(q.Kind, q.Category) {
			return nil, nil
		}
		started := time.Now()
		page, err := provider.Browse(requestCtx, q)
		if err != nil {
			if s.ctx.Err() == nil {
				slog.Warn("Library page load failed", append(refreshFailureAttrs(err), "kind", q.Kind, "page", q.Page, "elapsed", time.Since(started).Round(time.Millisecond))...)
			}
			if saveErr := s.cache.cacheFailed(key, err); saveErr != nil {
				return nil, saveErr
			}
			return nil, err
		}
		s.cache.mu.RLock()
		names := map[string]string{}
		for _, category := range s.cache.categories {
			if category.Kind == q.Kind {
				names[category.ID] = category.Name
			}
		}
		s.cache.mu.RUnlock()
		for i := range page.Items {
			if page.Items[i].CategoryID == "" && q.Category != "*" {
				page.Items[i].CategoryID = q.Category
			}
			if name := names[page.Items[i].CategoryID]; name != "" {
				page.Items[i].Category = name
			}
		}
		if err := s.cache.setBrowsePage(q, page, library, generation); err != nil {
			if saveErr := s.cache.cacheFailed(key, err); saveErr != nil {
				return nil, saveErr
			}
			return nil, err
		}
		return nil, nil
	}))
	return err
}

func (s *Server) browseRangeSnapshot(q model.BrowseQuery, through int) (model.BrowsePage, bool, error) {
	out := model.BrowsePage{Items: []model.Item{}, Page: through}
	complete := true
	// A page refresh and its later-page invalidation commit under the same lock.
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	var err error
	out.Revision, err = s.cache.listingRevision(q)
	if err != nil {
		return out, false, err
	}
	for n := q.Page; n <= through; n++ {
		q.Page = n
		page, ok, err := s.cache.browse(q, 0)
		if err != nil {
			return out, false, err
		}
		if !ok {
			complete = false
			out.Stale = true
			continue
		}
		var at int64
		if err = s.cache.db.QueryRow(`SELECT fetched_at FROM pages WHERE kind=? AND category=? AND search=? AND page=?`, q.Kind, q.Category, q.Search, n).Scan(&at); err != nil {
			return out, false, err
		}
		out.Stale = out.Stale || at == 0 || time.Since(time.Unix(0, at)) >= s.refreshInterval()
		out.Items = append(out.Items, page.Items...)
		out.Total, out.HasMore = page.Total, page.HasMore
		if !page.HasMore {
			out.Page = n
			break
		}
	}
	return out, complete, nil
}

func (s *Server) loadBrowseRange(ctx context.Context, provider model.BrowseProvider, q model.BrowseQuery, through int) (model.BrowsePage, error) {
	page, complete, err := s.browseRangeSnapshot(q, through)
	if err != nil || complete && !page.Stale {
		return page, err
	}
	// A single ordered pass repairs shifted boundaries only across the requested range.
	key := fmt.Sprintf("range:%s:%q:%d:%d:%d:%d", listingKey(q), q.SourceType, q.Page, through, page.Revision, s.cache.cacheRevision().UnixNano())
	eligible := false
	for n := q.Page; n <= through; n++ {
		current := q
		current.Page = n
		saved, ok, readErr := s.cache.browseSnapshot(current, s.refreshInterval())
		if readErr != nil {
			return page, readErr
		}
		if !ok || saved.Stale {
			eligible, err = s.cacheEligible(pageKey(current))
			if err == nil && !eligible {
				state, readErr := s.cache.cacheRetry(pageKey(current))
				err = readErr
				// Joining an already reserved final attempt does not admit more work.
				eligible = state.active
			}
			break
		}
		if !saved.HasMore {
			break
		}
	}
	if err != nil {
		return page, err
	}
	if !eligible {
		// Another viewer may have finished refreshing between the two reads.
		latest, found, readErr := s.browseRangeSnapshot(q, through)
		if readErr != nil {
			return page, readErr
		}
		if found {
			return latest, nil
		}
		return page, errCacheRetry
	}
	result := s.cacheFlight(&s.browseFlights, key, func() (any, error) {
		rangeCtx, cancel := context.WithTimeout(s.ctx, 2*time.Minute)
		defer cancel()
		for n := q.Page; n <= through; n++ {
			current := q
			current.Page = n
			if err := s.refreshBrowsePage(rangeCtx, provider, current); err != nil {
				return nil, err
			}
			saved, ok, err := s.cache.browseSnapshot(current, s.refreshInterval())
			if err != nil {
				return nil, err
			}
			if ok && !saved.HasMore {
				break
			}
		}
		return nil, nil
	})
	if complete {
		page.Refreshing = true
		return page, nil
	}
	if _, err = waitCache(ctx, result); err != nil {
		return page, err
	}
	page, _, err = s.browseRangeSnapshot(q, through)
	return page, err
}
