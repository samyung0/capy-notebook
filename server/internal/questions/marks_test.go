package questions

import "testing"

func TestStripMarks(t *testing.T) {
	for text, want := range map[string]string{
		"**Find** *all* __roots__ of ***x***": "Find all roots of x",
		"**the $x^2$ term** and **ab*cd*ef**": "the $x^2$ term and abcdef",
		"這是**重點**。":                           "這是重點。",
		// Loose markers, blanks, formulas and escapes stay as written.
		"2 * 3 * 4 and a*b":      "2 * 3 * 4 and a*b",
		"(1) ______ and $a*b*c$": "(1) ______ and $a*b*c$",
		`\*not italic\* $$x_1$$`: "*not italic* $$x_1$$",
		// `__` marks inside a word, as `**` does.
		"the__key__word, 中文__重點__中文": "thekeyword, 中文重點中文",
		// `\\` before a marker or dollar is one backslash.
		`C:\\**word** and \\\$5`: `C:\word and \$5`,
	} {
		if got := StripMarks(text); got != want {
			t.Errorf("StripMarks(%q) = %q, want %q", text, got, want)
		}
	}
}

func TestSearchTextStripsMarks(t *testing.T) {
	q := map[string]any{
		"stem": []any{map[string]any{"type": "text", "text": "Name the **largest** organ"}},
		"parts": []any{map[string]any{
			"blocks": []any{},
			"answer": map[string]any{"type": "open", "accepted": []any{"Skin"}},
		}},
	}
	if got := SearchText(q); got != "name the largest organ\nskin" {
		t.Errorf("SearchText = %q", got)
	}
}
