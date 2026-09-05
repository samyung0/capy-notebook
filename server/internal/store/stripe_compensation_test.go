package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func reserveStripeCheckoutForTest(
	t *testing.T,
	s *Store,
	ctx context.Context,
	userID, customerID string,
) string {
	t.Helper()
	reservationID, status, err := s.ReserveStripeCheckout(
		ctx,
		userID,
		customerID,
		"price_pro",
		"https://app.test/success",
		"https://app.test/cancel",
	)
	if err != nil || reservationID == "" || status.State != AccountActive {
		t.Fatalf("reserve checkout = %q %#v, %v", reservationID, status, err)
	}
	return reservationID
}

func TestOverQuotaAccountCanReserveCheckout(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for _, frozen := range []bool{false, true} {
		name := "grace"
		if frozen {
			name = "frozen"
		}
		t.Run(name, func(t *testing.T) {
			userID := newBlobTestUser(t, s, "u_checkout_"+name)
			ws, err := s.CreateWorkspace(ctx, userID, "Checkout recovery", ColorGreen, []TagRef{})
			if err != nil {
				t.Fatal(err)
			}
			pushOverQuota(t, s, userID, ws.ID)
			lapse := "2 days"
			if frozen {
				lapse = "20 days"
			}
			if _, err := s.pool.Exec(ctx, `UPDATE user_subscriptions
				SET current_period_end=now()-$2::interval,
					stripe_event_created=extract(epoch FROM now())::bigint
				WHERE user_id=$1`, userID, lapse); err != nil {
				t.Fatal(err)
			}
			reservationID, status, err := s.ReserveStripeCheckout(
				ctx,
				userID,
				"cus_"+name,
				"price_pro",
				"https://app.test/success",
				"https://app.test/cancel",
			)
			if err != nil || reservationID == "" {
				t.Fatalf("reserve checkout = %q %#v, %v", reservationID, status, err)
			}
			want := AccountOverQuotaGrace
			if frozen {
				want = AccountOverQuotaFrozen
			}
			if status.State != want {
				t.Fatalf("checkout account state=%q, want %q", status.State, want)
			}
		})
	}
}

func TestDeletingAccountCompensatesCheckoutRaceWithoutEntitlement(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_race")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_race")
	status, err := s.RecordStripeCheckoutSession(
		ctx, reservationID, userID, "cus_race", "cs_race",
	)
	if err != nil || status.State != AccountActive {
		t.Fatalf("record checkout = %#v, %v", status, err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	allowed, err := s.RecordStripeCheckoutCompleted(
		ctx, "cs_race", reservationID, userID, "cus_race", "sub_race",
	)
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("checkout completion was accepted after deletion started")
	}
	periodEnd := time.Now().UTC().Add(30 * 24 * time.Hour)
	if err := s.UpsertSubscription(ctx, Subscription{
		StripeSubscriptionID: "sub_race",
		UserID:               userID,
		Status:               "active",
		PriceID:              "price_pro",
		PlanTier:             PlanPro,
		CurrentPeriodEnd:     &periodEnd,
		StripeEventCreated:   time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	var subscriptionRows, expireJobs, cancelJobs int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM user_subscriptions
		WHERE user_id=$1`, userID).Scan(&subscriptionRows); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT
		count(*) FILTER (WHERE action='expire_checkout'),
		count(*) FILTER (WHERE action='cancel_subscription')
		FROM stripe_compensations WHERE user_id=$1`, userID).Scan(&expireJobs, &cancelJobs); err != nil {
		t.Fatal(err)
	}
	if subscriptionRows != 1 || expireJobs != 1 || cancelJobs != 1 {
		t.Fatalf("subscription rows=%d expire=%d cancel=%d", subscriptionRows, expireJobs, cancelJobs)
	}
	access, err := s.AccountAccess(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if access.PlanTier != PlanFree || access.State != AccountDeletionPending {
		t.Fatalf("raced checkout changed lifecycle: %#v", access)
	}
}

func TestSuccessfulSubscriptionCompensationClosesProviderTruthBeforeRestore(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_cancel_restore")
	subscriptionID := "sub_cancel_restore"
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subscriptionID, 1_000)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.Action != StripeCancelSubscription {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.FinishStripeCompensation(ctx, *job, nil); err != nil {
		release()
		t.Fatal(err)
	}
	release()

	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, userID); tier != PlanFree || status != "canceled" {
		t.Fatalf("restored lifecycle projected %s/%s, want free/canceled", tier, status)
	}
	var storedStatus string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, subscriptionID).Scan(&storedStatus); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "canceled" {
		t.Fatalf("subscription status=%q, want canceled", storedStatus)
	}
}

