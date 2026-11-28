// Package testdb exposes the database created by cmd/testdb to Go tests.
package testdb

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

const disposableMarker = "CAPY_GO_DISPOSABLE_DATABASE"

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

// FilesViewOnly is the skip reason of every Go test that edits a file while
// files are view-only (sourceupload.FilesEditable, Q853 A).
const FilesViewOnly = "File editing is off (Q853 A)"

// SkipWhileFilesViewOnly skips a test (or the rest of one) that edits a file
// while sourceupload.FilesEditable is off; with the switch on it runs.
func SkipWhileFilesViewOnly(t testing.TB) {
	t.Helper()
	if !sourceupload.FilesEditable {
		t.Skip(FilesViewOnly)
	}
}

// SkipWhileFilesEditable skips a check of the view-only refusals once
// sourceupload.FilesEditable is back on.
func SkipWhileFilesEditable(t testing.TB) {
	t.Helper()
	if sourceupload.FilesEditable {
		t.Skip("files are editable")
	}
}
