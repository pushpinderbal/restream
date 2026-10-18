package app

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Auth                                                                   AuthConfig
	RequestTimeout                                                         time.Duration
	EPGHours                                                               int
	MaxResponseBytes                                                       int64
	ListenAddr, DataDir, WebDir                                            string
	PortalURL, MAC, Timezone, UserAgent, SerialNumber, DeviceID, DeviceID2 string
	MaxStreams                                                             int
	SessionTTL, RequestInterval                                            time.Duration
	TranscodeMode                                                          string
	TMDBReadAccessToken                                                    string
	RefreshInterval                                                        time.Duration
	categoryEnvironment                                                    categoryEnvironment
	providerEnvironment                                                    map[string]string
}

func LoadConfig() (Config, error) {
	c := Config{
		ListenAddr: env("LISTEN_ADDR", ":8080"), DataDir: "/data", WebDir: "/app/web",
		Timezone: "UTC", UserAgent: os.Getenv("STALKER_USER_AGENT"),
		TranscodeMode: "auto", MaxStreams: 1, EPGHours: 6, RefreshInterval: 24 * time.Hour,
	}
	var err error
	c.Auth, err = loadAuthConfig()
	if err != nil {
		return c, err
	}
	c.providerEnvironment = map[string]string{}
	for name, key := range map[string]string{"STALKER_PORTAL_URL": "portalUrl", "STALKER_MAC": "mac", "STALKER_TIMEZONE": "timezone", "STALKER_SERIAL_NUMBER": "serialNumber", "STALKER_DEVICE_ID": "deviceId", "STALKER_DEVICE_ID2": "deviceId2"} {
		if value, present := os.LookupEnv(name); present {
			c.providerEnvironment[key] = value
		}
	}
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
	c.SessionTTL, err = time.ParseDuration(env("SESSION_TTL", "45s"))
	if err != nil || c.SessionTTL < 30*time.Second {
		return c, fmt.Errorf("SESSION_TTL must be a duration of at least 30s")
	}
	return c, nil
}

func env(key, fallback string) string {
	if s := os.Getenv(key); s != "" {
		return s
	}
	return fallback
}
