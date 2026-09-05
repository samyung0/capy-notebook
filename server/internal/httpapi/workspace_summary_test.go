package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

func TestPublicWorkspaceSummary(t *testing.T) {
	h := openShareHTTP(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	owner, ws, chapter, file := "u_summary_"+suffix, "ws_summary_"+suffix, "ch_summary_"+suffix, "f_summary_"+suffix
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users (id,name,email) VALUES ($1,'Summary author','summary@example.test')`, owner)
	defer pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, owner)
	exec(`INSERT INTO workspaces (id,user_id,name,description,privacy) VALUES ($1,$2,'<script>title</script>','Only metadata','public')`, ws, owner)
	exec(`INSERT INTO chapters (id,workspace_id,name) VALUES ($1,$2,'Chapter A')`, chapter, ws)
	exec(`INSERT INTO files (id,workspace_id,user_id,name,kind,chapter_id,content) VALUES ($1,$2,$3,'Source.pdf','pdf',$4,'SECRET CONTENT')`, file, ws, owner, chapter)
	path := "/api/public/workspaces/" + ws + "/summary"
	rec := doReq(t, h, http.MethodGet, path, "", nil)
	if rec.Code != 200 {
		t.Fatalf("summary: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("summary must not cache")
	}
	var summary store.WorkspaceSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Name != "<script>title</script>" || summary.Description != "Only metadata" || summary.Author != "Summary author" || summary.Privacy != store.PrivacyPublic || len(summary.Chapters) != 1 || !reflect.DeepEqual(summary.Chapters[0].Files, []string{"Source.pdf"}) || summary.Files == nil || summary.Tags == nil {
		t.Fatalf("summary = %#v", summary)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatal(err)
	}
	delete(keys, "$schema") // Huma adds its standard schema link.
	if len(keys) != 8 {
		t.Fatalf("unexpected projection keys: %v", keys)
	}
	for _, secret := range []string{owner, ws, chapter, file, "SECRET CONTENT", "summary@example.test", "workspaceId", "content", "blob"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("summary leaked %q", secret)
		}
	}
	rec = doReq(t, h, http.MethodHead, path, "", nil)
	if rec.Code != 200 || rec.Body.Len() != 0 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("HEAD %d %s", rec.Code, rec.Body.String())
	}
	exec(`UPDATE workspaces SET privacy='link',name='Renamed' WHERE id=$1`, ws)
	rec = doReq(t, h, http.MethodGet, path, "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"privacy":"link"`) || !strings.Contains(rec.Body.String(), "Renamed") {
		t.Fatalf("live summary %d %s", rec.Code, rec.Body.String())
	}
	exec(`INSERT INTO chapters (id,workspace_id,name) SELECT $1 || n::text,$2,'Bounded chapter' FROM generate_series(1,1000) n`, chapter+"_extra_", ws)
	rec = doReq(t, h, http.MethodGet, path, "", nil)
	if rec.Code != 422 {
		t.Fatalf("oversized outline: %d %s", rec.Code, rec.Body.String())
	}
	exec(`UPDATE workspaces SET privacy='private' WHERE id=$1`, ws)
	for _, user := range []string{"", "u_owner"} {
		rec = doReq(t, h, http.MethodGet, path, user, nil)
		if rec.Code != 404 {
			t.Fatalf("private summary %d", rec.Code)
		}
	}
	exec(`DELETE FROM chapters WHERE workspace_id=$1 AND id<>$2`, ws, chapter)
	exec(`UPDATE workspaces SET privacy='public' WHERE id=$1`, ws)
	for _, state := range []string{"suspended", "pending", "deleted"} {
		switch state {
		case "suspended":
			exec(`UPDATE users SET suspended_at=now(),suspended_reason='test' WHERE id=$1`, owner)
		case "pending":
			exec(`UPDATE users SET suspended_at=NULL,suspended_reason=NULL,deletion_requested_at=now(),purge_after=now()+interval '1 day' WHERE id=$1`, owner)
		case "deleted":
			exec(`UPDATE users SET deleted_at=now() WHERE id=$1`, owner)
		}
		rec = doReq(t, h, http.MethodGet, path, "", nil)
		if rec.Code != 404 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s summary %d %s", state, rec.Code, rec.Body.String())
		}
	}
	for _, id := range []string{"invalid", "ws_missing", "ws_" + strings.Repeat("a", 65)} {
		rec = doReq(t, h, http.MethodGet, "/api/public/workspaces/"+id+"/summary", "", nil)
		if rec.Code != 404 {
			t.Fatalf("bad/missing ID %q: %d", id, rec.Code)
		}
	}
}

func TestWorkspaceDescriptionEditAndPrivateSummary(t *testing.T) {
	h := openShareHTTP(t)
	created := doReq(t, h, http.MethodPost, "/api/workspaces", "u_owner", map[string]any{"name": "Summary settings"})
	if created.Code != 201 {
		t.Fatal(created.Body.String())
	}
	var workspace store.Workspace
	if err := json.Unmarshal(created.Body.Bytes(), &workspace); err != nil {
		t.Fatal(err)
	}
	defer doReq(t, h, http.MethodDelete, "/api/workspaces/"+workspace.ID, "u_owner", nil)
	path := "/api/workspaces/" + workspace.ID
	for _, description := range []string{"New description", ""} {
		rec := doReq(t, h, http.MethodPatch, path, "u_owner", map[string]any{"description": description})
		if rec.Code != 200 {
			t.Fatal(rec.Body.String())
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &workspace); err != nil {
			t.Fatal(err)
		}
		if workspace.Description != description {
			t.Fatalf("description = %q", workspace.Description)
		}
	}
	rec := doReq(t, h, http.MethodPatch, path, "u_owner", map[string]any{"description": strings.Repeat("a", 1001)})
	if rec.Code != 422 {
		t.Fatalf("description limit %d %s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodGet, "/api/public/workspaces/"+workspace.ID+"/summary", "u_owner", nil)
	if rec.Code != 404 {
		t.Fatalf("private owner summary %d", rec.Code)
	}
}
