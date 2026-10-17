package app

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// authTestProvider exercises discovery, remote JWKS verification and the code
// exchange over HTTP. Codes are single use and bound to their PKCE challenge.
type authTestProvider struct {
	server  *httptest.Server
	key     *rsa.PrivateKey
	mu      sync.Mutex
	codes   map[string]url.Values
	claims  func(map[string]any)
	role    any
	name    string
	counter int
}

func newAuthTestProvider(t *testing.T) *authTestProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &authTestProvider{key: key, codes: map[string]url.Values{}, role: "viewer", name: "Alex"}
	p.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration", "/custom-discovery":
			_ = json.NewEncoder(w).Encode(map[string]any{"issuer": p.server.URL, "authorization_endpoint": p.server.URL + "/authorize", "token_endpoint": p.server.URL + "/token", "jwks_uri": p.server.URL + "/jwks", "userinfo_endpoint": p.server.URL + "/userinfo", "response_types_supported": []string{"code"}, "subject_types_supported": []string{"public"}, "id_token_signing_alg_values_supported": []string{"RS256"}, "code_challenge_methods_supported": []string{"S256"}})
		case "/jwks":
			_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "test", Algorithm: "RS256", Use: "sig"}}})
		case "/authorize":
			q := r.URL.Query()
			if q.Get("response_type") != "code" || q.Get("client_id") != "restream-test" || q.Get("code_challenge_method") != "S256" || len(q.Get("code_challenge")) < 40 || q.Get("state") == "" || q.Get("nonce") == "" {
				http.Error(w, "invalid authorization request", 400)
				return
			}
			scopes := strings.Fields(q.Get("scope"))
			if len(scopes) != 2 || !containsAuthScope(scopes, "openid") || !containsAuthScope(scopes, "profile") {
				http.Error(w, "unexpected scopes", 400)
				return
			}
			p.mu.Lock()
			p.counter++
			code := time.Now().Format("150405.000000000") + strings.Repeat("x", p.counter)
			p.codes[code] = q
			p.mu.Unlock()
			callback, _ := url.Parse(q.Get("redirect_uri"))
			values := callback.Query()
			values.Set("code", code)
			values.Set("state", q.Get("state"))
			callback.RawQuery = values.Encode()
			http.Redirect(w, r, callback.String(), http.StatusFound)
		case "/userinfo":
			if r.Header.Get("Authorization") != "Bearer opaque-access-token" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			c := map[string]any{"sub": "stable-user-id", "name": p.name, "restream_role": p.role}
			if p.claims != nil {
				p.claims(c)
			}
			_ = json.NewEncoder(w).Encode(c)
		case "/token":
			if err := r.ParseForm(); err != nil {
				http.Error(w, "bad form", 400)
				return
			}
			id, secret, ok := r.BasicAuth()
			if !ok {
				id, secret = r.Form.Get("client_id"), r.Form.Get("client_secret")
			}
			if id != "restream-test" || secret != "test-secret" {
				http.Error(w, "client auth required", http.StatusUnauthorized)
				return
			}
			if r.Form.Get("grant_type") == "refresh_token" {
				if r.Form.Get("refresh_token") != "opaque-refresh-token" {
					http.Error(w, "invalid refresh", 400)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "opaque-access-token", "refresh_token": "opaque-refresh-token", "token_type": "Bearer", "expires_in": 3600})
				return
			}
			p.mu.Lock()
			q, ok := p.codes[r.Form.Get("code")]
			delete(p.codes, r.Form.Get("code"))
			p.mu.Unlock()
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if !ok || r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("redirect_uri") != q.Get("redirect_uri") || base64.RawURLEncoding.EncodeToString(sum[:]) != q.Get("code_challenge") {
				http.Error(w, "invalid code or PKCE", 400)
				return
			}
			claims := map[string]any{"iss": p.server.URL, "sub": "stable-user-id", "aud": "restream-test", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(), "nonce": q.Get("nonce"), "name": p.name, "restream_role": p.role}
			if p.claims != nil {
				p.claims(claims)
			}
			signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: p.key}, (&jose.SignerOptions{}).WithHeader("kid", "test"))
			if err != nil {
				t.Error(err)
				http.Error(w, "signer", 500)
				return
			}
			token, err := jwt.Signed(signer).Claims(claims).Serialize()
			if err != nil {
				t.Error(err)
				http.Error(w, "token", 500)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "opaque-access-token", "refresh_token": "opaque-refresh-token", "token_type": "Bearer", "expires_in": 3600, "id_token": token})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(p.server.Close)
	return p
}

func containsAuthScope(scopes []string, want string) bool {
	for _, s := range scopes {
		if s == want {
			return true
		}
	}
	return false
}

