package ops

import (
	"errors"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	AppEnv                 string
	UnsafeDevelopment      bool
	AccessDisabled         bool
	AuthDisabled           bool
	DevUserID              string
	ClerkSecretKey         string
	CloudflareAccessIssuer string
	CloudflareAccessAUD    string
	CloudflareAccessJWKS   string
	DatabaseURL            string
	AdminDatabaseURL       string
	IngestPrimaryEnv       string
	IngestUATDatabaseURL   string
	IngestLocalDatabaseURL string
}

func ConfigFromEnv() Config {
	return Config{
		AppEnv:                 envOr("APP_ENV", "development"),
		UnsafeDevelopment:      envEnabled("OPS_UNSAFE_DEVELOPMENT"),
		AccessDisabled:         envEnabled("OPS_ACCESS_DISABLED"),
		AuthDisabled:           envEnabled("OPS_AUTH_DISABLED"),
		DevUserID:              envOr("OPS_DEV_USER_ID", "u_1"),
		ClerkSecretKey:         os.Getenv("CLERK_SECRET_KEY"),
		CloudflareAccessIssuer: os.Getenv("OPS_CF_ACCESS_ISSUER"),
		CloudflareAccessAUD:    os.Getenv("OPS_CF_ACCESS_AUDIENCE"),
		CloudflareAccessJWKS:   os.Getenv("OPS_CF_ACCESS_JWKS_URL"),
		DatabaseURL:            os.Getenv("OPS_DATABASE_URL"),
		AdminDatabaseURL:       os.Getenv("OPS_ADMIN_DATABASE_URL"),
		IngestPrimaryEnv:       envOr("OPS_INGEST_PRIMARY_ENVIRONMENT", "production"),
		IngestUATDatabaseURL:   os.Getenv("OPS_INGEST_UAT_DATABASE_URL"),
		IngestLocalDatabaseURL: os.Getenv("OPS_INGEST_LOCAL_DATABASE_URL"),
	}
}

func (c Config) development() bool {
	return strings.EqualFold(strings.TrimSpace(c.AppEnv), "development")
}

func (c Config) allowUnsafe() bool {
	return c.development() && c.UnsafeDevelopment
}

func (c Config) AllowOwnerDSN() bool {
	return c.allowUnsafe()
}

func (c Config) resolvedJWKS() string {
	if jwks := strings.TrimSpace(c.CloudflareAccessJWKS); jwks != "" {
		return jwks
	}
	issuer := strings.TrimSpace(c.CloudflareAccessIssuer)
	if issuer == "" {
		return ""
	}
	return strings.TrimRight(issuer, "/") + "/cdn-cgi/access/certs"
}

func (c Config) AccessConfig() AccessConfig {
	return AccessConfig{
		Issuer:   strings.TrimSpace(c.CloudflareAccessIssuer),
		Audience: strings.TrimSpace(c.CloudflareAccessAUD),
		JWKSURL:  c.resolvedJWKS(),
	}
}

func (c Config) Validate() error {
	if c.UnsafeDevelopment && !c.development() {
		return errors.New("OPS_UNSAFE_DEVELOPMENT is only allowed when APP_ENV=development")
	}
	if c.AccessDisabled && !c.allowUnsafe() {
		return errors.New("OPS_ACCESS_DISABLED is only allowed in development with OPS_UNSAFE_DEVELOPMENT")
	}
	if c.AuthDisabled && !c.allowUnsafe() {
		return errors.New("OPS_AUTH_DISABLED is only allowed in development with OPS_UNSAFE_DEVELOPMENT")
	}
	if !c.AccessDisabled {
		if err := validateAccessIssuer(c.CloudflareAccessIssuer); err != nil {
			return err
		}
		if strings.TrimSpace(c.CloudflareAccessAUD) == "" {
			return errors.New("OPS_CF_ACCESS_AUDIENCE is required")
		}
		if err := validateHTTPSURL("Cloudflare Access JWKS", c.resolvedJWKS()); err != nil {
			return err
		}
	}
	if c.AuthDisabled {
		if strings.TrimSpace(c.DevUserID) == "" {
			return errors.New("OPS_DEV_USER_ID is required when OPS_AUTH_DISABLED=true")
		}
	} else if strings.TrimSpace(c.ClerkSecretKey) == "" {
		return errors.New("CLERK_SECRET_KEY is required")
	}
	if strings.TrimSpace(c.DatabaseURL) == "" {
		return errors.New("OPS_DATABASE_URL is required")
	}
	if strings.TrimSpace(c.AdminDatabaseURL) == "" {
		return errors.New("OPS_ADMIN_DATABASE_URL is required")
	}
	primaryEnvironment := strings.TrimSpace(c.IngestPrimaryEnv)
	if primaryEnvironment != "" && primaryEnvironment != "production" &&
		primaryEnvironment != "uat" && primaryEnvironment != "local" {
		return errors.New("OPS_INGEST_PRIMARY_ENVIRONMENT must be production, uat, or local")
	}
	if primaryEnvironment == "uat" && strings.TrimSpace(c.IngestUATDatabaseURL) != "" {
		return errors.New("OPS_INGEST_UAT_DATABASE_URL duplicates the primary database")
	}
	if primaryEnvironment == "local" && strings.TrimSpace(c.IngestLocalDatabaseURL) != "" {
		return errors.New("OPS_INGEST_LOCAL_DATABASE_URL duplicates the primary database")
	}
	return nil
}

func validateAccessIssuer(raw string) error {
	issuer := strings.TrimSpace(raw)
	if issuer == "" {
		return errors.New("OPS_CF_ACCESS_ISSUER is required")
	}
	parsed, err := url.Parse(issuer)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("Cloudflare Access issuer must be an HTTPS origin")
	}
	return nil
}

func validateHTTPSURL(name, raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return errors.New(name + " must be an absolute HTTPS URL")
	}
	return nil
}

func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envEnabled(key string) bool {
	return os.Getenv(key) == "true"
}
