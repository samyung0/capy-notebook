package questions

import "strings"

// SearchText is a question's words for an item bank's Search, lowercased: its
// stem, groups, parts and worked solutions, and its answers' options, accepted
// answers, items and pairs (Canvas searches stems and answer choices). Text
// blocks lose their bold, italic and underline markers.
func SearchText(q map[string]any) string {
	var out []string
	for _, blocks := range blockLists(q) {
		if text := StripMarks(blocksText(blocks)); text != "" {
			out = append(out, text)
		}
	}
	add := func(raw any) {
		if s, ok := raw.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		a, _ := p["answer"].(map[string]any)
		for _, key := range []string{"options", "accepted", "items"} {
			values, _ := a[key].([]any)
			for _, v := range values {
				// A gaps answer holds one accepted list per gap.
				if list, ok := v.([]any); ok {
					for _, s := range list {
						add(s)
					}
					continue
				}
				add(v)
			}
		}
		pairs, _ := a["pairs"].([]any)
		for _, raw := range pairs {
			pair, _ := raw.(map[string]any)
			add(pair["left"])
		}
	}
	return strings.ToLower(strings.Join(out, "\n"))
}
