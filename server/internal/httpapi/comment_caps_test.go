package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// TestCommentsArePlainText (security regression: rate-limit audit M9). A
// comment is plain text of at most 3,000 characters: more is refused, a rich
// payload is refused, a plain comment and its edit round-trip, and a note past
// its live comment count answers 409 comment_limit.
func TestCommentsArePlainText(t *testing.T) {
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
	path := "/api/materials/" + note.ID + "/discussions"
	long := map[string]any{"anchorVersion": 1, "blockId": "b1", "text": strings.Repeat("光", 3001)}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", long); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("3,001 characters → %d, want 422", rec.Code)
	}
	rich := map[string]any{"anchorVersion": 1, "blockId": "b1", "text": "hi",
		"contentRich": []any{map[string]any{"type": "p", "children": []any{map[string]any{"text": "hi"}}}}}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", rich); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("a rich payload → %d, want 422", rec.Code)
	}

	text := "First line\nsecond " + strings.Repeat("光", 2980)
	rec = doReq(t, h, http.MethodPost, path, "u_owner", map[string]any{"anchorVersion": 1, "blockId": "b1", "text": text})
	var discussion struct {
		ID       string
		Comments []struct{ ID, Text string }
	}
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &discussion) != nil ||
		len(discussion.Comments) != 1 || discussion.Comments[0].Text != text {
		t.Fatalf("a plain comment → %d %s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodPatch, "/api/comments/"+discussion.Comments[0].ID, "u_owner", map[string]any{"text": "Edited"})
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"text":"Edited"`) {
		t.Fatalf("edit → %d %s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodGet, path, "u_owner", nil)
	var listed []struct {
		Comments []struct{ Text string }
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &listed) != nil ||
		len(listed) != 1 || listed[0].Comments[0].Text != "Edited" {
		t.Fatalf("list → %d %s", rec.Code, rec.Body.String())
	}

	if _, err := st.Pool().Exec(context.Background(), `INSERT INTO material_comments (id, discussion_id, user_id, text)
		SELECT 'com_http_cap_' || n, $1, 'u_owner', 'x'
		FROM generate_series(2, $2::int) n`, discussion.ID, store.CommentsPerNote); err != nil {
		t.Fatal(err)
	}
	small := map[string]any{"anchorVersion": 1, "text": "hi"}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", small); rec.Code != http.StatusConflict || errorCode(t, rec) != "comment_limit" {
		t.Fatalf("a comment past the cap → %d %s, want 409 comment_limit", rec.Code, rec.Body.String())
	}
}

// TestCommentDiscussionBoundsAreEnforced (security regression: rate-limit
// audit r2 N-7, Q313). Block ids are 1 to 128 characters, a quote with a bidi
// control is refused, and a body past the 64 KiB cap is refused before it is
// read whole.
func TestCommentDiscussionBoundsAreEnforced(t *testing.T) {
	h, st, _ := openGradingAPI(t, "full")
	rec := doReq(t, h, http.MethodPost, "/api/workspaces/ws_e2e_private/materials", "u_owner",
		map[string]any{"kind": "note", "title": "Comment bounds " + strings.Repeat("x", 4)})
	var note struct{ ID string }
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &note) != nil {
		t.Fatalf("create note → %d %s", rec.Code, rec.Body.String())
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, note.ID)
	})
	path := "/api/materials/" + note.ID + "/discussions"
	for _, id := range []string{"", strings.Repeat("b", 129)} {
		body := map[string]any{"anchorVersion": 1, "blockId": id, "text": "hi"}
		if rec := doReq(t, h, http.MethodPost, path, "u_owner", body); rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("a %d-character block id → %d, want 422", len(id), rec.Code)
		}
	}
	bidi := map[string]any{"anchorVersion": 1, "blockId": "b1", "anchorQuote": "quote\u202Eetouq", "text": "hi"}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", bidi); rec.Code != http.StatusBadRequest {
		t.Errorf("a quote with a bidi override → %d, want 400", rec.Code)
	}
	huge := map[string]any{"anchorVersion": 1, "blockId": "b1", "text": "hi", "anchorQuote": strings.Repeat("q", 64<<10)}
	if rec := doReq(t, h, http.MethodPost, path, "u_owner", huge); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("a body past 64 KiB → %d, want 413", rec.Code)
	}
}
