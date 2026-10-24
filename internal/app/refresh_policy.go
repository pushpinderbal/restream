package app

import (
	"errors"
	"math/rand/v2"
	"time"
)

const (
	refreshAttemptTimeout = 5 * time.Minute
	recoveryAttemptLimit  = 3
	recoveryElapsedLimit  = 5 * time.Minute
	discoveryElapsedLimit = 30 * time.Minute
)

// Recovery never renews itself from a read, focus event, or process restart.
func recoveryExhausted(failures int, started time.Time, attempts int, elapsed time.Duration) bool {
	return failures >= attempts || !started.IsZero() && time.Since(started) >= elapsed
}

// Jitter spreads recovery work across instances. A provider's Retry-After is
// always a floor, even when it exceeds our ordinary backoff cap.
func retryCooldown(err error, failures int) time.Duration {
	return retryBackoff(err, failures, time.Minute, 30*time.Minute)
}

func retryBackoff(err error, failures int, initial, ceiling time.Duration) time.Duration {
	base := min(initial<<min(max(failures-1, 0), 10), ceiling)
	delay := min(time.Duration(float64(base)*(0.8+rand.Float64()*0.4)), ceiling)
	var limited interface{ RetryDelay() time.Duration }
	if errors.As(err, &limited) {
		delay = max(delay, limited.RetryDelay())
	}
	return delay
}

func retryPaused(err error) bool {
	var permanent interface{ Permanent() bool }
	return errors.As(err, &permanent) && permanent.Permanent()
}
