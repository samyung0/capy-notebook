package store

import (
	"context"
	"testing"
	"time"
)

// pushOverQuota puts a user into over_quota_grace the way production does: a
// paid period that has ended, plus stored bytes above the free limit.
func pushOverQuota(t *testing.T, s *Store, userID, workspaceID string) {
	t.Helper()
	ctx := context.Background()
	subID := uid("sub")
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subID, 1000)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSourceReady(ctx, workspaceID, userID, "big.pdf", "pdf", nil, "",
		mustPlanLimits(t, s, PlanFree).StorageBytes+1, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	lapsed := time.Now().Add(-2 * 24 * time.Hour).UTC()
	ended := proSubscription(userID, subID, 2000)
	ended.Status = "canceled"
	ended.CurrentPeriodEnd = &lapsed
	if err := s.UpsertSubscription(ctx, ended); err != nil {
		t.Fatal(err)
	}
}

// Collaboration write direction has to follow the account that is charged for
// the bytes, not the account that is typing. Keying it on the actor was wrong in
// both directions: it made an over-quota editor shrink-only inside a healthy
// owner's workspace, and let an active editor grow a document whose owner was
// already over their limit.
func TestCollaborationWriteDirectionFollowsTheStorageOwner(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	overQuotaUser := newBlobTestUser(t, s, "collab_over")
	healthyUser := newBlobTestUser(t, s, "collab_ok")

	overQuotaWS, err := s.CreateWorkspace(ctx, overQuotaUser, "Over quota", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	healthyWS, err := s.CreateWorkspace(ctx, healthyUser, "Healthy", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, healthyWS.ID, overQuotaUser)

	// Both materials are authored by the over-quota user. Only the workspace
	// they sit in differs, which is exactly the distinction the old actor-keyed
	// check could not see.
	inOverQuotaWS, err := s.CreateMaterial(ctx, Material{
		CreatedBy: overQuotaUser, WorkspaceID: overQuotaWS.ID, Kind: "note", Title: "Theirs",
	})
	if err != nil {
		t.Fatal(err)
	}
	inHealthyWS, err := s.CreateMaterial(ctx, Material{
		CreatedBy: overQuotaUser, WorkspaceID: healthyWS.ID, Kind: "note", Title: "Someone else's",
	})
	if err != nil {
		t.Fatal(err)
	}

	pushOverQuota(t, s, overQuotaUser, overQuotaWS.ID)

	actor, err := s.AccountAccess(ctx, overQuotaUser)
	if err != nil {
		t.Fatal(err)
	}
	if !actor.ShrinkOnly() {
		t.Fatalf("test setup did not reach an over-quota state, got %s", actor.State)
	}

	owned, err := s.MaterialOwnerAccess(ctx, inOverQuotaWS.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !owned.ShrinkOnly() {
		t.Fatalf("a material owned by an over-quota account must be shrink-only, got %s", owned.State)
	}

	guest, err := s.MaterialOwnerAccess(ctx, inHealthyWS.ID)
	if err != nil {
		t.Fatal(err)
	}
	if guest.State != AccountActive {
		t.Fatalf("an over-quota editor writing into a healthy owner's workspace spends the "+
			"owner's quota, so the room stays fully writable; got %s", guest.State)
	}
}

// The inverse: an active editor must not be able to grow a document that lands
// on an over-quota owner's counter.
func TestActiveEditorCannotGrowAnOverQuotaOwnersMaterial(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	owner := newBlobTestUser(t, s, "collab_owner")
	editor := newBlobTestUser(t, s, "collab_editor")

	ws, err := s.CreateWorkspace(ctx, owner, "Owner workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, ws.ID, editor)
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: editor, WorkspaceID: ws.ID, Kind: "note", Title: "Written by the editor",
	})
	if err != nil {
		t.Fatal(err)
	}
	if material.OwnerUserID != owner {
		t.Fatalf("storage owner = %q, want the workspace owner %q", material.OwnerUserID, owner)
	}

	pushOverQuota(t, s, owner, ws.ID)

	actor, err := s.AccountAccess(ctx, editor)
	if err != nil {
		t.Fatal(err)
	}
	if actor.State != AccountActive {
		t.Fatalf("the editor's own account is healthy, got %s", actor.State)
	}
	access, err := s.MaterialOwnerAccess(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !access.ShrinkOnly() {
		t.Fatalf("an active editor must not push an over-quota owner further over, got %s", access.State)
	}
}
