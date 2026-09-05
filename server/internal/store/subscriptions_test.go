package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func projectedPlan(t *testing.T, s *Store, userID string) (PlanTier, SubscriptionStatus) {
	t.Helper()
	var tier PlanTier
	var status SubscriptionStatus
	err := s.pool.QueryRow(context.Background(),
		`SELECT plan_tier, subscription_status FROM users WHERE id=$1`, userID).
		Scan(&tier, &status)
	if err != nil {
		t.Fatal(err)
	}
	return tier, status
}

func proSubscription(userID, subID string, eventCreated int64) Subscription {
	end := time.Now().Add(20 * 24 * time.Hour).UTC().Truncate(time.Second)
	return Subscription{
		StripeSubscriptionID: subID,
		UserID:               userID,
		Status:               "active",
		PriceID:              "price_pro",
		PlanTier:             PlanPro,
		CurrentPeriodEnd:     &end,
		StripeEventCreated:   eventCreated,
	}
}

func TestPlanTierIsProjectedFromTheSubscriptionRow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_proj")

	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "none" {
		t.Fatalf("a user who never subscribed should read free/none, got %s/%s", tier, status)
	}

	sub := proSubscription(user, uid("sub"), 1000)
	if err := s.UpsertSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanPro || status != "active" {
		t.Fatalf("checkout should project pro/active, got %s/%s", tier, status)
	}

	// The cancellation event.
	canceled := sub
	canceled.Status = "canceled"
	// A sparse deletion payload may not identify the old product. The stored
	// subscription still has to retain Pro as historical lapse evidence.
	canceled.PlanTier = PlanFree
	canceled.StripeEventCreated = 2000
	if err := s.UpsertSubscription(ctx, canceled); err != nil {
		t.Fatal(err)
	}
	tier, status := projectedPlan(t, s, user)
	if tier != PlanFree {
		t.Fatalf("cancellation should drop the tier to free, got %s", tier)
	}
	// Not "none": the lapse notifications only make sense for somebody who once
	// paid, so the two have to stay distinguishable.
	if status != "canceled" {
		t.Fatalf("a former subscriber should read canceled, got %s", status)
	}
	var historicalTier PlanTier
	if err := s.pool.QueryRow(ctx, `SELECT plan_tier FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, sub.StripeSubscriptionID).Scan(&historicalTier); err != nil {
		t.Fatal(err)
	}
	if historicalTier != PlanPro {
		t.Fatalf("closed subscription historical tier=%s, want pro", historicalTier)
	}
}

func TestAttributedSubscriptionBindsCustomerForReconciliation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_metadata_customer")
	customerID := uid("cus_metadata")

	if err := s.UpsertAttributedSubscription(
		ctx, customerID, proSubscription(user, uid("sub_metadata"), 1000),
	); err != nil {
		t.Fatal(err)
	}
	customers, err := s.ListStripeCustomers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, customer := range customers {
		if customer.UserID == user {
			if customer.CustomerID != customerID {
				t.Fatalf("customer id=%q, want %q", customer.CustomerID, customerID)
			}
			return
		}
	}
	t.Fatal("metadata-attributed subscription was not visible to reconciliation")
}

func TestAttributedSubscriptionCustomerMismatchRollsBack(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_customer_mismatch")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id='cus_original'
		WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	sub := proSubscription(user, uid("sub_customer_mismatch"), 1000)
	if err := s.UpsertAttributedSubscription(ctx, "cus_other", sub); !errors.Is(err, ErrConflict) {
		t.Fatalf("customer mismatch error=%v, want conflict", err)
	}
	var customerID *string
	var subscriptions int
	if err := s.pool.QueryRow(ctx, `SELECT stripe_customer_id,
		(SELECT count(*) FROM user_subscriptions WHERE stripe_subscription_id=$2)
		FROM users WHERE id=$1`, user, sub.StripeSubscriptionID).
		Scan(&customerID, &subscriptions); err != nil {
		t.Fatal(err)
	}
	if customerID == nil || *customerID != "cus_original" || subscriptions != 0 {
		t.Fatalf("mismatch partially committed customer=%v subscriptions=%d",
			customerID, subscriptions)
	}
}

func TestAttributedSubscriptionOwnerMismatchRollsBackCustomerBind(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	firstUser := newBlobTestUser(t, s, "sub_attributed_owner_first")
	secondUser := newBlobTestUser(t, s, "sub_attributed_owner_second")
	subscriptionID := uid("sub_attributed_owner")
	if err := s.UpsertSubscription(
		ctx, proSubscription(firstUser, subscriptionID, 1000),
	); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertAttributedSubscription(
		ctx, uid("cus_second"), proSubscription(secondUser, subscriptionID, 2000),
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("subscription owner mismatch error=%v, want conflict", err)
	}
	var customerID *string
	if err := s.pool.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`, secondUser).
		Scan(&customerID); err != nil {
		t.Fatal(err)
	}
	if customerID != nil {
		t.Fatalf("owner mismatch bound customer=%q", *customerID)
	}
	var owner string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, subscriptionID).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != firstUser {
		t.Fatalf("owner mismatch moved subscription to %q", owner)
	}
}

