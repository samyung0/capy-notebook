package store

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestFailedWebhookRemainsRetryableUntilSuccessful(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	eventID := uid("wh_retry")
	payload := json.RawMessage(`{"data":{"id":"retry-user"}}`)
	claim, processed, err := s.ClaimWebhookEvent(
		ctx, eventID, "clerk", "user.updated", "", payload,
	)
	if err != nil {
		t.Fatal(err)
	}
	if processed {
		t.Fatal("new webhook was already processed")
	}
	if err := s.MarkWebhookProcessed(ctx, "clerk", eventID, claim, errors.New("temporary failure")); err != nil {
		t.Fatal(err)
	}
	claim, processed, err = s.ClaimWebhookEvent(
		ctx, eventID, "clerk", "user.updated", "", payload,
	)
	if err != nil {
		t.Fatal(err)
	}
	if processed {
		t.Fatal("failed webhook was treated as complete")
	}
	if err := s.MarkWebhookProcessed(ctx, "clerk", eventID, claim, nil); err != nil {
		t.Fatal(err)
	}
	_, processed, err = s.ClaimWebhookEvent(
		ctx, eventID, "clerk", "user.updated", "", payload,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("successful retry was not marked complete")
	}
}

func TestWebhookIdentityIsScopedBySourceAfterProcessing(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	eventID := uid("shared_provider_event")

	clerkClaim, processed, err := s.ClaimWebhookEvent(
		ctx, eventID, "clerk", "user.updated", "", json.RawMessage(`{"provider":"clerk"}`),
	)
	if err != nil || processed {
		t.Fatalf("claim clerk processed=%v err=%v", processed, err)
	}
	if err := s.MarkWebhookProcessed(ctx, "clerk", eventID, clerkClaim, nil); err != nil {
		t.Fatal(err)
	}
	stripeClaim, processed, err := s.ClaimWebhookEvent(
		ctx, eventID, "stripe", "customer.subscription.updated", "",
		json.RawMessage(`{"provider":"stripe"}`),
	)
	if err != nil || processed {
		t.Fatalf("claim stripe processed=%v err=%v", processed, err)
	}
	if err := s.MarkWebhookProcessed(ctx, "stripe", eventID, stripeClaim, nil); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM webhook_events WHERE id=$1`, eventID).
		Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("cross-source event rows=%d, want 2", count)
	}
}

func TestWebhookIdentityIsScopedBySourceWhileInProgress(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	eventID := uid("shared_in_progress_event")

	if _, processed, err := s.ClaimWebhookEvent(
		ctx, eventID, "clerk", "user.updated", "", json.RawMessage(`{"provider":"clerk"}`),
	); err != nil || processed {
		t.Fatalf("claim clerk processed=%v err=%v", processed, err)
	}
	if _, processed, err := s.ClaimWebhookEvent(
		ctx, eventID, "stripe", "customer.subscription.updated", "",
		json.RawMessage(`{"provider":"stripe"}`),
	); err != nil || processed {
		t.Fatalf("claim stripe processed=%v err=%v", processed, err)
	}
}

func TestWebhookClaimAllowsUnknownIdentityThenAssociatesAfterProvision(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	eventID := uid("unknown_identity_event")
	userID := uid("unknown_identity")
	claim, processed, err := s.ClaimWebhookEvent(
		ctx,
		eventID,
		"clerk",
		"user.created",
		userID,
		json.RawMessage(`{"email":"new@example.test"}`),
	)
	if err != nil || processed {
		t.Fatalf("claim unknown identity processed=%v err=%v", processed, err)
	}
	var claimedUserID *string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM webhook_events WHERE id=$1`, eventID).
		Scan(&claimedUserID); err != nil {
		t.Fatal(err)
	}
	if claimedUserID != nil {
		t.Fatalf("unknown identity claim user_id=%q, want null", *claimedUserID)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id,name,email)
		VALUES ($1,'Webhook User',$2)`, userID, userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	if err := s.AssociateWebhookEvent(ctx, "clerk", eventID, claim, userID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkWebhookProcessed(ctx, "clerk", eventID, claim, nil); err != nil {
		t.Fatal(err)
	}
	var associatedUserID string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM webhook_events WHERE id=$1`, eventID).
		Scan(&associatedUserID); err != nil {
		t.Fatal(err)
	}
	if associatedUserID != userID {
		t.Fatalf("associated user=%q, want %q", associatedUserID, userID)
	}
}