func TestSuccessfulCancellationTombstoneRejectsDelayedLiveWebhookAfterRestore(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_cancel_tombstone")
	subscriptionID := "sub_cancel_tombstone"
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	if err := s.EnqueueStripeCompensation(
		ctx, userID, StripeCancelSubscription, subscriptionID,
	); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.Action != StripeCancelSubscription {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.FinishStripeCompensation(ctx, *job, nil); err != nil {
		release()
		t.Fatal(err)
	}
	release()

	var watermark int64
	if err := s.pool.QueryRow(ctx, `SELECT stripe_event_created
		FROM user_subscriptions WHERE stripe_subscription_id=$1`, subscriptionID).
		Scan(&watermark); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	stale := proSubscription(userID, subscriptionID, watermark-1)
	if err := s.UpsertSubscription(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, userID); tier != PlanFree || status != "canceled" {
		t.Fatalf("delayed webhook projected %s/%s, want free/canceled", tier, status)
	}
	var storedStatus string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, subscriptionID).Scan(&storedStatus); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "canceled" {
		t.Fatalf("delayed webhook replaced tombstone with %q", storedStatus)
	}
}

func TestLateLiveWebhookReopensCompletedSubscriptionCancellation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_late_live")
	subscriptionID := "sub_late_live"
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	if err := s.EnqueueStripeCompensation(
		ctx, userID, StripeCancelSubscription, subscriptionID,
	); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.Action != StripeCancelSubscription {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.FinishStripeCompensation(ctx, *job, nil); err != nil {
		release()
		t.Fatal(err)
	}
	release()

	record := proSubscription(userID, subscriptionID, time.Now().Unix()+10)
	if err := s.UpsertSubscription(ctx, record); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM stripe_compensations
		WHERE action='cancel_subscription' AND object_id=$1`, subscriptionID).
		Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "pending" {
		t.Fatalf("late live webhook left cancellation %q, want pending", status)
	}
	if tier, projectedStatus := projectedPlan(t, s, userID); tier != PlanFree || projectedStatus != "canceled" {
		t.Fatalf("closed lifecycle projected %s/%s, want free/canceled", tier, projectedStatus)
	}
}

func TestDeletionTransactionCompensatesSubscriptionActivatedAfterPreflight(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_preflight_race")
	periodEnd := time.Now().UTC().Add(30 * 24 * time.Hour)
	if err := s.UpsertSubscription(ctx, Subscription{
		StripeSubscriptionID: "sub_preflight_race",
		UserID:               userID,
		Status:               "active",
		PriceID:              "price_pro",
		PlanTier:             PlanPro,
		CurrentPeriodEnd:     &periodEnd,
		StripeEventCreated:   time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	status, err := s.RequestAccountDeletion(ctx, userID, false)
	if err != nil || status.State != AccountDeletionPending {
		t.Fatalf("deletion request = %#v, %v", status, err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM stripe_compensations
		WHERE user_id=$1 AND action='cancel_subscription'
		  AND object_id='sub_preflight_race'`, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("preflight-race cancellation jobs=%d", count)
	}
}

