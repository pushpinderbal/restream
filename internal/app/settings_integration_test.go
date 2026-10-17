package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

func settingsRequest(t *testing.T, runtime *Runtime, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, "http://localhost/api/settings", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	runtime.ServeHTTP(w, r)
	return w
}
func TestApplicationSettingsPersistenceAndRedaction(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), SessionTTL: time.Minute}
	// Production always starts from the settings database, never Config fixture values.
	cfg.PortalURL = "http://ignored.invalid"
	cfg.MAC = "ignored"
	cfg.TMDBReadAccessToken = "ignored"
	runtime, err := NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	response := settingsRequest(t, runtime, "GET", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), "ignored") {
		t.Fatalf("initial settings: %d %s", response.Code, response.Body)
	}
	patch := `{"provider":{"timezone":"Europe/London"},"library":{"refreshIntervalSeconds":7200,"dashboardCategories":["movie:1"],"blockedCategories":["series:2"],"guideHours":12},"discovery":{"tmdbReadAccessToken":"private-token"},"playback":{"maxStreams":3,"transcodeMode":"copy"}}`
	response = settingsRequest(t, runtime, "PATCH", patch)
	if response.Code != 200 {
		t.Fatalf("save: %d %s", response.Code, response.Body)
	}
	if strings.Contains(response.Body.String(), "private-token") {
		t.Fatal("response leaked token")
	}
	runtime.Close()
	runtime, err = NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	response = settingsRequest(t, runtime, "GET", "")
	var got settingsResponse
	if err = json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Provider.Timezone != "Europe/London" || got.Library.RefreshIntervalSeconds != 7200 || !got.Discovery.TMDBTokenConfigured || got.Playback.MaxStreams != 3 {
		t.Fatalf("persisted settings missing: %+v", got)
	}
	if runtime.server.cfg.TMDBReadAccessToken != "private-token" || runtime.server.cfg.RefreshInterval != 2*time.Hour {
		t.Fatal("saved settings did not reach server")
	}
	preferences := httptest.NewRecorder()
	runtime.ServeHTTP(preferences, httptest.NewRequest("GET", "/api/preferences", nil))
	if !strings.Contains(preferences.Body.String(), `"dashboardCategories":["movie:1"]`) {
		t.Fatalf("preferences not updated: %s", preferences.Body)
	}
	response = settingsRequest(t, runtime, "PATCH", `{"discovery":{"tmdbReadAccessToken":""}}`)
	if response.Code != 200 || runtime.server.tmdbConfigured() {
		t.Fatalf("clear token: %d %s", response.Code, response.Body)
	}
	if runtime.settings.Library.GuideHours != 12 {
		t.Fatal("partial update reset unrelated setting")
	}
}
func TestApplicationSettingsValidationAndOrigin(t *testing.T) {
	runtime, err := NewRuntime(Config{DataDir: t.TempDir(), WebDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	before := runtime.settings.UpdatedAt
	for _, body := range []string{`null`, `[]`, `{} {}`, `{"unknown":true}`, `{"provider":{"extra":1}}`, `{"provider":null}`, `{"provider":{"timezone":null}}`, `{"provider":{"portalUrl":"not-a-valid-url-secret"}}`, `{"provider":{"timezone":"bad/timezone"}}`, `{"library":{"refreshIntervalSeconds":1}}`, `{"library":{"guideHours":0}}`, `{"playback":{"maxStreams":0}}`, `{"playback":{"transcodeMode":"invalid"}}`, `{"discovery":{"tmdbReadAccessToken":null}}`, `{"discovery":{"unknown":"private-secret"}}`, `{"library":{"blockedCategories":["series:"]}}`, strings.Repeat("x", 300<<10)} {
		response := settingsRequest(t, runtime, "PATCH", body)
		if response.Code != 400 {
			t.Errorf("expected 400 for %q: %d %s", body[:min(len(body), 100)], response.Code, response.Body)
		}
		if strings.Contains(response.Body.String(), "secret") {
			t.Fatal("validation leaked submitted value")
		}
	}
	if !runtime.settings.UpdatedAt.Equal(before) {
		t.Fatal("invalid settings changed stored values")
	}
	r := httptest.NewRequest("PATCH", "http://localhost/api/settings", bytes.NewBufferString(`{"playback":{"maxStreams":2}}`))
	r.Header.Set("Origin", "http://evil.example")
	w := httptest.NewRecorder()
	runtime.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross origin allowed: %d", w.Code)
	}
}
func TestApplicationSettingsPreserveActivePlaybackAndCache(t *testing.T) {
	runtime, err := NewRuntime(Config{DataDir: t.TempDir(), WebDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	manager, err := stream.New(stream.Config{MaxStreams: 1, TranscodeMode: "auto", DataDir: runtime.base.DataDir}, func(ctx context.Context, item model.Item) (model.Source, error) {
		<-ctx.Done()
		return model.Source{}, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.manager = manager
	runtime.server.streams = manager
	item := model.Item{ID: "live:1", Kind: "live", Name: "Test channel", CategoryID: "news"}
	if err = runtime.server.cache.setCatalog([]model.Item{item}); err != nil {
		t.Fatal(err)
	}
	session, err := manager.Start(context.Background(), item, 0)
	if err != nil {
		t.Fatal(err)
	}
	runtime.server.sessionItems[session.ID] = item
	for _, body := range []string{`{"provider":{"timezone":"Europe/London"}}`, `{"library":{"guideHours":12}}`} {
		w := settingsRequest(t, runtime, "PATCH", body)
		if w.Code != 409 || !strings.Contains(w.Body.String(), "streams_active") {
			t.Fatalf("provider change while playing: %d %s", w.Code, w.Body)
		}
	}
	w := settingsRequest(t, runtime, "PATCH", `{"library":{"refreshIntervalSeconds":3600},"playback":{"maxStreams":2,"transcodeMode":"copy"}}`)
	if w.Code != 200 {
		t.Fatalf("non-provider save: %d %s", w.Code, w.Body)
	}
	if runtime.manager != manager {
		t.Fatal("playback manager replaced")
	}
	if _, err = manager.Get(session.ID); err != nil {
		t.Fatal("playback session lost", err)
	}
	if runtime.server.sessionItems[session.ID].ID != item.ID {
		t.Fatal("active session policy lost")
	}
	if _, ok := runtime.server.cache.item(item.ID); !ok {
		t.Fatal("library cache cleared")
	}
	w = settingsRequest(t, runtime, "PATCH", `{"library":{"blockedCategories":["live:news"]}}`)
	if w.Code != 200 {
		t.Fatalf("block category: %d %s", w.Code, w.Body)
	}
	if _, err = manager.Get(session.ID); err == nil {
		t.Fatal("blocked active session was not stopped")
	}
}

func TestApplicationSettingsProviderSwitchKeepsSettingsClearsLibrary(t *testing.T) {
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"js":{"token":"test","data":[]}}`))
	}))
	defer portal.Close()
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RequestTimeout: time.Second, RequestInterval: 100 * time.Millisecond}
	runtime, err := NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = runtime.server.cache.setCatalog([]model.Item{{ID: "live:old", Kind: "live", Name: "Old provider"}}); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"provider": map[string]any{"portalUrl": portal.URL, "mac": "00:1A:79:00:00:01"}, "library": map[string]any{"refreshIntervalSeconds": 7200}})
	response := settingsRequest(t, runtime, "PATCH", string(body))
	if response.Code != 200 {
		t.Fatalf("provider save: %d %s", response.Code, response.Body)
	}
	if runtime.provider == nil || runtime.manager == nil {
		t.Fatal("provider and playback not created")
	}
	if _, ok := runtime.server.cache.item("live:old"); ok {
		t.Fatal("previous provider library retained")
	}
	response = settingsRequest(t, runtime, "PATCH", `{"provider":{"portalUrl":"","mac":""}}`)
	if response.Code != 200 {
		t.Fatalf("clear provider: %d %s", response.Code, response.Body)
	}
	if runtime.provider != nil || runtime.manager != nil {
		t.Fatal("provider not cleared")
	}
	runtime.Close()
	runtime, err = NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if runtime.settings.Library.RefreshIntervalSeconds != 7200 {
		t.Fatal("provider cache reset cleared application settings")
	}
}

func TestApplicationSettingsTokenChangeRetainsRailAndRetriesMetadata(t *testing.T) {
	runtime, err := NewRuntime(Config{DataDir: t.TempDir(), WebDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if w := settingsRequest(t, runtime, "PATCH", `{"discovery":{"tmdbReadAccessToken":"old-token"}}`); w.Code != 200 {
		t.Fatal(w.Body)
	}
	record := discoveryRecord{Version: 1, HadMetadata: true, NextAttempt: time.Now().Add(time.Hour), Metadata: map[string]discoveryMetadata{"movie": {FetchedAt: time.Now()}}, Movies: []DiscoveryTitle{{Name: "Saved movie"}}}
	data, _ := json.Marshal(record)
	if _, err = runtime.server.cache.db.Exec(`INSERT INTO discovery(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, data); err != nil {
		t.Fatal(err)
	}
	runtime.server.discoveryService.record = record
	if w := settingsRequest(t, runtime, "PATCH", `{"discovery":{"tmdbReadAccessToken":"new-token"}}`); w.Code != 200 {
		t.Fatal(w.Body)
	}
	got := runtime.server.discoveryService.record
	if !got.NextAttempt.IsZero() || len(got.Metadata) != 0 || len(got.Movies) != 1 {
		t.Fatalf("token change did not invalidate metadata while retaining saved rail: %+v", got)
	}
}

func TestApplicationSettingsPersistenceFailureRestoresRuntime(t *testing.T) {
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"js":{"token":"test","data":[]}}`))
	}))
	defer portal.Close()
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RequestTimeout: time.Second, RequestInterval: 100 * time.Millisecond}
	runtime, err := NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	body, _ := json.Marshal(map[string]any{"provider": map[string]string{"portalUrl": portal.URL, "mac": "00:1A:79:00:00:01"}})
	if w := settingsRequest(t, runtime, "PATCH", string(body)); w.Code != 200 {
		t.Fatalf("configure provider: %d %s", w.Code, w.Body)
	}
	previous := runtime.settings
	previousProvider := runtime.provider
	// Hold resolver work so capacity assertions cannot race failed source resolution.
	_ = runtime.manager.Close()
	manager, err := stream.New(stream.Config{MaxStreams: 1, TranscodeMode: "auto", DataDir: cfg.DataDir}, func(ctx context.Context, item model.Item) (model.Source, error) {
		<-ctx.Done()
		return model.Source{}, ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	runtime.manager = manager
	runtime.server.streams = manager
	cached := model.Item{ID: "movie:rollback", Kind: "movie", Name: "Saved movie"}
	tx, err := runtime.server.cache.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err = insertItem(tx, cached); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	runtime.server.cache.mu.Lock()
	runtime.server.cache.byID[cached.ID] = cached
	runtime.server.cache.mu.Unlock()
	if _, err = runtime.db.Exec(`CREATE TRIGGER settings_write_failure BEFORE UPDATE ON application_settings BEGIN SELECT RAISE(FAIL, 'private database failure'); END`); err != nil {
		t.Fatal(err)
	}
	assertAvailable := func() {
		t.Helper()
		w := httptest.NewRecorder()
		runtime.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
		if w.Code != 200 {
			t.Fatalf("health unavailable: %d %s", w.Code, w.Body)
		}
		w = settingsRequest(t, runtime, "GET", "")
		if w.Code != 200 {
			t.Fatalf("settings unavailable: %d %s", w.Code, w.Body)
		}
	}
	w := settingsRequest(t, runtime, "PATCH", `{"playback":{"maxStreams":2,"transcodeMode":"copy"}}`)
	if w.Code != 500 || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("playback persistence failure not sanitized: %d %s", w.Code, w.Body)
	}
	if runtime.settings.Playback != previous.Playback || runtime.server.cfg.MaxStreams != 1 || runtime.server.cfg.TranscodeMode != "auto" || !runtime.settings.UpdatedAt.Equal(previous.UpdatedAt) {
		t.Fatal("failed playback save changed configuration")
	}
	first, err := manager.Start(context.Background(), cached, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Start(context.Background(), cached, 0); !errors.Is(err, stream.ErrCapacity) {
		t.Fatalf("manager capacity was not restored: %v", err)
	}
	_ = manager.Stop(first.ID)
	assertAvailable()
	w = settingsRequest(t, runtime, "PATCH", `{"provider":{"mac":"00:1A:79:00:00:02"}}`)
	if w.Code != 500 || strings.Contains(w.Body.String(), "private") {
		t.Fatalf("provider persistence failure not sanitized: %d %s", w.Code, w.Body)
	}
	if runtime.settings.Provider != previous.Provider || runtime.server.cfg.MAC != previous.Provider.MAC || runtime.provider == nil || runtime.manager == nil || runtime.provider == previousProvider {
		t.Fatal("previous provider generation was not reconstructed")
	}
	if _, ok := runtime.server.cache.item(cached.ID); !ok {
		t.Fatal("failed provider save cleared cached library")
	}
	if _, err = os.Stat(filepath.Join(cfg.DataDir, "streams")); err != nil {
		t.Fatal("restored streams directory missing", err)
	}
	probe := filepath.Join(cfg.DataDir, "streams", "writable")
	if err = os.WriteFile(probe, []byte("ok"), 0600); err != nil {
		t.Fatal("restored streams directory unusable", err)
	}
	session, err := runtime.manager.Start(context.Background(), cached, 0)
	if err != nil {
		t.Fatal("restored playback manager unusable", err)
	}
	_ = runtime.manager.Stop(session.ID)
	assertAvailable()
	var persisted applicationSettings
	var data []byte
	if err = runtime.db.QueryRow(`SELECT data FROM application_settings WHERE id=1`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Provider != previous.Provider || persisted.Playback != previous.Playback || !persisted.UpdatedAt.Equal(previous.UpdatedAt) {
		t.Fatal("failed save altered persisted configuration")
	}
}

func TestApplicationSettingsProviderEnvironmentPrecedenceAndRedaction(t *testing.T) {
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"js":{"token":"test","data":[]}}`))
	}))
	defer portal.Close()
	base := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RequestTimeout: time.Second, RequestInterval: 100 * time.Millisecond}
	runtime, err := NewRuntime(base)
	if err != nil {
		t.Fatal(err)
	}
	saved := ProviderSettings{PortalURL: portal.URL + "/saved", MAC: "00:1A:79:00:00:01", Timezone: "UTC", SerialNumber: "saved-serial", DeviceID: "saved-id", DeviceID2: "saved-id-2"}
	body, _ := json.Marshal(map[string]any{"provider": saved})
	if w := settingsRequest(t, runtime, "PATCH", string(body)); w.Code != 200 {
		t.Fatal(w.Body)
	}
	runtime.Close()
	values := map[string]string{"STALKER_PORTAL_URL": portal.URL + "/environment", "STALKER_MAC": "00:1A:79:00:00:02", "STALKER_TIMEZONE": "Europe/London", "STALKER_SERIAL_NUMBER": "", "STALKER_DEVICE_ID": "environment-device-secret", "STALKER_DEVICE_ID2": "environment-device-secret-2"}
	for key, value := range values {
		t.Setenv(key, value)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.DataDir, cfg.WebDir = base.DataDir, base.WebDir
	runtime, err = NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.server.cfg.PortalURL != values["STALKER_PORTAL_URL"] || runtime.server.cfg.MAC != values["STALKER_MAC"] || runtime.server.cfg.SerialNumber != "" || runtime.server.cfg.DeviceID != values["STALKER_DEVICE_ID"] {
		t.Fatal("environment did not override saved provider fields")
	}
	assertMasked := func(w *httptest.ResponseRecorder) {
		t.Helper()
		if w.Code != 200 {
			t.Fatalf("settings response: %d %s", w.Code, w.Body)
		}
		var got settingsResponse
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.Provider != (ProviderSettings{}) || len(got.ProviderEnvironment) != 6 {
			t.Fatalf("environment fields not redacted/listed: %+v", got)
		}
		for _, secret := range []string{values["STALKER_PORTAL_URL"], values["STALKER_MAC"], values["STALKER_DEVICE_ID"], "saved-serial"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatal("settings exposed a managed provider value")
			}
		}
	}
	assertMasked(settingsRequest(t, runtime, "GET", ""))
	for _, key := range []string{"portalUrl", "mac", "timezone", "serialNumber", "deviceId", "deviceId2", "PORTALURL", "DeViCeId"} {
		previous := runtime.settings.UpdatedAt
		patch, _ := json.Marshal(map[string]any{"provider": map[string]string{key: ""}, "playback": map[string]int{"maxStreams": 3}})
		w := settingsRequest(t, runtime, "PATCH", string(patch))
		if w.Code != 403 || !strings.Contains(w.Body.String(), "environment_managed") {
			t.Fatalf("managed field %s was not locked: %d %s", key, w.Code, w.Body)
		}
		if runtime.settings.Playback.MaxStreams != 1 || !runtime.settings.UpdatedAt.Equal(previous) {
			t.Fatal("managed-field rejection partially applied settings")
		}
	}
	w := settingsRequest(t, runtime, "PATCH", `{"provider":{"deviceId":""},"provider":{}}`)
	if w.Code != 403 {
		t.Fatalf("repeated section evaded managed-field rejection: %d", w.Code)
	}
	assertMasked(settingsRequest(t, runtime, "PATCH", `{"library":{"refreshIntervalSeconds":7200},"playback":{"maxStreams":2}}`))
	var encoded []byte
	if err = runtime.db.QueryRow(`SELECT data FROM application_settings WHERE id=1`).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	var persisted applicationSettings
	if err = json.Unmarshal(encoded, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.Provider != saved {
		t.Fatal("environment fields changed saved provider settings")
	}
	for _, secret := range []string{values["STALKER_PORTAL_URL"], values["STALKER_MAC"], values["STALKER_DEVICE_ID"]} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatal("environment credential persisted in settings")
		}
	}
	runtime.Close()
	runtime, err = NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	assertMasked(settingsRequest(t, runtime, "GET", ""))
	runtime.Close()
	runtime, err = NewRuntime(base)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if runtime.server.cfg.PortalURL != saved.PortalURL || runtime.server.cfg.SerialNumber != saved.SerialNumber {
		t.Fatal("removing environment did not restore saved provider settings")
	}
	var got settingsResponse
	if err = json.Unmarshal(settingsRequest(t, runtime, "GET", "").Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.ProviderEnvironment) != 0 || got.Provider != saved {
		t.Fatal("removed environment still locked provider")
	}
}

