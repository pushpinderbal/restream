// Package stalker implements the Stalker portal wire protocol. The request shapes
// follow the publicly observable MAG portal API (handshake, get_ordered_list,
// get_epg_info, create_link); this implementation is original.
package stalker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/sync/semaphore"

	"github.com/pushpinderbal/restream/internal/model"
)

type Config struct {
	PortalURL, MAC, Timezone, UserAgent, SerialNumber, DeviceID, DeviceID2 string
	HTTPClient                                                             *http.Client
	MaxResponseBytes                                                       int64
	RequestTimeout                                                         time.Duration
	RequestInterval                                                        time.Duration
	EPGHours                                                               int
}

type Client struct {
	cfg             Config
	endpoint        *url.URL
	http            *http.Client
	loc             *time.Location
	mu              *semaphore.Weighted
	token           string
	channels        []model.Item
	epgIDs          map[string]string
	discovery       *url.URL
	nextRequest     time.Time
	currentInterval time.Duration
	successStreak   int
	retryBackoff    func(int) time.Duration
	saveCooldown    func(time.Time) error
	seriesSource    string // protected by mu; learned from category discovery
}

var _ model.Provider = (*Client)(nil)
var _ model.BrowseProvider = (*Client)(nil)

const (
	defaultMaxResponseBytes int64 = 64 << 20
	maxAllowedResponseBytes int64 = 512 << 20
	maxAdaptiveInterval           = 30 * time.Second
	successesBeforeEase           = 20
)

const defaultUA = "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 4 rev: 2116 Mobile Safari/533.3"

// RateLimitError reports a portal cooldown without exposing its URL or identity.
// RetryAfter is the remaining wait at the time the retry budget was exhausted.
type RateLimitError struct {
	Action     string
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("portal %s rate limited; retry after %s", e.Action, e.RetryAfter.Round(time.Millisecond))
}

func (e *RateLimitError) RetryDelay() time.Duration { return e.RetryAfter }

// ConfigureCooldown restores a saved portal deadline and installs its persistence
// callback. Call it once during startup, before issuing portal requests.
func (c *Client) ConfigureCooldown(until time.Time, save func(time.Time) error) {
	_ = c.mu.Acquire(context.Background(), 1)
	defer c.mu.Release(1)
	if until.After(c.nextRequest) {
		c.nextRequest = until
	}
	c.saveCooldown = save
}

type portalHTTPError struct {
	action string
	status int
}

type portalUnsupportedError struct {
	typ, action string
}

func (e *portalUnsupportedError) Error() string {
	return fmt.Sprintf("portal %s/%s unavailable", e.typ, e.action)
}

func (e *portalHTTPError) Error() string {
	return fmt.Sprintf("portal %s failed: HTTP %d", e.action, e.status)
}

func unsupported(err error) bool {
	var unsupportedErr *portalUnsupportedError
	if errors.As(err, &unsupportedErr) {
		return true
	}
	var httpErr *portalHTTPError
	return errors.As(err, &httpErr) && (httpErr.status == http.StatusNotFound || httpErr.status == http.StatusNotImplemented)
}

func New(cfg Config) (*Client, error) {
	if cfg.RequestInterval < 0 {
		return nil, errors.New("invalid portal request interval")
	}
	if cfg.RequestInterval == 0 {
		cfg.RequestInterval = 250 * time.Millisecond
	}
	if cfg.RequestTimeout < 0 {
		return nil, errors.New("invalid portal request timeout")
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = time.Minute
	}
	if cfg.EPGHours < 0 || cfg.EPGHours > 168 {
		return nil, errors.New("invalid EPG hours")
	}
	if cfg.EPGHours == 0 {
		cfg.EPGHours = 6
	}
	if cfg.MaxResponseBytes < 0 || cfg.MaxResponseBytes > maxAllowedResponseBytes {
		return nil, errors.New("invalid maximum portal response size")
	}
	if cfg.MaxResponseBytes == 0 {
		cfg.MaxResponseBytes = defaultMaxResponseBytes
	}
	if strings.TrimSpace(cfg.PortalURL) == "" || strings.TrimSpace(cfg.MAC) == "" {
		return nil, errors.New("portal URL and MAC are required")
	}
	u, e := url.Parse(strings.TrimSpace(cfg.PortalURL))
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errors.New("invalid portal URL")
	}
	u.RawQuery = ""
	u.Fragment = ""
	rootURL := *u
	p := strings.TrimRight(u.Path, "/")
	switch {
	case strings.HasSuffix(p, "/server/load.php"), strings.HasSuffix(p, "/portal.php"):
		u.Path = p
	case strings.HasSuffix(p, "/stalker_portal/c"), strings.HasSuffix(p, "/stalker_portal"):
		u.Path = strings.TrimSuffix(strings.TrimSuffix(p, "/c"), "/stalker_portal") + "/stalker_portal/server/load.php"
	case strings.HasSuffix(p, "/c"):
		u.Path = strings.TrimSuffix(p, "/c") + "/server/load.php"
	default:
		u.Path = p + "/server/load.php"
	}
	if cfg.Timezone == "" {
		cfg.Timezone = "UTC"
	}
	loc, e := time.LoadLocation(cfg.Timezone)
	if e != nil {
		return nil, errors.New("invalid timezone")
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = defaultUA
	}
	h := cfg.HTTPClient
	if h == nil {
		h = &http.Client{Timeout: cfg.RequestTimeout}
	}
	c := &Client{cfg: cfg, endpoint: u, http: h, loc: loc, mu: semaphore.NewWeighted(1), currentInterval: cfg.RequestInterval, retryBackoff: jitterBackoff}
	if rootURL.Path == "" || rootURL.Path == "/" {
		c.discovery = &rootURL
	}
	return c, nil
}

