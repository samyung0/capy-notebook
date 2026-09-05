package httpapi

import (
	"strings"
	"testing"
)

func TestModelSlotContractsAreGenerated(t *testing.T) {
	spec, err := SpecYAML()
	if err != nil {
		t.Fatal(err)
	}
	text := string(spec)
	for _, expected := range []string{
		"/api/model-slots:",
		"    Slot:\n      enum:",
		"    UserModelSlot:\n      enum:",
		`$ref: "#/components/schemas/Slot"`,
		`$ref: "#/components/schemas/UserModelSlot"`,
	} {
		if !strings.Contains(text, expected) {
			t.Errorf("OpenAPI model-slot contract missing %q", expected)
		}
	}
}