func TestAttributedSubscriptionRejectsCustomerOwnedByAnotherUser(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	firstUser := newBlobTestUser(t, s, "sub_customer_owner_first")
	secondUser := newBlobTestUser(t, s, "sub_customer_owner_second")
	customerID := uid("cus_owned")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id=$2 WHERE id=$1`,
		firstUser, customerID); err != nil {
		t.Fatal(err)
	}
	sub := proSubscription(secondUser, uid("sub_customer_owner"), 1000)
	if err := s.UpsertAttributedSubscription(ctx, customerID, sub); !errors.Is(err, ErrConflict) {
		t.Fatalf("customer owner mismatch error=%v, want conflict", err)
	}
	var secondCustomer *string
	var subscriptions int
	if err := s.pool.QueryRow(ctx, `SELECT stripe_customer_id,
		(SELECT count(*) FROM user_subscriptions WHERE stripe_subscription_id=$2)
		FROM users WHERE id=$1`, secondUser, sub.StripeSubscriptionID).
		Scan(&secondCustomer, &subscriptions); err != nil {
		t.Fatal(err)
	}
	if secondCustomer != nil || subscriptions != 0 {
		t.Fatalf("customer owner mismatch partially committed customer=%v subscriptions=%d",
			secondCustomer, subscriptions)
	}
}

func TestConcurrentAttributedSubscriptionHasOneAtomicOwner(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	firstUser := newBlobTestUser(t, s, "sub_concurrent_owner_first")
	secondUser := newBlobTestUser(t, s, "sub_concurrent_owner_second")
	subscriptionID := uid("sub_concurrent_owner")
	firstCustomer := uid("cus_concurrent_first")
	secondCustomer := uid("cus_concurrent_second")

	blocker, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(ctx)
	if _, err := blocker.Exec(ctx, `LOCK TABLE user_subscriptions IN SHARE MODE`); err != nil {
		t.Fatal(err)
	}

	type result struct {
		userID     string
		customerID string
		err        error
	}
	results := make(chan result, 2)
	for _, candidate := range []struct {
		userID     string
		customerID string
	}{
		{firstUser, firstCustomer},
		{secondUser, secondCustomer},
	} {
		go func() {
			results <- result{
				userID:     candidate.userID,
				customerID: candidate.customerID,
				err: s.UpsertAttributedSubscription(
					ctx,
					candidate.customerID,
					proSubscription(candidate.userID, subscriptionID, 1000),
				),
			}
		}()
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err := blocker.QueryRow(ctx, `SELECT count(*) FROM pg_locks
			WHERE relation='user_subscriptions'::regclass
			  AND mode='RowExclusiveLock' AND NOT granted`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiting subscription inserts=%d, want 2", waiting)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	firstResult := <-results
	secondResult := <-results
	var winner, loser result
	switch {
	case firstResult.err == nil && errors.Is(secondResult.err, ErrConflict):
		winner, loser = firstResult, secondResult
	case secondResult.err == nil && errors.Is(firstResult.err, ErrConflict):
		winner, loser = secondResult, firstResult
	default:
		t.Fatalf("concurrent results: first=%v second=%v",
			firstResult.err, secondResult.err)
	}

	var ownerID string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, subscriptionID).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if ownerID != winner.userID {
		t.Fatalf("subscription owner=%q, winner=%q", ownerID, winner.userID)
	}
	for _, candidate := range []result{winner, loser} {
		var mapped *string
		if err := s.pool.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`,
			candidate.userID).Scan(&mapped); err != nil {
			t.Fatal(err)
		}
		if candidate.userID == winner.userID {
			if mapped == nil || *mapped != winner.customerID {
				t.Fatalf("winner customer=%v, want %q", mapped, winner.customerID)
			}
		} else if mapped != nil {
			t.Fatalf("loser customer=%q, want null", *mapped)
		}
	}
}

