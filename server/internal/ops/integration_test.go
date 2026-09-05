package ops

import (
	"os"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestMain(m *testing.M) {
	for _, key := range []string{
		"ANTHROPIC_API_KEY",
		"DEEPSEEK_API_KEY",
		"OPENAI_API_KEY",
		"DEEPINFRA_API_KEY",
	} {
		if os.Getenv(key) == "" {
			_ = os.Setenv(key, "test-"+key)
		}
	}
	os.Exit(m.Run())
}

func integrationDSN(t *testing.T) string {
	t.Helper()
	return testdb.URL(t)
}