func (c *Client) request(ctx context.Context, typ, action string, q url.Values) (json.RawMessage, error) {
	if e := c.lock(ctx); e != nil {
		return nil, e
	}
	defer c.mu.Release(1)
	if c.token == "" {
		if e := c.login(ctx); e != nil {
			return nil, e
		}
	}
	js, status, e := c.call(ctx, typ, action, q, c.token)
	optionalSeriesCategories := typ == "series" && action == "get_categories"
	invalidResponse := func(js json.RawMessage) bool {
		return invalidToken(js) && !(optionalSeriesCategories && nullOrFalse(js))
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden || (e == nil && invalidResponse(js)) {
		c.token = ""
		if e = c.login(ctx); e != nil {
			return nil, e
		}
		js, status, e = c.call(ctx, typ, action, q, c.token)
	}
	if e != nil {
		return nil, e
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return nil, fmt.Errorf("portal %s/%s authorization failed", typ, action)
	}
	if status < 200 || status >= 300 {
		return nil, &portalHTTPError{action: action, status: status}
	}
	if invalidResponse(js) {
		return nil, fmt.Errorf("portal %s/%s authorization expired", typ, action)
	}
	return js, nil
}

func nullOrFalse(js json.RawMessage) bool {
	s := strings.TrimSpace(string(js))
	return s == "null" || s == "false"
}

func (c *Client) lock(ctx context.Context) error {
	return c.mu.Acquire(ctx, 1)
}

func (c *Client) login(ctx context.Context) error {
	if c.discovery != nil {
		if e := c.discover(ctx); e != nil {
			return e
		}
	}
	q := url.Values{}
	q.Set("token", "")
	js, status, e := c.call(ctx, "stb", "handshake", q, "")
	if e != nil {
		return e
	}
	if status < 200 || status >= 300 {
		return errors.New("portal handshake failed")
	}
	var v map[string]json.RawMessage
	if json.Unmarshal(js, &v) != nil {
		return errors.New("invalid portal handshake")
	}
	token := str(v, "token")
	if token == "" {
		return errors.New("portal handshake returned no token")
	}
	q = url.Values{"hd": {"1"}, "stb_type": {"MAG250"}, "auth_second_step": {"1"}, "sn": {c.cfg.SerialNumber}, "device_id": {c.cfg.DeviceID}, "device_id2": {c.cfg.DeviceID2}}
	profile, status, e := c.call(ctx, "stb", "get_profile", q, token)
	if e != nil {
		return e
	}
	if status < 200 || status >= 300 || invalidToken(profile) {
		return errors.New("portal stb/get_profile authorization failed")
	}
	c.token = token
	return nil
}

// discover follows a portal landing-page redirect once. A root URL can redirect
// to /stalker_portal/c; no MAG credentials are sent during discovery.
func (c *Client) discover(ctx context.Context) error {
	target := c.discovery
	// Keep redirects explicit so both landing requests pass through the shared
	// rate limiter. Discovery sends no MAG identity.
	h := *c.http
	h.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	final := target
	for i := 0; i < 2; i++ {
		req, e := http.NewRequestWithContext(ctx, "GET", final.String(), nil)
		if e != nil {
			return nil
		}
		req.Header.Set("User-Agent", c.cfg.UserAgent)
		resp, e := c.doRateLimited(ctx, req, "discovery", &h)
		if e != nil {
			return e
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 300 || resp.StatusCode >= 400 {
			break
		}
		next, e := final.Parse(resp.Header.Get("Location"))
		if e != nil || next.Host != target.Host || (next.Scheme != "http" && next.Scheme != "https") {
			break
		}
		final = next
	}
	if final.Host != target.Host {
		return nil
	}
	p := strings.TrimRight(final.Path, "/")
	if strings.HasSuffix(p, "/stalker_portal/c") || strings.HasSuffix(p, "/stalker_portal") {
		u := *final
		u.Path = strings.TrimSuffix(strings.TrimSuffix(p, "/c"), "/stalker_portal") + "/stalker_portal/server/load.php"
		u.RawQuery = ""
		u.Fragment = ""
		c.endpoint = &u
	}
	c.discovery = nil
	return nil
}

func (c *Client) call(ctx context.Context, typ, action string, q url.Values, token string) (json.RawMessage, int, error) {
	v := url.Values{}
	for k, x := range q {
		v[k] = append([]string(nil), x...)
	}
	v.Set("type", typ)
	v.Set("action", action)
	v.Set("JsHttpRequest", "1-xml")
	u := *c.endpoint
	u.RawQuery = v.Encode()
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return nil, 0, errors.New("invalid portal request")
	}
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	req.Header.Set("X-User-Agent", "Model: MAG250; Link: Ethernet")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Cookie", "mac="+url.QueryEscape(c.cfg.MAC)+"; stb_lang=en; timezone="+url.QueryEscape(c.cfg.Timezone)+"; sn="+url.QueryEscape(c.cfg.SerialNumber))
	req.Header.Set("Referer", c.endpoint.Scheme+"://"+c.endpoint.Host+"/")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, e := c.doRateLimited(ctx, req, action, c.http)
	if e != nil {
		return nil, 0, e
	}
	defer resp.Body.Close()
	b, e := io.ReadAll(io.LimitReader(resp.Body, c.cfg.MaxResponseBytes+1))
	if e != nil {
		return nil, resp.StatusCode, fmt.Errorf("portal %s response failed", action)
	}
	if int64(len(b)) > c.cfg.MaxResponseBytes {
		return nil, resp.StatusCode, fmt.Errorf("portal %s response exceeds configured size limit (%d bytes; set STALKER_MAX_RESPONSE_MB)", action, c.cfg.MaxResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, resp.StatusCode, nil
	}
	if plaintextAuthFailure(b) {
		return nil, http.StatusUnauthorized, nil
	}
	var wrap struct {
		JS json.RawMessage `json:"js"`
	}
	if json.Unmarshal(b, &wrap) != nil || len(wrap.JS) == 0 {
		return nil, resp.StatusCode, fmt.Errorf("portal %s returned invalid data", action)
	}
	return wrap.JS, resp.StatusCode, nil
}

func (c *Client) doRateLimited(ctx context.Context, req *http.Request, action string, h *http.Client) (*http.Response, error) {
	// Redirects must be explicit; an automatic redirect would send an unpaced
	// request, potentially forwarding MAG credentials to another endpoint.
	boundedClient := *h
	boundedClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	requestType := req.URL.Query().Get("type")
	requestAttrs := []any{"type", requestType, "action", action}
	if action == "get_ordered_list" {
		if page, e := strconv.Atoi(req.URL.Query().Get("p")); e == nil && page >= 0 {
			requestAttrs = append(requestAttrs, "page", page)
		}
	}
	for attempt := 0; attempt <= 3; attempt++ {
		if e := c.waitRequest(ctx); e != nil {
			return nil, e
		}
		resp, e := boundedClient.Do(req)
		if e != nil {
			c.successStreak = 0
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("portal %s request failed", action)
		}
		if resp.StatusCode != http.StatusTooManyRequests {
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				c.recordSuccess()
			} else {
				c.successStreak = 0
			}
			if attempt > 0 && resp.StatusCode >= 200 && resp.StatusCode < 300 {
				slog.Debug("Portal request resumed after rate limit", append(requestAttrs, "attempts", attempt+1)...)
			}
			return resp, nil
		}
		_ = resp.Body.Close()
		c.increaseInterval()
		delay := c.retryDelay(resp.Header.Get("Retry-After"), attempt)
		until := time.Now().Add(max(delay, c.currentInterval))
		if until.After(c.nextRequest) {
			c.nextRequest = until
		}
		message := "Portal rate limited; retrying same request"
		if attempt == 3 {
			message = "Portal retry budget exhausted"
		}
		slog.Warn(message, append(requestAttrs, "attempt", attempt+1, "max_attempts", 4, "retry_delay", delay, "request_interval", c.currentInterval, "cooldown_until", c.nextRequest.UTC(), "retry_same_page", attempt < 3)...)
		if c.saveCooldown != nil {
			if e := c.saveCooldown(c.nextRequest); e != nil {
				return nil, errors.New("portal cooldown could not be saved")
			}
		}
		if attempt == 3 {
			return nil, &RateLimitError{Action: action, RetryAfter: time.Until(c.nextRequest)}
		}
	}
	return nil, errors.New("portal retry limit exceeded")
}

// The request semaphore also guards the adaptive interval and streak.
func (c *Client) increaseInterval() {
	c.successStreak = 0
	ceiling := max(maxAdaptiveInterval, c.cfg.RequestInterval)
	previous := c.currentInterval
	if c.currentInterval >= ceiling/2 {
		c.currentInterval = ceiling
	} else {
		c.currentInterval *= 2
	}
	if c.currentInterval != previous {
		slog.Debug("Portal request spacing increased", "previous", previous, "current", c.currentInterval)
	}
}

func (c *Client) recordSuccess() {
	c.successStreak++
	if c.successStreak < successesBeforeEase {
		return
	}
	c.successStreak = 0
	if c.currentInterval <= c.cfg.RequestInterval {
		return
	}
	previous := c.currentInterval
	c.currentInterval = max(c.cfg.RequestInterval, c.currentInterval-max(time.Nanosecond, c.currentInterval/5))
	slog.Debug("Portal request spacing eased", "previous", previous, "current", c.currentInterval, "successful_requests", successesBeforeEase)
}

// waitRequest is called with c.mu held, serializing all MAG calls and keeping
// the portal cooldown in force even after a caller's retry budget is exhausted.
func (c *Client) waitRequest(ctx context.Context) error {
	if d := time.Until(c.nextRequest); d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
	if e := ctx.Err(); e != nil {
		return e
	}
	c.nextRequest = time.Now().Add(c.currentInterval)
	return nil
}

func (c *Client) retryDelay(header string, attempt int) time.Duration {
	backoff := c.retryBackoff(attempt)
	header = strings.TrimSpace(header)
	if seconds, e := strconv.ParseUint(header, 10, 64); e == nil {
		if seconds > math.MaxInt64/uint64(time.Second) {
			return time.Duration(math.MaxInt64)
		}
		return max(backoff, time.Duration(seconds)*time.Second)
	}
	if header != "" && strings.Trim(header, "0123456789") == "" {
		return time.Duration(math.MaxInt64)
	}
	if date, e := http.ParseTime(header); e == nil {
		if delay := time.Until(date); delay > 0 {
			return max(backoff, delay)
		}
		return backoff
	}
	return backoff
}

func jitterBackoff(attempt int) time.Duration {
	// Every 429 has a retry floor, including a valid Retry-After: 0.
	base := 5 * time.Second << attempt
	return time.Duration(float64(base) * (0.75 + rand.Float64()*0.5))
}

func plaintextAuthFailure(body []byte) bool {
	if len(body) > 128 {
		return false
	}
	msg := strings.TrimSuffix(strings.TrimSpace(string(body)), ".")
	return strings.EqualFold(msg, "Authorization failed") || strings.EqualFold(msg, "Unauthorized request")
}

func invalidToken(js json.RawMessage) bool {
	s := strings.ToLower(strings.TrimSpace(string(js)))
	if s == "false" || s == "null" {
		return true
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(js, &m) != nil {
		return false
	}
	for _, k := range []string{"error", "text", "message"} {
		x := strings.ToLower(str(m, k))
		if strings.Contains(x, "token") && (strings.Contains(x, "invalid") || strings.Contains(x, "expir") || strings.Contains(x, "authoriz")) {
			return true
		}
	}
	return false
}

func str(m map[string]json.RawMessage, keys ...string) string {
	for _, k := range keys {
		b := m[k]
		if len(b) == 0 || string(b) == "null" {
			continue
		}
		var s string
		if json.Unmarshal(b, &s) == nil && s != "" {
			return s
		}
		var n json.Number
		if json.Unmarshal(b, &n) == nil {
			return n.String()
		}
	}
	return ""
}
func flag(m map[string]json.RawMessage, k string) bool {
	var native bool
	if json.Unmarshal(m[k], &native) == nil {
		return native
	}
	s := strings.ToLower(str(m, k))
	return s == "1" || s == "true" || s == "yes"
}
func rows(js json.RawMessage) ([]map[string]json.RawMessage, int, error) {
	var out []map[string]json.RawMessage
	if json.Unmarshal(js, &out) == nil {
		return out, 0, nil
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(js, &m) != nil {
		return nil, 0, errors.New("invalid portal list")
	}
	for _, k := range []string{"data", "items", "epg"} {
		if b := m[k]; len(b) > 0 {
			if json.Unmarshal(b, &out) == nil {
				n, _ := strconv.Atoi(str(m, "total_items", "total", "count"))
				return out, n, nil
			}
		}
	}
	return nil, 0, nil
}
func (c *Client) asset(s string) string {
	if s == "" {
		return ""
	}
	ref, e := url.Parse(s)
	if e != nil {
		return ""
	}
	if ref.Scheme != "" && ref.Scheme != "http" && ref.Scheme != "https" {
		return ""
	}
	base := *c.endpoint
	base.RawQuery = ""
	base.Fragment = ""
	return base.ResolveReference(ref).String()
}
func id(kind, s string) string { return kind + ":" + s }

func (c *Client) Catalog(ctx context.Context) ([]model.Item, error) {
	return c.live(ctx)
}

// Categories retrieves navigation metadata only. It never downloads VOD pages.
// When the series endpoint is unavailable, MAG installations commonly bundle
// series in VOD. Category metadata and clear title hints decide which section
// gets each category; ambiguous labels remain accessible in both sections.
// A populated dedicated series list is authoritative for series navigation.
func (c *Client) Categories(ctx context.Context) ([]model.Category, error) {
	genres, err := c.genreCategories(ctx)
	if err != nil && !unsupported(err) {
		return nil, err
	}
	vod, err := c.categories(ctx, "vod")
	if err != nil {
		return nil, err
	}
	series, err := c.categories(ctx, "series")
	seriesSource := "series"
	if unsupported(err) {
		seriesSource = "vod"
		series = nil
	} else if err != nil {
		return nil, err
	} else {
		usable := false
		for _, cat := range series {
			if !allCategory(cat.id, cat.name) {
				usable = true
				break
			}
		}
		if !usable {
			seriesSource = "vod"
		}
	}
	if err := c.lock(ctx); err != nil {
		return nil, err
	}
	c.seriesSource = seriesSource
	c.mu.Release(1)
	out := make([]model.Category, 0, len(genres)+2*len(vod)+len(series))
	for _, pair := range withoutAll(genres) {
		out = append(out, model.Category{ID: pair[0], Name: pair[1], Kind: "live", SourceType: "itv"})
	}
	for _, cat := range vod {
		if allCategory(cat.id, cat.name) {
			continue
		}
		kind := categoryKind(cat)
		if kind != "series" {
			out = append(out, model.Category{ID: cat.id, Name: cat.name, Kind: "movie", SourceType: "vod"})
		}
		if seriesSource == "vod" && kind != "movie" {
			out = append(out, model.Category{ID: cat.id, Name: cat.name, Kind: "series", SourceType: "vod"})
		}
	}
	for _, cat := range series {
		if !allCategory(cat.id, cat.name) {
			out = append(out, model.Category{ID: cat.id, Name: cat.name, Kind: "series", SourceType: seriesSource})
		}
	}
	return out, nil
}

// Browse fetches exactly one 1-based ordered-list page. Filtering mixed VOD
// rows changes the visible items, but pagination follows the portal's raw page
// and total so a page containing only the other kind does not end browsing.
func (c *Client) Browse(ctx context.Context, query model.BrowseQuery) (model.BrowsePage, error) {
	if query.Kind != "movie" && query.Kind != "series" {
		return model.BrowsePage{}, errors.New("invalid browse kind")
	}
	if query.Page < 1 || query.Page > 10000 {
		return model.BrowsePage{}, errors.New("invalid browse page")
	}
	if len(query.Search) > 200 {
		return model.BrowsePage{}, errors.New("browse search is too long")
	}
	typ := query.SourceType
	if typ == "" {
		if query.Kind == "movie" {
			typ = "vod"
		} else {
			if err := c.lock(ctx); err != nil {
				return model.BrowsePage{}, err
			}
			typ = c.seriesSource
			c.mu.Release(1)
			if typ == "" {
				typ = "series"
			}
		}
	}
	if typ != "vod" && typ != "series" || (query.Kind == "movie" && typ != "vod") {
		return model.BrowsePage{}, errors.New("invalid browse source")
	}
	if query.Kind == "series" && typ == "series" {
		if err := c.lock(ctx); err != nil {
			return model.BrowsePage{}, err
		}
		if c.seriesSource == "vod" {
			typ = "vod"
		}
		c.mu.Release(1)
	}
	category := query.Category
	if category == "" {
		category = "*"
	}
	q := url.Values{"p": {strconv.Itoa(query.Page)}, "category": {category}, "genre": {"0"}, "sortby": {"added"}}
	searchWords := searchTokens(query.Search)
	if len(searchWords) > 0 {
		q.Set("search", searchTerm(searchWords))
	}
	js, err := c.request(ctx, typ, "get_ordered_list", q)
	if query.Kind == "series" && typ == "series" && unsupported(err) {
		typ = "vod"
		js, err = c.request(ctx, typ, "get_ordered_list", q)
		if err == nil {
			if lockErr := c.lock(ctx); lockErr != nil {
				return model.BrowsePage{}, lockErr
			}
			c.seriesSource = "vod"
			c.mu.Release(1)
		}
	}
	if err != nil {
		return model.BrowsePage{}, err
	}
	if len(js) == 0 || nullOrFalse(js) {
		return model.BrowsePage{}, errors.New("invalid portal ordered list")
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(js, &shape) == nil {
		list := shape["data"]
		if len(list) == 0 {
			list = shape["items"]
		}
		var rawItems []map[string]json.RawMessage
		if len(list) == 0 || string(list) == "null" || json.Unmarshal(list, &rawItems) != nil {
			return model.BrowsePage{}, errors.New("invalid portal ordered list")
		}
	}
	raw, total, err := rows(js)
	if err != nil {
		return model.BrowsePage{}, err
	}
	pageSize := len(raw)
	var meta map[string]json.RawMessage
	if json.Unmarshal(js, &meta) == nil {
		if n, parseErr := strconv.Atoi(str(meta, "max_page_items")); parseErr == nil && n > 0 {
			pageSize = n
		}
	}
	items := make([]model.Item, 0, len(raw))
	seen := make(map[string]bool, len(raw))
	for _, row := range raw {
		pid := str(row, "id", "video_id")
		if pid == "" {
			continue
		}
		kind := "movie"
		if typ == "series" || flag(row, "is_series") {
			kind = "series"
		}
		if kind != query.Kind {
			continue
		}
		if !matchesSearch(str(row, "name"), searchWords) {
			continue
		}
		itemID := id(kind, pid)
		if seen[itemID] {
			continue
		}
		seen[itemID] = true
		seriesID := ""
		if kind == "series" {
			seriesID = pid
		}
		season, _ := strconv.Atoi(str(row, "season_number"))
		episode, _ := strconv.Atoi(str(row, "series_number", "episode_number"))
		categoryID := str(row, "category_id", "tv_genre_id", "genre_id")
		if categoryID == "" && category != "*" {
			categoryID = category
		}
		items = append(items, model.Item{ID: itemID, Kind: kind, CategoryID: categoryID, Category: str(row, "category_name", "category_title"), ProviderID: pid, SeriesID: seriesID, EpisodeID: pid, Name: str(row, "name"), Number: str(row, "number"), Logo: c.asset(str(row, "screenshot_uri", "logo")), Command: str(row, "cmd"), Description: str(row, "description", "plot"), Duration: duration(row), Season: season, Episode: episode})
	}
	hasMore := len(raw) > 0
	if total > 0 && pageSize > 0 {
		hasMore = hasMore && query.Page*pageSize < total
	}
	return model.BrowsePage{Items: items, Page: query.Page, Total: total, HasMore: hasMore}, nil
}

func withoutAll(cats [][2]string) [][2]string {
	if len(cats) < 2 {
		return cats
	}
	out := make([][2]string, 0, len(cats))
	for _, cat := range cats {
		label := strings.ToLower(strings.TrimSpace(cat[1]))
		if cat[0] == "0" || cat[0] == "*" || label == "all" || strings.HasPrefix(label, "all ") {
			continue
		}
		out = append(out, cat)
	}
	if len(out) == 0 {
		return cats
	}
	return out
}
func allCategory(id, name string) bool {
	label := strings.ToLower(strings.TrimSpace(name))
	return id == "0" || id == "*" || label == "all" || strings.HasPrefix(label, "all ")
}

type portalCategory struct {
	id, name, kind string
}

// Explicit portal type takes precedence. Labels are only used when they name
// a medium clearly; geography, language, and popularity do not imply a kind.
func categoryKind(cat portalCategory) string {
	switch strings.ToLower(strings.TrimSpace(cat.kind)) {
	case "movie", "movies", "film", "films", "cinema":
		return "movie"
	case "series", "serial", "tv_series", "tvseries", "tv_show", "tvshow", "shows":
		return "series"
	}
	words := searchTokens(cat.name)
	movie, series := false, false
	for _, word := range words {
		switch word {
		case "movie", "movies", "film", "films", "cinema":
			movie = true
		case "series", "serial", "serials", "season", "seasons", "show", "shows":
			series = true
		}
	}
	if movie && !series {
		return "movie"
	}
	if series && !movie {
		return "series"
	}
	return ""
}

func searchTokens(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
}

func searchTerm(words []string) string {
	term := ""
	for _, word := range words {
		if len(word) > len(term) {
			term = word
		}
	}
	return term
}

func matchesSearch(name string, words []string) bool {
	if len(words) == 0 {
		return true
	}
	title := strings.Join(searchTokens(name), " ")
	for _, word := range words {
		if !strings.Contains(title, word) {
			return false
		}
	}
	return true
}

func (c *Client) categories(ctx context.Context, typ string) ([]portalCategory, error) {
	js, e := c.request(ctx, typ, "get_categories", nil)
	if e != nil {
		return nil, e
	}
	if typ == "series" && nullOrFalse(js) {
		return nil, &portalUnsupportedError{typ: typ, action: "get_categories"}
	}
	rr, _, e := rows(js)
	if e != nil {
		return nil, e
	}
	out := make([]portalCategory, 0, len(rr))
	for _, r := range rr {
		cid := str(r, "id")
		if cid != "" {
			kind := str(r, "category_type", "type", "content_type")
			if value, present := r["is_series"]; present {
				var enabled bool
				if json.Unmarshal(value, &enabled) == nil {
					if enabled {
						kind = "series"
					} else {
						kind = "movie"
					}
				} else if marker := strings.ToLower(str(r, "is_series")); marker == "1" || marker == "true" {
					kind = "series"
				} else if marker == "0" || marker == "false" {
					kind = "movie"
				}
			}
			out = append(out, portalCategory{id: cid, name: str(r, "title", "alias"), kind: kind})
		}
	}
	return out, nil
}
func (c *Client) live(ctx context.Context) ([]model.Item, error) {
	js, e := c.request(ctx, "itv", "get_all_channels", nil)
	if e != nil {
		return nil, e
	}
	rr, _, e := rows(js)
	if e != nil {
		return nil, e
	}
	cats, e := c.genreCategories(ctx)
	if e != nil && !unsupported(e) {
		return nil, e
	}
	labels := map[string]string{}
	for _, p := range cats {
		labels[p[0]] = p[1]
	}
	out := make([]model.Item, 0, len(rr))
	epgIDs := map[string]string{}
	for _, r := range rr {
		pid := str(r, "id")
		if pid == "" {
			continue
		}
		cmd := str(r, "cmd")
		if cmd == "" {
			var cmds []map[string]json.RawMessage
			_ = json.Unmarshal(r["cmds"], &cmds)
			if len(cmds) > 0 {
				cmd = str(cmds[0], "cmd")
			}
		}
		if cmd == "" {
			cmd = pid
		}
		epgID := str(r, "ch_id")
		if epgID == "" {
			var cmds []map[string]json.RawMessage
			_ = json.Unmarshal(r["cmds"], &cmds)
			if len(cmds) > 0 {
				epgID = str(cmds[0], "ch_id")
			}
		}
		if epgID == "" {
			epgID = pid
		}
		epgIDs[id("live", pid)] = epgID
		categoryID := str(r, "tv_genre_id", "category_id", "genre_id")
		out = append(out, model.Item{ID: id("live", pid), Kind: "live", ProviderID: pid, Name: str(r, "name"), Number: str(r, "number", "ord"), CategoryID: categoryID, Category: labels[categoryID], Logo: c.asset(str(r, "logo", "icon", "screenshot_uri")), Command: cmd})
	}
	if e := c.lock(ctx); e != nil {
		return nil, e
	}
	c.channels = append([]model.Item(nil), out...)
	c.epgIDs = epgIDs
	c.mu.Release(1)
	return out, nil
}
func (c *Client) genreCategories(ctx context.Context) ([][2]string, error) {
	js, e := c.request(ctx, "itv", "get_genres", nil)
	if e != nil {
		return nil, e
	}
	rr, _, e := rows(js)
	if e != nil {
		return nil, e
	}
	out := make([][2]string, 0, len(rr))
	for _, r := range rr {
		out = append(out, [2]string{str(r, "id"), str(r, "title")})
	}
	return out, nil
}

func (c *Client) ordered(ctx context.Context, typ, category, movie, season, episode string) ([]model.Item, error) {
	out := []model.Item{}
	seen := map[string]bool{}
	total, rawRows, missingIDRows, stale := 0, 0, 0, 0
	shortfallConfirmPage := -1
	lastPageRows, lastPageCapacity := 0, 0
	for page := 0; page < 10000; page++ {
		q := url.Values{"p": {strconv.Itoa(page)}}
		if category != "" {
			q.Set("category", category)
		}
		if movie != "" {
			q.Set("movie_id", movie)
		}
		if season != "" {
			q.Set("season_id", season)
		}
		if episode != "" {
			q.Set("episode_id", episode)
		}
		js, e := c.request(ctx, typ, "get_ordered_list", q)
		if e != nil {
			return nil, e
		}
		// A missing or malformed list is not an end-of-list marker. Some
		// portals answer unknown actions with a valid JSON object or false.
		var shape map[string]json.RawMessage
		if json.Unmarshal(js, &shape) == nil {
			list := shape["data"]
			if len(list) == 0 {
				list = shape["items"]
			}
			var parsed []map[string]json.RawMessage
			if len(list) == 0 || string(list) == "null" || json.Unmarshal(list, &parsed) != nil {
				return nil, errors.New("invalid portal episode list")
			}
		}
		rr, n, e := rows(js)
		if e != nil {
			return nil, e
		}
		if n > total {
			total = n
		}
		if len(rr) == 0 {
			if !listComplete(len(out), rawRows, total) {
				// A short final page followed by an empty page is evidence of
				// the actual end, even when reported total is slightly high.
				// Limit the discrepancy to unused slots on that final page.
				shortfall := total - rawRows
				if page > 0 && len(out) > 0 && lastPageCapacity > 0 && lastPageRows > 0 && lastPageRows < lastPageCapacity && shortfall > 0 && shortfall <= lastPageCapacity-lastPageRows {
					if shortfallConfirmPage != page {
						shortfallConfirmPage = page
						page-- // retry the same terminal page once before accepting it
						continue
					}
					slog.Warn("Portal episode list total exceeds available rows", "source", typ, "stored_unique", len(out), "raw_rows", rawRows, "reported_total", total)
					return out, nil
				}
				return nil, fmt.Errorf("portal list incomplete: received %d distinct items and %d counted rows of %d", len(out), rawRows, total)
			}
			if total > len(out) {
				slog.Info("Portal list completed with fewer stored items than rows", "kind", typ, "stored_unique", len(out), "raw_rows", rawRows, "skipped_without_id", missingIDRows, "total", total)
			}
			return out, nil
		}
		lastPageRows, lastPageCapacity = len(rr), 0
		if shape != nil {
			if capacity, parseErr := strconv.Atoi(str(shape, "max_page_items")); parseErr == nil && capacity > 0 {
				lastPageRows, lastPageCapacity = len(rr), capacity
			}
		}
		fresh := 0
		missingOnPage := 0
		for _, r := range rr {
			pid := str(r, "id", "video_id")
			if pid == "" {
				missingOnPage++
				continue
			}
			kind := "movie"
			if typ == "series" && movie == "" || flag(r, "is_series") {
				kind = "series"
			}
			if movie != "" {
				kind = "episode"
				if flag(r, "is_season") {
					kind = "season"
				}
			}
			sid := movie
			if sid == "" && kind == "series" {
				sid = pid
			}
			itemID := id(kind, pid)
			if kind == "episode" {
				itemID = "episode:" + movie + ":" + season + ":" + pid
			}
			if seen[itemID] {
				continue
			}
			seen[itemID] = true
			fresh++
			ep, _ := strconv.Atoi(str(r, "series_number", "episode_number"))
			sn, _ := strconv.Atoi(str(r, "season_number"))
			it := model.Item{ID: itemID, Kind: kind, ProviderID: pid, SeriesID: sid, EpisodeID: pid, Name: str(r, "name"), Number: str(r, "number"), Logo: c.asset(str(r, "screenshot_uri", "logo")), Command: str(r, "cmd"), Description: str(r, "description", "plot"), Duration: duration(r), Season: sn, Episode: ep}
			if kind == "episode" {
				it.EpisodeID = pid
			}
			out = append(out, it)
		}
		missingIDRows += missingOnPage
		if missingOnPage > 0 {
			slog.Warn("Portal list page contains rows without IDs", "kind", typ, "page", page, "missing_rows", missingOnPage)
		}
		if fresh == 0 && missingOnPage == 0 {
			stale++
		} else {
			stale = 0
			rawRows += len(rr)
		}
		if stale >= 2 {
			if !listComplete(len(out), rawRows, total) {
				return nil, fmt.Errorf("portal list incomplete: received %d distinct items and %d counted rows of %d", len(out), rawRows, total)
			}
			if total > len(out) {
				slog.Info("Portal list completed with fewer stored items than rows", "kind", typ, "stored_unique", len(out), "raw_rows", rawRows, "skipped_without_id", missingIDRows, "total", total)
			}
		}
		if total > 0 && len(out) >= total || stale >= 2 {
			return out, nil
		}
	}
	return nil, errors.New("portal list exceeds pagination limit")
}

func listComplete(distinct, rawRows, total int) bool {
	if total > 0 && distinct == 0 {
		return false
	}
	// A terminal empty or repeated page establishes the end. Count productive
	// rows separately from stored IDs because the portal total may include
	// duplicate IDs or rows without IDs. Fully repeated valid pages do not
	// advance rawRows.
	return total <= 0 || distinct >= total || rawRows >= total
}

func duration(r map[string]json.RawMessage) float64 {
	s := str(r, "duration", "time", "length")
	if n, e := strconv.ParseFloat(s, 64); e == nil {
		return n
	}
	parts := strings.Split(s, ":")
	if len(parts) == 3 {
		h, e1 := strconv.Atoi(parts[0])
		m, e2 := strconv.Atoi(parts[1])
		sec, e3 := strconv.Atoi(parts[2])
		if e1 == nil && e2 == nil && e3 == nil {
			return float64(h*3600 + m*60 + sec)
		}
	}
	return 0
}

func (c *Client) Episodes(ctx context.Context, series model.Item) ([]model.Item, error) {
	if series.Kind != "series" {
		return nil, errors.New("episodes require a series")
	}
	sid := series.ProviderID
	if sid == "" {
		sid = strings.TrimPrefix(series.ID, "series:")
	}
	if sid == "" {
		return nil, errors.New("series ID is missing")
	}
	// Portals differ: some return episodes directly, others return season rows.
	first, e := c.ordered(ctx, "vod", "", sid, "0", "0")
	if e != nil {
		return nil, e
	}
	out := make([]model.Item, 0)
	seen := map[string]bool{}
	appendEpisodes := func(list []model.Item, season string, displaySeason int) {
		for _, it := range list {
			it.Kind = "episode"
			it.SeriesID = sid
			if season != "" && season != "0" {
				it.ID = "episode:" + sid + ":" + season + ":" + it.ProviderID
				if it.Season == 0 {
					it.Season = displaySeason
				}
			}
			if it.Name == "" {
				it.Name = series.Name
			}
			if it.Logo == "" {
				it.Logo = series.Logo
			}
			if !seen[it.ID] {
				out = append(out, it)
				seen[it.ID] = true
			}
		}
	}
	for idx, row := range first {
		// A season marker can be explicit, or a row without a command that leads to episodes.
		seasonID := row.ProviderID
		displaySeason := seasonNumber(row, idx+1)
		if (row.Kind == "season" || row.Command == "") && seasonID != "" {
			episodes, e := c.ordered(ctx, "vod", "", sid, seasonID, "0")
			if e != nil {
				return nil, e
			}
			if len(episodes) > 0 {
				appendEpisodes(episodes, seasonID, displaySeason)
				continue
			}
		}
		appendEpisodes([]model.Item{row}, "0", 0)
	}
	if len(out) > 0 {
		return out, nil
	}
	// Some installations expose seasons through type=series and episodes via season_id.
	seasons, e := c.ordered(ctx, "series", "", sid, "0", "0")
	if e != nil {
		return nil, e
	}
	for idx, s := range seasons {
		eps, e := c.ordered(ctx, "series", "", sid, s.ProviderID, "0")
		if e != nil {
			return nil, e
		}
		appendEpisodes(eps, s.ProviderID, seasonNumber(s, idx+1))
	}
	return out, nil
}

var seasonTitle = regexp.MustCompile(`(?i)(?:^|\b)(?:season\s*|s)([0-9]+)(?:\b|$)`)

func seasonNumber(row model.Item, fallback int) int {
	if row.Season > 0 {
		return row.Season
	}
	if n, e := strconv.Atoi(strings.TrimSpace(row.Number)); e == nil && n > 0 {
		return n
	}
	if match := seasonTitle.FindStringSubmatch(row.Name); len(match) == 2 {
		if n, e := strconv.Atoi(match[1]); e == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func (c *Client) EPG(ctx context.Context) ([]model.Program, error) {
	if e := c.lock(ctx); e != nil {
		return nil, e
	}
	channels := append([]model.Item(nil), c.channels...)
	epgIDs := c.epgIDs
	c.mu.Release(1)
	if len(channels) == 0 {
		var e error
		channels, e = c.live(ctx)
		if e != nil {
			return nil, e
		}
		if e := c.lock(ctx); e != nil {
			return nil, e
		}
		epgIDs = c.epgIDs
		c.mu.Release(1)
	}
	channelByEPG := map[string]string{}
	for _, ch := range channels {
		epgID := epgIDs[ch.ID]
		if epgID == "" {
			epgID = ch.ProviderID
		}
		channelByEPG[epgID] = ch.ID
		channelByEPG[ch.ProviderID] = ch.ID
	}
	out := make([]model.Program, 0)
	add := func(id string, rr []map[string]json.RawMessage) {
		for _, r := range rr {
			start := c.epgTime(str(r, "start_timestamp", "start", "from", "time"))
			end := c.epgTime(str(r, "stop_timestamp", "end", "to", "time_to"))
			if start.IsZero() || end.IsZero() || !end.After(start) {
				continue
			}
			out = append(out, model.Program{ChannelID: id, Title: str(r, "name", "title", "progname"), Description: str(r, "descr", "description", "desc"), Start: start, End: end})
		}
	}
	// Most portals return all channels in one bounded response.
	js, e := c.request(ctx, "itv", "get_epg_info", url.Values{"period": {strconv.Itoa(c.cfg.EPGHours)}})
	if e != nil {
		return nil, e
	}
	if bulk, ok := bulkEPG(js); ok {
		for epgID, rr := range bulk {
			if id := channelByEPG[epgID]; id != "" {
				add(id, rr)
			}
		}
		return out, nil
	}
	// Older portals only implement ch_id-scoped get_epg_info.
	for _, ch := range channels {
		epgID := epgIDs[ch.ID]
		if epgID == "" {
			epgID = ch.ProviderID
		}
		js, e := c.request(ctx, "itv", "get_epg_info", url.Values{"ch_id": {epgID}})
		if e != nil {
			return nil, e
		}
		rr, _, e := rows(js)
		if e != nil {
			return nil, e
		}
		add(ch.ID, rr)
	}
	return out, nil
}

func bulkEPG(js json.RawMessage) (map[string][]map[string]json.RawMessage, bool) {
	var obj map[string]json.RawMessage
	if json.Unmarshal(js, &obj) != nil {
		return nil, false
	}
	for _, k := range []string{"data", "epg"} {
		if nested := obj[k]; len(nested) > 0 && nested[0] == '{' {
			return bulkEPG(nested)
		}
	}
	out := map[string][]map[string]json.RawMessage{}
	for k, v := range obj {
		if k == "data" || k == "epg" || k == "total_items" || k == "total" || k == "count" {
			continue
		}
		var rr []map[string]json.RawMessage
		if json.Unmarshal(v, &rr) == nil {
			out[k] = rr
		}
	}
	return out, len(out) > 0
}

func (c *Client) epgTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if n, e := strconv.ParseInt(s, 10, 64); e == nil {
		return time.Unix(n, 0)
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, e := time.ParseInLocation(layout, s, c.loc); e == nil {
			return t
		}
	}
	return time.Time{}
}

func (c *Client) Resolve(ctx context.Context, it model.Item) (model.Source, error) {
	if it.Kind != "live" && it.Kind != "movie" && it.Kind != "episode" {
		return model.Source{}, errors.New("item is not playable")
	}
	cmd := strings.TrimSpace(it.Command)
	if it.Kind == "movie" {
		movieID := strings.TrimPrefix(it.ID, "movie:")
		if movieID == "" || movieID == it.ID || it.ProviderID != "" && it.ProviderID != movieID {
			return model.Source{}, errors.New("movie identity does not match provider metadata")
		}
		if cmd == "" || cmd == "/media/"+movieID+".mpg" {
			var err error
			cmd, err = c.movieFileCommand(ctx, movieID)
			if err != nil {
				return model.Source{}, err
			}
		}
	}
	resolvedEpisodeFile := false
	if it.Kind == "episode" && cmd == "" {
		var err error
		cmd, err = c.episodeFileCommand(ctx, it)
		if err != nil {
			return model.Source{}, err
		}
		resolvedEpisodeFile = true
	}
	if cmd == "" {
		pid := it.ProviderID
		if pid == "" {
			parts := strings.Split(it.ID, ":")
			pid = parts[len(parts)-1]
		}
		if it.Kind == "live" {
			cmd = pid
		} else {
			cmd = "/media/file_" + pid + ".mpg"
		}
	}
	q := url.Values{"cmd": {cmd}}
	typ := "vod"
	if it.Kind == "live" {
		typ = "itv"
	}
	if it.Kind == "episode" {
		if resolvedEpisodeFile && it.Episode <= 0 {
			return model.Source{}, errors.New("episode number is missing")
		}
		if it.Episode > 0 {
			// The portal can rewrite an SxxExx path using this selector even
			// after a concrete file ID was chosen. Omitting it selects episode 1.
			q.Set("series", strconv.Itoa(it.Episode))
		}
	}
	js, e := c.request(ctx, typ, "create_link", q)
	if e != nil {
		return model.Source{}, e
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(js, &m) != nil {
		return model.Source{}, errors.New("invalid playback response")
	}
	link := str(m, "url", "cmd")
	if link == "" && it.Kind != "live" {
		file, playToken := str(m, "id"), str(m, "play_token")
		if file != "" && playToken != "" {
			if !strings.Contains(path.Base(file), ".") {
				file += ".mp4"
			}
			base := *c.endpoint
			base.RawQuery = ""
			base.Fragment = ""
			prefix := base.Path
			if i := strings.Index(prefix, "/stalker_portal/"); i >= 0 {
				prefix = prefix[:i]
			} else if i := strings.Index(prefix, "/server/"); i >= 0 {
				prefix = prefix[:i]
			} else {
				prefix = path.Dir(prefix)
			}
			base.Path = path.Join(prefix, "play/movie.php")
			params := url.Values{"mac": {c.cfg.MAC}, "stream": {file}, "play_token": {playToken}, "type": {"movie"}}
			if it.Kind == "episode" {
				params.Set("type", "series")
			}
			base.RawQuery = params.Encode()
			link = base.String()
		}
	}
	if link == "" {
		return model.Source{}, errors.New("portal returned no playback URL")
	}
	// The MAG command may be prefixed by the player executable. Parse only the
	// URL token; never invoke a shell or interpret command flags.
	fields := strings.Fields(strings.TrimSpace(link))
	for _, f := range fields {
		if strings.HasPrefix(strings.ToLower(f), "http://") || strings.HasPrefix(strings.ToLower(f), "https://") {
			link = f
			break
		}
	}
	u, e := url.Parse(link)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return model.Source{}, errors.New("portal returned an invalid playback URL")
	}
	headers := map[string]string{"User-Agent": c.cfg.UserAgent, "Referer": c.endpoint.Scheme + "://" + c.endpoint.Host + "/"}
	// Playback endpoints on the same portal often require the MAG identity.
	if strings.EqualFold(u.Host, c.endpoint.Host) {
		if e := c.lock(ctx); e != nil {
			return model.Source{}, e
		}
		token := c.token
		c.mu.Release(1)
		headers["Cookie"] = "mac=" + url.QueryEscape(c.cfg.MAC) + "; stb_lang=en; timezone=" + url.QueryEscape(c.cfg.Timezone)
		if token != "" {
			headers["Authorization"] = "Bearer " + token
		}
	}
	return model.Source{URL: u.String(), Headers: headers, Live: it.Kind == "live", Duration: it.Duration}, nil
}

// A VOD catalog row can be a movie shell whose command names the movie ID.
// Select its concrete file at playback before asking the portal for a link.
func (c *Client) movieFileCommand(ctx context.Context, movieID string) (string, error) {
	js, err := c.request(ctx, "vod", "get_ordered_list", url.Values{
		"movie_id":   {movieID},
		"season_id":  {"0"},
		"episode_id": {"0"},
		"p":          {"0"},
	})
	if err != nil {
		return "", err
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(js, &shape) == nil {
		list := shape["data"]
		if len(list) == 0 {
			list = shape["items"]
		}
		var parsed []map[string]json.RawMessage
		if len(list) == 0 || string(list) == "null" || json.Unmarshal(list, &parsed) != nil {
			return "", errors.New("invalid portal movie file list")
		}
	}
	files, _, err := rows(js)
	if err != nil || len(files) == 0 {
		return "", errors.New("portal movie file unavailable")
	}
	for _, file := range files {
		if parent := str(file, "video_id"); parent != "" && parent != movieID {
			continue
		}
		if series := str(file, "series_id"); series != "" && series != "0" {
			continue
		}
		if season := str(file, "season_id"); season != "" && season != "0" {
			continue
		}
		if episode := str(file, "episode_id"); episode != "" && episode != "0" {
			continue
		}
		if !flag(file, "is_file") || flag(file, "is_season") || flag(file, "is_series") || flag(file, "is_episode") {
			continue
		}
		fileID := str(file, "id")
		if !numericIDs(fileID) {
			continue
		}
		if numericIDs(movieID) {
			slog.Debug("Portal movie file selected", "movie_id", movieID, "file_id", fileID)
		}
		return "/media/file_" + fileID + ".mpg", nil
	}
	return "", errors.New("portal movie file unavailable")
}

// Episode list rows may be navigation metadata without a playable command.
// MAG portals serve the actual file through one more scoped ordered-list call.
// The file row has its own ID and command, distinct from the selected episode.
func (c *Client) episodeFileCommand(ctx context.Context, it model.Item) (string, error) {
	parts := strings.Split(it.ID, ":")
	if len(parts) != 4 || parts[0] != "episode" || parts[1] == "" || parts[2] == "" || parts[3] == "" {
		return "", errors.New("episode identity is incomplete")
	}
	seriesID, seasonID, episodeID := parts[1], parts[2], parts[3]
	if it.SeriesID != "" && it.SeriesID != seriesID || it.ProviderID != "" && it.ProviderID != episodeID || it.EpisodeID != "" && it.EpisodeID != episodeID {
		return "", errors.New("episode identity does not match provider metadata")
	}
	js, err := c.request(ctx, "vod", "get_ordered_list", url.Values{
		"movie_id":   {seriesID},
		"season_id":  {seasonID},
		"episode_id": {episodeID},
		"p":          {"0"},
	})
	if err != nil {
		return "", err
	}
	var shape map[string]json.RawMessage
	if json.Unmarshal(js, &shape) == nil {
		list := shape["data"]
		if len(list) == 0 {
			list = shape["items"]
		}
		var parsed []map[string]json.RawMessage
		if len(list) == 0 || string(list) == "null" || json.Unmarshal(list, &parsed) != nil {
			return "", errors.New("invalid portal episode file list")
		}
	}
	files, _, err := rows(js)
	if err != nil || len(files) == 0 {
		return "", errors.New("portal episode file unavailable")
	}
	for _, file := range files {
		if parent := str(file, "video_id"); parent != "" && parent != seriesID {
			continue
		}
		if selected := str(file, "episode_id"); selected != "" && selected != episodeID {
			continue
		}
		if season := str(file, "season_id"); season != "" && season != seasonID {
			continue
		}
		if flag(file, "is_season") || flag(file, "is_series") || flag(file, "is_episode") {
			continue
		}
		fileID, fileCmd := str(file, "id"), strings.TrimSpace(str(file, "cmd"))
		if fileID == "" || fileCmd == "" {
			continue
		}
		if flag(file, "is_file") {
			if !numericIDs(fileID) {
				continue
			}
			// The MAG player resolves file rows by their file ID, even when
			// the row also carries an HTTP command. The HTTP value may be a
			// storage origin rather than a client-ready stream URL.
			fileCmd = "/media/file_" + fileID + ".mpg"
		}
		if numericIDs(seriesID, seasonID, episodeID, fileID) {
			slog.Debug("Portal episode file selected", "series_id", seriesID, "season_id", seasonID, "episode_id", episodeID, "file_id", fileID)
		}
		return fileCmd, nil
	}
	return "", errors.New("portal episode file unavailable")
}

func numericIDs(ids ...string) bool {
	for _, id := range ids {
		if _, err := strconv.ParseUint(id, 10, 64); err != nil {
			return false
		}
	}
	return true
}
