package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/pushpinderbal/restream/internal/stream"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

type fixtureProvider struct {
	mu                           sync.Mutex
	catalogs, epgs, episodeCalls int
	browseCalls                  int
	categoryCalls                int
	browseGate                   <-chan struct{}
	fail                         bool
	imageURL                     string
	catalogGate                  <-chan struct{}
}

func (p *fixtureProvider) Catalog(ctx context.Context) ([]model.Item, error) {
	p.mu.Lock()
	p.catalogs++
	fail, imageURL, gate := p.fail, p.imageURL, p.catalogGate
	p.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if fail {
		return nil, fmt.Errorf("unavailable")
	}
	if imageURL == "" {
		imageURL = "http://provider.invalid/secret-logo"
	}
	return []model.Item{{ID: "live:1", Kind: "live", Name: "News", Category: "General", Command: "secret-command", ProviderID: "1", Logo: imageURL}}, nil
}
func (p *fixtureProvider) EPG(ctx context.Context) ([]model.Program, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.epgs++
	if p.fail {
		return nil, fmt.Errorf("unavailable")
	}
	return []model.Program{{ChannelID: "live:1", Title: "Morning", Start: time.Now(), End: time.Now().Add(time.Hour)}}, nil
}
func (p *fixtureProvider) Episodes(ctx context.Context, item model.Item) ([]model.Item, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.episodeCalls++
	return []model.Item{{ID: "episode:2:1:1", Kind: "episode", Name: "Pilot", Command: "secret-episode", ProviderID: "3", SeriesID: "2", EpisodeID: "1"}}, nil
}
func (p *fixtureProvider) Resolve(ctx context.Context, item model.Item) (model.Source, error) {
	return model.Source{}, fmt.Errorf("unused")
}

