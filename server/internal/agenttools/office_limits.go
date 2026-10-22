package agenttools

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// OfficeLimitsPath is the Office engine's per-call limit table, relative to
// the repository root. The engine alone counts an agent call's limits (Epo
// 2026-10-22); Marshal writes the table's numbers into edit_office_document's
// description so the two cannot drift.
const OfficeLimitsPath = "vendor/betteroffice/crates/office-service/limits.json"

type officeLimitTable struct {
	Commands  int       `json:"commands"`
	ShapeText ShapeText `json:"shapeText"`
	Formats   map[string][]struct {
		Count string `json:"count"`
		Limit int    `json:"limit"`
	} `json:"formats"`
}

// ShapeText bounds the text one PPTX command writes into one shape (the
// engine's limits.json; review L2): Marshal writes it into set_shape_text's
// and add_text_box's schemas and the contract, where the office_building
// skill reads it.
type ShapeText struct {
	Paragraphs int `json:"paragraphs"`
	Characters int `json:"characters"`
}

// shapeTextKey marks a schema whose maxItems and description Marshal fills
// from ShapeText; the description's shapeParagraphs and shapeCharacters
// tokens become its numbers.
const (
	shapeTextKey    = "x-shape-text"
	shapeParagraphs = "{shape paragraphs}"
	shapeCharacters = "{shape characters}"
)

// parseOfficeLimits reads the engine's table.
func parseOfficeLimits(table []byte) (officeLimitTable, error) {
	var limits officeLimitTable
	if err := json.Unmarshal(table, &limits); err != nil {
		return limits, fmt.Errorf("office limits: %w", err)
	}
	if limits.Commands <= 0 || len(limits.Formats) == 0 {
		return limits, fmt.Errorf("office limits: no commands or formats")
	}
	if limits.ShapeText.Paragraphs <= 0 || limits.ShapeText.Characters <= 0 {
		return limits, fmt.Errorf("office limits: no shapeText bounds")
	}
	return limits, nil
}

// withShapeText fills the schemas shapeTextKey marks under node.
func withShapeText(node any, bounds ShapeText) {
	switch n := node.(type) {
	case map[string]any:
		if _, ok := n[shapeTextKey]; ok {
			delete(n, shapeTextKey)
			n["maxItems"] = bounds.Paragraphs
			if desc, ok := n["description"].(string); ok {
				desc = strings.ReplaceAll(desc, shapeParagraphs, thousands(bounds.Paragraphs))
				n["description"] = strings.ReplaceAll(desc, shapeCharacters, thousands(bounds.Characters))
			}
		}
		for _, value := range n {
			withShapeText(value, bounds)
		}
	case []any:
		for _, value := range n {
			withShapeText(value, bounds)
		}
	}
}

// officeLimitsSentence is the description's sentence for the table.
func officeLimitsSentence(limits officeLimitTable) string {
	formats := make([]string, 0, len(limits.Formats))
	for format := range limits.Formats {
		formats = append(formats, format)
	}
	sort.Strings(formats)
	parts := make([]string, 0, len(formats))
	for _, format := range formats {
		counts := make([]string, 0, len(limits.Formats[format]))
		for _, limit := range limits.Formats[format] {
			counts = append(counts, thousands(limit.Limit)+" "+limit.Count)
		}
		parts = append(parts, strings.ToUpper(format)+": "+list(counts))
	}
	return fmt.Sprintf("A call applies at most %s commands and, per format, %s. Commands apply in order up "+
		"to the first that would pass a limit; the rest come back unapplied, by index, to send in another call.",
		thousands(limits.Commands), strings.Join(parts, "; "))
}

// thousands writes 10000 as 10,000.
func thousands(n int) string {
	digits := strconv.Itoa(n)
	var out strings.Builder
	for i, digit := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteRune(digit)
	}
	return out.String()
}

// list joins items as "a, b and c".
func list(items []string) string {
	if len(items) < 2 {
		return strings.Join(items, "")
	}
	return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
}
