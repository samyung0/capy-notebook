package review

import (
	"fmt"
	"testing"
	"time"
)

var topicStart = time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)

// answers are one part each, a question per entry, right or wrong, a minute apart.
func answers(right, asked int) []PartAnswer {
	out := make([]PartAnswer, 0, asked)
	for i := range asked {
		awarded := 0.0
		if i < right {
			awarded = 1
		}
		out = append(out, PartAnswer{QuestionID: fmt.Sprintf("q%d", i), Hash: "h", Awarded: awarded, Marks: 1, At: topicStart.Add(time.Duration(i) * time.Minute)})
	}
	return out
}

// The counts Epo reviewed in todo-learning-page.md section 4.
func TestTopicLabelCounts(t *testing.T) {
	for _, c := range []struct {
		right, asked int
		want         string
	}{
		{0, 0, LabelNotStarted},
		{2, 2, LabelAttempted},
		{1, 3, LabelNeedsPractice},
		{2, 3, LabelFamiliar},
		{1, 4, LabelNeedsPractice},
		{4, 4, LabelProficient},
		{2, 5, LabelNeedsPractice},
		{3, 5, LabelFamiliar},
		{5, 5, LabelProficient},
		{4, 10, LabelNeedsPractice},
		{8, 10, LabelFamiliar},
		{9, 10, LabelProficient},
		{10, 20, LabelNeedsPractice},
		{15, 20, LabelFamiliar},
		{16, 20, LabelProficient},
	} {
		if got := TopicLabel(answers(c.right, c.asked), topicStart.Add(time.Hour)).Label; got != c.want {
			t.Errorf("%d of %d: got %s, want %s", c.right, c.asked, got, c.want)
		}
	}
}

func TestTopicEvidenceCountsLatestAnswers(t *testing.T) {
	parts := answers(1, 4)
	// q3 was wrong, and is right three days later.
	parts = append(parts, PartAnswer{QuestionID: "q3", Hash: "h", Awarded: 1, Marks: 1, KeySeen: true, At: topicStart.Add(72 * time.Hour)})
	got := TopicLabel(parts, topicStart.Add(73*time.Hour))
	if got.Right != 2 || got.Asked != 4 {
		t.Fatalf("got %d of %d, want 2 of 4", got.Right, got.Asked)
	}
	if got.Wrong != 2 || got.Partial != 0 {
		t.Fatalf("got %+v, want 2 wrong", got)
	}
}

// A same-day redo after seeing the key adds nothing.
func TestTopicSameDayRepeatCountsNothing(t *testing.T) {
	parts := answers(0, 3)
	for i := range 3 {
		parts = append(parts, PartAnswer{QuestionID: fmt.Sprintf("q%d", i), Hash: "h", Awarded: 1, Marks: 1, KeySeen: true, At: topicStart.Add(time.Duration(10+i) * time.Minute)})
	}
	if got := TopicLabel(parts, topicStart.Add(time.Hour)).Label; got != LabelNeedsPractice {
		t.Fatalf("got %s", got)
	}
}

func TestTopicEditedQuestionStartsAgain(t *testing.T) {
	parts := answers(0, 3)
	parts = append(parts, PartAnswer{QuestionID: "q0", Hash: "new", Awarded: 1, Marks: 1, At: topicStart.Add(time.Hour)})
	got := TopicLabel(parts, topicStart.Add(2*time.Hour))
	if got.Right != 1 || got.Asked != 3 || got.Wrong != 2 {
		t.Fatalf("got %+v", got)
	}
}

// A long question counts like at most three parts.
func TestTopicLongQuestionIsCapped(t *testing.T) {
	var parts []PartAnswer
	for range 12 {
		parts = append(parts, PartAnswer{QuestionID: "long", Hash: "h", Awarded: 1, Marks: 1, At: topicStart})
	}
	parts = append(parts,
		PartAnswer{QuestionID: "a", Hash: "h", Marks: 1, At: topicStart.Add(time.Minute)},
		PartAnswer{QuestionID: "b", Hash: "h", Marks: 1, At: topicStart.Add(2 * time.Minute)},
		PartAnswer{QuestionID: "c", Hash: "h", Marks: 1, At: topicStart.Add(3 * time.Minute)},
	)
	if got := TopicLabel(parts, topicStart.Add(time.Hour)).Label; got == LabelProficient {
		t.Fatalf("twelve right parts outweighed three wrong questions: %s", got)
	}
}

func TestTopicMasteredNeedsALaterCheck(t *testing.T) {
	parts := answers(5, 5)
	if got := TopicLabel(parts, topicStart.Add(time.Hour)).Label; got != LabelProficient {
		t.Fatalf("got %s", got)
	}
	parts = append(parts, PartAnswer{QuestionID: "q9", Hash: "h", Awarded: 1, Marks: 1, At: topicStart.Add(4 * 24 * time.Hour)})
	if got := TopicLabel(parts, topicStart.Add(4*24*time.Hour+time.Hour)).Label; got != LabelMastered {
		t.Fatalf("got %s", got)
	}
}

// Needs practice holds until its certainty falls below a half.
func TestTopicNeedsPracticeDoesNotFlicker(t *testing.T) {
	parts := answers(1, 4)
	if got := TopicLabel(parts, topicStart.Add(time.Hour)).Label; got != LabelNeedsPractice {
		t.Fatalf("got %s", got)
	}
	// 2 of 5: above 80% sure anyway; then 3 of 6 reads under 80% but over 50%.
	parts = append(parts,
		PartAnswer{QuestionID: "q8", Hash: "h", Awarded: 1, Marks: 1, At: topicStart.Add(5 * time.Minute)},
		PartAnswer{QuestionID: "q9", Hash: "h", Awarded: 1, Marks: 1, At: topicStart.Add(6 * time.Minute)},
	)
	if got := TopicLabel(parts, topicStart.Add(time.Hour)).Label; got != LabelNeedsPractice {
		t.Fatalf("got %s, want it to hold", got)
	}
	if got := TopicLabel(answers(3, 6), topicStart.Add(time.Hour)).Label; got != LabelFamiliar {
		t.Fatalf("got %s for the same counts arriving right first", got)
	}
}

// An attempt's closed part and its open part marked a day later are one check of
// the question, in the mark they add up to.
func TestTopicLabelGroupsACheckByAttempt(t *testing.T) {
	got := TopicLabel([]PartAnswer{
		{QuestionID: "q", AttemptID: "a", Hash: "h", Awarded: 1, Marks: 1, At: topicStart},
		{QuestionID: "q", AttemptID: "a", Hash: "h", Awarded: 0, Marks: 1, At: topicStart.Add(24 * time.Hour)},
	}, topicStart.Add(48*time.Hour))
	if got.Asked != 1 || got.Partial != 1 {
		t.Fatalf("standing = %+v, want one partly right check", got)
	}
}
