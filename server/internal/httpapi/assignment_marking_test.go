package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/httpapi"
)

// markingAssignment gives a quiz of open parts to the seeded class's members.
func markingAssignment(t *testing.T, h http.Handler, texts ...string) string {
	t.Helper()
	if len(texts) == 0 {
		texts = []string{"Explain."}
	}
	parts := make([]map[string]any, len(texts))
	for i, text := range texts {
		parts[i] = map[string]any{
			"id": fmt.Sprintf("q1:part:%d", i+1), "blocks": []map[string]any{{"type": "text", "text": text}},
			"answer": map[string]any{"type": "open", "accepted": []string{}}, "marks": 2,
			"markscheme": []map[string]any{{"text": "Point one", "marks": 2}}, "solution": []any{},
		}
	}
	const ws = "/api/workspaces/ws_e2e_private"
	if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "class"}); rec.Code != http.StatusOK {
		t.Fatalf("set kind: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "personal"}) })
	form := gradedQuizForm("Marking", "ai_approve")
	form["latePenaltyPct"] = 20
	assignmentID, _ := makeGradedQuiz(t, h, "u_owner", []map[string]any{{
		"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
		"parts": parts,
	}}, form)
	return assignmentID
}

type markingReport struct {
	Answers []struct {
		Waiting, AIMarked bool
		AttemptID         string
	}
}

func waitForAIMark(t *testing.T, h http.Handler, id string) markingReport {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		rec := doReq(t, h, http.MethodGet, "/api/assignments/"+id+"/report", "u_owner", nil)
		var report markingReport
		_ = json.Unmarshal(rec.Body.Bytes(), &report)
		if len(report.Answers) > 0 && report.Answers[0].AIMarked {
			return report
		}
		if time.Now().After(deadline) {
			t.Fatalf("no AI mark: %s", rec.Body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func settledCalls(calls *atomic.Int32) int32 {
	time.Sleep(300 * time.Millisecond)
	return calls.Load()
}

// A submit marks its open answers in the background, once however often it is
// repeated, and Mark with AI finds nothing left to pay for. Only staff run it or
// approve, and Approve all makes the marks count.
func TestAssignmentSubmitMarksOnceInTheBackground(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	id := markingAssignment(t, h)
	run := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/start", "u_viewer", map[string]any{})
	if run.Code != http.StatusOK && run.Code != http.StatusCreated {
		t.Fatalf("start: status = %d body=%s", run.Code, run.Body.String())
	}
	var attempt struct{ ID string }
	_ = json.Unmarshal(run.Body.Bytes(), &attempt)
	submit := func() {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attempt.ID+"/submit", "u_viewer",
			map[string]any{"answers": map[string]any{"q1:part:1": "Because of reasons."}})
		if rec.Code != http.StatusOK {
			t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
		}
	}
	submit()
	waitForAIMark(t, h, id)
	marked := settledCalls(calls)
	if marked != 1 {
		t.Fatalf("model calls = %d, want one", marked)
	}
	// The member attempting pays, not the owner, and the session settles (Epo 2026-11-08).
	var payer, status string
	if err := st.Pool().QueryRow(context.Background(), `SELECT actor_user_id, status FROM provider_sessions
		WHERE surface='quiz' AND workspace_id='ws_e2e_private' ORDER BY created_at DESC LIMIT 1`).Scan(&payer, &status); err != nil {
		t.Fatal(err)
	}
	if payer != "u_viewer" || status != "settled" {
		t.Fatalf("session paid by %s, %s", payer, status)
	}
	submit()
	if rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/mark-with-ai", "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("mark with AI: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if again := settledCalls(calls); again != marked {
		t.Fatalf("model calls = %d after repeats, want %d", again, marked)
	}

	for _, path := range []string{"/mark-with-ai", "/approve-ai-marks"} {
		rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+path, "u_viewer", map[string]any{"questionId": "q1"})
		if rec.Code < 400 || rec.Code >= 500 {
			t.Fatalf("a member at %s: status = %d", path, rec.Code)
		}
	}
	rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/approve-ai-marks", "u_owner", map[string]any{"questionId": "q1"})
	if rec.Code != http.StatusOK {
		t.Fatalf("approve: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var approved struct{ Approved int }
	_ = json.Unmarshal(rec.Body.Bytes(), &approved)
	if approved.Approved != 1 {
		t.Fatalf("approved = %d", approved.Approved)
	}
}

// Regrade with AI grades one approved answer again on the teacher's credits,
// whoever paid for the submission's (Epo 2026-11-23).
func TestRegradeRunsOnTheTeachersCredits(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	id := markingAssignment(t, h)
	attempt := startAndSubmit(t, h, id, map[string]any{"q1:part:1": "Because of reasons."})
	waitForAIMark(t, h, id)
	if rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/approve-ai-marks", "u_owner", map[string]any{"questionId": "q1"}); rec.Code != http.StatusOK {
		t.Fatalf("approve: status = %d body=%s", rec.Code, rec.Body.String())
	}
	before := settledCalls(calls)
	if rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attempt+"/regrade", "u_owner", map[string]any{"questionId": "q1"}); rec.Code != http.StatusOK {
		t.Fatalf("regrade: status = %d body=%s", rec.Code, rec.Body.String())
	}
	waitForAIMark(t, h, id)
	if made := settledCalls(calls); made != before+1 {
		t.Fatalf("model calls = %d, want %d", made, before+1)
	}
	var payer string
	if err := st.Pool().QueryRow(context.Background(), `SELECT actor_user_id FROM provider_sessions
		WHERE surface='quiz' AND workspace_id='ws_e2e_private' ORDER BY created_at DESC LIMIT 1`).Scan(&payer); err != nil {
		t.Fatal(err)
	}
	if payer != "u_owner" {
		t.Fatalf("the regrade was paid by %s", payer)
	}
}

func startAndSubmit(t *testing.T, h http.Handler, id string, answers map[string]any) string {
	t.Helper()
	run := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/start", "u_viewer", map[string]any{})
	if run.Code != http.StatusOK && run.Code != http.StatusCreated {
		t.Fatalf("start: status = %d body=%s", run.Code, run.Body.String())
	}
	var attempt struct{ ID string }
	_ = json.Unmarshal(run.Body.Bytes(), &attempt)
	rec := doReq(t, h, http.MethodPost, "/api/assignment-attempts/"+attempt.ID+"/submit", "u_viewer", map[string]any{"answers": answers})
	if rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	return attempt.ID
}

// An attempt's time running out keeps the marks already paid for: what is left
// stays Not marked for Mark with AI. Its first four parts share a call; the
// fifth, whose call never answers, is left.
func TestMarkingKeepsPaidMarksWhenItsTimeRunsOut(t *testing.T) {
	httpapi.SetMarkingAttemptTimeout(t, 400*time.Millisecond)
	h, _, _ := openGradingAPI(t, "slow-part")
	id := markingAssignment(t, h, "One.", "Two.", "Three.", "Four.", "Slow part.")
	attempt := startAndSubmit(t, h, id, fiveAnswers())
	parts := waitForMarks(t, h, attempt, "q1:part:1")
	if parts["q1:part:5"]["aiAwards"] != nil || parts["q1:part:5"]["pending"] != true {
		t.Fatalf("the part with no answer = %+v", parts["q1:part:5"])
	}
}

// An assignment's typed parts are graded four to a call (Epo 2026-11-23).
func TestMarkingGradesFourPartsACall(t *testing.T) {
	h, _, calls := openGradingAPI(t, "full")
	id := markingAssignment(t, h, "One.", "Two.", "Three.", "Four.", "Five.")
	attempt := startAndSubmit(t, h, id, fiveAnswers())
	parts := waitForMarks(t, h, attempt, "q1:part:1", "q1:part:5")
	if parts["q1:part:3"]["aiAwards"] == nil {
		t.Fatalf("a part was left: %+v", parts["q1:part:3"])
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("five parts took %d calls, want 2", got)
	}
}

func fiveAnswers() map[string]any {
	answers := map[string]any{}
	for i := 1; i <= 5; i++ {
		answers[fmt.Sprintf("q1:part:%d", i)] = "An answer."
	}
	return answers
}

// waitForMarks polls the attempt until the AI has marked every part named.
func waitForMarks(t *testing.T, h http.Handler, attempt string, ids ...string) map[string]map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		rec := doReq(t, h, http.MethodGet, "/api/assignment-attempts/"+attempt, "u_owner", nil)
		var got struct {
			Questions []map[string]any `json:"questions"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		parts := gradedParts(t, got.Questions)
		marked := true
		for _, id := range ids {
			marked = marked && parts[id]["aiAwards"] != nil
		}
		if marked {
			return parts
		}
		if time.Now().After(deadline) {
			t.Fatalf("the marks never came: %s", rec.Body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A stack with no pipeline, like the e2e stack, has nothing to mark with: the
// member's submit goes through and the answer stays Not marked.
func TestSubmitWithNoPipelineStaysNotMarked(t *testing.T) {
	h, _, _ := openGradingAPI(t, "no-pipeline")
	id := markingAssignment(t, h)
	attempt := startAndSubmit(t, h, id, map[string]any{"q1:part:1": "One."})
	settledCalls(new(atomic.Int32))
	rec := doReq(t, h, http.MethodGet, "/api/assignment-attempts/"+attempt, "u_owner", nil)
	var got struct {
		Questions []map[string]any `json:"questions"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if part := gradedParts(t, got.Questions)["q1:part:1"]; part["pending"] != true {
		t.Fatalf("part = %+v", part)
	}
}

// A failed grade leaves the answer waiting with Grade Error on the owner's row,
// counted as not graded among the answers waiting (mock T3); Mark with AI still
// runs, on the caller's credits, and a frozen caller is refused.
func TestFailedGradeShowsGradeError(t *testing.T) {
	h, st, _ := openGradingAPI(t, "fail")
	id := markingAssignment(t, h)
	startAndSubmit(t, h, id, map[string]any{"q1:part:1": "One."})
	row := waitForAIError(t, h, id)
	if row.AIError != "error" || !row.Waiting || row.AIMarked {
		t.Fatalf("row = %+v", row)
	}
	if manage := assignmentManage(t, h, id); manage.NotGraded != 1 || manage.ToApprove != 1 {
		t.Fatalf("counts = %+v", manage)
	}
	if rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+"/mark-with-ai", "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("mark with AI: status = %d body=%s", rec.Code, rec.Body.String())
	}
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id='u_editor'`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(ctx, `UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id='u_editor'`)
	})
	for _, path := range []string{"/mark-with-ai", "/approve-ai-marks"} {
		rec := doReq(t, h, http.MethodPost, "/api/assignments/"+id+path, "u_editor", map[string]any{"questionId": "q1"})
		if rec.Code < 400 || rec.Code >= 500 {
			t.Fatalf("a suspended editor at %s: status = %d", path, rec.Code)
		}
	}
}

// A member with no credits left submits all the same; their answer waits with
// No credits on the owner's row, and the owner's credits are never touched.
func TestNoCreditsLeavesTheAnswerNotGraded(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	ctx := context.Background()
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_credits (user_id, used_micros, purchased_micros)
		VALUES ('u_viewer', 1000000000000000, 0)
		ON CONFLICT (user_id) DO UPDATE SET used_micros=EXCLUDED.used_micros, purchased_micros=0`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM user_credits WHERE user_id='u_viewer'`)
	})
	id := markingAssignment(t, h)
	startAndSubmit(t, h, id, map[string]any{"q1:part:1": "One."})
	if row := waitForAIError(t, h, id); row.AIError != "credits" {
		t.Fatalf("row = %+v", row)
	}
	if made := calls.Load(); made != 0 {
		t.Fatalf("%d model calls with no credits", made)
	}
}

type answerRow struct {
	Waiting, AIMarked bool
	AIError           string
}

func waitForAIError(t *testing.T, h http.Handler, id string) answerRow {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		rec := doReq(t, h, http.MethodGet, "/api/assignments/"+id+"/report", "u_owner", nil)
		var report struct{ Answers []answerRow }
		_ = json.Unmarshal(rec.Body.Bytes(), &report)
		// Every question's answers are listed (Epo 2026-11-19): the reason is on
		// the row the AI couldn't grade, whichever it is.
		for _, row := range report.Answers {
			if row.AIError != "" {
				return row
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no reason on the row: %s", rec.Body.String())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func assignmentManage(t *testing.T, h http.Handler, id string) struct{ ToApprove, NotGraded int } {
	t.Helper()
	rec := doReq(t, h, http.MethodGet, "/api/assignments/"+id, "u_owner", nil)
	var got struct {
		Manage struct{ ToApprove, NotGraded int }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Manage
}

// A part left Not marked joins no review, on a quiz check or a review check; once
// checked again and marked, it does.
func TestNotMarkedJoinsNoReview(t *testing.T) {
	h, st, _ := openGradingAPI(t, "fail-once")
	ctx := context.Background()
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Not marked %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "open", "blocks": []map[string]any{{"type": "text", "text": "Explain."}},
				"answer": map[string]any{"type": "open", "accepted": []string{}}, "marks": 2,
				"markscheme": []map[string]any{{"text": "Point one", "marks": 2}}, "solution": []any{},
			}},
		}},
	})
	if quiz.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", quiz.Code, quiz.Body.String())
	}
	var made struct{ ID string }
	_ = json.Unmarshal(quiz.Body.Bytes(), &made)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil) })
	reviews := func() int {
		t.Helper()
		var n int
		if err := st.Pool().QueryRow(ctx, `SELECT count(*) FROM review_states WHERE user_id='u_owner' AND material_id=$1`, made.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	first := doReq(t, h, http.MethodPost, "/api/quizzes/"+made.ID+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{"open": "Because."},
	})
	if first.Code != http.StatusOK {
		t.Fatalf("check: status = %d body=%s", first.Code, first.Body.String())
	}
	if n := reviews(); n != 0 {
		t.Fatalf("a Not marked part made %d reviews", n)
	}
	var attempt struct{ ID string }
	_ = json.Unmarshal(first.Body.Bytes(), &attempt)
	again := doReq(t, h, http.MethodPost, "/api/quizzes/"+made.ID+"/check", "u_owner", map[string]any{
		"questionId": "q1", "answers": map[string]any{}, "attemptId": attempt.ID,
	})
	if again.Code != http.StatusOK {
		t.Fatalf("check again: status = %d body=%s", again.Code, again.Body.String())
	}
	if n := reviews(); n != 1 {
		t.Fatalf("after marking, reviews = %d", n)
	}
}

// A review check with nothing to mark it rates nothing, and still answers.
func TestReviewCheckLeavesNotMarkedUnrated(t *testing.T) {
	h, st, _ := openGradingAPI(t, "fail")
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Not marked review %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "open", "blocks": []map[string]any{{"type": "text", "text": "Explain."}},
				"answer": map[string]any{"type": "open", "accepted": []string{}}, "marks": 2,
				"markscheme": []map[string]any{{"text": "Point one", "marks": 2}}, "solution": []any{},
			}},
		}},
	})
	if quiz.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", quiz.Code, quiz.Body.String())
	}
	var made struct{ ID string }
	_ = json.Unmarshal(quiz.Body.Bytes(), &made)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil) })
	rec := doReq(t, h, http.MethodPost, "/api/review/check", "u_owner", map[string]any{
		"materialId": made.ID, "itemId": "q1", "answers": map[string]any{"open": "Because."},
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"pending":true`) {
		t.Fatalf("review check: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var n int
	if err := st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM review_states WHERE user_id='u_owner' AND material_id=$1`, made.ID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("reviews = %d", n)
	}
}
