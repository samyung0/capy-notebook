package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// TestTrashedItemsAnswerDeleted: an item trashed while a member could read it
// answers its room token and its read with 410 `item_deleted`, its name and
// kind, so their unsent edits are offered rather than dropped (Epo 2026-11-20,
// Q41), and so does an embedded quiz trashed alone, its block removed from a
// note still live. A non-member, a member it is hidden from and a purged item
// keep the non-disclosing 404. A shared canvas's read answers its members
// the same, and one never shared stays a 404 to them.
func TestTrashedItemsAnswerDeleted(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	h := httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
		E2EUserIDs:          []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		CollaborationSecret: "collab-test-secret",
	})
	const note, hidden, file = "note_deleted_answer", "note_deleted_hidden", "f_deleted_answer"
	for _, row := range []struct{ id, title string }{{note, "Cell biology notes"}, {hidden, "Hidden notes"}} {
		if _, err := st.Pool().Exec(ctx, `INSERT INTO materials
			(id, created_by, owner_user_id, workspace_id, kind, title, hidden,
			 trashed_at, trash_episode_id, purge_after)
			VALUES ($1,'u_owner','u_owner','ws_e2e_private','note',$2,$3,
			 now(),'ep_deleted',now() + interval '30 days')`, row.id, row.title, row.id == hidden); err != nil {
			t.Fatal(err)
		}
	}
	// A quiz whose block left its live note: trashed alone (Q41).
	const liveNote, embedded = "note_deleted_live_parent", "quiz_deleted_embedded"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO materials
		(id, created_by, owner_user_id, workspace_id, kind, title)
		VALUES ($1,'u_owner','u_owner','ws_e2e_private','note','Live notes')`, liveNote); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO materials
		(id, created_by, owner_user_id, workspace_id, kind, title, parent_material_id,
		 trashed_at, trash_episode_id, purge_after)
		VALUES ($1,'u_owner','u_owner','ws_e2e_private','quiz','Mitosis check',$2,
		 now(),'ep_deleted_block',now() + interval '30 days')`, embedded, liveNote); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, name, kind, size_bytes, status, blob_path,
		 trashed_at, trash_episode_id, purge_after)
		VALUES ($1,'ws_e2e_private','u_owner','plan.docx','doc',1,'ready','sources/f_deleted_answer/plan.docx',
		 now(),'ep_deleted',now() + interval '30 days')`, file); err != nil {
		t.Fatal(err)
	}
	// A member's canvas its maker shared with the workspace and trashed, and
	// one the maker never shared (review 2026-11-20).
	const sharedCanvas, ownCanvas = "canvas_deleted_shared", "canvas_deleted_own"
	for _, row := range []struct {
		id     string
		shared bool
	}{{sharedCanvas, true}, {ownCanvas, false}} {
		if _, err := st.Pool().Exec(ctx, `INSERT INTO materials
			(id, created_by, owner_user_id, kind, title, canvas_workspace_id, canvas_shared,
			 trashed_at, trash_episode_id, purge_after)
			VALUES ($1,'u_owner','u_owner','canvas','Lab diagrams','ws_e2e_private',$2,
			 now(),'ep_deleted_canvas',now() + interval '30 days')`, row.id, row.shared); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id IN ($1,$2)`, sharedCanvas, ownCanvas)
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id IN ($1,$2,$3)`, note, hidden, embedded)
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, liveNote)
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM files WHERE id=$1`, file)
	})

	// A token request sends a body; a read none.
	postBody := func(method string) any {
		if method == http.MethodPost {
			return map[string]any{}
		}
		return nil
	}
	deleted := func(method, path, user, name, kind string) {
		t.Helper()
		rec := doReq(t, h, method, path, user, postBody(method))
		var body struct {
			Errors []struct {
				Message string            `json:"message"`
				Value   map[string]string `json:"value"`
			} `json:"errors"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); rec.Code != http.StatusGone || err != nil || len(body.Errors) != 1 ||
			body.Errors[0].Message != "item_deleted" || body.Errors[0].Value["name"] != name || body.Errors[0].Value["kind"] != kind {
			t.Fatalf("%s %s as %s = %d %s", method, path, user, rec.Code, rec.Body.String())
		}
	}
	notFound := func(method, path, user string) {
		t.Helper()
		if rec := doReq(t, h, method, path, user, postBody(method)); rec.Code != http.StatusNotFound {
			t.Fatalf("%s %s as %s = %d %s", method, path, user, rec.Code, rec.Body.String())
		}
	}

	// A member who reads the workspace, and its editor for the hidden one.
	deleted(http.MethodPost, "/api/materials/"+note+"/collaboration-token", "u_viewer", "Cell biology notes", "note")
	deleted(http.MethodGet, "/api/materials/"+note, "u_viewer", "Cell biology notes", "note")
	deleted(http.MethodPost, "/api/materials/"+hidden+"/collaboration-token", "u_editor", "Hidden notes", "note")
	deleted(http.MethodPost, "/api/files/"+file+"/collaboration-token", "u_editor", "plan.docx", "doc")
	// An edit open reads its session beside its token, either answering
	// first (review 2026-11-20).
	deleted(http.MethodGet, "/api/files/"+file+"/source-session", "u_editor", "plan.docx", "doc")
	deleted(http.MethodGet, "/api/files/"+file, "u_viewer", "plan.docx", "doc")
	// A shared canvas's read, the canvas page's (review 2026-11-20).
	deleted(http.MethodGet, "/api/canvases/"+sharedCanvas, "u_viewer", "Lab diagrams", "canvas")
	// The quiz trashed alone answers as its live note is read.
	deleted(http.MethodPost, "/api/materials/"+embedded+"/collaboration-token", "u_editor", "Mitosis check", "quiz")
	deleted(http.MethodGet, "/api/materials/"+embedded, "u_viewer", "Mitosis check", "quiz")
	notFound(http.MethodGet, "/api/materials/"+embedded, "u_other")

	// A non-member, and a member the item is hidden from.
	notFound(http.MethodPost, "/api/materials/"+note+"/collaboration-token", "u_other")
	notFound(http.MethodGet, "/api/materials/"+note, "u_other")
	notFound(http.MethodPost, "/api/files/"+file+"/collaboration-token", "u_other")
	notFound(http.MethodGet, "/api/files/"+file+"/source-session", "u_other")
	notFound(http.MethodGet, "/api/files/"+file, "u_other")
	notFound(http.MethodPost, "/api/materials/"+hidden+"/collaboration-token", "u_viewer")
	notFound(http.MethodGet, "/api/materials/"+hidden, "u_viewer")
	notFound(http.MethodGet, "/api/canvases/"+sharedCanvas, "u_other")
	notFound(http.MethodGet, "/api/canvases/"+ownCanvas, "u_viewer")

	// Purged: the row is gone.
	if _, err := st.Pool().Exec(ctx, `DELETE FROM materials WHERE id=$1`, note); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `DELETE FROM files WHERE id=$1`, file); err != nil {
		t.Fatal(err)
	}
	notFound(http.MethodPost, "/api/materials/"+note+"/collaboration-token", "u_viewer")
	notFound(http.MethodGet, "/api/materials/"+note, "u_viewer")
	notFound(http.MethodPost, "/api/files/"+file+"/collaboration-token", "u_editor")
	notFound(http.MethodGet, "/api/files/"+file+"/source-session", "u_editor")
	notFound(http.MethodGet, "/api/files/"+file, "u_viewer")
}
