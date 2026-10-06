package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/jev"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// openGradingAPI serves the API with a stub Jev that gives every item the same
// choice: "zero", "partial" or "full".
func openGradingAPI(t *testing.T, choice string) (http.Handler, *store.Store, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body struct {
			Questions map[string]any `json:"questions"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		answers := map[string]any{}
		for key := range body.Questions {
			answers[key] = map[string]any{"choice": choice, "noul": 0.01}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": jev.Model, "answers": answers, "usage": map[string]any{"input_tokens": 1000}})
	}))
	t.Cleanup(srv.Close)
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	reg, err := models.New(ctx, st.Pool())
	if err != nil {
		t.Fatal(err)
	}
	st.SetModelRegistry(reg)
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		E2EAuth: true, E2ESecret: "e2e-test-secret", E2EUserIDs: []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry: reg, Jev: jev.NewForTest("key", srv.URL),
	})
	return h, st, &calls
}

func gradingQuiz(t *testing.T, h http.Handler, privacy string) string {
	t.Helper()
	rec := doReq(t, h, http.MethodPost, "/api/quizzes", "u_owner", map[string]any{
		"name": "Graded", "privacy": privacy,
		"questions": []any{map[string]any{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []any{
				map[string]any{"id": "open-a", "blocks": []any{map[string]any{"type": "text", "text": "Explain."}},
					"answer": map[string]any{"type": "open", "accepted": []any{"Because."}, "hints": []any{}}, "marks": 3,
					"markscheme": []any{map[string]any{"text": "Point one", "marks": 2}, map[string]any{"text": "Point two", "marks": 1}}, "solution": []any{}},
				map[string]any{"id": "closed-b", "blocks": []any{map[string]any{"type": "text", "text": "True?"}},
					"answer": map[string]any{"type": "boolean", "correct": true}, "marks": 1, "solution": []any{}},
				map[string]any{"id": "match-c", "blocks": []any{map[string]any{"type": "text", "text": "Match the capitals."}},
					"answer": map[string]any{"type": "matching", "options": []any{"Paris", "Rome", "Berlin"}, "pairs": []any{
						map[string]any{"left": "France", "right": 0}, map[string]any{"left": "Italy", "right": 1}, map[string]any{"left": "Germany", "right": 2},
					}}, "marks": 2, "solution": []any{map[string]any{"type": "text", "text": "Worked solution."}}},
			},
		}},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create quiz → %d %s", rec.Code, rec.Body.String())
	}
	var quiz struct{ ID string }
	_ = json.Unmarshal(rec.Body.Bytes(), &quiz)
	return quiz.ID
}

// gradedParts reads a graded question list's parts by id.
func gradedParts(t *testing.T, questions []map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, q := range questions {
		for _, raw := range q["parts"].([]any) {
			p := raw.(map[string]any)
			out[p["id"].(string)] = p
		}
	}
	return out
}

// Submitting grades every part on the server, stores what it graded and
// returns the keys: Jev's per-item marks on the open part, the boolean key
// and a matching share rounded down to a half mark.
func TestCreateAttemptGradesOnTheServer(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	id := gradingQuiz(t, h, "private")
	answers := map[string]any{"open-a": "Because of reasons.", "closed-b": true, "match-c": map[string]any{"0": "Paris", "1": "Berlin"}}
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/attempts", "u_owner", map[string]any{"answers": answers})
	if rec.Code != http.StatusCreated {
		t.Fatalf("attempt → %d %s", rec.Code, rec.Body.String())
	}
	var detail struct {
		ID, MaterialID string
		Correct, Total float64
		Questions      []map[string]any
		Answers        map[string]any
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &detail)
	parts := gradedParts(t, detail.Questions)
	if detail.Correct != 4.5 || detail.Total != 6 || detail.Answers["closed-b"] != true ||
		parts["open-a"]["awarded"] != 3.0 || fmt.Sprint(parts["open-a"]["itemAwards"]) != "[2 1]" ||
		parts["closed-b"]["awarded"] != 1.0 || parts["closed-b"]["answer"].(map[string]any)["correct"] != true ||
		parts["match-c"]["awarded"] != 0.5 || fmt.Sprint(parts["match-c"]["itemResults"]) != "[true false false]" ||
		parts["match-c"]["solution"] == nil {
		t.Fatalf("graded attempt = %s", rec.Body.String())
	}
	stored := doReq(t, h, http.MethodGet, "/api/attempts/"+detail.ID, "u_owner", nil)
	if stored.Code != http.StatusOK || !strings.Contains(stored.Body.String(), `"itemResults":[true,false,false]`) || !strings.Contains(stored.Body.String(), `"correct":4.5`) {
		t.Fatalf("stored attempt → %d %s", stored.Code, stored.Body.String())
	}
	var credits, tokens int64
	if err := st.Pool().QueryRow(context.Background(), `SELECT credit_micros, input_tokens FROM usage_events
		WHERE actor_user_id='u_owner' AND surface='quiz' AND provider='typesafe'`).Scan(&credits, &tokens); err != nil {
		t.Fatal(err)
	}
	if credits != 0 || tokens != 1000 {
		t.Fatalf("usage credits=%d tokens=%d, want recorded and uncharged", credits, tokens)
	}
	// A blank open answer earns 0 on every item without a Jev call.
	rec = doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/attempts", "u_owner", map[string]any{"answers": map[string]any{"open-a": "  "}})
	if rec.Code != http.StatusCreated || !strings.Contains(rec.Body.String(), `"awarded":0,"blocks":[{"text":"Explain."`) || !strings.Contains(rec.Body.String(), `"itemAwards":[0,0]`) {
		t.Fatalf("blank attempt → %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []map[string]any{
		{"missing": "x"},
		{"open-a": strings.Repeat("a", 5001)},
		{"open-a": 5},
	} {
		if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/attempts", "u_owner", map[string]any{"answers": body}); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("attempt %v → %d, want 422", body, rec.Code)
		}
	}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/attempts", "u_other", map[string]any{"answers": answers}); rec.Code != http.StatusNotFound {
		t.Fatalf("private quiz attempted by a stranger → %d", rec.Code)
	}
	// The browser no longer grades or sends scores; the old routes are gone.
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/grade", "u_owner", map[string]any{"answers": map[string]string{"open-a": "x"}}); rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("removed grade route → %d", rec.Code)
	}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/attempts", "u_owner", map[string]any{"answers": map[string]any{}, "correct": 6, "total": 6}); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("client score → %d", rec.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("Jev calls = %d, want only the answered open part", calls.Load())
	}
}

// Jev's partial credit is half of each item's own marks.
func TestCreateAttemptScalesPartialCreditByItemMarks(t *testing.T) {
	h, _, _ := openGradingAPI(t, "partial")
	id := gradingQuiz(t, h, "private")
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/attempts", "u_owner", map[string]any{
		"answers": map[string]any{"open-a": "Because of reasons."},
	})
	if rec.Code != http.StatusCreated || !strings.Contains(rec.Body.String(), `"awarded":1.5`) || !strings.Contains(rec.Body.String(), `"itemAwards":[1,0.5]`) {
		t.Fatalf("attempt → %d %s", rec.Code, rec.Body.String())
	}
}

// Signed-out grading grades every part and returns the keys; the daily caps
// count only the open parts Jev grades.
func TestGradeAnonymousQuizCapsPerIP(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	id := gradingQuiz(t, h, "link")
	token := store.ShareToken(nil, id)
	grade := func(ip, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/public/quizzes/"+token+"/grade", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("CF-Connecting-IP", ip)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	const open = `{"answers":{"open-a":"Because.","closed-b":false},"localId":"device-1"}`
	rec := grade("203.0.113.7", open)
	var graded struct {
		Correct, Total float64
		Questions      []map[string]any
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &graded)
	if rec.Code != http.StatusOK || graded.Correct != 3 || graded.Total != 6 || len(graded.Questions) != 1 ||
		gradedParts(t, graded.Questions)["closed-b"]["answer"].(map[string]any)["correct"] != true {
		t.Fatalf("anonymous grade → %d %s", rec.Code, rec.Body.String())
	}
	var parts int
	var tokens int64
	if err := st.Pool().QueryRow(context.Background(), `SELECT parts, input_tokens FROM anonymous_grading_usage
		WHERE ip_hash=$1 AND local_id='device-1'`, st.AnonymousIPHash("203.0.113.7")).Scan(&parts, &tokens); err != nil {
		t.Fatal(err)
	}
	if parts != 1 || tokens != 1000 {
		t.Fatalf("usage parts=%d tokens=%d", parts, tokens)
	}
	if _, err := st.Pool().Exec(context.Background(), `UPDATE anonymous_grading_usage SET parts=$2 WHERE ip_hash=$1`,
		st.AnonymousIPHash("203.0.113.7"), store.AnonymousGradingPartsPerIP); err != nil {
		t.Fatal(err)
	}
	if rec := grade("203.0.113.7", open); rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "anonymous_grading_limit") {
		t.Fatalf("capped IP → %d %s", rec.Code, rec.Body.String())
	}
	if rec := grade("203.0.113.7", `{"answers":{"closed-b":true}}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"correct":1`) {
		t.Fatalf("capped IP, closed parts only → %d %s", rec.Code, rec.Body.String())
	}
	if rec := grade("198.51.100.4", open); rec.Code != http.StatusOK {
		t.Fatalf("another IP → %d", rec.Code)
	}
	if rec := grade("198.51.100.4", `{"answers":{"nope":1}}`); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown part → %d", rec.Code)
	}
	// Swap the signature's last character; a token already ending in "x" gets "y" instead.
	forged := token[:len(token)-1] + "x"
	if forged == token {
		forged = token[:len(token)-1] + "y"
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/quizzes/"+forged+"/grade", strings.NewReader(`{"answers":{}}`))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("forged token → %d", rec.Code)
	}
}
