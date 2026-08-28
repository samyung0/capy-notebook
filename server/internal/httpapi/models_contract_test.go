package httpapi

import (
	"strings"
	"testing"
)

func TestModelSurfaceContractsAreGenerated(t *testing.T) {
	spec, err := SpecYAML()
	if err != nil {
		t.Fatal(err)
	}
	text := string(spec)
	for _, expected := range []string{
		"/api/model-surfaces:",
		"    Surface:\n      enum:",
		"    UserModelSurface:\n      enum:",
		`$ref: "#/components/schemas/Surface"`,
		`$ref: "#/components/schemas/UserModelSurface"`,
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("OpenAPI model-surface contract missing %q", expected)
		}
	}
}
