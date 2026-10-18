package app

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stalker"
)

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
	s.stateMu.RUnlock()
	s.Close()
	cfg.RefreshInterval, cfg.MaxStreams = time.Hour, 3
	s, err = New(cfg, p, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.stateMu.RLock()
	after := s.catalogSync
	s.stateMu.RUnlock()
	if after.Failures != 1 || !after.NextRefreshAt.Equal(*before.NextRefreshAt) || after.Error == "" {
		t.Fatalf("retry was reset on restart/settings: before=%+v after=%+v", before, after)
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

func TestGuideScheduleUsesContiguousChannelCoverage(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	for _, tc := range []struct {
		name     string
		programs []model.Program
		wait     time.Duration
	}{
		{"full day", []model.Program{{ChannelID: "a", Start: now, End: now.Add(24 * time.Hour)}}, 4 * time.Hour},
		{"six hours", []model.Program{{ChannelID: "a", Start: now, End: now.Add(6 * time.Hour)}}, 4 * time.Hour},
		{"short channel", []model.Program{{ChannelID: "a", Start: now, End: now.Add(24 * time.Hour)}, {ChannelID: "b", Start: now, End: now.Add(5 * time.Hour)}}, 4 * time.Hour},
		{"gap", []model.Program{{ChannelID: "a", Start: now, End: now.Add(3 * time.Hour)}, {ChannelID: "a", Start: now.Add(4 * time.Hour), End: now.Add(24 * time.Hour)}}, 2 * time.Hour},
		{"little coverage", []model.Program{{ChannelID: "a", Start: now, End: now.Add(20 * time.Minute)}}, 15 * time.Minute},
		{"absent guide", []model.Program{{ChannelID: "a", Start: now.Add(-time.Hour), End: now.Add(-time.Minute)}}, 15 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := s.cache.setEPG(tc.programs); err != nil {
				t.Fatal(err)
			}
			if got := s.nextScheduledRefresh(false, now, guideRefreshInterval); !got.Equal(now.Add(tc.wait)) {
				t.Fatalf("got %s, want %s", got, now.Add(tc.wait))
			}
		})
	}
}

type emptyGuideProvider struct {
	fixtureProvider
	guide []model.Program
}

func (p *emptyGuideProvider) EPG(context.Context) ([]model.Program, error) { return p.guide, nil }

func TestUnusableGuideResponsePreservesCacheAndDelaysRetry(t *testing.T) {
	for _, name := range []string{"empty", "expired", "malformed"} {
		t.Run(name, func(t *testing.T) {
			cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RefreshInterval: 24 * time.Hour}
			s, err := New(cfg, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			if err := s.cache.setEPG([]model.Program{{ChannelID: "live:1", Title: "Saved", Start: now.Add(-time.Hour), End: now.Add(3 * time.Hour)}}); err != nil {
				t.Fatal(err)
			}
			s.Close()
			p := &emptyGuideProvider{}
			switch name {
			case "expired":
				p.guide = []model.Program{{ChannelID: "live:1", Start: now.Add(-2 * time.Hour), End: now.Add(-time.Hour)}}
			case "malformed":
				p.guide = []model.Program{{ChannelID: "", Start: now, End: now.Add(time.Hour)}}
			}
			s, err = New(cfg, p, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			ts := httptest.NewServer(s)
			defer ts.Close()
			code, body := request(t, ts.URL, "POST", "/api/refresh", `{"target":"epg"}`)
			if code != 202 {
				t.Fatal(code, body)
			}
			waitFor(t, func() bool {
				s.stateMu.RLock()
				defer s.stateMu.RUnlock()
				return s.epgSync.Failures == 1 && !s.epgSync.Running
			})
			s.stateMu.RLock()
			state := s.epgSync
			s.stateMu.RUnlock()
			if state.NextRefreshAt == nil || state.NextRefreshAt.Sub(*state.FinishedAt) < 15*time.Minute {
				t.Fatal("empty guide retry is too soon", state)
			}
			s.cache.mu.RLock()
			saved := append([]model.Program(nil), s.cache.programs...)
			s.cache.mu.RUnlock()
			if len(saved) != 1 || saved[0].Title != "Saved" {
				t.Fatal("unusable response discarded saved guide", saved)
			}
		})
	}
}
