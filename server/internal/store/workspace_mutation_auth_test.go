package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func addWorkspaceEditor(t *testing.T, s *Store, workspaceID, userID string) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO workspace_members
		(workspace_id, user_id, role) VALUES ($1,$2,'editor')`, workspaceID, userID); err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceMutationRechecksCurrentEditorRole(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_acl_owner")
	editorID := newBlobTestUser(t, s, "u_acl_editor")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "ACL workspace", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, workspace.ID, editorID)
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role='viewer'
		WHERE workspace_id=$1 AND user_id=$2`, workspace.ID, editorID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddChapter(ctx, workspace.ID, editorID, "Forbidden"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer chapter mutation error = %v, want forbidden", err)
	}
	if _, err := s.CreateMaterial(ctx, Material{
		CreatedBy: editorID, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
		Kind: "note", Title: "Forbidden", Content: `{"type":"p","children":[{"text":"x"}]}`,
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer material mutation error = %v, want forbidden", err)
	}
}

func TestUploadFinalizationRechecksCreatorMembership(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_upload_acl_owner")
	editorID := newBlobTestUser(t, s, "u_upload_acl_editor")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Upload ACL", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, workspace.ID, editorID)
	uploadID := uid("up")
	if _, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uploadID, WorkspaceID: workspace.ID, CreatedBy: editorID,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "notes.txt", Kind: "txt", ContentType: "text/plain",
		DeclaredSize: 10, ParseMode: "none", ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspace_members
		WHERE workspace_id=$1 AND user_id=$2`, workspace.ID, editorID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinalizeUploadSession(ctx, uploadID, "etag", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed editor finalize error = %v, want not found", err)
	}
	var files int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM files WHERE workspace_id=$1`,
		workspace.ID).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if files != 0 {
		t.Fatalf("removed editor finalized %d files", files)
	}
}

func TestConversationFollowsEffectiveRole(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_chat_acl_owner")
	editorID := newBlobTestUser(t, s, "u_chat_acl_editor")
	visitorID := newBlobTestUser(t, s, "u_chat_acl_visitor")
	workspace, err := s.CreateWorkspace(ctx, ownerID, "Chat ACL", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, workspace.ID, editorID)
	conversation, err := s.CreateConversation(ctx, editorID, workspace.ID, "Private chat")
	if err != nil {
		t.Fatal(err)
	}
	// A demoted viewer keeps chatting: chat needs any effective role, not edit.
	if _, err := s.pool.Exec(ctx, `UPDATE workspace_members SET role='viewer'
		WHERE workspace_id=$1 AND user_id=$2`, workspace.ID, editorID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConversation(ctx, editorID, conversation.ID); err != nil {
		t.Fatalf("viewer chat read error = %v", err)
	}
	if _, err := s.AddUserMessage(ctx, editorID, conversation.ID, "still here"); err != nil {
		t.Fatalf("viewer chat write error = %v", err)
	}
	// Threads are private per user even inside one workspace.
	if _, err := s.GetConversation(ctx, ownerID, conversation.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owner reading another user's thread error = %v, want not found", err)
	}
	// Non-members chat only while the workspace is link/public.
	if _, err := s.CreateConversation(ctx, visitorID, workspace.ID, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private workspace visitor chat error = %v, want not found", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='link' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	visitorConv, err := s.CreateConversation(ctx, visitorID, workspace.ID, "")
	if err != nil {
		t.Fatalf("link visitor chat error = %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='private' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConversation(ctx, visitorID, visitorConv.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked visitor chat read error = %v, want not found", err)
	}
	if _, err := s.AddUserMessage(ctx, visitorID, visitorConv.ID, "late"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked visitor chat write error = %v, want not found", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now(),
		purge_after=now()+interval '30 days' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetConversation(ctx, editorID, conversation.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleting-owner chat read error = %v, want not found", err)
	}
}