func TestStaleWebhookCannotReinstatePaidLimits(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_order")
	subID := uid("sub")

	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, 1000)); err != nil {
		t.Fatal(err)
	}
	canceled := proSubscription(user, subID, 2000)
	canceled.Status = "canceled"
	if err := s.UpsertSubscription(ctx, canceled); err != nil {
		t.Fatal(err)
	}

	// Stripe redelivers the pre-cancellation update. Without the ordering guard
	// this silently restores pro limits to a user who is no longer paying.
	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, 1500)); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("stale event was applied: got %s/%s", tier, status)
	}
}

func TestEqualSecondTerminalSubscriptionWins(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_equal_second")
	subID := uid("sub")
	const eventCreated = int64(2000)

	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, eventCreated)); err != nil {
		t.Fatal(err)
	}
	canceled := proSubscription(user, subID, eventCreated)
	canceled.Status = "canceled"
	if err := s.UpsertSubscription(ctx, canceled); err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, eventCreated)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSubscriptionPastDue(ctx, subID, eventCreated); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("equal-second event revived cancellation: got %s/%s", tier, status)
	}
}

func TestNewerFailedInvoiceCannotReviveTerminalSubscription(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_newer_failure")
	subID := uid("sub")

	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, 1_000)); err != nil {
		t.Fatal(err)
	}
	canceled := proSubscription(user, subID, 2_000)
	canceled.Status = "canceled"
	if err := s.UpsertSubscription(ctx, canceled); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSubscriptionPastDue(ctx, subID, 3_000); err != nil {
		t.Fatal(err)
	}

	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("newer failed invoice revived cancellation: got %s/%s", tier, status)
	}
	var storedStatus string
	var storedEvent int64
	if err := s.pool.QueryRow(ctx, `SELECT status,stripe_event_created
		FROM user_subscriptions WHERE stripe_subscription_id=$1`, subID).
		Scan(&storedStatus, &storedEvent); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "canceled" || storedEvent != 2_000 {
		t.Fatalf("stored subscription = %s/%d, want canceled/2000", storedStatus, storedEvent)
	}
}

func TestFailedInvoiceMarksPastDueWithoutRevokingAccess(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_pastdue")
	subID := uid("sub")

	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, 1000)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSubscriptionPastDue(ctx, subID, 1100); err != nil {
		t.Fatal(err)
	}
	tier, status := projectedPlan(t, s, user)
	// Stripe is still retrying the invoice, so entitlement continues. Cutting
	// limits here would punish a customer whose card simply needs updating.
	if tier != PlanPro || status != "past_due" {
		t.Fatalf("expected pro/past_due, got %s/%s", tier, status)
	}
	if err := s.MarkSubscriptionPastDue(ctx, uid("missing"), 1100); err != nil {
		t.Fatalf("an invoice for a subscription we do not track must be ignored, not fail: %v", err)
	}
}

