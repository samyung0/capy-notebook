package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func TestACLChangeQueuesRetryableStableEviction(t *testing.T) {
	s := openRevisionTestStore(t)
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
	if _, err := s.pool.Exec(ctx, `DELETE FROM collaboration_eviction_outbox`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='public' WHERE id=$1`, material.ID); err != nil {
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
		payload.Mode != "drain" ||
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

func TestWorkspaceMembershipAndLifecycleChangesQueueEvictions(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_eviction_scope_owner")
	memberID := newBlobTestUser(t, s, "u_eviction_scope_member")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Eviction scope", ColorBlue, nil)
	if err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMaterial(ctx, Material{
		CreatedBy:   ownerID,
		WorkspaceID: workspace.ID,
		Kind:        "note",
		Title:       "Eviction target",
		Content:     content,
	}); err != nil {
		t.Fatal(err)
	}
	clear := func() {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `DELETE FROM collaboration_eviction_outbox`); err != nil {
			t.Fatal(err)
		}
	}
	count := func(channel string) int {
		t.Helper()
		var value int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM collaboration_eviction_outbox WHERE channel=$1`, channel).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	mode := func(channel string) string {
		t.Helper()
		var value string
		if err := s.pool.QueryRow(ctx, `SELECT payload->>'mode'
			FROM collaboration_eviction_outbox WHERE channel=$1
			ORDER BY created_at LIMIT 1`, channel).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	eventType := func(channel string) string {
		t.Helper()
		var value string
		if err := s.pool.QueryRow(ctx, `SELECT payload->>'type'
			FROM collaboration_eviction_outbox WHERE channel=$1
			ORDER BY created_at LIMIT 1`, channel).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if got := count("capy:collaboration:evict"); got != 1 {
		t.Fatalf("workspace ACL queued %d room evictions, want 1", got)
	}
	if got := mode("capy:collaboration:evict"); got != "drain" {
		t.Fatalf("workspace widening mode = %q, want drain", got)
	}
	if got := eventType("capy:collaboration:evict"); got != "access-changed" {
		t.Fatalf("workspace widening room event = %q, want access-changed", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces
		SET privacy='private', share_role='editor' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces
		SET privacy='public', share_role='viewer' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if got := mode("capy:collaboration:evict"); got != "drain" {
		t.Fatalf("effective private-to-public widening mode = %q, want drain", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces
		SET privacy='private', share_role='editor' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces
		SET share_role='viewer' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if got := mode("capy:collaboration:evict"); got != "drain" {
		t.Fatalf("dormant private role change mode = %q, want drain", got)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces
		SET privacy='public' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'viewer')`, workspace.ID, memberID); err != nil {
		t.Fatal(err)
	}
	if got := count("capy:collaboration:evict"); got != 1 {
		t.Fatalf("membership ACL queued %d room evictions, want 1", got)
	}
	if got := mode("capy:collaboration:evict"); got != "drain" {
		t.Fatalf("membership insert mode = %q, want drain", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members
		WHERE workspace_id=$1 AND user_id=$2`, workspace.ID, memberID); err != nil {
		t.Fatal(err)
	}
	if got := mode("capy:collaboration:evict"); got != "discard" {
		t.Fatalf("membership removal mode = %q, want discard", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if got := count("capy:collaboration:user-evict"); got != 1 {
		t.Fatalf("lifecycle queued %d user evictions, want 1", got)
	}
	if got := count("capy:collaboration:evict"); got != 1 {
		t.Fatalf("lifecycle queued %d owned-room evictions, want 1", got)
	}
	if got := mode("capy:collaboration:user-evict"); got != "discard" {
		t.Fatalf("account suspension user mode = %q, want discard", got)
	}
	if got := mode("capy:collaboration:evict"); got != "discard" {
		t.Fatalf("account suspension room mode = %q, want discard", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE users
		SET suspended_at=NULL, suspended_reason=NULL WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if got := mode("capy:collaboration:user-evict"); got != "drain" {
		t.Fatalf("account restoration user mode = %q, want drain", got)
	}
	if got := mode("capy:collaboration:evict"); got != "drain" {
		t.Fatalf("account restoration room mode = %q, want drain", got)
	}
	if got := eventType("capy:collaboration:evict"); got != "account-access-restored" {
		t.Fatalf("account restoration room event = %q, want account-access-restored", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE users
		SET plan_tier='pro', subscription_status='active' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if got := mode("capy:collaboration:user-evict"); got != "drain" {
		t.Fatalf("plan improvement user mode = %q, want drain", got)
	}
	if got := mode("capy:collaboration:evict"); got != "drain" {
		t.Fatalf("plan improvement room mode = %q, want drain", got)
	}
	if got := eventType("capy:collaboration:evict"); got != "account-access-restored" {
		t.Fatalf("plan improvement room event = %q, want account-access-restored", got)
	}

	clear()
	if _, err := s.pool.Exec(ctx, `UPDATE users
		SET plan_tier='free', subscription_status='canceled' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if got := mode("capy:collaboration:user-evict"); got != "discard" {
		t.Fatalf("plan downgrade user mode = %q, want discard", got)
	}
	if got := mode("capy:collaboration:evict"); got != "discard" {
		t.Fatalf("plan downgrade room mode = %q, want discard", got)
	}
}
