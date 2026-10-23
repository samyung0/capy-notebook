package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// TestCommentJSONAndCountAreCapped (security regression: rate-limit audit
// M9). A comment's JSON stops at 32 KiB even within the character limit, and
// a note past its live comment count answers 409 comment_limit.
func TestCommentJSONAndCountAreCapped(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/materials", "u_owner",
		map[string]any{"kind": "note", "title": "Comment caps " + strings.Repeat("x", 4)})
	var note struct{ ID string }
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &note) != nil {
		t.Fatalf("create note → %d %s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, note.ID)
	})
	comment := func(children []any) map[string]any {
		return map[string]any{"anchorVersion": 1, "contentRich": []any{map[string]any{"type": "p", "children": children}}}
	}
	// Empty leaves add bytes and no characters.
	leaves := make([]any, 0, 4000)
	for range 4000 {
		leaves = append(leaves, map[string]any{"text": ""})
	}
	leaves = append(leaves, map[string]any{"text": "hi"})
	path := "/api/materials/" + note.ID + "/discussions"
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", comment(leaves)); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("a 44 KB comment → %d, want 422", rec.Code)
	}
	small := comment([]any{map[string]any{"text": "hi"}})
	rec = doReq(t, h, http.MethodPost, path, "u_owner", small)
	var discussion struct{ ID string }
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &discussion) != nil {
		t.Fatalf("a small comment → %d %s", rec.Code, rec.Body.String())
	}
	if _, err := st.Pool().Exec(context.Background(), `INSERT INTO material_comments (id, discussion_id, user_id, content_rich)
		SELECT 'com_http_cap_' || n, $1, 'u_owner', '[{"type":"p","children":[{"text":"x"}]}]'
		FROM generate_series(2, $2::int) n`, discussion.ID, store.CommentsPerNote); err != nil {
		t.Fatal(err)
	}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", small); rec.Code != http.StatusConflict || errorCode(t, rec) != "comment_limit" {
		t.Fatalf("a comment past the cap → %d %s, want 409 comment_limit", rec.Code, rec.Body.String())
	}
}
