package httpapi

import (
	"slices"
	"testing"
)

// TestWithMixedIn: a mixed-in question whose id or a part's id is taken, by the
// generated questions or an earlier mixed-in one, stays out, since the whole quiz
// would fail validation after the model is paid.
func TestWithMixedIn(t *testing.T) {
	question := func(id string, parts ...string) map[string]any {
		list := []any{}
		for _, part := range parts {
			list = append(list, map[string]any{"id": part})
		}
		return map[string]any{"id": id, "parts": list}
	}
	got := withMixedIn(
		[]map[string]any{question("g1", "p1")},
		[]map[string]any{
			question("g1", "p9"),
			question("m1", "p1"),
			question("m2", "p2"),
			question("m2", "p3"),
			question("m3", "p2"),
			question("m4", "g1"),
		},
	)
	ids := []string{}
	for _, q := range got {
		ids = append(ids, q["id"].(string))
	}
	if !slices.Equal(ids, []string{"g1", "m2", "m4"}) {
		t.Fatalf("kept %v", ids)
	}
}
