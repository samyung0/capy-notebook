package store

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func TestACLChangeQueuesRetryableStableEviction(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_collaboration_eviction_owner")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID,
		Kind:      "note",
		Title:     "Eviction source",
		Content:   content,
		Privacy:   PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='public' WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM collaboration_eviction_outbox`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='private' WHERE id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}

	claimed, err := s.ClaimCollaborationEvictions(ctx, 10, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(claimed) != 1 {
		t.Fatalf("claimed %d evictions, want 1", len(claimed))
	}
	first := claimed[0]
	var payload struct {
		EvictionID string `json:"evictionId"`
		MaterialID string `json:"materialId"`
		Mode       string `json:"mode"`
		Room       string `json:"room"`
	}
	if err := json.Unmarshal([]byte(first.Payload), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.EvictionID != first.ID || payload.MaterialID != material.ID ||
		payload.Mode != "revoke" ||
		payload.Room != "material:"+material.ID+":schema:1" {
		t.Fatalf("unexpected eviction payload: %+v", payload)
	}
	if err := s.RetryCollaborationEviction(
		ctx, first.ID, first.LeaseID, "redis unavailable", time.Second,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE collaboration_eviction_outbox SET available_at=now()`); err != nil {
		t.Fatal(err)
	}
	retried, err := s.ClaimCollaborationEvictions(ctx, 10, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(retried) != 1 || retried[0].ID != first.ID || retried[0].Attempts != 2 {
		t.Fatalf("retry = %+v, want same id with two attempts", retried)
	}
	if err := s.CompleteCollaborationEviction(
		ctx, retried[0].ID, retried[0].LeaseID,
	); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM collaboration_eviction_outbox`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("remaining evictions = %d, want 0", remaining)
	}
}

// queuedEvictions runs change and returns what it queued, "<channel's last
// part> <mode>" per row, sorted.
func queuedEvictions(t *testing.T, s *Store, change func() error) []string {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `DELETE FROM collaboration_eviction_outbox`); err != nil {
		t.Fatal(err)
	}
	if err := change(); err != nil {
		t.Fatal(err)
	}
	rows, err := s.pool.Query(ctx, `SELECT regexp_replace(channel, '^.*:', '') || ' ' || (payload->>'mode')
		FROM collaboration_eviction_outbox ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	queued, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return queued
}

// Security regression (Q634, Epo 2026-11-05): an access change touches rooms
// only as far as it takes something from someone. Adding a member, raising a
// role and widening sharing queue nothing (nobody is closed, not even the
// person who gained); removing a member, lowering a role, narrowing sharing and
// transferring ownership queue a revoke of the workspace's note and file rooms,
// never a discard. Fails if a widening queues anything, or a narrowing queues
// anything but a revoke of both rooms (no revoke at all leaves the person
// connected).
func TestWorkspaceAccessChangesQueueARevokeOnlyWhenTheyNarrow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_revoke_owner")
	member := newBlobTestUser(t, s, "u_revoke_member")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	sourceTestSeed(t, s, owner, file.ID)
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, Kind: "note", Title: "Note", Content: content}); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) func() error {
		return func() error {
			_, err := s.pool.Exec(ctx, sql, args...)
			return err
		}
	}
	workspace := func(set string) func() error {
		return exec(`UPDATE workspaces SET `+set+` WHERE id=$1`, ws.ID)
	}
	const (
		addMember = `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,$3)`
		setRole   = `UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2`
		remove    = `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`
	)
	revoke := []string{"evict revoke", "evict revoke"}
	for _, step := range []struct {
		name   string
		change func() error
		want   []string
	}{
		{"a member added", exec(addMember, ws.ID, member, "viewer"), nil},
		{"a role raised", exec(setRole, ws.ID, member, "editor"), nil},
		{"a role unchanged", exec(setRole, ws.ID, member, "editor"), nil},
		{"a dormant share role raised", workspace(`share_role='editor'`), nil},
		{"a dormant share role lowered", workspace(`share_role='viewer'`), nil},
		{"private to link", workspace(`privacy='link'`), nil},
		{"link to public", workspace(`privacy='public'`), nil},
		{"the share role raised", workspace(`share_role='editor'`), nil},
		{"the share role lowered", workspace(`share_role='viewer'`), revoke},
		{"public to link", workspace(`privacy='link'`), revoke},
		{"link to private, the link gone", workspace(`privacy='private'`), revoke},
		{"a role lowered", exec(setRole, ws.ID, member, "viewer"), revoke},
		{"a member removed", exec(remove, ws.ID, member), revoke},
	} {
		if got := queuedEvictions(t, s, step.change); !slices.Equal(got, step.want) {
			t.Fatalf("%s queued %v, want %v", step.name, got, step.want)
		}
	}

	// A transfer narrows nobody's role, but moves whose account decides: the
	// workspace's change and the old owner's role each revoke.
	if _, err := s.pool.Exec(ctx, addMember, ws.ID, member, "editor"); err != nil {
		t.Fatal(err)
	}
	got := queuedEvictions(t, s, func() error {
		_, err := s.TransferWorkspace(ctx, owner, ws.ID, member)
		return err
	})
	if !slices.Equal(got, append(slices.Clone(revoke), revoke...)) {
		t.Fatalf("a transfer queued %v, want two revokes of both rooms", got)
	}
}

