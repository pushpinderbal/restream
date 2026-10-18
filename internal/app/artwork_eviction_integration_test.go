package app

import (
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestArtworkEvictionReplacementAndAccessOrder(t *testing.T) {
	c, s := testArtworkCache(t)
	c.maxBytes = 24
	for i, key := range []string{"a", "b", "c", "d"} {
		if _, err := s.db.Exec(`INSERT INTO artwork_cache(url,data,mime,etag,modified,validated_at,retry_at,accessed_at) VALUES(?,zeroblob(6),'image/png','','',0,0,?)`, key, i); err != nil {
			t.Fatal(err)
		}
	}
	// Reading an old image makes it more recent than the seeded entries.
	if _, err := c.read("a"); err != nil {
		t.Fatal(err)
	}
	save := func(size int) {
		t.Helper()
		if err := c.save("b", artworkEntry{image: imageData{data: make([]byte, size), mime: "image/png"}, validated: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	assertRetained := func(wantBytes int) {
		t.Helper()
		rows, err := s.db.Query(`SELECT url FROM artwork_cache ORDER BY url`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var keys []string
		for rows.Next() {
			var key string
			if err := rows.Scan(&key); err != nil {
				t.Fatal(err)
			}
			keys = append(keys, key)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(keys, []string{"a", "b"}) {
			t.Fatalf("recently read/replaced artwork lost: %v", keys)
		}
		var bytes int
		if err := s.db.QueryRow(`SELECT SUM(length(data)) FROM artwork_cache`).Scan(&bytes); err != nil || bytes != wantBytes {
			t.Fatalf("wrong retained payload size: %d, want %d; err=%v", bytes, wantBytes, err)
		}
	}
	// Growing a replacement must evict multiple older entries, up to the exact
	// byte boundary. Shrinking it must retain the other remaining entry.
	save(18)
	assertRetained(24)
	save(3)
	assertRetained(9)
}

func TestArtworkEvictionBoundsEmptyEntriesWithTiedAccessTimes(t *testing.T) {
	c, s := testArtworkCache(t)
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	statement, err := tx.Prepare(`INSERT INTO artwork_cache(url,data,mime,etag,modified,validated_at,retry_at,accessed_at) VALUES(?,x'','','','',0,0,1)`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < artworkMaxCacheEntries+3; i++ {
		if _, err := statement.Exec(fmt.Sprintf("old-%05d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := statement.Close(); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := c.save("new", artworkEntry{retry: time.Now().Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	var count, bytes int
	var oldest string
	if err := s.db.QueryRow(`SELECT COUNT(*),SUM(length(data)),MIN(CASE WHEN url LIKE 'old-%' THEN url END) FROM artwork_cache`).Scan(&count, &bytes, &oldest); err != nil {
		t.Fatal(err)
	}
	if count != artworkMaxCacheEntries || bytes != 0 || oldest != "old-00004" {
		t.Fatalf("empty entries not bounded deterministically: entries=%d bytes=%d oldest=%s", count, bytes, oldest)
	}
}
