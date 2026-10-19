package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stalker"
)

func TestSettingsManualRefreshLifecycle(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: time.Hour, MaxStreams: 2, Timezone: "America/Toronto", EPGHours: 48, TranscodeMode: "auto", SessionTTL: time.Minute}
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
	if initial.Sync["catalog"].IntervalSeconds != 3600 || initial.Sync["epg"].IntervalSeconds != 3600 || initial.Library["liveChannels"] != float64(1) || initial.Library["categories"] != float64(2) || initial.Timezone != cfg.Timezone {
		t.Fatal(initial)
	}
	for _, target := range []string{"catalog", "epg"} {
		state := initial.Sync[target]
		if state.FinishedAt == nil || state.NextRefreshAt.Sub(*state.FinishedAt) != cfg.RefreshInterval {
			t.Fatalf("%s did not follow the configured interval: %+v", target, state)
		}
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
	if !failed.Sync["epg"].LastSuccessfulAt.Equal(*initial.Sync["epg"].LastSuccessfulAt) || failed.Library["programmes"] != float64(1) || failed.Sync["epg"].NextRefreshAt.Sub(*failed.Sync["epg"].FinishedAt) != cfg.RefreshInterval {
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

func TestScheduledFailuresSurviveRestartAndUnrelatedConfiguration(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	p := &fixtureProvider{fail: true}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		s.stateMu.RLock()
		defer s.stateMu.RUnlock()
		return s.catalogSync.Failures == 1 && s.epgSync.Failures == 1
	})
	s.stateMu.RLock()
	before := s.catalogSync
	guideBefore := s.epgSync
	s.stateMu.RUnlock()
	if guideBefore.NextRefreshAt == nil || guideBefore.FinishedAt == nil || guideBefore.NextRefreshAt.Sub(*guideBefore.FinishedAt) != cfg.RefreshInterval {
		t.Fatalf("failed guide did not wait for the configured interval: %+v", guideBefore)
	}
	s.Close()
	cfg.RefreshInterval, cfg.MaxStreams = time.Hour, 3
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.stateMu.RLock()
	after := s.catalogSync
	guideAfter := s.epgSync
	s.stateMu.RUnlock()
	if after.Failures != 1 || !after.NextRefreshAt.Equal(*before.NextRefreshAt) || after.Error == "" {
		t.Fatalf("retry was reset on restart/settings: before=%+v after=%+v", before, after)
	}
	if guideAfter.Failures != 1 || guideAfter.NextRefreshAt == nil || !guideAfter.NextRefreshAt.Equal(*guideBefore.NextRefreshAt) {
		t.Fatalf("guide retry was reset on restart/settings: before=%+v after=%+v", guideBefore, guideAfter)
	}
	p.mu.Lock()
	calls := p.catalogs
	p.mu.Unlock()
	if calls != 1 {
		t.Fatalf("restart bypassed persisted cooldown: %d calls", calls)
	}
}

type authFailureProvider struct{ fixtureProvider }

func (p *authFailureProvider) Catalog(context.Context) ([]model.Item, error) {
	return nil, &stalker.PermanentError{Message: "authorization failed"}
}

