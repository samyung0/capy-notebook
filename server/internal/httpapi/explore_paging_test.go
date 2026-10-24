package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// TestExploreServesPagesFromThePreview (security regression: rate-limit audit
// H5). Explore answers pages of 50 with a cursor to the next, and quizzes
// come from their stored preview: a question count, no questions.
func TestExploreServesPagesFromThePreview(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	ctx := context.Background()
	created := map[string]bool{}
	t.Cleanup(func() {
		for id := range created {
			_, _ = st.Pool().Exec(ctx, `DELETE FROM materials WHERE id=$1`, id)
		}
	})
	for range store.ExplorePageSize + 1 {
		q, err := st.CreateQuiz(ctx, store.Quiz{UserID: "u_owner", Name: "Explore page", Questions: json.RawMessage(`[]`), Privacy: store.PrivacyPublic})
		if err != nil {
			t.Fatal(err)
		}
		created[q.ID] = true
	}
	var marked string
	for id := range created {
		marked = id
		break
	}
	if _, err := st.Pool().Exec(ctx, `UPDATE materials SET preview=jsonb_set(preview, '{questionCount}', '7') WHERE id=$1`, marked); err != nil {
		t.Fatal(err)
	}

	seen := map[string]int{}
	cursor, pages := "", 0
	for {
		path := "/api/explore/quizzes"
		if cursor != "" {
			path += "?cursor=" + url.QueryEscape(cursor)
		}
		rec := doReq(t, h, http.MethodGet, path, "u_other", nil)
		var page struct {
			Items []struct {
				ID            string
				QuestionCount *int
			}
			NextCursor string
		}
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &page) != nil {
			t.Fatalf("explore page %d → %d %.300s", pages, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), `"questions"`) {
			t.Fatalf("explore page %d carries questions", pages)
		}
		if len(page.Items) > store.ExplorePageSize || (page.NextCursor != "" && len(page.Items) != store.ExplorePageSize) {
			t.Fatalf("explore page %d holds %d items (next %q)", pages, len(page.Items), page.NextCursor)
		}
		for _, item := range page.Items {
			if seen[item.ID]++; seen[item.ID] > 1 {
				t.Fatalf("quiz %s listed again on page %d", item.ID, pages)
			}
			if item.ID == marked && (item.QuestionCount == nil || *item.QuestionCount != 7) {
				t.Fatalf("question count %v, want the preview's 7", item.QuestionCount)
			}
		}
		pages++
		if cursor = page.NextCursor; cursor == "" {
			break
		}
	}
	if pages < 2 {
		t.Fatalf("%d public quizzes fit one page", len(seen))
	}
	for id := range created {
		if seen[id] != 1 {
			t.Fatalf("quiz %s missing from the pages", id)
		}
	}
	if rec := doReq(t, h, http.MethodGet, "/api/explore/quizzes?cursor=nope", "u_other", nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("a malformed cursor → %d, want 400", rec.Code)
	}
}
