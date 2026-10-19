package store

import (
	"context"
	"errors"
	"slices"
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

// Lost access reads the same reach as every other path, on all three Files
// page listings: a redeemed link reaches the workspace, restore follows edit
// access, and a deletion-pending owner hides the workspace and its name. A
// hidden name still pages by the stored one (security review N1, N3).
func TestPayerListingsFollowReach(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_reach_owner")
	payer := newBlobTestUser(t, s, "u_reach_payer")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Reach", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, ws.ID, payer)
	if _, err := s.createReadyFile(ctx, ws.ID, payer, "slides.pdf", "pdf", nil, "", 10, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	listed, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Listed"})
	if err != nil {
		t.Fatal(err)
	}
	trashed, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Trashed"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.TrashMaterial(ctx, owner, trashed.ID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	// The payer leaves; the workspace is shared by link, for viewing.
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, payer); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='link', share_role='viewer' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}

	type view struct {
		lost       bool
		name       string
		canRestore bool
	}
	expect := func(step string, file, block, bin view) {
		t.Helper()
		files, err := s.ListOwnedFiles(ctx, payer, FileListFilter{})
		if err != nil || len(files.Items) != 1 {
			t.Fatalf("%s: files = %+v, %v", step, files.Items, err)
		}
		if got := (view{files.Items[0].LostAccess, files.Items[0].WorkspaceName, false}); got != file {
			t.Fatalf("%s: file = %+v, want %+v", step, got, file)
		}
		blocks, err := s.ListOwnedMaterials(ctx, payer, MaterialListFilter{})
		if err != nil || len(blocks.Items) != 1 || blocks.Items[0].ID != listed.ID {
			t.Fatalf("%s: blocks = %+v, %v", step, blocks.Items, err)
		}
		if got := (view{blocks.Items[0].LostAccess, blocks.Items[0].WorkspaceName, false}); got != block {
			t.Fatalf("%s: block = %+v, want %+v", step, got, block)
		}
		trash, err := s.ListTrash(ctx, payer, "", 0, "")
		if err != nil || len(trash.Items) != 1 {
			t.Fatalf("%s: trash = %+v, %v", step, trash.Items, err)
		}
		if got := (view{trash.Items[0].LostAccess, trash.Items[0].WorkspaceName, trash.Items[0].CanRestore}); got != bin {
			t.Fatalf("%s: trash item = %+v, want %+v", step, got, bin)
		}
	}
	lost := view{lost: true, name: ws.Name}
	expect("link not presented", lost, lost, lost)
	redeemLink(t, s, payer, ws.ID)
	reached := view{name: ws.Name}
	expect("link presented, viewer", reached, reached, reached)
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET share_role='editor' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	expect("link presented, editor", reached, reached, view{name: ws.Name, canRestore: true})
	if _, err := s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	closed := view{lost: true}
	expect("owner deleting", closed, closed, closed)

	// Sorted by workspace name, one per page: the hidden name pages by the
	// stored one, so every row comes once.
	other, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, Kind: "note", Title: "Standalone"})
	if err != nil {
		t.Fatal(err)
	}
	for _, ascending := range []bool{true, false} {
		seen := []string{}
		cursor := ""
		for range 4 {
			page, err := s.ListOwnedMaterials(ctx, payer, MaterialListFilter{Sort: "workspace", Ascending: ascending, Limit: 1, Cursor: cursor})
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range page.Items {
				seen = append(seen, item.ID)
			}
			if cursor = page.NextCursor; cursor == "" {
				break
			}
		}
		if len(seen) != 2 || seen[0] == seen[1] || !slices.Contains(seen, listed.ID) || !slices.Contains(seen, other.ID) {
			t.Fatalf("ascending=%v pages = %v, want %s and %s once each", ascending, seen, listed.ID, other.ID)
		}
	}

	// The payer still frees what it pays for while the owner is being
	// deleted: it trashes and purges the file and the note (Sam 2026-10-19,
	// review N2), though it cannot open them or restore them.
	files, err := s.ListOwnedFiles(ctx, payer, FileListFilter{})
	if err != nil || len(files.Items) != 1 {
		t.Fatalf("files = %+v, %v", files.Items, err)
	}
	fileTrash, err := s.TrashFile(ctx, payer, files.Items[0].ID, AgentOperation{})
	if err != nil {
		t.Fatalf("payer trashing under a deleting owner = %v", err)
	}
	if _, err := s.RestoreTrashed(ctx, payer, agenttools.KindSourceFile, files.Items[0].ID, fileTrash.Effect.TrashEpisodeID, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("payer restoring under a deleting owner = %v, want not found", err)
	}
	if _, err := s.PurgeTrashed(ctx, payer, agenttools.KindSourceFile, files.Items[0].ID, fileTrash.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatalf("payer purging the file = %v", err)
	}
	noteTrash, err := s.TrashMaterial(ctx, payer, listed.ID, "", AgentOperation{})
	if err != nil {
		t.Fatalf("payer trashing the note = %v", err)
	}
	if _, err := s.PurgeTrashed(ctx, payer, agenttools.KindMaterial, listed.ID, noteTrash.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatalf("payer purging the note = %v", err)
	}
	var left int
	if err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM files WHERE user_id=$1 AND workspace_id=$2)
		+ (SELECT count(*) FROM materials WHERE owner_user_id=$1 AND workspace_id=$2 AND id<>$3)`,
		payer, ws.ID, trashed.ID).Scan(&left); err != nil || left != 0 {
		t.Fatalf("payer's items left = %d, %v", left, err)
	}
}

// A projection charges the material's payer, so it locks the payer's row with
// the owner's and stops while the payer is being deleted, as the
// collaboration server does (security review N5).
func TestProjectionStopsForALockedPayer(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_proj_owner")
	payer := newBlobTestUser(t, s, "u_proj_payer")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Projection", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
	addWorkspaceEditor(t, s, ws.ID, payer)
	quiz, err := s.CreateMaterial(ctx, Material{
		CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "quiz", Title: "Payer's quiz",
		Content: quizProjection(t, 1, 1, 10, "a").Raw,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents
		(material_id, state, stored_version) VALUES ($1, '\x00'::bytea, 10)`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProjectMaterialContent(ctx, quiz.ID, quizProjection(t, 1, 1, 10, "b"), 1, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1`, payer); err != nil {
		t.Fatal(err)
	}
	var locked *AccountLockedError
	if _, err := s.ProjectMaterialContent(ctx, quiz.ID, quizProjection(t, 1, 1, 10, "c"), 2, nil); !errors.As(err, &locked) || locked.UserID != payer {
		t.Fatalf("projection for a deleting payer = %v, want its account locked", err)
	}
}
