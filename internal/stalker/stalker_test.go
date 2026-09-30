package stalker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

// This fake portal checks the wire contract across authentication, pagination,
// seasons, EPG and freshly issued playback links.
func TestPortalWorkflow(t *testing.T) {
	var mu sync.Mutex
	token := "t1"
	handshakes := 0
	links := 0
	requests := map[string]int{}
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		action := q.Get("action")
		typ := q.Get("type")
		if r.URL.Path != "/stalker_portal/server/load.php" {
			t.Errorf("wrong endpoint: %s", r.URL.Path)
		}
		if !strings.Contains(r.Header.Get("Cookie"), "mac=00%3A11%3A22%3A33%3A44%3A55") || !strings.Contains(r.Header.Get("Cookie"), "timezone=America%2FToronto") {
			t.Errorf("missing identity cookies: %s", r.Header.Get("Cookie"))
		}
		mu.Lock()
		defer mu.Unlock()
		requests[typ+"/"+action]++
		w.Header().Set("Content-Type", "application/json")
		respond := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		if action == "handshake" {
			handshakes++
			token = fmt.Sprintf("t%d", handshakes)
			respond(map[string]any{"token": token})
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if action == "get_profile" {
			if q.Get("device_id") != "device-a" || q.Get("device_id2") != "device-b" {
				t.Error("device IDs absent")
			}
			respond(map[string]any{"id": 1})
			return
		}
		switch typ + "/" + action {
		case "itv/get_all_channels":
			respond(map[string]any{"data": []any{map[string]any{"id": "1", "name": "News", "cmd": "ffmpeg http://old/live", "tv_genre_id": "10", "logo": "logos/news.png", "cmds": []any{map[string]any{"ch_id": "901"}}}}})
		case "itv/get_categories":
			respond([]any{})
		case "itv/get_genres":
			respond([]any{map[string]any{"id": "10", "title": "News & Current Affairs"}})
		case "vod/get_categories":
			respond([]any{map[string]any{"id": "20", "title": "Films"}})
		case "series/get_categories":
			respond([]any{map[string]any{"id": "30", "title": "Shows"}})
		case "vod/get_ordered_list":
			if q.Get("movie_id") == "200" {
				switch q.Get("season_id") {
				case "0":
					respond(map[string]any{"total_items": 2, "data": []any{map[string]any{"id": "5", "name": "Season 5", "is_season": 1}, map[string]any{"id": "3793", "name": "Season 1", "is_season": 1}}})
				case "5":
					respond(map[string]any{"total_items": 2, "data": []any{map[string]any{"id": "501", "name": "Pilot", "cmd": "/media/file_501.mpg", "series_number": "1"}, map[string]any{"id": "502", "name": "Second", "cmd": "/media/file_502.mpg", "series_number": "2"}}})
				case "3793":
					respond(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "601", "name": "Opening", "cmd": "/media/file_601.mpg", "series_number": "1"}}})
				default:
					respond(map[string]any{"data": []any{}})
				}
				return
			}
			if q.Get("p") == "1" {
				respond(map[string]any{"total_items": 2, "data": []any{map[string]any{"id": "100", "name": "Film One", "category_id": "20", "cmd": "/media/file_100.mpg"}, map[string]any{"id": "101", "name": "Film Two", "category_id": 20, "cmd": "/media/file_101.mpg"}}})
			} else {
				respond(map[string]any{"data": []any{}})
			}
		case "series/get_ordered_list":
			if q.Get("movie_id") != "" {
				respond(map[string]any{"data": []any{}})
			} else {
				respond(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "200", "name": "The Show", "genre_id": "30"}}})
			}
		case "itv/get_epg_info":
			if q.Get("period") != "24" {
				t.Errorf("bulk EPG missing period: %v", q)
			}
			respond(map[string]any{"data": map[string]any{"901": []any{map[string]any{"name": "Morning News", "start_timestamp": "2026-09-28 08:00:00", "stop_timestamp": "2026-09-28 09:00:00", "descr": "Local news"}}}})
		case "itv/create_link", "vod/create_link":
			links++
			if typ == "vod" && strings.Contains(q.Get("cmd"), "file_100") {
				respond(map[string]any{"id": "stream-100", "play_token": "play-1"})
				return
			}
			respond(map[string]any{"cmd": fmt.Sprintf("ffmpeg %s/play/%d.m3u8", server.URL, links)})
		default:
			t.Errorf("unexpected request %s %s", typ, action)
			respond([]any{})
		}
	}))
	defer server.Close()
	c, e := New(Config{PortalURL: server.URL + "/stalker_portal/c/", MAC: "00:11:22:33:44:55", Timezone: "America/Toronto", DeviceID: "device-a", DeviceID2: "device-b", EPGHours: 24, RequestInterval: time.Nanosecond})
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	items, e := c.Catalog(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if len(items) != 1 || requests["vod/get_ordered_list"] != 0 || requests["series/get_ordered_list"] != 0 {
		t.Fatalf("catalog: %+v", items)
	}
	categories, e := c.Categories(ctx)
	if e != nil || len(categories) != 3 {
		t.Fatalf("categories: %+v %v", categories, e)
	}
	movies, e := c.Browse(ctx, model.BrowseQuery{Kind: "movie", Category: "20", Page: 1})
	if e != nil || len(movies.Items) != 2 || movies.HasMore {
		t.Fatalf("movies: %+v %v", movies, e)
	}
	shows, e := c.Browse(ctx, model.BrowseQuery{Kind: "series", Category: "30", Page: 1})
	if e != nil || len(shows.Items) != 1 || shows.HasMore {
		t.Fatalf("series: %+v %v", shows, e)
	}
	items = append(items, movies.Items...)
	searchMovies, searchErr := c.Browse(ctx, model.BrowseQuery{Kind: "movie", Category: "*", Search: "Film", Page: 1})
	if searchErr != nil || len(searchMovies.Items) != 2 || searchMovies.Items[0].CategoryID != "20" || searchMovies.Items[1].CategoryID != "20" || shows.Items[0].CategoryID != "30" || items[0].CategoryID != "10" {
		t.Fatalf("portal navigation categories lost: search=%+v series=%+v live=%+v err=%v", searchMovies, shows, items[0], searchErr)
	}
	items = append(items, shows.Items...)
	found := map[string]model.Item{}
	for _, x := range items {
		found[x.ID] = x
	}
	if found["live:1"].Category != "News & Current Affairs" || found["movie:101"].Name != "Film Two" || found["series:200"].Kind != "series" {
		t.Fatalf("bad catalog: %+v", items)
	}
	ep, e := c.Episodes(ctx, found["series:200"])
	if e != nil {
		t.Fatal(e)
	}
	if len(ep) != 3 || ep[0].ID != "episode:200:5:501" || ep[0].Season != 5 || ep[1].Episode != 2 || ep[2].ID != "episode:200:3793:601" || ep[2].Season != 1 {
		t.Fatalf("episodes: %+v", ep)
	}
	pg, e := c.EPG(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if requests["itv/get_epg_info"] != 1 || len(pg) != 1 || pg[0].ChannelID != "live:1" || pg[0].Start.Location().String() != "America/Toronto" {
		t.Fatalf("EPG: %+v", pg)
	}
	src, e := c.Resolve(ctx, ep[0])
	if e != nil {
		t.Fatal(e)
	}
	if src.Live || src.URL != server.URL+"/play/1.m3u8" || src.Headers["Authorization"] == "" {
		t.Fatalf("episode source: %+v", src)
	}
	src, e = c.Resolve(ctx, found["live:1"])
	if e != nil || !src.Live || src.URL != server.URL+"/play/2.m3u8" {
		t.Fatalf("live source: %+v %v", src, e)
	}
	// Force expiry. The next call must handshake, get_profile and retry.
	mu.Lock()
	token = "expired"
	mu.Unlock()
	src, e = c.Resolve(ctx, found["movie:100"])
	if e != nil || src.URL != server.URL+"/play/movie.php?mac=00%3A11%3A22%3A33%3A44%3A55&play_token=play-1&stream=stream-100.mp4&type=movie" {
		t.Fatalf("refresh source: %+v %v", src, e)
	}
	if handshakes != 2 || requests["stb/get_profile"] != 2 {
		t.Fatalf("refresh was skipped: handshakes=%d requests=%v", handshakes, requests)
	}
}

func TestLiveGenresDoNotProbeUnsupportedCategories(t *testing.T) {
	var handshakes, categoryCalls, genreCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		key := q.Get("type") + "/" + q.Get("action")
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		switch key {
		case "stb/handshake":
			handshakes++
			send(map[string]any{"token": "token"})
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "itv/get_all_channels":
			send(map[string]any{"data": []any{map[string]any{"id": "1", "name": "News", "tv_genre_id": "10"}}})
		case "itv/get_categories":
			categoryCalls++
			send(false)
		case "itv/get_genres":
			genreCalls++
			send([]any{map[string]any{"id": "10", "title": "News"}})
		case "vod/get_categories", "series/get_categories":
			send([]any{})
		default:
			t.Errorf("unexpected action: %s", key)
		}
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	items, err := c.Catalog(context.Background())
	if err != nil || handshakes != 1 || genreCalls != 1 || categoryCalls != 0 || len(items) != 1 || items[0].Category != "News" {
		t.Fatalf("live metadata: error=%v handshakes=%d genres=%d categories=%d items=%+v", err, handshakes, genreCalls, categoryCalls, items)
	}
}

func TestPassiveCategoriesAndSearchBrowse(t *testing.T) {
	var ordered []string
	var handshakes int
	var pageTwoAttempts int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		key := q.Get("type") + "/" + q.Get("action")
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		switch key {
		case "stb/handshake":
			handshakes++
			send(map[string]any{"token": "token"})
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "itv/get_all_channels":
			send(map[string]any{"data": []any{map[string]any{"id": "1", "name": "News", "tv_genre_id": "10"}}})
		case "itv/get_genres":
			send([]any{map[string]any{"id": "10", "title": "News"}})
		case "vod/get_categories":
			send([]any{map[string]any{"id": "0", "title": "All"}, map[string]any{"id": "20", "title": "Entertainment"}})
		case "series/get_categories":
			send(false)
		case "vod/get_ordered_list":
			ordered = append(ordered, q.Encode())
			if q.Get("category") != "20" || q.Get("search") != "matrix" || q.Get("genre") != "0" || q.Get("sortby") != "added" {
				t.Errorf("wrong browse query: %v", q)
			}
			switch q.Get("p") {
			case "1":
				send(map[string]any{"total_items": 4, "max_page_items": 2, "data": []any{
					map[string]any{"id": "100", "name": "Matrix Show One", "is_series": true, "cmd": "show-command"},
					map[string]any{"id": "101", "name": "Matrix Movie One", "is_series": false, "cmd": "movie-command", "screenshot_uri": "logos/movie.png"},
				}})
			case "2":
				pageTwoAttempts++
				if pageTwoAttempts == 1 {
					w.Header().Set("Retry-After", "0")
					w.WriteHeader(http.StatusTooManyRequests)
					return
				}
				send(map[string]any{"total_items": 4, "max_page_items": 2, "data": []any{
					map[string]any{"id": "102", "name": "Matrix Movie Two", "is_series": 0},
					map[string]any{"id": "103", "name": "Matrix Show Two", "is_series": 1},
				}})
			case "3":
				send(map[string]any{"data": "malformed"})
			default:
				t.Errorf("unexpected page: %s", q.Get("p"))
			}
		default:
			t.Errorf("unexpected request: %s", key)
			send([]any{})
		}
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	c.retryBackoff = func(int) time.Duration { return time.Millisecond }
	live, err := c.Catalog(context.Background())
	if err != nil || len(live) != 1 || len(ordered) != 0 {
		t.Fatalf("eager VOD load: live=%+v ordered=%v error=%v", live, ordered, err)
	}
	categories, err := c.Categories(context.Background())
	if err != nil || len(categories) != 3 || len(ordered) != 0 || handshakes != 1 {
		t.Fatalf("category discovery: %+v ordered=%v handshakes=%d error=%v", categories, ordered, handshakes, err)
	}
	if categories[1].Kind != "movie" || categories[1].SourceType != "vod" || categories[2].Kind != "series" || categories[2].SourceType != "vod" || categories[2].ID != "20" {
		t.Fatalf("category mapping: %+v", categories)
	}
	movie, err := c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Category: "20", Search: "matrix", Page: 1, SourceType: categories[1].SourceType})
	if err != nil || len(movie.Items) != 1 || movie.Items[0].ID != "movie:101" || movie.Items[0].ProviderID != "101" || movie.Items[0].Command != "movie-command" || movie.Items[0].Logo == "" || !movie.HasMore || movie.Total != 4 {
		t.Fatalf("movie page: %+v error=%v", movie, err)
	}
	series, err := c.Browse(context.Background(), model.BrowseQuery{Kind: "series", Category: "20", Search: "matrix", Page: 2, SourceType: categories[2].SourceType})
	if err != nil || len(series.Items) != 1 || series.Items[0].ID != "series:103" || series.Items[0].SeriesID != "103" || series.HasMore || len(ordered) != 3 || pageTwoAttempts != 2 {
		t.Fatalf("series page: %+v ordered=%v error=%v", series, ordered, err)
	}
	_, err = c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Category: "20", Search: "matrix", Page: 3})
	if err == nil || !strings.Contains(err.Error(), "invalid portal ordered list") {
		t.Fatalf("malformed page accepted: %v", err)
	}
}

