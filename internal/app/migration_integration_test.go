package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func TestLegacyCacheAndJournalMigrateToSQLite(t *testing.T) {
	dir := t.TempDir()
	portal, mac := "http://provider.invalid", "aa:bb"
	old := diskCache{Version: 1, Provider: fingerprint(portal, mac), Items: pack([]model.Item{{ID: "live:1", Kind: "live", Name: "News", Command: "private-live"}}), Episodes: map[string][]diskItem{"series:2": pack([]model.Item{{ID: "episode:2:1", Kind: "episode", Name: "Pilot", EpisodeID: "1"}})}, Programs: []model.Program{{ChannelID: "live:1", Title: "Tonight"}}, CatalogUpdatedAt: time.Now(), EPGUpdatedAt: time.Now(), CatalogJournalEpoch: 4, CatalogProgress: map[string][]diskItem{"vod:done": pack([]model.Item{{ID: "movie:done", Kind: "movie", Name: "Done"}})}}
	b, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "catalog.json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	record := map[string]any{"provider": old.Provider, "epoch": 4, "phase": "vod:7", "nextPage": 1, "sourceType": "vod", "items": pack([]model.Item{{ID: "movie:3", Kind: "movie", Name: "Film", Command: "private-movie", Logo: "http://provider.invalid/poster"}})}
	line, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	oldRecord := map[string]any{"provider": old.Provider, "epoch": 3, "phase": "vod:7", "items": pack([]model.Item{{ID: "movie:old", Kind: "movie", Name: "Old"}})}
	wrongRecord := map[string]any{"provider": "different", "epoch": 4, "phase": "vod:7", "items": pack([]model.Item{{ID: "movie:wrong", Kind: "movie", Name: "Wrong"}})}
	doneRecord := map[string]any{"provider": old.Provider, "epoch": 4, "phase": "vod:done", "items": pack([]model.Item{{ID: "movie:ignored", Kind: "movie", Name: "Ignored"}})}
	journal := append(append([]byte{}, line...), '\n')
	for _, record := range []any{oldRecord, wrongRecord, doneRecord} {
		b, e := json.Marshal(record)
		if e != nil {
			t.Fatal(e)
		}
		journal = append(journal, b...)
		journal = append(journal, '\n')
	}
	journal = append(journal, []byte(`{"torn":`)...)
	if err = os.WriteFile(filepath.Join(dir, "catalog-pages.jsonl"), journal, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(dir, portal, mac)
	if err != nil {
		t.Fatal(err)
	}
	movie, ok := s.item("movie:3")
	if !ok || movie.Command != "private-movie" || movie.Logo == "" {
		t.Fatal("journal item lost")
	}
	for _, id := range []string{"movie:old", "movie:wrong", "movie:ignored"} {
		if _, ok := s.item(id); ok {
			t.Fatal("wrong journal record migrated", id)
		}
	}
	if _, ok = s.item("episode:2:1"); !ok {
		t.Fatal("episode lost")
	}
	if len(s.programs) != 1 {
		t.Fatal("guide lost")
	}
	if err = s.close(); err != nil {
		t.Fatal(err)
	}
	// Later opens use SQLite and do not depend on legacy files.
	if err = os.Remove(filepath.Join(dir, "catalog.json")); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(dir, "catalog-pages.jsonl")); err != nil {
		t.Fatal(err)
	}
	s, err = openStore(dir, portal, mac)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if _, ok = s.item("movie:3"); !ok {
		t.Fatal("SQLite did not retain migration")
	}
}
