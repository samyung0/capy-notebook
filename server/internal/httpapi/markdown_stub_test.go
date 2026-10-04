package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
)

// withConverter stands in for the collaboration service's markdown converter
// in front of next: each blank-line-separated block becomes a paragraph, and a
// ```quiz or ```flashcards fence whose body is JSON becomes a pending
// reference with its draft, the shape the real converter returns.
func withConverter(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/markdown/convert" {
			next.ServeHTTP(w, r)
			return
		}
		var in struct {
			Markdown string `json:"markdown"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		value := []map[string]any{}
		embedded := []map[string]any{}
		for i, block := range strings.Split(in.Markdown, "\n\n") {
			kind, body, fenced := strings.Cut(strings.TrimPrefix(block, "```"), "\n")
			if strings.HasPrefix(block, "```") && fenced && (kind == "quiz" || kind == "flashcards") {
				body = strings.TrimSuffix(strings.TrimSpace(body), "```")
				draft := map[string]any{"kind": kind}
				if err := json.Unmarshal([]byte(body), &draft); err != nil {
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]string{"code": "invalid_input", "message": "fence is not YAML"})
					return
				}
				draft["kind"] = kind
				embedded = append(embedded, draft)
				value = append(value, map[string]any{
					"type": "material_ref", "id": "ref_" + string(rune('a'+i)), "materialId": "",
					"refKind": kind, "pending": body, "children": []any{map[string]any{"text": ""}},
				})
				continue
			}
			value = append(value, map[string]any{
				"type": "p", "id": "block_" + string(rune('a'+i)), "children": []any{map[string]any{"text": block}},
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"document": map[string]any{"schemaVersion": 1, "value": value},
			"embedded": embedded,
		})
	})
}