func TestDeletionDoesNotRefundExistingPeriodEndCancellation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_period_end")
	periodEnd := time.Now().UTC().Add(10 * 24 * time.Hour)
	if err := s.UpsertSubscription(ctx, Subscription{
		StripeSubscriptionID: "sub_period_end",
		UserID:               userID,
		Status:               "active",
		PriceID:              "price_pro",
		PlanTier:             PlanPro,
		CurrentPeriodEnd:     &periodEnd,
		CancelAtPeriodEnd:    true,
		StripeEventCreated:   time.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM stripe_compensations
		WHERE user_id=$1 AND action='cancel_subscription'`, userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("period-end subscription compensation jobs=%d, want 0", count)
	}
}

func TestProviderPeriodEndTruthSuppressesCancellationWithoutTombstone(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_provider_period_end")
	subscriptionID := "sub_provider_period_end"
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subscriptionID, 1_000)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.Action != StripeCancelSubscription {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.MarkStripeCompensationProviderStarted(ctx, *job); err != nil {
		release()
		t.Fatal(err)
	}
	if err := s.SuppressStripeCancellationAtPeriodEnd(ctx, *job); err != nil {
		release()
		t.Fatal(err)
	}
	release()

	var jobStatus, subscriptionStatus string
	var cancelAtPeriodEnd bool
	if err := s.pool.QueryRow(ctx, `SELECT status FROM stripe_compensations
		WHERE id=$1`, job.ID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx, `SELECT status,cancel_at_period_end
		FROM user_subscriptions WHERE stripe_subscription_id=$1`, subscriptionID).
		Scan(&subscriptionStatus, &cancelAtPeriodEnd); err != nil {
		t.Fatal(err)
	}
	var refundJobs int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM stripe_compensations
		WHERE user_id=$1 AND action IN ('refund_payment_intent','refund_charge')`, userID).
		Scan(&refundJobs); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "suppressed" || subscriptionStatus != "active" || cancelAtPeriodEnd || refundJobs != 0 {
		t.Fatalf("period-end suppression job=%q subscription=%q cape=%t refunds=%d",
			jobStatus, subscriptionStatus, cancelAtPeriodEnd, refundJobs)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, userID); tier != PlanPro || status != "active" {
		t.Fatalf("restored period-end subscription projected %s/%s, want pro/active", tier, status)
	}
}

func TestLaterNonPeriodEndTruthReopensSuppressedCancellation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_period_end_reopened")
	subscriptionID := "sub_period_end_reopened"
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subscriptionID, 1_000)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.Action != StripeCancelSubscription {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.MarkStripeCompensationProviderStarted(ctx, *job); err != nil {
		release()
		t.Fatal(err)
	}
	if err := s.SuppressStripeCancellationAtPeriodEnd(ctx, *job); err != nil {
		release()
		t.Fatal(err)
	}
	release()

	// A later webhook says the end-of-period cancellation was reversed while
	// the account is still closed. That stronger truth must reopen cleanup.
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subscriptionID, 2_000)); err != nil {
		t.Fatal(err)
	}
	var status string
	var providerStartedAt *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT status,provider_started_at
		FROM stripe_compensations WHERE id=$1`, job.ID).
		Scan(&status, &providerStartedAt); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || providerStartedAt != nil {
		t.Fatalf("reopened cancellation status=%q providerStartedAt=%v", status, providerStartedAt)
	}
}

func TestSuspendedAccountExpiresRacedCheckout(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_suspended")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_hold")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='operator hold' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	status, err := s.RecordStripeCheckoutSession(
		ctx, reservationID, userID, "cus_hold", "cs_hold",
	)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountSuspended {
		t.Fatalf("checkout state=%s, want suspended", status.State)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM stripe_compensations
		WHERE user_id=$1 AND action='expire_checkout' AND object_id='cs_hold'`, userID).
		Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("raced suspended checkout compensation rows=%d", count)
	}
}

