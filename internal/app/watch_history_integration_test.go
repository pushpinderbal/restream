package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
