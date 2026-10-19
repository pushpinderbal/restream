package app

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stream"
)

type CategoryPreference struct {
	Kind       string `json:"kind"`
	ID         string `json:"id"`
	Visibility string `json:"visibility"`
	Dashboard  bool   `json:"dashboard"`
}

type Preferences struct {
	RefreshIntervalSeconds int64                `json:"refreshIntervalSeconds"`
	Categories             []CategoryPreference `json:"categories"`
}

// Configuration snapshots are immutable in production. The lock keeps request
// readers independent from startup/cache bookkeeping and deployment fixtures.
type preferenceSnapshot struct {
	value       Preferences
	updatedAt   time.Time
	blocked     bool
	environment categoryEnvironment
}

type preferencesService struct {
	mu       sync.RWMutex
	snapshot *preferenceSnapshot
}

func categoryPreferenceKey(kind, id string) string { return kind + "\x00" + id }

func containsCategory(categories []string, id string) bool {
	for _, category := range categories {
		if category == id {
			return true
		}
	}
	return false
}

func (s *Server) initPreferences() error {
	value := Preferences{RefreshIntervalSeconds: int64(s.cfg.RefreshInterval.Seconds()), Categories: []CategoryPreference{}}
	updatedAt, err := s.configurationVersion(value.RefreshIntervalSeconds)
	if err != nil {
		return err
	}
	// The saved application configuration is authoritative for each server generation.
	s.preferencesService = &preferencesService{snapshot: &preferenceSnapshot{
		value: value, updatedAt: updatedAt,
		blocked: len(s.cfg.categoryEnvironment.blocked) > 0, environment: s.cfg.categoryEnvironment,
	}}
	return nil
}