func TestStripeCompensationFailureIsRetriedDurably(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_retry")
	if err := s.EnqueueStripeCompensation(
		ctx, userID, StripeRefundPayment, "pi_retry",
	); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	if err := s.FinishStripeCompensation(ctx, *job, errors.New("Stripe unavailable")); err != nil {
		t.Fatal(err)
	}
	var status, lastError string
	var attempts int
	var leaseToken *string
	if err := s.pool.QueryRow(ctx, `SELECT status,attempts,lease_token,last_error
		FROM stripe_compensations WHERE id=$1`, job.ID).
		Scan(&status, &attempts, &leaseToken, &lastError); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || attempts != 1 || leaseToken != nil || lastError == "" {
		t.Fatalf("retry status=%q attempts=%d lease=%v error=%q",
			status, attempts, leaseToken, lastError)
	}
}

func TestDeletionCancellationSuppressesClaimedStripeCleanup(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_restore")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_restore")
	if _, err := s.RecordStripeCheckoutSession(
		ctx,
		reservationID,
		userID,
		"cus_restore",
		"cs_restore",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if release != nil {
		release()
	}
	if err != nil {
		t.Fatal(err)
	}
	if allowed {
		t.Fatal("claimed deletion cleanup remained runnable after restoration")
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM stripe_compensations
		WHERE id=$1`, job.ID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "suppressed" {
		t.Fatalf("restored compensation status=%q, want suppressed", status)
	}
}

func TestFreshDeletionReopensSuppressedStripeCleanup(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_fresh_deletion")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_fresh_deletion")
	if _, err := s.RecordStripeCheckoutSession(
		ctx,
		reservationID,
		userID,
		"cus_fresh_deletion",
		"cs_fresh_deletion",
	); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertSubscription(
		ctx,
		proSubscription(userID, "sub_fresh_deletion", 1_000),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}

	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	rows, err := s.pool.Query(ctx, `SELECT action,status,provider_started_at
		FROM stripe_compensations
		WHERE user_id=$1 AND action IN ('expire_checkout','cancel_subscription')
		ORDER BY action`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var action StripeCompensationAction
		var status string
		var providerStartedAt *time.Time
		if err := rows.Scan(&action, &status, &providerStartedAt); err != nil {
			t.Fatal(err)
		}
		if status != "pending" || providerStartedAt != nil {
			t.Fatalf("reopened %s status=%q providerStartedAt=%v", action, status, providerStartedAt)
		}
		seen++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if seen != 2 {
		t.Fatalf("reopened deletion cleanup jobs=%d, want 2", seen)
	}
}

func TestDeletionRestoreWaitsForStartedSubscriptionCancellation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_started_restore")
	subscriptionID := "sub_started_restore"
	if err := s.UpsertSubscription(ctx, proSubscription(userID, subscriptionID, 1_000)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.Action != StripeCancelSubscription {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.MarkStripeCompensationProviderStarted(ctx, *job); err != nil {
		release()
		t.Fatal(err)
	}
	release() // Simulate a worker losing local completion after the remote call.

	if _, err := s.CancelAccountDeletion(ctx, userID); !errors.Is(err, ErrConflict) {
		t.Fatalf("restore during uncertain cancellation error=%v, want conflict", err)
	}
	release, allowed, err = s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("resume compensation allowed=%v err=%v", allowed, err)
	}
	if err := s.FinishStripeCompensation(ctx, *job, nil); err != nil {
		release()
		t.Fatal(err)
	}
	release()

	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, userID); tier != PlanFree || status != "canceled" {
		t.Fatalf("restored lifecycle projected %s/%s, want free/canceled", tier, status)
	}
}

func TestStripeCheckoutReservationIsUniqueAndRecoverable(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_reservation")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "")
	if _, _, err := s.ReserveStripeCheckout(
		ctx,
		userID,
		"",
		"price_pro",
		"https://app.test/success",
		"https://app.test/cancel",
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("second checkout reservation error=%v, want conflict", err)
	}
	recovery, err := s.StripeCheckoutRecovery(ctx, reservationID)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.UserID != userID || recovery.PriceID != "price_pro" {
		t.Fatalf("checkout recovery = %#v", recovery)
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM stripe_compensations
		WHERE action='recover_checkout' AND object_id=$1 AND status='pending'`,
		reservationID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("checkout recovery jobs=%d, want 1", count)
	}
	if err := s.CompleteStripeCheckoutRecovery(
		ctx, reservationID, "cus_recovered", "cs_recovered",
	); err != nil {
		t.Fatal(err)
	}
	var userCustomer, checkoutCustomer, checkoutStatus string
	if err := s.pool.QueryRow(ctx, `SELECT u.stripe_customer_id,c.customer_id,c.status
		FROM users u JOIN stripe_checkout_sessions c ON c.user_id=u.id
		WHERE c.id=$1`, reservationID).
		Scan(&userCustomer, &checkoutCustomer, &checkoutStatus); err != nil {
		t.Fatal(err)
	}
	if userCustomer != "cus_recovered" || checkoutCustomer != "cus_recovered" ||
		checkoutStatus != "expired" {
		t.Fatalf("recovery customer user=%q checkout=%q status=%q",
			userCustomer, checkoutCustomer, checkoutStatus)
	}
}

