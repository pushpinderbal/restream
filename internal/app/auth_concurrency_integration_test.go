package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

type authBlockingRefreshTransport struct {
	base    http.RoundTripper
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (tr *authBlockingRefreshTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == "/token" {
		tr.once.Do(func() { close(tr.started) })
		select {
		case <-tr.release:
		case <-r.Context().Done():
			return nil, r.Context().Err()
		}
	}
	return tr.base.RoundTrip(r)
}

func TestOIDCSlowRefreshDoesNotBlockAnotherUser(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	a.login(t)
	jar, _ := cookiejar.New(nil)
	b := &authTestApp{server: a.server, app: a.app, client: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	p.claims = func(c map[string]any) { c["sub"] = "another-user" }
	b.login(t)
	p.claims = nil
	if _, err := a.app.db.Exec(`UPDATE auth_users SET checked_at=0 WHERE subject='stable-user-id'`); err != nil {
		t.Fatal(err)
	}
	base := a.app.auth.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	tr := &authBlockingRefreshTransport{base: base, started: make(chan struct{}), release: make(chan struct{})}
	a.app.auth.client.Transport = tr
	var release sync.Once
	defer release.Do(func() { close(tr.release) })
	slow := make(chan error, 1)
	go func() {
		resp, err := a.client.Get(a.server.URL + "/api/status")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode != 200 {
				err = fmt.Errorf("slow user status: %d", resp.StatusCode)
			}
		}
		slow <- err
	}()
	select {
	case <-tr.started:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not start")
	}
	fast := make(chan error, 1)
	go func() {
		resp, err := b.client.Get(b.server.URL + "/api/status")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode != 200 {
				err = fmt.Errorf("fresh user status: %d", resp.StatusCode)
			}
		}
		fast <- err
	}()
	select {
	case err := <-fast:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("another identity was blocked by a provider refresh")
	}
	release.Do(func() { close(tr.release) })
	select {
	case err := <-slow:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not finish")
	}
	a.app.auth.identityMu.Lock()
	defer a.app.auth.identityMu.Unlock()
	if len(a.app.auth.identities) != 0 {
		t.Error("idle identity locks were retained")
	}
}

func TestOIDCPendingResponseCannotRestoreRetiredSession(t *testing.T) {
	for _, action := range []string{"logout", "login rotation"} {
		t.Run(action, func(t *testing.T) {
			p := newAuthTestProvider(t)
			a := newAuthTestApp(t, p, nil)
			a.login(t)
			origin, _ := url.Parse(a.server.URL)
			oldCookies := a.client.Jar.Cookies(origin)
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			pendingServer := httptest.NewServer(a.app.auth.middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-release; w.WriteHeader(200) })))
			defer pendingServer.Close()
			defer once.Do(func() { close(release) })
			done := make(chan *http.Response, 1)
			errors := make(chan error, 1)
			go func() {
				resp, err := a.client.Get(pendingServer.URL + "/api/status")
				if err != nil {
					errors <- err
					return
				}
				done <- resp
			}()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("pending request did not load its session")
			}
			if action == "logout" {
				resp, err := a.client.Post(a.server.URL+"/auth/logout", "", nil)
				if err != nil {
					t.Fatal(err)
				}
				resp.Body.Close()
				if resp.StatusCode != 204 {
					t.Fatalf("logout: %d", resp.StatusCode)
				}
			} else {
				p.claims = func(c map[string]any) { c["sub"] = "new-account" }
				a.login(t)
			}
			once.Do(func() { close(release) })
			select {
			case err := <-errors:
				t.Fatal(err)
			case resp := <-done:
				resp.Body.Close()
				if len(resp.Cookies()) != 0 {
					t.Errorf("retired request emitted cookies: %v", resp.Cookies())
				}
			case <-time.After(3 * time.Second):
				t.Fatal("pending request did not finish")
			}
			// The browser has now applied every Set-Cookie from the pending response.
			resp := a.get(t, "/api/status")
			resp.Body.Close()
			want := 401
			if action == "login rotation" {
				want = 200
			}
			if resp.StatusCode != want {
				t.Errorf("browser status after pending response: got %d want %d", resp.StatusCode, want)
			}
			if action == "login rotation" {
				resp = a.get(t, "/api/auth")
				body := authResponseBody(t, resp)
				var state struct {
					User AuthUser `json:"user"`
				}
				if err := json.Unmarshal([]byte(body), &state); err != nil {
					t.Fatal(err)
				}
				var subject string
				if err := a.app.db.QueryRow(`SELECT subject FROM auth_users WHERE id=?`, state.User.ID).Scan(&subject); err != nil || subject != "new-account" {
					t.Fatalf("pending response replaced current account: %s %v", subject, err)
				}
			}
			req, _ := http.NewRequest(http.MethodGet, a.server.URL+"/api/status", nil)
			for _, cookie := range oldCookies {
				req.AddCookie(cookie)
			}
			replay, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			replay.Body.Close()
			if replay.StatusCode != 401 {
				t.Errorf("retired session replay: %d", replay.StatusCode)
			}
		})
	}
}

func TestOIDCRejectsIncorrectAuthorizedParty(t *testing.T) {
	for _, multiple := range []bool{false, true} {
		t.Run(fmt.Sprintf("multiple_audiences_%t", multiple), func(t *testing.T) {
			p := newAuthTestProvider(t)
			p.claims = func(c map[string]any) {
				if multiple {
					c["aud"] = []string{"restream-test", "another-client"}
				} else {
					c["azp"] = "another-client"
				}
			}
			a := newAuthTestApp(t, p, nil)
			resp := a.get(t, a.callbackURL(t))
			resp.Body.Close()
			if resp.StatusCode != http.StatusSeeOther || resp.Header.Get("Location") != "/?auth_error=access_denied" {
				t.Fatalf("invalid authorized party accepted: %d %s", resp.StatusCode, resp.Header.Get("Location"))
			}
			if resp.Header.Get("Referrer-Policy") != "no-referrer" || resp.Header.Get("X-Content-Type-Options") != "nosniff" || resp.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("callback security headers missing")
			}
		})
	}
}
