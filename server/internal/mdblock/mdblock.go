// Package mdblock reads and writes the custom fenced code blocks that make
// markdown the single source of truth for generated study materials.
//
// A material's `content` is a markdown document. Quizzes and flashcards embed
// their structured payload inside a fenced block whose language is the artifact
// kind:
//
//	```quiz
//	questions: [ ... ]
//	timeLimitMin: 20
//	```
//
//	```flashcards
//	cards: [ ... ]
//	```
//
// The payload is YAML. Because JSON is a subset of YAML, blocks backfilled from
// the legacy jsonb tables (which embed raw JSON) parse identically; the app
// re-serializes to clean YAML on the next write.
package mdblock

import (
	"encoding/json"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// CardContent is one flashcard's authored content (front/back) plus a stable id.
// Per-user scheduling state (FSRS) lives in the card_stats table, never here.
type CardContent struct {
	ID    string `json:"id" yaml:"id"`
	Front string `json:"front" yaml:"front"`
	Back  string `json:"back" yaml:"back"`
}

// ExtractFence returns the body of the first ```<lang> fenced block in content.
func ExtractFence(content, lang string) (string, bool) {
	lines := strings.Split(content, "\n")
	open := "```" + lang
	for i := 0; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) != open {
			continue
		}
		body := make([]string, 0, len(lines)-i)
		for j := i + 1; j < len(lines); j++ {
			if strings.TrimSpace(lines[j]) == "```" {
				return strings.Join(body, "\n"), true
			}
			body = append(body, lines[j])
		}
		return strings.Join(body, "\n"), true // unterminated fence
	}
	return "", false
}

// ParseQuiz extracts the quiz fence and returns the questions as JSON (the shape
// the frontend Question union expects) plus the optional time limit.
func ParseQuiz(content string) (json.RawMessage, *int, error) {
	body, ok := ExtractFence(content, "quiz")
	if !ok {
		return json.RawMessage("[]"), nil, nil
	}
	var doc struct {
		TimeLimitMin *int        `yaml:"timeLimitMin"`
		Questions    interface{} `yaml:"questions"`
	}
	if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
		return nil, nil, fmt.Errorf("parse quiz block: %w", err)
	}
	if doc.Questions == nil {
		doc.Questions = []interface{}{}
	}
	b, err := json.Marshal(doc.Questions)
	if err != nil {
		return nil, nil, err
	}
	return json.RawMessage(b), doc.TimeLimitMin, nil
}

// ParseFlashcards extracts the flashcards fence and returns the authored cards.
func ParseFlashcards(content string) ([]CardContent, error) {
	body, ok := ExtractFence(content, "flashcards")
	if !ok {
		return []CardContent{}, nil
	}
	var doc struct {
		Cards []CardContent `yaml:"cards"`
	}
	if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
		return nil, fmt.Errorf("parse flashcards block: %w", err)
	}
	if doc.Cards == nil {
		doc.Cards = []CardContent{}
	}
	return doc.Cards, nil
}
