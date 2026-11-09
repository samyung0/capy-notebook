package store

import (
	"context"
	"errors"
	"testing"
)

// Q459 (Epo 2026-10-28, with Q447): a source save checks each person whose
// edits it stores against the workspace its room opened the file in. After
// a Move into the owner's own workspace, the drain's final save, naming the
// old workspace, stores the edits of an editor who is not in the new one, and
// the file's session then opens in the new workspace. Fails if the save
// checks the file's current workspace (the drain's save is refused) or the
// named one is ignored.
func TestASourceSaveIsCheckedAgainstTheWorkspaceItsRoomOpened(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_q459_owner")
	editor := newBlobTestUser(t, s, "u_q459_editor")
	opened, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`, opened.ID, editor); err != nil {
		t.Fatal(err)
	}
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "owner")
	target, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Mine", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: target.ID}); err != nil {
		t.Fatal(err)
	}

	// The drain's final save, by the room opened in the old workspace.
	drain := sourceTestSave(doc, owner, "both")
	drain.ActorIDs = []string{owner, editor}
	if drain.WorkspaceID != opened.ID {
		t.Fatalf("the room's workspace = %q, want %q", drain.WorkspaceID, opened.ID)
	}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, drain); err != nil {
		t.Fatalf("the drain's save = %v, want stored", err)
	}
	reopened, err := s.SourceSession(ctx, owner, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.WorkspaceID != target.ID || reopened.Checkpoint != doc.Checkpoint+1 {
		t.Fatalf("reopened in %q at %d, want %q at %d", reopened.WorkspaceID, reopened.Checkpoint, target.ID, doc.Checkpoint+1)
	}

	// A save naming no workspace is checked as a room that opened a file with
	// none: only the payer's (TestAStandaloneRoomsDrainSavesAsItsPayer).
	none := sourceTestSave(reopened, editor, "none")
	none.WorkspaceID = ""
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, none); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an editor's save naming no workspace = %v, want not found", err)
	}
}

// Security regression (Q634, Epo 2026-11-05: up to about 5 s of a removed
// person's last edits can survive): a room's save stores what its room admitted
// from someone who lost their role since, so the room is not discarded under
// everyone else, while admission refuses them at once. An agent edit with no
// room and an account lock still refuse the save. Fails if a room's save checks
// the contributors' roles (its next store would discard the room for everyone),
// or admission or a direct agent edit stops checking them.
func TestARoomsSaveStoresWhatItAdmittedFromSomeoneWhoLostTheirRole(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_q634_owner")
	editor := newBlobTestUser(t, s, "u_q634_editor")
	lowered := newBlobTestUser(t, s, "u_q634_lowered")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	for _, member := range []string{editor, lowered} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`, ws.ID, member); err != nil {
			t.Fatal(err)
		}
	}
	doc := sourceTestSeed(t, s, owner, file.ID)
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, editor); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, ws.ID, lowered); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckSourceAccess(ctx, editor, file.ID, doc.Epoch, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed editor's admission = %v, want not found", err)
	}
	if err := s.CheckSourceAccess(ctx, editor, file.ID, doc.Epoch, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed editor's read = %v, want not found", err)
	}
	if err := s.CheckSourceAccess(ctx, lowered, file.ID, doc.Epoch, true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a lowered editor's admission = %v, want not found", err)
	}
	if err := s.CheckSourceAccess(ctx, lowered, file.ID, doc.Epoch, false); err != nil {
		t.Fatalf("a lowered editor's read = %v", err)
	}
	save := sourceTestSave(doc, owner, "theirs")
	save.ActorIDs = []string{owner, editor, lowered}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, save); err != nil {
		t.Fatalf("the room's save = %v, want stored", err)
	}
	stored, err := s.SourceSession(ctx, owner, file.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Checkpoint != doc.Checkpoint+1 {
		t.Fatalf("checkpoint = %d, want %d", stored.Checkpoint, doc.Checkpoint+1)
	}
	// An agent edit with no room: nothing admitted it, so the save is its check.
	direct := sourceTestSave(stored, editor, "direct")
	direct.Operation = &SourceCheckpointOperation{Receipt: SourceCheckpointReceipt{ID: uid("op"), ToolVersion: 1, RequestHash: "h", ActorUserID: editor}}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, direct); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed editor's direct agent edit = %v, want not found", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, editor); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, sourceTestSave(stored, editor, "locked")); err == nil {
		t.Fatal("a save naming a suspended contributor was stored")
	}
}

// Security regression (Q634, review F3): the room's access check names a lost
// role, for the recheck to close that person as a revoke does, and only then: a
// removed member, a lowered writer, a link visitor after the link goes, a public
// visitor with no link after public turns to link, a viewer of a hidden file. A
// file gone or a gone owner is plain not found. Everyone reads it as not found.
// Fails if a lost role goes unnamed, or a gone file or owner reads as one.
func TestCheckSourceAccessNamesALostRole(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_role_lost_owner")
	member := newBlobTestUser(t, s, "u_role_lost_member")
	linked := newBlobTestUser(t, s, "u_role_lost_linked")
	visitor := newBlobTestUser(t, s, "u_role_lost_visitor")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestSeed(t, s, owner, file.ID)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	lost := func(actor string, edit bool) {
		t.Helper()
		if err := s.CheckSourceAccess(ctx, actor, file.ID, doc.Epoch, edit); !errors.Is(err, ErrSourceRoleLost) || !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s edit=%v = %v, want the role lost, read as not found", actor, edit, err)
		}
	}
	allowed := func(actor string, edit bool) {
		t.Helper()
		if err := s.CheckSourceAccess(ctx, actor, file.ID, doc.Epoch, edit); err != nil {
			t.Fatalf("%s edit=%v = %v, want allowed", actor, edit, err)
		}
	}
	gone := func(actor string) {
		t.Helper()
		if err := s.CheckSourceAccess(ctx, actor, file.ID, doc.Epoch, false); !errors.Is(err, ErrNotFound) || errors.Is(err, ErrSourceRoleLost) {
			t.Fatalf("%s = %v, want plain not found", actor, err)
		}
	}
	exec(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'editor')`, ws.ID, member)
	allowed(member, true)
	exec(`UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, ws.ID, member)
	lost(member, true)
	allowed(member, false)

	exec(`UPDATE files SET hidden=true WHERE id=$1`, file.ID)
	lost(member, false)
	exec(`UPDATE files SET hidden=false WHERE id=$1`, file.ID)

	exec(`DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, ws.ID, member)
	lost(member, false)

	exec(`UPDATE workspaces SET privacy='public' WHERE id=$1`, ws.ID)
	allowed(visitor, false)
	exec(`INSERT INTO workspace_link_grants (workspace_id,user_id) VALUES ($1,$2)`, ws.ID, linked)
	exec(`UPDATE workspaces SET privacy='link' WHERE id=$1`, ws.ID)
	lost(visitor, false)
	allowed(linked, false)
	exec(`UPDATE workspaces SET privacy='private' WHERE id=$1`, ws.ID)
	lost(linked, false)

	exec(`UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1`, owner)
	gone(member)
	exec(`UPDATE users SET deletion_requested_at=NULL, purge_after=NULL WHERE id=$1`, owner)
	exec(`UPDATE files SET trashed_at=now(), trash_episode_id='ep_role_lost', purge_after=now()+interval '30 days' WHERE id=$1`, file.ID)
	gone(member)
}