func TestKeywordSearchSinglePageAndCategoryHints(t *testing.T) {
	var searches []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		switch q.Get("type") + "/" + q.Get("action") {
		case "stb/handshake":
			send(map[string]any{"token": "token"})
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "itv/get_genres":
			send([]any{})
		case "vod/get_categories":
			send([]any{
				map[string]any{"id": "10", "title": "Punjabi Latest Movies"},
				map[string]any{"id": "11", "title": "Hindi Series"},
				map[string]any{"id": "12", "title": "International"},
				map[string]any{"id": "13", "title": "Other", "type": "series"},
			})
		case "series/get_categories":
			send(false)
		case "vod/get_ordered_list":
			searches = append(searches, q.Get("search"))
			if q.Get("p") != "1" {
				t.Errorf("unexpected page: %s", q.Get("p"))
			}
			// Simulate a portal that only finds contiguous text in its search field.
			if q.Get("search") != "colors" {
				send(map[string]any{"total_items": 0, "data": []any{}})
				return
			}
			send(map[string]any{"total_items": 4, "max_page_items": 2, "data": []any{
				map[string]any{"id": "1", "name": "COLORS: India — 4K", "is_series": false},
				map[string]any{"id": "2", "name": "Colors USA", "is_series": false},
			}})
		default:
			t.Errorf("unexpected portal call: %s/%s", q.Get("type"), q.Get("action"))
		}
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	cats, err := c.Categories(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]map[string]bool{}
	for _, cat := range cats {
		if kinds[cat.ID] == nil {
			kinds[cat.ID] = map[string]bool{}
		}
		kinds[cat.ID][cat.Kind] = true
	}
	if len(searches) != 0 || !kinds["10"]["movie"] || kinds["10"]["series"] || kinds["11"]["movie"] || !kinds["11"]["series"] || !kinds["12"]["movie"] || !kinds["12"]["series"] || kinds["13"]["movie"] || !kinds["13"]["series"] {
		t.Fatalf("category hints: %+v searches=%v", cats, searches)
	}
	page, err := c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Search: "colors 4k", Page: 1})
	if err != nil || len(page.Items) != 1 || page.Items[0].Name != "COLORS: India — 4K" || !page.HasMore || page.Total != 4 || len(searches) != 1 || searches[0] != "colors" {
		t.Fatalf("keyword page: %+v searches=%v error=%v", page, searches, err)
	}
	page, err = c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Search: "colors canada", Page: 1})
	if err != nil || len(page.Items) != 0 || !page.HasMore || len(searches) != 2 {
		t.Fatalf("empty filtered page must retain raw pagination: %+v searches=%v error=%v", page, searches, err)
	}
}

