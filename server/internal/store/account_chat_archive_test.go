package store

import (
	"context"
	"testing"
)

// Account chat's bulk archive actions touch the caller's account
// conversations alone, never its workspace ones.
func TestAccountArchivedConversationsStayInTheirScope(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_account_archive")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Chats", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	archived := true
	account, err := s.CreateConversation(ctx, owner, "", "account")
	if err != nil {
		t.Fatal(err)
	}
	inWorkspace, err := s.CreateConversation(ctx, owner, ws.ID, "workspace")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{account.ID, inWorkspace.ID} {
		if _, err := s.UpdateConversation(ctx, owner, id, ConversationUpdate{Archived: &archived}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.UnarchiveConversations(ctx, owner, ""); err != nil {
		t.Fatal(err)
	}
	live, err := s.ListConversations(ctx, owner, "", false)
	if err != nil || len(live) != 1 || live[0].ID != account.ID {
		t.Fatalf("account list after unarchive = %+v, %v", live, err)
	}
	stillArchived, err := s.ListConversations(ctx, owner, ws.ID, true)
	if err != nil || len(stillArchived) != 1 {
		t.Fatalf("workspace archive changed: %+v, %v", stillArchived, err)
	}
	if _, err := s.UpdateConversation(ctx, owner, account.ID, ConversationUpdate{Archived: &archived}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteArchivedConversations(ctx, owner, ""); err != nil {
		t.Fatal(err)
	}
	if left, _ := s.ListConversations(ctx, owner, "", true); len(left) != 0 {
		t.Fatalf("archived account conversations left: %+v", left)
	}
	if kept, _ := s.ListConversations(ctx, owner, ws.ID, true); len(kept) != 1 {
		t.Fatalf("workspace archive deleted: %+v", kept)
	}
}
