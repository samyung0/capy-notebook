package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// TestAssignmentRoutesAuthorize walks the routes as each role, on the seeded
// workspace where u_owner, u_editor and u_viewer are members and u_other is not:
// only the owner's side manages or reads the report, a member is served no keys,
// and a personal workspace answers as if there were none.
func TestAssignmentRoutesAuthorize(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	const ws = "/api/workspaces/ws_e2e_private"
	setKind := func(kind string) {
		t.Helper()
		if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": kind}); rec.Code != http.StatusOK {
			t.Fatalf("set kind %s: status = %d body=%s", kind, rec.Code, rec.Body.String())
		}
	}
	if rec := doReq(t, h, http.MethodGet, ws+"/assignments", "u_owner", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a personal workspace's list: status = %d", rec.Code)
	}
	setKind("class")
	t.Cleanup(func() { setKind("personal") })

	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Assignment routes %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []map[string]any{{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []map[string]any{{
				"id": "q1:part:1", "blocks": []map[string]any{{"type": "text", "text": "Pick the second"}},
				"answer": map[string]any{"type": "mcq", "options": []string{"a", "b"}, "correct": []int{1}},
				"marks":  1, "solution": []any{},
			}},
		}},
	})
	if quiz.Code != http.StatusCreated {
		t.Fatalf("create quiz: status = %d body=%s", quiz.Code, quiz.Body.String())
	}
	var made struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(quiz.Body.Bytes(), &made); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil)
	})
	form := map[string]any{
		"kind": "marked", "title": "Routes", "quizId": made.ID, "dueAt": time.Now().Add(time.Hour).Format(time.RFC3339),
		"attempts": 1, "assignAll": true, "assignees": []string{}, "draft": false,
		"approveAiMarks": true, "showAnswers": true, "shuffle": false, "files": []any{},
	}
	for _, user := range []string{"u_viewer", "u_other"} {
		if rec := doReq(t, h, http.MethodPost, ws+"/assignments", user, form); rec.Code != http.StatusNotFound {
			t.Fatalf("%s creates: status = %d body=%s", user, rec.Code, rec.Body.String())
		}
	}
	created := doReq(t, h, http.MethodPost, ws+"/assignments", "u_editor", form)
	if created.Code != http.StatusCreated {
		t.Fatalf("an editor creates: status = %d body=%s", created.Code, created.Body.String())
	}
	var assignment struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &assignment); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		doReq(t, h, http.MethodDelete, "/api/assignments/"+assignment.ID, "u_owner", nil)
	})
	path := "/api/assignments/" + assignment.ID

	for _, user := range []string{"u_viewer", "u_other"} {
		for _, call := range []struct {
			method, path string
			body         any
		}{
			{http.MethodGet, path + "/report", nil},
			{http.MethodPut, path + "/closed", map[string]any{"closed": true}},
			{http.MethodPost, path + "/publish", map[string]any{}},
			{http.MethodDelete, path, nil},
		} {
			if rec := doReq(t, h, call.method, call.path, user, call.body); rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s %s: status = %d body=%s", user, call.method, call.path, rec.Code, rec.Body.String())
			}
		}
	}
	if rec := doReq(t, h, http.MethodGet, path, "u_other", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a nonmember reads it: status = %d", rec.Code)
	}
	// Not assigned, as an editor isn't under All members.
	if rec := doReq(t, h, http.MethodPost, path+"/start", "u_editor", map[string]any{}); rec.Code != http.StatusNotFound {
		t.Fatalf("an editor starts: status = %d", rec.Code)
	}

	started := doReq(t, h, http.MethodPost, path+"/start", "u_viewer", map[string]any{})
	if started.Code != http.StatusOK {
		t.Fatalf("a member starts: status = %d body=%s", started.Code, started.Body.String())
	}
	if strings.Contains(started.Body.String(), `"correct":[`) {
		t.Fatalf("a running attempt carried its key: %s", started.Body.String())
	}
	var attempt struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(started.Body.Bytes(), &attempt); err != nil {
		t.Fatal(err)
	}
	attemptPath := "/api/assignment-attempts/" + attempt.ID
	if rec := doReq(t, h, http.MethodGet, attemptPath, "u_other", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a nonmember reads the attempt: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPost, attemptPath+"/submit", "u_viewer", map[string]any{
		"answers": map[string]any{"q1:part:1": []int{1}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("submit: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, attemptPath+"/marks", "u_viewer", map[string]any{
		"questionId": "q1", "parts": []any{}, "comment": "",
	}); rec.Code != http.StatusNotFound {
		t.Fatalf("a member changes a mark: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodGet, attemptPath, "u_owner", nil); rec.Code != http.StatusOK {
		t.Fatalf("the owner reads the result: status = %d", rec.Code)
	}
	// The plain attempts route never serves one.
	if rec := doReq(t, h, http.MethodGet, "/api/attempts/"+attempt.ID, "u_viewer", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET /api/attempts: status = %d", rec.Code)
	}
}
