package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// markingAssignment gives an open-part quiz to the seeded class's members.
func markingAssignment(t *testing.T, h http.Handler) string {
	t.Helper()
	const ws = "/api/workspaces/ws_e2e_private"
	if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "class"}); rec.Code != http.StatusOK {
		t.Fatalf("set kind: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "personal"}) })
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Marking %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "q1:part:1", "blocks": []map[string]any{{"type": "text", "text": "Explain."}},
				"answer": map[string]any{"type": "open", "accepted": []string{}, "hints": []string{}}, "marks": 2,
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
	rec := doReq(t, h, http.MethodPost, ws+"/assignments", "u_owner", map[string]any{
		"kind": "marked", "title": "Marking", "quizId": made.ID, "dueAt": time.Now().Add(time.Hour).Format(time.RFC3339),
		"attempts": 1, "noLate": false, "latePenaltyPct": 20, "assignAll": true, "assignees": []string{}, "draft": false,
		"approveAiMarks": true, "showAnswers": true, "shuffle": false, "files": []any{},
	})
	if rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("create assignment: status = %d body=%s", rec.Code, rec.Body.String())
	}
	var assignment struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &assignment)
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+assignment.ID, "u_owner", nil) })
	return assignment.ID
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
	h, _, calls := openGradingAPI(t, "full")
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