func (p *fixtureProvider) Categories(ctx context.Context) ([]model.Category, error) {
	p.mu.Lock()
	p.categoryCalls++
	p.mu.Unlock()
	return []model.Category{{ID: "7", Name: "Drama", Kind: "series", SourceType: "vod"}, {ID: "8", Name: "Films", Kind: "movie", SourceType: "vod"}}, nil
}
func (p *fixtureProvider) Browse(ctx context.Context, q model.BrowseQuery) (model.BrowsePage, error) {
	p.mu.Lock()
	p.browseCalls++
	gate := p.browseGate
	p.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return model.BrowsePage{}, ctx.Err()
		}
	}
	item := model.Item{ID: "movie:2", Kind: "movie", Name: "Film", Category: q.Category, Command: "secret-film", ProviderID: "2", Logo: "http://provider.invalid/private-poster"}
	if q.Kind == "series" {
		item = model.Item{ID: "series:2", Kind: "series", Name: "A series", Category: q.Category, ProviderID: "2", Logo: "http://provider.invalid/private-poster"}
	}
	return model.BrowsePage{Items: []model.Item{item}, Page: q.Page, Total: 1, HasMore: false}, nil
}
func TestPassiveBrowseSharedAndPersistent(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55", CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	gate := make(chan struct{})
	p := &fixtureProvider{browseGate: gate}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	waitFor(t, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		s.cache.mu.RLock()
		ready := !s.cache.categoriesAt.IsZero()
		s.cache.mu.RUnlock()
		return p.catalogs > 0 && p.categoryCalls > 0 && ready
	})
	p.mu.Lock()
	if p.browseCalls != 0 {
		t.Fatal("startup fetched VOD")
	}
	p.mu.Unlock()
	_, cats := request(t, ts.URL, "GET", "/api/categories", "")
	if !strings.Contains(cats, "Drama") || strings.Contains(cats, "sourceType") {
		t.Fatal(cats)
	}
	path := "/api/browse?kind=series&category=7&search=pilot&page=1"
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, body := request(t, ts.URL, "GET", path, "")
			if status != 200 || !strings.Contains(body, "A series") || strings.Contains(body, "secret") || strings.Contains(body, "provider.invalid") {
				t.Errorf("browse: %d %s", status, body)
			}
		}()
	}
	waitFor(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.browseCalls == 1 })
	close(gate)
	wg.Wait()
	_, body := request(t, ts.URL, "GET", path, "")
	if !strings.Contains(body, "/api/images/series:2") {
		t.Fatal("cached image lost", body)
	}
	p.mu.Lock()
	calls := p.browseCalls
	p.mu.Unlock()
	request(t, ts.URL, "GET", path, "")
	p.mu.Lock()
	if p.browseCalls != calls {
		t.Fatal("cache miss")
	}
	p.mu.Unlock()
	status, body := request(t, ts.URL, "GET", "/api/series/series:2/episodes", "")
	if status != 200 || !strings.Contains(body, "Pilot") {
		t.Fatal(status, body)
	}
	ts.Close()
	s.Close()
	reopened, err := openStore(cfg.DataDir, cfg.PortalURL, cfg.MAC)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	page, ok, err := reopened.browse(model.BrowseQuery{Kind: "series", Category: "7", Search: "pilot", Page: 1, SourceType: "vod"}, time.Hour)
	if err != nil || !ok || len(page.Items) != 1 || page.Items[0].Logo == "" {
		t.Fatal("browse page not restored", err)
	}
	if len(reopened.categories) != 2 || reopened.categories[0].SourceType == "" {
		t.Fatal("source type not restored")
	}
	if _, ok := reopened.item("episode:2:1:1"); !ok {
		t.Fatal("episodes not restored")
	}
}
func TestHTTPUnconfiguredAndValidation(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), MaxStreams: 1}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	status, body := request(t, ts.URL, "GET", "/api/status", "")
	var out map[string]any
	json.Unmarshal([]byte(body), &out)
	if status != 200 || out["configured"] != false {
		t.Fatal(body)
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		status, _ = request(t, ts.URL, "GET", path, "")
		if status != 200 {
			t.Fatal(path, status)
		}
	}
	status, _ = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"live:1"}`)
	if status != 503 {
		t.Fatal(status)
	}
	status, _ = request(t, ts.URL, "POST", "/api/refresh", "")
	if status != 404 {
		t.Fatal(status)
	}
	status, _ = request(t, ts.URL, "GET", "/api/unknown", "")
	if status != 404 {
		t.Fatal(status)
	}
}

func TestCatalogETag(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55", CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	s, err := New(cfg, &fixtureProvider{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	waitFor(t, func() bool { _, ok := s.cache.item("live:1"); return ok })
	res, err := http.Get(ts.URL + "/api/catalog")
	if err != nil {
		t.Fatal(err)
	}
	etag := res.Header.Get("ETag")
	res.Body.Close()
	if etag == "" {
		t.Fatal("missing ETag")
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/catalog", nil)
	req.Header.Set("If-None-Match", etag)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 304 {
		t.Fatal(res.StatusCode)
	}
}
func TestImageSharedAcrossBrowsersAndRefreshStatus(t *testing.T) {
	imageBytes, err := base64.StdEncoding.DecodeString("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	imageCalls := 0
	imageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		imageCalls++
		mu.Unlock()
		w.Header().Set("Content-Type", "image/gif")
		w.Write(imageBytes)
	}))
	defer imageServer.Close()
	gate := make(chan struct{})
	p := &fixtureProvider{imageURL: imageServer.URL + "/logo", catalogGate: gate}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11:22:33:44:55", CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	waitFor(t, func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.catalogs == 1 })
	_, statusBody := request(t, ts.URL, "GET", "/api/status", "")
	if !strings.Contains(statusBody, `"refreshing":true`) {
		t.Fatal("refresh state not visible", statusBody)
	}
	close(gate)
	waitFor(t, func() bool { _, ok := s.cache.item("live:1"); return ok })
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _ := request(t, ts.URL, "GET", "/api/images/live:1", "")
			if status != 200 {
				t.Errorf("image HTTP status: %d", status)
			}
		}()
	}
	wg.Wait()
	mu.Lock()
	calls := imageCalls
	mu.Unlock()
	if calls != 1 {
		t.Fatalf("shared image triggered %d upstream requests", calls)
	}
}
func request(t *testing.T, base, method, path, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, base+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, string(b)
}
func waitFor(t *testing.T, fn func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for integration condition")
}

func TestPlaybackHTTPAdmissionAndStop(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), MaxStreams: 2, CatalogRefresh: time.Hour, EPGRefresh: time.Hour}
	manager, err := stream.New(stream.Config{MaxStreams: 2, DataDir: cfg.DataDir}, func(ctx context.Context, item model.Item) (model.Source, error) {
		<-ctx.Done()
		return model.Source{}, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	p := &fixtureProvider{}
	s, err := New(cfg, p, manager)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	waitFor(t, func() bool { _, ok := s.cache.item("live:1"); return ok })
	var wg sync.WaitGroup
	type result struct {
		status int
		body   string
	}
	replies := make(chan result, 10)
	for n := 0; n < 10; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, body := request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"live:1"}`)
			replies <- result{status, body}
		}()
	}
	wg.Wait()
	close(replies)
	admitted, rejected := 0, 0
	var ids []string
	for reply := range replies {
		switch reply.status {
		case 201:
			admitted++
			var session stream.Session
			if err := json.Unmarshal([]byte(reply.body), &session); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, session.ID)
		case 409:
			rejected++
			if !strings.Contains(reply.body, "No room available") {
				t.Fatal(reply.body)
			}
		default:
			t.Fatalf("unexpected response: %+v", reply)
		}
	}
	if admitted != 2 || rejected != 8 || manager.Active() != 2 {
		t.Fatalf("admission exceeded limit: %d admitted, %d rejected, %d active", admitted, rejected, manager.Active())
	}
	for _, id := range ids {
		status, _ := request(t, ts.URL, "POST", "/api/sessions/"+id+"/heartbeat", "")
		if status != 204 {
			t.Fatal(status)
		}
		status, _ = request(t, ts.URL, "POST", "/api/sessions/"+id+"/seek", `{"position":10}`)
		if status != 400 {
			t.Fatal("live seek", status)
		}
	}
	status, _ := request(t, ts.URL, "DELETE", "/api/sessions/"+ids[0], "")
	if status != 204 {
		t.Fatal(status)
	}
	status, _ = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"live:1"}`)
	if status != 201 {
		t.Fatal("slot not released", status)
	}
	status, _ = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"live:1","start":-1}`)
	if status != 400 {
		t.Fatal("negative position", status)
	}
	status, _ = request(t, ts.URL, "POST", "/api/sessions", `{"itemId":"live:1","url":"http://arbitrary"}`)
	if status != 400 {
		t.Fatal("arbitrary source accepted", status)
	}
}

