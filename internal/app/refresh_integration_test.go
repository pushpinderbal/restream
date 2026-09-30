package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSettingsManualRefreshLifecycle(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), CatalogRefresh: time.Hour, EPGRefresh: 2 * time.Hour, MaxStreams: 2, Timezone: "America/Toronto", EPGHours: 48, TranscodeMode: "auto", SessionTTL: time.Minute}
	p := &fixtureProvider{}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	type settingsStatus struct {
		Refreshing bool                    `json:"refreshing"`
		Sync       map[string]refreshState `json:"sync"`
		Library    map[string]any          `json:"library"`
		Timezone   string                  `json:"timezone"`
	}
	readStatus := func() settingsStatus {
		t.Helper()
		code, body := request(t, ts.URL, "GET", "/api/status", "")
		var out settingsStatus
		if code != 200 {
			t.Fatal(code, body)
		}
		if err := json.Unmarshal([]byte(body), &out); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(body, "secret") || strings.Contains(body, "provider.invalid") {
			t.Fatal("settings leaked provider details", body)
		}
		return out
	}
	waitFor(t, func() bool {
		out := readStatus()
		return !out.Refreshing && out.Sync["catalog"].LastSuccessfulAt != nil && out.Sync["epg"].LastSuccessfulAt != nil && out.Sync["catalog"].NextRefreshAt != nil && out.Sync["epg"].NextRefreshAt != nil
	})
	initial := readStatus()
	if initial.Sync["catalog"].IntervalSeconds != 3600 || initial.Sync["epg"].IntervalSeconds != 7200 || initial.Library["liveChannels"] != float64(1) || initial.Library["categories"] != float64(2) || initial.Timezone != cfg.Timezone {
		t.Fatal(initial)
	}
	gate := make(chan struct{})
	p.mu.Lock()
	beforeCatalog, beforeEPG := p.catalogs, p.epgs
	p.catalogGate = gate
	p.mu.Unlock()
	code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`)
	if code != http.StatusAccepted {
		t.Fatal(code, body)
	}
	waitFor(t, func() bool { return readStatus().Sync["catalog"].Running })
	running := readStatus()
	if !running.Refreshing || running.Sync["catalog"].StartedAt == nil || running.Sync["epg"].Running {
		t.Fatal(running)
	}
	// Requests from multiple browsers join the active job instead of queuing
	// another provider request after the first one completes.
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`)
			if code != 202 {
				t.Errorf("refresh: %d %s", code, body)
			}
		}()
	}
	wg.Wait()
	p.mu.Lock()
	if p.catalogs != beforeCatalog+1 || p.epgs != beforeEPG {
		t.Error("duplicate or unintended refresh", p.catalogs, p.epgs)
	}
	p.mu.Unlock()
	close(gate)
	waitFor(t, func() bool {
		out := readStatus()
		return !out.Refreshing && out.Sync["catalog"].LastSuccessfulAt.After(*initial.Sync["catalog"].LastSuccessfulAt) && out.Sync["catalog"].NextRefreshAt != nil
	})
	completed := readStatus()
	if completed.Sync["catalog"].FinishedAt == nil || !completed.Sync["catalog"].NextRefreshAt.After(*completed.Sync["catalog"].FinishedAt) {
		t.Fatal(completed)
	}
	p.mu.Lock()
	if p.catalogs != beforeCatalog+1 {
		t.Error("queued duplicate refresh", p.catalogs)
	}
	p.fail = true
	p.mu.Unlock()
	code, _ = request(t, ts.URL, "POST", "/api/refresh", `{"target":"epg"}`)
	if code != 202 {
		t.Fatal(code)
	}
	waitFor(t, func() bool {
		out := readStatus()
		return !out.Refreshing && out.Sync["epg"].Error != "" && out.Sync["epg"].NextRefreshAt != nil
	})
	failed := readStatus()
	if !failed.Sync["epg"].LastSuccessfulAt.Equal(*initial.Sync["epg"].LastSuccessfulAt) || failed.Library["programmes"] != float64(1) {
		t.Fatal("failed refresh discarded saved data", failed)
	}
	p.mu.Lock()
	p.fail = false
	p.mu.Unlock()
	code, _ = request(t, ts.URL, "POST", "/api/refresh", `{"target":"all"}`)
	if code != 202 {
		t.Fatal(code)
	}
	waitFor(t, func() bool {
		out := readStatus()
		return !out.Refreshing && out.Sync["epg"].Error == "" && out.Sync["epg"].LastSuccessfulAt.After(*initial.Sync["epg"].LastSuccessfulAt) && out.Sync["catalog"].LastSuccessfulAt.After(*completed.Sync["catalog"].LastSuccessfulAt)
	})
	for _, invalid := range []string{`{"target":"unknown"}`, `{"target":"all","extra":true}`, `not json`} {
		code, _ = request(t, ts.URL, "POST", "/api/refresh", invalid)
		if code != 400 {
			t.Fatal("invalid refresh accepted", code, invalid)
		}
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/refresh", strings.NewReader(`{"target":"all"}`))
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal("cross-origin refresh accepted", res.StatusCode)
	}
	cooldown := time.Now().Add(time.Hour)
	if err := s.cache.setPortalCooldown(cooldown); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest("POST", ts.URL+"/api/refresh", strings.NewReader(`{"target":"all"}`))
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 429 || res.Header.Get("Retry-After") == "" {
		t.Fatal("provider cooldown ignored", res.StatusCode)
	}
}
