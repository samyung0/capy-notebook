package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Reading to view or study never sends keys, whoever reads; editing sends them
// to whoever may edit.
func TestQuizReadsAreAnswerFreeOutsideEditing(t *testing.T) {
	h := openShareHTTP(t)
	for _, tc := range []struct {
		name, user, path string
		status           int
		keys             bool
	}{
		{"owner viewing", "u_owner", "/api/quizzes/qz_e2e_private", 200, false},
		{"editor viewing", "u_editor", "/api/quizzes/qz_e2e_private", 200, false},
		{"workspace viewer", "u_viewer", "/api/quizzes/qz_e2e_private", 200, false},
		{"link visitor", "u_other", "/api/quizzes/qz_e2e_link", 200, false},
		{"owner editing", "u_owner", "/api/quizzes/qz_e2e_private/edit", 200, true},
		{"editor editing", "u_editor", "/api/quizzes/qz_e2e_private/edit", 200, true},
		{"workspace viewer editing", "u_viewer", "/api/quizzes/qz_e2e_private/edit", 404, false},
		{"link visitor editing", "u_other", "/api/quizzes/qz_e2e_link/edit", 404, false},
		{"owner's workspace material", "u_owner", "/api/materials/qz_e2e_private", 200, false},
		{"viewer's workspace material", "u_viewer", "/api/materials/qz_e2e_private", 200, false},
		{"explore", "u_other", "/api/explore/quizzes", 200, false},
		{"signed out", "", "/api/public/quizzes/" + store.ShareToken(nil, "qz_e2e_link"), 200, false},
	} {
		rec := doReq(t, h, http.MethodGet, tc.path, tc.user, nil)
		body := rec.Body.String()
		if rec.Code != tc.status || strings.Contains(body, `"correct":`) != tc.keys ||
			(tc.status == 200 && !strings.Contains(body, `"type":"boolean"`)) {
			t.Fatalf("%s: %s → %d %s", tc.name, tc.path, rec.Code, body)
		}
	}
}

