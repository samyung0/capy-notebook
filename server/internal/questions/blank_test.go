package questions

import "testing"

func TestBlank(t *testing.T) {
	part := func(id, kind string) any {
		return map[string]any{"id": id, "answer": map[string]any{"type": kind}}
	}
	twoParts := map[string]any{"parts": []any{part("a", "short"), part("b", "gaps")}}
	withOrdering := map[string]any{"parts": []any{part("a", "short"), part("o", "ordering")}}
	cases := []struct {
		name    string
		q       map[string]any
		answers map[string]any
		want    bool
	}{
		{"nothing sent", twoParts, map[string]any{}, true},
		{"whitespace and empty gaps", twoParts, map[string]any{"a": "  ", "b": []any{"", " "}}, true},
		{"one gap filled", twoParts, map[string]any{"b": []any{"", "ATP"}}, false},
		{"a chosen option", map[string]any{"parts": []any{part("a", "mcq")}}, map[string]any{"a": []any{0.0}}, false},
		{"false is an answer", map[string]any{"parts": []any{part("a", "boolean")}}, map[string]any{"a": false}, false},
		{"no matched pair", map[string]any{"parts": []any{part("a", "matching")}}, map[string]any{"a": map[string]any{}}, true},
		{"ordering is never blank", withOrdering, map[string]any{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Blank(c.q, c.answers); got != c.want {
				t.Fatalf("Blank = %v, want %v", got, c.want)
			}
		})
	}
}
