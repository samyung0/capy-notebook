package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Uploader pays (Sam 2026-10-18): what a member uploads, reserves or creates
// in someone else's workspace is charged to the member, and only the member
// completes its own reservation.
func TestMemberPaysForWhatItAddsToAWorkspace(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_pays_owner")
	member := newBlobTestUser(t, s, "u_pays_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Shared", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, ws.ID, member)

	upload, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: member,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "archive.zip", Kind: "unknown", ContentType: "application/zip",
		DeclaredSize: 300, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinalizeUploadSession(ctx, owner, upload.ID, "etag", "", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner completing the member's reservation = %v, want not found", err)
	}
	if _, err := s.FinalizeUploadSession(ctx, member, upload.ID, "etag", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMaterial(ctx, Material{
		CreatedBy: member, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Member note",
	}); err != nil {
		t.Fatal(err)
	}

	memberUsage, err := s.StorageUsage(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	ownerUsage, err := s.StorageUsage(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if memberUsage.UsedBytes <= 300 || ownerUsage.UsedBytes != 0 {
		t.Fatalf("member used=%d owner used=%d, want the file and note on the member only",
			memberUsage.UsedBytes, ownerUsage.UsedBytes)
	}
}

// A member at its storage limit makes only what it pays for view-only; the
// owner's items in the same workspace stay editable.
func TestFullPayerMakesOnlyItsOwnItemsViewOnly(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_full_owner")
	member := newBlobTestUser(t, s, "u_full_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Shared", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, ws.ID, member)
	memberNote, err := s.CreateMaterial(ctx, Material{CreatedBy: member, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Member note"})
	if err != nil {
		t.Fatal(err)
	}
	ownerNote, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Owner note"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE user_storage SET used_bytes=$2 WHERE user_id=$1`,
		member, mustPlanLimits(t, s, PlanFree).StorageBytes); err != nil {
		t.Fatal(err)
	}
	var quota *QuotaExceededError
	if memberNote.OwnerUserID != member || ownerNote.OwnerUserID != owner {
		t.Fatalf("payers = %s, %s; want each creator", memberNote.OwnerUserID, ownerNote.OwnerUserID)
	}
	if err := s.assertContentEditableTx(ctx, s.pool, memberNote.OwnerUserID, owner); !errors.As(err, &quota) {
		t.Fatalf("owner editing the full member's note = %v, want storage_quota_exceeded", err)
	}
	if err := s.assertContentEditableTx(ctx, s.pool, ownerNote.OwnerUserID, member); err != nil {
		t.Fatalf("member editing the owner's note = %v, want allowed", err)
	}
}

// A member removed from a workspace still pays for its uploads: the Files
// page lists them as lost access, the owner trashes one, and the member
// purges it from its own trash but cannot restore it.
func TestRemovedMemberSeesAndPurgesWhatItPaysFor(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_lost_owner")
	member := newBlobTestUser(t, s, "u_lost_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Shared", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, ws.ID, member)
	file, err := s.createReadyFile(ctx, ws.ID, member, "slides.pdf", "pdf", nil, "", 1000, "sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,
		ws.ID, member); err != nil {
		t.Fatal(err)
	}

	page, err := s.ListOwnedFiles(ctx, member, FileListFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != file.ID || !page.Items[0].LostAccess {
		t.Fatalf("member's files = %+v, want its upload marked lost access", page.Items)
	}
	// A public share still reaches the workspace, so nothing is lost; a
	// suspended owner's workspace is lost and loses its name too.
	listed := func() File {
		t.Helper()
		page, err := s.ListOwnedFiles(ctx, member, FileListFilter{})
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("member's files = %+v, %v", page.Items, err)
		}
		return page.Items[0]
	}
	for _, step := range []struct {
		sql       string
		lost      bool
		workspace string
	}{
		{`UPDATE workspaces SET privacy='public' WHERE id=$1`, false, ws.Name},
		{`UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=(SELECT user_id FROM workspaces WHERE id=$1)`, true, ""},
		{`UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id=(SELECT user_id FROM workspaces WHERE id=$1)`, false, ws.Name},
		{`UPDATE workspaces SET privacy='private' WHERE id=$1`, true, ws.Name},
	} {
		if _, err := s.pool.Exec(ctx, step.sql, ws.ID); err != nil {
			t.Fatal(err)
		}
		if got := listed(); got.LostAccess != step.lost || got.WorkspaceName != step.workspace {
			t.Fatalf("after %q: lost=%v workspace=%q, want %v %q", step.sql, got.LostAccess, got.WorkspaceName, step.lost, step.workspace)
		}
	}

	trashed, err := s.TrashFile(ctx, owner, file.ID, AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	trash, err := s.ListTrash(ctx, member, "", 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(trash.Items) != 1 || !trash.Items[0].LostAccess {
		t.Fatalf("member's trash = %+v, want the trashed upload marked lost access", trash.Items)
	}
	episode := trashed.Effect.TrashEpisodeID
	if _, err := s.RestoreTrashed(ctx, member, agenttools.KindSourceFile, file.ID, episode, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed member restoring = %v, want not found", err)
	}
	if _, err := s.PurgeTrashed(ctx, member, agenttools.KindSourceFile, file.ID, episode, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	usage, err := s.StorageUsage(ctx, member)
	if err != nil {
		t.Fatal(err)
	}
	if usage.UsedBytes != 0 {
		t.Fatalf("member used=%d after the purge, want 0", usage.UsedBytes)
	}
}
