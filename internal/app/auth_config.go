package app

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
)

// AuthConfig configures deployment-level authentication; it is never editable through Settings.
type AuthConfig struct {
	Mode         string
	IssuerURL    string
	DiscoveryURL string
	ClientID     string
	ClientSecret string
	PublicURL    string
}

func loadAuthConfig() (AuthConfig, error) {
	c := AuthConfig{Mode: strings.TrimSpace(os.Getenv("AUTH_TYPE")), IssuerURL: strings.TrimSpace(os.Getenv("OIDC_ISSUER_URL")), DiscoveryURL: strings.TrimSpace(os.Getenv("OIDC_DISCOVERY_URL")), ClientID: strings.TrimSpace(os.Getenv("OIDC_CLIENT_ID")), ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"), PublicURL: strings.TrimSpace(os.Getenv("APP_URL"))}
	err := c.validate()
	return c, err
}

func (c *AuthConfig) validate() error {
	if c.Mode == "" {
		c.Mode = "none"
	}
	if c.Mode == "none" {
		return nil
	}
	if c.Mode != "oidc" {
		return fmt.Errorf("AUTH_TYPE must be none or oidc")
	}
	if c.IssuerURL == "" && c.DiscoveryURL == "" {
		return fmt.Errorf("OIDC_ISSUER_URL or OIDC_DISCOVERY_URL is required")
	}
	if c.ClientID == "" || c.ClientSecret == "" {
		return fmt.Errorf("OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required")
	}
	for name, raw := range map[string]string{"APP_URL": c.PublicURL, "OIDC_ISSUER_URL": c.IssuerURL, "OIDC_DISCOVERY_URL": c.DiscoveryURL} {
		if raw == "" && name != "APP_URL" {
			continue
		}
		u, err := authURL(raw)
		if err != nil {
			return fmt.Errorf("%s must be an HTTPS URL (HTTP is allowed only on loopback)", name)
		}
		if name == "APP_URL" && u.Path != "" && u.Path != "/" {
			return fmt.Errorf("APP_URL must be an origin without a path")
		}
		if (name == "OIDC_ISSUER_URL" || name == "APP_URL") && (u.RawQuery != "" || u.ForceQuery) {
			return fmt.Errorf("%s cannot contain a query", name)
		}
		if name == "APP_URL" {
			c.PublicURL = u.String()
		}
	}
	c.PublicURL = strings.TrimSuffix(c.PublicURL, "/")
	return nil
}

func authURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" {
		return nil, fmt.Errorf("invalid URL")
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if u.Scheme != "https" && !(u.Scheme == "http" && (host == "localhost" || ip != nil && ip.IsLoopback())) {
		return nil, fmt.Errorf("insecure URL")
	}
	return u, nil
}
