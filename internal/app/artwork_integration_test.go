package app

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
	s.imageFailureTTL = time.Second
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
	waitFor(t, func() bool { _, ok := s.imageCache.Get(upstream.URL + "/poster"); return !ok })
	res = getArtwork(t, ts.URL+"/api/images/live:3")
	if res.status != 200 || res.mime != "image/gif" || res.cache != "private, max-age=3600" || calls.Load() != 2 {
		t.Fatalf("upstream recovery: %+v, calls=%d", res, calls.Load())
	}
	res = getArtwork(t, ts.URL+"/api/images/live:3")
	if res.mime != "image/gif" || calls.Load() != 2 {
		t.Fatal("successful artwork not cached")
	}
	res = getArtwork(t, ts.URL+"/api/images/live:missing")
	if res.status != 404 {
		t.Fatal("unknown item should be 404", res.status)
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
	if status != 200 || payload.Item.Image != "/api/images/live:1" || strings.Contains(body, "private-command") || strings.Contains(body, "secret-provider-id") || strings.Contains(body, "provider.invalid") {
		t.Fatal(status, body)
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
	if err := s.setBrowse(q, model.BrowsePage{Items: []model.Item{{ID: "movie:3", Kind: "movie", Name: "Cached film"}}, Page: 1}, time.Hour); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Minute)
	if err := s.setRetryDeadline(false, deadline, true); err != nil {
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