type authTestApp struct {
	server *httptest.Server
	app    *Runtime
	client *http.Client
}

func newAuthTestApp(t *testing.T, p *authTestProvider, cfg *Config) *authTestApp {
	t.Helper()
	ts := httptest.NewUnstartedServer(nil)
	if cfg == nil {
		cfg = &Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: time.Hour}
	}
	cfg.Auth = AuthConfig{Mode: "oidc", IssuerURL: p.server.URL, ClientID: "restream-test", ClientSecret: "test-secret", PublicURL: "http://" + ts.Listener.Addr().String()}
	app, err := NewRuntime(*cfg)
	if err != nil {
		ts.Close()
		t.Fatal(err)
	}
	ts.Config.Handler = app
	ts.Start()
	jar, _ := cookiejar.New(nil)
	a := &authTestApp{server: ts, app: app, client: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	t.Cleanup(func() { ts.Close(); app.Close() })
	return a
}

func (a *authTestApp) get(t *testing.T, path string) *http.Response {
	t.Helper()
	if strings.HasPrefix(path, "/") {
		path = a.server.URL + path
	}
	resp, err := a.client.Get(path)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}
func authResponseBody(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func (a *authTestApp) callbackURL(t *testing.T) string {
	t.Helper()
	login := a.get(t, "/auth/login")
	defer login.Body.Close()
	if login.StatusCode != http.StatusFound && login.StatusCode != http.StatusSeeOther {
		t.Fatalf("login: %d %s", login.StatusCode, authResponseBody(t, login))
	}
	authorize := a.get(t, login.Header.Get("Location"))
	defer authorize.Body.Close()
	if authorize.StatusCode != http.StatusFound {
		t.Fatalf("authorize: %d %s", authorize.StatusCode, authResponseBody(t, authorize))
	}
	return authorize.Header.Get("Location")
}
func (a *authTestApp) login(t *testing.T) string {
	t.Helper()
	callback := a.get(t, a.callbackURL(t))
	defer callback.Body.Close()
	for _, cookie := range callback.Cookies() {
		if cookie.Name == "restream_session" && (!cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode) {
			t.Errorf("unsafe session cookie: %+v", cookie)
		}
	}
	if callback.StatusCode != http.StatusFound && callback.StatusCode != http.StatusSeeOther {
		t.Fatalf("callback: %d %s", callback.StatusCode, authResponseBody(t, callback))
	}
	status := a.get(t, "/api/auth")
	body := authResponseBody(t, status)
	if status.StatusCode != 200 {
		t.Fatalf("auth status: %d %s", status.StatusCode, body)
	}
	return body
}

func TestOIDCLoginProvisioningAndPermissions(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	resp := a.get(t, "/api/status")
	if resp.StatusCode != 401 {
		t.Errorf("anonymous catalog: %d", resp.StatusCode)
	}
	resp.Body.Close()
	body := a.login(t)
	var first struct {
		User struct {
			ID   string `json:"id"`
			Role string `json:"role"`
			Name string `json:"name"`
		} `json:"user"`
	}
	if err := json.Unmarshal([]byte(body), &first); err != nil {
		t.Fatal(err)
	}
	if first.User.ID == "" || first.User.Role != "viewer" {
		t.Fatalf("viewer identity: %s", body)
	}
	for _, endpoint := range []struct{ method, path string }{{"GET", "/api/settings"}, {"PATCH", "/api/settings"}, {"POST", "/api/refresh"}, {"GET", "/api/categories?manage=1"}} {
		req, _ := http.NewRequest(endpoint.method, a.server.URL+endpoint.path, strings.NewReader(`{}`))
		req.Header.Set("Origin", a.server.URL)
		resp, err := a.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 403 {
			t.Errorf("viewer %s %s: %d", endpoint.method, endpoint.path, resp.StatusCode)
		}
		resp.Body.Close()
	}
	resp = a.get(t, "/api/status")
	if resp.StatusCode != 200 {
		t.Errorf("viewer catalog: %d", resp.StatusCode)
	}
	resp.Body.Close()
	p.name = "Renamed"
	p.role = "admin"
	body = a.login(t)
	var next struct {
		User struct{ ID, Role, Name string } `json:"user"`
	}
	if err := json.Unmarshal([]byte(body), &next); err != nil {
		t.Fatal(err)
	}
	if next.User.ID != first.User.ID || next.User.Role != "admin" || next.User.Name != "Renamed" {
		t.Fatalf("JIT identity changed or claims not updated: %s", body)
	}
	resp = a.get(t, "/api/settings")
	if resp.StatusCode != 200 {
		t.Errorf("admin settings: %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestOIDCRejectsInvalidIdentityAndRoles(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"nonce", func(c map[string]any) { c["nonce"] = "wrong" }},
		{"issuer", func(c map[string]any) { c["iss"] = "https://wrong.example" }},
		{"audience", func(c map[string]any) { c["aud"] = "other-client" }},
		{"expired", func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() }},
		{"missing role", func(c map[string]any) { delete(c, "restream_role") }},
		{"array role", func(c map[string]any) { c["restream_role"] = []string{"admin"} }},
		{"unknown role", func(c map[string]any) { c["restream_role"] = "owner" }},
	}
	p := newAuthTestProvider(t)
	trustedKey := p.key
	wrongKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	cases = append(cases, struct {
		name   string
		mutate func(map[string]any)
	}{"signature", func(map[string]any) { p.key = wrongKey }})
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			p.key = trustedKey
			p.claims = tt.mutate
			a := newAuthTestApp(t, p, nil)
			resp := a.get(t, a.callbackURL(t))
			if resp.StatusCode < 400 && !strings.Contains(resp.Header.Get("Location"), "auth_error=") {
				t.Errorf("invalid login accepted: %d", resp.StatusCode)
			}
			resp.Body.Close()
			var users int
			if err := a.app.db.QueryRow("SELECT COUNT(*) FROM auth_users").Scan(&users); err != nil {
				t.Fatal(err)
			}
			if users != 0 {
				t.Errorf("invalid identity provisioned %d users", users)
			}
			resp = a.get(t, "/api/status")
			if resp.StatusCode != 401 {
				t.Errorf("invalid login established session: %d", resp.StatusCode)
			}
			resp.Body.Close()
		})
	}
}

