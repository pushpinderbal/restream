package app

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"sort"
	"strings"
	"time"
)

type ProviderSettings struct {
	PortalURL    string `json:"portalUrl"`
	MAC          string `json:"mac"`
	Timezone     string `json:"timezone"`
	SerialNumber string `json:"serialNumber"`
	DeviceID     string `json:"deviceId"`
	DeviceID2    string `json:"deviceId2"`
}
type LibrarySettings struct {
	RefreshIntervalSeconds int64    `json:"refreshIntervalSeconds"`
	DashboardCategories    []string `json:"dashboardCategories"`
	BlockedCategories      []string `json:"blockedCategories"`
	GuideHours             int      `json:"guideHours"`
}
type PlaybackSettings struct {
	MaxStreams    int    `json:"maxStreams"`
	TranscodeMode string `json:"transcodeMode"`
}
type applicationSettings struct {
	Provider            ProviderSettings `json:"provider"`
	Library             LibrarySettings  `json:"library"`
	Playback            PlaybackSettings `json:"playback"`
	TMDBReadAccessToken string           `json:"tmdbReadAccessToken"`
	UpdatedAt           time.Time        `json:"updatedAt"`
}
type settingsResponse struct {
	Provider            ProviderSettings `json:"provider"`
	ProviderEnvironment []string         `json:"providerEnvironment"`
	Library             LibrarySettings  `json:"library"`
	Discovery           struct {
		TMDBTokenConfigured bool `json:"tmdbTokenConfigured"`
	} `json:"discovery"`
	Playback  PlaybackSettings `json:"playback"`
	UpdatedAt time.Time        `json:"updatedAt"`
}

func defaultSettings() applicationSettings {
	return applicationSettings{Provider: ProviderSettings{Timezone: "UTC"}, Library: LibrarySettings{RefreshIntervalSeconds: 86400, DashboardCategories: []string{}, BlockedCategories: []string{}, GuideHours: 6}, Playback: PlaybackSettings{MaxStreams: 1, TranscodeMode: "auto"}}
}
func (s applicationSettings) response(environment map[string]string) settingsResponse {
	r := settingsResponse{Provider: s.Provider, Library: s.Library, Playback: s.Playback, UpdatedAt: s.UpdatedAt}
	r.ProviderEnvironment = []string{}
	for key := range environment {
		r.ProviderEnvironment = append(r.ProviderEnvironment, key)
		setProviderField(&r.Provider, key, "")
	}
	sort.Strings(r.ProviderEnvironment)
	r.Discovery.TMDBTokenConfigured = s.TMDBReadAccessToken != ""
	return r
}
func (s applicationSettings) config(base Config) (Config, error) {
	provider := effectiveProvider(s.Provider, base.providerEnvironment)
	base.PortalURL, base.MAC, base.Timezone = provider.PortalURL, provider.MAC, provider.Timezone
	base.SerialNumber, base.DeviceID, base.DeviceID2 = provider.SerialNumber, provider.DeviceID, provider.DeviceID2
	base.RefreshInterval = time.Duration(s.Library.RefreshIntervalSeconds) * time.Second
	base.EPGHours = s.Library.GuideHours
	base.MaxStreams, base.TranscodeMode = s.Playback.MaxStreams, s.Playback.TranscodeMode
	base.TMDBReadAccessToken = s.TMDBReadAccessToken
	var err error
	base.categoryEnvironment.dashboard, err = settingsSelectors("Home categories", s.Library.DashboardCategories)
	if err != nil {
		return base, err
	}
	base.categoryEnvironment.blocked, err = settingsSelectors("Blocked categories", s.Library.BlockedCategories)
	return base, err
}
func settingsSelectors(name string, values []string) ([]categorySelector, error) {
	if len(values) == 0 {
		return nil, nil
	}
	var b bytes.Buffer
	w := csv.NewWriter(&b)
	if err := w.Write(values); err != nil {
		return nil, err
	}
	w.Flush()
	return parseCategorySelectors(name, b.String())
}
func setProviderField(provider *ProviderSettings, key, value string) {
	switch key {
	case "portalUrl":
		provider.PortalURL = value
	case "mac":
		provider.MAC = value
	case "timezone":
		provider.Timezone = value
	case "serialNumber":
		provider.SerialNumber = value
	case "deviceId":
		provider.DeviceID = value
	case "deviceId2":
		provider.DeviceID2 = value
	}
}
func effectiveProvider(provider ProviderSettings, environment map[string]string) ProviderSettings {
	for key, value := range environment {
		setProviderField(&provider, key, strings.TrimSpace(value))
	}
	return provider
}
func (s *applicationSettings) validate(environment map[string]string) error {
	p := &s.Provider
	p.PortalURL, p.MAC, p.Timezone = strings.TrimSpace(p.PortalURL), strings.TrimSpace(p.MAC), strings.TrimSpace(p.Timezone)
	p.SerialNumber, p.DeviceID, p.DeviceID2 = strings.TrimSpace(p.SerialNumber), strings.TrimSpace(p.DeviceID), strings.TrimSpace(p.DeviceID2)
	effective := effectiveProvider(s.Provider, environment)
	p = &effective
	if p.PortalURL != "" {
		u, e := url.Parse(p.PortalURL)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
			return fmt.Errorf("Enter an HTTP or HTTPS portal URL without embedded credentials or a fragment.")
		}
	}
	if p.MAC != "" {
		if _, e := net.ParseMAC(p.MAC); e != nil {
			return fmt.Errorf("Enter a valid provider MAC address.")
		}
	}
	if _, e := time.LoadLocation(p.Timezone); e != nil {
		return fmt.Errorf("Choose a valid IANA timezone.")
	}
	for _, v := range []string{p.PortalURL, p.MAC, p.Timezone, p.SerialNumber, p.DeviceID, p.DeviceID2} {
		if len(v) > 2048 || strings.ContainsAny(v, "\r\n\x00") {
			return fmt.Errorf("Provider settings contain an invalid value.")
		}
	}
	if s.Library.RefreshIntervalSeconds < 60 || s.Library.RefreshIntervalSeconds > 604800 {
		return fmt.Errorf("Refresh interval must be between 1 minute and 7 days.")
	}
	if s.Library.GuideHours < 1 || s.Library.GuideHours > 168 {
		return fmt.Errorf("Guide hours must be between 1 and 168.")
	}
	if s.Playback.MaxStreams < 1 {
		return fmt.Errorf("Simultaneous streams must be a positive integer.")
	}
	if s.Playback.TranscodeMode != "auto" && s.Playback.TranscodeMode != "copy" && s.Playback.TranscodeMode != "transcode" {
		return fmt.Errorf("Playback mode must be auto, copy, or transcode.")
	}
	s.TMDBReadAccessToken = strings.TrimSpace(s.TMDBReadAccessToken)
	if len(s.TMDBReadAccessToken) > 8192 || strings.ContainsAny(s.TMDBReadAccessToken, "\r\n\x00") {
		return fmt.Errorf("Enter a valid TMDB read access token.")
	}
	for _, list := range []*[]string{&s.Library.DashboardCategories, &s.Library.BlockedCategories} {
		if *list == nil {
			*list = []string{}
		}
		if len(*list) > 5000 {
			return fmt.Errorf("Too many category selections.")
		}
		for i, v := range *list {
			v = strings.TrimSpace(v)
			if v == "" || len(v) > 1024 || strings.ContainsAny(v, "\r\n\x00") {
				return fmt.Errorf("Category selections must contain valid names or IDs.")
			}
			(*list)[i] = v
		}
	}
	_, e := s.config(Config{})
	return e
}

