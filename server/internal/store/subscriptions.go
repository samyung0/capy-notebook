package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// user_subscriptions is the record of what Stripe told us; users.plan_tier and
// users.subscription_status are a denormalized projection of it, kept only so the
// storage gate can read entitlement without a join. Webhooks write through
// UpsertSubscription; a completed cancellation compensation records its
// confirmed provider transition and reprojects in the same transaction.

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

func subscriptionEntitles(status string) bool {
	return status == "active" || status == "trialing" || status == "past_due"
}

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
	return s.upsertAttributedSubscription(ctx, "", sub)
}

// UpsertAttributedSubscription binds a subscription event's customer identity
// and applies its ordered subscription state in one user-lifecycle transaction.
func (s *Store) UpsertAttributedSubscription(
	ctx context.Context,
	customerID string,
	sub Subscription,
) error {
	return s.upsertAttributedSubscription(ctx, customerID, sub)
}

func (s *Store) upsertAttributedSubscription(
	ctx context.Context,
	customerID string,
	sub Subscription,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := lockSubscriptionUserTx(ctx, tx, sub.UserID); err != nil {
		return err
	}
	var mappedCustomer *string
	var deletionRequestedAt, deletedAt, suspendedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT stripe_customer_id,
		deletion_requested_at,deleted_at,suspended_at
		FROM users WHERE id=$1`, sub.UserID).Scan(
		&mappedCustomer, &deletionRequestedAt, &deletedAt, &suspendedAt,
	); err != nil {
		return err
	}
	if customerID != "" && mappedCustomer != nil &&
		*mappedCustomer != "" && *mappedCustomer != customerID {
		return ErrConflict
	}

	var existingUserID string
	err = tx.QueryRow(ctx, `SELECT user_id FROM user_subscriptions
		WHERE stripe_subscription_id=$1 FOR UPDATE`, sub.StripeSubscriptionID).
		Scan(&existingUserID)
	if err != nil && !isNoRows(err) {
		return err
	}
	if err == nil && existingUserID != sub.UserID {
		return ErrConflict
	}
	if customerID != "" {
		if _, err := tx.Exec(ctx, `UPDATE users SET
			stripe_customer_id=COALESCE(stripe_customer_id,$2),updated_at=now()
			WHERE id=$1`, sub.UserID, customerID); err != nil {
			if isUniqueViolation(err) {
				return ErrConflict
			}
			return err
		}
	}
	closed := deletionRequestedAt != nil || deletedAt != nil || suspendedAt != nil
	changed, err := upsertSubscriptionTx(ctx, tx, sub)
	if err != nil {
		return err
	}
	if !changed {
		var ownerID string
		if err := tx.QueryRow(ctx, `SELECT user_id FROM user_subscriptions
			WHERE stripe_subscription_id=$1 FOR UPDATE`, sub.StripeSubscriptionID).
			Scan(&ownerID); err != nil {
			return err
		}
		if ownerID != sub.UserID {
			return ErrConflict
		}
		// The stored row came from a newer event. Nothing to do, and in
		// particular the projection must not be recomputed from this event. The
		// customer bind may still be new, so commit that identity repair.
		return tx.Commit(ctx)
	}
	if closed && subscriptionEntitles(sub.Status) && !sub.CancelAtPeriodEnd {
		if err := enqueueStripeCompensationTx(
			ctx, tx, sub.UserID, StripeCancelSubscription, sub.StripeSubscriptionID,
		); err != nil {
			return err
		}
	}
	if closed {
		if err := s.projectClosedUserPlanTx(ctx, tx, sub.UserID); err != nil {
			return err
		}
		return tx.Commit(ctx)
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
			plan_tier = CASE
				WHEN excluded.status NOT IN `+entitlingStatuses+`
					AND user_subscriptions.plan_tier='pro'
				THEN user_subscriptions.plan_tier
				ELSE excluded.plan_tier
			END,
			current_period_end = excluded.current_period_end,
			cancel_at_period_end = excluded.cancel_at_period_end,
			canceled_at = excluded.canceled_at,
			ended_at = excluded.ended_at,
			stripe_event_created = excluded.stripe_event_created,
			updated_at = now()
		WHERE user_subscriptions.user_id = excluded.user_id
		  AND (excluded.stripe_event_created > user_subscriptions.stripe_event_created
			OR (
				excluded.stripe_event_created = user_subscriptions.stripe_event_created
				AND excluded.status NOT IN `+entitlingStatuses+`
				AND user_subscriptions.status IN `+entitlingStatuses+`
			))`,
		sub.StripeSubscriptionID, sub.UserID, sub.Status, sub.PriceID, sub.PlanTier,
		sub.CurrentPeriodEnd, sub.CancelAtPeriodEnd, sub.CanceledAt, sub.EndedAt,
		sub.StripeEventCreated)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// reconcileSubscriptionTx applies a complete provider read after the caller's
