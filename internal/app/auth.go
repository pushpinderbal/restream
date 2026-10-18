package app

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/alexedwards/scs/sqlite3store"
	"github.com/alexedwards/scs/v2"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const authRoleInterval = 5 * time.Minute

type AuthUser struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}
type authContextKey struct{}

func authenticatedUser(r *http.Request) *AuthUser {
	u, _ := r.Context().Value(authContextKey{}).(*AuthUser)
	return u
}

type authManager struct {
	cfg        AuthConfig
	db         *sql.DB
	sessions   *scs.SessionManager
	store      *sqlite3store.SQLite3Store
	provider   *oidc.Provider
	verifier   *oidc.IDTokenVerifier
	oauth      oauth2.Config
	client     *http.Client
	identityMu sync.Mutex
	identities map[string]*authIdentityLock
}

// Locks exist only while callbacks or revalidations are using/waiting for them.
// Keeping the reference count under identityMu prevents two locks for one identity.
type authIdentityLock struct {
	mu    sync.Mutex
	users int
}

func (a *authManager) lockIdentity(issuer, subject string) func() {
	key := issuer + "\x00" + subject
	a.identityMu.Lock()
	if a.identities == nil {
		a.identities = make(map[string]*authIdentityLock)
	}
	lock := a.identities[key]
	if lock == nil {
		lock = &authIdentityLock{}
		a.identities[key] = lock
	}
	lock.users++
	a.identityMu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		a.identityMu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(a.identities, key)
		}
		a.identityMu.Unlock()
	}
}

type authClaims struct {
	Role            string `json:"restream_role"`
	AuthorizedParty string `json:"azp"`
	Name            string `json:"name"`
	Username        string `json:"preferred_username"`
}

func (c authClaims) valid() bool { return c.Role == "viewer" || c.Role == "admin" }
func (c authClaims) name() string {
	if c.Name != "" {
		return c.Name
	}
	return c.Username
}

func newAuth(cfg AuthConfig, db *sql.DB) (*authManager, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	a := &authManager{cfg: cfg, db: db}
	if cfg.Mode == "none" {
		return a, nil
	}
	a.client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	discoveryURL := cfg.DiscoveryURL
	if discoveryURL == "" {
		discoveryURL = strings.TrimSuffix(cfg.IssuerURL, "/") + "/.well-known/openid-configuration"
	}
	req, err := http.NewRequest(http.MethodGet, discoveryURL, nil)
	if err != nil {
		return nil, fmt.Errorf("invalid OIDC discovery URL")
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery request failed")
	}
	defer resp.Body.Close()
	var metadata struct {
		oidc.ProviderConfig
		Methods []string `json:"code_challenge_methods_supported"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&metadata) != nil {
		return nil, fmt.Errorf("invalid OIDC discovery document")
	}
	if cfg.IssuerURL != "" && metadata.IssuerURL != cfg.IssuerURL {
		return nil, fmt.Errorf("OIDC discovery issuer does not match OIDC_ISSUER_URL")
	}
	for _, raw := range []string{metadata.IssuerURL, metadata.AuthURL, metadata.TokenURL, metadata.UserInfoURL, metadata.JWKSURL} {
		if _, err := authURL(raw); err != nil {
			return nil, fmt.Errorf("invalid OIDC provider endpoint")
		}
	}
	supported := false
	for _, method := range metadata.Methods {
		if method == "S256" {
			supported = true
		}
	}
	if !supported {
		return nil, fmt.Errorf("OIDC provider must advertise PKCE S256 support")
	}
	a.cfg.IssuerURL = metadata.IssuerURL
	a.provider = metadata.ProviderConfig.NewProvider(oidc.ClientContext(context.Background(), a.client))
	a.verifier = a.provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})
	a.oauth = oauth2.Config{ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, Endpoint: a.provider.Endpoint(), RedirectURL: cfg.PublicURL + "/auth/callback", Scopes: []string{oidc.ScopeOpenID, "profile"}}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS auth_users (
 id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL,
 role TEXT NOT NULL, checked_at INTEGER NOT NULL, provider_token BLOB NOT NULL, session_version INTEGER NOT NULL DEFAULT 0,
 UNIQUE(issuer,subject));
 CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY, data BLOB NOT NULL, expiry REAL NOT NULL);
 CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expiry);
 CREATE TABLE IF NOT EXISTS auth_login_transactions (state TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_retired_sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS auth_retired_sessions_expiry ON auth_retired_sessions(expires);`); err != nil {
		return nil, err
	}
	a.store = sqlite3store.NewWithConfig(db, sqlite3store.Config{TableName: "auth_sessions", CleanUpInterval: 5 * time.Minute})
	a.sessions = scs.New()
	a.sessions.Store = &authSessionStore{SQLite3Store: a.store, db: db, lifetime: 30 * 24 * time.Hour}
	a.sessions.Lifetime = 30 * 24 * time.Hour
	a.sessions.IdleTimeout = 24 * time.Hour
	a.sessions.Cookie.Name = "restream_session"
	a.sessions.Cookie.Path = "/"
	a.sessions.Cookie.HttpOnly = true
	a.sessions.Cookie.SameSite = http.SameSiteLaxMode
	a.sessions.Cookie.Secure = strings.HasPrefix(cfg.PublicURL, "https://")
	if a.sessions.Cookie.Secure {
		a.sessions.Cookie.Name = "__Host-restream_session"
	}
	a.sessions.Cookie.Persist = true
	a.sessions.ErrorFunc = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Error("Authentication session unavailable", "stage", "session_store")
		authResponseHeaders(w)
		fail(w, 500, "auth", "Authentication is temporarily unavailable.")
	}
	return a, nil
}
func (a *authManager) close() {
	if a.store != nil {
		a.store.StopCleanup()
	}
}
func (a *authManager) context(ctx context.Context) context.Context {
	return oidc.ClientContext(ctx, a.client)
}

func authResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func (a *authManager) middleware(next http.Handler) http.Handler {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
			authResponseHeaders(w)
		}
		if a.cfg.Mode == "oidc" {
			switch r.URL.Path {
			case "/auth/login":
				if r.Method == http.MethodGet {
					a.login(w, r)
				} else {
					w.WriteHeader(405)
				}
				return
			case "/auth/callback":
				if r.Method == http.MethodGet {
					a.callback(w, r)
				} else {
					w.WriteHeader(405)
				}
				return
			case "/auth/logout":
				if r.Method == http.MethodPost {
					a.logout(w, r)
				} else {
					w.WriteHeader(405)
				}
				return
			}
			if strings.HasPrefix(r.URL.Path, "/api/") {
				user := a.user(r)
				if user != nil {
					r = r.WithContext(context.WithValue(r.Context(), authContextKey{}, user))
				}
				if r.URL.Path != "/api/auth" {
					if user == nil {
						fail(w, 401, "unauthorized", "Sign in to continue.")
						return
					}
					admin := r.URL.Path == "/api/settings" || strings.HasPrefix(r.URL.Path, "/api/settings/") || r.URL.Path == "/api/refresh" || r.URL.Path == "/api/categories" && r.URL.Query().Get("manage") == "1"
					if admin && user.Role != "admin" {
						fail(w, 403, "forbidden", "Administrator access is required.")
						return
					}
				}
			}
		}
		if r.URL.Path == "/api/auth" {
			if r.Method != http.MethodGet {
				w.WriteHeader(405)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(struct {
				Mode string    `json:"mode"`
				User *AuthUser `json:"user"`
			}{a.cfg.Mode, authenticatedUser(r)})
			return
		}
		next.ServeHTTP(w, r)
	})
	if a.sessions == nil {
		return handler
	}
	withSession := a.sessions.LoadAndSave(handler)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
			withSession.ServeHTTP(w, r)
			return
		}
		// The public shell, versioned assets and health checks need no session writes.
		next.ServeHTTP(w, r)
	})
}

