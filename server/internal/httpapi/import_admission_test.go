package httpapi

import (
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/integrations"
)

// Security regression (Q346, review r2 S5): an import takes the upload's
// name rule, so a bidi-spoofed, path or over-long name is rejected
// invalid_name, and a file over the per-file cap file_too_large, before
// anything is downloaded.
func TestAdmitImportRefusesUnsafeNamesAndOversizedFiles(t *testing.T) {
	size := func(n int64) *int64 { return &n }
	for name, want := range map[string]string{
		"invoice\u202efdp.docx":           "invalid_name",
		"notes\u2066.pdf":                 "invalid_name",
		"a/b.pdf":                         "invalid_name",
		strings.Repeat("n", 121) + ".pdf": "invalid_name",
		"Lecture notes.pdf":               "",
	} {
		code, _, _, _ := admitImport(integrations.ImportFileMetadata{Name: name, Size: size(1000)}, "", 10<<20)
		if code != want {
			t.Errorf("%q: code = %q, want %q", name, code, want)
		}
	}
	if code, _, _, _ := admitImport(integrations.ImportFileMetadata{Name: "big.pdf", Size: size(11 << 20)}, "", 10<<20); code != "file_too_large" {
		t.Errorf("over the cap: code = %q", code)
	}
}