// subscription-version check. Unlike webhook ordering, the provider read is
// authoritative even when its start second ties the stored event second. Keep
// the greatest event stamp so an older webhook still cannot undo the result.
func reconcileSubscriptionTx(
	ctx context.Context,
	tx pgx.Tx,
	sub Subscription,
) (bool, error) {
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
			stripe_event_created = greatest(
				user_subscriptions.stripe_event_created,
				excluded.stripe_event_created
			),
			updated_at = now()
		WHERE user_subscriptions.user_id = excluded.user_id
		  AND (user_subscriptions.status,
		       user_subscriptions.price_id,
		       user_subscriptions.plan_tier,
		       user_subscriptions.current_period_end,
		       user_subscriptions.cancel_at_period_end,
		       user_subscriptions.canceled_at,
		       user_subscriptions.ended_at)
		      IS DISTINCT FROM
		      (excluded.status,
		       excluded.price_id,
		       excluded.plan_tier,
		       excluded.current_period_end,
		       excluded.cancel_at_period_end,
		       excluded.canceled_at,
		       excluded.ended_at)`,
		sub.StripeSubscriptionID, sub.UserID, sub.Status, sub.PriceID, sub.PlanTier,
		sub.CurrentPeriodEnd, sub.CancelAtPeriodEnd, sub.CanceledAt, sub.EndedAt,
		sub.StripeEventCreated)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() > 0 {
		return true, nil
	}
	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT user_id FROM user_subscriptions
		WHERE stripe_subscription_id=$1`, sub.StripeSubscriptionID).Scan(&ownerID); err != nil {
		return false, err
	}
	if ownerID != sub.UserID {
		return false, ErrConflict
	}
	return false, nil
}

// deriveUserPlanTx recomputes users.plan_tier and users.subscription_status from
// the subscription rows. Pro wins over free when a user somehow holds two live
// subscriptions, because charging for the higher tier and serving the lower one
// is the one failure mode worth ruling out. With no subscription rows, the
// stored tier/status remain canonical for fixtures and manual provisioning.
func (s *Store) deriveUserPlanTx(ctx context.Context, tx pgx.Tx, userID string) error {
	_, err := tx.Exec(ctx, `WITH live AS (
			SELECT plan_tier, status
			FROM user_subscriptions
			WHERE user_id = $1 AND status IN `+entitlingStatuses+`
			  AND (current_period_end IS NULL OR current_period_end > now())
			ORDER BY (plan_tier = 'pro') DESC, current_period_end DESC NULLS LAST
			LIMIT 1
		)
		UPDATE users SET
			plan_tier = CASE
				WHEN EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=$1)
					THEN COALESCE((SELECT plan_tier FROM live), 'free')
				ELSE plan_tier
			END,
			subscription_status = CASE
				WHEN EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=$1)
					THEN COALESCE((SELECT status FROM live), 'canceled')
				ELSE subscription_status
			END,
			updated_at = now()
		WHERE id = $1`, userID)
	if err != nil {
		return err
	}
	var tier PlanTier
	if err := tx.QueryRow(ctx, `SELECT plan_tier FROM users WHERE id=$1`, userID).Scan(&tier); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if tier != PlanFree {
		return nil
	}
	return s.pruneUserMaterialRevisionsTx(ctx, tx, userID)
}