func TestTerminalOrphanWebhookPayloadIsRedacted(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	eventID := uid("orphan_stripe_event")
	claim, processed, err := s.ClaimWebhookEvent(
		ctx,
		eventID,
		"stripe",
		"invoice.payment_failed",
		"",
		json.RawMessage(`{"customer_email":"private@example.test"}`),
	)
	if err != nil || processed {
		t.Fatalf("claim orphan processed=%v err=%v", processed, err)
	}
	if err := s.RedactWebhookEvent(ctx, "stripe", eventID, claim); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkWebhookProcessed(ctx, "stripe", eventID, claim, nil); err != nil {
		t.Fatal(err)
	}
	var payload string
	if err := s.pool.QueryRow(ctx, `SELECT payload::text FROM webhook_events WHERE id=$1`, eventID).
		Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload != "{}" {
		t.Fatalf("terminal orphan payload=%s, want {}", payload)
	}
}

func TestPurgedIdentityDeletionIsRetriedUntilConfirmed(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_identity_retry")
	memberID := newBlobTestUser(t, s, "u_identity_retry_member")
	workspace, err := s.CreateWorkspace(
		ctx, userID, "Purge-owned workspace", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id,user_id,role) VALUES ($1,$2,'editor')`, workspace.ID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, userID); err != nil {
		t.Fatal(err)
	}
	var workspaceExists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM workspaces WHERE id=$1)`, workspace.ID).Scan(&workspaceExists); err != nil {
		t.Fatal(err)
	}
	if workspaceExists {
		t.Fatal("purge left the account's owned workspace behind")
	}
	claimed, err := s.ClaimUsersDueForPurge(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(claimed, userID) {
		t.Fatal("purged tombstone was not claimed for external identity deletion")
	}
	if err := s.RetryIdentityDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	claimed, err = s.ClaimUsersDueForPurge(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(claimed, userID) {
		t.Fatal("identity retry ignored its backoff")
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET identity_delete_not_before=now()-interval '1 second'
		WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	claimed, err = s.ClaimUsersDueForPurge(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(claimed, userID) {
		t.Fatal("identity deletion was not reclaimed after backoff")
	}
	if err := s.MarkIdentityDeletionComplete(ctx, userID); err != nil {
		t.Fatal(err)
	}
	claimed, err = s.ClaimUsersDueForPurge(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(claimed, userID) {
		t.Fatal("confirmed identity deletion stayed in the retry queue")
	}
}

func TestDeletionCannotBeCanceledAfterIdentityIsGone(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_identity_gone")
	if _, err := s.RequestAccountDeletion(ctx, userID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkIdentityDeletionComplete(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cancel error = %v, want forbidden", err)
	}
}

func TestDeletionCannotBeCanceledAfterGraceExpires(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_grace_expired")
	if _, err := s.RequestAccountDeletion(ctx, userID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET purge_after=now()-interval '1 second'
		WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cancel error = %v, want forbidden", err)
	}
}

func TestClerkProfileSyncDoesNotRefreshLockedAccountPII(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for _, state := range []string{"suspended", "deletion_pending"} {
		t.Run(state, func(t *testing.T) {
			userID := newBlobTestUser(t, s, "u_profile_"+state)
			if state == "suspended" {
				if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
					suspended_reason='test suspension'
					WHERE id=$1`, userID); err != nil {
					t.Fatal(err)
				}
			} else if _, err := s.pool.Exec(ctx, `UPDATE users
				SET deletion_requested_at=now(), purge_after=now()+interval '30 days'
				WHERE id=$1`, userID); err != nil {
				t.Fatal(err)
			}
			created, err := s.UpsertUserFromClerk(
				ctx, userID, "Replacement Name", "replacement@example.test", "https://example.test/avatar",
			)
			if err != nil || created {
				t.Fatalf("profile sync = created %v, error %v", created, err)
			}
			var name, email string
			if err := s.pool.QueryRow(ctx, `SELECT name, email FROM users WHERE id=$1`, userID).
				Scan(&name, &email); err != nil {
				t.Fatal(err)
			}
			if name == "Replacement Name" || email == "replacement@example.test" {
				t.Fatalf("locked profile refreshed PII: name=%q email=%q", name, email)
			}
		})
	}
}

func TestClerkProfileSyncPreservesEmailWhenPayloadOmitsIt(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_profile_email_omitted")
	const storedEmail = "stored@example.test"
	if _, err := s.pool.Exec(ctx, `UPDATE users SET email=$2 WHERE id=$1`, userID, storedEmail); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertUserFromClerk(ctx, userID, "Refreshed Name", "", ""); err != nil {
		t.Fatal(err)
	}
	var email string
	if err := s.pool.QueryRow(ctx, `SELECT email FROM users WHERE id=$1`, userID).Scan(&email); err != nil {
		t.Fatal(err)
	}
	if email != storedEmail {
		t.Fatalf("email after omitted refresh = %q, want %q", email, storedEmail)
	}
}

func TestUserProvisionedDistinguishesUnknownClerkIdentity(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	knownID := newBlobTestUser(t, s, "u_provisioned")

	known, err := s.UserProvisioned(ctx, knownID)
	if err != nil || !known {
		t.Fatalf("known user provisioned=%v, err=%v", known, err)
	}
	unknown, err := s.UserProvisioned(ctx, "u_unknown_"+uid("provision"))
	if err != nil || unknown {
		t.Fatalf("unknown user provisioned=%v, err=%v", unknown, err)
	}
}

func TestStarterWorkspaceProvisioningIsDurableAndOneTime(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_starter_workspace")

	needsWorkspace, err := s.UpsertUserFromClerk(
		ctx, userID, "Starter User", userID+"@example.test", "",
	)
	if err != nil || !needsWorkspace {
		t.Fatalf("initial profile sync pending=%v err=%v", needsWorkspace, err)
	}
	if err := s.CreateDefaultWorkspace(ctx, userID); err != nil {
		t.Fatal(err)
	}
	needsWorkspace, err = s.UpsertUserFromClerk(
		ctx, userID, "Starter User", userID+"@example.test", "",
	)
	if err != nil || needsWorkspace {
		t.Fatalf("provisioned profile sync pending=%v err=%v", needsWorkspace, err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM workspaces WHERE user_id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateDefaultWorkspace(ctx, userID); err != nil {
		t.Fatal(err)
	}
	var workspaces int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE user_id=$1`, userID).
		Scan(&workspaces); err != nil {
		t.Fatal(err)
	}
	if workspaces != 0 {
		t.Fatalf("deleted starter workspace was recreated: count=%d", workspaces)
	}
}

func TestStarterWorkspaceDoesNotRaceOrdinaryCreation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	userID := newBlobTestUser(t, s, "u_starter_workspace_race")

	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID); err != nil {
		t.Fatal(err)
	}

	ordinaryResult := make(chan error, 1)
	go func() {
		_, createErr := s.CreateWorkspace(ctx, userID, "User workspace", ColorBlue, nil)
		ordinaryResult <- createErr
	}()
	waitForAccountLockWaiters(t, s, ctx, 1)

	starterResult := make(chan error, 1)
	go func() {
		starterResult <- s.CreateDefaultWorkspace(ctx, userID)
	}()
	waitForAccountLockWaiters(t, s, ctx, 2)

	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-ordinaryResult; err != nil {
		t.Fatalf("ordinary workspace creation: %v", err)
	}
	if err := <-starterResult; err != nil {
		t.Fatalf("starter workspace creation: %v", err)
	}
	var workspaceCount int
	var provisioned bool
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM workspaces WHERE user_id=$1),
		starter_workspace_provisioned_at IS NOT NULL
		FROM users WHERE id=$1`, userID).Scan(&workspaceCount, &provisioned); err != nil {
		t.Fatal(err)
	}
	if workspaceCount != 1 || !provisioned {
		t.Fatalf("workspace count=%d provisioned=%v, want 1/true", workspaceCount, provisioned)
	}
}

func waitForAccountLockWaiters(
	t *testing.T,
	s *Store,
	ctx context.Context,
	want int,
) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var waiting int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE wait_event_type='Lock'
			  AND query LIKE '%deleted_at, deletion_requested_at%FOR%UPDATE%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("account lock waiters=%d, want at least %d", waiting, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWorkspaceCollaboratorDoesNotBlockOwnerDeletion(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_delete_block_owner")
	memberID := newBlobTestUser(t, s, "u_delete_block_member")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Pending member workspace", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, workspace.ID, memberID); err != nil {
		t.Fatal(err)
	}
	blocked, err := s.WorkspacesBlockingDeletion(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blocked) != 0 {
		t.Fatalf("collaborator blocked owner deletion: %#v", blocked)
	}
	destroyed, err := s.WorkspacesDestroyedByDeletion(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if len(destroyed) != 1 || destroyed[0].ID != workspace.ID {
		t.Fatalf("workspace was not classified as destroyed: %#v", destroyed)
	}
	status, err := s.RequestAccountDeletion(ctx, ownerID, false)
	if err != nil || status.State != AccountDeletionPending {
		t.Fatalf("owner deletion with collaborator = %#v, %v", status, err)
	}
}

func TestCancelDeletionRestoresOwnedWorkspaceAccessAndSharing(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_restore_owner")
	memberID := newBlobTestUser(t, s, "u_restore_member")
	inviteeID := newBlobTestUser(t, s, "u_restore_invitee")
	clonerID := newBlobTestUser(t, s, "u_restore_cloner")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Restorable workspace", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`,
		workspace.ID); err != nil {
		t.Fatal(err)
	}
	linkWorkspace, err := s.CreateWorkspace(
		ctx, ownerID, "Restorable link workspace", ColorBlue, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='link' WHERE id=$1`,
		linkWorkspace.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id,user_id,role) VALUES ($1,$2,'editor')`, workspace.ID, memberID); err != nil {
		t.Fatal(err)
	}
	inviteID := uid("inv")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_invites
		(id,workspace_id,invited_user_id,email,role,token_hash,invited_by,expires_at)
		VALUES ($1,$2,$3,$4,'viewer',decode(repeat('03',32),'hex'),$5,now()+interval '1 day')`,
		inviteID, workspace.ID, inviteeID, inviteeID+"@example.test", ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, ownerID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.WorkspaceAccess(ctx, memberID, workspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending deletion member access error=%v, want not found", err)
	}
	if _, err := s.CloneWorkspace(ctx, clonerID, workspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending deletion clone error=%v, want not found", err)
	}
	if _, err := s.WorkspaceAccess(ctx, clonerID, linkWorkspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending deletion link access error=%v, want not found", err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, inviteID, inviteeID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pending deletion invite error=%v, want not found", err)
	}

	status, err := s.CancelAccountDeletion(ctx, ownerID)
	if err != nil || status.State != AccountActive {
		t.Fatalf("cancel deletion = %#v, %v", status, err)
	}
	if _, err := s.WorkspaceAccess(ctx, memberID, workspace.ID); err != nil {
		t.Fatalf("member access was not restored: %v", err)
	}
	listed, err := s.ListWorkspaces(ctx, memberID, "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(listed, func(item Workspace) bool { return item.ID == workspace.ID }) {
		t.Fatalf("restored workspace missing from member listing: %#v", listed)
	}
	public, err := s.ListPublicWorkspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(public, func(item PublicWorkspace) bool { return item.ID == workspace.ID }) {
		t.Fatalf("restored workspace missing from Explore: %#v", public)
	}
	name := "Restored and editable"
	if _, err := s.UpdateWorkspace(ctx, ownerID, workspace.ID, WorkspacePatch{Name: &name}); err != nil {
		t.Fatalf("owner edit was not restored: %v", err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, inviteID, inviteeID); err != nil {
		t.Fatalf("invite acceptance was not restored: %v", err)
	}
	if _, err := s.CloneWorkspace(ctx, clonerID, workspace.ID); err != nil {
		t.Fatalf("public clone was not restored: %v", err)
	}
	if _, err := s.WorkspaceAccess(ctx, clonerID, linkWorkspace.ID); err != nil {
		t.Fatalf("link access was not restored: %v", err)
	}
	if _, err := s.CloneWorkspace(ctx, clonerID, linkWorkspace.ID); err != nil {
		t.Fatalf("link clone was not restored: %v", err)
	}
}

func TestCancellationInvalidatesOnlyOlderDeletionPreflights(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_delete_generation")

	firstGeneration, err := s.AccountLifecycleGeneration(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletionAtGeneration(
		ctx, userID, false, firstGeneration,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletionAtGeneration(
		ctx, userID, false, firstGeneration,
	); !errors.Is(err, ErrAccountLifecycleChanged) {
		t.Fatalf("stale deletion preflight error=%v, want lifecycle change", err)
	}
	status, err := s.AccountAccess(ctx, userID)
	if err != nil || status.State != AccountActive {
		t.Fatalf("stale request changed restored account: %#v, %v", status, err)
	}

	currentGeneration, err := s.AccountLifecycleGeneration(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if currentGeneration != firstGeneration+1 {
		t.Fatalf("generation=%d, want %d", currentGeneration, firstGeneration+1)
	}
	status, err = s.RequestAccountDeletionAtGeneration(
		ctx, userID, false, currentGeneration,
	)
	if err != nil || status.State != AccountDeletionPending {
		t.Fatalf("fresh deletion request = %#v, %v", status, err)
	}
}

func TestSessionRevocationRetryBlocksRestoreUntilComplete(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_delete_session_revoke")
	generation, err := s.AccountLifecycleGeneration(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletionAtGenerationWithSessionRevocation(
		ctx, userID, false, generation,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); !errors.Is(err, ErrConflict) {
		t.Fatalf("restore with pending session revocation error=%v, want conflict", err)
	}

	claimed, err := s.ClaimUsersDueForSessionRevocation(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(claimed, userID) {
		t.Fatalf("session revocation claim=%v, want %s", claimed, userID)
	}
	claimed, err = s.ClaimUsersDueForSessionRevocation(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(claimed, userID) {
		t.Fatal("leased session revocation was claimed twice")
	}

	revokeErr := errors.New("Clerk unavailable")
	if err := s.RetrySessionRevocation(ctx, userID, revokeErr); err != nil {
		t.Fatal(err)
	}
	var pending bool
	var attempts int
	var dueAt *time.Time
	var lastError string
	if err := s.pool.QueryRow(ctx, `SELECT session_revoke_pending,
		session_revoke_attempts, session_revoke_not_before,
		session_revoke_last_error FROM users WHERE id=$1`, userID).
		Scan(&pending, &attempts, &dueAt, &lastError); err != nil {
		t.Fatal(err)
	}
	if !pending || attempts != 1 || dueAt == nil || lastError != revokeErr.Error() {
		t.Fatalf("retry state pending=%v attempts=%d due=%v error=%q",
			pending, attempts, dueAt, lastError)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET
		session_revoke_not_before=now()-interval '1 second' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	claimed, err = s.ClaimUsersDueForSessionRevocation(ctx, 10)
	if err != nil || !slices.Contains(claimed, userID) {
		t.Fatalf("retried claim=%v, %v", claimed, err)
	}
	if err := s.MarkSessionRevocationComplete(ctx, userID); err != nil {
		t.Fatal(err)
	}
	status, err := s.CancelAccountDeletion(ctx, userID)
	if err != nil || status.State != AccountActive {
		t.Fatalf("restore after complete revocation=%#v, %v", status, err)
	}
}

func TestDeletionLifecycleEmailsAreIdempotentPerGeneration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_delete_notice_generation")

	for cycle := range 2 {
		if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
			t.Fatal(err)
		}
		if err := s.NotifyAccountDeletionRequested(ctx, userID); err != nil {
			t.Fatal(err)
		}
		if err := s.NotifyAccountDeletionRequested(ctx, userID); err != nil {
			t.Fatal(err)
		}
		if err := s.NotifyAccountDeletionCancelled(ctx, userID); err != nil {
			t.Fatal(err)
		}
		if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
			t.Fatal(err)
		}
		if err := s.NotifyAccountDeletionCancelled(ctx, userID); err != nil {
			t.Fatal(err)
		}
		if err := s.NotifyAccountDeletionRequested(ctx, userID); err != nil {
			t.Fatal(err)
		}
		if err := s.NotifyAccountDeletionCancelled(ctx, userID); err != nil {
			t.Fatal(err)
		}

		var requested, cancelled int
		if err := s.pool.QueryRow(ctx, `SELECT
			count(*) FILTER (WHERE template='account-deletion-requested'),
			count(*) FILTER (WHERE template='account-deletion-cancelled')
			FROM email_outbox WHERE user_id=$1`, userID).Scan(&requested, &cancelled); err != nil {
			t.Fatal(err)
		}
		want := cycle + 1
		if requested != want || cancelled != want {
			t.Fatalf("cycle %d lifecycle emails requested=%d cancelled=%d, want %d each",
				cycle, requested, cancelled, want)
		}
	}

	rows, err := s.pool.Query(ctx, `SELECT idempotency_key FROM email_outbox
		WHERE user_id=$1 AND template LIKE 'account-deletion-%'
		ORDER BY idempotency_key`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	wantKeys := []string{
		"account-deletion-cancelled:" + userID + ":1",
		"account-deletion-cancelled:" + userID + ":2",
		"account-deletion-requested:" + userID + ":0",
		"account-deletion-requested:" + userID + ":1",
	}
	if !slices.Equal(keys, wantKeys) {
		t.Fatalf("lifecycle email keys=%v, want %v", keys, wantKeys)
	}
}

func TestDeletionPendingHidesContentAndCancelsAsyncWork(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_delete_owner")
	viewerID := newBlobTestUser(t, s, "u_delete_viewer")
	workspace, err := s.CreateWorkspace(
		ctx, ownerID, "Deleting workspace", ColorGreen, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`,
		workspace.ID); err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(
		ctx, workspace.ID, ownerID, "deleting.pdf", "pdf", nil, "", 100,
		"sources/deleting",
	)
	if err != nil {
		t.Fatal(err)
	}

	inviteID := uid("inv")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_invites
		(id, workspace_id, invited_user_id, email, role, token_hash, invited_by, expires_at)
		VALUES ($1,$2,$3,$4,'viewer',decode(repeat('00',32),'hex'),$5,now()+interval '1 day')`,
		inviteID, workspace.ID, viewerID, viewerID+"@example.test", ownerID); err != nil {
		t.Fatal(err)
	}

	upload, err := s.CreateUploadSession(ctx, NewUploadSession{
		ID: uid("up"), WorkspaceID: workspace.ID, CreatedBy: ownerID,
		ObjectPath: "incoming/deleting", FinalPath: "sources/deleting-pending",
		Name: "pending.pdf", Kind: "pdf", ContentType: "application/pdf",
		DeclaredSize: 50, ParseMode: "none", ExpiresAt: time.Now().UTC().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	reservationID := uid("cr")
	const reserved = int64(123)
	if _, err := s.pool.Exec(ctx, `INSERT INTO provider_sessions
		(id, actor_user_id, workspace_id, surface, reserved_micros, expires_at)
		VALUES ($1,$2,$3,'ingest',$4,now()+interval '1 hour')`,
		reservationID, ownerID, workspace.ID, reserved); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, reserved_micros)
		VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET reserved_micros=$2`,
		ownerID, reserved); err != nil {
		t.Fatal(err)
	}
	jobID := uid("job")
	if _, err := s.pool.Exec(ctx, `INSERT INTO jobs
		(id, type, payload, status, attempts, lease_expires_at)
		VALUES ($1,'ingest',jsonb_build_object(
			'fileId',$2::text,'actorUserId',$3::text,'reservationId',$4::text
		),'running',1,now()+interval '5 minutes')`,
		jobID, file.ID, ownerID, reservationID); err != nil {
		t.Fatal(err)
	}
	var jobAttemptID int64
	if err := s.pool.QueryRow(ctx, `INSERT INTO ingest_job_attempts
		(job_id, operation_id, attempt, job_type, environment, host_id,
		 worker_instance_id, trace_id, queued_at)
		VALUES ($1,$2,1,'ingest','test','test-host','test-worker',$3,now())
		RETURNING id`, jobID, uid("op"), uid("trace")).Scan(&jobAttemptID); err != nil {
		t.Fatal(err)
	}
	providerCallID := uid("call")
	if _, err := s.pool.Exec(ctx, `INSERT INTO provider_calls
		(id, reservation_id, actor_user_id, job_attempt_id, kind)
		VALUES ($1,$2,$3,$4,'audio')`,
		providerCallID, reservationID, ownerID, jobAttemptID); err != nil {
		t.Fatal(err)
	}
	// Deletion is the stronger state when an operator suspension already exists.
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='manual review' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	status, err := s.RequestAccountDeletion(ctx, ownerID, false)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountDeletionPending {
		t.Fatalf("state=%s, want deletion pending", status.State)
	}
	allowed, code, err := s.AccountSessionAllowed(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if allowed || code != "account_deletion_pending" {
		t.Fatalf("session allowed=%t code=%q", allowed, code)
	}

	if _, err := s.WorkspaceAccess(ctx, viewerID, workspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("direct shared access error=%v, want not found", err)
	}
	public, err := s.ListPublicWorkspaces(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range public {
		if item.ID == workspace.ID {
			t.Fatal("deletion-pending workspace remained in Explore")
		}
	}
	if _, err := s.CloneWorkspace(ctx, viewerID, workspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("clone error=%v, want not found", err)
	}
	if _, err := s.AcceptWorkspaceInvite(ctx, inviteID, viewerID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invite acceptance error=%v, want not found", err)
	}

	var jobStatus, sessionStatus, attemptStatus, providerCallStatus string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM jobs WHERE id=$1`, jobID).
		Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT status FROM provider_sessions WHERE id=$1`,
		reservationID).Scan(&sessionStatus); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT status FROM ingest_job_attempts WHERE id=$1`,
		jobAttemptID).Scan(&attemptStatus); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT status FROM provider_calls WHERE id=$1`,
		providerCallID).Scan(&providerCallStatus); err != nil {
		t.Fatal(err)
	}
	var creditReserved int64
	if err := s.pool.QueryRow(ctx, `SELECT reserved_micros FROM user_credits WHERE user_id=$1`,
		ownerID).Scan(&creditReserved); err != nil {
		t.Fatal(err)
	}
	var uploadExists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM upload_sessions WHERE id=$1)`, upload.ID).Scan(&uploadExists); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "failed" || attemptStatus != "failed" ||
		providerCallStatus != "open" || sessionStatus != "released" ||
		creditReserved != 0 || uploadExists {
		t.Fatalf("cancelled work job=%q attempt=%q call=%q session=%q credits=%d uploadExists=%t",
			jobStatus, attemptStatus, providerCallStatus, sessionStatus, creditReserved, uploadExists)
	}
	call := ProviderCallUsage{
		CallID: providerCallID, Kind: KindAudio, Provider: "elevenlabs",
		Model: "scribe_v2", Units: 12, Unit: "seconds",
	}
	if _, err := s.SettleProviderCall(ctx, reservationID, call); err != nil {
		t.Fatalf("settle provider receipt after deletion: %v", err)
	}
	duplicate, err := s.SettleProviderCall(ctx, reservationID, call)
	if err != nil || !duplicate.Duplicate {
		t.Fatalf("idempotent late receipt = %#v, %v", duplicate, err)
	}
	if n := eventCount(t, s, ownerID, reservationID); n != 1 {
		t.Fatalf("late receipt ledger rows = %d, want 1", n)
	}
	if err := s.pool.QueryRow(ctx, `SELECT status FROM provider_sessions WHERE id=$1`,
		reservationID).Scan(&sessionStatus); err != nil {
		t.Fatal(err)
	}
	if sessionStatus != "settled" {
		t.Fatalf("late receipt session=%q, want settled", sessionStatus)
	}
}

func TestPurgeRemovesMembershipsInvitesAndAuxiliaryPII(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	leaverID := newBlobTestUser(t, s, "u_purge_leaver")
	hostID := newBlobTestUser(t, s, "u_purge_host")
	inviteeID := newBlobTestUser(t, s, "u_purge_invitee")
	hostWorkspace, err := s.CreateWorkspace(
		ctx, hostID, "Surviving workspace", ColorBlue, []TagRef{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members
		(workspace_id, user_id, role) VALUES ($1,$2,'editor')`,
		hostWorkspace.ID, leaverID); err != nil {
		t.Fatal(err)
	}
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: leaverID, WorkspaceID: hostWorkspace.ID,
		WorkspaceName: hostWorkspace.Name, Kind: "note", Title: "Surviving note",
	})
	if err != nil {
		t.Fatal(err)
	}
	inviteID := uid("inv")
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_invites
		(id, workspace_id, invited_user_id, email, role, token_hash, invited_by, expires_at)
		VALUES ($1,$2,$3,$4,'viewer',decode(repeat('01',32),'hex'),$5,now()+interval '1 day')`,
		inviteID, hostWorkspace.ID, inviteeID, inviteeID+"@example.test", leaverID); err != nil {
		t.Fatal(err)
	}
	mailID := uid("mail")
	if _, err := s.pool.Exec(ctx, `INSERT INTO email_outbox
		(id, user_id, to_email, template, payload)
		VALUES ($1,$2,$3,'account-test',jsonb_build_object('email',$3::text))`,
		mailID, leaverID, leaverID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	webhookID := uid("wh")
	if _, err := s.pool.Exec(ctx, `INSERT INTO webhook_events
		(id, source, event_type, user_id, payload)
		VALUES ($1,'clerk','user.updated',$2,jsonb_build_object(
			'data',jsonb_build_object('id',$2::text,'email','private@example.test')
		))`, webhookID, leaverID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='private support note' WHERE id=$1`, leaverID); err != nil {
		t.Fatal(err)
	}

	if _, err := s.RequestAccountDeletion(ctx, leaverID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.PurgeUser(ctx, leaverID); err != nil {
		t.Fatal(err)
	}
	claim, _, err := s.ClaimWebhookEvent(
		ctx,
		webhookID,
		"clerk",
		"user.updated",
		leaverID,
		json.RawMessage(`{"id":"`+leaverID+`","email":"restored@example.test"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MarkWebhookProcessed(ctx, "clerk", webhookID, claim, nil); err != nil {
		t.Fatal(err)
	}

	for _, check := range []struct {
		name  string
		query string
		args  []any
		want  int
	}{
		{name: "membership", query: `SELECT count(*) FROM workspace_members WHERE user_id=$1`, args: []any{leaverID}},
		{name: "invite", query: `SELECT count(*) FROM workspace_invites WHERE id=$1`, args: []any{inviteID}},
		{name: "mail", query: `SELECT count(*) FROM email_outbox WHERE id=$1`, args: []any{mailID}},
		{name: "host workspace", query: `SELECT count(*) FROM workspaces WHERE id=$1`, args: []any{hostWorkspace.ID}, want: 1},
		{name: "host material", query: `SELECT count(*) FROM materials WHERE id=$1`, args: []any{material.ID}, want: 1},
	} {
		var got int
		if err := s.pool.QueryRow(ctx, check.query, check.args...).Scan(&got); err != nil {
			t.Fatalf("%s: %v", check.name, err)
		}
		if got != check.want {
			t.Errorf("%s rows=%d, want %d", check.name, got, check.want)
		}
	}
	var author *string
	if err := s.pool.QueryRow(ctx, `SELECT created_by FROM materials WHERE id=$1`,
		material.ID).Scan(&author); err != nil {
		t.Fatal(err)
	}
	if author != nil {
		t.Fatalf("surviving material author=%q, want anonymized", *author)
	}
	var name string
	var email *string
	var deletedAt, suspendedAt *time.Time
	var suspendedReason *string
	if err := s.pool.QueryRow(ctx, `SELECT name, email, deleted_at,
		suspended_at, suspended_reason FROM users WHERE id=$1`,
		leaverID).Scan(&name, &email, &deletedAt, &suspendedAt, &suspendedReason); err != nil {
		t.Fatal(err)
	}
	if name != "" || email != nil || deletedAt == nil ||
		suspendedAt != nil || suspendedReason != nil {
		t.Fatalf("purged profile name=%q email=%v deletedAt=%v suspension=%v/%v",
			name, email, deletedAt, suspendedAt, suspendedReason)
	}
	var webhookPayload string
	if err := s.pool.QueryRow(ctx, `SELECT payload::text FROM webhook_events WHERE id=$1`,
		webhookID).Scan(&webhookPayload); err != nil {
		t.Fatal(err)
	}
	if webhookPayload != "{}" {
		t.Fatalf("webhook payload after purge=%s, want scrubbed", webhookPayload)
	}
}
