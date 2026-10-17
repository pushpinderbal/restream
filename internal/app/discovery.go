package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/pushpinderbal/restream/internal/model"
)

const discoveryLimit = 18
const discoveryTrendCandidates = 12
const discoverySearchBudget = 18

// DiscoveryTitle always refers to a confirmed listing in this provider. The
// metadata identity is separate from its playback identity.
type DiscoveryTitle struct {
	TMDBID      int        `json:"tmdbId,omitempty"`
	Item        model.Item `json:"item"`
	Name        string     `json:"name"`
	Overview    string     `json:"overview,omitempty"`
	Poster      string     `json:"poster,omitempty"`
	Backdrop    string     `json:"backdrop,omitempty"`
	ReleaseDate string     `json:"releaseDate,omitempty"`
	Year        int        `json:"year,omitempty"`
	Rating      float64    `json:"rating,omitempty"`
	Genres      []string   `json:"genres,omitempty"`
}

type discoveryResponse struct {
	Configured     bool             `json:"configured"`
	Refreshing     bool             `json:"refreshing"`
	UpdatedAt      *time.Time       `json:"updatedAt,omitempty"`
	Error          string           `json:"error,omitempty"`
	TrendingMovies []DiscoveryTitle `json:"trendingMovies"`
	TrendingSeries []DiscoveryTitle `json:"trendingSeries"`
	ExploreMovies  []DiscoveryTitle `json:"exploreMovies"`
	ExploreSeries  []DiscoveryTitle `json:"exploreSeries"`
}

type discoveryAsset struct {
	Poster, Backdrop string
	ItemID           string
}

type discoveryRecord struct {
	Version              int                          `json:"version"`
	Revision             time.Time                    `json:"revision"`
	UpdatedAt            time.Time                    `json:"updatedAt"`
	NextAttempt          time.Time                    `json:"nextAttempt"`
	Error                string                       `json:"error,omitempty"`
	HadMetadata          bool                         `json:"hadMetadata"`
	Movies               []DiscoveryTitle             `json:"movies"`
	Series               []DiscoveryTitle             `json:"series"`
	ExploreMovies        []DiscoveryTitle             `json:"exploreMovies"`
	ExploreSeries        []DiscoveryTitle             `json:"exploreSeries"`
	Assets               map[string]discoveryAsset    `json:"assets"`
	PreferencesUpdatedAt time.Time                    `json:"preferencesUpdatedAt,omitempty"`
	Metadata             map[string]discoveryMetadata `json:"metadata,omitempty"`
	Matches              map[string]discoveryMatch    `json:"matches,omitempty"`
}

type discoveryMetadata struct {
	Titles    []tmdbTitle `json:"titles"`
	FetchedAt time.Time   `json:"fetchedAt"`
}

// Identity survives listing expiry. CheckedAt and Revision describe the last
// availability check, including an unsuccessful search when ItemID is empty.
type discoveryMatch struct {
	ItemID, Name                string
	Year, TMDBID                int
	CheckedAt, Revision, Policy time.Time
}

type discoveryService struct {
	mu                  sync.Mutex
	wg                  sync.WaitGroup
	closed, refreshing  bool
	record              discoveryRecord
	client, imageClient *http.Client
}

func (s *Server) initDiscovery() error {
	d := &discoveryService{client: &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 || req.URL.Scheme != "https" || req.URL.Host != "api.themoviedb.org" {
				return errors.New("invalid metadata redirect")
			}
			return nil
		},
	}, imageClient: &http.Client{
		Timeout: 12 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 || req.URL.Scheme != "https" || req.URL.Host != "image.tmdb.org" || !strings.HasPrefix(req.URL.Path, "/t/p/") {
				return errors.New("invalid metadata image redirect")
			}
			return nil
		},
	}}
	var data []byte
	err := s.cache.db.QueryRow(`SELECT data FROM discovery WHERE id=1`).Scan(&data)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		// A corrupt or old discovery snapshot is safely rebuilt; playback records
		// and the library cache are independent of this optional feature.
		if json.Unmarshal(data, &d.record) != nil || d.record.Version != 1 {
			d.record = discoveryRecord{}
		}
	}
	s.discoveryService = d
	return nil
}

