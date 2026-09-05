package store

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
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

// TestTransferMovesOwnershipAndTheStorageBill pins the reason transfer has to be
// one transaction: the storage owner is denormalized onto four tables and mirrored
// in two counter rows, and a partial rewrite would leave a user paying for a
// workspace they can no longer see.
func TestTransferMovesOwnershipAndTheStorageBill(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	senderID := newTransferTestUser(t, s, "u_sender")
	recipientID := newTransferTestUser(t, s, "u_recipient")

	ws, err := s.CreateWorkspace(ctx, senderID, "Handover", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSourceReady(ctx, ws.ID, senderID, "notes.pdf", "pdf",
		nil, "", 4096, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{
		ID: uid("c"), Front: "front", Back: "back",
	}})
	if err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: senderID, WorkspaceID: ws.ID, Kind: "flashcards",
		Title: "FlashcardSet", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	// A live reservation has to move too, or the sender keeps paying for an
	// upload that will land in somebody else's workspace.
	if _, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: ws.ID, CreatedBy: senderID,
		ObjectPath: "incoming/" + uid("blob"), FinalPath: "sources/" + uid("blob"),
		Name: "pending.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 512, ParseMode: "none",
		ExpiresAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	senderBefore, err := s.StorageUsage(ctx, senderID)
	if err != nil {
		t.Fatal(err)
	}
	if senderBefore.UsedBytes <= 0 || senderBefore.ReservedBytes != 512 {
		t.Fatalf("sender before transfer: used=%d reserved=%d, want both charged",
			senderBefore.UsedBytes, senderBefore.ReservedBytes)
	}

	// A non-member cannot receive it, however willing the owner is.
	if _, err := s.TransferWorkspace(ctx, senderID, ws.ID, recipientID); err == nil {
		t.Fatal("transfer to a non-member succeeded")
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor')`, ws.ID, recipientID); err != nil {
		t.Fatal(err)
	}

	moved, err := s.TransferWorkspace(ctx, senderID, ws.ID, recipientID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.ID != ws.ID {
		t.Fatalf("transferred workspace id = %q, want %q", moved.ID, ws.ID)
	}

	senderAfter, err := s.StorageUsage(ctx, senderID)
	if err != nil {
		t.Fatal(err)
	}
	if senderAfter.UsedBytes != 0 || senderAfter.ReservedBytes != 0 {
		t.Errorf("sender after transfer: used=%d reserved=%d, want 0 and 0",
			senderAfter.UsedBytes, senderAfter.ReservedBytes)
	}
	recipientAfter, err := s.StorageUsage(ctx, recipientID)
	if err != nil {
		t.Fatal(err)
	}
	if recipientAfter.UsedBytes != senderBefore.UsedBytes {
		t.Errorf("recipient used = %d, want the sender's %d",
			recipientAfter.UsedBytes, senderBefore.UsedBytes)
	}
	if recipientAfter.ReservedBytes != 512 {
		t.Errorf("recipient reserved = %d, want the moved reservation 512",
			recipientAfter.ReservedBytes)
	}

	// Every owner column, not just the workspace row.
	for _, tc := range []struct{ what, query string }{
		{"workspace", `SELECT count(*) FROM workspaces WHERE id=$1 AND user_id=$2`},
		{"files", `SELECT count(*) FROM files WHERE workspace_id=$1 AND user_id=$2`},
		{"materials", `SELECT count(*) FROM materials WHERE workspace_id=$1 AND owner_user_id=$2`},
		{"upload sessions", `SELECT count(*) FROM upload_sessions WHERE workspace_id=$1 AND user_id=$2`},
	} {
		var count int
		if err := s.pool.QueryRow(ctx, tc.query, ws.ID, recipientID).Scan(&count); err != nil {
			t.Fatalf("%s: %v", tc.what, err)
		}
		if count == 0 {
			t.Errorf("%s still point at the old owner", tc.what)
		}
	}

	// Authorship is untouched: the sender wrote the material and still did.
	var author *string
	if err := s.pool.QueryRow(ctx, `SELECT created_by FROM materials WHERE id=$1`,
		material.ID).Scan(&author); err != nil {
		t.Fatal(err)
	}
	if author == nil || *author != senderID {
		t.Error("transfer rewrote authorship, which belongs to a different axis")
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
	if roles[recipientID] != "owner" {
		t.Errorf("recipient role = %q, want owner", roles[recipientID])
	}
	if roles[senderID] != "editor" {
		t.Errorf("outgoing owner role = %q, want editor", roles[senderID])
	}
}

// TestTransferRefusedWhenRecipientCannotAffordIt pins the quota gate. Without it
// a free-tier user could be handed a workspace far over their limit and end up
// permanently frozen through no action of their own.
func TestTransferRefusedWhenRecipientCannotAffordIt(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	senderID := newTransferTestUser(t, s, "u_bigsender")
	recipientID := newTransferTestUser(t, s, "u_smallrecipient")

	ws, err := s.CreateWorkspace(ctx, senderID, "Too big", ColorBlue, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor')`, ws.ID, recipientID); err != nil {
		t.Fatal(err)
	}
	// Written directly: the sender's own gate would refuse a file this size.
	if _, err := s.pool.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, name, kind, size_bytes)
		VALUES ($1,$2,$3,'huge.pdf','pdf',$4)`,
		uid("f"), ws.ID, senderID, mustPlanLimits(t, s, PlanFree).StorageBytes+1); err != nil {
		t.Fatal(err)
	}

	if _, err := s.TransferWorkspace(ctx, senderID, ws.ID, recipientID); err == nil {
		t.Fatal("transfer succeeded despite exceeding the recipient's quota")
	}
	var owner string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE id=$1`,
		ws.ID).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != senderID {
		t.Error("a refused transfer still moved the workspace")
	}
}

