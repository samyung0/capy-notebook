package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// classForTest makes the seeded workspace a class for the test.
func classForTest(t *testing.T, h http.Handler) {
	t.Helper()
	const ws = "/api/workspaces/ws_e2e_private"
	if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "class"}); rec.Code != http.StatusOK {
		t.Fatalf("set kind: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": "personal"}) })
}

// assignmentQuestions reads a graded quiz's frozen question count.
func assignmentQuestions(t *testing.T, h http.Handler, user, id string) int {
	t.Helper()
	rec := doReq(t, h, http.MethodGet, "/api/assignments/"+id, user, nil)
	var got struct {
		Questions int `json:"questions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("read %s: status = %d body=%s", id, rec.Code, rec.Body.String())
	}
	return got.Questions
}

// Generate takes the graded quiz's settings (Epo 2026-11-16): a form refused
// fails before the model is called, and an admitted one makes the quiz with
// its graded quiz, which froze the questions.
func TestGenerateMakesItsGradedQuiz(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"questions":[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Q?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]}`))
	}))
	t.Cleanup(srv.Close)
	h := openShareAPI(t, pipeline.New(srv.URL, ""))
	classForTest(t, h)

	undated := gradedQuizForm("Generated", "ai_approve")
	delete(undated, "dueAt")
	body := generateBody(fmt.Sprintf("Graded generate %d", time.Now().UnixNano()))
	body["gradedQuiz"] = undated
	if rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate", "u_editor", body); rec.Code != http.StatusUnprocessableEntity || calls.Load() != 0 {
		t.Fatalf("an undated graded quiz: status = %d, model calls %d, body=%s", rec.Code, calls.Load(), rec.Body.String())
	}

	body["gradedQuiz"] = gradedQuizForm("Generated", "ai_approve")
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/generate", "u_editor", body)
	var made struct {
		AssignmentID string `json:"assignmentId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &made); err != nil || rec.Code != http.StatusOK || made.AssignmentID == "" {
		t.Fatalf("generate a graded quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+made.AssignmentID, "u_owner", nil) })
	if n := assignmentQuestions(t, h, "u_editor", made.AssignmentID); n != 1 {
		t.Fatalf("its graded quiz froze %d questions", n)
	}
}

// copyQuizToGradedQuiz copies a practice quiz, or a graded quiz's own quiz,
// into a new graded quiz for the workspace's staff (Epo 2026-11-16); a
// viewer is answered not found.
func TestCopyQuizToGradedQuizRoute(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	classForTest(t, h)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	practice := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Practice %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
		"questions": []any{gradedQuizQuestion},
	})
	var source struct{ ID string }
	if err := json.Unmarshal(practice.Body.Bytes(), &source); err != nil || practice.Code != http.StatusCreated {
		t.Fatalf("a practice quiz: status = %d body=%s", practice.Code, practice.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+source.ID, "u_owner", nil) })
	copyOf := func(quizID, user, title string) *httptest.ResponseRecorder {
		t.Helper()
		return doReq(t, h, http.MethodPost, "/api/quizzes/"+quizID+"/graded-copy", user,
			map[string]any{"gradedQuiz": gradedQuizForm(fmt.Sprintf("%s %d", title, time.Now().UnixNano()), "ai_approve")})
	}
	made := func(rec *httptest.ResponseRecorder) string {
		t.Helper()
		var got struct{ ID string }
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || rec.Code != http.StatusCreated {
			t.Fatalf("copy: status = %d body=%s", rec.Code, rec.Body.String())
		}
		t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+got.ID, "u_owner", nil) })
		return got.ID
	}
	if rec := copyOf(source.ID, "u_viewer", "Theirs"); rec.Code != http.StatusNotFound {
		t.Fatalf("a viewer copies: status = %d body=%s", rec.Code, rec.Body.String())
	}

	first := made(copyOf(source.ID, "u_editor", "Term 1"))
	if n := assignmentQuestions(t, h, "u_editor", first); n != 1 {
		t.Fatalf("the copy froze %d questions", n)
	}
	var owned string
	if err := pool.QueryRow(ctx, `SELECT id FROM materials WHERE assignment_id=$1`, first).Scan(&owned); err != nil {
		t.Fatal(err)
	}
	// A graded quiz's own quiz is no practice quiz to start from.
	if rec := copyOf(owned, "u_owner", "Term 2"); rec.Code != http.StatusNotFound {
		t.Fatalf("a graded quiz's quiz copied: status = %d body=%s", rec.Code, rec.Body.String())
	}
}