func TestOIDCStateBoundToBrowserAndSingleUse(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	callback := a.callbackURL(t)
	other := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := other.Get(callback)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode < 400 && !strings.Contains(resp.Header.Get("Location"), "auth_error=") {
		t.Errorf("callback accepted without browser binding: %d", resp.StatusCode)
	}
	resp.Body.Close()
	altered, _ := url.Parse(callback)
	q := altered.Query()
	q.Set("state", "wrong-state")
	altered.RawQuery = q.Encode()
	resp = a.get(t, altered.String())
	if resp.StatusCode < 400 && !strings.Contains(resp.Header.Get("Location"), "auth_error=") {
		t.Errorf("bad state accepted: %d", resp.StatusCode)
	}
	resp.Body.Close()
	// Start a fresh transaction since a rejected callback may intentionally consume it.
	callback = a.callbackURL(t)
	resp = a.get(t, callback)
	if resp.StatusCode != 302 && resp.StatusCode != 303 {
		t.Fatalf("valid callback: %d %s", resp.StatusCode, authResponseBody(t, resp))
	}
	resp.Body.Close()
	resp = a.get(t, callback)
	if resp.StatusCode < 400 && !strings.Contains(resp.Header.Get("Location"), "auth_error=") {
		t.Errorf("replayed callback accepted: %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestOIDCSessionPersistenceAndLogoutCSRF(t *testing.T) {
	p := newAuthTestProvider(t)
	a := newAuthTestApp(t, p, nil)
	a.login(t)
	origin, _ := url.Parse(a.server.URL)
	cookies := a.client.Jar.Cookies(origin)
	resp := a.get(t, "/api/auth")
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Error("auth response may be cached")
	}
	resp.Body.Close()
	request, _ := http.NewRequest(http.MethodPost, a.server.URL+"/auth/logout", nil)
	request.Header.Set("Origin", "https://attacker.example")
	resp, err := a.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 403 {
		t.Errorf("cross-origin logout: %d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = a.get(t, "/api/status")
	if resp.StatusCode != 200 {
		t.Errorf("cross-origin logout destroyed session: %d", resp.StatusCode)
	}
	resp.Body.Close()
	// Restart the production runtime against the same SQLite file and carry the
	// browser's cookie to the new listener (cookies do not depend on port).
	cfg := a.app.base
	a.app.Close()
	listener := httptest.NewUnstartedServer(nil)
	cfg.Auth.PublicURL = "http://" + listener.Listener.Addr().String()
	restarted, err := NewRuntime(cfg)
	if err != nil {
		listener.Close()
		t.Fatal(err)
	}
	t.Cleanup(restarted.Close)
	listener.Config.Handler = restarted
	listener.Start()
	t.Cleanup(listener.Close)
	target, _ := url.Parse(listener.URL)
	a.client.Jar.SetCookies(target, cookies)
	resp = a.get(t, listener.URL+"/api/status")
	if resp.StatusCode != 200 {
		t.Errorf("session lost on restart: %d %s", resp.StatusCode, authResponseBody(t, resp))
	}
	resp.Body.Close()
	request, _ = http.NewRequest(http.MethodPost, listener.URL+"/auth/logout", nil)
	request.Header.Set("Origin", listener.URL)
	resp, err = a.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 204 {
		t.Errorf("same-origin logout: %d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = a.get(t, listener.URL+"/api/status")
	if resp.StatusCode != 401 {
		t.Errorf("logout retained access: %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestOIDCRoleRevalidation(t *testing.T) {
	p := newAuthTestProvider(t)
	p.role = "admin"
	a := newAuthTestApp(t, p, nil)
	a.login(t)
	for _, role := range []any{"viewer", nil} {
		p.role = role
		if _, err := a.app.db.Exec("UPDATE auth_users SET checked_at=0"); err != nil {
			t.Fatal(err)
		}
		resp := a.get(t, "/api/settings")
		want := 403
		if role == nil {
			want = 401
		}
		if resp.StatusCode != want {
			t.Errorf("role %v settings: got %d want %d: %s", role, resp.StatusCode, want, authResponseBody(t, resp))
		}
		resp.Body.Close()
	}
}

func TestOIDCDiscoveryAndConfiguration(t *testing.T) {
	p := newAuthTestProvider(t)
	valid := AuthConfig{Mode: "oidc", DiscoveryURL: p.server.URL + "/custom-discovery", ClientID: "restream-test", ClientSecret: "test-secret", PublicURL: "http://127.0.0.1:8080"}
	db, err := sql.Open("sqlite", t.TempDir()+"/auth.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	auth, err := newAuth(valid, db)
	if err != nil {
		t.Fatalf("discovery-only configuration: %v", err)
	}
	auth.close()
	invalid := []struct {
		name   string
		mutate func(*AuthConfig)
	}{
		{"issuer mismatch", func(c *AuthConfig) { c.IssuerURL = "https://wrong.example" }},
		{"no discovery", func(c *AuthConfig) { c.DiscoveryURL = "" }},
		{"no client ID", func(c *AuthConfig) { c.ClientID = "" }},
		{"no client secret", func(c *AuthConfig) { c.ClientSecret = "" }},
		{"no app URL", func(c *AuthConfig) { c.PublicURL = "" }},
		{"public HTTP", func(c *AuthConfig) { c.PublicURL = "http://restream.example" }},
		{"discovery HTTP", func(c *AuthConfig) { c.DiscoveryURL = "http://identity.example/.well-known/openid-configuration" }},
		{"unknown mode", func(c *AuthConfig) { c.Mode = "auto" }},
	}
	for _, tt := range invalid {
		t.Run(tt.name, func(t *testing.T) {
			cfg := valid
			tt.mutate(&cfg)
			manager, err := newAuth(cfg, db)
			if err == nil {
				manager.close()
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestAuthTypeEnvironmentControlsAccess(t *testing.T) {
	p := newAuthTestProvider(t)
	t.Setenv("STALKER_PORTAL_URL", "")
	t.Setenv("STALKER_MAC", "")
	t.Setenv("OIDC_ISSUER_URL", p.server.URL)
	t.Setenv("OIDC_DISCOVERY_URL", "")
	t.Setenv("OIDC_CLIENT_ID", "restream-test")
	t.Setenv("OIDC_CLIENT_SECRET", "test-secret")
	t.Setenv("APP_URL", "http://127.0.0.1:8080")
	for _, tc := range []struct {
		name, authType, wantMode, wantError string
	}{
		{name: "default", wantMode: "none"},
		{name: "anonymous", authType: "none", wantMode: "none"},
		{name: "oidc", authType: "oidc", wantMode: "oidc"},
		{name: "invalid type", authType: "auto", wantError: "AUTH_TYPE must be none or oidc"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AUTH_TYPE", tc.authType)
			cfg, err := LoadConfig()
			if tc.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("configuration error: got %v, want %q", err, tc.wantError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			cfg.DataDir, cfg.WebDir = t.TempDir(), t.TempDir()
			app, err := NewRuntime(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer app.Close()
			server := httptest.NewServer(app)
			defer server.Close()
			for _, path := range []string{"/api/auth", "/api/settings", "/api/status"} {
				resp, err := http.Get(server.URL + path)
				if err != nil {
					t.Fatal(err)
				}
				body := authResponseBody(t, resp)
				wantStatus := http.StatusOK
				if tc.wantMode == "oidc" && path != "/api/auth" {
					wantStatus = http.StatusUnauthorized
				}
				if resp.StatusCode != wantStatus {
					t.Errorf("%s: got %d, want %d: %s", path, resp.StatusCode, wantStatus, body)
				}
				if path == "/api/auth" && !strings.Contains(body, `"mode":"`+tc.wantMode+`"`) {
					t.Errorf("unexpected auth state: %s", body)
				}
			}
		})
	}
}
