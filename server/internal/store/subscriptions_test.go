package store

import (
	"context"
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
	canceled.PlanTier = PlanFree
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
	changed, err := s.SyncSubscriptionsFromStripe(ctx, user, &record)
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
	changed, err = s.SyncSubscriptionsFromStripe(ctx, user, &again)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Fatal("reconciling identical state reported drift")
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
		FreeStorageLimitBytes+1, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}

	lapsed := time.Now().Add(-2 * 24 * time.Hour).UTC()
	ended := proSubscription(user, subID, 2000)
	ended.Status = "canceled"
	ended.PlanTier = PlanFree
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
	ended.StripeEventCreated = 3000
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