func assertCheckoutCompletionConverged(
	t *testing.T,
	s *Store,
	ctx context.Context,
	userID, reservationID, sessionID string,
) {
	t.Helper()
	var count int
	var id, status string
	if err := s.pool.QueryRow(ctx, `SELECT count(*),min(id),min(status)
		FROM stripe_checkout_sessions WHERE user_id=$1`, userID).
		Scan(&count, &id, &status); err != nil {
		t.Fatal(err)
	}
	if count != 1 || id != reservationID || status != "completed" {
		t.Fatalf("checkout rows=%d id=%q status=%q, want one completed reservation %q",
			count, id, status, reservationID)
	}
	var providerID, recoveryStatus string
	if err := s.pool.QueryRow(ctx, `SELECT c.provider_session_id,x.status
		FROM stripe_checkout_sessions c
		JOIN stripe_compensations x ON x.object_id=c.id
		WHERE c.id=$1 AND x.action='recover_checkout'`, reservationID).
		Scan(&providerID, &recoveryStatus); err != nil {
		t.Fatal(err)
	}
	if providerID != sessionID || recoveryStatus != "suppressed" {
		t.Fatalf("provider=%q recovery=%q, want %q/suppressed",
			providerID, recoveryStatus, sessionID)
	}
}

func TestStripeCheckoutCompletionBeforeBindConvergesReservation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_checkout_completion_before_bind")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_early")
	allowed, err := s.RecordStripeCheckoutCompleted(
		ctx, "cs_early", reservationID, userID, "cus_early", "sub_early",
	)
	if err != nil || !allowed {
		t.Fatalf("completion allowed=%v err=%v", allowed, err)
	}
	status, err := s.RecordStripeCheckoutSession(
		ctx, reservationID, userID, "cus_early", "cs_early",
	)
	if err != nil || status.State != AccountActive {
		t.Fatalf("late bind status=%#v err=%v", status, err)
	}
	assertCheckoutCompletionConverged(t, s, ctx, userID, reservationID, "cs_early")
}

func TestStripeCheckoutConcurrentCompletionAndBindConverge(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for i := range 5 {
		userID := newBlobTestUser(t, s, fmt.Sprintf("u_checkout_concurrent_%d", i))
		customerID := fmt.Sprintf("cus_concurrent_%d", i)
		reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, customerID)
		sessionID := fmt.Sprintf("cs_concurrent_%d", i)
		start := make(chan struct{})
		errs := make(chan error, 2)
		go func() {
			<-start
			_, err := s.RecordStripeCheckoutSession(
				ctx, reservationID, userID, customerID, sessionID,
			)
			errs <- err
		}()
		go func() {
			<-start
			allowed, err := s.RecordStripeCheckoutCompleted(
				ctx, sessionID, reservationID, userID, customerID, "sub_"+sessionID,
			)
			if err == nil && !allowed {
				err = errors.New("active checkout was not allowed")
			}
			errs <- err
		}()
		close(start)
		for range 2 {
			if err := <-errs; err != nil {
				t.Fatalf("iteration %d concurrent checkout: %v", i, err)
			}
		}
		assertCheckoutCompletionConverged(t, s, ctx, userID, reservationID, sessionID)
	}
}

