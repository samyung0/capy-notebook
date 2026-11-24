package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// A topic's page lists its questions with the latest result, each ready to
// practise; Frequently wrong lists the ones not right at their latest check
// (Epo 2026-11-22). q1 is under Cells, q2 under Genetics by its own topic.
func TestStudyQuestionsListTopicsAndWrong(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_study_questions")
	ctx := context.Background()
	f.check(t, f.check(t, "", 0, true), 1, false)
	f.check(t, "", 1, false)

	list := func(filter QuestionsFilter) []StudyQuestion {
		t.Helper()
		got, err := f.s.WorkspaceStudyQuestions(ctx, f.user, f.ws.ID, false, filter)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	cells := list(QuestionsFilter{TopicID: f.cells})
	if len(cells) != 1 || cells[0].QuestionID != "q1" || cells[0].Result != resultRight ||
		cells[0].Question == nil || cells[0].MaterialTitle != "Two topics" {
		t.Fatalf("Cells = %+v, want q1 right with its content", cells)
	}
	genetics := list(QuestionsFilter{TopicID: f.genetics})
	if len(genetics) != 1 || genetics[0].QuestionID != "q2" || genetics[0].Result != resultWrong || genetics[0].Misses != 2 {
		t.Fatalf("Genetics = %+v, want q2 wrong, missed twice", genetics)
	}
	wrong := list(QuestionsFilter{Wrong: true})
	if len(wrong) != 1 || wrong[0].QuestionID != "q2" || wrong[0].TopicName != "Genetics" {
		t.Fatalf("wrong = %+v, want q2 under Genetics", wrong)
	}
}

// A class's staff open a member's latest answer from their lists, marked
// (Epo 2026-11-22). A later marking of an older attempt leaves the newer
// answer; a question not answered, or a reader not staff, gets nothing.
func TestMemberAnswerIsTheLatest(t *testing.T) {
	f := newAssignmentFixture(t, "member-answer")
	ctx := context.Background()
	qs := frozenFixture(t)
	check := func(attempt string, pick float64) string {
		t.Helper()
		answers := map[string]any{"p1": []any{pick}}
		graded, _, _ := questions.Graded(qs[0], answers, nil)
		d, err := f.s.CheckQuizQuestion(ctx, f.viewer, f.quiz.ID, QuizCheck{
			AttemptID: attempt, Answers: answers, Question: graded,
			Order: []string{"q1", "q2", "q3"}, Marks: map[string]float64{"q1": 1, "q2": 2, "q3": 3},
		}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return d.ID
	}
	first := check("", 0)
	check("", 1)
	mt, err := f.s.GetMaterial(ctx, f.quiz.ID)
	if err != nil {
		t.Fatal(err)
	}
	old := map[string]any{"p1": []any{float64(0)}}
	graded, _, _ := questions.Graded(qs[0], old, nil)
	if err := f.s.inTx(ctx, func(tx pgx.Tx) error {
		return logAnswerPartsTx(ctx, tx, f.viewer, mt, graded, old, answerSourceQuiz, first, time.Now(), map[string]bool{"p1": true})
	}); err != nil {
		t.Fatal(err)
	}

	got, err := f.s.WorkspaceMemberAnswer(ctx, f.editor, f.ws.ID, f.viewer, f.quiz.ID, "q1")
	if err != nil {
		t.Fatal(err)
	}
	if picked, _ := got.Answers["p1"].([]any); len(picked) != 1 || picked[0] != float64(1) || got.Question["id"] != "q1" {
		t.Fatalf("answer = %+v, want the second check's pick", got)
	}
	if _, err := f.s.WorkspaceMemberAnswer(ctx, f.editor, f.ws.ID, f.viewer, f.quiz.ID, "q2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unanswered question: %v", err)
	}
	if _, err := f.s.WorkspaceMemberAnswer(ctx, f.other, f.ws.ID, f.viewer, f.quiz.ID, "q1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a member read another's answer: %v", err)
	}
}
