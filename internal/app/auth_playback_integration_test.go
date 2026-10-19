package app

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/stream"
)

func authPlaybackRequest(t *testing.T, a *authTestApp, method, path, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, a.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestOIDCPlaybackBelongsToItsUser(t *testing.T) {
	logs := captureActivityLogs(t)
	p := newAuthTestProvider(t)
	owner := newAuthTestApp(t, p, nil)
	streams := &policyStreams{values: map[string]stream.Session{}}
	rt := owner.app
	replacement, err := New(rt.server.cfg, &fixtureProvider{}, streams)
	if err != nil {
		t.Fatal(err)
	}
	rt.server.Close()
	rt.server = replacement
	waitFor(t, func() bool { _, ok := replacement.cache.item("live:1"); return ok })
	if body := owner.login(t); !strings.Contains(body, `"role":"viewer"`) {
		t.Fatal("viewer login failed", body)
	}
	started := authPlaybackRequest(t, owner, "POST", "/api/sessions", `{"itemId":"live:1"}`)
	if started.StatusCode != 201 {
		t.Fatal("start playback", started.StatusCode, authResponseBody(t, started))
	}
	started.Body.Close()

	// A second administrator still cannot inspect or control another user's stream.
	p.role = "admin"
	p.claims = func(claims map[string]any) { claims["sub"] = "another-user" }
	jar, _ := cookiejar.New(nil)
	other := &authTestApp{server: owner.server, app: rt, client: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	if body := other.login(t); !strings.Contains(body, `"role":"admin"`) {
		t.Fatal("second user login failed", body)
	}
	paths := []struct{ method, path, body string }{
		{"GET", "/api/sessions/test-1", ""},
		{"POST", "/api/sessions/test-1/heartbeat", ""},
		{"POST", "/api/sessions/test-1/seek", `{"position":5}`},
		{"DELETE", "/api/sessions/test-1", ""},
		{"GET", "/api/streams/test-1/1/index.m3u8", ""},
		{"GET", "/api/streams/test-1/1/seg-000001.ts", ""},
		{"GET", "/api/streams/test-1/1/subtitles-0.json?start=30", ""},
	}
	for _, request := range paths {
		resp := authPlaybackRequest(t, other, request.method, request.path, request.body)
		body := authResponseBody(t, resp)
		if resp.StatusCode != 404 {
			t.Errorf("another user: %s %s = %d %s", request.method, request.path, resp.StatusCode, body)
		}
		resp, err := http.DefaultClient.Get(owner.server.URL + request.path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Errorf("anonymous media/control request returned %d", resp.StatusCode)
		}
	}
	for _, request := range paths {
		if request.method == "DELETE" {
			continue
		}
		resp := authPlaybackRequest(t, owner, request.method, request.path, request.body)
		body := authResponseBody(t, resp)
		if resp.StatusCode != 200 && resp.StatusCode != 204 {
			t.Errorf("owner: %s %s = %d %s", request.method, request.path, resp.StatusCode, body)
		}
	}
	resp := authPlaybackRequest(t, owner, "DELETE", "/api/sessions/test-1", "")
	resp.Body.Close()
	if resp.StatusCode != 204 || streams.Active() != 0 {
		t.Fatal("owner could not stop playback", resp.StatusCode)
	}
	output := logs()
	if strings.Count(output, "Stream starting") != 1 || !strings.Contains(output, "session_id=test-1") || !strings.Contains(output, "user_id=") {
		t.Fatal("stream start is missing its user/session context", output)
	}
	if strings.Contains(output, "secret-command") || strings.Contains(output, "opaque-access-token") || strings.Contains(output, "opaque-refresh-token") {
		t.Fatal("stream activity exposed credentials", output)
	}
}

func TestOIDCToBrowserLogin(t *testing.T) {
	if os.Getenv("RESTREAM_BROWSER_TESTS") != "1" {
		t.Skip("set RESTREAM_BROWSER_TESTS=1 after building web assets to exercise OIDC in Chromium")
	}
	webDir, err := filepath.Abs("../../web/dist")
	if err != nil {
		t.Fatal(err)
	}
	p := newAuthTestProvider(t)
	p.role = "admin"
	a := newAuthTestApp(t, p, &Config{DataDir: t.TempDir(), WebDir: webDir})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "bun", "web/tests/oidc-login.mjs", a.server.URL)
	cmd.Dir = "../.."
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("OIDC browser login: %v\n%s", err, output)
	}
	t.Log(string(output))
}

func TestOIDCDeploymentURLAndCookieContract(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	cfg := a.app.base.Auth
	cfg.PublicURL = "HTTPS://restream.example.com/"
	manager, err := newAuth(cfg, a.app.db)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.close()
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://untrusted.example/auth/login", nil)
	req.Header.Set("X-Forwarded-Host", "untrusted.example")
	manager.middleware(http.NotFoundHandler()).ServeHTTP(recorder, req)
	authorize, err := url.Parse(recorder.Header().Get("Location"))
	if err != nil || authorize.Query().Get("redirect_uri") != "https://restream.example.com/auth/callback" {
		t.Fatal("callback must use the configured public origin", recorder.Header().Get("Location"), err)
	}
	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "__Host-restream_session" || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode || cookies[0].Domain != "" || cookies[0].Path != "/" {
		t.Fatal("HTTPS session cookie contract", cookies)
	}
	for _, value := range []string{"https://restream.example.com?", "https://restream.example.com?next=x"} {
		cfg.PublicURL = value
		if err := cfg.validate(); err == nil {
			t.Fatal("public origin accepted a query", value)
		}
	}
}

func TestOIDCReprovisioningDoesNotRestoreRevokedCookies(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	a.login(t)
	origin, _ := url.Parse(a.server.URL)
	cookies := a.client.Jar.Cookies(origin)
	p.role = nil
	if _, err := a.app.db.Exec(`UPDATE auth_users SET checked_at=0`); err != nil {
		t.Fatal(err)
	}
	resp := a.get(t, "/api/status")
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("removed role retained access", resp.StatusCode)
	}
	p.role = "viewer"
	a.login(t)
	replay, _ := http.NewRequest("GET", a.server.URL+"/api/status", nil)
	for _, cookie := range cookies {
		replay.AddCookie(cookie)
	}
	resp, err := http.DefaultClient.Do(replay)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("new login restored a previously revoked cookie", resp.StatusCode)
	}
}

func TestOIDCPublicShellAndHealthDoNotCreateSessions(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	for _, path := range []string{"/", "/healthz", "/readyz"} {
		resp := a.get(t, path)
		resp.Body.Close()
		if len(resp.Cookies()) != 0 {
			t.Errorf("public request %s set a session cookie", path)
		}
	}
	var count int
	if err := a.app.db.QueryRow(`SELECT COUNT(*) FROM auth_sessions`).Scan(&count); err != nil || count != 0 {
		t.Fatal("public requests created sessions", count, err)
	}
}
