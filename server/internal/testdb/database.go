// Package testdb exposes the database created by cmd/testdb to Go tests.
package testdb

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"testing"
)

const disposableMarker = "EVO_GO_DISPOSABLE_DATABASE"

// URL returns the disposable loopback Postgres URL installed by cmd/testdb.
// Database tests fail instead of skipping when run outside the harness, so CI
// cannot report a green suite that silently omitted them.
func URL(t testing.TB) string {
	t.Helper()
	raw := os.Getenv("DATABASE_URL")
	if err := validateURL(os.Getenv(disposableMarker), raw); err != nil {
		t.Fatalf("database test setup: %v; run `pnpm test:go` from the repository root", err)
	}
	return raw
}

func validateURL(marker, raw string) error {
	if marker != "1" {
		return fmt.Errorf("the disposable database harness is not active")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	if parsed.Scheme != "postgres" && parsed.Scheme != "postgresql" {
		return fmt.Errorf("DATABASE_URL must use postgres")
	}
	host := parsed.Hostname()
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("disposable DATABASE_URL must point to loopback, got %q", host)
	}
	if parsed.Port() == "" {
		return fmt.Errorf("disposable DATABASE_URL requires Docker's mapped port")
	}
	return nil
}
