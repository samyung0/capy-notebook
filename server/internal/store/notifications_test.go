package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestNotificationReadIsScopedToRecipient(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userA := uid("notification-user")
	userB := uid("notification-user")
	_, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3),($4,$5,$6)`,
		userA, "Notification A", userA+"@example.test",
		userB, "Notification B", userB+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id IN ($1,$2)`, userA, userB)
	})

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	notification, err := CreateNotificationTx(ctx, tx, NotificationParams{
		Data:   json.RawMessage(`{"title":"test","body":"test"}`),
		Kind:   NotifSystem,
		UserID: userA,
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	changed, err := s.MarkNotificationRead(ctx, userB, notification.ID)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("a different user marked the notification read")
	}
	changed, err = s.MarkNotificationRead(ctx, userA, notification.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("recipient notification was not marked read")
	}
}

func TestEmailOutboxPreferencesIdempotencyAndFailureCleanup(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := uid("email-user")
	_, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3)`, userID, "Email User", userID+"@example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	if _, err := s.SetNotificationPrefs(ctx, userID, NotificationPrefs{
		EmailMembership:      false,
		EmailWorkspaceInvite: true,
	}); err != nil {
		t.Fatal(err)
	}
	idempotencyKey := uid("email-key")
	enqueue := func() (bool, error) {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return false, err
		}
		created, err := EnqueueEmailTx(ctx, tx, EmailOutboxParams{
			Category:       "membership",
			IdempotencyKey: idempotencyKey,
			Locale:         "en",
			Payload:        json.RawMessage(`{"workspaceName":"Test"}`),
			Template:       "workspace-role-changed",
			ToEmail:        userID + "@example.test",
			UserID:         userID,
		})
		if err != nil {
			_ = tx.Rollback(ctx)
			return false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return false, err
		}
		return created, nil
	}

	created, err := enqueue()
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("disabled membership email was enqueued")
	}
	if _, err := s.SetNotificationPrefs(ctx, userID, NotificationPrefs{
		EmailMembership:      true,
		EmailWorkspaceInvite: true,
	}); err != nil {
		t.Fatal(err)
	}
	created, err = enqueue()
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("enabled membership email was not enqueued")
	}
	created, err = enqueue()
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("duplicate idempotency key created another email")
	}

	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox SET next_attempt_at=now()+interval '1 day'
		WHERE status='pending' AND user_id<>$1`, userID); err != nil {
		t.Fatal(err)
	}
	items, err := s.ClaimEmails(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("claimed %d email(s), want 1", len(items))
	}
	item := items[0]
	if err := s.MarkEmailFailed(ctx, item, errors.New("temporary failure")); err != nil {
		t.Fatal(err)
	}
	var status string
	var nextAttempt time.Time
	if err := s.pool.QueryRow(ctx, `SELECT status, next_attempt_at
		FROM email_outbox WHERE id=$1`, item.ID).Scan(&status, &nextAttempt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || !nextAttempt.After(time.Now().UTC()) {
		t.Fatalf("retry state = %q at %s", status, nextAttempt)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox
		SET next_attempt_at=now() WHERE id=$1`, item.ID); err != nil {
		t.Fatal(err)
	}
	items, err = s.ClaimEmails(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("claimed %d email(s) for terminal retry, want 1", len(items))
	}
	item = items[0]
	item.Attempts = 6
	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox
		SET attempts=6, payload='{"secret":"token"}'::jsonb WHERE id=$1`, item.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkEmailFailed(ctx, item, errors.New("permanent failure")); err != nil {
		t.Fatal(err)
	}
	var payload []byte
	if err := s.pool.QueryRow(ctx, `SELECT status, payload
		FROM email_outbox WHERE id=$1`, item.ID).Scan(&status, &payload); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || string(payload) != `{}` {
		t.Fatalf("terminal failure state = %q payload %s", status, payload)
	}
}

func TestEmailOutboxSuppressesBlankRecipient(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := uid("blank-email-user")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,NULL)`, userID, "Blank Email User"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	created, err := EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		Category:       "membership",
		IdempotencyKey: uid("blank-email-key"),
		Template:       "workspace-role-changed",
		ToEmail:        " \t\n ",
		UserID:         userID,
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if created {
		_ = tx.Rollback(ctx)
		t.Fatal("blank recipient was enqueued")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM email_outbox WHERE user_id=$1`, userID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("blank recipient created %d outbox row(s)", count)
	}
}

