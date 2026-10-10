package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// thumbnailURLs collects id -> thumbnailUrl from every object in a JSON body.
func thumbnailURLs(t *testing.T, body []byte) map[string]string {
	t.Helper()
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	out := map[string]string{}
	var walk func(any)
	walk = func(v any) {
		switch v := v.(type) {
		case map[string]any:
			if url, ok := v["thumbnailUrl"].(string); ok {
				id, _ := v["id"].(string)
				out[id] = url
			}
			for _, child := range v {
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(value)
	return out
}

// TestListThumbnailsFollowReadAccess is the thumbnail access rule (security
// regression: human authorization-permissions-lifecycles 2026-10-11, a
// thumbnail's presigned URL follows the item's read access). Lists sign only
// rows their access-scoped queries return, so no list hands a caller a link to
// a file it cannot read, and shared and public listings sign shared files only.
func TestListThumbnailsFollowReadAccess(t *testing.T) {
	h := openShareHTTP(t)
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	pool := st.Pool()

	type seeded struct{ id, key string }
	seed := func(ws string, trashed bool) seeded {
		t.Helper()
		id := "f_thumb_" + strings.TrimPrefix(ws, "ws_e2e_")
		if trashed {
			id += "_trashed"
		}
		row := seeded{id: id, key: "thumbs/" + id + "/0123abcd.webp"}
		_, err := pool.Exec(ctx, `INSERT INTO files
			(id, workspace_id, user_id, name, kind, size_bytes, status, thumbnail_key,
			 trashed_at, trash_episode_id, purge_after)
			VALUES ($1,$2,'u_owner',$1 || '.pdf','pdf',1,'ready',$3,
			 CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 'ep_' || $1 END,
			 CASE WHEN $4 THEN now() + interval '30 days' END)`,
			row.id, ws, row.key, trashed)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM files WHERE id=$1`, row.id)
		})
		return row
	}
	private := seed("ws_e2e_private", false)
	link := seed("ws_e2e_link", false)
	public := seed("ws_e2e_public", false)
	trashed := seed("ws_e2e_private", true)

	get := func(user, path string, status int) map[string]string {
		t.Helper()
		rec := doReq(t, h, http.MethodGet, path, user, nil)
		if rec.Code != status {
			t.Fatalf("%s %s = %d %s", user, path, rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), private.key) && user == "u_other" {
			t.Fatalf("%s %s leaked the private thumbnail key", user, path)
		}
		if status != http.StatusOK {
			return nil
		}
		return thumbnailURLs(t, rec.Body.Bytes())
	}
	want := func(urls map[string]string, rows ...seeded) {
		t.Helper()
		for _, row := range rows {
			if urls[row.id] != "memory://"+row.key {
				t.Errorf("%s thumbnailUrl = %q, want its signed key", row.id, urls[row.id])
			}
		}
	}
	none := func(urls map[string]string, rows ...seeded) {
		t.Helper()
		for _, row := range rows {
			if url, ok := urls[row.id]; ok {
				t.Errorf("%s got thumbnailUrl %q without read access", row.id, url)
			}
		}
	}

	// A signed-in stranger reads the link and public workspaces only.
	get("u_other", "/api/workspaces/ws_e2e_private/files", http.StatusNotFound)
	want(get("u_other", "/api/workspaces/ws_e2e_link/files", http.StatusOK), link)
	want(get("u_other", "/api/workspaces/ws_e2e_public/files", http.StatusOK), public)
	// Opening a shared workspace adds nothing to the caller's own lists.
	for _, path := range []string{"/api/files", "/api/files?scope=member", "/api/trash"} {
		none(get("u_other", path, http.StatusOK), private, link, public, trashed)
	}

	// A member viewer reads the private workspace; trash stays the owner's.
	want(get("u_viewer", "/api/workspaces/ws_e2e_private/files", http.StatusOK), private)
	want(get("u_viewer", "/api/files?scope=member", http.StatusOK), private)
	none(get("u_viewer", "/api/trash", http.StatusOK), trashed)

	want(get("u_owner", "/api/files?limit=100", http.StatusOK), private, link, public)
	want(get("u_owner", "/api/trash", http.StatusOK), trashed)
}

// TestCrossOwnerCloneCopiesThumbnails (security regression: review 1 S1): a
// thumbnail key names its file, and the file id leads to the file's workspace,
// so a clone by anyone but the source owner never shares the source key. It
// gets a copy under its own file id after the clone commits, or nothing when
// the copy fails. The owner's own clone shares the key.
func TestCrossOwnerCloneCopiesThumbnails(t *testing.T) {
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
	bucket := blob.NewMemory()
	h := httpapi.New(st, bucket, nil, nil, "docling", httpapi.Config{
		AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
		E2EUserIDs:    []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		ModelRegistry: reg,
	})
	pool := st.Pool()
	source, err := st.CreateWorkspace(ctx, "u_owner", store.WorkspaceCreate{Name: "Thumbnail clone source", Tags: []store.TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, source.ID) })
	if _, err := pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1, 'u_editor', 'editor')`, source.ID); err != nil {
		t.Fatal(err)
	}
	seed := func(id string, stored bool) string {
		t.Helper()
		key := "thumbs/" + id + "/0123abcd.webp"
		if _, err := pool.Exec(ctx, `INSERT INTO files
			(id, workspace_id, user_id, name, kind, size_bytes, status, thumbnail_key)
			VALUES ($1,$2,'u_owner',$1 || '.pdf','pdf',1,'ready',$3)`, id, source.ID, key); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM files WHERE id=$1`, id) })
		if stored {
			if _, _, err := bucket.Put(key, strings.NewReader("webp")); err != nil {
				t.Fatal(err)
			}
		}
		return key
	}
	sourceKey := seed("f_thumb_clone_src", true)
	seed("f_thumb_clone_gone", false)

	clone := func(user string) string {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/workspaces/"+source.ID+"/clone", user, nil)
		if rec.Code != http.StatusCreated {
			t.Fatalf("%s clone = %d %s", user, rec.Code, rec.Body.String())
		}
		var body struct {
			Workspace struct{ ID string } `json:"workspace"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, body.Workspace.ID)
		})
		return body.Workspace.ID
	}
	keyOf := func(workspaceID, name string) string {
		t.Helper()
		var key string
		if err := pool.QueryRow(ctx, `SELECT COALESCE(thumbnail_key, '') FROM files
			WHERE workspace_id=$1 AND name=$2`, workspaceID, name).Scan(&key); err != nil {
			t.Fatal(err)
		}
		return key
	}

	theirs := clone("u_editor")
	copied := keyOf(theirs, "f_thumb_clone_src.pdf")
	if copied == "" || strings.Contains(copied, "f_thumb_clone_src") || !strings.HasSuffix(copied, "/0123abcd.webp") {
		t.Fatalf("cross-owner clone key = %q, want a copy under the clone's own file id", copied)
	}
	if _, err := bucket.Head(ctx, copied); err != nil {
		t.Fatalf("copied object %s: %v", copied, err)
	}
	if gone := keyOf(theirs, "f_thumb_clone_gone.pdf"); gone != "" {
		t.Fatalf("a failed copy left key %q", gone)
	}

	ours := clone("u_owner")
	if shared := keyOf(ours, "f_thumb_clone_src.pdf"); shared != sourceKey {
		t.Fatalf("owner clone key = %q, want the shared %s", shared, sourceKey)
	}
}