func TestEpisodeListTerminalShortfallAndTransientEmptyPage(t *testing.T) {
	for _, tc := range []struct {
		name, mode                         string
		capacity, first, last, total, want int
		wantErr                            string
	}{
		{name: "confirmed shortfall", mode: "short", capacity: 2, first: 2, last: 1, total: 4, want: 3},
		{name: "multirow reported drift", mode: "short", capacity: 4, first: 4, last: 2, total: 8, want: 6},
		{name: "transient empty", mode: "transient", capacity: 2, first: 2, last: 1, total: 4, want: 4},
		{name: "full page then empty", mode: "short", capacity: 2, first: 2, last: 2, total: 5, wantErr: "portal list incomplete"},
		{name: "large gap after short page", mode: "short", capacity: 4, first: 4, last: 1, total: 9, wantErr: "portal list incomplete"},
		{name: "malformed terminal", mode: "malformed", capacity: 2, first: 2, last: 1, total: 4, wantErr: "invalid portal episode list"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			terminalCalls := 0
			pageItems := func(start, count int) []any {
				items := make([]any, 0, count)
				for i := 0; i < count; i++ {
					items = append(items, map[string]any{"id": strconv.Itoa(501 + start + i), "name": "Episode", "cmd": "file"})
				}
				return items
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				w.Header().Set("Content-Type", "application/json")
				send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
				switch q.Get("type") + "/" + q.Get("action") {
				case "stb/handshake":
					send(map[string]any{"token": "token"})
				case "stb/get_profile":
					send(map[string]any{"id": 1})
				case "vod/get_ordered_list":
					if q.Get("movie_id") != "200" || q.Get("episode_id") != "0" {
						t.Errorf("unexpected episode query shape: %v", q)
					}
					if q.Get("season_id") == "0" {
						send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "5", "name": "Season 1", "is_season": 1}}})
						return
					}
					if q.Get("season_id") != "5" {
						t.Errorf("unexpected season: %v", q)
					}
					if q.Get("p") == "0" {
						send(map[string]any{"total_items": tc.total, "max_page_items": tc.capacity, "data": pageItems(0, tc.first)})
						return
					}
					if q.Get("p") == "1" {
						send(map[string]any{"total_items": tc.total, "max_page_items": tc.capacity, "data": pageItems(tc.first, tc.last)})
						return
					}
					terminalCalls++
					if tc.mode == "malformed" {
						send(map[string]any{"total_items": tc.total, "data": "broken"})
					} else if tc.mode == "transient" && terminalCalls == 2 {
						send(map[string]any{"total_items": tc.total, "data": pageItems(tc.first+tc.last, 1)})
					} else {
						send(map[string]any{"total_items": tc.total, "data": []any{}})
					}
				default:
					t.Errorf("unexpected provider request: %v", q)
				}
			}))
			defer srv.Close()
			c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
			if err != nil {
				t.Fatal(err)
			}
			items, err := c.Episodes(context.Background(), model.Item{ID: "series:200", Kind: "series", ProviderID: "200"})
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("incomplete episode list accepted: items=%d err=%v", len(items), err)
				}
				return
			}
			if err != nil || len(items) != tc.want || terminalCalls != 2 {
				t.Fatalf("episode list: items=%d terminalCalls=%d err=%v", len(items), terminalCalls, err)
			}
		})
	}
}