// Security regression (Q634): a standalone material's sharing behaves as a
// workspace's, and being trashed or moved stays a discard, a note's rows naming
// its room. Fails if widening queues anything, narrowing anything but a revoke,
// or a trashed or moved material is no longer discarded.
func TestMaterialSharingQueuesARevokeOnlyWhenItNarrows(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_revoke_material")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "note", Title: "Note", Content: content, Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Target", Tags: nil})
	if err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) func() error {
		return func() error {
			_, err := s.pool.Exec(ctx, sql, args...)
			return err
		}
	}
	for _, step := range []struct {
		name   string
		change func() error
		want   []string
	}{
		{"private to link", exec(`UPDATE materials SET privacy='link' WHERE id=$1`, material.ID), nil},
		{"link to public", exec(`UPDATE materials SET privacy='public' WHERE id=$1`, material.ID), nil},
		{"public to link", exec(`UPDATE materials SET privacy='link' WHERE id=$1`, material.ID), []string{"evict revoke"}},
		{"link to private", exec(`UPDATE materials SET privacy='private' WHERE id=$1`, material.ID), []string{"evict revoke"}},
		{"filed into a workspace", exec(`UPDATE materials SET workspace_id=$2 WHERE id=$1`, material.ID, workspace.ID), []string{"evict discard"}},
		{"trashed", exec(`UPDATE materials SET trashed_at=now(), trash_episode_id='ep_revoke', purge_after=now()+interval '30 days' WHERE id=$1`, material.ID), []string{"evict discard"}},
	} {
		if got := queuedEvictions(t, s, step.change); !slices.Equal(got, step.want) {
			t.Fatalf("%s queued %v, want %v", step.name, got, step.want)
		}
	}
}

// Security regression (Q634): a lowered plan or a lapsed subscription queues
// nothing, where it used to discard the owner's rooms and close the owner's
// connections everywhere: frozen and the storage limit are enforced at admission,
// the room-read-only strip (rooms.rs: a_plan_lapse_turns_the_rooms_read_only_at_the_next_update).
// Account locks stay a discard and restoration a drain. Fails if a lapse queues
// anything, or a lock stops discarding.
func TestAPlanLapseQueuesNothingAndALockStaysADiscard(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_revoke_plan")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "note", Title: "Note", Content: content, Privacy: PrivacyPrivate}); err != nil {
		t.Fatal(err)
	}
	user := func(set string) func() error {
		return func() error {
			_, err := s.pool.Exec(ctx, `UPDATE users SET `+set+` WHERE id=$1`, owner)
			return err
		}
	}
	restored := []string{"evict drain", "user-evict drain"}
	discard := []string{"evict discard", "user-evict discard"}
	for _, step := range []struct {
		name   string
		change func() error
		want   []string
	}{
		{"a plan bought", user(`plan_tier='pro', subscription_status='active'`), restored},
		{"payment past due", user(`subscription_status='past_due'`), restored},
		{"a subscription lapsed", user(`subscription_status='unpaid'`), nil},
		{"a plan lowered", user(`plan_tier='free', subscription_status='canceled'`), nil},
		{"a plan bought again", user(`plan_tier='pro', subscription_status='active'`), restored},
		{"a plan lowered at once", user(`plan_tier='free', subscription_status='none'`), nil},
		{"suspended", user(`suspended_at=now(), suspended_reason='test'`), discard},
		{"a plan change while suspended", user(`plan_tier='pro'`), discard},
	} {
		if got := queuedEvictions(t, s, step.change); !slices.Equal(got, step.want) {
			t.Fatalf("%s queued %v, want %v", step.name, got, step.want)
		}
	}
	if got := queuedEvictions(t, s, user(`suspended_at=NULL, suspended_reason=NULL`)); !slices.Equal(got, restored) {
		t.Fatalf("unsuspended queued %v, want %v", got, restored)
	}
}
