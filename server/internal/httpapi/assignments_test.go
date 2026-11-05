package httpapi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

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
		"attempts": 1, "noLate": false, "latePenaltyPct": 20, "assignAll": true, "assignees": []string{}, "draft": false,
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

	// While it is open its assignee gets neither the quiz nor a key, and no
	// viewer clones in a class; staff do.
	quizPath := "/api/quizzes/" + made.ID
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
	if rec := doReq(t, h, http.MethodPost, "/api/materials/"+made.ID+"/clone", "u_viewer", map[string]any{"title": "Copy"}); rec.Code != http.StatusNotFound {
		t.Fatalf("a class viewer clones the quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodPut, path+"/closed", "u_owner", map[string]any{"closed": true}); rec.Code != http.StatusOK {
		t.Fatalf("close: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doReq(t, h, http.MethodGet, quizPath, "u_viewer", nil); rec.Code != http.StatusOK {
		t.Fatalf("after closing the member reads the quiz: status = %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPost, quizPath+"/check", "u_viewer", check); rec.Code != http.StatusOK {
		t.Fatalf("after closing the member checks the quiz: status = %d body=%s", rec.Code, rec.Body.String())
	}

	// The notice, told once.
	notice := func(user string) bool {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, ws+"/sharing-notice", user, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("notice for %s: status = %d", user, rec.Code)
		}
		var got struct {
			Due bool `json:"due"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Due
	}
	if notice("u_owner") || notice("u_other") {
		t.Fatal("the notice is due someone who shares nothing")
	}
	if rec := doReq(t, h, http.MethodPut, ws+"/sharing-notice", "u_viewer", nil); rec.Code != http.StatusNoContent {
		t.Fatalf("mark the notice: status = %d", rec.Code)
	}
	if notice("u_viewer") {
		t.Fatal("the notice shows twice")
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
	setClosed(false)
	setClosed(true)
	select {
	case msg := <-sub.Channel():
		want := fmt.Sprintf(`{"type":"assignment_closed","assignmentId":%q}`, strings.TrimPrefix(path, "/api/assignments/"))
		if msg.Channel != "notif:u_viewer" || msg.Payload != want {
			t.Fatalf("heard %s on %s", msg.Payload, msg.Channel)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the member taking it heard nothing")
	}
	select {
	case msg := <-sub.Channel():
		t.Fatalf("heard a second event: %s on %s", msg.Payload, msg.Channel)
	case <-time.After(200 * time.Millisecond):
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
	quiz := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": fmt.Sprintf("Closing %d", time.Now().UnixNano()), "workspaceId": "ws_e2e_private", "topics": []string{},
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
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/quizzes/"+made.ID, "u_owner", nil) })
	created := doReq(t, h, http.MethodPost, ws+"/assignments", "u_owner", map[string]any{
		"kind": "marked", "title": "Closing", "quizId": made.ID, "dueAt": time.Now().Add(time.Hour).Format(time.RFC3339),
		"attempts": 1, "noLate": false, "latePenaltyPct": 0, "assignAll": true, "assignees": []string{}, "draft": false,
		"approveAiMarks": true, "showAnswers": true, "shuffle": false, "files": []any{},
	})
	if created.Code != http.StatusCreated && created.Code != http.StatusOK {
		t.Fatalf("create assignment: status = %d body=%s", created.Code, created.Body.String())
	}
	var assignment struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &assignment); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { doReq(t, h, http.MethodDelete, "/api/assignments/"+assignment.ID, "u_owner", nil) })
	path := "/api/assignments/" + assignment.ID
	if rec := doReq(t, h, http.MethodPost, path+"/start", "u_viewer", map[string]any{}); rec.Code != http.StatusOK {
		t.Fatalf("a member starts: status = %d body=%s", rec.Code, rec.Body.String())
	}
	return path
}