func TestClaimEmailsLeavesTerminalRowsAloneAndShutdownRefundsAttempts(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := uid("claim-user")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3)`, userID, "Claim User", userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	enqueue := func() {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := EnqueueEmailTx(ctx, tx, EmailOutboxParams{
			Category:       "membership",
			IdempotencyKey: uid("claim-key"),
			Locale:         "en",
			Payload:        json.RawMessage(`{"workspaceId":"ws_test"}`),
			Template:       "workspace-member-removed",
			ToEmail:        userID + "@example.test",
			UserID:         userID,
		}); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	enqueue()
	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox
		SET status='failed', attempts=$2, updated_at=now()-interval '1 hour'
		WHERE user_id=$1`, userID, maxEmailAttempts); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := s.pool.QueryRow(ctx, `SELECT updated_at FROM email_outbox
		WHERE user_id=$1`, userID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ClaimEmails(ctx, 1); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := s.pool.QueryRow(ctx, `SELECT updated_at FROM email_outbox
		WHERE user_id=$1`, userID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !after.Equal(before) {
		t.Fatal("claiming rewrote an already-failed row")
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	enqueue()
	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox SET next_attempt_at=now()+interval '1 day'
		WHERE status='pending' AND (user_id IS NULL OR user_id<>$1)`, userID); err != nil {
		t.Fatal(err)
	}
	items, err := s.ClaimEmails(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Attempts != 1 {
		t.Fatalf("claimed %d email(s) with attempts %v", len(items), items)
	}
	if err := s.ReleaseEmailClaims(ctx, items); err != nil {
		t.Fatal(err)
	}
	var status string
	var attempts int
	if err := s.pool.QueryRow(ctx, `SELECT status, attempts FROM email_outbox
		WHERE id=$1`, items[0].ID).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 0 {
		t.Fatalf("released claim = %q with %d attempt(s); want pending with 0", status, attempts)
	}
}

func TestDisableNotificationCategoryIsAtomic(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := uid("unsubscribe-user")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3)`, userID, "Unsubscribe User", userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, category := range []string{"workspace_invite", "membership"} {
		wg.Add(1)
		go func(category string) {
			defer wg.Done()
			errs <- s.DisableNotificationCategory(ctx, userID, category)
		}(category)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	prefs, err := s.GetNotificationPrefs(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if prefs.EmailWorkspaceInvite || prefs.EmailMembership {
		t.Fatalf("concurrent unsubscribe lost an update: %#v", prefs)
	}
}

func TestEmailCompletionRequiresCurrentLease(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := uid("lease-user")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1,$2,$3)`, userID, "Lease User", userID+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID)
		_, _ = s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	created, err := EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		Category:       "membership",
		IdempotencyKey: uid("lease-key"),
		Locale:         "en",
		Payload:        json.RawMessage(`{"workspaceId":"ws_test","role":"viewer"}`),
		Template:       "workspace-member-removed",
		ToEmail:        userID + "@example.test",
		UserID:         userID,
	})
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if !created {
		_ = tx.Rollback(ctx)
		t.Fatal("email was not enqueued")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE email_outbox SET next_attempt_at=now()+interval '1 day'
		WHERE status='pending' AND user_id<>$1`, userID); err != nil {
		t.Fatal(err)
	}
	items, err := s.ClaimEmails(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("claimed %d email(s), want 1", len(items))
	}
	stale := items[0]
	stale.LeaseToken = "stale-lease"
	if err := s.MarkEmailSent(ctx, stale, "provider-stale"); !errors.Is(err, ErrEmailLeaseLost) {
		t.Fatalf("stale completion error = %v, want ErrEmailLeaseLost", err)
	}
	if err := s.MarkEmailSent(ctx, items[0], "provider-current"); err != nil {
		t.Fatal(err)
	}
}