func TestScheduledAuthenticationPauseAndExplicitRetry(t *testing.T) {
	logs := captureActivityLogs(t)
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	s, err := New(cfg, &authFailureProvider{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		s.stateMu.RLock()
		defer s.stateMu.RUnlock()
		return s.catalogSync.Paused && !s.epgSync.Running && s.epgSync.LastSuccessfulAt != nil
	})
	output := logs()
	if !strings.Contains(output, "reason=authorization") || !strings.Contains(output, "paused=true") || !strings.Contains(output, "Check provider credentials") {
		t.Fatal("provider authentication failure has no useful log", output)
	}
	s.Close()
	p := &fixtureProvider{}
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.stateMu.RLock()
	paused := s.catalogSync
	s.stateMu.RUnlock()
	if !paused.Paused || paused.NextRefreshAt != nil || paused.Failures != 1 {
		t.Fatal(paused)
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"catalog"}`)
	if code != 202 {
		t.Fatal(code, body)
	}
	waitFor(t, func() bool {
		s.stateMu.RLock()
		defer s.stateMu.RUnlock()
		return !s.catalogSync.Running && !s.catalogSync.Paused && s.catalogSync.LastSuccessfulAt != nil
	})
	var data []byte
	if err := s.cache.db.QueryRow(`SELECT data FROM scheduled_refresh WHERE kind='metadata'`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	var saved scheduledRefresh
	if err := json.Unmarshal(data, &saved); err != nil || saved.State.Failures != 0 || saved.State.Error != "" {
		t.Fatal(string(data), err)
	}
}

type emptyGuideProvider struct {
	fixtureProvider
	guide []model.Program
}

func (p *emptyGuideProvider) EPG(context.Context) ([]model.Program, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.epgs++
	return append([]model.Program(nil), p.guide...), nil
}

func TestGuideCadenceSurvivesRestartAndConfigurationChange(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 2 * time.Hour}
	now := time.Now().UTC()
	p := &emptyGuideProvider{guide: []model.Program{{ChannelID: "live:1", Start: now.Add(-time.Hour), End: now.Add(20 * time.Minute)}}}
	s, err := New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		s.stateMu.RLock()
		defer s.stateMu.RUnlock()
		return s.epgSync.FinishedAt != nil && !s.epgSync.Running
	})
	s.stateMu.RLock()
	state := s.epgSync
	s.stateMu.RUnlock()
	if state.NextRefreshAt == nil || state.NextRefreshAt.Sub(*state.FinishedAt) != cfg.RefreshInterval {
		s.Close()
		t.Fatalf("short guide bypassed the configured interval: %+v", state)
	}
	// Upgrade an older saved early scan while changing the regular cadence.
	early := state.FinishedAt.Add(15 * time.Minute)
	state.NextRefreshAt = &early
	err = s.saveScheduledRefresh("epg", state)
	s.Close()
	if err != nil {
		t.Fatal(err)
	}
	cfg.RefreshInterval = 6 * time.Hour
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.stateMu.RLock()
	restored := s.epgSync
	s.stateMu.RUnlock()
	want := s.refreshLastSuccess(false).Add(cfg.RefreshInterval)
	if restored.NextRefreshAt == nil || !restored.NextRefreshAt.Equal(want) {
		t.Fatalf("restart did not apply configured cadence: got %+v, want %s", restored, want)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.epgs != 1 {
		t.Fatalf("restart unexpectedly fetched the guide: %d calls", p.epgs)
	}
}

func TestUnusableGuidePreservesCacheUntilConfiguredRefresh(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
	s, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	err = s.cache.setEPG([]model.Program{{ChannelID: "live:1", Title: "Saved", Start: now.Add(-time.Hour), End: now.Add(3 * time.Hour)}})
	s.Close()
	if err != nil {
		t.Fatal(err)
	}
	p := &emptyGuideProvider{}
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ts := httptest.NewServer(s)
	defer ts.Close()
	var finished time.Time
	for _, tc := range []struct {
		name  string
		guide []model.Program
	}{
		{"empty", nil},
		{"expired", []model.Program{{ChannelID: "live:1", Start: now.Add(-2 * time.Hour), End: now.Add(-time.Hour)}}},
		{"malformed", []model.Program{{ChannelID: "", Start: now, End: now.Add(time.Hour)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p.mu.Lock()
			p.guide = tc.guide
			p.mu.Unlock()
			if code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"epg"}`); code != 202 {
				t.Fatal(code, body)
			}
			waitFor(t, func() bool {
				s.stateMu.RLock()
				defer s.stateMu.RUnlock()
				return s.epgSync.Failures == 1 && !s.epgSync.Running && s.epgSync.FinishedAt.After(finished)
			})
			s.stateMu.RLock()
			state := s.epgSync
			s.stateMu.RUnlock()
			if state.NextRefreshAt == nil || state.NextRefreshAt.Sub(*state.FinishedAt) != cfg.RefreshInterval {
				t.Fatal("unusable guide bypassed the configured refresh interval", state)
			}
			finished = *state.FinishedAt
			s.cache.mu.RLock()
			saved := append([]model.Program(nil), s.cache.programs...)
			s.cache.mu.RUnlock()
			if len(saved) != 1 || saved[0].Title != "Saved" {
				t.Fatal("unusable response discarded saved guide", saved)
			}
		})
	}
}