func TestFailedInvoicePreservesClosedLifecycleProjection(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_pastdue_closed")
	subID := uid("sub")

	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, 1_000)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, user, false); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSubscriptionPastDue(ctx, subID, 1_100); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("closed lifecycle projected %s/%s, want free/canceled", tier, status)
	}
	var storedStatus string
	var cancellationJobs int
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT status FROM user_subscriptions WHERE stripe_subscription_id=$1),
		(SELECT count(*) FROM stripe_compensations
		 WHERE action='cancel_subscription' AND object_id=$1)`, subID).
		Scan(&storedStatus, &cancellationJobs); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "past_due" || cancellationJobs != 1 {
		t.Fatalf("stored status=%q cancellation jobs=%d", storedStatus, cancellationJobs)
	}
}

func TestSuspendedAccountRejectsSubscriptionEntitlementAndReconciliationKeepsItClosed(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_suspended")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id=$2,
		suspended_at=now(), suspended_reason='operator hold' WHERE id=$1`,
		user, "cus_suspended"); err != nil {
		t.Fatal(err)
	}
	sub := proSubscription(user, "sub_suspended", 1000)
	if err := s.UpsertSubscription(ctx, sub); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("suspended subscription projected %s/%s, want free/canceled", tier, status)
	}
	var subscriptionRows, cancellationJobs int
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM user_subscriptions WHERE user_id=$1),
		(SELECT count(*) FROM stripe_compensations
		 WHERE user_id=$1 AND action='cancel_subscription' AND object_id=$2)`,
		user, sub.StripeSubscriptionID).Scan(&subscriptionRows, &cancellationJobs); err != nil {
		t.Fatal(err)
	}
	if subscriptionRows != 1 || cancellationJobs != 1 {
		t.Fatalf("suspended subscription rows=%d cancellations=%d, want 1/1",
			subscriptionRows, cancellationJobs)
	}
	customers, err := s.ListStripeCustomers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, customer := range customers {
		if customer.UserID == user {
			if !customer.LifecycleClosed {
				t.Fatal("suspended Stripe customer was eligible for reconciliation entitlement")
			}
			return
		}
	}
	t.Fatal("suspended Stripe customer was not listed")
}

func TestReconcileAdoptsStripeAndClosesRowsStripeNoLongerReports(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_recon")
	stale := uid("sub")
	live := uid("sub")

	if err := s.UpsertSubscription(ctx, proSubscription(user, stale, 1000)); err != nil {
		t.Fatal(err)
	}
	record := proSubscription(user, live, 0)
	version, err := s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{record}, version, 1500, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("adopting a subscription we had never seen is drift")
	}
	var staleStatus string
	if err := s.pool.QueryRow(ctx,
		`SELECT status FROM user_subscriptions WHERE stripe_subscription_id=$1`, stale).
		Scan(&staleStatus); err != nil {
		t.Fatal(err)
	}
	if staleStatus != "canceled" {
		t.Fatalf("a subscription Stripe no longer reports should be closed, got %s", staleStatus)
	}

	// A second pass over unchanged state must not report drift, otherwise the
	// nightly log names every customer and drift becomes invisible.
	again := proSubscription(user, live, 0)
	version, err = s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	changed, err = s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{again}, version, 1600, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("reconciling identical state reported drift")
	}
}

func TestReconcileAuthoritativeWriteWinsEqualEventSecond(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "sub_recon_equal_second")
	record := proSubscription(userID, uid("sub"), 1_000)
	if err := s.UpsertSubscription(ctx, record); err != nil {
		t.Fatal(err)
	}

	provider := record
	periodEnd := record.CurrentPeriodEnd.Add(24 * time.Hour)
	provider.CurrentPeriodEnd = &periodEnd
	provider.CancelAtPeriodEnd = true
	version, err := s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.SyncSubscriptionsFromStripe(
		ctx, userID, []Subscription{provider}, version, 1_000, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("equal-second provider drift was reported as clean")
	}
	var storedPeriodEnd time.Time
	var cancelAtPeriodEnd bool
	if err := s.pool.QueryRow(ctx, `SELECT current_period_end, cancel_at_period_end
		FROM user_subscriptions WHERE stripe_subscription_id=$1`, record.StripeSubscriptionID).
		Scan(&storedPeriodEnd, &cancelAtPeriodEnd); err != nil {
		t.Fatal(err)
	}
	if !storedPeriodEnd.Equal(periodEnd) || !cancelAtPeriodEnd {
		t.Fatalf("provider drift persisted period_end=%v cancel_at_period_end=%v", storedPeriodEnd, cancelAtPeriodEnd)
	}

	version, err = s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	changed, err = s.SyncSubscriptionsFromStripe(
		ctx, userID, []Subscription{provider}, version, 1_000, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("identical authoritative provider state reported drift")
	}
}

func TestReconcileAuthoritativeSnapshotClosesNewerStampedMissingRow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "sub_recon_missing_newer_stamp")
	record := proSubscription(userID, uid("sub"), 3_000)
	if err := s.UpsertSubscription(ctx, record); err != nil {
		t.Fatal(err)
	}
	version, err := s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.SyncSubscriptionsFromStripe(ctx, userID, nil, version, 2_000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("missing provider subscription was reported as clean")
	}
	var status string
	var stamp int64
	if err := s.pool.QueryRow(ctx, `SELECT status, stripe_event_created
		FROM user_subscriptions WHERE stripe_subscription_id=$1`, record.StripeSubscriptionID).
		Scan(&status, &stamp); err != nil {
		t.Fatal(err)
	}
	if status != "canceled" || stamp != 3_000 {
		t.Fatalf("missing subscription status=%q stamp=%d, want canceled/3000", status, stamp)
	}
}

func TestReconcileRechecksClosedLifecycleUnderUserLock(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_recon_lifecycle_close")
	record := proSubscription(user, uid("sub"), 0)
	version, err := s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='operator hold' WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}

	changed, err := s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{record}, version, 2_000, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("closed lifecycle did not record remote subscription drift")
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("closed lifecycle projected %s/%s, want free/canceled", tier, status)
	}
	var storedStatus string
	var cancellationJobs int
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT status FROM user_subscriptions WHERE stripe_subscription_id=$1),
		(SELECT count(*) FROM stripe_compensations
		 WHERE action='cancel_subscription' AND object_id=$1)`,
		record.StripeSubscriptionID).Scan(&storedStatus, &cancellationJobs); err != nil {
		t.Fatal(err)
	}
	if storedStatus != "active" || cancellationJobs != 1 {
		t.Fatalf("stored status=%q cancellation jobs=%d", storedStatus, cancellationJobs)
	}
}

