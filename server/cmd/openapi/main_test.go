package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestGeneratedFieldLimitsAreCurrent(t *testing.T) {
	for _, tc := range []struct {
		path string
		want []byte
	}{
		{"src/api/limits.generated.ts", renderTypeScriptLimits()},
		{"pipeline/pipeline/generated/limits.py", renderPythonLimits()},
	} {
		t.Run(tc.path, func(t *testing.T) {
			path := filepath.Join("..", "..", "..", filepath.FromSlash(tc.path))
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n")), tc.want) {
				t.Fatalf("%s is stale; run pnpm gen:openapi", tc.path)
			}
		})
	}
}