func TestSelectedEpisodeResolvesScopedFile(t *testing.T) {
	var lookups, links int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		switch q.Get("type") + "/" + q.Get("action") {
		case "stb/handshake":
			send(map[string]any{"token": "token"})
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "vod/get_ordered_list":
			lookups++
			if q.Get("movie_id") != "200" || q.Get("season_id") != "5" || q.Get("p") != "0" {
				t.Errorf("file lookup lost episode scope: %v", q)
			}
			switch q.Get("episode_id") {
			case "501":
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "9001", "video_id": "200", "is_file": true, "cmd": "http://storage.test/origin-A"}}})
			case "502":
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "9002", "video_id": "200", "is_file": true, "cmd": "http://storage.test/origin-B"}}})
			case "503":
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "9003", "video_id": "wrong-parent", "cmd": "wrong-file"}}})
			case "504":
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "504", "video_id": "200", "is_season": 1}}})
			case "505":
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "9005", "video_id": "200", "cmd": "opaque-file-C"}}})
			default:
				t.Errorf("unexpected episode: %v", q)
			}
		case "vod/create_link":
			links++
			expectedSeries := map[string]string{"/media/file_9001.mpg": "22", "/media/file_9002.mpg": "23", "opaque-file-C": "24"}[q.Get("cmd")]
			if q.Get("series") != expectedSeries {
				t.Errorf("selected episode number missing from link request: %v", q)
			}
			switch q.Get("cmd") {
			case "/media/file_9001.mpg":
				send(map[string]any{"cmd": "ffmpeg http://example.test/media/A.m3u8"})
			case "/media/file_9002.mpg":
				send(map[string]any{"cmd": "ffmpeg http://example.test/media/B.m3u8"})
			case "opaque-file-C":
				send(map[string]any{"cmd": "ffmpeg http://example.test/media/C.m3u8"})
			default:
				t.Errorf("unselected media command: %v", q)
				send(map[string]any{"cmd": ""})
			}
		default:
			t.Errorf("unexpected portal call: %v", q)
		}
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		row, want string
		number    int
	}{{"501", "A", 22}, {"502", "B", 23}, {"505", "C", 24}} {
		item := model.Item{ID: "episode:200:5:" + tc.row, Kind: "episode", ProviderID: tc.row, SeriesID: "200", Episode: tc.number}
		source, err := c.Resolve(context.Background(), item)
		if err != nil || !strings.Contains(source.URL, "/media/"+tc.want+".m3u8") {
			t.Fatalf("wrong file selected for %s: source=%+v err=%v", tc.row, source, err)
		}
	}
	for _, row := range []string{"503", "504"} {
		_, err := c.Resolve(context.Background(), model.Item{ID: "episode:200:5:" + row, Kind: "episode", ProviderID: row, SeriesID: "200"})
		if err == nil || !strings.Contains(err.Error(), "episode file unavailable") {
			t.Fatalf("unrelated file accepted for %s: %v", row, err)
		}
	}
	_, err = c.Resolve(context.Background(), model.Item{ID: "episode:200:5:501", Kind: "episode", ProviderID: "501", SeriesID: "200"})
	if err == nil || !strings.Contains(err.Error(), "episode number is missing") {
		t.Fatalf("file lookup without episode number accepted: %v", err)
	}
	if lookups != 6 || links != 3 {
		t.Fatalf("unexpected portal request count: lookups=%d links=%d", lookups, links)
	}
}