func TestClosedReconciliationWithoutSubscriptionsDoesNotReportDrift(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_recon_closed_empty")
	version, err := s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, user, false); err != nil {
		t.Fatal(err)
	}
	changed, err := s.SyncSubscriptionsFromStripe(
		ctx, user, nil, version, 2_000, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("unchanged closed account without subscriptions reported drift")
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "none" {
		t.Fatalf("closed empty account projected %s/%s, want free/none", tier, status)
	}
}

func TestReconcileReportsActiveProjectionRepairs(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	t.Run("provider has no subscription", func(t *testing.T) {
		userID := newBlobTestUser(t, s, "sub_recon_active_projection_free")
		if _, err := s.pool.Exec(ctx, `UPDATE users SET
			plan_tier='pro',subscription_status='active' WHERE id=$1`, userID); err != nil {
			t.Fatal(err)
		}
		version, err := s.SubscriptionVersion(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		changed, err := s.SyncSubscriptionsFromStripe(ctx, userID, nil, version, 2_000, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !changed {
			t.Fatal("active Free projection repair was reported as clean")
		}
		if tier, status := projectedPlan(t, s, userID); tier != PlanFree || status != SubNone {
			t.Fatalf("repaired projection=%s/%s, want free/none", tier, status)
		}
	})

	t.Run("provider subscription matches local row", func(t *testing.T) {
		userID := newBlobTestUser(t, s, "sub_recon_active_projection_pro")
		record := proSubscription(userID, uid("sub"), 1_000)
		if err := s.UpsertSubscription(ctx, record); err != nil {
			t.Fatal(err)
		}
		if _, err := s.pool.Exec(ctx, `UPDATE users SET
			plan_tier='free',subscription_status='canceled' WHERE id=$1`, userID); err != nil {
			t.Fatal(err)
		}
		version, err := s.SubscriptionVersion(ctx, userID)
		if err != nil {
			t.Fatal(err)
		}
		changed, err := s.SyncSubscriptionsFromStripe(
			ctx, userID, []Subscription{record}, version, 2_000, nil,
		)
		if err != nil {
			t.Fatal(err)
		}
		if !changed {
			t.Fatal("active Pro projection repair was reported as clean")
		}
		if tier, status := projectedPlan(t, s, userID); tier != PlanPro || status != SubActive {
			t.Fatalf("repaired projection=%s/%s, want pro/active", tier, status)
		}
	})
}

func TestDeletionCancellationRestoresReconciledProviderTruth(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_recon_delete_restore")
	version, err := s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, user, false); err != nil {
		t.Fatal(err)
	}
	record := proSubscription(user, uid("sub"), 2_000)
	if _, err := s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{record}, version, 2_000, nil,
	); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("closed lifecycle projected %s/%s, want free/canceled", tier, status)
	}
	if _, err := s.CancelAccountDeletion(ctx, user); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanPro || status != "active" {
		t.Fatalf("restored lifecycle projected %s/%s, want pro/active", tier, status)
	}
}

func TestDeletionCancellationRestoresWebhookProviderTruth(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_webhook_delete_restore")
	if _, err := s.RequestAccountDeletion(ctx, user, false); err != nil {
		t.Fatal(err)
	}
	record := proSubscription(user, uid("sub"), 2_000)
	if err := s.UpsertSubscription(ctx, record); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("closed lifecycle projected %s/%s, want free/canceled", tier, status)
	}
	if _, err := s.CancelAccountDeletion(ctx, user); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanPro || status != "active" {
		t.Fatalf("restored lifecycle projected %s/%s, want pro/active", tier, status)
	}
}

