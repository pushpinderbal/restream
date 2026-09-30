package app

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	RequestTimeout                                                         time.Duration
	EPGHours                                                               int
	MaxResponseBytes                                                       int64
	ListenAddr, DataDir, WebDir                                            string
	PortalURL, MAC, Timezone, UserAgent, SerialNumber, DeviceID, DeviceID2 string
	MaxStreams                                                             int
	SessionTTL, CatalogRefresh, EPGRefresh, RequestInterval                time.Duration
	EpisodeCacheTTL                                                        time.Duration
	FFmpegPath, FFprobePath, TranscodeMode                                 string
}

func LoadConfig() (Config, error) {
	c := Config{
		ListenAddr: env("LISTEN_ADDR", ":8080"), DataDir: env("DATA_DIR", "./data"), WebDir: env("WEB_DIR", "./web/dist"),
		PortalURL: strings.TrimSpace(os.Getenv("STALKER_PORTAL_URL")), MAC: strings.TrimSpace(os.Getenv("STALKER_MAC")),
		Timezone: env("STALKER_TIMEZONE", "UTC"), UserAgent: os.Getenv("STALKER_USER_AGENT"), SerialNumber: os.Getenv("STALKER_SERIAL_NUMBER"), DeviceID: os.Getenv("STALKER_DEVICE_ID"), DeviceID2: os.Getenv("STALKER_DEVICE_ID2"),
		FFmpegPath: env("FFMPEG_PATH", "ffmpeg"), FFprobePath: env("FFPROBE_PATH", "ffprobe"), TranscodeMode: env("TRANSCODE_MODE", "auto"),
	}
	var err error
	responseMB, err := strconv.ParseInt(env("STALKER_MAX_RESPONSE_MB", "64"), 10, 32)
	if err != nil || responseMB < 1 || responseMB > 512 {
		return c, fmt.Errorf("STALKER_MAX_RESPONSE_MB must be an integer between 1 and 512")
	}
	c.MaxResponseBytes = responseMB << 20
	c.RequestTimeout, err = time.ParseDuration(env("STALKER_REQUEST_TIMEOUT", "1m"))
	if err != nil || c.RequestTimeout < time.Second {
		return c, fmt.Errorf("STALKER_REQUEST_TIMEOUT must be a duration of at least 1s")
	}
	c.RequestInterval, err = time.ParseDuration(env("STALKER_REQUEST_INTERVAL", "250ms"))
	if err != nil || c.RequestInterval < 100*time.Millisecond {
		return c, fmt.Errorf("STALKER_REQUEST_INTERVAL must be a duration of at least 100ms")
	}
	c.EPGHours, err = strconv.Atoi(env("STALKER_EPG_HOURS", "6"))
	if err != nil || c.EPGHours < 1 || c.EPGHours > 168 {
		return c, fmt.Errorf("STALKER_EPG_HOURS must be an integer between 1 and 168")
	}

	c.MaxStreams, err = strconv.Atoi(env("MAX_STREAMS", "1"))
	if err != nil || c.MaxStreams < 1 {
		return c, fmt.Errorf("MAX_STREAMS must be a positive integer")
	}
	for _, setting := range []struct {
		name, fallback string
		target         *time.Duration
		minimum        time.Duration
	}{
		{"SESSION_TTL", "45s", &c.SessionTTL, 30 * time.Second},
		{"CATALOG_REFRESH_INTERVAL", "24h", &c.CatalogRefresh, time.Minute},
		{"EPISODE_CACHE_TTL", "1h", &c.EpisodeCacheTTL, time.Minute},
		{"EPG_REFRESH_INTERVAL", "6h", &c.EPGRefresh, time.Minute},
	} {
		*setting.target, err = time.ParseDuration(env(setting.name, setting.fallback))
		if err != nil || *setting.target < setting.minimum {
			return c, fmt.Errorf("%s must be a duration of at least %s", setting.name, setting.minimum)
		}
	}
	if (c.PortalURL == "") != (c.MAC == "") {
		return c, fmt.Errorf("set both STALKER_PORTAL_URL and STALKER_MAC")
	}
	if c.PortalURL != "" {
		u, e := url.Parse(c.PortalURL)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
			return c, fmt.Errorf("STALKER_PORTAL_URL must be an HTTP(S) portal URL without embedded credentials")
		}
	}
	if _, err := time.LoadLocation(c.Timezone); err != nil {
		return c, fmt.Errorf("STALKER_TIMEZONE must be an IANA timezone")
	}
	if c.TranscodeMode != "auto" && c.TranscodeMode != "copy" && c.TranscodeMode != "transcode" {
		return c, fmt.Errorf("TRANSCODE_MODE must be auto, copy, or transcode")
	}
	return c, nil
}

func env(key, fallback string) string {
	if s := os.Getenv(key); s != "" {
		return s
	}
	return fallback
}
