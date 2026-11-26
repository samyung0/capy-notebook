package httpapi_test

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/pipeline"
)

// gradedQuizQuestion is one multiple choice question for a graded quiz.
var gradedQuizQuestion = map[string]any{
	"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
	"parts": []map[string]any{{
		"id": "q1:part:1", "blocks": []map[string]any{{"type": "text", "text": "Pick the second"}},
		"answer": map[string]any{"type": "mcq", "options": []string{"a", "b"}, "correct": []int{1}},
		"marks":  1, "solution": []any{},
	}},
}

// gradedQuizForm is the New graded quiz dialog's settings: given to every
// member, due in an hour, marked as marking says.
func gradedQuizForm(title, marking string) map[string]any {
	return map[string]any{
		"kind": "marked", "title": title, "dueAt": time.Now().Add(time.Hour).Format(time.RFC3339),
		"attempts": 1, "noLate": false, "latePenaltyPct": 0, "assignAll": true, "assignees": []string{}, "draft": false,
		"marking": marking, "showAnswers": "submitted", "showGrades": "automatic", "shuffle": false, "files": []any{},
	}
}

// postGradedQuiz makes a quiz of these questions with its graded quiz in one
// request in the seeded workspace, as Create blank does (createMaterial's
// gradedQuiz, Epo 2026-11-16).
func postGradedQuiz(t *testing.T, h http.Handler, user string, questions any, form map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(questions)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := materialdoc.QuizDocument(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	var content map[string]any
	if err := json.Unmarshal([]byte(doc), &content); err != nil {
		t.Fatal(err)
	}
	return doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/materials", user, map[string]any{
		"kind": "quiz", "title": fmt.Sprintf("%s %d", form["title"], time.Now().UnixNano()), "content": content, "gradedQuiz": form,
	})
}

