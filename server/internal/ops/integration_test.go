package ops

import (
	"os"
	"testing"
)

func integrationDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn != "" {
		return dsn
	}
	if os.Getenv("OPS_INTEGRATION_REQUIRED") == "1" {
		t.Fatal("TEST_DATABASE_URL is required for ops integration tests")
	}
	t.Skip("TEST_DATABASE_URL is not set")
	return ""
}
