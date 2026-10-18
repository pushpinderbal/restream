package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	artworkFreshTTL        = 30 * 24 * time.Hour
	artworkClientTTL       = 24 * time.Hour
	defaultImageFailureTTL = 5 * time.Minute
	artworkMaxAssetBytes   = 5 << 20
	artworkMaxCacheBytes   = 256 << 20
	artworkMaxCacheEntries = 16384
)

type imageData struct {
	data []byte
	mime string
}

const defaultArtwork = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" role="img" aria-label="Artwork unavailable"><rect width="320" height="180" fill="#172033"/><rect x="109" y="55" width="102" height="70" rx="14" fill="#27354d" stroke="#536a92" stroke-width="2"/><path d="m147 77 37 13-37 13z" fill="#aec3e8"/></svg>`

var fallbackArtwork = imageData{data: []byte(defaultArtwork), mime: "image/svg+xml"}

type artworkResult struct {
	image imageData
	ttl   time.Duration
}

type artworkEntry struct {
	image            imageData
	etag, modified   string
	validated, retry time.Time
}

type artworkHost struct {
	slots chan struct{}
	users int
}

type artworkTransport struct {
	cache *artworkCache
	base  http.RoundTripper
}

type artworkBody struct {
	io.ReadCloser
	release func()
	once    sync.Once
}

func (b *artworkBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(b.release)
	return err
}

func (t artworkTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	host := strings.ToLower(r.URL.Host)
	release, err := t.cache.acquire(r.Context(), host)
	if err != nil {
		return nil, err
	}
	// Queued URLs must observe failures/rate limits discovered while waiting.
	if err := t.cache.hostReady(r.Context(), host); err != nil {
		release()
		return nil, err
	}
	res, err := t.base.RoundTrip(r)
	if err != nil {
		release()
		return nil, err
	}
	res.Body = &artworkBody{ReadCloser: res.Body, release: release}
	return res, nil
}

// Artwork is deliberately independent of library expiry: an unchanged URL is
// revalidated after 30 days, and successful bytes survive restarts and failures.
type artworkCache struct {
	db                   *sql.DB
	client               *http.Client
	ctx                  context.Context
	cancel               context.CancelFunc
	freshTTL, failureTTL time.Duration
	maxBytes             int64
	flights              singleflight.Group
	slots                chan struct{}
	mu                   sync.Mutex
	hosts                map[string]*artworkHost
	closed               bool
	workers              sync.WaitGroup
	storageRetry         time.Time
}

