package stalker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type recoveryTransport func(*http.Request) (*http.Response, error)

func (f recoveryTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestReadRecoverySharesOneBoundedAttemptBudget(t *testing.T) {
	for _, failure := range []string{"network", "503"} {
		for _, outcome := range []string{"recovers", "exhausted", "deadline"} {
			t.Run(failure+"/"+outcome, func(t *testing.T) {
				persistent := outcome != "recovers"
				var attempts atomic.Int32
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var js any = map[string]any{"data": []any{}, "total_items": 0}
					switch r.URL.Query().Get("action") {
					case "handshake":
						js = map[string]any{"token": "session"}
					case "get_profile":
						js = map[string]any{"id": 1}
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
				}))
				defer srv.Close()
				transport := recoveryTransport(func(r *http.Request) (*http.Response, error) {
					if r.URL.Query().Get("action") == "get_ordered_list" && (attempts.Add(1) == 1 || persistent) {
						if failure == "network" {
							return nil, errors.New("private network details")
						}
						return &http.Response{StatusCode: http.StatusServiceUnavailable, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
					}
					return http.DefaultTransport.RoundTrip(r)
				})
				c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", HTTPClient: &http.Client{Transport: transport}, RequestInterval: time.Nanosecond})
				if err != nil {
					t.Fatal(err)
				}
				c.retryBackoff = func(int) time.Duration { return 0 }
				if outcome == "deadline" {
					c.cfg.RequestTimeout = 50 * time.Millisecond
					c.retryBackoff = func(int) time.Duration { return time.Hour }
				}
				_, err = c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Page: 1})
				wantAttempts := int32(2)
				if persistent {
					wantAttempts = 4
				}
				if outcome == "deadline" {
					wantAttempts = 1
					if !errors.Is(err, context.DeadlineExceeded) {
						t.Fatalf("retry ignored logical deadline: %v", err)
					}
				}
				if attempts.Load() != wantAttempts || (err != nil) != persistent || err != nil && strings.Contains(err.Error(), "private") {
					t.Fatalf("read recovery: attempts=%d error=%v", attempts.Load(), err)
				}
			})
		}
	}
}

func TestStatefulActionsDoNotReplayTransientFailures(t *testing.T) {
	for _, action := range []string{"handshake", "create_link"} {
		for _, cooldown := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/cooldown=%t", action, cooldown), func(t *testing.T) {
				var attempts atomic.Int32
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Query().Get("action") == action {
						attempts.Add(1)
						if cooldown {
							w.Header().Set("Retry-After", "90")
						}
						w.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"js": map[string]any{"id": 1, "token": "session"}})
				}))
				defer srv.Close()
				c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
				if err != nil {
					t.Fatal(err)
				}
				c.retryBackoff = func(int) time.Duration { return 0 }
				var saved time.Time
				c.ConfigureCooldown(time.Time{}, func(until time.Time) error { saved = until; return nil })
				_, err = c.Resolve(context.Background(), model.Item{Kind: "live", ID: "live:1"})
				if err == nil || attempts.Load() != 1 {
					t.Fatalf("stateful replay: attempts=%d error=%v", attempts.Load(), err)
				}
				if cooldown {
					var limited *RateLimitError
					if !errors.As(err, &limited) || limited.RetryDelay() < 89*time.Second || time.Until(saved) < 89*time.Second {
						t.Fatalf("stateful operation lost its cooldown: %v saved=%v", err, saved)
					}
					_, err = c.Resolve(context.Background(), model.Item{Kind: "live", ID: "live:1"})
					if !errors.As(err, &limited) || attempts.Load() != 1 {
						t.Fatalf("next request bypassed cooldown: calls=%d error=%v", attempts.Load(), err)
					}
				} else if !strings.Contains(err.Error(), strconv.Itoa(http.StatusServiceUnavailable)) {
					t.Fatalf("unexpected stateful error: %v", err)
				}
			})
		}
	}
}

func TestRejectedLoginAllowsLaterRecovery(t *testing.T) {
	for _, failure := range []string{"handshake", "missing token", "profile"} {
		t.Run(failure, func(t *testing.T) {
			var recovered atomic.Bool
			var handshakes atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				action := r.URL.Query().Get("action")
				var js any = []any{}
				if action == "handshake" {
					handshakes.Add(1)
					if !recovered.Load() && failure == "handshake" {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					js = map[string]any{"token": "session"}
					if !recovered.Load() && failure == "missing token" {
						js = map[string]any{}
					}
				} else if action == "get_profile" {
					if !recovered.Load() && failure == "profile" {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					js = map[string]any{"id": 1}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
			}))
			defer srv.Close()
			c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
			if err != nil {
				t.Fatal(err)
			}
			_, err = c.Catalog(context.Background())
			var auth *AuthenticationError
			if !errors.As(err, &auth) || handshakes.Load() != 1 {
				t.Fatalf("rejected login: error=%v handshakes=%d", err, handshakes.Load())
			}
			recovered.Store(true)
			if _, err = c.Catalog(context.Background()); err != nil || handshakes.Load() != 2 {
				t.Fatalf("later recovery: error=%v handshakes=%d", err, handshakes.Load())
			}
		})
	}
}