func TestReconcileRechecksRestoredLifecycleUnderUserLock(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_recon_lifecycle_restore")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),
		suspended_reason='operator hold' WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	version, err := s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=NULL,
		suspended_reason=NULL WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	record := proSubscription(user, uid("sub"), 0)

	changed, err := s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{record}, version, 2_000, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("restored lifecycle did not adopt remote subscription")
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanPro || status != "active" {
		t.Fatalf("restored lifecycle projected %s/%s, want pro/active", tier, status)
	}
	var cancellationJobs int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM stripe_compensations
		WHERE action='cancel_subscription' AND object_id=$1`,
		record.StripeSubscriptionID).Scan(&cancellationJobs); err != nil {
		t.Fatal(err)
	}
	if cancellationJobs != 0 {
		t.Fatalf("restored lifecycle enqueued %d cancellation jobs", cancellationJobs)
	}
}

func TestReconcileKeepsAllEntitlingSubscriptionsAndRejectsStaleSnapshot(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_recon_multi")
	first := proSubscription(user, uid("sub"), 1000)
	second := proSubscription(user, uid("sub"), 1000)
	if err := s.UpsertSubscription(ctx, first); err != nil {
		t.Fatal(err)
	}
	version, err := s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpsertSubscription(ctx, second); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{first, second}, version, 1500, nil,
	); !errors.Is(err, ErrReconciliationStale) {
		t.Fatalf("stale snapshot error = %v", err)
	}
	version, err = s.SubscriptionVersion(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.SyncSubscriptionsFromStripe(
		ctx, user, []Subscription{first, second}, version, 1500, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("complete live set should not cancel or rewrite either subscription")
	}
	var live int
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM user_subscriptions
		 WHERE user_id=$1 AND status IN `+entitlingStatuses, user).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 2 {
		t.Fatalf("live subscriptions=%d, want 2", live)
	}
}