func (s *Server) tmdbConfigured() bool {
	return s.cfg.TMDBReadAccessToken != ""
}

func (s *Server) discover(w http.ResponseWriter, r *http.Request) {
	revision := s.cache.libraryRevision()
	s.queueDiscovery(revision)
	d := s.discoveryService
	d.mu.Lock()
	saved, refreshing := d.record, d.refreshing
	d.mu.Unlock()
	result := discoveryResponse{
		Configured: s.tmdbConfigured(), Refreshing: refreshing,
		TrendingMovies: []DiscoveryTitle{}, TrendingSeries: []DiscoveryTitle{},
		ExploreMovies: []DiscoveryTitle{}, ExploreSeries: []DiscoveryTitle{},
	}
	if saved.Version == 1 {
		if !saved.UpdatedAt.IsZero() {
			result.UpdatedAt = &saved.UpdatedAt
		}
		result.Error = saved.Error
		if result.Configured {
			result.TrendingMovies = s.availableDiscovery(saved.Movies)
			result.TrendingSeries = s.availableDiscovery(saved.Series)
		}
		result.ExploreMovies = s.availableDiscovery(saved.ExploreMovies)
		result.ExploreSeries = s.availableDiscovery(saved.ExploreSeries)
	}
	respond(w, 200, result)
}

func (s *Server) availableDiscovery(values []DiscoveryTitle) []DiscoveryTitle {
	policy := s.preferencesSnapshot()
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	result := make([]DiscoveryTitle, 0, len(values))
	for _, v := range values {
		item, exists := s.cache.byID[v.Item.ID]
		if !exists || item.Kind != v.Item.Kind {
			continue
		}
		category := s.itemPreferenceLocked(item, policy)
		if category.Visibility != "show" || !category.Dashboard {
			continue
		}
		if v.TMDBID != 0 && (!sameDiscoveryIdentity(v.Item, item) || item.TMDBID != 0 && item.TMDBID != v.TMDBID) {
			continue
		}
		v.Item = publicItems([]model.Item{item})[0]
		result = append(result, v)
	}
	return result
}

func mergeDiscovery(primary, secondary []DiscoveryTitle) []DiscoveryTitle {
	seen := map[string]bool{}
	result := make([]DiscoveryTitle, 0, discoveryLimit)
	for _, values := range [][]DiscoveryTitle{primary, secondary} {
		for _, v := range values {
			if !seen[v.Item.ID] && len(result) < discoveryLimit {
				seen[v.Item.ID] = true
				result = append(result, v)
			}
		}
	}
	return result
}

func providerDiscovery(items []model.Item, kind string) []DiscoveryTitle {
	values := make([]DiscoveryTitle, 0, discoveryLimit)
	seen := map[string]bool{}
	groups := map[string][]model.Item{}
	order := []string{}
	for _, item := range items {
		if item.Kind == kind {
			key := item.CategoryID
			if key == "" {
				key = item.Category
			}
			if _, exists := groups[key]; !exists {
				order = append(order, key)
			}
			groups[key] = append(groups[key], item)
		}
	}
	for row := 0; len(values) < discoveryLimit; row++ {
		more := false
		for _, category := range order {
			if row >= len(groups[category]) {
				continue
			}
			more = true
			item := groups[category][row]
			name, year := discoveryName(item)
			key := name + ":" + strconv.Itoa(year)
			if seen[key] || len(values) == discoveryLimit {
				continue
			}
			seen[key] = true
			public := publicItems([]model.Item{item})[0]
			values = append(values, DiscoveryTitle{Item: public, Name: discoveryLabel(item), Overview: item.Description, Poster: public.Image, Year: year})
		}
		if !more {
			break
		}
	}
	return values
}

