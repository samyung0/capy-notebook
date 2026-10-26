package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// Security regression: a Clerk address still held by another live local
// account must not fail provisioning (every request answered 503 and the
// webhook retried forever). The account is stored without an email instead.
func TestClerkEmailCollisionStoresNoEmail(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	holder := newBlobTestUser(t, s, "u_email_holder")
	taken := strings.ToUpper(holder + "@example.test")

	newcomer := "u_email_newcomer_" + uid("n")
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, newcomer)
	})
	if _, err := s.UpsertUserFromClerk(ctx, newcomer, "Newcomer", taken, ""); err != nil {
		t.Fatalf("provisioning with a taken address: %v", err)
	}
	var email *string
	if err := s.pool.QueryRow(ctx, `SELECT email FROM users WHERE id=$1`, newcomer).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if email != nil {
		t.Fatalf("newcomer email=%q, want none", *email)
	}

	existing := newBlobTestUser(t, s, "u_email_refresh")
	if _, err := s.UpsertUserFromClerk(ctx, existing, "", taken, ""); err != nil {
		t.Fatalf("refresh with a taken address: %v", err)
	}
}

// Security regression: accepting someone else's invite answers like a missing
// one, by invite id and by token, so ids and tokens are not an existence
// oracle.
func TestAcceptingAnotherAccountsInviteAnswersNotFound(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, "u_owner", WorkspaceCreate{Name: "Invite oracle " + uid("n"), Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), "u_owner", ws.ID) })
	inviteID, token := workspaceInviteToken(t, s, ctx, ws.ID, "u_other", "u_other", RoleViewer)

	for _, reference := range []string{inviteID, token, "inv_0000000000"} {
		if _, err := s.AcceptWorkspaceInvite(ctx, reference, "u_viewer"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("accept %q by another account=%v, want not found", reference, err)
		}
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, inviteID, "u_other"); err != nil {
		t.Fatalf("invitee accept: %v", err)
	}
}

// Security regression: member role changes and removals refuse an empty actor
// instead of treating it as the owner.
func TestMemberMutationsRefuseAnEmptyActor(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_empty_actor_owner")
	member := newBlobTestUser(t, s, "u_empty_actor_member")
	ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Empty actor", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'viewer')`, ws.ID, member); err != nil {
		t.Fatal(err)
	}
	if err := s.SetWorkspaceMemberRole(ctx, "", ws.ID, member, RoleEditor); !errors.Is(err, ErrForbidden) {
		t.Fatalf("role change with no actor=%v, want forbidden", err)
	}
	if err := s.RemoveWorkspaceMember(ctx, "", ws.ID, member); !errors.Is(err, ErrForbidden) {
		t.Fatalf("removal with no actor=%v, want forbidden", err)
	}
	role, err := s.WorkspaceRole(ctx, member, ws.ID)
	if err != nil || role != RoleViewer {
		t.Fatalf("member role=%q, %v; want viewer", role, err)
	}
}

// Security regression: the raw invite token is never stored in
// email_outbox.payload; the dispatcher mints it when it sends.
func TestInviteEmailTokenIsMintedAtSend(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ws, err := s.CreateWorkspace(ctx, "u_owner", WorkspaceCreate{Name: "Invite mint " + uid("n"), Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.DeleteWorkspace(context.Background(), "u_owner", ws.ID) })
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "u_other", RoleViewer, "u_owner"); err != nil {
		t.Fatal(err)
	}
	inviteMail := func() (string, []byte, []byte) {
		t.Helper()
		var mailID string
		var payload, hash []byte
		if err := s.pool.QueryRow(ctx, `SELECT o.id, o.payload, wi.token_hash
			FROM workspace_invites wi
			JOIN email_outbox o ON o.template='workspace-invite'
				AND o.payload->>'inviteId'=wi.id AND o.status='pending'
			WHERE wi.workspace_id=$1 AND wi.invited_user_id='u_other'
			ORDER BY o.created_at DESC LIMIT 1`, ws.ID).Scan(&mailID, &payload, &hash); err != nil {
			t.Fatal(err)
		}
		return mailID, payload, hash
	}
	firstMail, payload, hash := inviteMail()
	var fields map[string]any
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	for key, value := range fields {
		text, _ := value.(string)
		digest := inviteTokenHash(strings.TrimPrefix(text, "/workspace-invites/"))
		if key == "invitePath" || bytes.Equal(digest[:], hash) {
			t.Fatalf("outbox payload holds the invite token in %q", key)
		}
	}

	// A re-sent invite (past the resend cooldown) replaces the token, so the
	// older email cannot mint.
	ageInvitesPastCooldown(t, s, ws.ID)
	if err := s.CreateWorkspaceInvite(ctx, ws.ID, "u_other", RoleEditor, "u_owner"); err != nil {
		t.Fatal(err)
	}
	stale := beginInviteSendForTest(t, s, firstMail)
	if _, ok, err := stale.MintInviteLink(ctx); err != nil || ok {
		t.Fatalf("stale invite email minted: ok=%v err=%v", ok, err)
	}
	if err := stale.Cancel(ctx); err != nil {
		t.Fatal(err)
	}

	latestMail, _, _ := inviteMail()
	guard := beginInviteSendForTest(t, s, latestMail)
	path, ok, err := guard.MintInviteLink(ctx)
	if err != nil || !ok {
		t.Fatalf("mint: ok=%v err=%v", ok, err)
	}
	if err := guard.MarkSent(ctx, "provider-id"); err != nil {
		t.Fatal(err)
	}
	member, err := s.AcceptWorkspaceInvite(ctx, strings.TrimPrefix(path, "/workspace-invites/"), "u_other")
	if err != nil || member.Role != RoleEditor {
		t.Fatalf("accept with the minted link: %#v, %v", member, err)
	}
}

// beginInviteSendForTest claims one outbox row the way ClaimEmails does,
// without claiming other tests' mail, and opens its send guard.
func beginInviteSendForTest(t *testing.T, s *Store, mailID string) *EmailSendGuard {
	t.Helper()
	ctx := context.Background()
	item := EmailOutbox{ID: mailID, LeaseToken: uid("lease")}
	if err := s.pool.QueryRow(ctx, `UPDATE email_outbox
		SET status='sending', attempts=attempts+1, lease_token=$2,
			lease_expires_at=now()+interval '2 minutes', updated_at=now()
		WHERE id=$1 AND status='pending'
		RETURNING template, payload`, mailID, item.LeaseToken).
		Scan(&item.Template, &item.Payload); err != nil {
		t.Fatal(err)
	}
	guard, active, err := s.BeginEmailSend(ctx, item)
	if err != nil || !active {
		t.Fatalf("begin send: active=%v err=%v", active, err)
	}
	t.Cleanup(guard.Rollback)
	return guard
}
