package app

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// Run with: go test ./internal/app -run '^$' -bench BenchmarkArtworkCacheSave -benchtime=5x
// Setup is outside the timer: real SQLite/WAL, one connection, 16KiB assets.
func BenchmarkArtworkCacheSave(b *testing.B) {
	const insert = `INSERT OR REPLACE INTO artwork_cache(url,data,mime,etag,modified,validated_at,retry_at,accessed_at) VALUES(?,?,'image/png','','',0,0,?)`
	const baselineEviction = `DELETE FROM artwork_cache WHERE url IN (
		SELECT url FROM (SELECT url,
		SUM(length(data)) OVER (ORDER BY accessed_at DESC,url DESC) AS bytes,
		ROW_NUMBER() OVER (ORDER BY accessed_at DESC,url DESC) AS entries
		FROM artwork_cache) WHERE bytes>? OR entries>?
	)`
	for _, optimized := range []bool{false, true} {
		name := "baseline"
		if optimized {
			name = "optimized"
		}
		for _, workload := range []string{"under_budget", "revalidate", "insert_evict"} {
			b.Run(name+"/"+workload, func(b *testing.B) {
				s, err := openStore(b.TempDir(), "http://provider.invalid", "benchmark")
				if err != nil {
					b.Fatal(err)
				}
				cache, err := newArtworkCache(context.Background(), s.db)
				if err != nil {
					s.close()
					b.Fatal(err)
				}
				b.Cleanup(func() { cache.close(); s.close() })
				if !optimized {
					if _, err := s.db.Exec(`DROP INDEX artwork_lru_size; CREATE INDEX artwork_accessed ON artwork_cache(accessed_at)`); err != nil {
						b.Fatal(err)
					}
				}
				rows := artworkMaxCacheEntries
				if workload == "under_budget" {
					rows /= 4
				}
				blob := make([]byte, artworkMaxCacheBytes/artworkMaxCacheEntries)
				tx, err := s.db.Begin()
				if err != nil {
					b.Fatal(err)
				}
				for i := 0; i < rows; i++ {
					if _, err := tx.Exec(insert, fmt.Sprintf("asset-%05d", i), blob, i/8); err != nil {
						tx.Rollback()
						b.Fatal(err)
					}
				}
				if err := tx.Commit(); err != nil {
					b.Fatal(err)
				}
				if _, err := s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
					b.Fatal(err)
				}
				image := artworkEntry{image: imageData{data: blob, mime: "image/png"}, validated: time.Now()}
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					key := fmt.Sprintf("asset-%05d", rows-1)
					if workload == "insert_evict" {
						key = fmt.Sprintf("new-%05d", i)
					}
					if optimized {
						err = cache.save(key, image)
					} else {
						tx, err = s.db.Begin()
						if err == nil {
							_, err = tx.Exec(insert, key, blob, time.Now().UnixNano())
							if err == nil {
								_, err = tx.Exec(baselineEviction, artworkMaxCacheBytes, artworkMaxCacheEntries)
							}
							if err == nil {
								err = tx.Commit()
							} else {
								tx.Rollback()
							}
						}
					}
					if err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