func TestStripeCheckoutExpirationAfterBindErrorConvergesLocalState(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_checkout_bind_error_expire")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_expire")
	if err := s.RecordStripeCheckoutSessionExpired(
		ctx, reservationID, userID, "cus_expire", "cs_expired_after_bind_error",
	); err != nil {
		t.Fatal(err)
	}
	var status, providerID, checkoutCustomer, userCustomer, recoveryStatus string
	if err := s.pool.QueryRow(ctx, `SELECT c.status,c.provider_session_id,
		c.customer_id,u.stripe_customer_id,x.status
		FROM stripe_checkout_sessions c
		JOIN users u ON u.id=c.user_id
		JOIN stripe_compensations x ON x.object_id=c.id
		WHERE c.id=$1 AND x.action='recover_checkout'`, reservationID).
		Scan(&status, &providerID, &checkoutCustomer, &userCustomer, &recoveryStatus); err != nil {
		t.Fatal(err)
	}
	if status != "expired" || providerID != "cs_expired_after_bind_error" ||
		checkoutCustomer != "cus_expire" || userCustomer != "cus_expire" ||
		recoveryStatus != "suppressed" {
		t.Fatalf("checkout=%q provider=%q checkout customer=%q user customer=%q recovery=%q",
			status, providerID, checkoutCustomer, userCustomer, recoveryStatus)
	}
}

func TestStripeCheckoutExpirationDoesNotSuppressCustomerConflict(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_checkout_expire_customer_conflict")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id='cus_existing'
		WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_existing")
	if err := s.RecordStripeCheckoutSessionExpired(
		ctx, reservationID, userID, "cus_new", "cs_customer_conflict",
	); err == nil {
		t.Fatal("bind-error expiration accepted a conflicting new customer")
	}
	var checkoutStatus, recoveryStatus, userCustomer string
	if err := s.pool.QueryRow(ctx, `SELECT c.status,x.status,u.stripe_customer_id
		FROM stripe_checkout_sessions c
		JOIN stripe_compensations x ON x.object_id=c.id AND x.action='recover_checkout'
		JOIN users u ON u.id=c.user_id
		WHERE c.id=$1`, reservationID).
		Scan(&checkoutStatus, &recoveryStatus, &userCustomer); err != nil {
		t.Fatal(err)
	}
	if checkoutStatus != "creating" || recoveryStatus != "pending" || userCustomer != "cus_existing" {
		t.Fatalf("checkout=%q recovery=%q customer=%q",
			checkoutStatus, recoveryStatus, userCustomer)
	}
}

