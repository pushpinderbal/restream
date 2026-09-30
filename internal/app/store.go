package app

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
	_ "modernc.org/sqlite"
)

// diskItem keeps provider-only fields on the server while Item's JSON remains public.
type diskItem struct {
	Item       model.Item `json:"item"`
	Logo       string     `json:"logo,omitempty"`
	Command    string     `json:"command,omitempty"`
	ProviderID string     `json:"providerId,omitempty"`
	SeriesID   string     `json:"seriesId,omitempty"`
	EpisodeID  string     `json:"episodeId,omitempty"`
}
type diskCategory struct {
	model.Category
	SourceType string `json:"sourceType"`
}
type diskBrowsePage struct {
	Items   []diskItem `json:"items"`
	Page    int        `json:"page"`
	Total   int        `json:"total"`
	HasMore bool       `json:"hasMore"`
}

func encodePage(p model.BrowsePage) ([]byte, error) {
	return json.Marshal(diskBrowsePage{pack(p.Items), p.Page, p.Total, p.HasMore})
}
func decodePage(b []byte) (model.BrowsePage, error) {
	var d diskBrowsePage
	err := json.Unmarshal(b, &d)
	return model.BrowsePage{Items: unpack(d.Items), Page: d.Page, Total: d.Total, HasMore: d.HasMore}, err
}

type diskCache struct {
	Version             int                   `json:"version"`
	Provider            string                `json:"provider"`
	Items               []diskItem            `json:"items"`
	Episodes            map[string][]diskItem `json:"episodes"`
	Programs            []model.Program       `json:"programs"`
	CatalogUpdatedAt    time.Time             `json:"catalogUpdatedAt"`
	CatalogPublishedAt  time.Time             `json:"catalogPublishedAt,omitempty"`
	EPGUpdatedAt        time.Time             `json:"epgUpdatedAt"`
	PortalCooldownUntil time.Time             `json:"portalCooldownUntil,omitempty"`
	CatalogProgress     map[string][]diskItem `json:"catalogProgress,omitempty"`
	CatalogJournalEpoch uint64                `json:"catalogJournalEpoch,omitempty"`
}
type store struct {
	mu                                                 sync.RWMutex
	db                                                 *sql.DB
	fingerprint                                        string
	items                                              []model.Item // live only
	byID                                               map[string]model.Item
	episodes                                           map[string][]model.Item
	episodesAt                                         map[string]time.Time
	programs                                           []model.Program
	categories                                         []model.Category
	catalogAt, epgAt, categoriesAt, catalogPublishedAt time.Time
	libraryRefreshedAt                                 time.Time
	portalCooldownUntil                                time.Time
	catalogJSON, epgJSON                               []byte
	catalogETag, epgETag                               string
}

var errSeriesRemoved = errors.New("series no longer in catalog")

// Increment when category or browse query semantics change. Existing live,
// EPG, episode, and item records remain useful across these upgrades.
const browseCacheVersion = "3"

