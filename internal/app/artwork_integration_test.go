package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestArtworkFallbackSharedFailureAndRecovery(t *testing.T) {
	pixel, err := base64.StdEncoding.DecodeString("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	var available atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-MAC") != "" {
			t.Error("private portal headers sent to artwork host")
		}
		if !available.Load() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(pixel)
	}))
	defer upstream.Close()
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55"}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.artwork.failureTTL = time.Second
	if err := s.cache.setCatalog([]model.Item{
		{ID: "live:1", Kind: "live", Name: "No logo", Command: "private-command"},
		{ID: "live:2", Kind: "live", Name: "Broken URL", Logo: "javascript:alert(1)"},
		{ID: "live:3", Kind: "live", Name: "Remote", Logo: upstream.URL + "/poster"},
	}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	for _, id := range []string{"live:1", "live:2"} {
		res := getArtwork(t, ts.URL+"/api/images/"+id)
		if res.status != 200 || res.mime != "image/svg+xml" || !strings.Contains(res.body, "<svg") || res.cache != "private, max-age=1" {
			t.Fatalf("fallback for %s: %+v", id, res)
		}
	}
	var wg sync.WaitGroup
	for n := 0; n < 16; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := getArtwork(t, ts.URL+"/api/images/live:3")
			if res.status != 200 || res.mime != "image/svg+xml" {
				t.Errorf("failed upstream fallback: %+v", res)
			}
		}()
	}
	wg.Wait()
	if got := calls.Load(); got != 1 {
		t.Fatalf("failed image was requested %d times", got)
	}
	available.Store(true)
	res := getArtwork(t, ts.URL+"/api/images/live:3")
	if res.mime != "image/svg+xml" || calls.Load() != 1 {
		t.Fatal("negative cache was not shared")
	}
	if _, err := s.cache.db.Exec(`UPDATE artwork_cache SET retry_at=0`); err != nil {
		t.Fatal(err)
	}
	// Browsers also share a successful cache miss after the failure expires.
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res := getArtwork(t, ts.URL+"/api/images/live:3")
			if res.status != 200 || res.mime != "image/gif" || res.cache != "private, max-age=86400" {
				t.Errorf("upstream recovery: %+v", res)
			}
		}()
	}
	wg.Wait()
	if got := calls.Load(); got != 2 {
		t.Fatalf("shared recovery triggered %d upstream requests, want 2 total", got)
	}
	res = getArtwork(t, ts.URL+"/api/images/live:3")
	if res.mime != "image/gif" || calls.Load() != 2 {
		t.Fatal("successful artwork not cached")
	}
	// Browser freshness must also respect the server image's remaining lifetime.
	if _, err := s.cache.db.Exec(`UPDATE artwork_cache SET validated_at=? WHERE url=?`, time.Now().Add(-artworkFreshTTL+6*time.Hour).UnixMilli(), upstream.URL+"/poster"); err != nil {
		t.Fatal(err)
	}
	res = getArtwork(t, ts.URL+"/api/images/live:3")
	var maxAge int
	_, _ = fmt.Sscanf(res.cache, "private, max-age=%d", &maxAge)
	if res.mime != "image/gif" || maxAge < int((6*time.Hour-time.Minute).Seconds()) || maxAge > int((6*time.Hour).Seconds()) || calls.Load() != 2 {
		t.Fatal("browser lifetime exceeded server freshness", res, calls.Load())
	}
	res = getArtwork(t, ts.URL+"/api/images/live:missing")
	if res.status != 404 {
		t.Fatal("unknown item should be 404", res.status)
	}
}

func testArtworkCache(t *testing.T) (*artworkCache, *store) {
	t.Helper()
	s, err := openStore(t.TempDir(), "http://provider.invalid", "00:11:22:33:44:55")
	if err != nil {
		t.Fatal(err)
	}
	c, err := newArtworkCache(context.Background(), s.db)
	if err != nil {
		s.close()
		t.Fatal(err)
	}
	t.Cleanup(func() { c.close(); s.close() })
	return c, s
}

func artworkPixel(t *testing.T) []byte {
	t.Helper()
	pixel, err := base64.StdEncoding.DecodeString("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")
	if err != nil {
		t.Fatal(err)
	}
	return pixel
}