func TestBrowsePageKeysAndExpiry(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), PortalURL: "http://provider.invalid", MAC: "00:11", CatalogRefresh: 40 * time.Millisecond, EPGRefresh: time.Hour}
	p := &fixtureProvider{}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	defer s.Close()
	waitFor(t, func() bool {
		s.cache.mu.RLock()
		ready := !s.cache.categoriesAt.IsZero()
		s.cache.mu.RUnlock()
		return ready
	})
	paths := []string{
		"/api/browse?kind=movie&category=8&page=1",
		"/api/browse?kind=movie&category=8&page=2",
		"/api/browse?kind=movie&category=8&search=alpha&page=1",
		"/api/browse?kind=series&category=7&page=1",
	}
	for _, path := range paths {
		status, body := request(t, ts.URL, "GET", path, "")
		if status != 200 || !strings.Contains(body, "items") {
			t.Fatal(status, body)
		}
	}
	p.mu.Lock()
	calls := p.browseCalls
	p.mu.Unlock()
	if calls != len(paths) {
		t.Fatalf("shared wrong page key: %d", calls)
	}
	request(t, ts.URL, "GET", paths[0], "")
	p.mu.Lock()
	calls = p.browseCalls
	p.mu.Unlock()
	if calls != len(paths) {
		t.Fatal("fresh page refetched")
	}
	time.Sleep(55 * time.Millisecond)
	request(t, ts.URL, "GET", paths[0], "")
	p.mu.Lock()
	calls = p.browseCalls
	p.mu.Unlock()
	if calls != len(paths)+1 {
		t.Fatal("expired page did not refresh")
	}
}
