package store

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func newTransferTestUser(t *testing.T, s *Store, label string) string {
	t.Helper()
	ctx := context.Background()
	id := uid(label)
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1, 'Transfer Test', $2)`, id, fmt.Sprintf("%s@example.test", id)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id)
	})
	return id
}

// A transfer hands the workspace and the owner role over but moves no
// charges: each item stays on the account that uploaded or created it
// (uploader pays, Sam 2026-10-18).
func TestTransferMovesOwnershipButNoCharges(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	senderID := newTransferTestUser(t, s, "u_sender")
	recipientID := newTransferTestUser(t, s, "u_recipient")

	ws, err := s.CreateWorkspace(ctx, senderID, WorkspaceCreate{Name: "Handover", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.createReadyFile(ctx, ws.ID, senderID, "notes.pdf", "pdf",
		nil, "", 4096, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: senderID,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "pending.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 512, ParseMode: "none",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor')`, ws.ID, recipientID); err != nil {
		t.Fatal(err)
	}
	senderBefore, err := s.StorageUsage(ctx, senderID)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.TransferWorkspace(ctx, senderID, ws.ID, recipientID); err != nil {
		t.Fatal(err)
	}

	senderAfter, err := s.StorageUsage(ctx, senderID)
	if err != nil {
		t.Fatal(err)
	}
	if senderAfter.UsedBytes != senderBefore.UsedBytes || senderAfter.ReservedBytes != 512 {
		t.Errorf("sender after transfer: used=%d reserved=%d, want %d and 512",
			senderAfter.UsedBytes, senderAfter.ReservedBytes, senderBefore.UsedBytes)
	}
	recipientAfter, err := s.StorageUsage(ctx, recipientID)
	if err != nil {
		t.Fatal(err)
	}
	if recipientAfter.UsedBytes != 0 || recipientAfter.ReservedBytes != 0 {
		t.Errorf("recipient after transfer: used=%d reserved=%d, want nothing",
			recipientAfter.UsedBytes, recipientAfter.ReservedBytes)
	}
	roles := map[string]string{}
	rows, err := s.pool.Query(ctx, `SELECT user_id, role FROM workspace_members
		WHERE workspace_id=$1`, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var userID, role string
		if err := rows.Scan(&userID, &role); err != nil {
			t.Fatal(err)
		}
		roles[userID] = role
	}
	if roles[recipientID] != "owner" || roles[senderID] != "editor" {
		t.Errorf("roles after transfer = %v, want recipient owner and sender editor", roles)
	}
}
