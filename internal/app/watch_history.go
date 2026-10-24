package app

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

const historyUndoLifetime = 5 * time.Minute

var historyImagePathRE = regexp.MustCompile(`^/api/(?:images/[^/?#\\\s]+|discovery/images/[^/?#\\\s]+/(?:poster|backdrop))(?:\?v=[0-9a-f]{16})?$`)

// History deliberately stores a display-only whitelist, never provider commands,
// stream URLs, credentials, or sessions.
type historyItem struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Category   string `json:"category"`
	CategoryID string `json:"categoryId,omitempty"`
	Image      string `json:"image,omitempty"`
	Season     int    `json:"season,omitempty"`
	Episode    int    `json:"episode,omitempty"`
}
type watchHistoryEntry struct {
	Title      historyItem `json:"title"`
	Item       historyItem `json:"item"`
	WatchedAt  int64       `json:"watchedAt"`
	Position   float64     `json:"position"`
	Duration   float64     `json:"duration"`
	Completed  bool        `json:"completed"`
	UpdatedAt  int64       `json:"updatedAt"`
	PlaybackID string      `json:"playbackId"`
}
type historySnapshot struct {
	Entries []watchHistoryEntry `json:"entries"`
	Scope   string              `json:"scope"`
	UserID  string              `json:"userId"`
}