// This metadata records only a hash and revision time for cache invalidation.
// It stores no editable choices and can never restore configuration values.
func (s *Server) configurationVersion(seconds int64) (time.Time, error) {
	configuration := struct {
		RefreshIntervalSeconds int64                 `json:"refreshIntervalSeconds"`
		Categories             categoryConfiguration `json:"categories"`
	}{seconds, s.cfg.categoryEnvironment.configuration()}
	encoded, err := json.Marshal(configuration)
	if err != nil {
		return time.Time{}, err
	}
	sum := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(sum[:])
	var saved struct {
		Fingerprint string    `json:"fingerprint"`
		UpdatedAt   time.Time `json:"updatedAt"`
	}
	var data string
	err = s.cache.db.QueryRow(`SELECT value FROM meta WHERE key='configuration_revision'`).Scan(&data)
	if err != nil && err != sql.ErrNoRows {
		return time.Time{}, err
	}
	if err == nil && json.Unmarshal([]byte(data), &saved) == nil && saved.Fingerprint == fingerprint && !saved.UpdatedAt.IsZero() {
		return saved.UpdatedAt, nil
	}
	saved.Fingerprint, saved.UpdatedAt = fingerprint, time.Now().UTC()
	encoded, err = json.Marshal(saved)
	if err == nil {
		_, err = s.cache.db.Exec(`INSERT INTO meta(key,value) VALUES('configuration_revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, string(encoded))
	}
	return saved.UpdatedAt, err
}

func (s *Server) preferencesSnapshot() *preferenceSnapshot {
	p := s.preferencesService
	p.mu.RLock()
	value := p.snapshot
	p.mu.RUnlock()
	return value
}

func (s *Server) getPreferences(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		fail(w, http.StatusMethodNotAllowed, "read_only", "Use application settings to update configuration.")
		return
	}
	respond(w, http.StatusOK, s.effectivePreferences(s.preferencesSnapshot()))
}

func (p *preferenceSnapshot) category(kind, id string, names ...string) CategoryPreference {
	category := CategoryPreference{Kind: kind, ID: id, Visibility: "show", Dashboard: true}
	name := ""
	if len(names) > 0 {
		name = names[0]
	}
	if p.environment.dashboardManaged() {
		category.Dashboard = matchesCategory(p.environment.dashboard, kind, id, name)
	}
	if matchesCategory(p.environment.blocked, kind, id, name) {
		category.Visibility = "block"
	}
	return category
}

func (p *preferenceSnapshot) restricted() bool { return p.environment.configured() }

func (s *Server) episodeParentLocked(item model.Item) (model.Item, bool) {
	if item.SeriesID != "" {
		if parent, ok := s.cache.byID["series:"+item.SeriesID]; ok {
			return parent, true
		}
	}
	if parts := strings.Split(item.ID, ":"); len(parts) >= 2 && (parts[0] == "episode" || parts[0] == "season") {
		if parent, ok := s.cache.byID["series:"+parts[1]]; ok {
			return parent, true
		}
	}
	// Legacy/imported portals can use opaque episode IDs. Their persisted
	// episode list still supplies an authoritative parent relationship.
	for key, episodes := range s.cache.episodes {
		parentID, _, _ := strings.Cut(key, "#")
		parent, ok := s.cache.byID[parentID]
		if !ok || parent.Kind != "series" {
			continue
		}
		for _, episode := range episodes {
			if episode.ID == item.ID {
				return parent, true
			}
		}
	}
	return model.Item{}, false
}

// Caller holds cache.mu. Episode restrictions always inherit the series;
// blank child category metadata must never bypass a blocked parent.
func (s *Server) itemPreferenceLocked(item model.Item, p *preferenceSnapshot) CategoryPreference {
	if current, ok := s.cache.byID[item.ID]; ok && current.Kind == item.Kind {
		item = current
	}
	kind := item.Kind
	if kind == "episode" || kind == "season" {
		if parent, ok := s.episodeParentLocked(item); ok {
			item = parent
		} else {
			if p.environment.blocksKind("series") {
				return CategoryPreference{Kind: "series", Visibility: "block"}
			}
		}
		kind = "series"
	}
	if item.CategoryID != "" {
		if !p.environment.configured() {
			return p.category(kind, item.CategoryID)
		}
		name := item.Category
		for _, metadata := range s.cache.categories {
			if metadata.Kind == kind && strings.EqualFold(metadata.ID, item.CategoryID) {
				name = metadata.Name
				break
			}
		}
		return p.category(kind, item.CategoryID, name)
	}
	result := p.category(kind, "", item.Category)
	if item.Category == "" {
		return result
	}
	resolved := false
	for _, metadata := range s.cache.categories {
		if metadata.Kind != kind || !strings.EqualFold(strings.TrimSpace(metadata.Name), strings.TrimSpace(item.Category)) {
			continue
		}
		category := p.category(kind, metadata.ID, metadata.Name)
		if !resolved {
			result.Dashboard = category.Dashboard
			resolved = true
		} else {
			result.Dashboard = result.Dashboard && category.Dashboard
		}
		if category.Visibility == "block" {
			result.Visibility = category.Visibility
		}
	}
	return result
}

func (s *Server) itemPreference(item model.Item) CategoryPreference {
	p := s.preferencesSnapshot()
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	return s.itemPreferenceLocked(item, p)
}

func (s *Server) visibleItems(items []model.Item, dashboard bool) []model.Item {
	p := s.preferencesSnapshot()
	if !p.restricted() {
		return items
	}
	result := make([]model.Item, 0, len(items))
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	for _, item := range items {
		category := s.itemPreferenceLocked(item, p)
		if category.Visibility == "show" && (!dashboard || category.Dashboard) {
			result = append(result, item)
		}
	}
	return result
}

func (s *Server) browseCategoryAllowed(kind, id string) bool {
	p := s.preferencesSnapshot()
	if id != "*" {
		return s.categoryPolicy(kind, id).Visibility == "show"
	}
	if !p.environment.blocksKind(kind) {
		return true
	}
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	for _, category := range s.cache.categories {
		if category.Kind == kind && p.category(kind, category.ID, category.Name).Visibility == "show" {
			return true
		}
	}
	return false
}

func (s *Server) blockedItem(item model.Item) bool {
	return s.itemPreference(item).Visibility == "block"
}

func blocked(w http.ResponseWriter) {
	fail(w, 403, "blocked", "Category blocked by server configuration.")
}

func (s *Server) rememberSession(r *http.Request, id string, item model.Item) bool {
	s.sessionItemsMu.Lock()
	if len(s.sessionItems) >= 256 {
		for previousID := range s.sessionItems {
			if _, err := s.streams.Get(previousID); err != nil {
				delete(s.sessionItems, previousID)
				delete(s.sessionOwners, previousID)
			}
		}
	}
	s.sessionItems[id] = item
	if user := authenticatedUser(r); user != nil {
		s.sessionOwners[id] = user.ID
	}
	denied := s.blockedItem(item)
	s.sessionItemsMu.Unlock()
	if denied {
		_ = s.streams.Stop(id)
	}
	return !denied
}

// Playback identifiers are never access credentials. Every control and media
// request must belong to the signed-in user, including administrator requests.
func (s *Server) sessionOwned(w http.ResponseWriter, r *http.Request, id string) bool {
	if user := authenticatedUser(r); user != nil {
		s.sessionItemsMu.Lock()
		owner := s.sessionOwners[id]
		s.sessionItemsMu.Unlock()
		if owner != user.ID {
			streamError(w, stream.ErrNotFound)
			return false
		}
	}
	return true
}

func (s *Server) sessionAllowed(w http.ResponseWriter, r *http.Request, id string) bool {
	if !s.sessionOwned(w, r, id) {
		return false
	}
	s.sessionItemsMu.Lock()
	item, known := s.sessionItems[id]
	s.sessionItemsMu.Unlock()
	if known && s.blockedItem(item) || !known && s.preferencesSnapshot().blocked {
		if known && s.streams != nil {
			_ = s.streams.Stop(id)
		}
		blocked(w)
		return false
	}
	return true
}

func (s *Server) stopBlockedSessions() {
	if s.streams == nil {
		return
	}
	s.sessionItemsMu.Lock()
	ids := []string{}
	for id, item := range s.sessionItems {
		if s.blockedItem(item) {
			ids = append(ids, id)
		}
	}
	s.sessionItemsMu.Unlock()
	for _, id := range ids {
		_ = s.streams.Stop(id)
	}
}

func (s *Server) policyMedia(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/api/streams/"), "/")
		if s.sessionAllowed(w, r, id) {
			next.ServeHTTP(w, r)
		}
	})
}

func (s *Server) discoveryRefreshInterval() time.Duration {
	return s.refreshInterval()
}

func (s *Server) nextScheduledRefresh(last time.Time) time.Time {
	if last.IsZero() {
		return time.Now()
	}
	return last.Add(s.refreshInterval())
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// A restriction changes unfiltered discovery queries into a bounded, explicit
// allowed category query. If every known category is excluded, no provider or
// metadata request is made for that media kind.
func (s *Server) discoveryCategories(kind string) []string {
	p := s.preferencesSnapshot()
	if !p.environment.dashboardManaged() && !p.environment.blocksKind(kind) {
		return []string{"*"}
	}
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	eligible := []string{}
	for _, category := range s.cache.categories {
		if category.Kind != kind || category.ID == "" || category.ID == "*" {
			continue
		}
		policy := p.category(kind, category.ID, category.Name)
		if policy.Visibility != "show" || !policy.Dashboard {
			continue
		}
		eligible = append(eligible, category.ID)
	}
	sort.Strings(eligible)
	if len(eligible) <= 4 {
		return eligible
	}
	// Bound each refresh while rotating coverage across the full allowed set.
	// Once users curate categories, no language receives an implicit priority.
	interval := max(int64(60), p.value.RefreshIntervalSeconds)
	start := int((time.Now().Unix() / interval * 4) % int64(len(eligible)))
	return append(append([]string{}, eligible[start:]...), eligible[:start]...)[:4]
}
