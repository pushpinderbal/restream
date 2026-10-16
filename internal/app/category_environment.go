package app

import (
	"encoding/csv"
	"fmt"
	"io"
	"sort"
	"strings"
)

type categorySelector struct{ kind, value, display string }

type categoryEnvironment struct {
	dashboard, blocked []categorySelector
}

func parseCategorySelectors(name, value string) ([]categorySelector, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	r := csv.NewReader(strings.NewReader(value))
	r.TrimLeadingSpace = true
	values, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("%s must be a comma-separated list of category names or IDs", name)
	}
	if _, err := r.Read(); err != io.EOF {
		return nil, fmt.Errorf("%s must contain a single comma-separated list", name)
	}
	if len(values) > 5000 {
		return nil, fmt.Errorf("%s contains too many categories", name)
	}
	var result []categorySelector
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		selector := categorySelector{value: strings.ToLower(value), display: value}
		if kind, category, ok := strings.Cut(selector.value, ":"); ok && (kind == "live" || kind == "movie" || kind == "series") {
			selector.kind, selector.value = kind, strings.TrimSpace(category)
			if selector.value == "" {
				return nil, fmt.Errorf("%s requires a category after %s:", name, kind)
			}
		}
		result = append(result, selector)
	}
	return result, nil
}

func matchesCategory(selectors []categorySelector, kind, id, name string) bool {
	id, name = strings.ToLower(id), strings.ToLower(strings.TrimSpace(name))
	for _, selector := range selectors {
		if (selector.kind == "" || selector.kind == kind) && (selector.value == "*" || selector.value == id || name != "" && selector.value == name) {
			return true
		}
	}
	return false
}

func (e categoryEnvironment) dashboardManaged() bool { return len(e.dashboard) > 0 }
func (e categoryEnvironment) configured() bool       { return e.dashboardManaged() || len(e.blocked) > 0 }

func (e categoryEnvironment) blocksKind(kind string) bool {
	for _, selector := range e.blocked {
		if selector.kind == "" || selector.kind == kind {
			return true
		}
	}
	return false
}

type categoryConfiguration struct {
	DashboardCategories []string `json:"dashboardCategories"`
	BlockedCategories   []string `json:"blockedCategories"`
}

func selectorLabels(selectors []categorySelector) []string {
	result := make([]string, 0, len(selectors))
	for _, selector := range selectors {
		label := selector.display
		if label == "" {
			label = selector.value
			if selector.kind != "" {
				label = selector.kind + ":" + label
			}
		}
		result = append(result, label)
	}
	return result
}

func (e categoryEnvironment) configuration() categoryConfiguration {
	return categoryConfiguration{selectorLabels(e.dashboard), selectorLabels(e.blocked)}
}

type preferenceResponse struct {
	Preferences
	Configuration categoryConfiguration `json:"configuration"`
}

func (s *Server) effectivePreferences(p *preferenceSnapshot) preferenceResponse {
	response := preferenceResponse{Preferences: p.value, Configuration: p.environment.configuration()}
	if !p.environment.configured() {
		return response
	}
	response.Categories = []CategoryPreference{}
	s.cache.mu.RLock()
	for _, category := range s.cache.categories {
		if category.ID == "" || category.ID == "*" {
			continue
		}
		policy := p.category(category.Kind, category.ID, category.Name)
		if policy.Visibility != "show" || !policy.Dashboard {
			response.Categories = append(response.Categories, policy)
		}
	}
	s.cache.mu.RUnlock()
	sort.Slice(response.Categories, func(i, j int) bool {
		return categoryPreferenceKey(response.Categories[i].Kind, response.Categories[i].ID) < categoryPreferenceKey(response.Categories[j].Kind, response.Categories[j].ID)
	})
	return response
}

func (s *Server) categoryPolicy(kind, id string) CategoryPreference {
	p := s.preferencesSnapshot()
	s.cache.mu.RLock()
	defer s.cache.mu.RUnlock()
	for _, category := range s.cache.categories {
		if category.Kind == kind && strings.EqualFold(category.ID, id) {
			return p.category(kind, id, category.Name)
		}
	}
	return p.category(kind, id)
}
