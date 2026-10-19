package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stalker"
)

func captureActivityLogs(t *testing.T) func() string {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "activity-logs")
	if err != nil {
		t.Fatal(err)
	}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(file, nil)))
	t.Cleanup(func() { slog.SetDefault(previous); _ = file.Close() })
	return func() string {
		t.Helper()
		data, err := os.ReadFile(file.Name())
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
}

func TestSignInAndSettingsActivityLogs(t *testing.T) {
	for _, tc := range []struct{ label, name, username, wantName string }{
		{"display name", "Alex", "alex-user", "Alex"},
		{"username", "  ", "alex-user", "alex-user"},
		{"user ID", "", "", ""},
	} {
		t.Run(tc.label, func(t *testing.T) {
			logs := captureActivityLogs(t)
			p := newAuthTestProvider(t)
			p.role = "admin"
			p.name = tc.name
			p.claims = func(claims map[string]any) { claims["preferred_username"] = tc.username }
			a := newAuthTestApp(t, p, nil)
			var identity struct{ User AuthUser }
			if err := json.Unmarshal([]byte(a.login(t)), &identity); err != nil || identity.User.ID == "" || identity.User.Name != tc.wantName {
				t.Fatal("missing signed-in identity", err)
			}
			for _, expected := range []string{"Sign-in started", "User signed in", "user_id=" + identity.User.ID, "role=admin"} {
				if !strings.Contains(logs(), expected) {
					t.Fatalf("missing %q: %s", expected, logs())
				}
			}
			before := logs()
			for range 5 {
				a.get(t, "/api/auth").Body.Close()
				a.get(t, "/api/status").Body.Close()
			}
			if logs() != before {
				t.Fatal("routine auth/status polling produced activity logs", logs())
			}
			resp := authPlaybackRequest(t, a, "PATCH", "/api/settings", `{"discovery":{"tmdbReadAccessToken":"private-metadata-token"}}`)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK || !strings.Contains(logs(), "Settings updated") || !strings.Contains(logs(), "sections=[discovery]") {
				t.Fatal("settings change was not logged", resp.StatusCode, logs())
			}
			before = logs()
			resp = authPlaybackRequest(t, a, "PATCH", "/api/settings", `{"discovery":{"tmdbReadAccessToken":"private-metadata-token"}}`)
			resp.Body.Close()
			if logs() != before {
				t.Fatal("unchanged settings produced activity logs", logs())
			}
			resp = authPlaybackRequest(t, a, "POST", "/auth/logout", "")
			resp.Body.Close()
			if resp.StatusCode != http.StatusNoContent || !strings.Contains(logs(), "User signed out") {
				t.Fatal("sign-out was not logged", resp.StatusCode, logs())
			}
			resp = a.get(t, "/auth/callback?code=private-code&state=private-state&error=private-provider-error")
			resp.Body.Close()
			if !strings.Contains(logs(), "Sign-in failed") || !strings.Contains(logs(), "stage=callback_validation") {
				t.Fatal("failed sign-in stage was not logged", logs())
			}
			wantUser := tc.wantName
			if wantUser == "" {
				wantUser = identity.User.ID
			}
			for _, message := range []string{"User signed in", "Settings updated", "User signed out"} {
				found := false
				for _, line := range strings.Split(logs(), "\n") {
					if strings.Contains(line, `msg="`+message+`"`) {
						found = true
						if !strings.Contains(line, "user="+wantUser) || !strings.Contains(line, "user_id="+identity.User.ID) {
							t.Fatalf("missing user context for %q: %s", message, line)
						}
					}
				}
				if !found {
					t.Fatalf("missing activity %q", message)
				}
			}
			for _, secret := range []string{"private-", "opaque-access-token", "opaque-refresh-token", "test-secret", p.server.URL} {
				if strings.Contains(logs(), secret) {
					t.Fatalf("activity logs exposed %q: %s", secret, logs())
				}
			}
		})
	}
}

func TestDiscoveryFailuresLoggedOnceWithRetryDetails(t *testing.T) {
	for _, scenario := range []struct {
		name, reason string
		status       int
		paused       bool
	}{
		{name: "authentication", status: 401, reason: "authentication_failed", paused: true},
		{name: "rate limit", status: 429, reason: "rate_limited"},
		{name: "transport", reason: "request_failed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			logs := captureActivityLogs(t)
			s, ts := discoveryTestServer(t, Config{TMDBReadAccessToken: "private-metadata-token"}, matchingDiscoveryProvider())
			var calls atomic.Int32
			s.discoveryService.client.Transport = discoveryTransport(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				if scenario.status == 0 {
					return nil, errors.New("private-transport-error https://private.invalid?token=private-token")
				}
				return &http.Response{StatusCode: scenario.status, Header: http.Header{"Retry-After": {"120"}}, Body: io.NopCloser(strings.NewReader("private-response-body")), Request: r}, nil
			})
			readDiscovery(t, ts)
			waitFor(t, func() bool {
				s.discoveryService.mu.Lock()
				defer s.discoveryService.mu.Unlock()
				return !s.discoveryService.refreshing && s.discoveryService.record.Error != ""
			})
			output := logs()
			for _, expected := range []string{"Discovery refresh started", "Discovery refresh failed", "source=tmdb", "reason=" + scenario.reason} {
				if !strings.Contains(output, expected) {
					t.Fatalf("missing %q: %s", expected, output)
				}
			}
			if scenario.paused {
				if !strings.Contains(output, "paused=true") || !strings.Contains(output, "http_status=401") || !strings.Contains(output, "Check the TMDB read access token in Settings") || strings.Contains(output, "next_retry_at=") {
					t.Fatal("authentication pause has no useful guidance", output)
				}
			} else if !strings.Contains(output, "paused=false") || !strings.Contains(output, "next_retry_at=") {
				t.Fatal("transient failure has no retry details", output)
			}
			if strings.Contains(output, "private-") || strings.Count(output, "Discovery refresh failed") != 1 {
				t.Fatal("failure details leaked or were duplicated", output)
			}
			attempts := calls.Load()
			for range 10 {
				readDiscovery(t, ts)
			}
			if logs() != output || calls.Load() != attempts {
				t.Fatal("dashboard polling repeated the failed refresh/log", logs())
			}
		})
	}
}

type oversizedGuideProvider struct{ fixtureProvider }

func (p *oversizedGuideProvider) EPG(context.Context) ([]model.Program, error) {
	return nil, &stalker.PermanentError{Message: "portal get_epg_info response exceeds configured size limit (67108864 bytes; set STALKER_MAX_RESPONSE_MB)"}
}

func TestGuideSizeFailureLogKeepsConfigurationHint(t *testing.T) {
	logs := captureActivityLogs(t)
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir()}, &oversizedGuideProvider{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	waitFor(t, func() bool {
		s.stateMu.RLock()
		defer s.stateMu.RUnlock()
		return s.epgSync.Paused && s.catalogSync.LastSuccessfulAt != nil
	})
	output := logs()
	for _, expected := range []string{"reason=response_too_large", "kind=epg", "paused=true", "STALKER_MAX_RESPONSE_MB", "reduce guide coverage"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("missing %q: %s", expected, output)
		}
	}
	if strings.Contains(output, "Check provider credentials") {
		t.Fatal("response-size failure was misreported as a credentials issue", output)
	}
}
