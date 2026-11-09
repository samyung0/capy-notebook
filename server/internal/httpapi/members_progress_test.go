package httpapi_test

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/samyung0/capy-notebook/server/internal/pipeline"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// TestMembersRoutesAuthorize: Study → Members and a member's profile answer a
// class's owner and editor members alone; its viewer member, a link editor, a
// nonmember and a personal workspace get 404 (the store's refusal is not
// disclosed), and only a viewer member has a profile.
func TestMembersRoutesAuthorize(t *testing.T) {
	h := openShareAPI(t, pipeline.New("http://127.0.0.1:1", ""))
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	id := fmt.Sprintf("ws_members_%d", time.Now().UnixNano())
	exec(`INSERT INTO workspaces (id, user_id, name, privacy, share_role, kind) VALUES ($1, 'u_owner', 'Members routes', 'link', 'editor', 'class')`, id)
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, id) })
	exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, 'u_owner', 'owner'), ($1, 'u_editor', 'editor'), ($1, 'u_viewer', 'viewer')`, id)
	members := "/api/workspaces/" + id + "/study/members"
	profile := members + "/u_viewer"
	expect := func(user string, want int) {
		t.Helper()
		for _, path := range []string{members, profile} {
			if rec := doReq(t, h, http.MethodGet, path, user, nil); rec.Code != want {
				t.Fatalf("%s GET %s: status = %d, want %d, body=%s", user, path, rec.Code, want, rec.Body.String())
			}
		}
	}
	expect("u_owner", http.StatusOK)
	expect("u_editor", http.StatusOK)
	expect("u_viewer", http.StatusNotFound)
	// Without a redeemed link u_other has no reach: a nonmember.
	expect("u_other", http.StatusNotFound)
	exec(`INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ($1, 'u_other')`, id)
	expect("u_other", http.StatusNotFound)
	if rec := doReq(t, h, http.MethodGet, members+"/u_editor", "u_owner", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("a teaching assistant's profile: status = %d", rec.Code)
	}
	exec(`UPDATE workspaces SET kind='personal' WHERE id=$1`, id)
	expect("u_owner", http.StatusNotFound)
}