// TestOwnerColumnsAreCoveredByTransfer fails when a new denormalized storage
// owner column appears without being added to the transfer path.
//
// This is the guard the denormalization needs. Those columns are only correct
// because exactly one code path rewrites them; a fifth one added elsewhere would
// leave the previous owner charged for bytes they cannot see, and nothing else
// would notice — the counters stay internally consistent, just attributed to the
// wrong user.
func TestOwnerColumnsAreCoveredByTransfer(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	// Tables that are workspace-scoped and also name a user are the risk: that
	// user is either the storage owner (must move with the workspace) or
	// something else entirely. Enumerating them from the catalog forces a new
	// table to be classified here rather than silently doing neither.
	//
	// Authorship columns are excluded by name: created_by never changes hands,
	// because who wrote something is not affected by who owns it.
	rows, err := s.pool.Query(ctx, `SELECT c.table_name, c.column_name
		FROM information_schema.columns c
		JOIN information_schema.tables t
			ON t.table_schema = c.table_schema AND t.table_name = c.table_name
		WHERE c.table_schema = 'public'
			AND t.table_type = 'BASE TABLE'
			AND c.column_name IN ('user_id', 'owner_user_id')
			AND EXISTS (
				SELECT 1 FROM information_schema.columns w
				WHERE w.table_schema = c.table_schema
					AND w.table_name = c.table_name
					AND w.column_name = 'workspace_id'
			)
		ORDER BY c.table_name, c.column_name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatal(err)
		}
		found = append(found, table+"."+column)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	// Workspace-scoped user columns that are deliberately not storage owners.
	notOwnership := map[string]string{
		"workspace_members.user_id": "membership, rewritten as a role swap instead",
		"notifications.user_id":     "recipient of a message about the workspace",
		"workspace_invites.user_id": "the invited party, resolved before acceptance",
		"card_stats.user_id":        "per-user study progress, not billable bytes",
		"conversations.user_id":     "who held the chat; history stays with them",
	}
	covered := map[string]bool{}
	for _, col := range ownerColumns {
		covered[col.table+"."+col.column] = true
	}
	sort.Strings(found)
	for _, name := range found {
		if covered[name] || notOwnership[name] != "" {
			continue
		}
		t.Errorf("%s is a workspace-scoped user column that transfer neither "+
			"rewrites nor explicitly excludes; classify it as ownership "+
			"(add to ownerColumns) or not (add to notOwnership with a reason)", name)
	}
	for name := range covered {
		if !contains(found, name) {
			t.Errorf("transfer rewrites %s, which no longer exists in the schema", name)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
