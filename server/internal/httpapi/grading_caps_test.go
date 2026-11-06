package httpapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// TestAnonymousGradingRefusesAForgedTokenUnread (security regression:
// rate-limit audit L6). A shared page's check with a forged share token is
// refused before any of its body is read.
func TestAnonymousGradingRefusesAForgedTokenUnread(t *testing.T) {
	h, _, _ := openGradingAPI(t, "full")
	token := store.ShareToken(nil, gradingQuiz(t, h, "link"))
	forged := token[:len(token)-1] + "x"
	if forged == token {
		forged = token[:len(token)-1] + "y"
	}
	for _, path := range []string{
		"/api/public/quizzes/" + forged + "/grade",
		"/api/public/notes/" + forged + "/quizzes/q_1/grade",
	} {
		body := &countedBody{r: strings.NewReader(`{"answers":{"open-a":"` + strings.Repeat("a", 4096) + `"}}`)}
		req := httptest.NewRequest(http.MethodPost, path, body)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound || body.read != 0 {
			t.Fatalf("%s → %d after reading %d bytes, want 404 unread", path, rec.Code, body.read)
		}
	}
}

// TestSignedInGradingStopsAtTheDailyPartCap (security regression: rate-limit
// audit M7). A signed-in learner's open parts are counted before any model; past
// the day's cap a check with open answers and a computation check are
// refused unsent, and a check with closed answers only is still graded.
func TestSignedInGradingStopsAtTheDailyPartCap(t *testing.T) {
	h, st, calls := openGradingAPI(t, "full")
	ctx := context.Background()
	id := gradingQuiz(t, h, "private")
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM grading_usage WHERE user_id='u_owner'`)
	})
	open := map[string]any{"questionId": "q1", "answers": map[string]any{"open-a": "Because.", "closed-b": true}}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", open); rec.Code != http.StatusOK {
		t.Fatalf("check → %d %s", rec.Code, rec.Body.String())
	}
	var parts int
	if err := st.Pool().QueryRow(ctx, `SELECT parts FROM grading_usage
		WHERE user_id='u_owner' AND day=(now() AT TIME ZONE 'UTC')::date`).Scan(&parts); err != nil || parts < 1 {
		t.Fatalf("counted parts = %d (%v), want the open part counted", parts, err)
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE grading_usage SET parts=$1 WHERE user_id='u_owner'`,
		store.SignedInGradingPartsPerDay); err != nil {
		t.Fatal(err)
	}
	before := calls.Load()
	rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", open)
	if rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), "grading_limit") || calls.Load() != before {
		t.Fatalf("check past the cap → %d %s (model calls %d → %d)", rec.Code, rec.Body.String(), before, calls.Load())
	}
	check := doReq(t, h, http.MethodPost, "/api/questions/computation-check", "u_owner", map[string]any{
		"partId": "open-a",
		"question": map[string]any{
			"id": "q1", "stem": []any{}, "layout": "paper", "labels": "letters",
			"parts": []any{map[string]any{"id": "open-a", "blocks": []any{map[string]any{"type": "text", "text": "Explain."}},
				"answer": map[string]any{"type": "open", "accepted": []any{"Because."}, "hints": []any{}}, "marks": 1,
				"markscheme": []any{map[string]any{"text": "Point one", "marks": 1}}, "solution": []any{}}},
		},
	})
	if check.Code != http.StatusTooManyRequests || calls.Load() != before {
		t.Fatalf("computation check past the cap → %d %s", check.Code, check.Body.String())
	}
	closed := map[string]any{"questionId": "q1", "answers": map[string]any{"closed-b": true}}
	if rec := doReq(t, h, http.MethodPost, "/api/quizzes/"+id+"/check", "u_owner", closed); rec.Code != http.StatusOK {
		t.Fatalf("closed-only check past the cap → %d", rec.Code)
	}
}
