package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// user_subscriptions is the record of what Stripe told us; users.plan_tier and
// users.subscription_status are a denormalized projection of it, kept only so the
// storage gate can read entitlement without a join. Every write goes through
// UpsertSubscription so the projection cannot drift.

// Subscription is one Stripe subscription as we track it.
type Subscription struct {
	StripeSubscriptionID string     `json:"stripeSubscriptionId"`
	UserID               string     `json:"userId"`
	Status               string     `json:"status"`
	PriceID              string     `json:"priceId"`
	PlanTier             PlanTier   `json:"planTier"`
	CurrentPeriodEnd     *time.Time `json:"currentPeriodEnd,omitempty"`
	CancelAtPeriodEnd    bool       `json:"cancelAtPeriodEnd"`
	CanceledAt           *time.Time `json:"canceledAt,omitempty"`
	EndedAt              *time.Time `json:"endedAt,omitempty"`
	// StripeEventCreated is the `created` timestamp of the event that produced
	// this state, in unix seconds. It is the ordering guard.
	StripeEventCreated int64 `json:"-"`
}

// entitlingStatuses are the Stripe statuses that still grant paid limits.
// past_due is included deliberately: Stripe keeps retrying the invoice and the
// customer has not lost access yet. When it gives up it sends
// customer.subscription.deleted, and the status becomes canceled.
const entitlingStatuses = `('active','trialing','past_due')`

var ErrReconciliationStale = errors.New("reconciliation snapshot changed")

type SubscriptionVersion struct {
	Count     int64
	UpdatedAt time.Time
}

func lockSubscriptionUserTx(ctx context.Context, tx pgx.Tx, userID string) error {
	var locked string
	err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID).
		Scan(&locked)
	if isNoRows(err) {
		return ErrNotFound
	}
	return err
}

// UpsertSubscription records subscription state from a Stripe webhook and
// re-derives the user's projected tier, in one transaction.
//
// Stale events are dropped. Stripe does not guarantee delivery order, so without
// the stripe_event_created guard a redelivered `customer.subscription.updated`
// from before a cancellation would silently reinstate paid limits.
func (s *Store) UpsertSubscription(ctx context.Context, sub Subscription) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := lockSubscriptionUserTx(ctx, tx, sub.UserID); err != nil {
		return err
	}
	changed, err := upsertSubscriptionTx(ctx, tx, sub)
	if err != nil {
		return err
	}
	if !changed {
		// The stored row came from a newer event. Nothing to do, and in
		// particular the projection must not be recomputed from this event.
		return nil
	}
	if err := s.deriveUserPlanTx(ctx, tx, sub.UserID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// upsertSubscriptionTx writes the row and reports whether it won the ordering
// guard. It does not touch the projection; callers do that once.
func upsertSubscriptionTx(ctx context.Context, tx pgx.Tx, sub Subscription) (bool, error) {
	tag, err := tx.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id, user_id, status, price_id, plan_tier,
		 current_period_end, cancel_at_period_end, canceled_at, ended_at,
		 stripe_event_created)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (stripe_subscription_id) DO UPDATE SET
			status = excluded.status,
			price_id = excluded.price_id,
			plan_tier = excluded.plan_tier,
			current_period_end = excluded.current_period_end,
			cancel_at_period_end = excluded.cancel_at_period_end,
			canceled_at = excluded.canceled_at,
			ended_at = excluded.ended_at,
			stripe_event_created = excluded.stripe_event_created,
			updated_at = now()
		WHERE excluded.stripe_event_created >= user_subscriptions.stripe_event_created`,
		sub.StripeSubscriptionID, sub.UserID, sub.Status, sub.PriceID, sub.PlanTier,
		sub.CurrentPeriodEnd, sub.CancelAtPeriodEnd, sub.CanceledAt, sub.EndedAt,
		sub.StripeEventCreated)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// deriveUserPlanTx recomputes users.plan_tier and users.subscription_status from
// the subscription rows. Pro wins over free when a user somehow holds two live
// subscriptions, because charging for the higher tier and serving the lower one
// is the one failure mode worth ruling out.
func (s *Store) deriveUserPlanTx(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `WITH live AS (
			SELECT plan_tier, status
			FROM user_subscriptions
			WHERE user_id = $1 AND status IN `+entitlingStatuses+`
			ORDER BY (plan_tier = 'pro') DESC, current_period_end DESC NULLS LAST
			LIMIT 1
		)
		UPDATE users SET
			plan_tier = COALESCE((SELECT plan_tier FROM live), 'free'),
			subscription_status = COALESCE(
				(SELECT status FROM live),
				-- No live subscription: distinguish somebody who cancelled from
				-- somebody who never subscribed, because the lapse notifications
				-- only make sense for the former.
				(SELECT 'canceled' FROM user_subscriptions WHERE user_id = $1 LIMIT 1),
				'none'
			),
			updated_at = now()
		WHERE id = $1`, userID)
	return err
}

// MarkSubscriptionPastDue records a failed invoice. Stripe sends
// invoice.payment_failed before it gives up on the subscription, so this is the
// first point at which a lapse is predictable rather than already happened.
func (s *Store) MarkSubscriptionPastDue(
	ctx context.Context,
	stripeSubscriptionID string,
	eventCreated int64,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var userID string
	err = tx.QueryRow(ctx, `
		SELECT user_id FROM user_subscriptions
		 WHERE stripe_subscription_id = $1`, stripeSubscriptionID).Scan(&userID)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return err
	}
	err = tx.QueryRow(ctx, `UPDATE user_subscriptions
		SET status = 'past_due',
		    stripe_event_created = greatest(stripe_event_created, $2),
		    updated_at = now()
		WHERE stripe_subscription_id = $1 AND stripe_event_created <= $2
		RETURNING user_id`, stripeSubscriptionID, eventCreated).Scan(&userID)
	if isNoRows(err) {
		// Either unknown to us, or superseded by a newer event.
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.deriveUserPlanTx(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SubscriptionForUser returns the subscription currently granting entitlement, or
// nil. Used by the billing read and by the deletion preconditions.
func (s *Store) SubscriptionForUser(ctx context.Context, userID string) (*Subscription, error) {
	sub := Subscription{UserID: userID}
	err := s.pool.QueryRow(ctx, `SELECT stripe_subscription_id, status, price_id,
			plan_tier, current_period_end, cancel_at_period_end, canceled_at, ended_at
		FROM user_subscriptions
		WHERE user_id = $1 AND status IN `+entitlingStatuses+`
		ORDER BY (plan_tier = 'pro') DESC, current_period_end DESC NULLS LAST
		LIMIT 1`, userID).
		Scan(&sub.StripeSubscriptionID, &sub.Status, &sub.PriceID, &sub.PlanTier,
			&sub.CurrentPeriodEnd, &sub.CancelAtPeriodEnd, &sub.CanceledAt, &sub.EndedAt)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &sub, nil
}

// UserIDBySubscription resolves the owner of a Stripe subscription id, for events
// that carry the subscription but not the customer.
func (s *Store) UserIDBySubscription(ctx context.Context, subscriptionID string) (string, error) {
	var userID string
	err := s.pool.QueryRow(ctx,
		`SELECT user_id FROM user_subscriptions WHERE stripe_subscription_id=$1`,
		subscriptionID).Scan(&userID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return userID, err
}

func (s *Store) SubscriptionVersion(
	ctx context.Context,
	userID string,
) (SubscriptionVersion, error) {
	var version SubscriptionVersion
	err := s.pool.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(updated_at), 'epoch'::timestamptz)
		  FROM user_subscriptions WHERE user_id=$1`, userID).
		Scan(&version.Count, &version.UpdatedAt)
	return version, err
}

