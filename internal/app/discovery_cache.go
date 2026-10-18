package app

import (
	"context"
	"maps"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pushpinderbal/restream/internal/model"
)

func cloneDiscoveryMap[K comparable, V any](values map[K]V) map[K]V {
	if values == nil {
		return make(map[K]V)
	}
	return maps.Clone(values)
}

func discoveryMatchKey(kind string, id int) string {
	return kind + ":" + strconv.Itoa(id)
}

func newDiscoveryMatch(item model.Item, checked, revision, policy time.Time) discoveryMatch {
	name, year := discoveryName(item)
	return discoveryMatch{ItemID: item.ID, Name: name, Year: year, TMDBID: item.TMDBID, CheckedAt: checked, Revision: revision, Policy: policy}
}

func (m discoveryMatch) matches(item model.Item) bool {
	name, year := discoveryName(item)
	return m.ItemID == item.ID && m.Name == name && (m.Year == 0 || year == 0 || m.Year == year) && m.TMDBID == item.TMDBID
}

func sameDiscoveryIdentity(a, b model.Item) bool {
	if a.ID != b.ID || a.Kind != b.Kind {
		return false
	}
	if a.Name == b.Name && a.Year == b.Year {
		return true
	}
	firstName, firstYear := discoveryName(a)
	secondName, secondYear := discoveryName(b)
	return firstName == secondName && (firstYear == 0 || secondYear == 0 || firstYear == secondYear)
}

// Existing confirmed rail entries also seed the independent identity cache.
func (s *Server) restoreDiscoveryMatches(record *discoveryRecord, previous discoveryRecord) {
	for _, values := range [][]DiscoveryTitle{previous.Movies, previous.Series} {
		for _, title := range values {
			key := discoveryMatchKey(title.Item.Kind, title.TMDBID)
			if _, exists := record.Matches[key]; exists || title.TMDBID == 0 {
				continue
			}
			item, exists := s.cache.item(title.Item.ID)
			if exists && sameDiscoveryIdentity(item, title.Item) && (item.TMDBID == 0 || item.TMDBID == title.TMDBID) {
				record.Matches[key] = newDiscoveryMatch(item, previous.UpdatedAt, previous.Revision, previous.PreferencesUpdatedAt)
			}
		}
	}
}

func (s *Server) discoveryTrends(ctx context.Context, record *discoveryRecord, kind, mediaType string, continuing bool) ([]tmdbTitle, error) {
	metadata, exists := record.Metadata[kind]
	if !exists || metadata.FetchedAt.IsZero() || !continuing && time.Since(metadata.FetchedAt) >= s.discoveryRefreshInterval() {
		titles, err := s.tmdbList(ctx, "trending/"+mediaType+"/week", nil)
		if err != nil {
			return nil, err
		}
		metadata = discoveryMetadata{Titles: slices.Clone(titles), FetchedAt: time.Now().UTC()}
		record.Metadata[kind] = metadata
		record.Cursors[kind] = 0
	}
	trends := []tmdbTitle{}
	seen := map[int]bool{}
	for _, title := range metadata.Titles[:min(len(metadata.Titles), discoveryTrendCandidates)] {
		if title.ID > 0 && !title.Adult && title.name() != "" && !seen[title.ID] {
			seen[title.ID] = true
			trends = append(trends, title)
		}
	}
	return trends, nil
}

func rankedDiscovery(values []DiscoveryTitle, trends []tmdbTitle) []DiscoveryTitle {
	byID := make(map[int]DiscoveryTitle, len(values))
	for _, value := range values {
		byID[value.TMDBID] = value
	}
	result := make([]DiscoveryTitle, 0, len(trends))
	for _, title := range trends {
		if value, exists := byID[title.ID]; exists {
			result = append(result, value)
		}
	}
	return result
}

// Keep the previous rail behind newly confirmed matches until this kind's
// replacement finishes, even when the TMDB list has completely changed.
func progressiveDiscovery(values []DiscoveryTitle, trends []tmdbTitle) []DiscoveryTitle {
	result := rankedDiscovery(values, trends)
	seen := map[int]bool{}
	for _, value := range result {
		seen[value.TMDBID] = true
	}
	for _, value := range values {
		if !seen[value.TMDBID] && len(result) < discoveryLimit {
			seen[value.TMDBID] = true
			result = append(result, value)
		}
	}
	return result
}

func removeDiscoveryItem(values []DiscoveryTitle, id string) []DiscoveryTitle {
	return slices.DeleteFunc(slices.Clone(values), func(v DiscoveryTitle) bool { return v.Item.ID == id })
}

func pruneDiscoveryAssets(record *discoveryRecord) {
	assets := map[string]discoveryAsset{}
	for _, values := range [][]DiscoveryTitle{record.Movies, record.Series, record.ExploreMovies, record.ExploreSeries} {
		for _, title := range values {
			for _, path := range []string{title.Poster, title.Backdrop} {
				if !strings.HasPrefix(path, "/api/discovery/images/") {
					continue
				}
				id, _, _ := strings.Cut(strings.TrimPrefix(path, "/api/discovery/images/"), "/")
				if asset, exists := record.Assets[id]; exists {
					assets[id] = asset
				}
			}
		}
	}
	record.Assets = assets
}

func pruneDiscoveryMatches(record *discoveryRecord) {
	// Retain older identities when they leave Trending, with a bounded disk cache.
	const limit = 256
	if len(record.Matches) <= limit {
		return
	}
	keys := slices.Collect(maps.Keys(record.Matches))
	sort.Slice(keys, func(i, j int) bool { return record.Matches[keys[i]].CheckedAt.After(record.Matches[keys[j]].CheckedAt) })
	for _, key := range keys[limit:] {
		delete(record.Matches, key)
	}
}
