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
// the file's session then opens in the new workspace. Removing that editor
// from the old workspace still refuses their edits there. Fails if the save
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
	if _, err := s.MoveFiles(ctx, owner, []string{file.ID}, MoveTarget{WorkspaceID: target.ID}, false); err != nil {
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

	// Access removed where the room opened: that editor's edits are refused.
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, opened.ID, editor); err != nil {
		t.Fatal(err)
	}
	late := sourceTestSave(reopened, editor, "late")
	late.WorkspaceID = opened.ID
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, late); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed editor's save = %v, want not found", err)
	}
	// A save naming no workspace is refused.
	none := sourceTestSave(reopened, owner, "none")
	none.WorkspaceID = ""
	if _, err := s.SaveSourceCheckpoint(ctx, file.ID, none); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a save naming no workspace = %v, want forbidden", err)
	}
}