// SyncSubscriptionsFromStripe makes our rows match a complete live read of
// Stripe's entitling subscriptions. observed is captured immediately before
// the provider read. If a webhook commits during that read, the compare-and-
// swap fails and the caller retries instead of overwriting newer state.
//
// It returns whether anything actually differed, so the caller can log real drift
// instead of every user every night.
func (s *Store) SyncSubscriptionsFromStripe(
	ctx context.Context,
	userID string,
	live []Subscription,
	observed SubscriptionVersion,
	authoritativeAt int64,
	run *ReconcileRun,
) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)

	if run != nil {
		if err := assertReconciliationLeaseTx(ctx, tx, *run); err != nil {
			return false, err
		}
	}
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return false, err
	}
	var current SubscriptionVersion
	if err := tx.QueryRow(ctx, `
		SELECT count(*), COALESCE(max(updated_at), 'epoch'::timestamptz)
		  FROM user_subscriptions WHERE user_id=$1`, userID).
		Scan(&current.Count, &current.UpdatedAt); err != nil {
		return false, err
	}
	if current.Count != observed.Count || !current.UpdatedAt.Equal(observed.UpdatedAt) {
		return false, ErrReconciliationStale
	}

	changed := false
	keep := make([]string, 0, len(live))
	for i := range live {
		subscription := &live[i]
		keep = append(keep, subscription.StripeSubscriptionID)
		// Drift is decided by comparing the material fields, not by whether the
		// upsert touched a row: the upsert always advances the event stamp, so it
		// always reports a write.
		var stored Subscription
		err := tx.QueryRow(ctx, `SELECT status, price_id, plan_tier, current_period_end,
				cancel_at_period_end
			FROM user_subscriptions WHERE stripe_subscription_id = $1`,
			subscription.StripeSubscriptionID).
			Scan(&stored.Status, &stored.PriceID, &stored.PlanTier,
				&stored.CurrentPeriodEnd, &stored.CancelAtPeriodEnd)
		switch {
		case isNoRows(err):
			changed = true
		case err != nil:
			return false, err
		default:
			changed = changed ||
				stored.Status != subscription.Status ||
				stored.PriceID != subscription.PriceID ||
				stored.PlanTier != subscription.PlanTier ||
				stored.CancelAtPeriodEnd != subscription.CancelAtPeriodEnd ||
				!sameInstant(stored.CurrentPeriodEnd, subscription.CurrentPeriodEnd)
		}
		subscription.UserID = userID
		subscription.StripeEventCreated = authoritativeAt
		if _, err := upsertSubscriptionTx(ctx, tx, *subscription); err != nil {
			return false, err
		}
	}
	// Anything else we still believe is live has been cancelled behind our back,
	// most likely by a webhook we never received.
	tag, err := tx.Exec(ctx, `UPDATE user_subscriptions
		SET status = 'canceled',
		    ended_at = COALESCE(ended_at, now()),
		    stripe_event_created = greatest(stripe_event_created, $3),
		    updated_at = now()
		WHERE user_id = $1
		  AND NOT (stripe_subscription_id = ANY($2))
		  AND stripe_event_created <= $3
		  AND status IN `+entitlingStatuses,
		userID, keep, authoritativeAt)
	if err != nil {
		return false, err
	}
	changed = changed || tag.RowsAffected() > 0
	if err := s.deriveUserPlanTx(ctx, tx, userID); err != nil {
		return false, err
	}
	return changed, tx.Commit(ctx)
}

func sameInstant(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