func fingerprint(portal, mac string) string {
	sum := sha256.Sum256([]byte(portal + "\x00" + mac))
	return hex.EncodeToString(sum[:])
}
func openStore(dir, portal, mac string) (*store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "restream.sqlite")
	file, createErr := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if createErr != nil {
		return nil, createErr
	}
	file.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	fail := func(err error) (*store, error) { db.Close(); return nil, err }
	if _, err = db.Exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data BLOB NOT NULL);
 CREATE INDEX IF NOT EXISTS items_kind ON items(kind);
 CREATE TABLE IF NOT EXISTS pages(kind TEXT NOT NULL,category TEXT NOT NULL,search TEXT NOT NULL,page INTEGER NOT NULL,data BLOB NOT NULL,fetched_at INTEGER NOT NULL,PRIMARY KEY(kind,category,search,page));
 CREATE INDEX IF NOT EXISTS pages_fetched_at ON pages(fetched_at);
 CREATE TABLE IF NOT EXISTS categories(kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS episodes(series_id TEXT PRIMARY KEY,data BLOB NOT NULL,fetched_at INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS epg(id INTEGER PRIMARY KEY CHECK(id=1),data BLOB NOT NULL);`); err != nil {
		return fail(err)
	}
	if err = os.Chmod(path, 0600); err != nil {
		return fail(err)
	}
	s := &store{db: db, fingerprint: fingerprint(portal, mac), byID: map[string]model.Item{}, episodes: map[string][]model.Item{}, episodesAt: map[string]time.Time{}}
	var stored string
	err = db.QueryRow(`SELECT value FROM meta WHERE key='provider'`).Scan(&stored)
	if err == sql.ErrNoRows {
		if err = s.initializeProvider(dir); err != nil {
			return fail(err)
		}
	} else if err != nil {
		return fail(err)
	} else if stored != s.fingerprint {
		if err = s.clearForProvider(); err != nil {
			return fail(err)
		}
	}
	if err = s.upgradeBrowseCache(); err != nil {
		return fail(err)
	}
	if err = s.load(); err != nil {
		return fail(err)
	}
	return s, nil
}
func (s *store) upgradeBrowseCache() error {
	var version string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key='browse_cache_version'`).Scan(&version)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if version == browseCacheVersion {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM pages`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM categories`); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM meta WHERE key='categories_at'`); err != nil {
		return err
	}
	if err = putMeta(tx, "browse_cache_version", browseCacheVersion); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *store) initializeProvider(dir string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO meta(key,value) VALUES('provider',?)`, s.fingerprint); err != nil {
		return err
	}
	// One-time migration from the previous JSON cache. Partial page journals are
	// intentionally not resumed; their saved items are imported below.
	data, readErr := os.ReadFile(filepath.Join(dir, "catalog.json"))
	if readErr == nil {
		var old diskCache
		if err = json.Unmarshal(data, &old); err != nil {
			return fmt.Errorf("legacy cache invalid: %w", err)
		}
		if old.Version == 1 && old.Provider == s.fingerprint {
			for _, v := range old.Items {
				if err = insertItem(tx, unpackOne(v)); err != nil {
					return err
				}
			}
			for _, phase := range old.CatalogProgress {
				for _, v := range phase {
					if err = insertItem(tx, unpackOne(v)); err != nil {
						return err
					}
				}
			}
			for id, values := range old.Episodes {
				b, _ := json.Marshal(values)
				if _, err = tx.Exec(`INSERT OR REPLACE INTO episodes(series_id,data,fetched_at) VALUES(?,?,0)`, id, b); err != nil {
					return err
				}
			}
			b, _ := json.Marshal(old.Programs)
			if _, err = tx.Exec(`INSERT OR REPLACE INTO epg(id,data) VALUES(1,?)`, b); err != nil {
				return err
			}
			if err = migrateJournal(tx, filepath.Join(dir, "catalog-pages.jsonl"), s.fingerprint, old.CatalogJournalEpoch, old.CatalogProgress); err != nil {
				return err
			}
			for key, at := range map[string]time.Time{"live_at": old.CatalogUpdatedAt, "epg_at": old.EPGUpdatedAt, "cooldown": old.PortalCooldownUntil} {
				if !at.IsZero() {
					if err = putMeta(tx, key, at.Format(time.RFC3339Nano)); err != nil {
						return err
					}
				}
			}
		}
	} else if !os.IsNotExist(readErr) {
		return readErr
	} else {
		if err = migrateJournal(tx, filepath.Join(dir, "catalog-pages.jsonl"), s.fingerprint, 0, nil); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Valid complete journal records are imported once. A torn last line is ignored.
func migrateJournal(tx *sql.Tx, path, provider string, epoch uint64, completed map[string][]diskItem) error {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	for {
		line, readErr := reader.ReadBytes('\n')
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
		line = bytes.TrimSpace(line)
		var record struct {
			Provider string     `json:"provider"`
			Epoch    uint64     `json:"epoch"`
			Phase    string     `json:"phase"`
			Items    []diskItem `json:"items"`
		}
		if err = json.Unmarshal(line, &record); err != nil {
			return fmt.Errorf("legacy page journal invalid: %w", err)
		}
		if record.Provider != provider || record.Epoch != epoch {
			continue
		}
		if _, done := completed[record.Phase]; done {
			continue
		}
		for _, v := range record.Items {
			if err = insertItem(tx, unpackOne(v)); err != nil {
				return err
			}
		}
	}
}
func (s *store) clearForProvider() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range []string{"items", "pages", "categories", "episodes", "epg", "meta"} {
		if _, err = tx.Exec("DELETE FROM " + table); err != nil {
			return err
		}
	}
	if err = putMeta(tx, "provider", s.fingerprint); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *store) load() error {
	rows, err := s.db.Query(`SELECT data FROM items`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var b []byte
		var d diskItem
		if err = rows.Scan(&b); err != nil {
			break
		}
		if err = json.Unmarshal(b, &d); err != nil {
			break
		}
		i := unpackOne(d)
		s.byID[i.ID] = i
		if i.Kind == "live" {
			s.items = append(s.items, i)
		}
	}
	if err == nil {
		err = rows.Err()
	}
	if closeErr := rows.Close(); err != nil {
		return err
	} else if closeErr != nil {
		return closeErr
	}
	rows, err = s.db.Query(`SELECT series_id,data,fetched_at FROM episodes`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var b []byte
		var ds []diskItem
		var fetchedAt int64
		if err = rows.Scan(&id, &b, &fetchedAt); err != nil {
			break
		}
		if err = json.Unmarshal(b, &ds); err != nil {
			break
		}
		s.episodes[id] = unpack(ds)
		s.episodesAt[id] = time.Unix(0, fetchedAt)
		for _, i := range s.episodes[id] {
			s.byID[i.ID] = i
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	rows, err = s.db.Query(`SELECT data FROM categories ORDER BY kind,id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var b []byte
		var c diskCategory
		if err = rows.Scan(&b); err != nil {
			break
		}
		if err = json.Unmarshal(b, &c); err != nil {
			break
		}
		c.Category.SourceType = c.SourceType
		s.categories = append(s.categories, c.Category)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	var b []byte
	err = s.db.QueryRow(`SELECT data FROM epg WHERE id=1`).Scan(&b)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		if err = json.Unmarshal(b, &s.programs); err != nil {
			return err
		}
	}
	for key, dest := range map[string]*time.Time{"live_at": &s.catalogAt, "epg_at": &s.epgAt, "categories_at": &s.categoriesAt, "library_refreshed_at": &s.libraryRefreshedAt, "cooldown": &s.portalCooldownUntil} {
		var v string
		err = s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, key).Scan(&v)
		if err == nil {
			*dest, _ = time.Parse(time.RFC3339Nano, v)
		} else if err != sql.ErrNoRows {
			return err
		}
	}
	s.catalogPublishedAt = s.catalogAt
	if s.categoriesAt.After(s.catalogPublishedAt) {
		s.catalogPublishedAt = s.categoriesAt
	}
	return s.refreshSnapshots()
}
func putMeta(tx *sql.Tx, key, value string) error {
	_, err := tx.Exec(`INSERT INTO meta(key,value)VALUES(?,?) ON CONFLICT(key)DO UPDATE SET value=excluded.value`, key, value)
	return err
}
func packOne(i model.Item) diskItem {
	return diskItem{i, i.Logo, i.Command, i.ProviderID, i.SeriesID, i.EpisodeID}
}
func unpackOne(d diskItem) model.Item {
	i := d.Item
	i.Logo = d.Logo
	i.Command = d.Command
	i.ProviderID = d.ProviderID
	i.SeriesID = d.SeriesID
	i.EpisodeID = d.EpisodeID
	return i
}
func pack(items []model.Item) []diskItem {
	out := make([]diskItem, 0, len(items))
	for _, i := range items {
		out = append(out, packOne(i))
	}
	return out
}
func unpack(items []diskItem) []model.Item {
	out := make([]model.Item, 0, len(items))
	for _, d := range items {
		out = append(out, unpackOne(d))
	}
	return out
}
func insertItem(tx *sql.Tx, i model.Item) error {
	b, err := json.Marshal(packOne(i))
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO items(id,kind,data)VALUES(?,?,?) ON CONFLICT(id)DO UPDATE SET kind=excluded.kind,data=excluded.data`, i.ID, i.Kind, b)
	return err
}
func snapshot(v any) ([]byte, string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(b)
	return b, `"` + hex.EncodeToString(sum[:]) + `"`, nil
}
func catalogSnapshot(items []model.Item) ([]byte, string, error) {
	return snapshot(struct {
		Items []model.Item `json:"items"`
	}{publicItems(items)})
}
func epgSnapshot(p []model.Program) ([]byte, string, error) {
	if p == nil {
		p = []model.Program{}
	}
	return snapshot(struct {
		Programs []model.Program `json:"programs"`
	}{p})
}
func (s *store) refreshSnapshots() error {
	var err error
	s.catalogJSON, s.catalogETag, err = catalogSnapshot(s.items)
	if err != nil {
		return err
	}
	s.epgJSON, s.epgETag, err = epgSnapshot(s.programs)
	return err
}
func (s *store) setCatalog(items []model.Item) error {
	live := make([]model.Item, 0, len(items))
	for _, i := range items {
		if i.Kind == "live" {
			live = append(live, i)
		}
	}
	data, tag, err := catalogSnapshot(live)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM items WHERE kind='live'`); err != nil {
		return err
	}
	for _, i := range live {
		if err = insertItem(tx, i); err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	if err = putMeta(tx, "live_at", now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for id, i := range s.byID {
		if i.Kind == "live" {
			delete(s.byID, id)
		}
	}
	for _, i := range live {
		s.byID[i.ID] = i
	}
	s.items = live
	s.catalogAt = now
	s.catalogPublishedAt = now
	s.catalogJSON, s.catalogETag = data, tag
	return nil
}
func (s *store) setEPG(p []model.Program) error {
	data, tag, err := epgSnapshot(p)
	if err != nil {
		return err
	}
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT OR REPLACE INTO epg(id,data)VALUES(1,?)`, b); err != nil {
		return err
	}
	now := time.Now().UTC()
	if err = putMeta(tx, "epg_at", now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.programs = p
	s.epgAt = now
	s.epgJSON, s.epgETag = data, tag
	return nil
}
func (s *store) setCategories(c []model.Category) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	sourceChanged := len(s.categories) == 0
	oldSources := map[string]string{}
	for _, v := range s.categories {
		if v.Kind == "series" {
			oldSources[v.ID] = v.SourceType
		}
	}
	for _, v := range c {
		if v.Kind == "series" && oldSources[v.ID] != "" && oldSources[v.ID] != v.SourceType {
			sourceChanged = true
			break
		}
	}
	if sourceChanged {
		if _, err = tx.Exec(`DELETE FROM pages WHERE kind='series'`); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`DELETE FROM categories`); err != nil {
		return err
	}
	for _, v := range c {
		b, e := json.Marshal(diskCategory{v, v.SourceType})
		if e != nil {
			return e
		}
		if _, err = tx.Exec(`INSERT INTO categories(kind,id,data)VALUES(?,?,?)`, v.Kind, v.ID, b); err != nil {
			return err
		}
	}
	now := time.Now().UTC()
	if err = putMeta(tx, "categories_at", now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.categories = c
	s.categoriesAt = now
	s.catalogPublishedAt = now
	return nil
}

// Keep item records for active playback, but expire all lists atomically.
// The revision also prevents older in-flight requests from repopulating them.
func (s *store) invalidateLibrary() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`DELETE FROM pages`); err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE episodes SET fetched_at=0`); err != nil {
		return err
	}
	now := time.Now().UTC()
	if err = putMeta(tx, "library_refreshed_at", now.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for id := range s.episodesAt {
		s.episodesAt[id] = time.Time{}
	}
	s.libraryRefreshedAt = now
	return nil
}

func (s *store) libraryRevision() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.libraryRefreshedAt
}

// Caller holds mu. A response fetched before refresh still needs playback
// records for its titles, but must not replace records from newer responses.
func (s *store) retainMissingItems(items []model.Item) error {
	missing := make([]model.Item, 0)
	for _, item := range items {
		if _, exists := s.byID[item.ID]; !exists {
			missing = append(missing, item)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range missing {
		if err = insertItem(tx, item); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for _, item := range missing {
		s.byID[item.ID] = item
	}
	return nil
}

func (s *store) browse(q model.BrowseQuery, ttl time.Duration) (model.BrowsePage, bool, error) {
	var b []byte
	var at int64
	err := s.db.QueryRow(`SELECT data,fetched_at FROM pages WHERE kind=? AND category=? AND search=? AND page=?`, q.Kind, q.Category, q.Search, q.Page).Scan(&b, &at)
	if err == sql.ErrNoRows {
		return model.BrowsePage{}, false, nil
	}
	if err != nil {
		return model.BrowsePage{}, false, err
	}
	if ttl > 0 && time.Since(time.Unix(0, at)) > ttl {
		return model.BrowsePage{}, false, nil
	}
	page, err := decodePage(b)
	if err != nil {
		return page, false, err
	}
	return page, true, nil
}
func (s *store) setBrowse(q model.BrowseQuery, p model.BrowsePage, ttl time.Duration) error {
	return s.setBrowseAtRevision(q, p, ttl, s.libraryRevision())
}

func (s *store) setBrowseAtRevision(q model.BrowseQuery, p model.BrowsePage, ttl time.Duration, revision time.Time) error {
	b, err := encodePage(p)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.libraryRefreshedAt.Equal(revision) {
		return s.retainMissingItems(p.Items)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	if _, err = tx.Exec(`DELETE FROM pages WHERE fetched_at<?`, time.Now().Add(-ttl).UnixNano()); err != nil {
		return err
	}
	for _, i := range p.Items {
		if err = insertItem(tx, i); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO pages(kind,category,search,page,data,fetched_at)VALUES(?,?,?,?,?,?) ON CONFLICT(kind,category,search,page)DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at`, q.Kind, q.Category, q.Search, q.Page, b, time.Now().UnixNano()); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for _, i := range p.Items {
		s.byID[i.ID] = i
	}
	return nil
}
func (s *store) setRetryDeadline(_ bool, at time.Time, shared bool) error {
	if !shared {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !at.After(s.portalCooldownUntil) {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = putMeta(tx, "cooldown", at.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.portalCooldownUntil = at
	return nil
}
func (s *store) setEpisodes(id string, items []model.Item) error {
	return s.setEpisodesAtRevision(id, items, s.libraryRevision())
}

func (s *store) setEpisodesAtRevision(id string, items []model.Item, revision time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.libraryRefreshedAt.Equal(revision) {
		return s.retainMissingItems(items)
	}
	series, ok := s.byID[id]
	if !ok || series.Kind != "series" {
		return errSeriesRemoved
	}
	b, err := json.Marshal(pack(items))
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT OR REPLACE INTO episodes(series_id,data,fetched_at)VALUES(?,?,?)`, id, b, time.Now().UnixNano()); err != nil {
		return err
	}
	for _, i := range items {
		if err = insertItem(tx, i); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.episodes[id] = items
	s.episodesAt[id] = time.Now()
	for _, i := range items {
		s.byID[i.ID] = i
	}
	return nil
}
func (s *store) getEpisodes(id string, ttl time.Duration) ([]model.Item, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items, ok := s.episodes[id]
	if !ok || ttl > 0 && time.Since(s.episodesAt[id]) > ttl {
		return nil, false
	}
	return append([]model.Item(nil), items...), true
}
func (s *store) cachedSeries() []model.Item {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]model.Item, 0, len(s.episodes))
	for id := range s.episodes {
		if i, ok := s.byID[id]; ok && i.Kind == "series" {
			out = append(out, i)
		}
	}
	return out
}
func (s *store) item(id string) (model.Item, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	i, ok := s.byID[id]
	return i, ok
}
func (s *store) close() error { return s.db.Close() }