func TestArtworkPersistsRevalidatesAndPreservesStaleOnFailure(t *testing.T) {
	pixel := artworkPixel(t)
	var calls atomic.Int32
	var status atomic.Int32
	status.Store(http.StatusOK)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if status.Load() == http.StatusNotModified {
			if r.Header.Get("If-None-Match") != `"poster-v1"` || r.Header.Get("If-Modified-Since") != "Sat, 17 Oct 2026 12:00:00 GMT" {
				t.Error("missing conditional revalidation headers")
			}
		}
		w.Header().Set("ETag", `"poster-v1"`)
		w.Header().Set("Last-Modified", "Sat, 17 Oct 2026 12:00:00 GMT")
		w.WriteHeader(int(status.Load()))
		if status.Load() == http.StatusOK {
			_, _ = w.Write(pixel)
		}
	}))
	defer upstream.Close()
	dir := t.TempDir()
	open := func() (*artworkCache, *store) {
		s, err := openStore(dir, "http://provider.invalid", "00:11:22:33:44:55")
		if err != nil {
			t.Fatal(err)
		}
		c, err := newArtworkCache(context.Background(), s.db)
		if err != nil {
			s.close()
			t.Fatal(err)
		}
		return c, s
	}
	c, s := open()
	first := c.get(context.Background(), upstream.URL)
	if string(first.image.data) != string(pixel) || first.ttl < 29*24*time.Hour {
		t.Fatal("initial image was not cached", first)
	}
	c.close()
	s.close()
	c, s = open()
	defer func() { c.close(); s.close() }()
	if got := c.get(context.Background(), upstream.URL); got.image.mime == fallbackArtwork.mime || calls.Load() != 1 {
		t.Fatal("restart downloaded cached image again")
	}
	expire := func() {
		if _, err := s.db.Exec(`UPDATE artwork_cache SET validated_at=?,retry_at=0`, time.Now().Add(-31*24*time.Hour).UnixMilli()); err != nil {
			t.Fatal(err)
		}
	}
	expire()
	status.Store(http.StatusNotModified)
	if got := c.get(context.Background(), upstream.URL); got.image.mime == fallbackArtwork.mime || got.ttl < 29*24*time.Hour || calls.Load() != 2 {
		t.Fatal("304 did not renew existing image")
	}
	expire()
	status.Store(http.StatusServiceUnavailable)
	if got := c.get(context.Background(), upstream.URL); string(got.image.data) != string(pixel) || got.ttl != c.failureTTL || calls.Load() != 3 {
		t.Fatal("failed revalidation discarded stale image")
	}
	if got := c.get(context.Background(), upstream.URL); got.image.mime == fallbackArtwork.mime || calls.Load() != 3 {
		t.Fatal("stale retry cooldown ignored")
	}
	c.close()
	s.close()
	c, s = open()
	if got := c.get(context.Background(), upstream.URL); got.image.mime == fallbackArtwork.mime || calls.Load() != 3 {
		t.Fatal("retry cooldown did not survive restart")
	}
}

func TestArtworkDownloadLimitsAndDeduplication(t *testing.T) {
	c, _ := testArtworkCache(t)
	pixel := artworkPixel(t)
	var active, peak, calls atomic.Int32
	gate := make(chan struct{})
	var release sync.Once
	var hosts []*httptest.Server
	defer func() {
		release.Do(func() { close(gate) })
		for _, h := range hosts {
			h.Close()
		}
	}()
	for i := 0; i < 3; i++ {
		var hostActive, hostPeak atomic.Int32
		h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			n := active.Add(1)
			for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
			}
			hn := hostActive.Add(1)
			for old := hostPeak.Load(); hn > old && !hostPeak.CompareAndSwap(old, hn); old = hostPeak.Load() {
			}
			if hn > 2 {
				t.Error("more than two downloads to one host")
			}
			<-gate
			_, _ = w.Write(pixel)
			hostActive.Add(-1)
			active.Add(-1)
		}))
		hosts = append(hosts, h)
	}
	var wg sync.WaitGroup
	for _, h := range hosts {
		for i := 0; i < 6; i++ {
			wg.Add(1)
			go func(uri string) {
				defer wg.Done()
				if c.get(context.Background(), uri).image.mime == fallbackArtwork.mime {
					t.Error("download failed")
				}
			}(fmt.Sprintf("%s/%d", h.URL, i%3))
		}
	}
	waitFor(t, func() bool { return active.Load() == 4 })
	if peak.Load() > 4 {
		t.Fatal("global artwork concurrency exceeded four")
	}
	release.Do(func() { close(gate) })
	wg.Wait()
	if calls.Load() != 9 {
		t.Fatalf("expected 9 unique downloads, got %d", calls.Load())
	}
}