func TestMovieShellResolvesConcreteFile(t *testing.T) {
	var fileLookups, links int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		switch q.Get("type") + "/" + q.Get("action") {
		case "stb/handshake":
			send(map[string]any{"token": "token"})
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "vod/get_ordered_list":
			if q.Get("movie_id") == "" {
				if q.Get("category") != "26" || q.Get("p") != "1" {
					t.Errorf("unexpected movie browse: %v", q)
				}
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "338020", "name": "Movie", "cmd": "/media/338020.mpg"}}})
				return
			}
			fileLookups++
			if q.Get("season_id") != "0" || q.Get("episode_id") != "0" || q.Get("p") != "0" {
				t.Errorf("movie file lookup lost scope: %v", q)
			}
			switch q.Get("movie_id") {
			case "338020":
				send(map[string]any{"total_items": 3, "data": []any{
					map[string]any{"id": "7", "video_id": "338020", "is_season": true},
					map[string]any{"id": "8000", "video_id": "other-movie", "is_file": true, "cmd": "http://storage.test/wrong"},
					map[string]any{"id": "2825215", "video_id": "338020", "is_file": true, "cmd": "http://storage.test/right"},
				}})
			case "338349":
				send(map[string]any{"total_items": 1, "data": []any{map[string]any{"id": "8001", "video_id": "another-movie", "is_file": true}}})
			default:
				t.Errorf("unexpected movie file lookup: %v", q)
			}
		case "vod/create_link":
			links++
			if q.Has("series") {
				t.Errorf("movie link should not select series: %v", q)
			}
			switch q.Get("cmd") {
			case "/media/file_2825215.mpg":
				send(map[string]any{"cmd": "ffmpeg http://example.test/movie/338020.m3u8"})
			case "/media/file_902.mpg":
				send(map[string]any{"cmd": "ffmpeg http://example.test/movie/338354.m3u8"})
			case "opaque-explicit":
				send(map[string]any{"cmd": "ffmpeg http://example.test/movie/338355.m3u8"})
			default:
				t.Errorf("wrong movie file command: %v", q)
				send(map[string]any{"cmd": ""})
			}
		default:
			t.Errorf("unexpected portal request: %v", q)
		}
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if err != nil {
		t.Fatal(err)
	}
	page, err := c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Category: "26", Page: 1})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("movie browse: %+v err=%v", page, err)
	}
	for _, item := range []model.Item{page.Items[0], {ID: "movie:338020", Kind: "movie", ProviderID: "338020", Command: "/media/338020.mpg"}, {ID: "movie:338020", Kind: "movie", ProviderID: "338020"}} {
		source, resolveErr := c.Resolve(context.Background(), item)
		if resolveErr != nil || !strings.Contains(source.URL, "/movie/338020.m3u8") {
			t.Fatalf("movie shell resolved incorrectly: %+v err=%v", source, resolveErr)
		}
	}
	explicit, err := c.Resolve(context.Background(), model.Item{ID: "movie:338354", Kind: "movie", ProviderID: "338354", Command: "/media/file_902.mpg"})
	if err != nil || !strings.Contains(explicit.URL, "/movie/338354.m3u8") {
		t.Fatalf("explicit file command changed: %+v err=%v", explicit, err)
	}
	opaque, err := c.Resolve(context.Background(), model.Item{ID: "movie:338355", Kind: "movie", ProviderID: "338355", Command: "opaque-explicit"})
	if err != nil || !strings.Contains(opaque.URL, "/movie/338355.m3u8") {
		t.Fatalf("opaque movie command changed: %+v err=%v", opaque, err)
	}
	_, err = c.Resolve(context.Background(), model.Item{ID: "movie:338349", Kind: "movie", ProviderID: "338349", Command: "/media/338349.mpg"})
	if err == nil || !strings.Contains(err.Error(), "movie file unavailable") {
		t.Fatalf("unrelated movie file accepted: %v", err)
	}
	if fileLookups != 4 || links != 5 {
		t.Fatalf("unexpected movie portal calls: lookups=%d links=%d", fileLookups, links)
	}
}

func TestPortalURLFormsAndSafeErrors(t *testing.T) {
	for in, want := range map[string]string{"https://example.test/c": "/server/load.php", "https://example.test/stalker_portal/c": "/stalker_portal/server/load.php", "https://example.test/portal.php": "/portal.php", "https://example.test/server/load.php": "/server/load.php"} {
		c, e := New(Config{PortalURL: in, MAC: "mac"})
		if e != nil || c.endpoint.Path != want {
			t.Fatalf("%s: %v %v", in, c, e)
		}
	}
	secret := "00:11:22:33:44:55"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, secret+" token failed", http.StatusForbidden)
	}))
	defer srv.Close()
	c, _ := New(Config{PortalURL: srv.URL + "/c", MAC: secret, RequestInterval: time.Nanosecond})
	_, e := c.Catalog(context.Background())
	if e == nil || strings.Contains(e.Error(), secret) || strings.Contains(e.Error(), srv.URL) {
		t.Fatalf("unsafe error: %v", e)
	}
	_, e = New(Config{PortalURL: "https://user:password@example.test/c", MAC: secret})
	if e == nil {
		t.Fatal("accepted URL credentials")
	}
}