// makeGradedQuiz is postGradedQuiz made, returning the graded quiz's id and its
// quiz's; it is deleted, with its quiz, after the test.
func makeGradedQuiz(t *testing.T, h http.Handler, user string, questions any, form map[string]any) (assignmentID, quizID string) {
	t.Helper()
	rec := postGradedQuiz(t, h, user, questions, form)
	var made struct {
		ID           string `json:"id"`
		AssignmentID string `json:"assignmentId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &made); err != nil || rec.Code != http.StatusCreated || made.AssignmentID == "" {
		t.Fatalf("make a graded quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+made.AssignmentID, "u_owner", nil) })
	return made.AssignmentID, made.ID
}

// TestAssignmentRoutesAuthorize walks the routes as each role, on the seeded
// workspace where u_owner, u_editor and u_viewer are members and u_other is not:
// only the owner's side manages or reads the report, a member is served no keys,
// and a personal workspace has no assignments.
func TestAssignmentRoutesAuthorize(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	const ws = "/api/workspaces/ws_e2e_private"
	setKind := func(kind string) {
		t.Helper()
		if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": kind}); rec.Code != http.StatusOK {
			t.Fatalf("set kind %s: status = %d body=%s", kind, rec.Code, rec.Body.String())
		}
	}
	// A personal workspace has no assignments, and nobody sets one for themself
	// (Epo 2026-11-21).
	task := map[string]any{
		"kind": "unmarked", "title": "Read chapter 4", "attempts": 1, "noLate": false, "latePenaltyPct": 0,
		"assignAll": false, "assignees": []string{"u_owner"}, "draft": false,
		"marking": "ai_approve", "showAnswers": "closed", "showGrades": "automatic", "shuffle": false, "files": []any{},
	}
	if rec := doReq(t, h, http.MethodPost, ws+"/assignments", "u_owner", task); rec.Code != http.StatusNotFound {
		t.Fatalf("an assignment in a personal workspace: status = %d body=%s", rec.Code, rec.Body.String())
	}
	setKind("class")
	t.Cleanup(func() { setKind("personal") })

	// A graded quiz is made with its questions (Epo 2026-11-16): never from a
	// quiz that already exists, and only by the class's staff.
	form := gradedQuizForm("Routes", "ai_approve")
	form["latePenaltyPct"] = 20
	named := maps.Clone(form)
	named["quizId"] = "qz_e2e_private"
	if rec := doReq(t, h, http.MethodPost, ws+"/assignments", "u_editor", named); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("a graded quiz from an existing quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}
	for user, want := range map[string]int{"u_viewer": http.StatusForbidden, "u_other": http.StatusNotFound} {
		if rec := postGradedQuiz(t, h, user, []any{gradedQuizQuestion}, form); rec.Code != want {
			t.Fatalf("%s makes a graded quiz: status = %d body=%s", user, rec.Code, rec.Body.String())
		}
	}
	task["assignees"] = []string{"u_viewer"}
	if rec := doReq(t, h, http.MethodPost, ws+"/assignments", "u_viewer", task); rec.Code != http.StatusNotFound {
		t.Fatalf("a viewer's assignment for themself: status = %d body=%s", rec.Code, rec.Body.String())
	}
	assignmentID, quizID := makeGradedQuiz(t, h, "u_editor", []any{gradedQuizQuestion}, form)
	path := "/api/assignments/" + assignmentID

	for _, user := range []string{"u_viewer", "u_other"} {
		for _, call := range []struct {
			method, path string
			body         any
		}{
			{http.MethodGet, path + "/report", nil},
			{http.MethodPut, path + "/closed", map[string]any{"closed": true}},
			{http.MethodPost, path + "/publish", map[string]any{}},
			{http.MethodPost, path + "/republish", map[string]any{}},
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

	// While it is open its assignee gets neither the quiz nor a key, and no
	// viewer clones in a class; staff do.
	quizPath := "/api/quizzes/" + quizID
	check := map[string]any{"questionId": "q1", "answers": map[string]any{"q1:part:1": []int{1}}}
	if rec := doReq(t, h, http.MethodGet, quizPath, "u_viewer", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("the assignee reads the quiz: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPost, quizPath+"/check", "u_viewer", check); rec.Code != http.StatusNotFound {
		t.Fatalf("the assignee checks the quiz: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodGet, quizPath, "u_editor", nil); rec.Code != http.StatusOK {
		t.Fatalf("staff read the quiz: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPost, ws+"/clone", "u_viewer", map[string]any{"name": "Copy"}); rec.Code != http.StatusNotFound {
		t.Fatalf("a class viewer clones: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPost, "/api/materials/"+quizID+"/clone", "u_viewer", map[string]any{"title": "Copy"}); rec.Code != http.StatusNotFound {
		t.Fatalf("a class viewer clones the quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPut, path+"/closed", "u_owner", map[string]any{"closed": true}); rec.Code != http.StatusOK {
		t.Fatalf("close: status = %d body=%s", rec.Code, rec.Body.String())
	}
	// The graded quiz owns its quiz: closing does not show it to members.
	if rec := doReq(t, h, http.MethodGet, quizPath, "u_viewer", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("after closing the member reads the quiz: status = %d", rec.Code)
	}
}

// TestClosingTellsWhoIsTakingIt (Epo 2026-11-05): closing tells a member with an
// attempt running, with the assignment's id alone; nobody hears a reopen, and a
// member with nothing running hears nothing.
func TestClosingTellsWhoIsTakingIt(t *testing.T) {
	url := os.Getenv("CAPY_GO_TEST_REDIS_URL")
	if url == "" {
		t.Skip("run with pnpm test:go for disposable Redis")
	}
	options, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(options)
	t.Cleanup(func() { _ = rdb.Close() })
	sub := rdb.Subscribe(t.Context(), "notif:u_viewer", "notif:u_other")
	t.Cleanup(func() { _ = sub.Close() })
	if _, err := sub.Receive(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err := sub.Receive(t.Context()); err != nil {
		t.Fatal(err)
	}
	h, _, _, _ := openInternalHTTPWithRedis(t, pipeline.New("http://127.0.0.1:1", ""), rdb, nil)
	path := startedAssignment(t, h)

	setClosed := func(closed bool) {
		t.Helper()
		if rec := doReq(t, h, http.MethodPut, path+"/closed", "u_owner", map[string]any{"closed": closed}); rec.Code != http.StatusOK {
			t.Fatalf("closed %v: status = %d body=%s", closed, rec.Code, rec.Body.String())
		}
	}
	// To do's own refetch event goes to members too (Epo 2026-11-08); this
	// test listens for the assignment's.
	next := func(wait time.Duration) *redis.Message {
		t.Helper()
		deadline := time.After(wait)
		for {
			select {
			case msg := <-sub.Channel():
				if msg.Payload == `{"type":"todo"}` {
					continue
				}
				return msg
			case <-deadline:
				return nil
			}
		}
	}
	id := strings.TrimPrefix(path, "/api/assignments/")
	setClosed(false)
	if rec := doReq(t, h, http.MethodPost, path+"/republish", "u_owner", map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("republish: status = %d body=%s", rec.Code, rec.Body.String())
	}
	msg := next(5 * time.Second)
	if msg == nil {
		t.Fatal("the member taking it heard no republish")
	}
	if want := fmt.Sprintf(`{"type":"assignment_republished","assignmentId":%q}`, id); msg.Channel != "notif:u_viewer" || msg.Payload != want {
		t.Fatalf("heard %s on %s", msg.Payload, msg.Channel)
	}
	setClosed(true)
	msg = next(5 * time.Second)
	if msg == nil {
		t.Fatal("the member taking it heard nothing")
	}
	if want := fmt.Sprintf(`{"type":"assignment_closed","assignmentId":%q}`, id); msg.Channel != "notif:u_viewer" || msg.Payload != want {
		t.Fatalf("heard %s on %s", msg.Payload, msg.Channel)
	}
	if msg := next(200 * time.Millisecond); msg != nil {
		t.Fatalf("heard a second event: %s on %s", msg.Payload, msg.Channel)
	}
}

// TestAClosingNobodyHearsStillCloses (Epo 2026-11-05): the event is best effort, so
// a stream service that is down leaves the close as it was.
func TestAClosingNobodyHearsStillCloses(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", MaxRetries: -1})
	t.Cleanup(func() { _ = rdb.Close() })
	h, _, _, _ := openInternalHTTPWithRedis(t, pipeline.New("http://127.0.0.1:1", ""), rdb, nil)
	path := startedAssignment(t, h)
	rec := doReq(t, h, http.MethodPut, path+"/closed", "u_owner", map[string]any{"closed": true})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"closed":true`) {
		t.Fatalf("closing: status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// startedAssignment makes an assignment of a new quiz in the seeded class with
// u_viewer's attempt running, and returns its path.
func startedAssignment(t *testing.T, h http.Handler) string {
	t.Helper()
	const ws = "/api/workspaces/ws_e2e_private"
	setKind := func(kind string) {
		t.Helper()
		if rec := doReq(t, h, http.MethodPatch, ws, "u_owner", map[string]any{"kind": kind}); rec.Code != http.StatusOK {
			t.Fatalf("set kind %s: status = %d body=%s", kind, rec.Code, rec.Body.String())
		}
	}
	setKind("class")
	t.Cleanup(func() { setKind("personal") })
	assignmentID, _ := makeGradedQuiz(t, h, "u_owner", []any{gradedQuizQuestion}, gradedQuizForm("Closing", "ai_approve"))
	path := "/api/assignments/" + assignmentID
	if rec := doReq(t, h, http.MethodPost, path+"/start", "u_viewer", map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("a member starts: status = %d body=%s", rec.Code, rec.Body.String())
	}
	return path
}