func TestArtworkSizeEvictionAndPersistenceFailureCooldown(t *testing.T) {
	c, s := testArtworkCache(t)
	pixel := artworkPixel(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/too-large" {
			_, _ = w.Write(append(pixel, make([]byte, artworkMaxAssetBytes)...))
			return
		}
		_, _ = w.Write(pixel)
	}))
	defer upstream.Close()
	c.maxBytes = int64(len(pixel) * 2)
	for _, path := range []string{"/a", "/b", "/a", "/c"} {
		if c.get(context.Background(), upstream.URL+path).image.mime == fallbackArtwork.mime {
			t.Fatal("valid image rejected")
		}
	}
	var count, total int
	if err := s.db.QueryRow(`SELECT COUNT(*),SUM(length(data)) FROM artwork_cache`).Scan(&count, &total); err != nil || count != 2 || total != len(pixel)*2 {
		t.Fatal("cache size limit not enforced", count, total, err)
	}
	var retained int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM artwork_cache WHERE url=?`, upstream.URL+"/a").Scan(&retained); err != nil || retained != 1 {
		t.Fatal("recently accessed image was evicted", err)
	}
	if got := c.get(context.Background(), upstream.URL+"/too-large"); got.image.mime != fallbackArtwork.mime {
		t.Fatal("oversized image accepted")
	}
	before := calls.Load()
	if c.get(context.Background(), upstream.URL+"/too-large").image.mime != fallbackArtwork.mime || calls.Load() != before {
		t.Fatal("oversized image was fetched again during cooldown")
	}
	if _, err := s.db.Exec(`CREATE TRIGGER artwork_write_failure BEFORE INSERT ON artwork_cache BEGIN SELECT RAISE(FAIL,'disk unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	if c.get(context.Background(), upstream.URL+"/unsaved").image.mime == fallbackArtwork.mime {
		t.Fatal("successful image lost when persistence failed")
	}
	before = calls.Load()
	c.get(context.Background(), upstream.URL+"/unsaved")
	if calls.Load() != before {
		t.Fatal("failed persistence caused repeated upstream download")
	}
}

func TestArtworkShutdownCancelsActiveAndQueuedDownloads(t *testing.T) {
	c, _ := testArtworkCache(t)
	var active atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		active.Add(1)
		defer active.Add(-1)
		<-r.Context().Done()
	}))
	defer func() { c.close(); upstream.Close() }()
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); c.get(context.Background(), fmt.Sprintf("%s/%d", upstream.URL, i)) }(i)
	}
	waitFor(t, func() bool { return active.Load() == 2 })
	c.close()
	wg.Wait()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.hosts) != 0 || len(c.slots) != 0 {
		t.Fatal("shutdown left occupied download slots")
	}
}

type artworkResponse struct {
	status            int
	mime, cache, body string
}

func getArtwork(t *testing.T, uri string) artworkResponse {
	t.Helper()
	res, err := http.Get(uri)
	if err != nil {
		t.Error(err)
		return artworkResponse{}
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Error(err)
	}
	return artworkResponse{res.StatusCode, res.Header.Get("Content-Type"), res.Header.Get("Cache-Control"), string(b)}
}

func TestItemDetailUsesLocalCacheAndHidesProviderFields(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55"}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.cache.setCatalog([]model.Item{{ID: "live:1", Kind: "live", Name: "Channel", Logo: "http://provider.invalid/logo", Command: "private-command", ProviderID: "secret-provider-id"}}); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	status, body := request(t, ts.URL, "GET", "/api/items/live:1", "")
	var payload struct {
		Item model.Item `json:"item"`
	}
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatal(err)
	}
	if status != 200 || !strings.HasPrefix(payload.Item.Image, "/api/images/live:1?v=") || strings.Contains(body, "private-command") || strings.Contains(body, "secret-provider-id") || strings.Contains(body, "provider.invalid") {
		t.Fatal(status, body)
	}
	previous := payload.Item.Image
	if err := s.cache.setCatalog([]model.Item{{ID: "live:1", Kind: "live", Name: "Channel", Logo: "http://provider.invalid/new-logo"}}); err != nil {
		t.Fatal(err)
	}
	status, body = request(t, ts.URL, "GET", "/api/items/live:1", "")
	if json.Unmarshal([]byte(body), &payload) != nil || status != 200 || payload.Item.Image == previous {
		t.Fatal("changed artwork did not invalidate the browser URL", status, body)
	}
	status, _ = request(t, ts.URL, "GET", "/api/items/movie:missing", "")
	if status != 404 {
		t.Fatal(status)
	}
}