func TestRootRedirectAndPortalVariants(t *testing.T) {
	calls := map[string]int{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			http.Redirect(w, r, "/stalker_portal/c", http.StatusFound)
			return
		}
		if r.URL.Path == "/stalker_portal/c" {
			_, _ = w.Write([]byte("landing"))
			return
		}
		if r.URL.Path != "/stalker_portal/server/load.php" {
			t.Errorf("unexpected URL: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		key := q.Get("type") + "/" + q.Get("action")
		calls[key]++
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		if key == "stb/handshake" {
			send(map[string]any{"token": "token"})
			return
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("missing token for %s", key)
		}
		switch key {
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "itv/get_all_channels":
			send(map[string]any{"data": []any{map[string]any{"id": "1", "name": "One", "logo": "/logos/one.png", "cmds": []any{map[string]any{"ch_id": "44"}}}}})
		case "itv/get_categories":
			send([]any{})
		case "itv/get_genres":
			send([]any{})
		case "vod/get_categories":
			send([]any{map[string]any{"id": "0", "title": "All"}, map[string]any{"id": "20", "title": "Drama"}, map[string]any{"id": "30", "title": "Shows", "type": "series"}})
		case "series/get_categories":
			send([]any{map[string]any{"id": "0", "title": "All Series"}, map[string]any{"id": "30", "title": "Shows"}})
		case "vod/get_ordered_list":
			switch q.Get("category") {
			case "0":
				t.Error("queried synthetic All category")
				send([]any{})
			case "20":
				switch q.Get("p") {
				case "0", "1":
					send([]any{map[string]any{"id": "100", "name": "A", "duration": "01:30:00"}})
				case "2":
					send([]any{map[string]any{"id": "101", "name": "B"}})
				default:
					send([]any{})
				}
			case "30":
				send([]any{map[string]any{"id": "200", "name": "Series", "is_series": 1}, map[string]any{"id": "201", "name": "Ordinary Movie", "is_series": 0}})
			default:
				send([]any{})
			}
		case "series/get_ordered_list":
			http.Error(w, "unsupported", http.StatusNotFound)
		case "itv/get_epg_info":
			if q.Get("period") == "6" {
				send([]any{})
				return
			}
			if q.Get("ch_id") != "44" {
				t.Errorf("wrong channel ID: %v", q)
			}
			send([]any{map[string]any{"title": "One Show", "start": "2026-09-28 10:00:00", "end": "2026-09-28 11:00:00"}})
		default:
			t.Errorf("unexpected action %s", key)
			send([]any{})
		}
	}))
	defer srv.Close()
	c, e := New(Config{PortalURL: srv.URL, MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if e != nil {
		t.Fatal(e)
	}
	// EPG first checks that channel-to-EPG-ID mapping is refreshed after live loading.
	programs, e := c.EPG(context.Background())
	if e != nil || len(programs) != 1 || programs[0].ChannelID != "live:1" {
		t.Fatalf("EPG fallback: %+v %v", programs, e)
	}
	items, e := c.Catalog(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if len(items) != 1 || calls["vod/get_ordered_list"] != 0 {
		t.Fatalf("unexpected eager VOD load: %+v", items)
	}
	categories, e := c.Categories(context.Background())
	if e != nil || len(categories) != 2 || calls["vod/get_ordered_list"] != 0 || categories[1].ID != "30" || categories[1].Kind != "series" || categories[1].SourceType != "series" {
		t.Fatalf("categories: %+v %v", categories, e)
	}
	for _, page := range []int{1, 2} {
		result, browseErr := c.Browse(context.Background(), model.BrowseQuery{Kind: "movie", Category: "20", Page: page})
		if browseErr != nil {
			t.Fatal(browseErr)
		}
		items = append(items, result.Items...)
	}
	result, e := c.Browse(context.Background(), model.BrowseQuery{Kind: "series", Category: "30", Page: 1, SourceType: "series"})
	if e != nil || len(result.Items) != 1 {
		t.Fatalf("series fallback: %+v %v", result, e)
	}
	items = append(items, result.Items...)
	got := map[string]model.Item{}
	for _, it := range items {
		got[it.ID] = it
	}
	if len(items) != 4 || got["movie:100"].Duration != 5400 || got["movie:101"].Name != "B" || got["series:200"].ID == "" {
		t.Fatalf("catalog variants: %+v", items)
	}
	if got["series:201"].ID != "" {
		t.Fatalf("movie mislabeled as series: %+v", got["series:201"])
	}
	if got["live:1"].Logo != srv.URL+"/logos/one.png" {
		t.Fatalf("root-relative logo: %s", got["live:1"].Logo)
	}
	if calls["itv/get_epg_info"] != 2 {
		t.Fatalf("EPG requests: %v", calls)
	}
}

func TestLargeCatalogResponseLimit(t *testing.T) {
	// A portal can return tens of thousands of channels. Padding outside js
	// keeps the fixture small while exercising the full response envelope.
	large := []byte(`{"js":{"data":[{"id":"1","name":"Large Channel","cmd":"http://example.test/live"}]},"padding":"` + strings.Repeat("x", 17<<20) + `"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		key := q.Get("type") + "/" + q.Get("action")
		w.Header().Set("Content-Type", "application/json")
		switch key {
		case "stb/handshake":
			_, _ = w.Write([]byte(`{"js":{"token":"token"}}`))
		case "stb/get_profile":
			_, _ = w.Write([]byte(`{"js":{"id":1}}`))
		case "itv/get_all_channels":
			_, _ = w.Write(large)
		case "itv/get_categories", "itv/get_genres", "vod/get_categories", "series/get_categories":
			_, _ = w.Write([]byte(`{"js":[]}`))
		default:
			t.Errorf("unexpected portal request: %s", key)
			http.Error(w, "unexpected", http.StatusBadRequest)
		}
	}))
	defer server.Close()
	makeClient := func(max int64) *Client {
		c, e := New(Config{PortalURL: server.URL + "/server/load.php", MAC: "aa:bb", MaxResponseBytes: max, RequestInterval: time.Nanosecond})
		if e != nil {
			t.Fatal(e)
		}
		return c
	}
	for _, tc := range []struct {
		name string
		max  int64
		ok   bool
	}{
		{"default above 16 MiB", 0, true},
		{"exact boundary", int64(len(large)), true},
		{"one byte below", int64(len(large) - 1), false},
		{"small configured limit", 1 << 20, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items, e := makeClient(tc.max).Catalog(context.Background())
			if tc.ok {
				if e != nil || len(items) != 1 || items[0].Name != "Large Channel" {
					t.Fatalf("large catalog: %+v %v", items, e)
				}
				return
			}
			if e == nil || !strings.Contains(e.Error(), "size limit") || !strings.Contains(e.Error(), "STALKER_MAX_RESPONSE_MB") || !strings.Contains(e.Error(), fmt.Sprint(tc.max)) || strings.Contains(e.Error(), server.URL) {
				t.Fatalf("expected safe size limit error: %+v %v", items, e)
			}
		})
	}
	if _, e := New(Config{PortalURL: server.URL, MAC: "aa:bb", MaxResponseBytes: -1}); e == nil {
		t.Fatal("accepted negative maximum")
	}
}

func TestPlaintextAuthorizationRecovery(t *testing.T) {
	for _, tc := range []struct {
		name, target, body string
		persistent, html   bool
	}{
		{name: "refresh and retry channels", target: "itv/get_all_channels", body: "  aUtHoRiZaTiOn FaIlEd. \n"},
		{name: "persistent category denial", target: "vod/get_categories", body: "Unauthorized request.", persistent: true},
		{name: "HTML is not an auth signal", target: "itv/get_all_channels", body: "<html>Authorization failed.</html>", html: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handshakes := 0
			denials := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				key := q.Get("type") + "/" + q.Get("action")
				if key == "stb/handshake" {
					handshakes++
					_ = json.NewEncoder(w).Encode(map[string]any{"js": map[string]any{"token": fmt.Sprintf("token-%d", handshakes)}})
					return
				}
				if r.Header.Get("Authorization") != fmt.Sprintf("Bearer token-%d", handshakes) {
					t.Errorf("stale token: %s", key)
				}
				if key == tc.target && (tc.persistent || denials == 0) {
					denials++
					w.Header().Set("Content-Type", "text/html")
					_, _ = w.Write([]byte(tc.body))
					return
				}
				w.Header().Set("Content-Type", "application/json")
				var js any = []any{}
				switch key {
				case "stb/get_profile":
					js = map[string]any{"id": 1}
				case "itv/get_all_channels":
					js = map[string]any{"data": []any{map[string]any{"id": "1", "name": "Channel", "cmd": "http://example.test/live"}}}
				case "itv/get_categories", "itv/get_genres", "vod/get_categories", "series/get_categories":
				default:
					t.Errorf("unexpected request: %s", key)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
			}))
			defer srv.Close()
			secret := "aa:bb:cc:dd:ee:ff"
			c, e := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: secret, RequestInterval: time.Nanosecond})
			if e != nil {
				t.Fatal(e)
			}
			var items []model.Item
			if tc.persistent {
				_, e = c.Categories(context.Background())
			} else {
				items, e = c.Catalog(context.Background())
			}
			if !tc.persistent && !tc.html {
				if e != nil || len(items) != 1 || handshakes != 2 || denials != 1 {
					t.Fatalf("recovery: items=%+v error=%v handshakes=%d denials=%d", items, e, handshakes, denials)
				}
				return
			}
			if e == nil || strings.Contains(e.Error(), secret) || strings.Contains(e.Error(), tc.body) {
				t.Fatalf("unsafe error: %v", e)
			}
			if tc.persistent && (!strings.Contains(e.Error(), "authorization failed") || handshakes != 2 || denials != 2) {
				t.Fatalf("persistent denial did not stop once: %v, handshakes=%d denials=%d", e, handshakes, denials)
			}
			if tc.html && (handshakes != 1 || denials != 1 || !strings.Contains(e.Error(), "invalid data")) {
				t.Fatalf("HTML triggered auth retry: %v, handshakes=%d denials=%d", e, handshakes, denials)
			}
		})
	}
}

func TestBulkEPGFailuresDoNotFanOut(t *testing.T) {
	for _, tc := range []struct {
		name     string
		timeout  time.Duration
		max      int64
		auth     bool
		wantBulk int32
	}{
		{name: "timeout", timeout: 5 * time.Millisecond, wantBulk: 1},
		{name: "size limit", max: 1024, wantBulk: 1},
		{name: "persistent authorization", auth: true, wantBulk: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var bulkCalls, channelCalls, handshakes atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				q := r.URL.Query()
				key := q.Get("type") + "/" + q.Get("action")
				w.Header().Set("Content-Type", "application/json")
				send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
				switch key {
				case "stb/handshake":
					handshakes.Add(1)
					send(map[string]any{"token": fmt.Sprintf("t%d", handshakes.Load())})
				case "stb/get_profile":
					send(map[string]any{"id": 1})
				case "itv/get_all_channels":
					send(map[string]any{"data": []any{map[string]any{"id": "1", "name": "Channel", "cmd": "http://example.test/live"}}})
				case "itv/get_categories", "itv/get_genres":
					send([]any{})
				case "itv/get_epg_info":
					if q.Get("ch_id") != "" {
						channelCalls.Add(1)
						send([]any{})
						return
					}
					if q.Get("period") != "6" {
						t.Errorf("unexpected EPG period: %v", q)
					}
					bulkCalls.Add(1)
					if tc.auth {
						w.Header().Set("Content-Type", "text/html")
						_, _ = w.Write([]byte("Authorization failed."))
						return
					}
					if tc.timeout > 0 {
						time.Sleep(40 * time.Millisecond)
						send(map[string]any{"1": []any{}})
						return
					}
					send(map[string]any{"1": []any{}, "padding": strings.Repeat("x", 2048)})
				default:
					t.Errorf("unexpected request: %s", key)
					send([]any{})
				}
			}))
			defer srv.Close()
			cfg := Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestTimeout: tc.timeout, MaxResponseBytes: tc.max, RequestInterval: time.Nanosecond}
			c, e := New(cfg)
			if e != nil {
				t.Fatal(e)
			}
			_, e = c.EPG(context.Background())
			if e == nil {
				t.Fatal("expected bulk EPG failure")
			}
			if bulkCalls.Load() != tc.wantBulk || channelCalls.Load() != 0 {
				t.Fatalf("bulk=%d channel=%d error=%v", bulkCalls.Load(), channelCalls.Load(), e)
			}
		})
	}
	c, e := New(Config{PortalURL: "https://example.test/server/load.php", MAC: "aa:bb"})
	if e != nil || c.cfg.EPGHours != 6 || c.http.Timeout != time.Minute {
		t.Fatalf("defaults: %+v %v", c, e)
	}
	custom := &http.Client{Timeout: 2 * time.Second}
	c, e = New(Config{PortalURL: "https://example.test/server/load.php", MAC: "aa:bb", HTTPClient: custom, RequestTimeout: time.Minute, EPGHours: 24})
	if e != nil || c.http != custom || c.cfg.EPGHours != 24 {
		t.Fatalf("client override: %+v %v", c, e)
	}
	for _, cfg := range []Config{{PortalURL: "https://example.test", MAC: "aa:bb", RequestTimeout: -time.Second}, {PortalURL: "https://example.test", MAC: "aa:bb", EPGHours: 169}, {PortalURL: "https://example.test", MAC: "aa:bb", EPGHours: -1}} {
		if _, e := New(cfg); e == nil {
			t.Fatalf("accepted invalid config: %+v", cfg)
		}
	}
}

func TestRetryAfterCancellationPreservesCooldown(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", time.Now().Add(3*time.Second).UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c, e := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, e = c.Catalog(ctx)
	if !errors.Is(e, context.DeadlineExceeded) || calls.Load() != 1 {
		t.Fatalf("first call=%v, requests=%d", e, calls.Load())
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel2()
	_, e = c.EPG(ctx2)
	if !errors.Is(e, context.DeadlineExceeded) || calls.Load() != 1 {
		t.Fatalf("cooldown lost: error=%v requests=%d", e, calls.Load())
	}
}

func TestAdaptivePortalSpacingAcrossRetryAndRecovery(t *testing.T) {
	var requests []time.Time
	var genres []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, time.Now())
		key := r.URL.Query().Get("type") + "/" + r.URL.Query().Get("action")
		w.Header().Set("Content-Type", "application/json")
		send := func(v any) { _ = json.NewEncoder(w).Encode(map[string]any{"js": v}) }
		switch key {
		case "stb/handshake":
			send(map[string]any{"token": "token"})
		case "stb/get_profile":
			send(map[string]any{"id": 1})
		case "itv/get_genres":
			genres = append(genres, requests[len(requests)-1])
			if len(genres) == 1 {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			send([]any{})
		default:
			t.Errorf("unexpected portal request %s", key)
		}
	}))
	defer srv.Close()
	c, err := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	c.retryBackoff = func(int) time.Duration { return 10 * time.Millisecond }
	for i := 0; i < 22; i++ {
		if _, err := c.request(context.Background(), "itv", "get_genres", nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(requests) != 25 || len(genres) != 23 || requests[1].Sub(requests[0]) < 16*time.Millisecond || genres[1].Sub(genres[0]) < 35*time.Millisecond || genres[len(genres)-1].Sub(genres[len(genres)-2]) < 28*time.Millisecond || c.currentInterval != 32*time.Millisecond {
		t.Fatalf("adaptive spacing: requests=%d genres=%d loginGap=%s retryGap=%s recoveredGap=%s interval=%s", len(requests), len(genres), requests[1].Sub(requests[0]), genres[1].Sub(genres[0]), genres[len(genres)-1].Sub(genres[len(genres)-2]), c.currentInterval)
	}
}

func TestDiscoveryRateLimitCanResume(t *testing.T) {
	var landingCalls, apiCalls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			landingCalls++
			if landingCalls <= 4 {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			http.Redirect(w, r, "/stalker_portal/c", http.StatusFound)
			return
		}
		if r.URL.Path == "/stalker_portal/c" {
			_, _ = w.Write([]byte("landing"))
			return
		}
		if r.URL.Path != "/stalker_portal/server/load.php" {
			t.Errorf("wrong API path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		apiCalls++
		q := r.URL.Query()
		var js any = []any{}
		switch q.Get("type") + "/" + q.Get("action") {
		case "stb/handshake":
			js = map[string]any{"token": "token"}
		case "stb/get_profile":
			js = map[string]any{"id": 1}
		case "itv/get_all_channels":
			js = map[string]any{"data": []any{map[string]any{"id": "1"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"js": js})
	}))
	defer srv.Close()
	c, e := New(Config{PortalURL: srv.URL, MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if e != nil {
		t.Fatal(e)
	}
	c.retryBackoff = func(int) time.Duration { return 0 }
	_, e = c.Catalog(context.Background())
	var limited *RateLimitError
	if !errors.As(e, &limited) || limited.Action != "discovery" || apiCalls != 0 {
		t.Fatalf("first attempt=%v apiCalls=%d", e, apiCalls)
	}
	items, e := c.Catalog(context.Background())
	if e != nil || len(items) != 1 || landingCalls != 5 || apiCalls == 0 {
		t.Fatalf("resume: items=%+v error=%v landing=%d api=%d", items, e, landingCalls, apiCalls)
	}
}

func TestCooldownPersistsBeforeCancellationAndRestores(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	config := Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond}
	c, e := New(config)
	if e != nil {
		t.Fatal(e)
	}
	var saved time.Time
	var saves int
	c.ConfigureCooldown(time.Time{}, func(until time.Time) error {
		saved = until
		saves++
		return nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, e = c.Catalog(ctx)
	if !errors.Is(e, context.DeadlineExceeded) || saves != 1 || time.Until(saved) < time.Second || calls.Load() != 1 {
		t.Fatalf("deadline=%v saves=%d calls=%d error=%v", saved, saves, calls.Load(), e)
	}
	restored, e := New(config)
	if e != nil {
		t.Fatal(e)
	}
	restored.ConfigureCooldown(saved, nil)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel2()
	_, e = restored.Catalog(ctx2)
	if !errors.Is(e, context.DeadlineExceeded) || calls.Load() != 1 {
		t.Fatalf("restored deadline ignored: calls=%d error=%v", calls.Load(), e)
	}
}

func TestCooldownPersistenceFailureStopsRetry(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Retry-After", "2")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	c, e := New(Config{PortalURL: srv.URL + "/server/load.php", MAC: "aa:bb", RequestInterval: time.Nanosecond})
	if e != nil {
		t.Fatal(e)
	}
	c.ConfigureCooldown(time.Time{}, func(time.Time) error { return errors.New("secret persistence detail") })
	_, e = c.Catalog(context.Background())
	if e == nil || !strings.Contains(e.Error(), "could not be saved") || strings.Contains(e.Error(), "secret") || calls.Load() != 1 {
		t.Fatalf("persistence failure: calls=%d error=%v", calls.Load(), e)
	}
}
