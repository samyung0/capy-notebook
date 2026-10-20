package store

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
)

// Security regression (human authorization, 2026-10-21): the owner's pending
// list shows every typed address exactly as typed until that invite is
// accepted, cancelled or expires, so it never tells whether an address has an
// account. Only rows that reach an eligible account notify and email; a second
// address of an account that accepted stays listed but inert; a transfer
// cancels every pending invite.
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
		slices.Sort(want)
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

	// Accepting through one address leaves the other listed, inert.
	if _, err := s.AcceptWorkspaceInvite(ctx, ids[byEmail], invitee); err != nil {
		t.Fatal(err)
	}
	assertListed(typed[0], invitee, typed[3], typed[4])
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
	assertListed(invitee, typed[3], typed[4])

	if _, err := s.TransferWorkspace(ctx, owner, ws.ID, member); err != nil {
		t.Fatal(err)
	}
	assertListed()
}
