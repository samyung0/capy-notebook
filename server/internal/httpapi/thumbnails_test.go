package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

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
