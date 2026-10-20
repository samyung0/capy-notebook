package store

import (
	"context"
	"testing"
)

func TestConversationPinArchiveAndBulk(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, WorkspaceCreate{Name: "Chats", Tags: nil})
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 3)
	for i := range ids {
		c, err := s.CreateConversation(ctx, userID, ws.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		ids[i] = c.ID
	}
	yes, no, title := true, false, "Renamed"
	listIDs := func(archived bool) []string {
		t.Helper()
		list, err := s.ListConversations(ctx, userID, ws.ID, archived)
		if err != nil {
			t.Fatal(err)
		}
		out := make([]string, len(list))
		for i, c := range list {
			out[i] = c.ID
		}
		return out
	}

	// The oldest thread, pinned and renamed, leads the list.
	c, err := s.UpdateConversation(ctx, userID, ids[0], ConversationUpdate{Pinned: &yes, Title: &title})
	if err != nil || c.PinnedAt == nil || c.Title != title {
		t.Fatalf("pin: %#v %v", c, err)
	}
	if got := listIDs(false); got[0] != ids[0] {
		t.Fatalf("pinned first: %v", got)
	}

	// Archiving moves it out of the list and drops the pin.
	c, err = s.UpdateConversation(ctx, userID, ids[0], ConversationUpdate{Archived: &yes})
	if err != nil || c.ArchivedAt == nil || c.PinnedAt != nil {
		t.Fatalf("archive: %#v %v", c, err)
	}
	if got := listIDs(false); len(got) != 2 {
		t.Fatalf("live list after archive: %v", got)
	}
	if got := listIDs(true); len(got) != 1 || got[0] != ids[0] {
		t.Fatalf("archived list: %v", got)
	}

	// Unarchive one, then archive two and bring them all back.
	if _, err := s.UpdateConversation(ctx, userID, ids[0], ConversationUpdate{Archived: &no}); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids[:2] {
		if _, err := s.UpdateConversation(ctx, userID, id, ConversationUpdate{Archived: &yes}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.UnarchiveConversations(ctx, userID, ws.ID); err != nil {
		t.Fatal(err)
	}
	if got := listIDs(false); len(got) != 3 {
		t.Fatalf("unarchive all: %v", got)
	}

	// Delete archived removes only archived threads.
	if _, err := s.UpdateConversation(ctx, userID, ids[2], ConversationUpdate{Archived: &yes}); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteArchivedConversations(ctx, userID, ws.ID); err != nil {
		t.Fatal(err)
	}
	if live, archived := listIDs(false), listIDs(true); len(live) != 2 || len(archived) != 0 {
		t.Fatalf("delete archived: live %v archived %v", live, archived)
	}
}
