package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type scheduledRefresh struct {
	State         refreshState `json:"state"`
	Configuration string       `json:"configuration"`
}

func (s *Server) refreshConfiguration(catalog bool) string {
	values := []any{s.cfg.PortalURL, s.cfg.MAC, s.cfg.Timezone, s.cfg.SerialNumber, s.cfg.DeviceID, s.cfg.DeviceID2, s.cfg.MaxResponseBytes, s.cfg.UserAgent}
	if !catalog {
		values = append(values, s.cfg.EPGHours)
	}
	data, _ := json.Marshal(values)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (s *Server) refreshLastSuccess(catalog bool) time.Time {
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	if !catalog {
		return s.cache.epgAt
	}
	last := s.cache.catalogAt
	if _, ok := s.provider.(model.BrowseProvider); ok && s.cache.categoriesAt.Before(last) {
		last = s.cache.categoriesAt
	}
	return last
}

func (s *Server) initScheduledRefresh() error {
	for idx, state := range []*refreshState{&s.catalogSync, &s.epgSync} {
		catalog := idx == 0
		kind := "epg"
		if catalog {
			kind = "metadata"
		}
		var data []byte
		err := s.cache.db.QueryRow(`SELECT data FROM scheduled_refresh WHERE kind=?`, kind).Scan(&data)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		configuration := s.refreshConfiguration(catalog)
		var saved scheduledRefresh
		if len(data) > 0 {
			if err := json.Unmarshal(data, &saved); err != nil {
				return err
			}
		}
		if saved.Configuration == configuration {
			*state = saved.State
		}
		if (state.Failures > 0 || state.Running) && state.RecoveryStartedAt == nil {
			state.RecoveryStartedAt = state.StartedAt
			if state.RecoveryStartedAt == nil {
				state.RecoveryStartedAt = state.FinishedAt
			}
		}
		if state.RecoveryAttempts == 0 {
			state.RecoveryAttempts = state.Failures
			if state.Running {
				state.RecoveryAttempts++
			}
		}
		if state.RecoveryStartedAt != nil && state.RecoveryAttempts > 0 && !state.Paused && recoveryExhausted(state.RecoveryAttempts, *state.RecoveryStartedAt, recoveryAttemptLimit, recoveryElapsedLimit) {
			state.Paused = true
			base := state.RecoveryStartedAt
			if state.FinishedAt != nil {
				base = state.FinishedAt
			}
			next := maxTime(time.Now(), s.nextScheduledRefresh(*base))
			// A guide's already configured future cadence is not postponed by restart.
			if !catalog && state.NextRefreshAt != nil && state.NextRefreshAt.After(time.Now()) {
				next = *state.NextRefreshAt
			}
			state.NextRefreshAt = &next
			state.Error = "Automatic retries stopped. Showing saved data until the next scheduled refresh or manual retry."
		} else if saved.Configuration == configuration && state.Running {
			next := time.Now().Add(retryCooldown(nil, max(1, state.Failures)))
			if !catalog {
				next = s.nextScheduledRefresh(time.Now())
			}
			state.NextRefreshAt = &next
		}
		resume := saved.Configuration == configuration && (state.Running || state.Queued)
		state.Configuration = configuration
		state.Running, state.Queued = false, false
		last := s.refreshLastSuccess(catalog)
		if state.LastSuccessfulAt == nil && !last.IsZero() {
			state.LastSuccessfulAt = &last
		}
		// Recompute successful schedules when cadence changes, but never shorten
		// a persisted failure cooldown because settings or the process changed.
		if !state.Paused && state.Failures == 0 {
			next := s.nextScheduledRefresh(last)
			if resume || len(data) > 0 && saved.Configuration != configuration {
				next = time.Now().UTC()
			}
			state.NextRefreshAt = &next
		}
		if !catalog && !state.Paused && state.Failures > 0 && state.FinishedAt != nil && state.NextRefreshAt != nil {
			// Older guide retries may predate the configured regular interval.
			// Preserve any longer provider cooldown when updating that schedule.
			next := maxTime(*state.NextRefreshAt, s.nextScheduledRefresh(*state.FinishedAt))
			state.NextRefreshAt = &next
		}
		if err := s.saveScheduledRefresh(kind, *state); err != nil {
			return err
		}
	}
	s.catalogError, s.epgError = s.catalogSync.Error, s.epgSync.Error
	return nil
}

func (s *Server) saveScheduledRefresh(kind string, state refreshState) error {
	data, err := json.Marshal(scheduledRefresh{State: state, Configuration: state.Configuration})
	if err != nil {
		return err
	}
	_, err = s.cache.db.Exec(`INSERT INTO scheduled_refresh(kind,data) VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data`, kind, data)
	return err
}

func (s *Server) scheduler(catalog bool) {
	defer s.wg.Done()
	kind, idx, state := "epg", 1, &s.epgSync
	if catalog {
		kind, idx, state = "metadata", 0, &s.catalogSync
	}
	for {
		s.stateMu.RLock()
		next, paused := state.NextRefreshAt, state.Paused
		s.stateMu.RUnlock()
		var timer *time.Timer
		var due <-chan time.Time
		if !paused || next != nil {
			wait := time.Duration(0)
			if next != nil {
				wait = max(0, time.Until(*next))
			}
			timer = time.NewTimer(wait)
			due = timer.C
		}
		select {
		case <-s.ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case <-due:
		case <-s.refreshWake[idx]:
			if timer != nil {
				timer.Stop()
			}
		}
		s.cache.mu.RLock()
		cooldown := s.cache.portalCooldownUntil
		s.cache.mu.RUnlock()
		s.stateMu.Lock()
		// Coalesce a manual request that arrives at the timer boundary.
		select {
		case <-s.refreshWake[idx]:
		default:
		}
		if cooldown.After(time.Now()) {
			state.NextRefreshAt, state.Queued = &cooldown, false
			_ = s.saveScheduledRefresh(kind, *state)
			s.stateMu.Unlock()
			continue
		}
		if !state.Paused && catalog && state.RecoveryAttempts > 0 && state.RecoveryStartedAt != nil && recoveryExhausted(state.RecoveryAttempts, *state.RecoveryStartedAt, recoveryAttemptLimit, recoveryElapsedLimit) {
			state.Paused = true
			next := s.nextScheduledRefresh(time.Now())
			state.NextRefreshAt = &next
			state.Error = "Automatic retries stopped. Showing saved data until the next scheduled refresh or manual retry."
			_ = s.saveScheduledRefresh(kind, *state)
			s.stateMu.Unlock()
			continue
		}
		started := time.Now().UTC()
		// Only a scheduled cadence or explicit refresh opens a new episode. Reads
		// cannot reach this reset, and recovery counters persist across restarts.
		if state.RecoveryStartedAt != nil && recoveryExhausted(state.RecoveryAttempts, *state.RecoveryStartedAt, recoveryAttemptLimit, recoveryElapsedLimit) {
			state.Failures, state.Paused = 0, false
			state.RecoveryStartedAt = nil
			state.RecoveryAttempts = 0
		}
		if state.RecoveryStartedAt == nil {
			state.RecoveryStartedAt = &started
		}
		state.Queued, state.Running, state.StartedAt = false, true, &started
		state.RecoveryAttempts++
		state.NextRefreshAt = nil
		if err := s.saveScheduledRefresh(kind, *state); err != nil {
			state.Running = false
			state.Failures++
			state.Paused = recoveryExhausted(state.RecoveryAttempts, *state.RecoveryStartedAt, recoveryAttemptLimit, recoveryElapsedLimit)
			state.Error = "Could not save refresh state. Showing saved data."
			next := time.Now().Add(retryCooldown(err, state.Failures))
			if state.Paused || !catalog {
				next = s.nextScheduledRefresh(time.Now())
			}
			state.NextRefreshAt = &next
			s.stateMu.Unlock()
			slog.Warn("Could not persist refresh start; delaying provider work", "kind", kind, "error", err)
			continue
		}
		s.stateMu.Unlock()
		err := s.doRefresh(catalog, !catalog)
		if s.ctx.Err() != nil {
			s.stateMu.Lock()
			state.Running = false
			next := time.Now()
			state.NextRefreshAt = &next

			_ = s.saveScheduledRefresh(kind, *state)
			s.stateMu.Unlock()
			return
		}
		finished := time.Now().UTC()
		s.stateMu.Lock()
		state.Running, state.FinishedAt = false, &finished
		if err != nil {
			state.Failures++
			state.Paused = retryPaused(err)
			state.Error = "Refresh failed. Showing saved data."
			state.NextRefreshAt = nil
			if state.Paused {
				state.Error = "Provider authentication or configuration needs attention. Update Settings or retry manually."
			} else {
				delay := retryCooldown(err, state.Failures)
				if !catalog {
					delay = max(delay, s.refreshInterval())
				}
				next := finished.Add(delay)
				if catalog && (recoveryExhausted(state.RecoveryAttempts, *state.RecoveryStartedAt, recoveryAttemptLimit, recoveryElapsedLimit) || next.Sub(*state.RecoveryStartedAt) >= recoveryElapsedLimit) {
					state.Paused = true
					state.Error = "Automatic retries stopped. Showing saved data until the next scheduled refresh or manual retry."
					next = s.nextScheduledRefresh(finished)
				}
				state.NextRefreshAt = &next
			}
		} else {
			state.Failures, state.Paused, state.Error = 0, false, ""
			state.RecoveryStartedAt = nil
			state.RecoveryAttempts = 0
			state.LastSuccessfulAt = &finished
			next := s.nextScheduledRefresh(finished)
			state.NextRefreshAt = &next
		}
		if catalog {
			s.catalogError = state.Error
		} else {
			s.epgError = state.Error
		}
		if saveErr := s.saveScheduledRefresh(kind, *state); saveErr != nil {
			slog.Warn("Could not persist refresh outcome", "kind", kind, "error", saveErr)
		}
		if err != nil {
			attrs := append(refreshFailureAttrs(err), "kind", kind, "elapsed", finished.Sub(started).Round(time.Millisecond), "paused", state.Paused)
			if state.NextRefreshAt != nil {
				attrs = append(attrs, "next_retry_at", *state.NextRefreshAt)
			}
			slog.Warn("Provider refresh failed; showing saved data", attrs...)
		}
		s.stateMu.Unlock()
	}
}

func (s *Server) scheduledAttemptTimeout(catalog bool) time.Duration {
	s.stateMu.RLock()
	defer s.stateMu.RUnlock()
	state := s.epgSync
	if catalog {
		state = s.catalogSync
	}
	if state.RecoveryStartedAt == nil {
		return refreshAttemptTimeout
	}
	return min(refreshAttemptTimeout, max(0, time.Until(state.RecoveryStartedAt.Add(recoveryElapsedLimit))))
}