func TestLapsedSubscriptionOverQuotaFreezesButNeverDeletes(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_quota")
	// The realistic path into this state: a paying user fills more than the free
	// tier, then stops paying.
	subID := uid("sub")
	if err := s.UpsertSubscription(ctx, proSubscription(user, subID, 1000)); err != nil {
		t.Fatal(err)
	}
	ws, err := s.CreateWorkspace(ctx, user, "Over quota", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateSourceReady(ctx, ws.ID, user, "big.pdf", "pdf", nil, "",
		mustPlanLimits(t, s, PlanFree).StorageBytes+1, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}

	lapsed := time.Now().Add(-2 * 24 * time.Hour).UTC()
	eventCreated := time.Now().Unix()
	ended := proSubscription(user, subID, eventCreated)
	ended.Status = "canceled"
	ended.CurrentPeriodEnd = &lapsed
	if err := s.UpsertSubscription(ctx, ended); err != nil {
		t.Fatal(err)
	}

	status, err := s.AccountAccess(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountOverQuotaGrace {
		t.Fatalf("a fresh lapse should be in grace, got %s", status.State)
	}
	if status.CanCreate() {
		t.Fatal("an over-quota account must not be able to add more data")
	}
	if !status.ShrinkOnly() {
		t.Fatal("an over-quota account must stay able to shrink, or it can never recover")
	}

	// Past the buffer the account freezes and stays frozen. Nothing is deleted.
	longLapsed := time.Now().AddDate(0, 0, -(overQuotaBufferDays + 1)).UTC()
	ended.CurrentPeriodEnd = &longLapsed
	ended.StripeEventCreated = eventCreated + 1
	if err := s.UpsertSubscription(ctx, ended); err != nil {
		t.Fatal(err)
	}
	status, err = s.AccountAccess(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountOverQuotaFrozen {
		t.Fatalf("expected frozen after the buffer, got %s", status.State)
	}
	var files int
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM files WHERE workspace_id=$1`, ws.ID).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if files != 1 {
		t.Fatalf("freezing must not destroy content, found %d files", files)
	}
}

func TestExpiredPaidPeriodAppliesFreeLimitsBeforeWebhookProjection(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_stale_projection")
	workspace, err := s.CreateWorkspace(ctx, user, "Stale plan", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	periodEnd := time.Now().Add(-time.Minute).UTC()
	if _, err := s.pool.Exec(ctx, `UPDATE users SET plan_tier='pro',
		subscription_status='active' WHERE id=$1`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id, user_id, status, plan_tier,
		 current_period_end, stripe_event_created)
		VALUES ($1,$2,'active','pro',$3,1)`, uid("sub"), user, periodEnd); err != nil {
		t.Fatal(err)
	}

	ownerTier, err := s.WorkspaceOwnerPlan(ctx, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ownerTier != PlanFree {
		t.Fatalf("workspace owner tier=%s, want free after period end", ownerTier)
	}
	usage, err := s.StorageUsage(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if usage.PlanTier != PlanFree || usage.LimitBytes != mustPlanLimits(t, s, PlanFree).StorageBytes {
		t.Fatalf("storage tier=%s limit=%d", usage.PlanTier, usage.LimitBytes)
	}
	credits, err := s.CreditBalance(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if credits.PlanTier != PlanFree || credits.LimitMicros != mustPlanLimits(t, s, PlanFree).CreditMicros {
		t.Fatalf("credits tier=%s limit=%d", credits.PlanTier, credits.LimitMicros)
	}
	gotWorkspace, err := s.GetWorkspace(ctx, user, workspace.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if gotWorkspace.OwnerPlanTier != PlanFree ||
		gotWorkspace.FilesLimit != mustPlanLimits(t, s, PlanFree).FilesPerWorkspace {
		t.Fatalf("workspace tier=%s file limit=%d after expiry",
			gotWorkspace.OwnerPlanTier, gotWorkspace.FilesLimit)
	}
	if sub, err := s.SubscriptionForUser(ctx, user); err != nil {
		t.Fatal(err)
	} else if sub != nil {
		t.Fatalf("expired subscription still grants entitlement: %#v", sub)
	}
	me, err := s.Me(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if me.PlanTier != PlanFree || me.SubscriptionStatus != SubCanceled {
		t.Fatalf("me reports %s/%s after expiry", me.PlanTier, me.SubscriptionStatus)
	}
	billing, err := s.GetBilling(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if billing.PlanTier != PlanFree || billing.SubscriptionStatus != SubCanceled {
		t.Fatalf("billing reports %s/%s after expiry",
			billing.PlanTier, billing.SubscriptionStatus)
	}
}

func TestCurrentFreeSubscriptionBeatsExpiredProSubscription(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_live_free_expired_pro")
	expired := time.Now().Add(-time.Hour).UTC()
	current := time.Now().Add(time.Hour).UTC()
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id, user_id, status, plan_tier,
		 current_period_end, stripe_event_created)
		VALUES ($1,$3,'active','pro',$4,1),
		       ($2,$3,'active','free',$5,1)`,
		uid("sub"), uid("sub"), user, expired, current); err != nil {
		t.Fatal(err)
	}
	tier, err := s.effectivePlanTierForUser(ctx, s.pool, user)
	if err != nil {
		t.Fatal(err)
	}
	if tier != PlanFree {
		t.Fatalf("effective tier=%s, want current free subscription", tier)
	}
	sub, err := s.SubscriptionForUser(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if sub == nil || sub.PlanTier != PlanFree {
		t.Fatalf("entitling subscription=%#v, want current free", sub)
	}

	workspace, err := s.CreateWorkspace(ctx, user, "Live Free after Pro", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(
		ctx, workspace.ID, user, "over-free.pdf", "pdf", nil, "", 1, "sources/"+uid("blob"),
	)
	if err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).StorageBytes
	if _, err := s.pool.Exec(ctx, `UPDATE files SET size_bytes=$2 WHERE id=$1`,
		file.ID, freeLimit+1); err != nil {
		t.Fatal(err)
	}
	status, err := s.AccountAccess(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountOverQuotaGrace || status.PlanTier != PlanFree {
		t.Fatalf("live Free after paid lapse state=%s tier=%s, want grace/free",
			status.State, status.PlanTier)
	}

	longExpired := time.Now().AddDate(0, 0, -(overQuotaBufferDays + 1)).UTC()
	if _, err := s.pool.Exec(ctx, `UPDATE user_subscriptions
		SET current_period_end=$2 WHERE user_id=$1 AND plan_tier='pro'`,
		user, longExpired); err != nil {
		t.Fatal(err)
	}
	status, err = s.AccountAccess(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != AccountOverQuotaFrozen || status.PlanTier != PlanFree {
		t.Fatalf("old paid lapse state=%s tier=%s, want frozen/free",
			status.State, status.PlanTier)
	}
}

func TestOverQuotaNoticesIncludeLiveFreeAfterPaidLapse(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_live_free_notices")
	expired := time.Now().Add(-time.Hour).UTC().Truncate(time.Second)
	current := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id, user_id, status, plan_tier,
		 current_period_end, stripe_event_created)
		VALUES ($1,$3,'active','pro',$4,1),
		       ($2,$3,'active','free',$5,1)`,
		uid("sub"), uid("sub"), user, expired, current); err != nil {
		t.Fatal(err)
	}
	workspace, err := s.CreateWorkspace(ctx, user, "Notice workspace", ColorGreen, nil)
	if err != nil {
		t.Fatal(err)
	}
	file, err := s.CreateSourceReady(
		ctx, workspace.ID, user, "over-free.pdf", "pdf", nil, "", 1, "sources/"+uid("blob"),
	)
	if err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).StorageBytes
	if _, err := s.pool.Exec(ctx, `UPDATE files SET size_bytes=$2 WHERE id=$1`,
		file.ID, freeLimit+1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SweepOverQuotaNotices(ctx); err != nil {
		t.Fatal(err)
	}
	var started bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM lifecycle_notices
		WHERE user_id=$1 AND kind=$2)`, user, lifecycleNoticeStarted).Scan(&started); err != nil {
		t.Fatal(err)
	}
	if !started {
		t.Fatal("live Free row suppressed the paid-lapse grace notice")
	}

	longExpired := time.Now().AddDate(0, 0, -(overQuotaBufferDays + 1)).UTC().Truncate(time.Second)
	if _, err := s.pool.Exec(ctx, `UPDATE user_subscriptions
		SET current_period_end=$2 WHERE user_id=$1 AND plan_tier='pro'`,
		user, longExpired); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SweepOverQuotaNotices(ctx); err != nil {
		t.Fatal(err)
	}
	var frozen bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM lifecycle_notices
		WHERE user_id=$1 AND kind=$2)`, user, lifecycleNoticeFrozen).Scan(&frozen); err != nil {
		t.Fatal(err)
	}
	if !frozen {
		t.Fatal("live Free row suppressed the paid-lapse frozen notice")
	}
}

func TestLifecycleNoticeRechecksCurrentAccountState(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_notice_recheck")
	periodEnd := time.Now().Add(-24 * time.Hour).UTC()
	sent, err := s.sendLifecycleNotice(
		ctx,
		user,
		"notice@example.test",
		"en",
		lifecycleNoticeStarted,
		periodEnd,
		AccountStatus{UserID: user, State: AccountOverQuotaGrace},
	)
	if err != nil {
		t.Fatal(err)
	}
	if sent {
		t.Fatal("active account received a stale over-quota notice")
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM lifecycle_notices
		WHERE user_id=$1`, user).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("stale lifecycle notice rows=%d, want 0", count)
	}
}

func TestUpsertingExpiredEntitlementProjectsFree(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	user := newBlobTestUser(t, s, "sub_expired_upsert")
	expired := proSubscription(user, uid("sub"), 1000)
	periodEnd := time.Now().Add(-time.Minute).UTC()
	expired.CurrentPeriodEnd = &periodEnd
	if err := s.UpsertSubscription(ctx, expired); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, user); tier != PlanFree || status != "canceled" {
		t.Fatalf("expired active row projected %s/%s, want free/canceled", tier, status)
	}
}

func TestSubscriptionUpsertRejectsOwnerChange(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	firstUser := newBlobTestUser(t, s, "sub_owner_first")
	secondUser := newBlobTestUser(t, s, "sub_owner_second")
	subscriptionID := uid("sub_owner")
	if err := s.UpsertSubscription(
		ctx, proSubscription(firstUser, subscriptionID, 1000),
	); err != nil {
		t.Fatal(err)
	}
	conflicting := proSubscription(secondUser, subscriptionID, 2000)
	conflicting.Status = "canceled"
	if err := s.UpsertSubscription(ctx, conflicting); !errors.Is(err, ErrConflict) {
		t.Fatalf("owner-changing upsert error=%v, want conflict", err)
	}
	var owner, status string
	if err := s.pool.QueryRow(ctx, `SELECT user_id,status FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, subscriptionID).Scan(&owner, &status); err != nil {
		t.Fatal(err)
	}
	if owner != firstUser || status != "active" {
		t.Fatalf("conflicting upsert changed subscription to owner=%q status=%q", owner, status)
	}
	if tier, _ := projectedPlan(t, s, secondUser); tier != PlanFree {
		t.Fatalf("conflicting upsert projected second user to %s", tier)
	}
}
