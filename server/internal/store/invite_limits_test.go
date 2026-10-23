package store

import (
	"context"
	"errors"
	"testing"
)

// ageInvitesPastCooldown moves a workspace's pending invites past the resend
// cooldown, for tests that send again at once.
func ageInvitesPastCooldown(t *testing.T, s *Store, wsID string) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `UPDATE workspace_invites
		SET created_at=created_at - interval '11 minutes' WHERE workspace_id=$1`, wsID); err != nil {
		t.Fatal(err)
	}
}

// TestInviteResendWaitsAndOwnersHaveADailyCap (security regression:
// rate-limit audit M8). A resend to the same address of a workspace within 10
// minutes is refused with no new token or email, account or not; past the
// owner's daily count every invite is refused.
func TestInviteResendWaitsAndOwnersHaveADailyCap(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_invite_cap_owner")
	invitee := newBlobTestUser(t, s, "u_invite_cap_invitee")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Invite caps", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	outbox := func() (count int) {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM email_outbox
			WHERE user_id=$1 AND template='workspace-invite'`, invitee).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	for _, address := range []string{invitee, "nobody-cap@example.test"} {
		if err := s.CreateWorkspaceInvite(ctx, ws.ID, address, RoleViewer, owner); err != nil {
			t.Fatalf("invite %q: %v", address, err)
		}
		if err := s.CreateWorkspaceInvite(ctx, ws.ID, address, RoleEditor, owner); !errors.Is(err, ErrInviteRecentlySent) {
			t.Fatalf("resend to %q at once: %v, want ErrInviteRecentlySent", address, err)
		}
	}
	if got := outbox(); got != 1 {
		t.Fatalf("invite emails = %d, want 1", got)
	}
	ageInvitesPastCooldown(t, s, ws.ID)
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, invitee, RoleEditor, owner); err != nil {
		t.Fatalf("resend past the cooldown: %v", err)
	}
	if got := outbox(); got != 2 {
		t.Fatalf("invite emails after the resend = %d, want 2", got)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE invite_usage SET invites=$2
		WHERE user_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date`, owner, InvitesPerOwnerPerDay); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "another-cap@example.test", RoleViewer, owner); !errors.Is(err, ErrInviteLimit) {
		t.Fatalf("invite past the daily cap: %v, want ErrInviteLimit", err)
	}
	var rows int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_invites
		WHERE workspace_id=$1 AND lower(email)='another-cap@example.test'`, ws.ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("refused invite left %d rows (%v)", rows, err)
	}
}