func TestStripeCheckoutCompletionRejectsCustomerIdentityMismatch(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	t.Run("user mapping", func(t *testing.T) {
		userID := newBlobTestUser(t, s, "u_checkout_user_customer_mismatch")
		if _, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id='cus_mapped'
			WHERE id=$1`, userID); err != nil {
			t.Fatal(err)
		}
		reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_mapped")
		if _, err := s.RecordStripeCheckoutCompleted(
			ctx, "cs_user_mismatch", reservationID, userID, "cus_event", "sub_user_mismatch",
		); err == nil {
			t.Fatal("checkout accepted a customer that conflicts with the user mapping")
		}
	})

	t.Run("reservation mapping", func(t *testing.T) {
		userID := newBlobTestUser(t, s, "u_checkout_reservation_customer_mismatch")
		reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_reserved")
		if _, err := s.RecordStripeCheckoutCompleted(
			ctx, "cs_reservation_mismatch", reservationID, userID, "cus_event", "sub_reservation_mismatch",
		); err == nil {
			t.Fatal("checkout accepted a customer that conflicts with the reservation")
		}
	})

	t.Run("reservation owner", func(t *testing.T) {
		ownerID := newBlobTestUser(t, s, "u_checkout_reservation_owner")
		otherID := newBlobTestUser(t, s, "u_checkout_reservation_other")
		reservationID := reserveStripeCheckoutForTest(t, s, ctx, ownerID, "cus_owner")
		if _, err := s.RecordStripeCheckoutCompleted(
			ctx, "cs_owner_mismatch", reservationID, otherID, "cus_owner", "sub_owner_mismatch",
		); !errors.Is(err, ErrConflict) {
			t.Fatalf("reservation owner mismatch error=%v, want conflict", err)
		}
	})
}

func TestStripeCheckoutRecoverySerializesWithSessionBinding(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_recovery_bind")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_bind")
	if _, err := s.pool.Exec(ctx, `UPDATE stripe_compensations
		SET next_attempt_at=now() WHERE action='recover_checkout' AND object_id=$1`,
		reservationID); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.ObjectID != reservationID {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if err != nil || !allowed {
		t.Fatalf("begin recovery allowed=%v err=%v", allowed, err)
	}
	blockedCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := s.RecordStripeCheckoutSession(
		blockedCtx, reservationID, userID, "cus_bind", "cs_bind",
	); !errors.Is(err, context.DeadlineExceeded) {
		release()
		t.Fatalf("concurrent bind error=%v, want deadline exceeded", err)
	}
	release()
	if _, err := s.RecordStripeCheckoutSession(
		ctx, reservationID, userID, "cus_bind", "cs_bind",
	); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishStripeCompensation(ctx, *job, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale recovery finish error=%v, want conflict", err)
	}
}

func TestStripeCheckoutBindingFencesClaimedRecovery(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_recovery_claimed")
	reservationID := reserveStripeCheckoutForTest(t, s, ctx, userID, "cus_claimed")
	if _, err := s.pool.Exec(ctx, `UPDATE stripe_compensations
		SET next_attempt_at=now() WHERE action='recover_checkout' AND object_id=$1`,
		reservationID); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil || job.ObjectID != reservationID {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	if _, err := s.RecordStripeCheckoutSession(
		ctx, reservationID, userID, "cus_claimed", "cs_claimed",
	); err != nil {
		t.Fatal(err)
	}
	release, allowed, err := s.BeginStripeCompensation(ctx, *job)
	if release != nil {
		release()
	}
	if !errors.Is(err, ErrConflict) || allowed {
		t.Fatalf("stale recovery begin allowed=%v err=%v, want fenced conflict", allowed, err)
	}
	var status string
	var leaseToken *string
	var completedAt *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT status,lease_token,completed_at
		FROM stripe_compensations WHERE id=$1`, job.ID).
		Scan(&status, &leaseToken, &completedAt); err != nil {
		t.Fatal(err)
	}
	if status != "suppressed" || leaseToken != nil || completedAt == nil {
		t.Fatalf("fenced recovery status=%q lease=%v completed=%v",
			status, leaseToken, completedAt)
	}
}

func TestFailedStripeRefundAdvancesIdempotencyGeneration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_stripe_refund_generation")
	if err := s.EnqueueStripeCompensation(
		ctx, userID, StripeRefundPayment, "pi_generation",
	); err != nil {
		t.Fatal(err)
	}
	job, err := s.ClaimStripeCompensation(ctx, time.Minute)
	if err != nil || job == nil {
		t.Fatalf("claim = %#v, %v", job, err)
	}
	if err := s.SetStripeCompensationProviderResult(ctx, *job, "re_failed"); err != nil {
		t.Fatal(err)
	}
	if err := s.AdvanceStripeRefundGeneration(
		ctx, *job, errors.New("refund failed"),
	); err != nil {
		t.Fatal(err)
	}
	var status string
	var generation int
	var providerResultID *string
	if err := s.pool.QueryRow(ctx, `SELECT status,generation,provider_result_id
		FROM stripe_compensations WHERE id=$1`, job.ID).
		Scan(&status, &generation, &providerResultID); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || generation != 1 || providerResultID != nil {
		t.Fatalf("refund retry status=%q generation=%d providerResult=%v",
			status, generation, providerResultID)
	}
}
