package httpapi_test

import (
	"context"
	"encoding/json"
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
		E2EAuth: true, E2ESecret: "e2e-test-secret", E2EUserIDs: []string{"u_owner", "u_other"},
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

func TestGradeQuizByReferenceRecordsUncharged(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	id := gradingQuiz(t, h, "private")
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/grade", "u_owner", map[string]any{
		"answers": map[string]string{"open-a": "Because of reasons."},
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"itemAwards":[2,1]`) {
		t.Fatalf("grade → %d %s", rec.Code, rec.Body.String())
	}
	var credits, tokens int64
	if err := st.Pool().QueryRow(context.Background(), `SELECT credit_micros, input_tokens FROM usage_events
		WHERE actor_user_id='u_owner' AND surface='quiz' AND provider='typesafe'`).Scan(&credits, &tokens); err != nil {
		t.Fatal(err)
	}
	if credits != 0 || tokens != 1000 {
		t.Fatalf("usage credits=%d tokens=%d, want recorded and uncharged", credits, tokens)
	}
	for _, body := range []map[string]string{
		{"closed-b": "true"},
		{"missing": "x"},
		{"open-a": strings.Repeat("a", 5001)},
	} {
		if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/grade", "u_owner", map[string]any{"answers": body}); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("grade %v → %d, want 422", body, rec.Code)
		}
	}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/grade", "u_other", map[string]any{"answers": map[string]string{"open-a": "x"}}); rec.Code != http.StatusNotFound {
		t.Fatalf("private quiz graded for a stranger → %d", rec.Code)
	}
	if calls.Load() != 1 {
		t.Fatalf("Jev calls = %d, want only the valid request", calls.Load())
	}
}

// Jev's partial credit is half of each item's own marks.
func TestGradeQuizScalesPartialCreditByItemMarks(t *testing.T) {
	h, _, _ := openGradingAPI(t, "partial")
	id := gradingQuiz(t, h, "private")
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/grade", "u_owner", map[string]any{
		"answers": map[string]string{"open-a": "Because of reasons."},
	})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"awarded":1.5,"itemAwards":[1,0.5]`) {
		t.Fatalf("grade → %d %s", rec.Code, rec.Body.String())
	}
}

func TestGradeAnonymousQuizCapsPerIP(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	id := gradingQuiz(t, h, "link")
	token := store.ShareToken(nil, id)
	grade := func(ip string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/public/quizzes/"+token+"/grade",
			strings.NewReader(`{"answers":{"open-a":"Because."},"localId":"device-1"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("CF-Connecting-IP", ip)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	if rec := grade("203.0.113.7"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"awarded":3`) {
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
	if rec := grade("203.0.113.7"); rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "anonymous_grading_limit") {
		t.Fatalf("capped IP → %d %s", rec.Code, rec.Body.String())
	}
	if rec := grade("198.51.100.4"); rec.Code != http.StatusOK {
		t.Fatalf("another IP → %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/quizzes/"+token[:len(token)-1]+"x/grade", strings.NewReader(`{"answers":{}}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("forged token → %d", rec.Code)
	}
}
