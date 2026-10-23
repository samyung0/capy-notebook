package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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
		CreatedBy: member, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Member note",
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
	memberNote, err := s.CreateMaterial(ctx, Material{CreatedBy: member, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Member note"})
	if err != nil {
		t.Fatal(err)
	}
	ownerNote, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Owner note"})
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
	listed, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Listed"})
	if err != nil {
		t.Fatal(err)
	}
	trashed, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Trashed"})
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
	other, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, Kind: "note", Content: materialTestContent(t, ""), Title: "Standalone"})
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

// Listing scopes outside a workspace (Sam 2026-10-19): the Files page lists
// what the caller pays for; Recent and search what it can open; a lost row
// shows only its name and size and pages without leaking what it hides; past
// reviews and notifications blank names the caller can no longer reach.
func TestListingScopesOutsideAWorkspace(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_scope_owner")
	member := newBlobTestUser(t, s, "u_scope_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Scope Hall", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
	addWorkspaceEditor(t, s, ws.ID, member)
	chapter, err := s.AddChapter(ctx, ws.ID, owner, "Week one")
	if err != nil {
		t.Fatal(err)
	}
	ownerFile, err := s.createReadyFile(ctx, ws.ID, owner, "owner-scope.pdf", "pdf", &chapter.ID, "", 10, "sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	memberFile, err := s.createReadyFile(ctx, ws.ID, member, "member-scope.pdf", "pdf", &chapter.ID, "", 20, "sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	memberNote, err := s.CreateMaterial(ctx, Material{
		CreatedBy: member, WorkspaceID: ws.ID, WorkspaceName: ws.Name, ChapterID: &chapter.ID, Kind: "note", Content: materialTestContent(t, ""), Title: "Member scope note",
	})
	if err != nil {
		t.Fatal(err)
	}
	fileIDs := func(user string, member bool) []string {
		t.Helper()
		page, err := s.ListOwnedFiles(ctx, user, FileListFilter{Member: member, WorkspaceIDs: []string{ws.ID}})
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, file := range page.Items {
			ids = append(ids, file.ID)
		}
		slices.Sort(ids)
		return ids
	}
	both := []string{ownerFile.ID, memberFile.ID}
	slices.Sort(both)
	searched := func(user string) []string {
		t.Helper()
		results, err := s.Search(ctx, user, "scope.pdf")
		if err != nil {
			t.Fatal(err)
		}
		ids := []string{}
		for _, result := range results {
			ids = append(ids, result.ID)
		}
		slices.Sort(ids)
		return ids
	}
	// The Files page is the storage breakdown; Recent and search span what
	// each can open, a member's uploads and the owner's alike.
	if got := fileIDs(owner, false); !slices.Equal(got, []string{ownerFile.ID}) {
		t.Fatalf("owner's Files = %v, want only what the owner pays for", got)
	}
	for _, user := range []string{owner, member} {
		if got := fileIDs(user, true); !slices.Equal(got, both) {
			t.Fatalf("%s Recent = %v, want both files", user, got)
		}
		if got := searched(user); !slices.Equal(got, both) {
			t.Fatalf("%s search = %v, want both files", user, got)
		}
	}
	// The owner sees a member's trash inside its workspace, not on its Files page.
	trashed, err := s.TrashFile(ctx, owner, memberFile.ID, AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	for _, scope := range []struct {
		workspace string
		want      int
	}{{"", 0}, {ws.ID, 1}} {
		page, err := s.ListTrash(ctx, owner, scope.workspace, 0, "")
		if err != nil || len(page.Items) != scope.want {
			t.Fatalf("owner trash in %q = %+v, %v; want %d", scope.workspace, page.Items, err, scope.want)
		}
	}
	if _, err := s.RestoreTrashed(ctx, owner, agenttools.KindSourceFile, memberFile.ID, trashed.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}

	// A review the member finished there, and the notice of its removal.
	if _, err := s.pool.Exec(ctx, `INSERT INTO review_sessions
		(id, user_id, workspace_id, chapter_id, group_kind, items, started_at, last_answer_at, finished_at)
		VALUES (gen_random_uuid(), $1, $2, $3, 'chapter', '[]', now(), now(), now())`, member, ws.ID, chapter.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveWorkspaceMember(ctx, owner, ws.ID, member); err != nil {
		t.Fatal(err)
	}

	// Gone from what the member can open; still on its Files page, as name
	// and size only.
	if got := fileIDs(member, true); len(got) != 0 {
		t.Fatalf("removed member's Recent = %v, want none", got)
	}
	if got := searched(member); len(got) != 0 {
		t.Fatalf("removed member's search = %v, want none", got)
	}
	files, err := s.ListOwnedFiles(ctx, member, FileListFilter{})
	if err != nil || len(files.Items) != 1 {
		t.Fatalf("removed member's Files = %+v, %v", files.Items, err)
	}
	if got := files.Items[0]; !got.LostAccess || got.Name != "member-scope.pdf" || got.SizeBytes != 20 ||
		got.ChapterID != nil || got.Status != "" || got.Revision != 0 || got.PreviewURL != nil || got.WorkspaceName != ws.Name {
		t.Fatalf("lost file = %+v, want name, size and workspace only", got)
	}
	blocks, err := s.ListOwnedMaterials(ctx, member, MaterialListFilter{})
	if err != nil || len(blocks.Items) != 1 {
		t.Fatalf("removed member's Blocks = %+v, %v", blocks.Items, err)
	}
	if got := blocks.Items[0]; !got.LostAccess || got.ID != memberNote.ID || got.Title != memberNote.Title ||
		got.ChapterID != nil || got.ChapterName != "" || got.UpdatedAt != got.CreatedAt || got.Preview != nil {
		t.Fatalf("lost block = %+v, want name and size only", got)
	}
	reviews, _, err := s.PastReviews(ctx, member, PastReviewParams{Limit: 10})
	if err != nil || len(reviews) != 1 || reviews[0].WorkspaceName != "" || reviews[0].ChapterName != "" || reviews[0].IconID != "" {
		t.Fatalf("removed member's past review = %+v, %v; want the names blank", reviews, err)
	}
	notices, err := s.ListNotifications(ctx, member, 10, "")
	if err != nil {
		t.Fatal(err)
	}
	removal := slices.IndexFunc(notices.Items, func(n Notification) bool { return n.WorkspaceID == ws.ID })
	if removal < 0 || notices.Items[removal].WorkspaceName != "" {
		t.Fatalf("removal notice = %+v, want it without the live workspace name", notices.Items)
	}

	// Nothing a lost row hides reaches a cursor: the owner renames the note
	// after the member left, then is suspended, which hides the workspace's
	// name. One per page, the page ending on the lost row pages on its
	// creation time and the blank name.
	renamed := "Renamed by the owner"
	if _, err := s.UpdateMaterial(ctx, memberNote.ID, MaterialPatch{Title: &renamed, UpdatedBy: owner}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateMaterial(ctx, Material{CreatedBy: member, Kind: "note", Content: materialTestContent(t, ""), Title: "Loose"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id=$1`, owner)
	})
	for _, sort := range []struct {
		name      string
		ascending bool
	}{{"updated", true}, {"workspace", false}} {
		page, err := s.ListOwnedMaterials(ctx, member, MaterialListFilter{Sort: sort.name, Ascending: sort.ascending, Limit: 1})
		if err != nil || len(page.Items) != 1 || page.NextCursor == "" {
			t.Fatalf("%s first page = %+v, %v", sort.name, page, err)
		}
		primary, _, _, err := decodeListCursor(page.NextCursor)
		if err != nil {
			t.Fatal(err)
		}
		want := ""
		if sort.name == "updated" {
			if page.Items[0].ID != memberNote.ID {
				t.Fatalf("updated ascending starts with %s, want the lost note by its creation time", page.Items[0].ID)
			}
			want = memberNote.CreatedAt.UTC().Format(time.RFC3339Nano)
		}
		if primary != want {
			t.Fatalf("%s cursor = %q, want %q", sort.name, primary, want)
		}
	}
}

// m16Note is the owner's note in a workspace the editor edits, and a reader
// of storage usage.
func m16Note(t *testing.T, s *Store, owner, editor string) (Workspace, Material, func(string) StorageUsage) {
	t.Helper()
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Media", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
	addWorkspaceEditor(t, s, ws.ID, editor)
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Owner's note"})
	if err != nil {
		t.Fatal(err)
	}
	return ws, note, func(user string) StorageUsage {
		t.Helper()
		usage, err := s.StorageUsage(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		return usage
	}
}

// Images and audio follow their uploader, as files do (Epo 2026-10-24, M16):
// an editor's image in the owner's note is reserved and charged to the
// editor, who completes it, and nothing is charged to the owner.
func TestNoteMediaIsChargedToItsUploader(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_charge_owner")
	editor := newBlobTestUser(t, s, "u_m16_charge_editor")
	ws, note, usage := m16Note(t, s, owner, editor)
	ownerBefore := usage(owner)
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	asset, upload := f.reserve(editor, ws.ID, note.ID)
	if asset.UserID != editor || upload.UserID != editor {
		t.Fatalf("asset payer %s, reservation payer %s; want the uploader %s", asset.UserID, upload.UserID, editor)
	}
	if got := usage(editor); got.ReservedBytes != 100 {
		t.Fatalf("editor reserved %d, want the image's 100 bytes", got.ReservedBytes)
	}
	if _, err := s.FinalizeEditorAssetUpload(ctx, upload.ID, "etag"); err != nil {
		t.Fatalf("the uploader completing its reservation = %v", err)
	}
	if got := usage(editor); got.UsedBytes != 100 || got.ReservedBytes != 0 {
		t.Fatalf("editor usage = %+v, want the image's 100 bytes used", got)
	}
	if got := usage(owner); got != ownerBefore {
		t.Fatalf("owner usage = %+v, want unchanged %+v", got, ownerBefore)
	}
}

// An uploader at its storage limit is refused on its own quota, while the
// owner still adds images to the note and the note stays editable for both:
// its view-only state follows only its own payer (M16).
func TestFullUploaderIsRefusedWhileTheNoteStaysEditable(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_full_owner")
	editor := newBlobTestUser(t, s, "u_m16_full_editor")
	ws, note, _ := m16Note(t, s, owner, editor)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`,
		editor, mustPlanLimits(t, s, PlanFree).StorageBytes); err != nil {
		t.Fatal(err)
	}
	reserve := func(actor string) error {
		_, _, err := s.CreateEditorAssetReservation(ctx, NewEditorAssetReservation{
			AssetID: uid("asset"), UploadID: uid("eau"), WorkspaceID: ws.ID, MaterialID: note.ID, CreatedBy: actor,
			Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/incoming/" + uid("blob"),
			ContentType: "image/png", DeclaredSize: 100, ExpiresAt: time.Now().Add(time.Hour),
		})
		return err
	}
	var quota *QuotaExceededError
	if err := reserve(editor); !errors.As(err, &quota) || quota.UserID != editor {
		t.Fatalf("a full editor's image = %v, want its own storage_quota_exceeded", err)
	}
	if err := reserve(owner); err != nil {
		t.Fatalf("the owner's image = %v, want reserved", err)
	}
	for _, actor := range []string{owner, editor} {
		if err := s.assertContentEditableTx(ctx, s.pool, note.OwnerUserID, actor); err != nil {
			t.Fatalf("%s editing the note = %v, want editable", actor, err)
		}
	}
}

// A removed member keeps paying for its images in the owner's note, an
// embedded set's included, and deletes them from its Files page, which lists
// them under the note it can no longer open. Neither another editor nor the
// note's owner deletes them, and a payer does not delete media in its own
// notes there; the note then reads each deleted one as removed.
func TestRemovedUploaderDeletesItsMediaFromTheFilesPage(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_lost_owner")
	editor := newBlobTestUser(t, s, "u_m16_lost_editor")
	ws, note, usage := m16Note(t, s, owner, editor)
	other := newBlobTestUser(t, s, "u_m16_lost_other")
	addWorkspaceEditor(t, s, ws.ID, other)
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	image := f.ready(editor, ws.ID, note.ID)
	set, err := s.CreateEmbeddedMaterial(ctx, editor, note.ID, EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}}})
	if err != nil {
		t.Fatal(err)
	}
	cardImage := f.ready(editor, ws.ID, set.ID)
	ownImage := f.ready(owner, ws.ID, note.ID)
	cards, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{ID: "c1", Front: "front", Back: "back", Image: &materialdoc.CardImage{AssetID: cardImage.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	for id, content := range map[string]string{note.ID: noteWithImages(t, image.ID, ownImage.ID), set.ID: cards} {
		if _, err := s.pool.Exec(ctx, `UPDATE materials SET content=$2 WHERE id=$1`, id, content); err != nil {
			t.Fatal(err)
		}
	}
	lost := func(user string) []LostEditorAsset {
		t.Helper()
		page, err := s.ListLostEditorAssets(ctx, user, 0, "")
		if err != nil {
			t.Fatal(err)
		}
		return page.Items
	}
	if got := lost(editor); len(got) != 0 {
		t.Fatalf("listed while the editor can open the note: %+v", got)
	}
	if err := s.RemoveWorkspaceMember(ctx, owner, ws.ID, editor); err != nil {
		t.Fatal(err)
	}
	if got := usage(editor); got.UsedBytes != 200 {
		t.Fatalf("removed editor uses %d, want its two images' 200 bytes", got.UsedBytes)
	}
	got := lost(editor)
	if len(got) != 2 || got[0].MaterialTitle != note.Title || got[1].MaterialTitle != note.Title ||
		got[0].Name != "figure.png" || got[0].SizeBytes != 100 {
		t.Fatalf("lost media = %+v, want both images under %q", got, note.Title)
	}
	if got := lost(owner); len(got) != 0 {
		t.Fatalf("owner's lost media = %+v, want none", got)
	}
	for _, actor := range []string{other, owner} {
		if err := s.DeleteEditorAsset(ctx, actor, image.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s deleting the editor's image = %v, want not found", actor, err)
		}
	}
	if err := s.DeleteEditorAsset(ctx, owner, ownImage.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the owner deleting its own note's image = %v, want not found", err)
	}
	for _, asset := range []EditorAsset{image, cardImage} {
		if err := s.DeleteEditorAsset(ctx, editor, asset.ID); err != nil {
			t.Fatalf("the removed editor deleting its image = %v", err)
		}
	}
	if got := usage(editor); got.UsedBytes != 0 {
		t.Fatalf("editor uses %d after deleting, want 0", got.UsedBytes)
	}
	// The note reads both as removed, its embedded set's card image too.
	removed, err := s.RemovedEditorAssetIDs(ctx, note.ID, []string{image.ID, ownImage.ID})
	want := []string{image.ID, cardImage.ID}
	slices.Sort(want)
	if err != nil || !slices.Equal(removed, want) {
		t.Fatalf("removed = %v, %v; want the two deleted images %v", removed, err, want)
	}
}

// Deleting the uploader's account deletes its images in other people's notes,
// which then read them as removed; the note and the owner's usage stay.
func TestAccountDeletionRemovesItsMediaFromOthersNotes(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_purge_owner")
	editor := newBlobTestUser(t, s, "u_m16_purge_editor")
	ws, note, usage := m16Note(t, s, owner, editor)
	image := editorAssetFixture{t: t, s: s, ctx: ctx}.ready(editor, ws.ID, note.ID)
	ownerBefore := usage(owner)
	if _, err := s.RequestAccountDeletion(ctx, editor, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, editor); err != nil {
		t.Fatal(err)
	}
	var assets, notes int
	if err := s.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM editor_assets WHERE id=$1),
		(SELECT count(*) FROM materials WHERE id=$2)`, image.ID, note.ID).Scan(&assets, &notes); err != nil {
		t.Fatal(err)
	}
	if assets != 0 || notes != 1 {
		t.Fatalf("after the purge: %d images, %d notes; want the image gone and the note kept", assets, notes)
	}
	if removed, err := s.MissingEditorAssetIDs(ctx, []string{image.ID}); err != nil || !slices.Equal(removed, []string{image.ID}) {
		t.Fatalf("removed = %v, %v", removed, err)
	}
	if got := usage(owner); got != ownerBefore {
		t.Fatalf("owner usage = %+v, want unchanged %+v", got, ownerBefore)
	}
}

// A pasted copy of an image is charged to the account that pastes it.
func TestPastedImageIsChargedToThePaster(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_paste_owner")
	editor := newBlobTestUser(t, s, "u_m16_paste_editor")
	ws, source, usage := m16Note(t, s, owner, editor)
	target, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Target"})
	if err != nil {
		t.Fatal(err)
	}
	original := editorAssetFixture{t: t, s: s, ctx: ctx}.ready(owner, ws.ID, source.ID)
	ownerBefore := usage(owner)
	adopted, refused, err := s.AdoptEditorAssets(ctx, editor, ws.ID, target.ID, []string{original.ID}, mustPlanLimits(t, s, PlanFree))
	if err != nil || refused || adopted[original.ID] == "" {
		t.Fatalf("paste = %v refused %v, %v", adopted, refused, err)
	}
	copied, err := s.GetEditorAsset(ctx, adopted[original.ID])
	if err != nil || copied.UserID != editor {
		t.Fatalf("copy = %+v, %v; want it charged to the paster %s", copied, err, editor)
	}
	if got := usage(editor); got.UsedBytes != 100 {
		t.Fatalf("paster uses %d, want the copy's 100 bytes", got.UsedBytes)
	}
	if got := usage(owner); got != ownerBefore {
		t.Fatalf("owner usage = %+v, want unchanged %+v", got, ownerBefore)
	}
}

// A figure the chat agent places in someone else's note is charged to the
// account chatting.
func TestAgentFigureIsChargedToTheActor(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_agent_owner")
	editor := newBlobTestUser(t, s, "u_m16_agent_editor")
	_, note, usage := m16Note(t, s, owner, editor)
	ownerBefore := usage(owner)
	figure := AgentAsset{
		ID: ChatAssetID(uid("msg"), "figure"), Name: "figure.jpg", ObjectPath: "editor-assets/" + uid("blob") + ".jpg",
		ContentType: "image/jpeg", SizeBytes: 200,
	}
	if created, err := s.EnsureAgentAssets(ctx, editor, note.ID, []AgentAsset{figure}); err != nil || len(created) != 1 {
		t.Fatalf("figure = %v, %v", created, err)
	}
	stored, err := s.GetEditorAsset(ctx, figure.ID)
	if err != nil || stored.UserID != editor {
		t.Fatalf("figure = %+v, %v; want it charged to the actor %s", stored, err, editor)
	}
	if got := usage(editor); got.UsedBytes != 200 {
		t.Fatalf("actor uses %d, want the figure's 200 bytes", got.UsedBytes)
	}
	if got := usage(owner); got != ownerBefore {
		t.Fatalf("owner usage = %+v, want unchanged %+v", got, ownerBefore)
	}
}

// An embedded quiz or flashcard set an editor creates in the owner's note
// stays charged to the note's payer (Sam 2026-10-19), unlike its images.
func TestEmbeddedSetStaysChargedToTheNotesPayer(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_m16_embed_owner")
	editor := newBlobTestUser(t, s, "u_m16_embed_editor")
	_, note, usage := m16Note(t, s, owner, editor)
	set, err := s.CreateEmbeddedMaterial(ctx, editor, note.ID, EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}}})
	if err != nil {
		t.Fatal(err)
	}
	if set.OwnerUserID != owner || set.CreatedBy != editor {
		t.Fatalf("embedded set payer %s, creator %s; want the note's payer and the editor", set.OwnerUserID, set.CreatedBy)
	}
	if got := usage(editor); got.UsedBytes != 0 || got.ReservedBytes != 0 {
		t.Fatalf("editor usage = %+v, want nothing charged", got)
	}
}

// A frozen payer refuses an image added to its note by anyone: here a member
// whose note sits in a healthy owner's workspace, so only the note's payer
// (not the workspace owner) can be the reason.
func TestFrozenNotePayerRefusesAddedImages(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_frozen_doc_owner")
	payer := newBlobTestUser(t, s, "u_frozen_doc_payer")
	editor := newBlobTestUser(t, s, "u_frozen_doc_editor")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Frozen docs", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
	addWorkspaceEditor(t, s, ws.ID, payer)
	addWorkspaceEditor(t, s, ws.ID, editor)
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Frozen note"})
	if err != nil {
		t.Fatal(err)
	}
	pushFrozen(t, s, payer, ws.ID)
	_, _, err = s.CreateEditorAssetReservation(ctx, NewEditorAssetReservation{
		AssetID: uid("asset"), UploadID: uid("eau"), WorkspaceID: ws.ID, MaterialID: note.ID, CreatedBy: editor,
		Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/incoming/" + uid("blob"),
		ContentType: "image/png", DeclaredSize: 100, ExpiresAt: time.Now().Add(time.Hour),
	})
	wantOverQuotaLock(t, "reserving into a frozen payer's note", err)
}

// A co-editor never learns another account's lifecycle lock or suspension
// reason: writes on what a suspended payer pays for answer not found
// (security review C2), while the frozen state still reads as frozen.
func TestCoEditorsDoNotSeeAPayersSuspension(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_c2_owner")
	payer := newBlobTestUser(t, s, "u_c2_payer")
	editor := newBlobTestUser(t, s, "u_c2_editor")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "C2", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
	addWorkspaceEditor(t, s, ws.ID, payer)
	addWorkspaceEditor(t, s, ws.ID, editor)
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: payer, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Content: materialTestContent(t, ""), Title: "Payer's note"})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.createReadyFile(ctx, ws.ID, payer, "payer.docx", "docx", nil, "", 10, "sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='private reason' WHERE id=$1`, payer); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id=$1`, payer)
	})
	title := "Renamed"
	_, updateErr := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Title: &title, UpdatedBy: editor})
	_, renameErr := s.UpdateFile(ctx, editor, file.ID, FilePatch{Name: &title})
	_, _, reserveErr := s.CreateEditorAssetReservation(ctx, NewEditorAssetReservation{
		AssetID: uid("asset"), UploadID: uid("eau"), WorkspaceID: ws.ID, MaterialID: note.ID, CreatedBy: editor,
		Name: "figure.png", Purpose: "image", ObjectPath: "editor-assets/incoming/" + uid("blob"),
		ContentType: "image/png", DeclaredSize: 100, ExpiresAt: time.Now().Add(time.Hour),
	})
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, _, sourceErr := s.sourceEditLockTx(ctx, tx, file.ID, editor)
	_ = tx.Rollback(ctx)
	for name, err := range map[string]error{"rename": updateErr, "file rename": renameErr, "image": reserveErr, "file edit": sourceErr} {
		var locked *AccountLockedError
		if errors.As(err, &locked) || !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s on a suspended payer's item = %v, want a plain not found", name, err)
		}
	}
}

// Source edits follow the file's payer (security review B7): a frozen owner
// leaves a member's file editable, a frozen payer under a healthy owner makes
// its file refuse a healthy editor, and a checkpoint for a deleting payer is
// refused before it waits on the file row. Each case fails on the old
// owner-only check.
func TestSourceEditsFollowTheFilesPayer(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	member := newBlobTestUser(t, s, "u_b7_member")
	editor := newBlobTestUser(t, s, "u_b7_editor")
	workspace := func(owner string) (string, File) {
		t.Helper()
		ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "B7", Tags: []TagRef{}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), owner, ws.ID) })
		addWorkspaceEditor(t, s, ws.ID, member)
		addWorkspaceEditor(t, s, ws.ID, editor)
		file, err := s.createReadyFile(ctx, ws.ID, member, "member.docx", "docx", nil, "", 10, "sources/"+uid("blob"))
		if err != nil {
			t.Fatal(err)
		}
		return ws.ID, file
	}
	editLock := func(fileID, actor string) error {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, _, err = s.sourceEditLockTx(ctx, tx, fileID, actor)
		return err
	}

	// A frozen owner: the member's file stays editable for the member.
	frozenOwner := newBlobTestUser(t, s, "u_b7_frozen_owner")
	frozenWS, kept := workspace(frozenOwner)
	pushFrozen(t, s, frozenOwner, frozenWS)
	if err := editLock(kept.ID, member); err != nil {
		t.Fatalf("member editing its file under a frozen owner = %v", err)
	}

	// A frozen payer under a healthy owner: a healthy editor is refused.
	healthyOwner := newBlobTestUser(t, s, "u_b7_healthy_owner")
	healthyWS, file := workspace(healthyOwner)
	pushFrozen(t, s, member, healthyWS)
	wantOverQuotaLock(t, "editor editing a frozen payer's file", editLock(file.ID, editor))

	// A deleting payer: the checkpoint answers at once while another
	// transaction holds the file row.
	if _, err := s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1`, member); err != nil {
		t.Fatal(err)
	}
	holder, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(ctx)
	if _, err := holder.Exec(ctx, `SELECT 1 FROM files WHERE id=$1 FOR UPDATE`, file.ID); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = s.SaveSourceCheckpoint(waitCtx, file.ID, SourceCheckpoint{
		ActorIDs: []string{editor}, Epoch: 1, BaseRevision: 1, Update: []byte{1}, PendingEffects: json.RawMessage(`[]`),
	})
	var locked *AccountLockedError
	if !errors.As(err, &locked) || locked.UserID != member {
		t.Fatalf("checkpoint for a deleting payer = %v, want the payer's lock before the file row", err)
	}
}

// Under a suspended owner the payer still trashes and purges what it pays for
// (Sam 2026-10-19), and still cannot read the workspace or restore.
func TestPayerPurgesUnderASuspendedOwner(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_susp_owner")
	payer := newBlobTestUser(t, s, "u_susp_payer")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Suspended", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, ws.ID, payer)
	file, err := s.createReadyFile(ctx, ws.ID, payer, "kept.pdf", "pdf", nil, "", 10, "sources/"+uid("blob"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WorkspaceAccess(ctx, payer, ws.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("payer reading a suspended owner's workspace = %v, want not found", err)
	}
	trashed, err := s.TrashFile(ctx, payer, file.ID, AgentOperation{})
	if err != nil {
		t.Fatalf("payer trashing under a suspended owner = %v", err)
	}
	episode := trashed.Effect.TrashEpisodeID
	if _, err := s.RestoreTrashed(ctx, payer, agenttools.KindSourceFile, file.ID, episode, AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("payer restoring under a suspended owner = %v, want not found", err)
	}
	if _, err := s.PurgeTrashed(ctx, payer, agenttools.KindSourceFile, file.ID, episode, AgentOperation{}); err != nil {
		t.Fatalf("payer purging under a suspended owner = %v", err)
	}
}