func TestRejectedBrowseActionKeepsOtherCategoriesUsable(t *testing.T) {
	var handshakes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		var js any
		switch q.Get("action") {
		case "handshake":
			handshakes++
			js = map[string]any{"token": "session"}
		case "get_profile":
			js = map[string]any{"id": 1}
		case "get_ordered_list":
			if q.Get("category") != "working" {
				var status int
				_, _ = fmt.Sscan(q.Get("category"), &status)
				w.WriteHeader(status)
				return
			}
			js = map[string]any{"data": []any{}, "total_items": 0}
		default:
			t.Errorf("unexpected action: %s", q.Get("action"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []int{400, 404, 405, 410, 422} {
		_, err = c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Page: 1, Category: fmt.Sprint(status)})
		var actionErr *portalHTTPError
		var configErr *PermanentError
		if !errors.As(err, &actionErr) || actionErr.action != "get_ordered_list" || actionErr.status != status || !actionErr.Permanent() || errors.As(err, &configErr) {
			t.Fatalf("operation failure %d: %v", status, err)
		}
	}
	_, err = c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Page: 1, Category: "working"})
	if err != nil || handshakes != 1 {
		t.Fatalf("unrelated category lost its session: error=%v handshakes=%d", err, handshakes)
	}
}

func TestPortalAffinitySurvivesDiscoveryAndReauthentication(t *testing.T) {
	var handshakes, profiles, links int
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		checkCookie := func(name, want string) {
			t.Helper()
			cookie, err := r.Cookie(name)
			if err != nil || cookie.Value != want {
				t.Errorf("%s cookie on %s: %v %v", name, r.URL.Path, cookie, err)
			}
		}
		if r.URL.Path == "/" {
			if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
				t.Error("discovery sent MAG identity")
			}
			http.SetCookie(w, &http.Cookie{Name: "affinity", Value: "node-1", Path: "/"})
			http.Redirect(w, r, "/stalker_portal/c", http.StatusFound)
			return
		}
		checkCookie("affinity", "node-1")
		if r.URL.Path == "/stalker_portal/c" {
			if strings.Contains(r.Header.Get("Cookie"), "mac=") {
				t.Error("landing page sent MAG identity")
			}
			return
		}
		if r.URL.Path == "/play/stream.m3u8" {
			checkCookie("session", "2")
			checkCookie("mac", "aa%3Abb")
			if r.Header.Get("Authorization") != "Bearer token-2" {
				t.Error("playback lost session token")
			}
			return
		}
		checkCookie("mac", "aa%3Abb")
		var js any
		switch r.URL.Query().Get("action") {
		case "handshake":
			handshakes++
			http.SetCookie(w, &http.Cookie{Name: "session", Value: fmt.Sprint(handshakes), Path: "/"})
			js = map[string]any{"token": fmt.Sprintf("token-%d", handshakes)}
		case "get_profile":
			checkCookie("session", fmt.Sprint(handshakes))
			count := 0
			for _, cookie := range r.Cookies() {
				if cookie.Name == "session" {
					count++
				}
			}
			if count != 1 {
				t.Errorf("retry duplicated session cookie: %d", count)
			}
			profiles++
			if profiles == 1 {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			js = map[string]any{"id": 1}
		case "create_link":
			checkCookie("session", fmt.Sprint(handshakes))
			links++
			if links == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			js = map[string]any{"cmd": srv.URL + "/play/stream.m3u8"}
		default:
			t.Errorf("unexpected action: %s", r.URL.Query().Get("action"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
	}))
	defer srv.Close()
	sharedClient := &http.Client{}
	c, err := New(Config{PortalURL: srv.URL, MAC: "aa:bb", HTTPClient: sharedClient, RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	c.retryBackoff = func(int) time.Duration { return 0 }
	source, err := c.Resolve(context.Background(), model.Item{Kind: "live", ID: "live:1", Command: "http://old/live"})
	if err != nil || handshakes != 2 || links != 2 {
		t.Fatalf("resolve: source=%+v error=%v handshakes=%d links=%d", source, err, handshakes, links)
	}
	req, _ := http.NewRequest(http.MethodGet, source.URL, nil)
	for key, value := range source.Headers {
		req.Header.Set(key, value)
	}
	resp, err := sharedClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	for _, foreign := range []string{"https://" + c.endpoint.Host + "/play", "http://different.test/play"} {
		u, _ := url.Parse(foreign)
		headers, err := c.playbackHeaders(context.Background(), u)
		if err != nil || headers["Cookie"] != "" || headers["Authorization"] != "" {
			t.Fatalf("foreign origin received session: %v %v", headers, err)
		}
	}
	other, err := New(Config{PortalURL: srv.URL, MAC: "other", HTTPClient: sharedClient})
	if err != nil || len(other.http.Jar.Cookies(c.endpoint)) != 0 || sharedClient.Jar != nil {
		t.Fatal("portal affinity leaked through a shared HTTP client")
	}
}

func TestLogicalRequestDeadlineIncludesAuthentication(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-r.Context().Done():
			return
		case <-time.After(40 * time.Millisecond):
		}
		js := map[string]any{"id": 1}
		if r.URL.Query().Get("action") == "handshake" {
			js = map[string]any{"token": "token"}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestTimeout: 60 * time.Millisecond, RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Catalog(context.Background())
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 2 {
		t.Fatalf("authentication reset request budget: calls=%d error=%v", calls.Load(), err)
	}
}

func TestLogicalRequestDeadlineIncludesQueuedTime(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL, MAC: "aa:bb", RequestTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer c.mu.release()
	for _, operation := range []struct {
		name string
		run  func() error
	}{
		{"catalog", func() error { _, err := c.Catalog(context.Background()); return err }},
		{"series metadata", func() error {
			_, err := c.Browse(context.Background(), model.BrowseQuery{Kind: "series", Page: 1})
			return err
		}},
		{"guide metadata", func() error { _, err := c.EPG(context.Background()); return err }},
	} {
		t.Run(operation.name, func(t *testing.T) {
			err := operation.run()
			if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 0 {
				t.Fatalf("queue exceeded request budget: calls=%d error=%v", calls.Load(), err)
			}
		})
	}
}
