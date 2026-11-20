package store

import (
	"context"
	"errors"
	"testing"
)

// The invite page reads an invite before Accept (Epo 2026-11-19) for its own
// invitee alone, answering not found wherever Accept would.
func TestInvitePreviewIsTheInviteesAlone(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_preview_owner")
	invitee := newBlobTestUser(t, s, "u_preview_invitee")
	stranger := newBlobTestUser(t, s, "u_preview_stranger")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Preview class", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, invitee, RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	var inviteID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM workspace_invites WHERE workspace_id=$1`, ws.ID).Scan(&inviteID); err != nil {
		t.Fatal(err)
	}

	got, err := s.PreviewWorkspaceInvite(ctx, inviteID, invitee)
	if err != nil {
		t.Fatal(err)
	}
	if got.Role != RoleViewer || got.WorkspaceKind != "class" {
		t.Fatalf("preview = %+v, want a class viewer", got)
	}
	if _, err := s.PreviewWorkspaceInvite(ctx, inviteID, stranger); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger's preview err = %v, want not found", err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, inviteID, invitee); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreviewWorkspaceInvite(ctx, inviteID, invitee); !errors.Is(err, ErrNotFound) {
		t.Fatalf("accepted invite's preview err = %v, want not found", err)
	}
}