// Merge only explicitly supplied fields; null and unknown fields are rejected.
var errEnvironmentManaged = errors.New("Provider settings managed by the environment cannot be changed here.")

func mergeSettings(current applicationSettings, body io.Reader, environment map[string]string) (applicationSettings, error) {
	raw := map[string]json.RawMessage{}
	d := json.NewDecoder(body)
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return current, fmt.Errorf("Enter a valid settings object.")
	}
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return current, fmt.Errorf("Enter a valid settings object.")
		}
		section, ok := token.(string)
		if !ok {
			return current, fmt.Errorf("Enter a valid settings object.")
		}
		var data json.RawMessage
		if d.Decode(&data) != nil {
			return current, fmt.Errorf("Enter a valid settings object.")
		}
		if strings.EqualFold(section, "provider") {
			var fields map[string]json.RawMessage
			if json.Unmarshal(data, &fields) == nil {
				for supplied := range fields {
					for managed := range environment {
						if strings.EqualFold(supplied, managed) {
							return current, errEnvironmentManaged
						}
					}
				}
			}
		}
		if _, duplicate := raw[section]; duplicate {
			return current, fmt.Errorf("Settings sections cannot be repeated.")
		}
		raw[section] = data
	}
	if _, err = d.Token(); err != nil {
		return current, fmt.Errorf("Enter a valid settings object.")
	}
	if err = d.Decode(new(any)); err != io.EOF {
		return current, fmt.Errorf("Settings must contain a single JSON object.")
	}
	encoded, _ := json.Marshal(current)
	var next applicationSettings
	_ = json.Unmarshal(encoded, &next)
	for section, data := range raw {
		var target any
		switch section {
		case "provider":
			target = &next.Provider
		case "library":
			target = &next.Library
		case "playback":
			target = &next.Playback
		case "discovery":
			var fields map[string]json.RawMessage
			if json.Unmarshal(data, &fields) != nil || fields == nil {
				return current, fmt.Errorf("Discovery settings must be an object.")
			}
			for name, v := range fields {
				if name != "tmdbReadAccessToken" || bytes.Equal(bytes.TrimSpace(v), []byte("null")) || json.Unmarshal(v, &next.TMDBReadAccessToken) != nil {
					return current, fmt.Errorf("Invalid discovery setting.")
				}
			}
			continue
		default:
			return current, fmt.Errorf("Unknown settings section.")
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || fields == nil {
			return current, fmt.Errorf("Settings sections must be objects.")
		}
		for _, v := range fields {
			if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
				return current, fmt.Errorf("Settings values cannot be null.")
			}
		}
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if decoder.Decode(target) != nil {
			return current, fmt.Errorf("Unknown setting or invalid value in %s.", section)
		}
	}
	if err := next.validate(environment); err != nil {
		return current, err
	}
	return next, nil
}
