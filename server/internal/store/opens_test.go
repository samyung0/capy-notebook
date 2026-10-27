package store

import (
	"context"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func listedIDs(t *testing.T, s *Store, userID string) []string {
	t.Helper()
	list, err := s.ListWorkspaces(context.Background(), userID, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(list))
	for i, w := range list {
		ids[i] = w.ID
	}
	return ids
}

func TestVisitedLinkWorkspaceListsWithItsFilesUntilForgotten(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	seedWorkspaceFiles(t, s, ws.ID, "u_owner", 1)
	visitor := newBlobTestUser(t, s, "u_visitor")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ($1, $2)`,
		ws.ID, visitor); err != nil {
		t.Fatal(err)
	}

	if err := s.RecordWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListWorkspaces(ctx, visitor, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != ws.ID || list[0].MemberRole != "" {
		t.Fatalf("visitor's workspaces = %+v, want the visited one as a nonmember", list)
	}
	files, err := s.ListOwnedFiles(ctx, visitor, FileListFilter{Member: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(files.Items) != 1 || files.Items[0].WorkspaceID != ws.ID {
		t.Fatalf("visitor's member files = %+v, want the visited workspace's file", files.Items)
	}

	if err := s.ForgetWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	if ids := listedIDs(t, s, visitor); len(ids) != 0 {
		t.Fatalf("after Forget = %v, want none", ids)
	}
	// Forget clears the debounce, so opening it again lists it at once.
	if err := s.RecordWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	if ids := listedIDs(t, s, visitor); len(ids) != 1 {
		t.Fatalf("after reopening = %v, want the workspace", ids)
	}
}

func TestRecentWorkspacesFollowTheCallersOwnOpens(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_visits")
	first, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "First", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Second", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordWorkspaceVisit(ctx, owner, first.ID); err != nil {
		t.Fatal(err)
	}
	if ids := listedIDs(t, s, owner); len(ids) != 2 || ids[0] != first.ID || ids[1] != second.ID {
		t.Fatalf("order = %v, want the opened workspace first", ids)
	}

	// A second open inside the window writes nothing: this process skips the
	// database, and another process (an empty map) meets the upsert's window.
	setOpened := func(at time.Time) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `UPDATE workspace_visits SET opened_at=$3 WHERE user_id=$1 AND workspace_id=$2`,
			owner, first.ID, at); err != nil {
			t.Fatal(err)
		}
	}
	opened := func() time.Time {
		t.Helper()
		var at time.Time
		if err := s.pool.QueryRow(ctx, `SELECT opened_at FROM workspace_visits WHERE user_id=$1 AND workspace_id=$2`,
			owner, first.ID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	old := time.Now().Add(-time.Hour).UTC().Truncate(time.Microsecond)
	setOpened(old)
	if err := s.RecordWorkspaceVisit(ctx, owner, first.ID); err != nil {
		t.Fatal(err)
	}
	if got := opened(); !got.Equal(old) {
		t.Fatalf("opened_at = %v, want the earlier %v kept by the process window", got, old)
	}
	recent := time.Now().Add(-time.Minute).UTC().Truncate(time.Microsecond)
	setOpened(recent)
	forgetWritten(openKey("workspace", owner, first.ID))
	if err := s.RecordWorkspaceVisit(ctx, owner, first.ID); err != nil {
		t.Fatal(err)
	}
	if got := opened(); !got.Equal(recent) {
		t.Fatalf("opened_at = %v, want %v kept by the upsert's window", got, recent)
	}
}

func TestPrivateWorkspaceDropsItsVisitorsVisits(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	visitor := newBlobTestUser(t, s, "u_visitor")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ($1, $2)`,
		ws.ID, visitor); err != nil {
		t.Fatal(err)
	}
	for _, user := range []string{visitor, "u_owner"} {
		if err := s.RecordWorkspaceVisit(ctx, user, ws.ID); err != nil {
			t.Fatal(err)
		}
	}
	private := PrivacyPrivate
	if _, err := s.UpdateWorkspaceSharing(ctx, "u_owner", ws.ID, &private, nil); err != nil {
		t.Fatal(err)
	}
	var left []string
	rows, err := s.pool.Query(ctx, `SELECT user_id FROM workspace_visits WHERE workspace_id=$1`, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		left = append(left, id)
	}
	if len(left) != 1 || left[0] != "u_owner" {
		t.Fatalf("visits after private = %v, want the owner's only", left)
	}
}

var recentKinds = []string{"note", "quiz", "flashcards", "mindmap", "diagram"}

func recentIDs(t *testing.T, s *Store, userID string) []string {
	t.Helper()
	opens, err := s.RecentOpens(context.Background(), userID, recentKinds, 20)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(opens))
	for i, open := range opens {
		ids[i] = open.ID
	}
	return ids
}

func TestRecentFollowsOpensAndCreation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	file, err := s.createReadyFile(ctx, ws.ID, "u_owner", "notes.pdf", "pdf", nil, "", 1, "sources/"+uid("f"))
	if err != nil {
		t.Fatal(err)
	}
	visitor := newBlobTestUser(t, s, "u_recent")
	content, err := materialdoc.Marshal(materialdoc.Empty())
	if err != nil {
		t.Fatal(err)
	}
	// Creating counts as opening.
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: visitor, Kind: "note", Title: "Mine", Content: content, Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	if ids := recentIDs(t, s, visitor); len(ids) != 1 || ids[0] != note.ID {
		t.Fatalf("recent after creating = %v, want the new note", ids)
	}

	// A visitor's open lists once the workspace is in their set, newest first.
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ($1, $2)`,
		ws.ID, visitor); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordItemOpen(ctx, visitor, OpenFile, file.ID); err != nil {
		t.Fatal(err)
	}
	if ids := recentIDs(t, s, visitor); len(ids) != 2 || ids[0] != file.ID || ids[1] != note.ID {
		t.Fatalf("recent after opening = %v, want the file then the note", ids)
	}

	// Forgetting the workspace takes its files out of Recent.
	if err := s.ForgetWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	if ids := recentIDs(t, s, visitor); len(ids) != 1 || ids[0] != note.ID {
		t.Fatalf("recent after Forget = %v, want the note only", ids)
	}
}

func TestVisitorReopenWritesAgainAfterAnotherProcessForgets(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, ws := createSharingTestWorkspace(t, s, ShareViewer)
	visitor := newBlobTestUser(t, s, "u_visitor")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_link_grants (workspace_id, user_id) VALUES ($1, $2)`,
		ws.ID, visitor); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	// The row goes without this process hearing of it (Forget elsewhere, or
	// the workspace turning private and back).
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_visits WHERE user_id=$1`, visitor); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordWorkspaceVisit(ctx, visitor, ws.ID); err != nil {
		t.Fatal(err)
	}
	if ids := listedIDs(t, s, visitor); len(ids) != 1 || ids[0] != ws.ID {
		t.Fatalf("after reopening = %v, want the workspace back", ids)
	}
}
