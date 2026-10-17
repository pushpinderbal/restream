package app

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stalker"
	"github.com/pushpinderbal/restream/internal/stream"
)

// Runtime applies saved configuration between immutable server generations.
// Requests finish against their generation before settings replace it.
type Runtime struct {
	mu       sync.RWMutex
	base     Config
	settings applicationSettings
	db       *sql.DB
	server   *Server
	manager  *stream.Manager
	provider model.Provider
	handler  http.Handler
	closed   bool
}

func NewRuntime(cfg Config) (*Runtime, error) {
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(cfg.DataDir, "restream.sqlite")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	_ = file.Close()
	if err = os.Chmod(path, 0600); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err = db.Exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS application_settings(id INTEGER PRIMARY KEY CHECK(id=1),data BLOB NOT NULL);`); err != nil {
		_ = db.Close()
		return nil, err
	}
	rt := &Runtime{base: cfg, db: db, settings: defaultSettings()}
	var data []byte
	err = db.QueryRow(`SELECT data FROM application_settings WHERE id=1`).Scan(&data)
	if err == nil {
		err = json.Unmarshal(data, &rt.settings)
	} else if errors.Is(err, sql.ErrNoRows) {
		rt.settings.UpdatedAt = time.Now().UTC()
		err = rt.persist(rt.settings)
	}
	if err == nil {
		err = rt.settings.validate(cfg.providerEnvironment)
	}
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	effective, err := rt.settings.config(cfg)
	if err == nil {
		rt.provider, rt.manager, err = runtimeDependencies(effective)
	}
	if err == nil {
		rt.server, err = New(effective, rt.provider, streamInterface(rt.manager))
	}
	if err != nil {
		if rt.manager != nil {
			_ = rt.manager.Close()
		}
		_ = db.Close()
		return nil, err
	}
	guard := http.NewCrossOriginProtection()
	guard.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fail(w, 403, "origin", "Cross-origin requests are not allowed.")
	}))
	rt.handler = guard.Handler(http.HandlerFunc(rt.serve))
	return rt, nil
}
func runtimeDependencies(cfg Config) (model.Provider, *stream.Manager, error) {
	if cfg.PortalURL == "" || cfg.MAC == "" {
		return nil, nil, nil
	}
	p, err := stalker.New(stalker.Config{RequestTimeout: cfg.RequestTimeout, RequestInterval: cfg.RequestInterval, EPGHours: cfg.EPGHours, MaxResponseBytes: cfg.MaxResponseBytes, PortalURL: cfg.PortalURL, MAC: cfg.MAC, Timezone: cfg.Timezone, UserAgent: cfg.UserAgent, SerialNumber: cfg.SerialNumber, DeviceID: cfg.DeviceID, DeviceID2: cfg.DeviceID2})
	if err != nil {
		return nil, nil, err
	}
	m, err := stream.New(stream.Config{MaxStreams: cfg.MaxStreams, SessionTTL: cfg.SessionTTL, DataDir: cfg.DataDir, TranscodeMode: cfg.TranscodeMode}, p.Resolve)
	return p, m, err
}
func streamInterface(manager *stream.Manager) Streams {
	if manager == nil {
		return nil
	}
	return manager
}
func (rt *Runtime) persist(settings applicationSettings) error {
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = rt.db.Exec(`INSERT INTO application_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, data)
	return err
}
func (rt *Runtime) ServeHTTP(w http.ResponseWriter, r *http.Request) { rt.handler.ServeHTTP(w, r) }
func (rt *Runtime) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/settings" {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			rt.mu.RLock()
			defer rt.mu.RUnlock()
			if rt.closed {
				fail(w, 503, "unavailable", "Application is shutting down.")
				return
			}
			respond(w, 200, rt.settings.response(rt.base.providerEnvironment))
		case http.MethodPatch:
			rt.updateSettings(w, r)
		default:
			w.Header().Set("Allow", "GET, HEAD, PATCH")
			fail(w, 405, "method", "Method not allowed.")
		}
		return
	}
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	if rt.closed || rt.server == nil {
		fail(w, 503, "unavailable", "Application is shutting down.")
		return
	}
	rt.server.ServeHTTP(w, r)
}
func (rt *Runtime) updateSettings(w http.ResponseWriter, r *http.Request) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.closed || rt.server == nil {
		fail(w, 503, "unavailable", "Application is shutting down.")
		return
	}
	next, err := mergeSettings(rt.settings, http.MaxBytesReader(w, r.Body, 256<<10), rt.base.providerEnvironment)
	if err != nil {
		if errors.Is(err, errEnvironmentManaged) {
			fail(w, 403, "environment_managed", err.Error())
			return
		}
		fail(w, 400, "invalid_settings", err.Error())
		return
	}
	if reflect.DeepEqual(next, rt.settings) {
		respond(w, 200, rt.settings.response(rt.base.providerEnvironment))
		return
	}
	providerChanged := effectiveProvider(next.Provider, rt.base.providerEnvironment) != effectiveProvider(rt.settings.Provider, rt.base.providerEnvironment) || next.Library.GuideHours != rt.settings.Library.GuideHours
	if providerChanged && rt.manager != nil && rt.manager.Active() > 0 {
		fail(w, 409, "streams_active", "Stop active playback before changing provider or guide settings.")
		return
	}
	cfg, err := next.config(rt.base)
	if err != nil {
		fail(w, 400, "invalid_settings", err.Error())
		return
	}
	oldServer := rt.server
	provider, manager := rt.provider, rt.manager
	if providerChanged {
		oldServer.Close()
		if rt.manager != nil {
			_ = rt.manager.Close()
		}
		provider, manager, err = runtimeDependencies(cfg)
		if err != nil {
			rt.restoreGeneration(true, oldServer)
			fail(w, 500, "settings_unavailable", "Unable to prepare playback for these settings.")
			return
		}
	} else if manager != nil {
		if err = manager.Configure(cfg.MaxStreams, cfg.TranscodeMode); err != nil {
			fail(w, 400, "invalid_settings", "Unable to apply playback settings.")
			return
		}
	}
	next.UpdatedAt = time.Now().UTC()
	if err = rt.persist(next); err != nil {
		if providerChanged {
			if manager != nil {
				_ = manager.Close()
			}
			rt.restoreGeneration(true, oldServer)
		} else if rt.manager != nil {
			_ = rt.manager.Configure(rt.settings.Playback.MaxStreams, rt.settings.Playback.TranscodeMode)
		}
		fail(w, 500, "settings_save", "Unable to save settings.")
		return
	}
	if !providerChanged {
		oldServer.Close()
	}
	if next.TMDBReadAccessToken != rt.settings.TMDBReadAccessToken {
		record := oldServer.discoveryService.record
		record.NextAttempt = time.Time{}
		record.Metadata = nil
		record.Error = ""
		data, _ := json.Marshal(record)
		_, _ = rt.db.Exec(`UPDATE discovery SET data=? WHERE id=1`, data)
	}
	if next.Library.GuideHours != rt.settings.Library.GuideHours || next.Provider.Timezone != rt.settings.Provider.Timezone {
		_, _ = rt.db.Exec(`DELETE FROM meta WHERE key='epg_at'`)
	}
	server, err := New(cfg, provider, streamInterface(manager))
	if err != nil {
		_ = rt.persist(rt.settings)
		if providerChanged && manager != nil {
			_ = manager.Close()
		}
		rt.restoreGeneration(providerChanged, oldServer)
		fail(w, 500, "settings_apply", "Unable to apply settings.")
		return
	}
	if !providerChanged {
		server.sessionItems = oldServer.sessionItems
	}
	rt.server, rt.provider, rt.manager, rt.settings = server, provider, manager, next
	server.stopBlockedSessions()
	respond(w, 200, next.response(rt.base.providerEnvironment))
}

// Restore the previous immutable generation if applying a saved change fails.
func (rt *Runtime) restoreGeneration(providerChanged bool, previous *Server) {
	cfg, _ := rt.settings.config(rt.base)
	if providerChanged {
		var err error
		rt.provider, rt.manager, err = runtimeDependencies(cfg)
		if err != nil {
			rt.server = nil
			return
		}
	} else if rt.manager != nil {
		_ = rt.manager.Configure(cfg.MaxStreams, cfg.TranscodeMode)
	}
	rt.server, _ = New(cfg, rt.provider, streamInterface(rt.manager))
	if rt.server != nil && !providerChanged {
		rt.server.sessionItems = previous.sessionItems
	}
}
func (rt *Runtime) Close() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.closed {
		return
	}
	rt.closed = true
	if rt.server != nil {
		rt.server.Close()
	}
	if rt.manager != nil {
		_ = rt.manager.Close()
	}
	_ = rt.db.Close()
}