func (a *authManager) login(w http.ResponseWriter, r *http.Request) {
	// Replacing this transaction also invalidates a previous login attempt in this browser.
	if err := a.sessions.RenewToken(r.Context()); err != nil {
		a.loginError(w, r, false, "session_renewal")
		return
	}
	state, nonce, verifier := oauth2.GenerateVerifier(), oauth2.GenerateVerifier(), oauth2.GenerateVerifier()
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM auth_login_transactions WHERE expires < ?`, time.Now().Unix()); err != nil {
		a.loginError(w, r, false, "transaction_cleanup")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `INSERT INTO auth_login_transactions(state,expires) VALUES(?,?)`, state, time.Now().Add(10*time.Minute).Unix()); err != nil {
		a.loginError(w, r, false, "transaction_save")
		return
	}
	a.sessions.Put(r.Context(), "login_state", state)
	a.sessions.Put(r.Context(), "login_nonce", nonce)
	a.sessions.Put(r.Context(), "login_verifier", verifier)
	a.sessions.Put(r.Context(), "login_started", time.Now().Unix())
	slog.Info("Sign-in started")
	http.Redirect(w, r, a.oauth.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}
func (a *authManager) loginError(w http.ResponseWriter, r *http.Request, denied bool, stage string) {
	code := "login_failed"
	if denied {
		code = "access_denied"
	}
	// Provider errors, callback queries and tokens can contain credentials.
	slog.Warn("Sign-in failed", "stage", stage, "reason", code)
	http.Redirect(w, r, "/?auth_error="+code, http.StatusSeeOther)
}
func (a *authManager) callback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	state := a.sessions.PopString(ctx, "login_state")
	nonce := a.sessions.PopString(ctx, "login_nonce")
	verifier := a.sessions.PopString(ctx, "login_verifier")
	started := a.sessions.GetInt64(ctx, "login_started")
	a.sessions.Remove(ctx, "login_started")
	if state == "" || nonce == "" || verifier == "" || started <= 0 || time.Now().Unix()-started > 600 || started > time.Now().Unix() || subtle.ConstantTimeCompare([]byte(state), []byte(r.URL.Query().Get("state"))) != 1 || r.URL.Query().Get("error") != "" || r.URL.Query().Get("code") == "" {
		a.loginError(w, r, false, "callback_validation")
		return
	}
	var expires int64
	if err := a.db.QueryRowContext(ctx, `DELETE FROM auth_login_transactions WHERE state=? RETURNING expires`, state).Scan(&expires); err != nil || expires < time.Now().Unix() {
		a.loginError(w, r, false, "transaction_validation")
		return
	}
	token, err := a.oauth.Exchange(a.context(ctx), r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		a.loginError(w, r, false, "token_exchange")
		return
	}
	raw, _ := token.Extra("id_token").(string)
	id, err := a.verifier.Verify(a.context(ctx), raw)
	if err != nil || id.Subject == "" || subtle.ConstantTimeCompare([]byte(id.Nonce), []byte(nonce)) != 1 {
		a.loginError(w, r, false, "token_verification")
		return
	}
	var claims authClaims
	if id.Claims(&claims) != nil || !claims.valid() || claims.AuthorizedParty != "" && claims.AuthorizedParty != a.cfg.ClientID || len(id.Audience) > 1 && claims.AuthorizedParty != a.cfg.ClientID {
		a.loginError(w, r, true, "claims_validation")
		return
	}
	data, err := json.Marshal(token)
	if err != nil {
		a.loginError(w, r, false, "token_storage")
		return
	}
	unlock := a.lockIdentity(id.Issuer, id.Subject)
	var userID string
	var version int64
	err = a.db.QueryRowContext(ctx, `INSERT INTO auth_users(id,issuer,subject,name,role,checked_at,provider_token) VALUES(?,?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET name=excluded.name,role=excluded.role,checked_at=excluded.checked_at,provider_token=excluded.provider_token RETURNING id,session_version`, oauth2.GenerateVerifier(), id.Issuer, id.Subject, claims.name(), claims.Role, time.Now().Unix(), data).Scan(&userID, &version)
	unlock()
	if err != nil {
		a.loginError(w, r, false, "user_save")
		return
	}
	if err = a.sessions.RenewToken(ctx); err != nil {
		a.loginError(w, r, false, "session_renewal")
		return
	}
	a.sessions.Clear(ctx)
	a.sessions.Put(ctx, "user_id", userID)
	a.sessions.Put(ctx, "user_version", version)
	slog.Info("User signed in", "user_id", userID, "role", claims.Role)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}
func (a *authManager) logout(w http.ResponseWriter, r *http.Request) {
	userID := a.sessions.GetString(r.Context(), "user_id")
	if err := a.sessions.Destroy(r.Context()); err != nil {
		slog.Error("Sign-out failed", "stage", "session_destroy", "user_id", userID)
		fail(w, 500, "auth", "Unable to sign out.")
		return
	}
	if userID != "" {
		slog.Info("User signed out", "user_id", userID)
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *authManager) user(r *http.Request) *AuthUser {
	id := a.sessions.GetString(r.Context(), "user_id")
	if id == "" {
		return nil
	}
	var u AuthUser
	var issuer, subject string
	var checked, version int64
	var data []byte

	load := func() bool {
		err := a.db.QueryRowContext(r.Context(), `SELECT id,name,role,issuer,subject,checked_at,provider_token,session_version FROM auth_users WHERE id=?`, id).Scan(&u.ID, &u.Name, &u.Role, &issuer, &subject, &checked, &data, &version)
		return err == nil && issuer == a.cfg.IssuerURL && version == a.sessions.GetInt64(r.Context(), "user_version") && (u.Role == "viewer" || u.Role == "admin")
	}
	if !load() {
		return nil
	}
	if time.Since(time.Unix(checked, 0)) < authRoleInterval {
		return &u
	}
	unlock := a.lockIdentity(issuer, subject)
	defer unlock()
	// A callback or another request may have replaced credentials while we waited.
	if !load() {
		return nil
	}
	if time.Since(time.Unix(checked, 0)) < authRoleInterval {
		return &u
	}
	if r.Context().Err() != nil {
		return nil
	}
	// Complete rotating credentials even when the initiating browser navigates away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 20*time.Second)
	defer cancel()
	revoke := func(reason string) *AuthUser {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Second)
		defer cancel()
		_, _ = a.db.ExecContext(ctx, `UPDATE auth_users SET role='',checked_at=0,session_version=session_version+1 WHERE id=?`, id)
		slog.Warn("User access revoked", "user_id", id, "stage", "session_revalidation", "reason", reason)
		return nil
	}
	var token oauth2.Token
	if json.Unmarshal(data, &token) != nil {
		return revoke("invalid_stored_token")
	}
	// Force refresh even while an access token is valid, so account/client-access revocations
	// are checked at the same bounded interval as role changes.
	if token.RefreshToken == "" {
		return revoke("missing_refresh_token")
	}
	token.Expiry = time.Now().Add(-time.Hour)
	refreshed, err := a.oauth.TokenSource(a.context(ctx), &token).Token()
	var claims authClaims
	if err == nil {
		var info *oidc.UserInfo
		info, err = a.provider.UserInfo(a.context(ctx), oauth2.StaticTokenSource(refreshed))
		if err == nil {
			if info.Subject != subject {
				err = errors.New("subject mismatch")
			} else {
				err = info.Claims(&claims)
			}
		}
	}
	if err != nil {
		return revoke("provider_revalidation_failed")
	}
	if !claims.valid() {
		return revoke("invalid_role")
	}
	data, err = json.Marshal(refreshed)
	if err != nil {
		return revoke("token_storage_failed")
	}
	_, err = a.db.ExecContext(ctx, `UPDATE auth_users SET name=?,role=?,checked_at=?,provider_token=? WHERE id=?`, claims.name(), claims.Role, time.Now().Unix(), data, id)
	if err != nil {
		return revoke("user_save_failed")
	}
	if u.Role != claims.Role {
		slog.Info("User role changed", "user_id", id, "previous_role", u.Role, "role", claims.Role)
	}
	u.Name, u.Role = claims.name(), claims.Role
	return &u
}