func TestBrowseCacheUpgradePreservesOtherSavedData(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, "http://provider.invalid", "00:11:22:33:44:55")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.setCatalog([]model.Item{{ID: "live:1", Kind: "live", Name: "News"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.setEPG([]model.Program{{ChannelID: "live:1", Title: "News", Start: time.Now(), End: time.Now().Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	if err := s.setCategories([]model.Category{{ID: "7", Name: "Old mirrored series", Kind: "series", SourceType: "vod"}}); err != nil {
		t.Fatal(err)
	}
	q := model.BrowseQuery{Kind: "movie", Category: "7", Search: "literal", Page: 1}
	if err := seedBrowsePage(s, q, model.BrowsePage{Items: []model.Item{{ID: "movie:3", Kind: "movie", Name: "Cached film"}}, Page: 1}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	if err := s.setPortalCooldown(deadline); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`DELETE FROM meta WHERE key='browse_cache_version'`); err != nil {
		t.Fatal(err)
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(dir, "http://provider.invalid", "00:11:22:33:44:55")
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if _, ok, err := reopened.browse(q, time.Hour); err != nil || ok {
		t.Fatal("old browse page retained", err)
	}
	if len(reopened.categories) != 0 || !reopened.categoriesAt.IsZero() {
		t.Fatal("old category metadata retained")
	}
	if _, ok := reopened.item("live:1"); !ok {
		t.Fatal("live catalog lost")
	}
	if _, ok := reopened.item("movie:3"); !ok {
		t.Fatal("cached item detail lost")
	}
	if len(reopened.programs) != 1 || reopened.epgAt.IsZero() || reopened.catalogAt.IsZero() || reopened.portalCooldownUntil.Before(deadline.Add(-time.Second)) {
		t.Fatal("unrelated cache state lost")
	}
	var version string
	if err := reopened.db.QueryRow(`SELECT value FROM meta WHERE key='browse_cache_version'`).Scan(&version); err != nil || version != browseCacheVersion {
		t.Fatal("cache semantics version not saved", version, err)
	}
}

func TestArtworkHostRateLimitPersistsAndProtectsOtherURLs(t *testing.T) {
	pixel := artworkPixel(t)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/limited" {
			w.Header().Set("Retry-After", "3600")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write(pixel)
	}))
	defer upstream.Close()
	dir := t.TempDir()
	open := func() (*artworkCache, *store) {
		s, err := openStore(dir, "http://provider.invalid", "00:11:22:33:44:55")
		if err != nil {
			t.Fatal(err)
		}
		c, err := newArtworkCache(context.Background(), s.db)
		if err != nil {
			s.close()
			t.Fatal(err)
		}
		return c, s
	}
	c, s := open()
	if c.get(context.Background(), upstream.URL+"/saved").image.mime == fallbackArtwork.mime {
		t.Fatal("failed to seed image")
	}
	if _, err := s.db.Exec(`UPDATE artwork_cache SET validated_at=?`, time.Now().Add(-31*24*time.Hour).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if c.get(context.Background(), upstream.URL+"/limited").image.mime != fallbackArtwork.mime {
		t.Fatal("rate limit should return placeholder")
	}
	if c.get(context.Background(), upstream.URL+"/other").image.mime != fallbackArtwork.mime || calls.Load() != 2 {
		t.Fatal("another URL ignored host cooldown")
	}
	if got := c.get(context.Background(), upstream.URL+"/saved"); string(got.image.data) != string(pixel) || calls.Load() != 2 {
		t.Fatal("host cooldown discarded stale image or fetched upstream")
	}
	var retry int64
	if err := s.db.QueryRow(`SELECT retry_at FROM artwork_hosts`).Scan(&retry); err != nil || time.UnixMilli(retry).Before(time.Now().Add(59*time.Minute)) {
		t.Fatal("Retry-After not honored", err)
	}
	c.close()
	s.close()
	c, s = open()
	defer func() { c.close(); s.close() }()
	if c.get(context.Background(), upstream.URL+"/after-restart").image.mime != fallbackArtwork.mime || calls.Load() != 2 {
		t.Fatal("host cooldown lost on restart")
	}
}

func TestArtworkQueuedMissesStopAfterStorageFailure(t *testing.T) {
	c, s := testArtworkCache(t)
	var calls atomic.Int32
	pixel := artworkPixel(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = w.Write(pixel) }))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	first, err := c.acquire(c.ctx, u.Host)
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.acquire(c.ctx, u.Host)
	if err != nil {
		first()
		t.Fatal(err)
	}
	var releaseFirst, releaseSecond sync.Once
	defer releaseFirst.Do(first)
	defer releaseSecond.Do(second)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); c.get(context.Background(), fmt.Sprintf("%s/%d", upstream.URL, i)) }(i)
	}
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.hosts[u.Host].users == 8 })
	if _, err := s.db.Exec(`CREATE TRIGGER artwork_queue_write_failure BEFORE INSERT ON artwork_cache BEGIN SELECT RAISE(FAIL,'disk unavailable'); END`); err != nil {
		t.Fatal(err)
	}
	releaseFirst.Do(first)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("queued misses downloaded after storage failure: %d calls", calls.Load())
	}
	releaseSecond.Do(second)
}