// A review session shows questions answer-free; checking one grades it on the
// server, rates it and returns its key. Flashcards keep their button ratings.
func TestReviewSessionChecksQuestionsOnTheServer(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM review_sessions WHERE user_id='u_viewer'`,
			`DELETE FROM attempts WHERE user_id='u_viewer' AND material_id='qz_e2e_private'`,
			`DELETE FROM review_log WHERE user_id='u_viewer' AND material_id='qz_e2e_private'`,
			`DELETE FROM review_states WHERE user_id='u_viewer' AND material_id='qz_e2e_private'`,
			`DELETE FROM study_progress WHERE user_id='u_viewer' AND material_id='qz_e2e_private'`,
		} {
			_, _ = st.Pool().Exec(context.Background(), q)
		}
	})
	const part = "q_priv_1:part:1"
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/qz_e2e_private/attempts", "u_viewer", map[string]any{
		"answers": map[string]any{part: false},
	}); rec.Code != http.StatusCreated || !strings.Contains(rec.Body.String(), `"correct":0,`) {
		t.Fatalf("viewer attempt → %d %s", rec.Code, rec.Body.String())
	}
	rec := doReq(t, h, http.MethodGet, "/api/workspaces/ws_e2e_private/review", "u_viewer", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"itemId":"q_priv_1"`) || strings.Contains(rec.Body.String(), `"correct":`) {
		t.Fatalf("review session → %d %s", rec.Code, rec.Body.String())
	}
	check := func(user string, body map[string]any) *httptest.ResponseRecorder {
		return doReq(t, h, http.MethodPost, "/api/review/check", user, body)
	}
	// The check carries its session, which records the answer and the graded
	// question; the session stays the viewer's own.
	const sessionID = "6f1c2b3a-0d4e-4f5a-8b6c-7d8e9f0a1b2c"
	rec = check("u_viewer", map[string]any{"materialId": "qz_e2e_private", "itemId": "q_priv_1", "answers": map[string]any{part: true},
		"session": map[string]any{"id": sessionID, "workspaceId": "ws_e2e_private", "group": "workspace",
			"items": []any{map[string]any{"materialId": "qz_e2e_private", "itemId": "q_priv_1"}}}})
	var graded struct {
		Correct, Total float64
		Question       map[string]any
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &graded)
	if rec.Code != http.StatusOK || graded.Correct != 1 || graded.Total != 1 {
		t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
	}
	if p := graded.Question["parts"].([]any)[0].(map[string]any); p["awarded"] != 1.0 || p["answer"].(map[string]any)["correct"] != true {
		t.Fatalf("checked question = %v", graded.Question)
	}
	var awarded float64
	if err := st.Pool().QueryRow(context.Background(), `SELECT (graded->'parts'->0->>'awarded')::float FROM review_answers
		WHERE session_id=$1 AND item_id='q_priv_1'`, sessionID).Scan(&awarded); err != nil || awarded != 1 {
		t.Fatalf("recorded answer awarded = %v %v", awarded, err)
	}
	if rec := doReq(t, h, http.MethodGet, "/api/review/sessions/"+sessionID, "u_other", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("another user's resume → %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodGet, "/api/review/sessions", "u_viewer", nil); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), `"quiz":{"correct":1,"total":1}`) {
		t.Fatalf("past reviews → %d %s", rec.Code, rec.Body.String())
	}
	var ratings int
	if err := st.Pool().QueryRow(context.Background(), `SELECT count(*) FROM review_log
		WHERE user_id='u_viewer' AND material_id='qz_e2e_private' AND item_id='q_priv_1'`).Scan(&ratings); err != nil || ratings != 2 {
		t.Fatalf("ratings = %d %v, want the attempt's and the check's", ratings, err)
	}
	for _, tc := range []struct {
		user   string
		body   map[string]any
		status int
	}{
		{"u_viewer", map[string]any{"materialId": "dk_e2e_private", "itemId": "c_e2e_priv_1", "answers": map[string]any{}}, 422},
		{"u_viewer", map[string]any{"materialId": "qz_e2e_private", "itemId": "q_priv_1", "answers": map[string]any{"other": true}}, 422},
		{"u_other", map[string]any{"materialId": "qz_e2e_private", "itemId": "q_priv_1", "answers": map[string]any{}}, 404},
	} {
		if rec := check(tc.user, tc.body); rec.Code != tc.status {
			t.Fatalf("check %v as %s → %d %s", tc.body, tc.user, rec.Code, rec.Body.String())
		}
	}
	// A question's score comes only from a check.
	if rec := doReq(t, h, http.MethodPost, "/api/review/ratings", "u_viewer", map[string]any{
		"materialId": "qz_e2e_private", "itemId": "q_priv_1", "score": 1,
	}); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("browser score → %d", rec.Code)
	}
}

// The chat agent inspects a quiz with its keys only for a user who may edit it.
func TestAgentInspectionHidesQuizKeysFromReaders(t *testing.T) {
	h, st := openInternalHTTP(t)
	question, _ := json.Marshal(map[string]any{"id": "q_priv_1", "stem": []any{}, "layout": "paper", "labels": "letters", "parts": []any{
		map[string]any{"id": "q_priv_1:part:1", "blocks": []any{map[string]any{"type": "text", "text": "Private quiz prompt?"}},
			"answer": map[string]any{"type": "boolean", "correct": true}, "marks": 1, "solution": []any{}},
	}})
	inspection, _ := json.Marshal(map[string]any{"roomSchema": 1, "blocks": []any{map[string]any{
		"id": "qz_e2e_private:quiz", "type": "quiz", "text": "",
		"children": []any{map[string]any{"id": "q_priv_1", "type": "quiz_question", "text": string(question)}},
	}}})
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(inspection)
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	for _, tc := range []struct {
		user string
		keys bool
	}{{"u_viewer", false}, {"u_editor", true}} {
		rec := doInternal(t, h, http.MethodPost, "/api/internal/documents/inspect", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": tc.user,
			"target": map[string]any{"kind": "material", "id": "qz_e2e_private"},
		})
		body := rec.Body.String()
		if rec.Code != http.StatusOK || strings.Contains(body, `\"correct\"`) != tc.keys || !strings.Contains(body, "Private quiz prompt?") {
			t.Fatalf("inspect as %s → %d %s", tc.user, rec.Code, body)
		}
	}
}
