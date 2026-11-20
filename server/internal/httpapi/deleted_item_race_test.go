package httpapi

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// TestDeletedErrorAsksAgainAfterARestore: an item restored between the
// handler's live check and the deleted check is live, not gone: the caller
// hears 409 to ask again, never the 404 that drops their unsent edits to it
// (review 2026-11-20). Someone who cannot read it keeps the 404.
func TestDeletedErrorAsksAgainAfterARestore(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	const restored = "note_restored_meanwhile"
	if _, err := st.Pool().Exec(ctx, `INSERT INTO materials
		(id, created_by, owner_user_id, workspace_id, kind, title)
		VALUES ($1,'u_owner','u_owner','ws_e2e_private','note','Restored notes')`, restored); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id=$1`, restored)
	})
	a := &api{s: st}
	// The handler's live check refused it while trashed; it is live again.
	ask := func(user string) error {
		caller := auth.WithUserID(ctx, user)
		live := func() error { _, err := st.MaterialEffectiveRole(caller, user, restored); return err }
		return a.deletedError(caller, agenttools.KindMaterial, restored, store.ErrNotFound, live)
	}
	var conflict huma.StatusError
	if err := ask("u_viewer"); !errors.As(err, &conflict) || conflict.GetStatus() != http.StatusConflict {
		t.Fatalf("a reader after a restore = %v, want 409", err)
	}
	if err := ask("u_other"); err != nil {
		t.Fatalf("someone outside after a restore = %v, want the 404 kept", err)
	}
}

// TestTrashAfterTheAccessCheckAnswersDeleted: a trash that commits after a
// handler's access check, before its later reads, answers as one before it
// did: 410 `item_deleted`, never the 404 that drops the caller's unsent edits
// (review 2026-11-20).
func TestTrashAfterTheAccessCheckAnswersDeleted(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	const forToken, forRead = "note_trashed_before_token", "note_trashed_before_read"
	for _, id := range []string{forToken, forRead} {
		if _, err := st.Pool().Exec(ctx, `INSERT INTO materials
			(id, created_by, owner_user_id, workspace_id, kind, title)
			VALUES ($1,'u_owner','u_owner','ws_e2e_private','note',$1)`, id); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM materials WHERE id IN ($1,$2)`, forToken, forRead)
	})
	a := &api{s: st}
	a.accessChecked = func(id string) {
		if _, err := st.Pool().Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id='ep_meanwhile',
			purge_after=now()+interval '30 days' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}
	caller := auth.WithUserID(ctx, "u_viewer")
	gone := func(what string, err error) {
		t.Helper()
		var status huma.StatusError
		if !errors.As(err, &status) || status.GetStatus() != http.StatusGone {
			t.Fatalf("%s = %v, want 410", what, err)
		}
	}
	_, err = a.createMaterialCollaborationToken(caller, &materialCollaborationTokenInput{ID: forToken})
	gone("the room token", err)
	_, err = a.getMaterial(caller, &getMaterialInput{ID: forRead, NoContent: true})
	gone("the read", err)
}
