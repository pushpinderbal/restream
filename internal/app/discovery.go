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
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/pushpinderbal/restream/internal/model"
)

const discoveryTTL = 6 * time.Hour
const discoveryLimit = 18
const discoveryTrendCandidates = 12
const discoverySearchBudget = 18

// DiscoveryTitle always refers to a confirmed listing in this provider. The
// metadata identity is separate from its playback identity.
type DiscoveryTitle struct {
	TMDBID   int        `json:"tmdbId,omitempty"`
	Item     model.Item `json:"item"`
	Name     string     `json:"name"`
	Overview string     `json:"overview,omitempty"`
	Poster   string     `json:"poster,omitempty"`
	Backdrop string     `json:"backdrop,omitempty"`
	Year     int        `json:"year,omitempty"`
	Rating   float64    `json:"rating,omitempty"`
	Genres   []string   `json:"genres,omitempty"`
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
	Version              int                       `json:"version"`
	Revision             time.Time                 `json:"revision"`
	UpdatedAt            time.Time                 `json:"updatedAt"`
	NextAttempt          time.Time                 `json:"nextAttempt"`
	Error                string                    `json:"error,omitempty"`
	HadMetadata          bool                      `json:"hadMetadata"`
	Movies               []DiscoveryTitle          `json:"movies"`
	Series               []DiscoveryTitle          `json:"series"`
	ExploreMovies        []DiscoveryTitle          `json:"exploreMovies"`
	ExploreSeries        []DiscoveryTitle          `json:"exploreSeries"`
	Assets               map[string]discoveryAsset `json:"assets"`
	PreferencesUpdatedAt time.Time                 `json:"preferencesUpdatedAt,omitempty"`
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
	return s.cfg.TMDBReadAccessToken != "" || s.cfg.TMDBAPIKey != ""
}

func (s *Server) discover(w http.ResponseWriter, r *http.Request) {
	revision := s.cache.libraryRevision()
	items, err := s.discoveryCandidates()
	if err != nil {
		fail(w, 500, "cache", "Could not read saved discovery titles.")
		return
	}
	available := make(map[string]model.Item, len(items))
	for _, item := range items {
		available[item.ID] = item
	}
	s.queueDiscovery(revision)
	d := s.discoveryService
	d.mu.Lock()
	saved, refreshing := d.record, d.refreshing
	d.mu.Unlock()
	result := discoveryResponse{
		Configured: s.tmdbConfigured(), Refreshing: refreshing,
		TrendingMovies: []DiscoveryTitle{}, TrendingSeries: []DiscoveryTitle{},
		ExploreMovies: providerDiscovery(items, "movie"), ExploreSeries: providerDiscovery(items, "series"),
	}
	if saved.Revision.Equal(revision) && saved.Version == 1 {
		if !saved.UpdatedAt.IsZero() {
			result.UpdatedAt = &saved.UpdatedAt
		}
		result.Error = saved.Error
		result.TrendingMovies = availableDiscovery(saved.Movies, available)
		result.TrendingSeries = availableDiscovery(saved.Series, available)
		result.ExploreMovies = mergeDiscovery(availableDiscovery(saved.ExploreMovies, available), result.ExploreMovies)
		result.ExploreSeries = mergeDiscovery(availableDiscovery(saved.ExploreSeries, available), result.ExploreSeries)
	}
	respond(w, 200, result)
}

