package model

import (
	"context"
	"time"
)

type Item struct {
	ID          string  `json:"id"`
	Kind        string  `json:"kind"` // live, movie, series, episode
	Name        string  `json:"name"`
	Category    string  `json:"category"`
	CategoryID  string  `json:"categoryId,omitempty"`
	Logo        string  `json:"-"`
	Image       string  `json:"image,omitempty"` // populated by HTTP API with local image URL
	Number      string  `json:"number,omitempty"`
	Description string  `json:"description,omitempty"`
	Duration    float64 `json:"duration,omitempty"`
	Season      int     `json:"season,omitempty"`
	Episode     int     `json:"episode,omitempty"`
	Command     string  `json:"-"`
	ProviderID  string  `json:"-"`
	SeriesID    string  `json:"-"`
	EpisodeID   string  `json:"-"`
}

// Category is portal navigation metadata. SourceType records which MAG API
// serves the category, even when series are bundled into VOD.
type Category struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	SourceType string `json:"-"`
}

type BrowseQuery struct {
	Kind       string `json:"kind"`
	Category   string `json:"category,omitempty"`
	Search     string `json:"search,omitempty"`
	Page       int    `json:"page"`
	SourceType string `json:"-"`
}

type BrowsePage struct {
	Items   []Item `json:"items"`
	Page    int    `json:"page"`
	Total   int    `json:"total"`
	HasMore bool   `json:"hasMore"`
}

// BrowseProvider discovers categories without importing VOD and fetches one
// requested portal page at a time.
type BrowseProvider interface {
	Categories(context.Context) ([]Category, error)
	Browse(context.Context, BrowseQuery) (BrowsePage, error)
}

type Program struct {
	ChannelID   string    `json:"channelId"`
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Start       time.Time `json:"start"`
	End         time.Time `json:"end"`
}

type Source struct {
	URL      string
	Headers  map[string]string
	Live     bool
	Duration float64
}

type Provider interface {
	Catalog(context.Context) ([]Item, error)
	Episodes(context.Context, Item) ([]Item, error)
	EPG(context.Context) ([]Program, error)
	Resolve(context.Context, Item) (Source, error)
}

// PortalCooldownProvider is optional. It lets a provider apply a persisted
// portal deadline to every request and persist new deadlines as they arrive.
type PortalCooldownProvider interface {
	ConfigureCooldown(time.Time, func(time.Time) error)
}