func newArtworkCache(ctx context.Context, db *sql.DB) (*artworkCache, error) {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS artwork_cache (
		url TEXT PRIMARY KEY, data BLOB NOT NULL, mime TEXT NOT NULL,
		etag TEXT NOT NULL, modified TEXT NOT NULL, validated_at INTEGER NOT NULL,
		retry_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL
	); DROP INDEX IF EXISTS artwork_accessed;
	CREATE INDEX IF NOT EXISTS artwork_lru_size ON artwork_cache(accessed_at DESC,url DESC,length(data));
	CREATE TABLE IF NOT EXISTS artwork_hosts(host TEXT PRIMARY KEY,retry_at INTEGER NOT NULL)`)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	return &artworkCache{db: db, client: &http.Client{Timeout: 12 * time.Second}, ctx: ctx, cancel: cancel,
		freshTTL: artworkFreshTTL, failureTTL: defaultImageFailureTTL, maxBytes: artworkMaxCacheBytes,
		slots: make(chan struct{}, 4), hosts: make(map[string]*artworkHost)}, nil
}

func (c *artworkCache) close() {
	c.mu.Lock()
	c.closed = true
	c.cancel()
	c.mu.Unlock()
	c.workers.Wait()
}

func (c *artworkCache) fallback() artworkResult { return artworkResult{fallbackArtwork, c.failureTTL} }

func (c *artworkCache) get(ctx context.Context, rawURL string) artworkResult {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return c.fallback()
	}
	key := u.String()
	entry, err := c.read(key)
	if err != nil {
		// A broken cache must not turn every image request into an upstream fetch.
		c.storageFailed()
		return c.result(entry)
	}
	if result, ok := c.cached(entry); ok {
		return result
	}
	c.mu.Lock()
	paused := c.closed || c.storageRetry.After(time.Now())
	c.mu.Unlock()
	if paused {
		return c.result(entry)
	}
	ch := c.flights.DoChan(key, func() (any, error) {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return c.result(entry), nil
		}
		c.workers.Add(1)
		c.mu.Unlock()
		defer c.workers.Done()
		// Another caller may have completed this URL between the first read and
		// joining the flight.
		current, err := c.read(key)
		if err != nil {
			c.storageFailed()
			return c.result(entry), nil
		}
		if result, ok := c.cached(current); ok {
			return result, nil
		}
		updated, _ := c.fetch(key, current)
		return c.result(updated), nil
	})
	select {
	case <-ctx.Done():
		return c.result(entry)
	case <-c.ctx.Done():
		return c.result(entry)
	case result := <-ch:
		return result.Val.(artworkResult)
	}
}

func (c *artworkCache) storageFailed() {
	c.mu.Lock()
	c.storageRetry = time.Now().Add(c.failureTTL)
	c.mu.Unlock()
}

func (c *artworkCache) hostReady(ctx context.Context, host string) error {
	c.mu.Lock()
	paused := c.closed || c.storageRetry.After(time.Now())
	c.mu.Unlock()
	if paused {
		return errors.New("artwork cache unavailable")
	}
	var deadline int64
	err := c.db.QueryRowContext(ctx, `SELECT retry_at FROM artwork_hosts WHERE host=?`, host).Scan(&deadline)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		c.storageFailed()
		return err
	}
	if time.Now().Before(time.UnixMilli(deadline)) {
		return errors.New("artwork host cooling down")
	}
	return nil
}

func (c *artworkCache) rateLimited(res *http.Response, rawURL string) {
	now := time.Now()
	deadline := now.Add(defaultImageFailureTTL)
	value := strings.TrimSpace(res.Header.Get("Retry-After"))
	if seconds, err := strconv.ParseInt(value, 10, 32); err == nil && seconds >= 0 {
		deadline = now.Add(time.Duration(seconds) * time.Second)
	} else if date, err := http.ParseTime(value); err == nil {
		deadline = maxTime(now, date)
	}
	u, _ := url.Parse(rawURL)
	if res.Request != nil && res.Request.URL != nil {
		u = res.Request.URL
	}
	host := strings.ToLower(u.Host)
	_, err := c.db.ExecContext(c.ctx, `INSERT INTO artwork_hosts(host,retry_at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)`, host, deadline.UnixMilli())
	if err != nil {
		c.storageFailed()
	}
}

func (c *artworkCache) cached(e artworkEntry) (artworkResult, bool) {
	now := time.Now()
	return c.result(e), (len(e.image.data) > 0 && now.Before(e.validated.Add(c.freshTTL))) || now.Before(e.retry)
}

func (c *artworkCache) result(e artworkEntry) artworkResult {
	if len(e.image.data) == 0 {
		return c.fallback()
	}
	ttl := time.Until(e.validated.Add(c.freshTTL))
	if ttl <= 0 {
		ttl = c.failureTTL
	}
	return artworkResult{e.image, ttl}
}

func (c *artworkCache) read(key string) (artworkEntry, error) {
	var e artworkEntry
	var validated, retry int64
	err := c.db.QueryRowContext(c.ctx, `SELECT data,mime,etag,modified,validated_at,retry_at FROM artwork_cache WHERE url=?`, key).
		Scan(&e.image.data, &e.image.mime, &e.etag, &e.modified, &validated, &retry)
	if errors.Is(err, sql.ErrNoRows) {
		return e, nil
	}
	if err != nil {
		return e, err
	}
	if validated != 0 {
		e.validated = time.UnixMilli(validated)
	}
	if retry != 0 {
		e.retry = time.UnixMilli(retry)
	}
	if _, err := c.db.ExecContext(c.ctx, `UPDATE artwork_cache SET accessed_at=? WHERE url=?`, time.Now().UnixNano(), key); err != nil {
		// Failure to update an eviction timestamp must not hide usable bytes.
		c.storageFailed()
	}
	return e, nil
}

func (c *artworkCache) save(key string, e artworkEntry) error {
	tx, err := c.db.BeginTx(c.ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	data := e.image.data
	if data == nil {
		data = []byte{}
	}
	stamp := func(t time.Time) int64 {
		if t.IsZero() {
			return 0
		}
		return t.UnixMilli()
	}
	_, err = tx.ExecContext(c.ctx, `INSERT OR REPLACE INTO artwork_cache(url,data,mime,etag,modified,validated_at,retry_at,accessed_at) VALUES(?,?,?,?,?,?,?,?)`, key, data, e.image.mime, e.etag, e.modified, stamp(e.validated), stamp(e.retry), time.Now().UnixNano())
	if err != nil {
		return err
	}
	// Check metadata in the covering index before ranking rows for eviction.
	var bytes, entries int64
	err = tx.QueryRowContext(c.ctx, `SELECT COALESCE(SUM(length(data)),0),COUNT(*) FROM artwork_cache INDEXED BY artwork_lru_size`).Scan(&bytes, &entries)
	if err != nil {
		return err
	}
	if bytes > c.maxBytes || entries > artworkMaxCacheEntries {
		// A shared ROWS frame lets SQLite evaluate both functions in one pass.
		_, err = tx.ExecContext(c.ctx, `DELETE FROM artwork_cache WHERE url IN (
			SELECT url FROM (SELECT url,
			SUM(length(data)) OVER recent AS bytes,
			ROW_NUMBER() OVER recent AS entries
			FROM artwork_cache WINDOW recent AS (
				ORDER BY accessed_at DESC,url DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
			)) WHERE bytes>? OR entries>?
		)`, c.maxBytes, artworkMaxCacheEntries)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *artworkCache) acquire(ctx context.Context, host string) (func(), error) {
	c.mu.Lock()
	h := c.hosts[host]
	if h == nil {
		h = &artworkHost{slots: make(chan struct{}, 2)}
		c.hosts[host] = h
	}
	h.users++
	c.mu.Unlock()
	dropHost := func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		h.users--
		if h.users == 0 {
			delete(c.hosts, host)
		}
	}
	select {
	case h.slots <- struct{}{}:
	case <-ctx.Done():
		dropHost()
		return nil, ctx.Err()
	}
	select {
	case c.slots <- struct{}{}:
		return func() { <-c.slots; <-h.slots; dropHost() }, nil
	case <-ctx.Done():
		<-h.slots
		dropHost()
		return nil, ctx.Err()
	}
}

func (c *artworkCache) fetch(rawURL string, previous artworkEntry) (updated artworkEntry, fetchErr error) {
	// The deadline includes time waiting for a download slot.
	ctx, cancel := context.WithTimeout(c.ctx, 12*time.Second)
	defer cancel()
	var body io.Closer
	defer func() {
		if fetchErr != nil {
			updated = previous
			updated.retry = time.Now().Add(c.failureTTL)
		}
		// Persist before releasing the download slot. If storage fails, queued
		// misses see the circuit and do not immediately redownload more assets.
		if err := c.save(rawURL, updated); err != nil {
			c.storageFailed()
		}
		if body != nil {
			_ = body.Close()
		}
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return previous, err
	}
	req.Header.Set("User-Agent", "Restream/1.0")
	if previous.etag != "" {
		req.Header.Set("If-None-Match", previous.etag)
	}
	if previous.modified != "" {
		req.Header.Set("If-Modified-Since", previous.modified)
	}
	// Wrap the transport rather than the initial URL so redirects count against
	// the destination host's limit as well. No portal credentials are attached.
	client := *c.client
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = artworkTransport{cache: c, base: transport}
	res, err := client.Do(req)
	if err != nil {
		return previous, err
	}
	body = res.Body
	if res.StatusCode == http.StatusTooManyRequests {
		c.rateLimited(res, rawURL)
	}
	if res.StatusCode == http.StatusNotModified && len(previous.image.data) > 0 {
		previous.validated, previous.retry = time.Now(), time.Time{}
		if etag := res.Header.Get("ETag"); etag != "" {
			previous.etag = etag
		}
		if modified := res.Header.Get("Last-Modified"); modified != "" {
			previous.modified = modified
		}
		return previous, nil
	}
	if res.StatusCode != http.StatusOK {
		return previous, fmt.Errorf("artwork upstream returned %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, artworkMaxAssetBytes+1))
	if err != nil {
		return previous, err
	}
	if len(data) > artworkMaxAssetBytes {
		return previous, errors.New("artwork too large")
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
	default:
		return previous, fmt.Errorf("invalid artwork type: %s", mime)
	}
	return artworkEntry{image: imageData{data: data, mime: mime}, etag: res.Header.Get("ETag"), modified: res.Header.Get("Last-Modified"), validated: time.Now()}, nil
}

func writeArtwork(w http.ResponseWriter, result artworkResult) {
	w.Header().Set("Content-Type", result.image.mime)
	w.Header().Set("Content-Length", fmt.Sprint(len(result.image.data)))
	w.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", max(0, int(min(result.ttl, artworkClientTTL).Seconds()))))
	_, _ = w.Write(result.image.data)
}