func TestApplicationSettingsPartialProviderEnvironmentAndDrafts(t *testing.T) {
	portal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"js":{"token":"test","data":[]}}`))
	}))
	defer portal.Close()
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), RequestTimeout: time.Second, RequestInterval: 100 * time.Millisecond, providerEnvironment: map[string]string{"portalUrl": portal.URL}}
	runtime, err := NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.provider != nil {
		t.Fatal("partial provider was configured")
	}
	if w := settingsRequest(t, runtime, "PATCH", `{"playback":{"maxStreams":2}}`); w.Code != 200 {
		t.Fatalf("unrelated save blocked during setup: %d %s", w.Code, w.Body)
	}
	w := settingsRequest(t, runtime, "PATCH", `{"provider":{"mac":"00:1A:79:00:00:01","serialNumber":"editable-serial"}}`)
	if w.Code != 200 || runtime.provider == nil || runtime.server.cfg.SerialNumber != "editable-serial" {
		t.Fatalf("unlocked provider fields not applied: %d %s", w.Code, w.Body)
	}
	if runtime.settings.Provider.PortalURL != "" {
		t.Fatal("environment portal copied into settings")
	}
	runtime.Close()
	cfg.providerEnvironment = nil
	runtime, err = NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if runtime.provider != nil || runtime.settings.Provider.MAC != "00:1A:79:00:00:01" {
		t.Fatal("removing partial environment should allow setup repair")
	}
	body, _ := json.Marshal(map[string]any{"provider": map[string]string{"portalUrl": portal.URL}})
	if w = settingsRequest(t, runtime, "PATCH", string(body)); w.Code != 200 || runtime.provider == nil {
		t.Fatalf("provider draft could not be completed: %d %s", w.Code, w.Body)
	}
}

func TestApplicationSettingsInvalidProviderEnvironmentIsSanitized(t *testing.T) {
	for key, value := range map[string]string{"portalUrl": "bad-private-url-secret", "mac": "private-mac-secret", "timezone": "private-timezone-secret", "deviceId": "private-device-secret\ninvalid"} {
		cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir(), providerEnvironment: map[string]string{key: value}}
		runtime, err := NewRuntime(cfg)
		if err == nil {
			runtime.Close()
			t.Fatalf("invalid environment %s accepted", key)
		}
		if strings.Contains(err.Error(), "private") {
			t.Fatalf("invalid environment error exposed value: %v", err)
		}
	}
}
