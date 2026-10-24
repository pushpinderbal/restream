package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func historyRequest(t *testing.T, handler http.Handler, user *AuthUser, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	var err error
	if raw, ok := body.(string); ok {
		data = []byte(raw)
	} else if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	if user != nil {
		req = req.WithContext(context.WithValue(req.Context(), authContextKey{}, user))
	}
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}
func historySnapshotFor(t *testing.T, handler http.Handler, user *AuthUser) historySnapshot {
	t.Helper()
	response := historyRequest(t, handler, user, "GET", "/api/watch-history", nil)
	if response.Code != 200 {
		t.Fatalf("history snapshot: %d %s", response.Code, response.Body)
	}
	var result historySnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func historyRecordBody(scope, kind, id, itemID string) map[string]any {
	title := historyItem{ID: id, Kind: kind, Name: "A title", Category: "Drama", Image: "/api/images/" + id}
	item := title
	if kind == "series" {
		item = historyItem{ID: itemID, Kind: "episode", Name: "An episode", Season: 1, Episode: 1}
	}
	return map[string]any{"scope": scope, "title": title, "item": item, "watchedAt": time.Now().UnixMilli(), "position": 12, "duration": 200, "completed": false}
}
func recordHistoryFor(t *testing.T, handler http.Handler, user *AuthUser, scope, kind, id, itemID string) watchHistoryEntry {
	t.Helper()
	response := historyRequest(t, handler, user, "POST", "/api/watch-history/record", historyRecordBody(scope, kind, id, itemID))
	if response.Code != 200 {
		t.Fatalf("record history: %d %s", response.Code, response.Body)
	}
	var result struct {
		Entry watchHistoryEntry `json:"entry"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Entry.PlaybackID == "" {
		t.Fatal("missing server playback identity")
	}
	return result.Entry
}
func historyProgress(t *testing.T, handler http.Handler, user *AuthUser, scope string, entry watchHistoryEntry, position float64) *watchHistoryEntry {
	t.Helper()
	response := historyRequest(t, handler, user, "PATCH", "/api/watch-history/progress", map[string]any{"scope": scope, "kind": entry.Title.Kind, "id": entry.Title.ID, "itemId": entry.Item.ID, "playbackId": entry.PlaybackID, "position": position, "duration": 200, "completed": false, "seq": 1})
	if response.Code != 200 {
		t.Fatalf("progress: %d %s", response.Code, response.Body)
	}
	var result struct {
		Entry *watchHistoryEntry `json:"entry"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.Entry
}
func deleteHistory(t *testing.T, handler http.Handler, user *AuthUser, scope, kind, id string) string {
	t.Helper()
	body := map[string]string{"scope": scope}
	if kind != "" {
		body["kind"] = kind
		body["id"] = id
	}
	response := historyRequest(t, handler, user, "DELETE", "/api/watch-history", body)
	if response.Code != 200 {
		t.Fatalf("delete: %d %s", response.Code, response.Body)
	}
	var result struct {
		UndoToken string `json:"undoToken"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result.UndoToken
}
func undoHistory(t *testing.T, handler http.Handler, user *AuthUser, scope, token string) historySnapshot {
	t.Helper()
	response := historyRequest(t, handler, user, "POST", "/api/watch-history/undo", map[string]string{"scope": scope, "undoToken": token})
	if response.Code != 200 {
		t.Fatalf("undo: %d %s", response.Code, response.Body)
	}
	var result historySnapshot
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWatchHistoryRefreshesDisplayArtworkFromCachedLibraryWithoutWrites(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := &fixtureProvider{}
	s.provider = p
	scope := historySnapshotFor(t, s, nil).Scope
	movies := []model.Item{}
	expected := map[string]watchHistoryEntry{}
	for _, scenario := range []struct {
		id, storedImage string
	}{
		{"missing", ""},
		{"expired-metadata", "/api/discovery/images/expired/poster"},
		{"old-library", "/api/images/movie:old-library"},
		{"versioned-library", "/api/images/movie:versioned-library?v=0123456789abcdef"},
		{"current-metadata", "/api/discovery/images/current/poster?v=0123456789abcdef"},
	} {
		id := "movie:" + scenario.id
		item := model.Item{ID: id, Kind: "movie", Name: "Current library name", Logo: "https://private.invalid/" + scenario.id + "?token=private", Command: "private-command"}
		movies = append(movies, item)
		body := historyRecordBody(scope, "movie", id, "")
		title := body["title"].(historyItem)
		title.Image = scenario.storedImage
		body["title"], body["item"] = title, title
		response := historyRequest(t, s, nil, "POST", "/api/watch-history/record", body)
		var recorded struct {
			Entry watchHistoryEntry `json:"entry"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &recorded) != nil {
			t.Fatalf("record artwork snapshot: %d %s", response.Code, response.Body)
		}
		entry := recorded.Entry
		entry.Title.Image = publicItems([]model.Item{item})[0].Image
		if scenario.id == "current-metadata" {
			entry.Title.Image = scenario.storedImage
		}
		entry.Item.Image = entry.Title.Image
		expected[id] = entry
	}
	if err := seedBrowsePage(s.cache, model.BrowseQuery{Kind: "movie", Category: "*", Page: 1}, model.BrowsePage{Items: movies, Page: 1}); err != nil {
		t.Fatal(err)
	}
	live := model.Item{ID: "live:channel", Kind: "live", Name: "Channel", Logo: "https://private.invalid/live.jpg"}
	if err := s.cache.setCatalog([]model.Item{live}); err != nil {
		t.Fatal(err)
	}
	liveEntry := recordHistoryFor(t, s, nil, scope, "live", live.ID, "")
	liveEntry.Title.Image = publicItems([]model.Item{live})[0].Image
	liveEntry.Item.Image = liveEntry.Title.Image
	expected[live.ID] = liveEntry
	series := model.Item{ID: "series:show", Kind: "series", Name: "Show", Logo: "https://private.invalid/show.jpg"}
	episode := model.Item{ID: "episode:show:1", Kind: "episode", Name: "Episode", Logo: "https://private.invalid/episode.jpg"}
	if err := seedBrowsePage(s.cache, model.BrowseQuery{Kind: "series", Category: "*", Page: 1}, model.BrowsePage{Items: []model.Item{series}, Page: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.cache.setEpisodesAtRevision(series.ID, []model.Item{episode}, s.cache.libraryRevision()); err != nil {
		t.Fatal(err)
	}
	seriesEntry := recordHistoryFor(t, s, nil, scope, "series", series.ID, episode.ID)
	seriesEntry.Title.Image = publicItems([]model.Item{series})[0].Image
	seriesEntry.Item.Image = publicItems([]model.Item{episode})[0].Image
	expected[series.ID] = seriesEntry
	s.discoveryService.mu.Lock()
	s.discoveryService.record.Assets = map[string]discoveryAsset{"current": {ItemID: "movie:current-metadata", Poster: "/poster.jpg"}}
	s.discoveryService.mu.Unlock()
	before, err := readWatchHistory(s.cache.db, scope, "")
	if err != nil {
		t.Fatal(err)
	}
	var changesBefore, changesAfter int64
	if err := s.cache.db.QueryRow(`SELECT total_changes()`).Scan(&changesBefore); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		got := historySnapshotFor(t, s, nil)
		if len(got.Entries) != len(expected) {
			t.Fatalf("history entries changed: %+v", got)
		}
		for _, entry := range got.Entries {
			if !reflect.DeepEqual(entry, expected[entry.Title.ID]) {
				t.Fatalf("display repair altered playback metadata: got=%+v want=%+v", entry, expected[entry.Title.ID])
			}
		}
		encoded, _ := json.Marshal(got)
		if strings.Contains(string(encoded), "private") {
			t.Fatal("history exposed provider artwork credentials")
		}
	}
	after, err := readWatchHistory(s.cache.db, scope, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.cache.db.QueryRow(`SELECT total_changes()`).Scan(&changesAfter); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) || changesAfter != changesBefore {
		t.Fatal("history display read wrote to storage")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.catalogs+p.epgs+p.episodeCalls+p.browseCalls+p.categoryCalls != 0 {
		t.Fatal("history display read requested provider metadata")
	}
}

func TestWatchHistoryRuntimePersistenceAndProviderIsolation(t *testing.T) {
	cfg := Config{DataDir: t.TempDir(), WebDir: t.TempDir()}
	rt, err := NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := historySnapshotFor(t, rt, nil)
	if snapshot.UserID != "" || snapshot.Scope == "" || len(snapshot.Entries) != 0 {
		t.Fatalf("initial shared profile: %+v", snapshot)
	}
	// History is useful with no configured provider, and has no old browser12/title cap.
	for i := 0; i < 15; i++ {
		recordHistoryFor(t, rt, nil, snapshot.Scope, "movie", fmt.Sprintf("movie:%d", i), "")
	}
	rt.Close()
	rt, err = NewRuntime(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := historySnapshotFor(t, rt, nil); len(got.Entries) != 15 || got.Scope != snapshot.Scope {
		t.Fatalf("restart lost durable history: %+v", got)
	}
	rt.Close()
	// Library/provider resets must leave other provider namespaces intact.
	cfg.PortalURL, cfg.MAC = "http://provider.invalid", "00:11:22:33:44:55"
	other, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	otherScope := historySnapshotFor(t, other, nil)
	if len(otherScope.Entries) != 0 || otherScope.Scope == snapshot.Scope {
		t.Fatal("provider namespaces mixed")
	}
	recordHistoryFor(t, other, nil, otherScope.Scope, "movie", "movie:other", "")
	stale := historyRequest(t, other, nil, "POST", "/api/watch-history/record", historyRecordBody(snapshot.Scope, "movie", "movie:stale", ""))
	if stale.Code != 409 {
		t.Fatalf("old provider scope accepted: %d", stale.Code)
	}
	other.Close()
	cfg.PortalURL, cfg.MAC = "", ""
	restored, err := New(cfg, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if got := historySnapshotFor(t, restored, nil); len(got.Entries) != 15 {
		t.Fatalf("provider reset deleted saved history: %d", len(got.Entries))
	}
}
func TestWatchHistoryProgressAndUndoRaces(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	scope := historySnapshotFor(t, s, nil).Scope
	first := recordHistoryFor(t, s, nil, scope, "series", "series:1", "episode:1")
	if got := historyProgress(t, s, nil, scope, first, 195); got == nil || !got.Completed || got.Position != 195 {
		t.Fatalf("completion missing: %+v", got)
	}
	// A final keepalive may arrive before an older request for this playback.
	newer := historyRequest(t, s, nil, "PATCH", "/api/watch-history/progress", map[string]any{"scope": scope, "kind": first.Title.Kind, "id": first.Title.ID, "itemId": first.Item.ID, "playbackId": first.PlaybackID, "position": 80, "duration": 200, "completed": false, "seq": 2})
	if newer.Code != 200 {
		t.Fatalf("newer progress: %d %s", newer.Code, newer.Body)
	}
	if got := historyProgress(t, s, nil, scope, first, 20); got == nil || got.Position != 80 {
		t.Fatalf("reordered progress regressed newer write: %+v", got)
	}
	for _, check := range []struct {
		seq      int
		position float64
		want     float64
	}{{2, 140, 80}, {3, 40, 40}} {
		response := historyRequest(t, s, nil, "PATCH", "/api/watch-history/progress", map[string]any{"scope": scope, "kind": first.Title.Kind, "id": first.Title.ID, "itemId": first.Item.ID, "playbackId": first.PlaybackID, "position": check.position, "duration": 200, "completed": false, "seq": check.seq})
		var got struct {
			Entry watchHistoryEntry `json:"entry"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &got) != nil || got.Entry.Position != check.want {
			t.Fatalf("sequence/seek update: %d %s", response.Code, response.Body)
		}
	}
	second := recordHistoryFor(t, s, nil, scope, "series", "series:1", "episode:2")
	if got := historyProgress(t, s, nil, scope, first, 20); got != nil {
		t.Fatal("old episode progress replaced new playback")
	}
	// A restart of even the same episode supersedes the former playback writer.
	third := recordHistoryFor(t, s, nil, scope, "series", "series:1", "episode:2")
	if got := historyProgress(t, s, nil, scope, second, 80); got != nil {
		t.Fatal("old same-episode playback was accepted")
	}
	removed := deleteHistory(t, s, nil, scope, "series", "series:1")
	if got := historyProgress(t, s, nil, scope, third, 60); got != nil {
		t.Fatal("progress resurrected removed history")
	}
	newest := recordHistoryFor(t, s, nil, scope, "series", "series:1", "episode:3")
	if got := undoHistory(t, s, nil, scope, removed); len(got.Entries) != 1 || got.Entries[0].PlaybackID != newest.PlaybackID {
		t.Fatal("undo overwrote newer playback")
	}
	recordHistoryFor(t, s, nil, scope, "movie", "movie:1", "")
	clear := deleteHistory(t, s, nil, scope, "", "")
	if got := historyProgress(t, s, nil, scope, newest, 60); got != nil {
		t.Fatal("progress resurrected cleared history")
	}
	recordHistoryFor(t, s, nil, scope, "series", "series:1", "episode:4")
	if got := undoHistory(t, s, nil, scope, clear); len(got.Entries) != 2 || !((got.Entries[0].Item.ID == "episode:4") || (got.Entries[1].Item.ID == "episode:4")) {
		t.Fatalf("clear undo failed to preserve new playback/restore other: %+v", got)
	}
	removed = deleteHistory(t, s, nil, scope, "movie", "movie:1")
	clear = deleteHistory(t, s, nil, scope, "", "")
	if got := undoHistory(t, s, nil, scope, removed); len(got.Entries) != 0 {
		t.Fatal("undo removal ignored later clear")
	}
	// A clear of already empty history also invalidates the previous clear's undo.
	deleteHistory(t, s, nil, scope, "", "")
	if got := undoHistory(t, s, nil, scope, clear); len(got.Entries) != 0 {
		t.Fatal("external empty clear did not invalidate undo")
	}
	expiredEntry := recordHistoryFor(t, s, nil, scope, "movie", "movie:expired", "")
	expired := deleteHistory(t, s, nil, scope, "movie", "movie:expired")
	if _, err = s.cache.db.Exec(`UPDATE watch_history_undo SET expires=0 WHERE token=?`, expired); err != nil {
		t.Fatal(err)
	}
	if got := undoHistory(t, s, nil, scope, expired); len(got.Entries) != 0 {
		t.Fatal("expired undo restored history")
	}
	if got := historyProgress(t, s, nil, scope, expiredEntry, 30); got != nil {
		t.Fatal("expired undo resurrected entry")
	}
}
func TestWatchHistoryUserIsolationAndViewerAccess(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir(), Auth: AuthConfig{Mode: "oidc"}}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	alice, bob := &AuthUser{ID: "alice", Role: "viewer"}, &AuthUser{ID: "bob", Role: "viewer"}
	a, b := historySnapshotFor(t, s, alice), historySnapshotFor(t, s, bob)
	if a.Scope == b.Scope || a.UserID != "alice" || b.UserID != "bob" {
		t.Fatal("identity missing or scopes mixed")
	}
	recordHistoryFor(t, s, alice, a.Scope, "movie", "movie:1", "")
	if len(historySnapshotFor(t, s, bob).Entries) != 0 {
		t.Fatal("history leaked to another user")
	}
	denied := historyRequest(t, s, bob, "DELETE", "/api/watch-history", map[string]string{"scope": a.Scope})
	if denied.Code != 409 {
		t.Fatalf("cross-user queued mutation accepted: %d", denied.Code)
	}
	if got := historyRequest(t, s, nil, "GET", "/api/watch-history", nil); got.Code != 401 {
		t.Fatalf("anonymous authenticated-mode access: %d", got.Code)
	}
	// Exercise real OIDC middleware: viewers can persist their own progress.
	provider := newAuthTestProvider(t)
	app := newAuthTestApp(t, provider, nil)
	app.login(t)
	response := app.get(t, "/api/watch-history")
	var snapshot historySnapshot
	if err = json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || snapshot.UserID == "" {
		t.Fatalf("viewer snapshot: %d %+v", response.StatusCode, snapshot)
	}
	data, _ := json.Marshal(historyRecordBody(snapshot.Scope, "movie", "movie:viewer", ""))
	response, err = app.client.Post(app.server.URL+"/api/watch-history/record", "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("viewer write denied: %d", response.StatusCode)
	}
}
func TestWatchHistoryRejectsInvalidPayloadsAndReportsStorageFailure(t *testing.T) {
	s, err := New(Config{DataDir: t.TempDir(), WebDir: t.TempDir()}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	scope := historySnapshotFor(t, s, nil).Scope
	valid := historyRecordBody(scope, "movie", "movie:1", "")
	encoded, _ := json.Marshal(valid)
	tests := []string{`null`, `[]`, `{} {}`, strings.Repeat("x", 17<<10), strings.Replace(string(encoded), `"position":12`, `"position":-1`, 1), strings.Replace(string(encoded), `"duration":200`, `"duration":1e999`, 1), strings.Replace(string(encoded), `"watchedAt":`, `"userId":"another-user","watchedAt":`, 1), strings.Replace(string(encoded), `"name":"A title"`, `"command":"secret","name":"A title"`, 1), strings.Replace(string(encoded), `"/api/images/movie:1"`, `"https://secret.invalid/stream"`, 1)}
	for _, body := range tests {
		got := historyRequest(t, s, nil, "POST", "/api/watch-history/record", body)
		if got.Code != 400 && got.Code != 409 {
			t.Errorf("invalid payload accepted: %d %s", got.Code, got.Body)
		}
		if strings.Contains(got.Body.String(), "secret") {
			t.Fatal("validation leaked submitted secrets")
		}
	}
	for _, image := range []string{"/api/images/movie:1?token=secret", "/api/images/movie:1?v=0123456789ABCDEF", "/api/images/movie:1?v=0123456789abcdef&extra=1", "/api/images/movie:1#fragment", "/api/images/movie:1\\secret", "/api/images/movie:1\r\nsecret", "/api/images/movie:1/path", "/api/discovery/images/id/arbitrary"} {
		body := historyRecordBody(scope, "movie", "movie:1", "")
		title := body["title"].(historyItem)
		title.Image = image
		body["title"] = title
		if got := historyRequest(t, s, nil, "POST", "/api/watch-history/record", body); got.Code != 400 {
			t.Fatalf("noncanonical artwork accepted: %q status=%d", image, got.Code)
		}
	}
	for _, timestamp := range []int64{0, -1, time.Now().Add(time.Hour).UnixMilli()} {
		body := historyRecordBody(scope, "movie", "movie:invalid-time", "")
		body["watchedAt"] = timestamp
		if got := historyRequest(t, s, nil, "POST", "/api/watch-history/record", body); got.Code != 400 {
			t.Fatalf("invalid timestamp accepted: %d", got.Code)
		}
	}
	for _, seq := range []any{0, -1, 1.5, 9007199254740992, "1"} {
		body := map[string]any{"scope": scope, "kind": "movie", "id": "movie:1", "itemId": "movie:1", "playbackId": "obsolete", "position": 10, "duration": 200, "completed": false, "seq": seq}
		if got := historyRequest(t, s, nil, "PATCH", "/api/watch-history/progress", body); got.Code != 400 {
			t.Fatalf("invalid progress sequence accepted: %v %d", seq, got.Code)
		}
	}
	// A movie cannot record an unrelated movie/episode as its played item.
	valid["item"] = historyItem{ID: "other", Kind: "episode", Name: "Other"}
	if got := historyRequest(t, s, nil, "POST", "/api/watch-history/record", valid); got.Code != 400 {
		t.Fatalf("invalid title-item relationship: %d", got.Code)
	}
	// Live progress has no resume/completion state.
	live := recordHistoryFor(t, s, nil, scope, "live", "live:1", "")
	if live.Position != 0 || live.Duration != 0 || live.Completed {
		t.Fatal("live history contains resume state")
	}
	if err = s.cache.db.Close(); err != nil {
		t.Fatal(err)
	}
	if got := historyRequest(t, s, nil, "GET", "/api/watch-history", nil); got.Code != 500 {
		t.Fatalf("storage read failure hidden: %d", got.Code)
	}
	if got := historyRequest(t, s, nil, "DELETE", "/api/watch-history", map[string]string{"scope": scope}); got.Code != 500 {
		t.Fatalf("storage write failure hidden: %d", got.Code)
	}
}
