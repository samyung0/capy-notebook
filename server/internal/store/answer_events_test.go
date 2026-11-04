package store

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// q1 has a true/false part and an open part, q2 one true/false part.
const answerEventQuestions = `[
 {"id":"q1","stem":[],"parts":[
  {"id":"q1:a","blocks":[{"type":"text","text":"Cells have membranes?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]},
  {"id":"q1:b","blocks":[{"type":"text","text":"What does a membrane do?"}],"answer":{"type":"open","accepted":["It separates the cell"],"hints":[]},"marks":2,
   "markscheme":[{"text":"Separates the cell","marks":2}],"solution":[]}],"layout":"paper","labels":"letters"},
 {"id":"q2","stem":[],"parts":[{"id":"q2:a","blocks":[{"type":"text","text":"Ribosomes have membranes?"}],"answer":{"type":"boolean","correct":false},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}
]`

// Every graded part of a checked question is logged with its marks, grader,
// source, attempt and workspace. A wholly blank question logs nothing, but a
// later check of it knows its key was shown. Deleting the quiz keeps them.
func TestAnswerEventsLogGradedParts(t *testing.T) {
	f := newStudyFixture(t, "u_answer_events")
	ctx := context.Background()
	var qs []map[string]any
	if err := json.Unmarshal([]byte(answerEventQuestions), &qs); err != nil {
		t.Fatal(err)
	}
	q1Answers := map[string]any{"q1:a": true, "q1:b": "It keeps the cell apart"}
	// The model gives the open part 1.5 of its 2 marks.
	grade := func(q map[string]any, answers map[string]any) map[string]any {
		graded, _, _ := questions.Graded(q, answers, map[string][]float64{"q1:b": {1.5}})
		return graded
	}
	check := func(quizID, attemptID string, q map[string]any, answers map[string]any) AttemptDetail {
		t.Helper()
		d, err := f.s.CheckQuizQuestion(ctx, f.user, quizID, QuizCheck{
			AttemptID: attemptID, Answers: answers, Question: grade(q, answers),
			Order: []string{"q1", "q2"}, Marks: map[string]float64{"q1": 3, "q2": 1},
		}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	events := func(materialID string) []string {
		t.Helper()
		rows, err := f.s.pool.Query(ctx, `SELECT question_id, part_id, answer_type, grader, source, awarded, marks,
				key_seen, COALESCE(attempt_id, '-'), COALESCE(workspace_id, '-')
			FROM answer_events WHERE user_id=$1 AND material_id=$2 ORDER BY id`, f.user, materialID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var question, part, kind, grader, source, attempt, workspace string
			var awarded, marks float64
			var seen bool
			if err := rows.Scan(&question, &part, &kind, &grader, &source, &awarded, &marks, &seen, &attempt, &workspace); err != nil {
				t.Fatal(err)
			}
			out = append(out, fmt.Sprintf("%s %s %s %s %s %g/%g seen=%v %s %s", question, part, kind, grader, source, awarded, marks, seen, attempt, workspace))
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}

	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: json.RawMessage(answerEventQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	// One attempt answers q1 and checks q2 blank; the next answers q2.
	first := check(quiz.ID, "", qs[0], q1Answers)
	check(quiz.ID, first.ID, qs[1], map[string]any{})
	second := check(quiz.ID, "", qs[1], map[string]any{"q2:a": false})
	// A review check of q1, as POST /api/review/check sends it.
	score := 2.5 / 3
	if err := f.s.RateItem(ctx, f.user, Rating{MaterialID: quiz.ID, ItemID: "q1", Score: &score,
		Graded: grade(qs[0], q1Answers), Answers: q1Answers}, time.Now()); err != nil {
		t.Fatal(err)
	}
	ws := f.ws.ID
	want := []string{
		"q1 q1:a boolean deterministic quiz 1/1 seen=false " + first.ID + " " + ws,
		"q1 q1:b open ai quiz 1.5/2 seen=false " + first.ID + " " + ws,
		"q2 q2:a boolean deterministic quiz 1/1 seen=true " + second.ID + " " + ws,
		"q1 q1:a boolean deterministic review 1/1 seen=true - " + ws,
		"q1 q1:b open ai review 1.5/2 seen=true - " + ws,
	}
	if got := events(quiz.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("events =\n%q\nwant\n%q", got, want)
	}
	// The item hash is the one FSRS rates against.
	if n := f.count(t, `SELECT count(*) FROM answer_events e JOIN review_states rs
		ON rs.user_id=e.user_id AND rs.material_id=e.material_id AND rs.item_id=e.question_id AND rs.item_hash=e.item_hash
		WHERE e.material_id=$1`, quiz.ID); n != 5 {
		t.Fatalf("events matching the rated hash = %d, want 5", n)
	}
	if n := f.count(t, `SELECT count(*) FROM attempts WHERE material_id=$1 AND workspace_id=$2`, quiz.ID, ws); n != 2 {
		t.Fatalf("attempts in the workspace = %d, want 2", n)
	}

	// A standalone quiz's attempt and events have no workspace.
	standalone, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Alone", Questions: json.RawMessage(answerEventQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	alone := check(standalone.ID, "", qs[0], q1Answers)
	want = []string{
		"q1 q1:a boolean deterministic quiz 1/1 seen=false " + alone.ID + " -",
		"q1 q1:b open ai quiz 1.5/2 seen=false " + alone.ID + " -",
	}
	if got := events(standalone.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("standalone events =\n%q\nwant\n%q", got, want)
	}
	if n := f.count(t, `SELECT count(*) FROM attempts WHERE id=$1 AND workspace_id IS NULL`, alone.ID); n != 1 {
		t.Fatalf("standalone attempt with a workspace")
	}

	// Deleting the quiz keeps its events, with no material.
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM materials WHERE id=$1`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, `SELECT count(*) FROM answer_events WHERE user_id=$1 AND material_id IS NULL`, f.user); n != 5 {
		t.Fatalf("events after the quiz is deleted = %d, want 5", n)
	}

	// An account purge deletes them.
	if _, err := f.s.RequestAccountDeletion(ctx, f.user, true); err != nil {
		t.Fatal(err)
	}
	if err := f.s.PurgeUser(ctx, f.user); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, `SELECT count(*) FROM answer_events WHERE user_id=$1`, f.user); n != 0 {
		t.Fatalf("answer events after purge = %d", n)
	}
}