func availableDiscovery(values []DiscoveryTitle, available map[string]model.Item) []DiscoveryTitle {
	result := make([]DiscoveryTitle, 0, len(values))
	for _, v := range values {
		item, exists := available[v.Item.ID]
		if !exists || item.Kind != v.Item.Kind {
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

// Items retained for playback after a refresh are deliberately not evidence
// of current availability. Only current, unexpired browse pages count.
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
	d := s.discoveryService
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || d.refreshing {
		return
	}
	record := d.record
	if record.Version == 1 && record.Revision.Equal(revision) && record.PreferencesUpdatedAt.Equal(s.preferencesSnapshot().updatedAt) && record.HadMetadata == s.tmdbConfigured() && time.Now().Before(record.NextAttempt) {
		return
	}
	d.refreshing = true
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		ctx, cancel := context.WithTimeout(s.ctx, 3*time.Minute)
		defer cancel()
		loaded, err := s.buildDiscovery(ctx, revision)
		if !s.cache.libraryRevision().Equal(revision) || !loaded.PreferencesUpdatedAt.Equal(s.preferencesSnapshot().updatedAt) || s.ctx.Err() != nil {
			d.mu.Lock()
			d.refreshing = false
			d.mu.Unlock()
			return
		}
		d.mu.Lock()
		defer d.mu.Unlock()
		if err != nil {
			if record.Version == 1 && record.Revision.Equal(revision) {
				loaded = record
			}
			loaded.Version, loaded.Revision, loaded.HadMetadata = 1, revision, s.tmdbConfigured()
			loaded.PreferencesUpdatedAt = s.preferencesSnapshot().updatedAt
			loaded.Error = "Discovery refresh could not finish. Showing saved available titles."
			loaded.NextAttempt = time.Now().Add(5 * time.Minute)
		} else {
			loaded.NextAttempt = time.Now().Add(s.discoveryRefreshInterval())
		}
		// Coordinate the persisted snapshot with library invalidation. A refresh
		// cannot publish an old availability mapping into a newer revision.
		s.cache.mu.Lock()
		if s.cache.libraryRefreshedAt.Equal(revision) {
			data, marshalErr := json.Marshal(loaded)
			if marshalErr == nil {
				_, marshalErr = s.cache.db.Exec(`INSERT INTO discovery(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, data)
			}
			if marshalErr == nil {
				d.record = loaded
			}
		}
		s.cache.mu.Unlock()
		d.refreshing = false
	}()
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
	seriesCategory := ""
	englishSeriesCategory := ""
	for _, category := range s.cache.categories {
		if category.Kind == kind && kind == "series" && (q.Category == "*" || q.Category == category.ID) {
			if q.SourceType == "" {
				q.SourceType = category.SourceType
			}
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
	if page, found, err := s.cache.browse(q, s.refreshInterval(true)); err != nil || found {
		page.Items = s.visibleItems(page.Items, true)
		return page, err
	}
	key := q.Kind + "\x00" + q.Category + "\x00" + q.Search + "\x001\x00" + revision.Format(time.RFC3339Nano)
	value, err, _ := s.browseFlights.Do(key, func() (any, error) {
		if page, found, err := s.cache.browse(q, s.refreshInterval(true)); err != nil || found {
			return page, err
		}
		requestCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		policy := s.categoryPolicy(kind, q.Category)
		if policy.Visibility != "show" || !policy.Dashboard || q.Category == "*" && !containsCategory(s.discoveryCategories(kind), "*") {
			return model.BrowsePage{Items: []model.Item{}, Page: 1}, nil
		}
		page, err := p.Browse(requestCtx, q)
		if err != nil {
			return nil, err
		}
		if !s.cache.libraryRevision().Equal(revision) {
			return nil, errors.New("library changed during discovery")
		}
		s.cache.mu.RLock()
		names := map[string]string{}
		for _, category := range s.cache.categories {
			if category.Kind == kind {
				names[category.ID] = category.Name
			}
		}
		s.cache.mu.RUnlock()
		for i := range page.Items {
			if page.Items[i].CategoryID == "" && q.Category != "*" {
				page.Items[i].CategoryID = q.Category
			}
			if name := names[page.Items[i].CategoryID]; name != "" {
				page.Items[i].Category = name
			}
		}
		if err := s.cache.setBrowseAtRevision(q, page, s.refreshInterval(true), revision); err != nil {
			return nil, err
		}
		return page, nil
	})
	if err != nil {
		return model.BrowsePage{}, err
	}
	page := value.(model.BrowsePage)
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

func (m tmdbTitle) year() int {
	date := m.ReleaseDate
	if date == "" {
		date = m.FirstAirDate
	}
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
	if s.cfg.TMDBReadAccessToken == "" {
		query.Set("api_key", s.cfg.TMDBAPIKey)
	}
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.themoviedb.org/3/"+path+"?"+query.Encode(), nil)
	if err != nil {
		return nil, errors.New("metadata request could not be created")
	}
	if s.cfg.TMDBReadAccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.TMDBReadAccessToken)
	}
	req.Header.Set("Accept", "application/json")
	res, err := s.discoveryService.client.Do(req)
	if err != nil {
		// HTTP transport errors can contain the request URL, including an API
		// key. Never retain or expose that error text.
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
	record := discoveryRecord{Version: 1, Revision: revision, HadMetadata: s.tmdbConfigured(), Assets: map[string]discoveryAsset{}, PreferencesUpdatedAt: s.preferencesSnapshot().updatedAt}
	var firstErr error
	for _, kind := range []string{"movie", "series"} {
		if ctx.Err() != nil || !s.cache.libraryRevision().Equal(revision) {
			return record, errors.New("library changed during discovery")
		}
		for _, category := range s.discoveryCategories(kind) {
			if _, err := s.discoveryBrowseCategory(ctx, kind, category, "", revision); err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	items, err := s.discoveryCandidates()
	if err != nil {
		return record, err
	}
	record.ExploreMovies, record.ExploreSeries = providerDiscovery(items, "movie"), providerDiscovery(items, "series")
	if !s.tmdbConfigured() {
		record.UpdatedAt = time.Now().UTC()
		return record, firstErr
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
		trends, err := s.tmdbList(ctx, "trending/"+mediaType+"/week", nil)
		if err != nil {
			return record, err
		}
		if len(trends) > discoveryTrendCandidates {
			trends = trends[:discoveryTrendCandidates]
		}
		for _, title := range trends {
			if ctx.Err() != nil || !s.cache.libraryRevision().Equal(revision) {
				return record, errors.New("library changed during discovery")
			}
			if title.ID <= 0 || title.Adult || title.name() == "" {
				continue
			}
			matches := discoveryMatches(items, kind, title)
			if len(matches) == 0 {
				for _, category := range categories {
					if kindBudget <= 0 || budget <= 0 {
						break
					}
					kindBudget--
					budget--
					page, err := s.discoveryBrowseCategory(ctx, kind, category, title.name(), revision)
					if err != nil {
						return record, err
					}
					items = append(items, page.Items...)
					matches = discoveryMatches(items, kind, title)
					if len(matches) > 0 {
						break
					}
				}
			}
			if len(matches) == 0 {
				continue
			}
			// A provider title without a year or external ID could be a remake.
			// Resolve that ambiguity using exact metadata identities before it is
			// allowed onto the available-only dashboard.
			if matches[0].TMDBID == 0 {
				year := discoveryMatchYear(matches[0], title)
				if year == 0 {
					identities, err := s.tmdbList(ctx, "search/"+mediaType, url.Values{"query": {title.name()}, "include_adult": {"false"}})
					if err != nil {
						return record, err
					}
					if !uniqueDiscoveryIdentity(title, identities) {
						continue
					}
				}
			}
			value := record.metadataTitle(matches[0], title)
			if kind == "movie" {
				record.Movies = append(record.Movies, value)
			} else {
				record.Series = append(record.Series, value)
			}
		}
	}
	record.UpdatedAt = time.Now().UTC()
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
	value := DiscoveryTitle{TMDBID: title.ID, Item: publicItems([]model.Item{item})[0], Name: title.name(), Overview: title.Overview, Year: title.year(), Rating: title.Rating}
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
	revision := d.record.Revision
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
	if !exists || !s.cache.libraryRevision().Equal(revision) {
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
