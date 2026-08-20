package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKindFromName(t *testing.T) {
	cases := map[string]string{
		"notes.pdf":       "pdf",
		"paper.PDF":       "pdf",
		"report.docx":     "doc",
		"report.doc":      "doc",
		"readme.md":       "md",
		"readme.markdown": "md",
		"figure.png":      "image",
		"photo.JPEG":      "image",
		"data.csv":        "sheet",
		"deck.pptx":       "slides",
		"talk.mp3":        "audio",
		"noext":           "unknown",
	}
	for name, want := range cases {
		if got := kindFromName(name); got != want {
			t.Errorf("kindFromName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestContentType(t *testing.T) {
	cases := map[string]string{
		"pdf":     "application/pdf",
		"md":      "text/plain; charset=utf-8",
		"txt":     "text/plain; charset=utf-8",
		"doc":     "text/plain; charset=utf-8",
		"image":   "application/octet-stream",
		"unknown": "application/octet-stream",
	}
	for kind, want := range cases {
		if got := contentType(kind); got != want {
			t.Errorf("contentType(%q) = %q, want %q", kind, got, want)
		}
	}
}

func TestRandID(t *testing.T) {
	id := randID("f")
	if !strings.HasPrefix(id, "f_") {
		t.Fatalf("randID prefix missing: %q", id)
	}
	if len(id) != len("f_")+10 { // 5 bytes hex-encoded = 10 chars
		t.Fatalf("randID length = %d, want %d (%q)", len(id), len("f_")+10, id)
	}
	if randID("x") == randID("x") {
		t.Errorf("randID should not collide on consecutive calls")
	}
}

func TestRandInt(t *testing.T) {
	for i := 0; i < 200; i++ {
		n := randInt(200, 3200)
		if n < 200 || n >= 3200 {
			t.Fatalf("randInt out of range: %d", n)
		}
	}
}

// buildQuestions must emit shapes the frontend QuestionRunner can render for
// every question type.
func TestBuildQuestionsAllTypes(t *testing.T) {
	types := []string{"mcq", "multi", "boolean", "short", "open", "matching", "ordering"}
	raw := buildQuestions(generateOpts{Types: types, Difficulty: []string{"easy", "hard"}, Count: len(types)})

	var qs []map[string]any
	if err := json.Unmarshal(raw, &qs); err != nil {
		t.Fatalf("buildQuestions produced invalid JSON: %v", err)
	}
	if len(qs) != len(types) {
		t.Fatalf("got %d questions, want %d", len(qs), len(types))
	}
	for _, q := range qs {
		if q["id"] == nil || q["prompt"] == nil || q["type"] == nil {
			t.Errorf("question missing core fields: %v", q)
		}
		switch q["type"] {
		case "mcq", "multi":
			if _, ok := q["options"].([]any); !ok {
				t.Errorf("%v missing options", q["type"])
			}
			if _, ok := q["correct"].([]any); !ok {
				t.Errorf("%v missing correct[]", q["type"])
			}
		case "boolean":
			if _, ok := q["correct"].(bool); !ok {
				t.Errorf("boolean missing bool correct")
			}
		case "short":
			if _, ok := q["accepted"].([]any); !ok {
				t.Errorf("%v missing accepted", q["type"])
			}
		case "open":
			if _, ok := q["accepted"].([]any); !ok {
				t.Errorf("open missing accepted")
			}
			if _, ok := q["rubrics"].([]any); !ok {
				t.Errorf("open missing rubrics")
			}
		case "ordering":
			if _, ok := q["items"].([]any); !ok {
				t.Errorf("ordering missing items")
			}
		case "matching":
			if _, ok := q["pairs"].([]any); !ok {
				t.Errorf("matching missing pairs")
			}
		}
	}
}

func TestBuildQuestionsDefaults(t *testing.T) {
	// No types/difficulty/count → defaults to 5 mcq questions.
	raw := buildQuestions(generateOpts{})
	var qs []map[string]any
	if err := json.Unmarshal(raw, &qs); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(qs) != 5 {
		t.Fatalf("default count = %d, want 5", len(qs))
	}
	for _, q := range qs {
		if q["type"] != "mcq" {
			t.Errorf("default type = %v, want mcq", q["type"])
		}
	}
}

func TestNormalizeGenerateTitle(t *testing.T) {
	if _, err := normalizeGenerateTitle("  "); err == nil {
		t.Fatal("blank title was accepted")
	}
	if _, err := normalizeGenerateTitle(strings.Repeat("a", 201)); err == nil {
		t.Fatal("overlong title was accepted")
	}
	got, err := normalizeGenerateTitle("  Cell quiz  ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "Cell quiz" {
		t.Fatalf("trimmed = %q, want Cell quiz", got)
	}
}
