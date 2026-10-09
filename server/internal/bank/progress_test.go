package bank

import (
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A topic lists only current answered questions; Continue points at the next
// unanswered question after the latest answer, wrapping, and nowhere once
// every question is answered.
func TestSummarizeProgress(t *testing.T) {
	now := time.Now()
	topic := func(id string, ids ...string) topicQuestions {
		hashes := make([]string, len(ids))
		for i, q := range ids {
			hashes[i] = "h-" + q
		}
		return topicQuestions{TopicProgress: TopicProgress{TopicID: id}, ids: ids, hashes: hashes}
	}
	result := func(id, hash string, score float64, ago time.Duration) store.BankResult {
		return store.BankResult{QuestionID: id, Hash: hash, Score: score, AnsweredAt: now.Add(-ago)}
	}
	topics := []topicQuestions{
		topic("wrap", "a1", "a2", "a3", "a4"),
		topic("done", "b1", "b2"),
		topic("stale", "c1"),
	}
	results := []store.BankResult{
		// a4 is the latest answer, so Continue wraps past it to a2.
		result("a1", "h-a1", 1, 3*time.Hour),
		result("a4", "h-a4", 0.5, time.Hour),
		result("a3", "h-a3-old", 1, 0), // edited since: not answered
		result("gone", "h-gone", 1, 0), // retracted: not in any topic
		result("b1", "h-b1", 1, 2*time.Hour),
		result("b2", "h-b2", 0, 2*time.Hour+time.Minute),
		result("c1", "h-c1-old", 1, 0),
	}
	got := summarize(topics, results)
	if len(got) != 2 || got[0].TopicID != "wrap" || got[1].TopicID != "done" {
		t.Fatalf("topics = %+v", got)
	}
	wrap, done := got[0], got[1]
	if wrap.Total != 4 || wrap.Answered != 2 || wrap.Correct != 1 || !wrap.LastAnsweredAt.Equal(now.Add(-time.Hour)) ||
		wrap.NextQuestionID == nil || *wrap.NextQuestionID != "a2" || !slices.Equal(wrap.QuestionIDs, []string{"a1", "a2", "a3", "a4"}) || wrap.LastAnsweredPosition != 4 ||
		!slices.Equal(wrap.AnsweredPositions, []int{1, 4}) {
		t.Fatalf("wrap = %+v next %v", wrap, wrap.NextQuestionID)
	}
	if done.Total != 2 || done.Answered != 2 || done.Correct != 1 || done.NextQuestionID != nil {
		t.Fatalf("done = %+v", done)
	}
}
