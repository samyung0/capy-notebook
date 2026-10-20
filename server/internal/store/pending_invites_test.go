package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/migrations"
)

// Security regression (human authorization, 2026-10-21): the owner's pending
// list shows every typed address exactly as typed until that invite is
// accepted, cancelled or expires, so it never tells whether an address has an
// account. Only rows that reach an eligible account notify and email; a second
// address of an account that accepted stays listed but inert, and so does a
// row whose account goes away (a retype that no longer reaches it, a purge),
// each losing its notification; a transfer cancels every pending invite.
func TestPendingInvitesListEveryTypedAddress(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_pending_owner")
	invitee := newBlobTestUser(t, s, "u_pending_invitee")
	member := newBlobTestUser(t, s, "u_pending_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Pending list", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'viewer')`, ws.ID, member); err != nil {
		t.Fatal(err)
	}
	byEmail := strings.ToUpper(invitee + "@example.test")
	typed := []string{"Nobody@Example.test", byEmail, invitee, member + "@example.test", owner + "@example.test"}
	for _, address := range typed {
		if err := s.CreateWorkspaceInvite(ctx, ws.ID, address, RoleViewer, owner); err != nil {
			t.Fatalf("invite %q: %v", address, err)
		}
	}
	// Typing an address again refreshes its row.
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "nobody@example.test", RoleEditor, owner); err != nil {
		t.Fatal(err)
	}
	typed[0] = "nobody@example.test"

	pending := func() map[string]string {
		t.Helper()
		list, err := s.ListWorkspaceInvites(ctx, ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, invite := range list {
			out[invite.Address] = invite.ID
		}
		return out
	}
	assertListed := func(want ...string) map[string]string {
		t.Helper()
		got := pending()
		addresses := make([]string, 0, len(got))
		for address := range got {
			addresses = append(addresses, address)
		}
		slices.Sort(addresses)
		want = slices.Sorted(slices.Values(want))
		if !slices.Equal(addresses, want) {
			t.Fatalf("pending list = %q, want %q", addresses, want)
		}
		return got
	}
	ids := assertListed(typed...)

	var notified, mailed int
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM notifications n JOIN workspace_invites wi ON wi.id=n.workspace_invite_id
			WHERE wi.workspace_id=$1),
		(SELECT count(*) FROM email_outbox WHERE template='workspace-invite'
			AND payload->>'inviteId' IN (SELECT id FROM workspace_invites WHERE workspace_id=$1))`, ws.ID).
		Scan(&notified, &mailed); err != nil {
		t.Fatal(err)
	}
	if notified != 2 || mailed != 2 {
		t.Fatalf("notifications=%d emails=%d, want 2 each (only the two rows that reach the invitee)", notified, mailed)
	}

	inviteNotices := func(user string) int {
		t.Helper()
		var n int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM notifications n
			JOIN workspace_invites wi ON wi.id=n.workspace_invite_id
			WHERE wi.workspace_id=$1 AND n.user_id=$2`, ws.ID, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// Accepting through one address leaves the other listed, inert, and takes
	// both invite notifications out of the bell.
	if _, err := s.AcceptWorkspaceInvite(ctx, ids[byEmail], invitee); err != nil {
		t.Fatal(err)
	}
	if n := inviteNotices(invitee); n != 0 {
		t.Fatalf("invitee keeps %d invite notifications after accepting", n)
	}

	// A retyped address whose account joined meanwhile stays listed, inert,
	// and its notification goes.
	leaver := newBlobTestUser(t, s, "u_pending_leaver")
	leaverAddress := leaver + "@example.test"
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, leaverAddress, RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	if n := inviteNotices(leaver); n != 1 {
		t.Fatalf("leaver invite notifications = %d, want 1", n)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'viewer')`, ws.ID, leaver); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, leaverAddress, RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	if n := inviteNotices(leaver); n != 0 {
		t.Fatalf("an inert retyped row keeps %d notifications", n)
	}

	// A purged invitee's row stays listed, inert, until its own expiry.
	gone := newBlobTestUser(t, s, "u_pending_gone")
	goneAddress := gone + "@example.test"
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, goneAddress, RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, gone, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, gone); err != nil {
		t.Fatal(err)
	}
	typed = append(typed, leaverAddress, goneAddress)
	assertListed(typed[0], invitee, typed[3], typed[4], leaverAddress, goneAddress)
	var goneLinked bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_invites
		WHERE workspace_id=$1 AND invited_user_id=$2)`, ws.ID, gone).Scan(&goneLinked); err != nil || goneLinked {
		t.Fatalf("purged invitee still linked: %v %v", goneLinked, err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, ids[invitee], invitee); !errors.Is(err, ErrNotFound) {
		t.Fatalf("accepting the account's second row: %v, want not found", err)
	}
	var mailID string
	if err := s.pool.QueryRow(ctx, `SELECT id FROM email_outbox WHERE template='workspace-invite'
		AND payload->>'inviteId'=$1 AND status='pending'`, ids[invitee]).Scan(&mailID); err != nil {
		t.Fatal(err)
	}
	guard := beginInviteSendForTest(t, s, mailID)
	if _, ok, err := guard.MintInviteLink(ctx); err != nil || ok {
		t.Fatalf("inert row's queued email minted: ok=%v err=%v", ok, err)
	}

	if err := s.CancelWorkspaceInvite(ctx, member, ws.ID, ids[typed[0]]); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a member cancelling: %v, want forbidden", err)
	}
	if err := s.CancelWorkspaceInvite(ctx, owner, ws.ID, ids[typed[0]]); err != nil {
		t.Fatal(err)
	}
	if err := s.CancelWorkspaceInvite(ctx, owner, ws.ID, ids[typed[0]]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cancelling twice: %v, want not found", err)
	}
	assertListed(invitee, typed[3], typed[4], leaverAddress, goneAddress)

	if _, err := s.TransferWorkspace(ctx, owner, ws.ID, member); err != nil {
		t.Fatal(err)
	}
	assertListed()
}

// 0100 clears the pending invites stored before it: they hold the resolved
// account email (empty for an account without one), not the typed address, and
// two such empty addresses would break the new unique index.
func TestInviteAddressMigrationClearsEarlierPendingInvites(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_migrate_owner")
	first := newBlobTestUser(t, s, "u_migrate_first")
	second := newBlobTestUser(t, s, "u_migrate_second")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Invite migration", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Rows as they were before 0100: two pending invites to accounts without
	// an email, and one accepted invite.
	if _, err := tx.Exec(ctx, `DROP INDEX workspace_invites_pending_address_idx`); err != nil {
		t.Fatal(err)
	}
	for i, row := range []struct {
		user     string
		accepted bool
	}{{first, false}, {second, false}, {second, true}} {
		hash := sha256.Sum256([]byte(ws.ID + uid("token")))
		if _, err := tx.Exec(ctx, `INSERT INTO workspace_invites
			(id, workspace_id, invited_user_id, email, role, token_hash, invited_by, expires_at, accepted_at)
			VALUES ($1,$2,$3,'','viewer',$4,$5,now()+interval '7 days',CASE WHEN $6 THEN now() END)`,
			uid("inv"), ws.ID, row.user, hash[:], owner, row.accepted); err != nil {
			t.Fatalf("row %d: %v", i, err)
		}
	}
	body, err := migrations.FS.ReadFile("0100_workspace_invite_addresses.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, string(body)); err != nil {
		t.Fatalf("0100 on earlier pending invites: %v", err)
	}
	var pending, accepted int
	if err := tx.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE accepted_at IS NULL), count(*) FILTER (WHERE accepted_at IS NOT NULL)
		FROM workspace_invites WHERE workspace_id=$1`, ws.ID).Scan(&pending, &accepted); err != nil {
		t.Fatal(err)
	}
	if pending != 0 || accepted != 1 {
		t.Fatalf("after 0100: %d pending, %d accepted; want 0 and 1", pending, accepted)
	}
}
