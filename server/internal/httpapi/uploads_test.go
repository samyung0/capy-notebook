package httpapi

import (
	"regexp"
	"testing"
)

// Browser uploads and cloud imports take their keys from sourceObjectKeys:
// a 128-bit blob id plus only a plain lowercase extension (security review
// E-F1, E-F5, 2026-10-19).
func TestSourceObjectKeys(t *testing.T) {
	for _, tc := range []struct{ name, ext string }{
		{"Notes.PDF", ".pdf"},
		{"deck.pptx", ".pptx"},
		{"no extension", ""},
		{"odd.p df", ""},
		{"tab.pd\tf", ""},
		{"newline.pd\nf", ""},
		{"long.abcdefghijkl", ""},
		{"unicode.pdé", ""},
	} {
		incoming, final := sourceObjectKeys("up_0123456789", tc.name)
		blob := `blob_[0-9a-f]{32}` + regexp.QuoteMeta(tc.ext)
		if !regexp.MustCompile(`^incoming/up_0123456789/`+blob+`$`).MatchString(incoming) ||
			!regexp.MustCompile(`^sources/`+blob+`$`).MatchString(final) ||
			incoming[len("incoming/up_0123456789/"):] != final[len("sources/"):] {
			t.Fatalf("%q keys = %q, %q; want one blob id with extension %q", tc.name, incoming, final, tc.ext)
		}
	}
}
