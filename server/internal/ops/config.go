package ops

import (
	"errors"
	"net/url"
	"strings"
)

type SecurityConfig struct {
	ClerkSecretKey         string
	CloudflareAccessIssuer string
	CloudflareAccessAUD    string
	CloudflareAccessJWKS   string
}

func (c SecurityConfig) Validate() error {
	if strings.TrimSpace(c.CloudflareAccessIssuer) == "" ||
		strings.TrimSpace(c.CloudflareAccessAUD) == "" ||
		strings.TrimSpace(c.CloudflareAccessJWKS) == "" {
		return errors.New("Cloudflare Access issuer, audience, and JWKS URL are required")
	}
	if strings.TrimSpace(c.ClerkSecretKey) == "" {
		return errors.New("CLERK_SECRET_KEY is required")
	}
	for name, raw := range map[string]string{
		"Cloudflare Access issuer": c.CloudflareAccessIssuer,
		"Cloudflare Access JWKS":   c.CloudflareAccessJWKS,
	} {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			return errors.New(name + " must be an absolute HTTPS URL")
		}
	}
	return nil
}
