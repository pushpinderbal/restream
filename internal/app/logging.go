package app

import (
	"errors"
	"net/http"

	"github.com/pushpinderbal/restream/internal/stalker"
)

// Log classifications instead of upstream error text: URLs, tokens and response
// bodies can contain credentials. Internal user IDs link activity without names.
func activityAttrs(r *http.Request) []any {
	if user := authenticatedUser(r); user != nil {
		return []any{"user_id", user.ID}
	}
	return nil
}

func refreshFailureAttrs(err error) []any {
	var metadata discoveryMetadataError
	if errors.As(err, &metadata) {
		reason := "http_error"
		if metadata.reason != "" {
			reason = metadata.reason
		}
		switch metadata.status {
		case http.StatusUnauthorized, http.StatusForbidden:
			reason = "authentication_failed"
		case http.StatusTooManyRequests:
			reason = "rate_limited"
		}
		attrs := []any{"source", "tmdb", "reason", reason}
		if metadata.status != 0 {
			attrs = append(attrs, "http_status", metadata.status)
		}
		if metadata.Permanent() {
			attrs = append(attrs, "action", "Check the TMDB read access token in Settings, then refresh again.")
		}
		return attrs
	}
	var limited *stalker.RateLimitError
	if errors.As(err, &limited) {
		return []any{"source", "provider", "reason", "rate_limited"}
	}
	reason := providerFailureReason(err)
	attrs := []any{"reason", reason}
	if reason == "response_too_large" {
		return append(attrs, "source", "provider", "action", "Increase STALKER_MAX_RESPONSE_MB, or reduce guide coverage in Settings for a guide refresh, then refresh again.")
	}
	if retryPaused(err) {
		attrs = append(attrs, "action", "Check provider credentials and configuration in Settings, then refresh again.")
	}
	return attrs
}