// projectEmptyProviderSnapshotTx is used only after Stripe authoritatively
// returns no live subscription for an active account. Unlike deriveUserPlanTx,
// that external evidence is allowed to replace a no-row stored tier.
func (s *Store) projectEmptyProviderSnapshotTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
) error {
	tag, err := tx.Exec(ctx, `UPDATE users SET
		plan_tier='free',
		subscription_status=CASE
			WHEN EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=$1)
				THEN 'canceled'
			ELSE 'none'
		END,
		updated_at=now()
		WHERE id=$1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return s.pruneUserMaterialRevisionsTx(ctx, tx, userID)
}

// projectClosedUserPlanTx keeps Stripe's provider truth in
// user_subscriptions while the lifecycle gate denies local access. Provider
// rows force the denormalized projection to Free; with no rows, the stored tier
// remains canonical for retention. A later support restore can immediately
// derive the live plan from preserved provider rows.
func (s *Store) projectClosedUserPlanTx(ctx context.Context, tx pgx.Tx, userID string) error {
	effectiveTier, err := s.effectivePlanTierForUser(ctx, tx, userID)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE users SET
		plan_tier=CASE
			WHEN EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=$1)
				THEN 'free'
			ELSE plan_tier
		END,
		subscription_status=CASE
			WHEN EXISTS(SELECT 1 FROM user_subscriptions WHERE user_id=$1)
				THEN 'canceled'
			ELSE subscription_status
		END,
		updated_at=now()
		WHERE id=$1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	if effectiveTier == PlanPro {
		return nil
	}
	return s.pruneUserMaterialRevisionsTx(ctx, tx, userID)
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
	var deletionRequestedAt, deletedAt, suspendedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT deletion_requested_at,deleted_at,suspended_at
		FROM users WHERE id=$1`, userID).Scan(
		&deletionRequestedAt, &deletedAt, &suspendedAt,
	); err != nil {
		return err
	}
	closed := deletionRequestedAt != nil || deletedAt != nil || suspendedAt != nil
	var cancelAtPeriodEnd bool
	err = tx.QueryRow(ctx, `UPDATE user_subscriptions
		SET status = 'past_due',
		    stripe_event_created = greatest(stripe_event_created, $2),
		    updated_at = now()
		WHERE stripe_subscription_id = $1
		  AND status IN `+entitlingStatuses+`
		  AND stripe_event_created <= $2
		RETURNING user_id,cancel_at_period_end`, stripeSubscriptionID, eventCreated).
		Scan(&userID, &cancelAtPeriodEnd)
	if isNoRows(err) {
		// Either unknown to us, or superseded by a newer event.
		return nil
	}
	if err != nil {
		return err
	}
	if closed && !cancelAtPeriodEnd {
		if err := enqueueStripeCompensationTx(
			ctx, tx, userID, StripeCancelSubscription, stripeSubscriptionID,
		); err != nil {
			return err
		}
	}
	if closed {
		if err := s.projectClosedUserPlanTx(ctx, tx, userID); err != nil {
			return err
		}
	} else if err := s.deriveUserPlanTx(ctx, tx, userID); err != nil {
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
			AND (current_period_end IS NULL OR current_period_end > now())
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
	var deletionRequestedAt, deletedAt, suspendedAt *time.Time
	var projectedTier PlanTier
	var projectedStatus SubscriptionStatus
	if err := tx.QueryRow(ctx, `SELECT deletion_requested_at, deleted_at, suspended_at,
		plan_tier, subscription_status
		FROM users WHERE id=$1`, userID).Scan(
		&deletionRequestedAt, &deletedAt, &suspendedAt,
		&projectedTier, &projectedStatus,
	); err != nil {
		return false, err
	}
	lifecycleClosed := deletionRequestedAt != nil || deletedAt != nil || suspendedAt != nil
	if lifecycleClosed {
		for i := range live {
			if !live[i].CancelAtPeriodEnd {
				if err := enqueueStripeCompensationTx(
					ctx,
					tx,
					userID,
					StripeCancelSubscription,
					live[i].StripeSubscriptionID,
				); err != nil {
					return false, err
				}
			}
		}
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
		subscription.UserID = userID
		subscription.StripeEventCreated = authoritativeAt
		wrote, err := reconcileSubscriptionTx(ctx, tx, *subscription)
		if err != nil {
			return false, err
		}
		changed = changed || wrote
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
		  AND status IN `+entitlingStatuses,
		userID, keep, authoritativeAt)
	if err != nil {
		return false, err
	}
	changed = changed || tag.RowsAffected() > 0
	if lifecycleClosed {
		if err := s.projectClosedUserPlanTx(ctx, tx, userID); err != nil {
			return false, err
		}
	} else if len(live) == 0 {
		if err := s.projectEmptyProviderSnapshotTx(ctx, tx, userID); err != nil {
			return false, err
		}
	} else if err := s.deriveUserPlanTx(ctx, tx, userID); err != nil {
		return false, err
	}
	var repairedTier PlanTier
	var repairedStatus SubscriptionStatus
	if err := tx.QueryRow(ctx, `SELECT plan_tier,subscription_status
		FROM users WHERE id=$1`, userID).Scan(&repairedTier, &repairedStatus); err != nil {
		return false, err
	}
	changed = changed || projectedTier != repairedTier || projectedStatus != repairedStatus
	return changed, tx.Commit(ctx)
}
