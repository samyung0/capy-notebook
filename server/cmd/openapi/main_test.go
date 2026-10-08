package main

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
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

// The collaboration server validates embedded questions with its own copy of
// the bounds (collaboration-rs/crates/notes/src/questions.rs); each must equal
// Go's.
func TestCollaborationQuestionBoundsMatchGo(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "collaboration-rs", "crates", "notes", "src", "questions.rs"))
	if err != nil {
		t.Fatal(err)
	}
	found := regexp.MustCompile(`pub const (QUESTION_\w+): \w+ = ([\d_]+)(?:\.0)?;`).FindAllSubmatch(raw, -1)
	if len(found) == 0 {
		t.Fatal("no question bounds found in questions.rs")
	}
	for _, match := range found {
		name := string(match[1])
		value, err := strconv.Atoi(strings.ReplaceAll(string(match[2]), "_", ""))
		if err != nil {
			t.Fatal(err)
		}
		want, ok := fieldlimits.QuestionBounds[name]
		if !ok || value != want {
			t.Errorf("questions.rs %s = %d, Go has %d (known %v)", name, value, want, ok)
		}
	}
}
