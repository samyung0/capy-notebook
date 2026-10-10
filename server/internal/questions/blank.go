package questions

import "strings"

// Blank reports whether a learner left every part of a question empty. Such a
// question still scores 0 marks in an attempt, but says nothing about what the
// learner remembers, so it is not rated for review. A question with an
// ordering part is never blank: the shown order is itself an answer, and it
// may already be the right one.
func Blank(q map[string]any, answers map[string]any) bool {
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		a, _ := p["answer"].(map[string]any)
		if a["type"] == "ordering" {
			return false
		}
		id, _ := p["id"].(string)
		if !emptyAnswer(answers[id]) {
			return false
		}
	}
	return true
}

// emptyAnswer mirrors isAnswered in src/features/quizzes/QuestionRunner.tsx:
// no value, blank text, no chosen option, no filled gap, no matched pair.
func emptyAnswer(value any) bool {
	switch v := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(v) == ""
	case []any:
		for _, item := range v {
			if text, isText := item.(string); !isText || strings.TrimSpace(text) != "" {
				return false
			}
		}
		return true
	case map[string]any:
		return len(v) == 0
	default:
		return false
	}
}