// Fresh browse pages are evidence for new matches and availability checks.
// Saved rail entries are served separately, even while these pages are stale.
func (s *Server) discoveryCandidates() ([]model.Item, error) {
	policy := s.preferencesSnapshot()
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	ttl := s.refreshInterval(true)
	if ttl <= 0 {
		ttl = 24 * time.Hour
	}
	rows, err := s.cache.db.Query(`SELECT data FROM pages WHERE fetched_at>=? ORDER BY kind,search,category,page LIMIT 160`, time.Now().Add(-ttl).UnixNano())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	items := []model.Item{}
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return nil, err
		}
		page, err := decodePage(data)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			if (item.Kind == "movie" || item.Kind == "series") && !seen[item.ID] {
				category := s.itemPreferenceLocked(item, policy)
				if category.Visibility != "show" || !category.Dashboard {
					continue
				}
				seen[item.ID] = true
				items = append(items, item)
			}
		}
	}
	return items, rows.Err()
}

func (s *Server) queueDiscovery(revision time.Time) {
	if s.provider == nil {
		return
	}
	policy := s.preferencesSnapshot().updatedAt
	d := s.discoveryService
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.refreshing {
		return
	}
	record := d.record
	if record.Version == 1 && record.Revision.Equal(revision) && record.PreferencesUpdatedAt.Equal(policy) && record.HadMetadata == s.tmdbConfigured() && time.Now().Before(record.NextAttempt) {
		return
	}
	d.refreshing = true
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		defer func() {
			d.mu.Lock()
			d.refreshing = false
			d.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(s.ctx, 3*time.Minute)
		defer cancel()
		loaded, err := s.buildDiscovery(ctx, revision)
		if !s.cache.libraryRevision().Equal(revision) || !loaded.PreferencesUpdatedAt.Equal(s.preferencesSnapshot().updatedAt) || s.ctx.Err() != nil {
			return
		}
		if err != nil {
			loaded.Error = "Discovery refresh could not finish. Showing saved available titles."
			loaded.NextAttempt = time.Now().Add(5 * time.Minute)
		} else {
			loaded.UpdatedAt = time.Now().UTC()
			loaded.NextAttempt = time.Now().Add(s.discoveryRefreshInterval())
			for kind, metadata := range loaded.Metadata {
				if s.tmdbConfigured() && len(s.discoveryCategories(kind)) > 0 {
					loaded.NextAttempt = minTime(loaded.NextAttempt, metadata.FetchedAt.Add(s.discoveryRefreshInterval()))
				}
			}
		}
		_ = s.publishDiscovery(loaded)
	}()
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// Published records are immutable. Persist partial results too, so a slow
// provider or a restart cannot erase matches already found by this refresh.
func (s *Server) publishDiscovery(record discoveryRecord) error {
	record.Movies, record.Series = slices.Clone(record.Movies), slices.Clone(record.Series)
	record.Assets = maps.Clone(record.Assets)
	record.Metadata, record.Matches = maps.Clone(record.Metadata), maps.Clone(record.Matches)
	pruneDiscoveryAssets(&record)
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	policy := s.preferencesSnapshot().updatedAt
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	if !record.Revision.Equal(s.cache.libraryRefreshedAt) || !record.PreferencesUpdatedAt.Equal(policy) || s.ctx.Err() != nil {
		return errCacheChanged
	}
	d := s.discoveryService
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return context.Canceled
	}
	if _, err = s.cache.db.Exec(`INSERT INTO discovery(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, data); err == nil {
		d.record = record
	}
	return err
}

func (s *Server) discoveryBrowse(ctx context.Context, kind, search string, revision time.Time) (model.BrowsePage, error) {
	categories := s.discoveryCategories(kind)
	if len(categories) == 0 {
		return model.BrowsePage{Items: []model.Item{}, Page: 1}, nil
	}
	return s.discoveryBrowseCategory(ctx, kind, categories[0], search, revision)
}

func (s *Server) discoveryBrowseCategory(ctx context.Context, kind, categoryID, search string, revision time.Time) (model.BrowsePage, error) {
	p, ok := s.provider.(model.BrowseProvider)
	if !ok {
		return model.BrowsePage{}, errors.New("provider has no browse API")
	}
	policy := s.categoryPolicy(kind, categoryID)
	if policy.Visibility != "show" || !policy.Dashboard || categoryID == "*" && !containsCategory(s.discoveryCategories(kind), "*") {
		return model.BrowsePage{Items: []model.Item{}, Page: 1}, nil
	}
	q := model.BrowseQuery{Kind: kind, Category: categoryID, Search: search, Page: 1}
	s.cache.mu.RLock()
	q.SourceType = s.cache.browseSourceTypeLocked(q)
	seriesCategory := ""
	englishSeriesCategory := ""
	for _, category := range s.cache.categories {
		if category.Kind == kind && kind == "series" && (q.Category == "*" || q.Category == category.ID) {
			if seriesCategory == "" {
				seriesCategory = category.ID
			}
			if englishSeriesCategory == "" && strings.Contains(strings.ToLower(category.Name), "english") {
				englishSeriesCategory = category.ID
			}
		}
	}
	s.cache.mu.RUnlock()
	// Mirrored VOD portals return mixed movies/shows for category=*. A known
	// series category makes the single Explore page useful without walking
	// through movie pages. Searches still cover the whole provider catalogue.
	if kind == "series" && search == "" && q.SourceType == "vod" && q.Category == "*" {
		if englishSeriesCategory != "" {
			q.Category = englishSeriesCategory
		} else if seriesCategory != "" {
			q.Category = seriesCategory
		}
	}
	s.cache.mu.RLock()
	q.SourceType = s.cache.browseSourceTypeLocked(q)
	s.cache.mu.RUnlock()
	// Home rebuilds already run in the background; wait for fresh availability
	// before publishing a replacement discovery snapshot.
	if err := s.refreshBrowsePage(ctx, p, q); err != nil {
		return model.BrowsePage{}, err
	}
	page, _, err := s.cache.browseSnapshot(q, s.refreshInterval(true))
	if err != nil {
		return model.BrowsePage{}, err
	}
	if !s.cache.libraryRevision().Equal(revision) {
		return model.BrowsePage{}, errCacheChanged
	}
	page.Items = s.visibleItems(page.Items, true)
	return page, nil
}

type tmdbTitle struct {
	ID            int     `json:"id"`
	Title         string  `json:"title"`
	Name          string  `json:"name"`
	OriginalName  string  `json:"original_name"`
	OriginalTitle string  `json:"original_title"`
	Overview      string  `json:"overview"`
	Poster        string  `json:"poster_path"`
	Backdrop      string  `json:"backdrop_path"`
	ReleaseDate   string  `json:"release_date"`
	FirstAirDate  string  `json:"first_air_date"`
	Rating        float64 `json:"vote_average"`
	Adult         bool    `json:"adult"`
}

func (m tmdbTitle) name() string {
	if m.Title != "" {
		return m.Title
	}
	return m.Name
}

func (m tmdbTitle) releaseDate() string {
	if m.ReleaseDate != "" {
		return m.ReleaseDate
	}
	return m.FirstAirDate
}

func (m tmdbTitle) year() int {
	date := m.releaseDate()
	if len(date) < 4 {
		return 0
	}
	year, _ := strconv.Atoi(date[:4])
	return year
}

func (s *Server) tmdbList(ctx context.Context, path string, query url.Values) ([]tmdbTitle, error) {
	if query == nil {
		query = url.Values{}
	}
	query.Set("language", "en-US")
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.themoviedb.org/3/"+path+"?"+query.Encode(), nil)
	if err != nil {
		return nil, errors.New("metadata request could not be created")
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.TMDBReadAccessToken)
	req.Header.Set("Accept", "application/json")
	res, err := s.discoveryService.client.Do(req)
	if err != nil {
		// HTTP transport errors can contain sensitive request details. Never
		// retain or expose that error text.
		return nil, errors.New("metadata request failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("metadata service returned HTTP %d", res.StatusCode)
	}
	var result struct {
		Results []tmdbTitle `json:"results"`
	}
	decoder := json.NewDecoder(io.LimitReader(res.Body, 2<<20))
	if decoder.Decode(&result) != nil {
		return nil, errors.New("metadata response was invalid")
	}
	return result.Results, nil
}

func (s *Server) buildDiscovery(ctx context.Context, revision time.Time) (discoveryRecord, error) {
	d := s.discoveryService
	d.mu.Lock()
	record := d.record
	d.mu.Unlock()
	previous := record
	record.Version, record.Revision, record.HadMetadata = 1, revision, s.tmdbConfigured()
	record.PreferencesUpdatedAt = s.preferencesSnapshot().updatedAt
	record.Error, record.NextAttempt = "", time.Time{}
	record.Movies, record.Series = slices.Clone(record.Movies), slices.Clone(record.Series)
	record.Assets = cloneDiscoveryMap(record.Assets)
	record.Metadata, record.Matches = cloneDiscoveryMap(record.Metadata), cloneDiscoveryMap(record.Matches)
	s.restoreDiscoveryMatches(&record, previous)
	if !record.HadMetadata {
		record.Movies, record.Series = nil, nil
	}
	// Reuse local artwork immediately; only the background builder scans pages.
	items, err := s.discoveryCandidates()
	if err != nil {
		return record, err
	}
	record.ExploreMovies = mergeDiscovery(providerDiscovery(items, "movie"), record.ExploreMovies)
	record.ExploreSeries = mergeDiscovery(providerDiscovery(items, "series"), record.ExploreSeries)
	if err = s.publishDiscovery(record); err != nil {
		return record, err
	}
	var firstErr error
	for _, kind := range []string{"movie", "series"} {
		for _, category := range s.discoveryCategories(kind) {
			if _, err := s.discoveryBrowseCategory(ctx, kind, category, "", revision); err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	items, err = s.discoveryCandidates()
	if err != nil {
		return record, err
	}
	record.ExploreMovies = mergeDiscovery(providerDiscovery(items, "movie"), record.ExploreMovies)
	record.ExploreSeries = mergeDiscovery(providerDiscovery(items, "series"), record.ExploreSeries)
	if err = s.publishDiscovery(record); err != nil {
		return record, err
	}
	if !record.HadMetadata {
		return record, firstErr
	}
	fresh := make(map[string]model.Item, len(items))
	for _, item := range items {
		fresh[item.ID] = item
	}
	budget := discoverySearchBudget
	for _, kind := range []string{"movie", "series"} {
		categories := s.discoveryCategories(kind)
		if len(categories) == 0 {
			continue
		}
		kindBudget := min(budget, discoverySearchBudget/2)
		mediaType := "movie"
		if kind == "series" {
			mediaType = "tv"
		}
		trends, err := s.discoveryTrends(ctx, &record, kind, mediaType)
		if err != nil {
			return record, err
		}
		values := &record.Movies
		if kind == "series" {
			values = &record.Series
		}
		*values = progressiveDiscovery(*values, trends)
		if err = s.publishDiscovery(record); err != nil {
			return record, err
		}
		for _, title := range trends {
			if ctx.Err() != nil || !s.cache.libraryRevision().Equal(revision) {
				return record, errCacheChanged
			}
			key := discoveryMatchKey(kind, title.ID)
			link, known := record.Matches[key]
			if known && link.ItemID == "" && link.Revision.Equal(revision) && link.Policy.Equal(record.PreferencesUpdatedAt) && time.Since(link.CheckedAt) < s.discoveryRefreshInterval() {
				continue
			}
			matches := []model.Item{}
			if item, exists := fresh[link.ItemID]; known && exists && item.Kind == kind && link.matches(item) {
				matches = append(matches, item)
			}
			if len(matches) == 0 {
				matches = discoveryMatches(items, kind, title)
			}
			searched, exhaustive := 0, true
			if len(matches) == 0 {
				for _, category := range categories {
					if kindBudget <= 0 || budget <= 0 {
						exhaustive = false
						break
					}
					kindBudget--
					budget--
					page, err := s.discoveryBrowseCategory(ctx, kind, category, title.name(), revision)
					if err != nil {
						return record, err
					}
					searched++
					exhaustive = exhaustive && !page.HasMore
					items = append(items, page.Items...)
					for _, item := range page.Items {
						fresh[item.ID] = item
					}
					matches = discoveryMatches(items, kind, title)
					if len(matches) > 0 {
						break
					}
				}
			}
			if len(matches) == 0 {
				// An incomplete or skipped search cannot prove a cached title gone.
				if exhaustive && searched == len(categories) {
					record.Matches[key] = discoveryMatch{CheckedAt: time.Now(), Revision: revision, Policy: record.PreferencesUpdatedAt}
					*values = slices.DeleteFunc(*values, func(v DiscoveryTitle) bool { return v.TMDBID == title.ID })
					record.ExploreMovies = removeDiscoveryItem(record.ExploreMovies, link.ItemID)
					record.ExploreSeries = removeDiscoveryItem(record.ExploreSeries, link.ItemID)
					if err = s.publishDiscovery(record); err != nil {
						return record, err
					}
				}
				continue
			}
			confirmed := known && link.ItemID == matches[0].ID && link.matches(matches[0])
			if !confirmed && matches[0].TMDBID == 0 && discoveryMatchYear(matches[0], title) == 0 {
				identities, err := s.tmdbList(ctx, "search/"+mediaType, url.Values{"query": {title.name()}, "include_adult": {"false"}})
				if err != nil {
					return record, err
				}
				if !uniqueDiscoveryIdentity(title, identities) {
					record.Matches[key] = discoveryMatch{CheckedAt: time.Now(), Revision: revision, Policy: record.PreferencesUpdatedAt}
					*values = slices.DeleteFunc(*values, func(v DiscoveryTitle) bool { return v.TMDBID == title.ID })
					continue
				}
			}
			record.Matches[key] = newDiscoveryMatch(matches[0], time.Now(), revision, record.PreferencesUpdatedAt)
			value := record.metadataTitle(matches[0], title)
			*values = progressiveDiscovery(append(slices.DeleteFunc(*values, func(v DiscoveryTitle) bool { return v.TMDBID == title.ID }), value), trends)
			if err = s.publishDiscovery(record); err != nil {
				return record, err
			}
		}
		*values = rankedDiscovery(*values, trends)
		if err = s.publishDiscovery(record); err != nil {
			return record, err
		}
	}
	pruneDiscoveryMatches(&record)
	return record, firstErr
}

var discoveryYearRE = regexp.MustCompile(`(?:\(|\[|\s)((?:19|20)\d{2})(?:\)|\]|\s|$)`)
var discoveryQualityRE = regexp.MustCompile(`(?i)(?:\s*[-|:]\s*|\s+)[\[(]?(?:4k|uhd|fhd|hd|sd|1080p|720p|2160p|bluray|blu-ray|web-dl|webrip)[\])]?\s*$`)

func discoveryLabel(item model.Item) string {
	name := strings.TrimSpace(item.Name)
	// Categories are provider navigation, not part of the programme identity.
	// Strip only an exact category suffix, rather than arbitrary title words.
	for {
		previous := name
		if category := strings.TrimSpace(item.Category); category != "" {
			for _, separator := range []string{" - ", " | ", " : "} {
				suffix := separator + category
				if strings.HasSuffix(strings.ToLower(name), strings.ToLower(suffix)) {
					name = strings.TrimSpace(name[:len(name)-len(suffix)])
				}
			}
		}
		name = strings.TrimSpace(discoveryQualityRE.ReplaceAllString(name, ""))
		if previous == name {
			break
		}
	}
	return name
}

func discoveryName(item model.Item) (string, int) {
	name, year := discoveryLabel(item), item.Year
	if matches := discoveryYearRE.FindStringSubmatchIndex(name); len(matches) == 4 {
		parsed, _ := strconv.Atoi(name[matches[2]:matches[3]])
		if year == 0 {
			year = parsed
		}
		name = name[:matches[0]] + " " + name[matches[1]:]
	}
	return normalizeDiscoveryName(name), year
}

func normalizeDiscoveryName(name string) string {
	return strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return ' '
	}, name)), " ")
}

func discoveryTitleNames(title tmdbTitle) map[string]bool {
	names := map[string]bool{normalizeDiscoveryName(title.name()): true}
	for _, name := range []string{title.OriginalName, title.OriginalTitle} {
		if name != "" {
			names[normalizeDiscoveryName(name)] = true
		}
	}
	return names
}

func discoveryMatchYear(item model.Item, title tmdbTitle) int {
	if discoveryTitleNames(title)[normalizeDiscoveryName(discoveryLabel(item))] {
		return item.Year
	}
	_, year := discoveryName(item)
	return year
}

func discoveryMatches(items []model.Item, kind string, title tmdbTitle) []model.Item {
	names := discoveryTitleNames(title)
	seen := map[string]bool{}
	matches := []model.Item{}
	for _, item := range items {
		if item.Kind != kind || seen[item.ID] || item.TMDBID != 0 && item.TMDBID != title.ID {
			continue
		}
		name, _ := discoveryName(item)
		year := discoveryMatchYear(item, title)
		// A year-like number can be part of the real title (Class of 1999,
		// Blade Runner 2049). An exact full title wins over suffix inference.
		if fullName := normalizeDiscoveryName(discoveryLabel(item)); names[fullName] {
			name = fullName
		}
		if item.TMDBID != title.ID && !names[name] || year != 0 && title.year() != 0 && year != title.year() {
			continue
		}
		seen[item.ID] = true
		matches = append(matches, item)
	}
	sort.Slice(matches, func(i, j int) bool {
		if (matches[i].TMDBID != 0) != (matches[j].TMDBID != 0) {
			return matches[i].TMDBID != 0
		}
		firstYear := discoveryMatchYear(matches[i], title)
		secondYear := discoveryMatchYear(matches[j], title)
		if (firstYear != 0) != (secondYear != 0) {
			return firstYear != 0
		}
		return matches[i].ID < matches[j].ID
	})
	return matches
}

func uniqueDiscoveryIdentity(title tmdbTitle, identities []tmdbTitle) bool {
	// A full search page could hide another remake on a later page. Omit that
	// unqualified provider listing rather than claim an unverified identity.
	if len(identities) >= 20 {
		return false
	}
	name := normalizeDiscoveryName(title.name())
	ids := map[int]bool{}
	for _, identity := range identities {
		if normalizeDiscoveryName(identity.name()) == name && identity.ID > 0 {
			ids[identity.ID] = true
		}
	}
	return len(ids) == 1 && ids[title.ID]
}

var discoveryImagePathRE = regexp.MustCompile(`^/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$`)

func (r *discoveryRecord) metadataTitle(item model.Item, title tmdbTitle) DiscoveryTitle {
	value := DiscoveryTitle{TMDBID: title.ID, Item: publicItems([]model.Item{item})[0], Name: title.name(), Overview: title.Overview, ReleaseDate: title.releaseDate(), Year: title.year(), Rating: title.Rating}
	asset := discoveryAsset{ItemID: item.ID}
	if discoveryImagePathRE.MatchString(title.Poster) {
		asset.Poster = title.Poster
	}
	if discoveryImagePathRE.MatchString(title.Backdrop) {
		asset.Backdrop = title.Backdrop
	}
	if asset.Poster != "" || asset.Backdrop != "" {
		sum := sha256.Sum256([]byte(item.Kind + ":" + strconv.Itoa(title.ID) + ":" + asset.Poster + ":" + asset.Backdrop))
		id := hex.EncodeToString(sum[:12])
		r.Assets[id] = asset
		if asset.Poster != "" {
			value.Poster = "/api/discovery/images/" + id + "/poster"
		}
		if asset.Backdrop != "" {
			value.Backdrop = "/api/discovery/images/" + id + "/backdrop"
		}
	}
	return value
}

func (s *Server) discoveryImage(w http.ResponseWriter, r *http.Request) {
	d := s.discoveryService
	d.mu.Lock()
	asset, exists := d.record.Assets[r.PathValue("id")]
	if asset.ItemID == "" {
		for _, titles := range [][]DiscoveryTitle{d.record.Movies, d.record.Series, d.record.ExploreMovies, d.record.ExploreSeries} {
			for _, title := range titles {
				prefix := "/api/discovery/images/" + r.PathValue("id") + "/"
				if strings.HasPrefix(title.Poster, prefix) || strings.HasPrefix(title.Backdrop, prefix) {
					asset.ItemID = title.Item.ID
				}
			}
		}
	}
	d.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	item, known := s.cache.item(asset.ItemID)
	if known && s.blockedItem(item) || !known && s.preferencesSnapshot().blocked {
		blocked(w)
		return
	}
	path, size := "", "w500"
	switch r.PathValue("type") {
	case "poster":
		path = asset.Poster
	case "backdrop":
		path, size = asset.Backdrop, "w1280"
	}
	if !discoveryImagePathRE.MatchString(path) {
		http.NotFound(w, r)
		return
	}
	key := "https://image.tmdb.org/t/p/" + size + path
	if cached, ok := s.imageCache.Get(key); ok {
		writeImage(w, cached, s.imageFailureTTL)
		return
	}
	value, _, _ := s.imageFlights.Do(key, func() (any, error) {
		if cached, ok := s.imageCache.Get(key); ok {
			return cached, nil
		}
		image, err := s.fetchDiscoveryImage(key)
		ttl := imageCacheTTL
		if err != nil {
			image, ttl = fallbackArtwork, s.imageFailureTTL
		}
		s.imageCache.SetWithTTL(key, image, int64(len(image.data)), ttl)
		s.imageCache.Wait()
		return image, nil
	})
	d.mu.Lock()
	_, exists = d.record.Assets[r.PathValue("id")]
	d.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	item, known = s.cache.item(asset.ItemID)
	if known && s.blockedItem(item) || !known && s.preferencesSnapshot().blocked {
		blocked(w)
		return
	}
	writeImage(w, value.(imageData), s.imageFailureTTL)
}

func (s *Server) fetchDiscoveryImage(uri string) (imageData, error) {
	req, err := http.NewRequestWithContext(s.ctx, "GET", uri, nil)
	if err != nil {
		return imageData{}, err
	}
	res, err := s.discoveryService.imageClient.Do(req)
	if err != nil {
		return imageData{}, errors.New("metadata image unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return imageData{}, errors.New("metadata image unavailable")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, (5<<20)+1))
	if err != nil || len(data) > 5<<20 {
		return imageData{}, errors.New("metadata image invalid")
	}
	mime := http.DetectContentType(data)
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif":
		return imageData{data: data, mime: mime}, nil
	default:
		return imageData{}, errors.New("metadata image invalid")
	}
}