func initWatchHistory(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS watch_history_scopes(scope TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS watch_history(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,data BLOB NOT NULL,playback_id TEXT NOT NULL,deleted_token TEXT NOT NULL DEFAULT '',deleted_at INTEGER NOT NULL DEFAULT 0,last_sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,kind,id));
 CREATE TABLE IF NOT EXISTS watch_history_undo(token TEXT PRIMARY KEY,scope TEXT NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL);`)
	return err
}

func historyUserID(r *http.Request) string {
	if user := authenticatedUser(r); user != nil {
		return user.ID
	}
	return ""
}

func (s *Server) historyScope(r *http.Request) string {
	profile := "shared-default"
	if user := authenticatedUser(r); user != nil {
		profile = "user:" + user.ID
	} else if s.cfg.Auth.Mode != "" && s.cfg.Auth.Mode != "none" {
		return ""
	}
	sum := sha256.Sum256([]byte(profile + "\x00" + s.cache.fingerprint))
	return hex.EncodeToString(sum[:])
}
func validHistoryKind(kind string) bool { return kind == "live" || kind == "movie" || kind == "series" }
func validHistoryID(id string) bool {
	return strings.TrimSpace(id) != "" && len(id) <= 1024 && !strings.ContainsRune(id, '\x00')
}
func (i historyItem) valid() bool {
	imageValid := i.Image == "" || historyImagePathRE.MatchString(i.Image)
	return validHistoryID(i.ID) && (validHistoryKind(i.Kind) || i.Kind == "episode") && strings.TrimSpace(i.Name) != "" && len(i.Name) <= 4096 && len(i.Category) <= 4096 && len(i.CategoryID) <= 1024 && len(i.Image) <= 4096 && i.Season >= 0 && i.Episode >= 0 && imageValid
}
func validHistoryNumber(n float64) bool {
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 1e9
}
func (e *watchHistoryEntry) normalize(now int64) bool {
	if !e.Title.valid() || !e.Item.valid() || !validHistoryKind(e.Title.Kind) || e.WatchedAt <= 0 || e.WatchedAt > now+int64((5*time.Minute)/time.Millisecond) || e.UpdatedAt < 0 || e.UpdatedAt > now+int64((5*time.Minute)/time.Millisecond) || !validHistoryNumber(e.Position) || !validHistoryNumber(e.Duration) {
		return false
	}
	if e.Title.Kind == "series" {
		if e.Item.Kind != "episode" {
			return false
		}
	} else if e.Item.Kind != e.Title.Kind || e.Item.ID != e.Title.ID {
		return false
	}
	e.WatchedAt, e.UpdatedAt = now, now
	e.normalizeProgress()
	return true
}
func (e *watchHistoryEntry) normalizeProgress() {
	if e.Title.Kind == "live" {
		e.Position, e.Duration, e.Completed = 0, 0, false
		return
	}
	if e.Duration > 0 {
		e.Position = math.Min(e.Position, e.Duration)
	}
	e.Completed = e.Completed || e.Duration >= 60 && e.Position >= e.Duration*.95 && e.Duration-e.Position <= 120
}

type historyQuerier interface {
	Query(string, ...any) (*sql.Rows, error)
}

func readWatchHistory(q historyQuerier, scope, userID string) (historySnapshot, error) {
	result := historySnapshot{Entries: []watchHistoryEntry{}, Scope: scope, UserID: userID}
	rows, err := q.Query(`SELECT data FROM watch_history WHERE scope=? AND deleted_token='' ORDER BY json_extract(data,'$.watchedAt') DESC,kind,id`, scope)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var data []byte
		var entry watchHistoryEntry
		if err = rows.Scan(&data); err != nil {
			return result, err
		}
		if err = json.Unmarshal(data, &entry); err != nil {
			return result, err
		}
		result.Entries = append(result.Entries, entry)
	}
	return result, rows.Err()
}

func (s *Server) historyDisplayImage(display *historyItem) {
	item, known := s.cache.item(display.ID)
	if !known || item.Kind != display.Kind {
		return
	}
	if strings.HasPrefix(display.Image, "/api/discovery/images/") {
		path, _, _ := strings.Cut(display.Image, "?")
		id, imageType, ok := strings.Cut(strings.TrimPrefix(path, "/api/discovery/images/"), "/")
		s.discoveryService.mu.Lock()
		asset, exists := s.discoveryService.record.Assets[id]
		s.discoveryService.mu.Unlock()
		if ok && exists && asset.ItemID == item.ID && (imageType == "poster" && asset.Poster != "" || imageType == "backdrop" && asset.Backdrop != "") {
			return
		}
	}
	// History is a snapshot of playback, but its display image can follow the
	// current cached library without fetching or rewriting the saved entry.
	display.Image = publicItems([]model.Item{item})[0].Image
}

func (s *Server) watchHistory(w http.ResponseWriter, r *http.Request) {
	scope := s.historyScope(r)
	if scope == "" {
		fail(w, 401, "unauthorized", "Sign in to access watch history.")
		return
	}
	if r.Method == http.MethodGet {
		result, err := readWatchHistory(s.cache.db, scope, historyUserID(r))
		if err != nil {
			fail(w, 500, "history_storage", "Unable to load watch history.")
			return
		}
		for i := range result.Entries {
			s.historyDisplayImage(&result.Entries[i].Title)
			s.historyDisplayImage(&result.Entries[i].Item)
		}
		respond(w, 200, result)
		return
	}
	if r.Method != http.MethodDelete {
		w.Header().Set("Allow", "GET, DELETE")
		fail(w, 405, "method", "Method not allowed.")
		return
	}
	var body struct {
		Scope string `json:"scope"`
		Kind  string `json:"kind"`
		ID    string `json:"id"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Scope != scope {
		fail(w, 409, "history_scope", "Watch history changed. Reload and try again.")
		return
	}
	if (body.Kind != "" || body.ID != "") && (!validHistoryKind(body.Kind) || !validHistoryID(body.ID)) {
		fail(w, 400, "invalid", "Invalid history entry.")
		return
	}
	s.mutateHistory(w, scope, func(tx *sql.Tx) (any, error) {
		token := rand.Text()
		if _, err := tx.Exec(`INSERT INTO watch_history_scopes(scope) VALUES(?) ON CONFLICT DO NOTHING`, scope); err != nil {
			return nil, err
		}
		if body.Kind == "" {
			if _, err := tx.Exec(`UPDATE watch_history_scopes SET generation=generation+1 WHERE scope=?`, scope); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(`UPDATE watch_history SET deleted_token=?,deleted_at=? WHERE scope=? AND deleted_token=''`, token, time.Now().UnixMilli(), scope); err != nil {
				return nil, err
			}
		} else {
			if _, err := tx.Exec(`UPDATE watch_history SET deleted_token=?,deleted_at=? WHERE scope=? AND kind=? AND id=? AND deleted_token=''`, token, time.Now().UnixMilli(), scope, body.Kind, body.ID); err != nil {
				return nil, err
			}
		}
		_, err := tx.Exec(`INSERT INTO watch_history_undo(token,scope,generation,expires) SELECT ?,scope,generation,? FROM watch_history_scopes WHERE scope=?`, token, time.Now().Add(historyUndoLifetime).UnixMilli(), scope)
		return map[string]string{"undoToken": token, "scope": scope}, err
	})
}
func (s *Server) recordWatchHistory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope string `json:"scope"`
		watchHistoryEntry
	}
	if !decode(w, r, &body) {
		return
	}
	scope := s.historyMutationScope(w, r, body.Scope)
	if scope == "" {
		return
	}
	if !body.normalize(time.Now().UnixMilli()) {
		fail(w, 400, "invalid", "Invalid history entry.")
		return
	}
	body.PlaybackID = rand.Text()
	s.mutateHistory(w, scope, func(tx *sql.Tx) (any, error) {
		data, err := json.Marshal(body.watchHistoryEntry)
		if err == nil {
			_, err = tx.Exec(`INSERT INTO watch_history(scope,kind,id,data,playback_id) VALUES(?,?,?,?,?) ON CONFLICT(scope,kind,id) DO UPDATE SET data=excluded.data,playback_id=excluded.playback_id,deleted_token='',deleted_at=0,last_sequence=0`, scope, body.Title.Kind, body.Title.ID, data, body.PlaybackID)
		}
		return map[string]any{"entry": body.watchHistoryEntry, "scope": scope}, err
	})
}
func (s *Server) progressWatchHistory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope      string  `json:"scope"`
		Kind       string  `json:"kind"`
		ID         string  `json:"id"`
		ItemID     string  `json:"itemId"`
		PlaybackID string  `json:"playbackId"`
		Seq        int64   `json:"seq"`
		Position   float64 `json:"position"`
		Duration   float64 `json:"duration"`
		Completed  bool    `json:"completed"`
	}
	if !decode(w, r, &body) {
		return
	}
	scope := s.historyMutationScope(w, r, body.Scope)
	if scope == "" {
		return
	}
	if body.Seq <= 0 || body.Seq > 9007199254740991 || !validHistoryKind(body.Kind) || !validHistoryID(body.ID) || !validHistoryID(body.ItemID) || body.PlaybackID == "" || len(body.PlaybackID) > 256 || !validHistoryNumber(body.Position) || !validHistoryNumber(body.Duration) {
		fail(w, 400, "invalid", "Invalid playback progress.")
		return
	}
	s.mutateHistory(w, scope, func(tx *sql.Tx) (any, error) {
		var data []byte
		var entry watchHistoryEntry
		var result *watchHistoryEntry
		var lastSequence int64
		err := tx.QueryRow(`SELECT data,last_sequence FROM watch_history WHERE scope=? AND kind=? AND id=? AND playback_id=? AND deleted_token=''`, scope, body.Kind, body.ID, body.PlaybackID).Scan(&data, &lastSequence)
		if errors.Is(err, sql.ErrNoRows) {
			return map[string]any{"entry": result, "scope": scope}, nil
		}
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &entry); err != nil {
			return nil, err
		}
		if entry.Item.ID != body.ItemID {
			return map[string]any{"entry": result, "scope": scope}, nil
		}
		if body.Seq <= lastSequence {
			return map[string]any{"entry": entry, "scope": scope}, nil
		}
		entry.Position, entry.Duration, entry.Completed = body.Position, body.Duration, body.Completed
		entry.UpdatedAt = time.Now().UnixMilli()
		entry.normalizeProgress()
		data, err = json.Marshal(entry)
		if err == nil {
			_, err = tx.Exec(`UPDATE watch_history SET data=?,last_sequence=? WHERE scope=? AND kind=? AND id=?`, data, body.Seq, scope, body.Kind, body.ID)
		}
		return map[string]any{"entry": entry, "scope": scope}, err
	})
}
func (s *Server) undoWatchHistory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope     string `json:"scope"`
		UndoToken string `json:"undoToken"`
	}
	if !decode(w, r, &body) {
		return
	}
	scope := s.historyMutationScope(w, r, body.Scope)
	if scope == "" {
		return
	}
	if body.UndoToken == "" || len(body.UndoToken) > 256 {
		fail(w, 400, "invalid", "Invalid undo request.")
		return
	}
	s.mutateHistory(w, scope, func(tx *sql.Tx) (any, error) {
		_, err := tx.Exec(`UPDATE watch_history SET deleted_token='',deleted_at=0 WHERE scope=? AND deleted_token=? AND EXISTS(SELECT 1 FROM watch_history_undo u JOIN watch_history_scopes s ON s.scope=u.scope AND s.generation=u.generation WHERE u.token=? AND u.scope=? AND u.expires>?)`, scope, body.UndoToken, body.UndoToken, scope, time.Now().UnixMilli())
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(`DELETE FROM watch_history_undo WHERE scope=? AND token=?`, scope, body.UndoToken); err != nil {
			return nil, err
		}
		return readWatchHistory(tx, scope, historyUserID(r))
	})
}
func (s *Server) historyMutationScope(w http.ResponseWriter, r *http.Request, supplied string) string {
	scope := s.historyScope(r)
	if scope == "" {
		fail(w, 401, "unauthorized", "Sign in to access watch history.")
		return ""
	}
	if supplied != scope {
		fail(w, 409, "history_scope", "Watch history changed. Reload and try again.")
		return ""
	}
	return scope
}
func (s *Server) mutateHistory(w http.ResponseWriter, scope string, change func(*sql.Tx) (any, error)) {
	tx, err := s.cache.db.Begin()
	if err == nil {
		defer tx.Rollback()
		cutoff := time.Now().Add(-historyUndoLifetime).UnixMilli()
		_, err = tx.Exec(`DELETE FROM watch_history WHERE scope=? AND deleted_token<>'' AND deleted_at<=?`, scope, cutoff)
		if err == nil {
			_, err = tx.Exec(`DELETE FROM watch_history_undo WHERE expires<=?`, time.Now().UnixMilli())
		}
	}
	var result any
	if err == nil {
		result, err = change(tx)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(w, 500, "history_storage", "Unable to save watch history.")
		return
	}
	respond(w, 200, result)
}
