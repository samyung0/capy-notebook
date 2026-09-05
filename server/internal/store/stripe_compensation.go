package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

type StripeCompensationAction string

const (
	StripeRecoverCheckout    StripeCompensationAction = "recover_checkout"
	StripeExpireCheckout     StripeCompensationAction = "expire_checkout"
	StripeCancelSubscription StripeCompensationAction = "cancel_subscription"
	StripeRefundPayment      StripeCompensationAction = "refund_payment_intent"
	StripeRefundCharge       StripeCompensationAction = "refund_charge"
)

type StripeCheckoutRecovery struct {
	ID         string
	UserID     string
	CustomerID string
	Email      string
	Name       string
	PriceID    string
	SuccessURL string
	CancelURL  string
}

type StripeCompensation struct {
	ID               int64
	UserID           string
	Action           StripeCompensationAction
	ObjectID         string
	Attempts         int
	Generation       int
	ProviderResultID string
	LeaseToken       string
}

func enqueueStripeCompensationTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	action StripeCompensationAction,
	objectID string,
) error {
	if objectID == "" {
		return nil
	}
	// A newly observed live subscription is stronger evidence than an older
	// completed/suppressed cancellation job. Reopen only that idempotent action;
	// refund generations must retain their terminal history.
	_, err := tx.Exec(ctx, `INSERT INTO stripe_compensations
		(user_id, action, object_id) VALUES ($1,$2,$3)
		ON CONFLICT (action, object_id) DO UPDATE SET
			status='pending',attempts=0,lease_token=NULL,lease_expires_at=NULL,
			provider_started_at=NULL,next_attempt_at=now(),last_error='',
			completed_at=NULL,updated_at=now()
		WHERE excluded.action='cancel_subscription'
		  AND stripe_compensations.status IN ('succeeded','suppressed')`,
		userID, action, objectID)
	return err
}

func (s *Store) EnqueueStripeCompensation(
	ctx context.Context,
	userID string,
	action StripeCompensationAction,
	objectID string,
) error {
	if objectID == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO stripe_compensations
		(user_id, action, object_id) VALUES ($1,$2,$3)
		ON CONFLICT (action, object_id) DO NOTHING`, userID, action, objectID)
	return err
}

// ReserveStripeCheckout commits a per-user creation slot before any Stripe
// request. Its delayed recovery job can replay the provider calls with the same
// idempotency key if the process dies after Stripe creates a session but before
// the provider id is bound locally.
func (s *Store) ReserveStripeCheckout(
	ctx context.Context,
	userID, customerID, priceID, successURL, cancelURL string,
) (string, AccountStatus, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", AccountStatus{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return "", AccountStatus{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE stripe_checkout_sessions SET
		status='expired',updated_at=now()
		WHERE user_id=$1 AND status='open' AND expires_at<=now()`, userID); err != nil {
		return "", AccountStatus{}, err
	}
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return "", AccountStatus{}, err
	}
	if !status.CanAuthenticate() {
		return "", status, nil
	}
	var subscribed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_subscriptions
		WHERE user_id=$1 AND status IN `+entitlingStatuses+`
		  AND (current_period_end IS NULL OR current_period_end>now()))`, userID).
		Scan(&subscribed); err != nil {
		return "", AccountStatus{}, err
	}
	if subscribed {
		return "", status, ErrConflict
	}
	reservationID := uid("checkout")
	if _, err := tx.Exec(ctx, `INSERT INTO stripe_checkout_sessions
		(id,user_id,customer_id,price_id,success_url,cancel_url,status)
		VALUES ($1,$2,$3,$4,$5,$6,'creating')`, reservationID, userID,
		customerID, priceID, successURL, cancelURL); err != nil {
		if isUniqueViolation(err) {
			return "", status, ErrConflict
		}
		return "", AccountStatus{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO stripe_compensations
		(user_id,action,object_id,next_attempt_at)
		VALUES ($1,'recover_checkout',$2,now()+interval '5 minutes')
		ON CONFLICT (action,object_id) DO NOTHING`, userID, reservationID); err != nil {
		return "", AccountStatus{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", AccountStatus{}, err
	}
	return reservationID, status, nil
}

// RecordStripeCheckoutSession binds the remote result to its committed
// reservation. A session created for an account that became locked is queued
// for expiration and never returned to the browser.
func (s *Store) RecordStripeCheckoutSession(
	ctx context.Context,
	reservationID, userID, customerID, sessionID string,
) (AccountStatus, error) {
	// The delayed recovery worker holds this same lock across its idempotent
	// Stripe replay and expiration. Serializing the bind prevents it from
	// expiring a session just as the request records and returns that session.
	release, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	defer release()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AccountStatus{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return AccountStatus{}, err
	}
	var existingCustomer *string
	if err := tx.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`, userID).
		Scan(&existingCustomer); err != nil {
		return AccountStatus{}, err
	}
	if existingCustomer != nil && *existingCustomer != "" && *existingCustomer != customerID {
		return AccountStatus{}, errors.New("Stripe customer changed during checkout")
	}
	if customerID != "" {
		if _, err := tx.Exec(ctx, `UPDATE users SET
			stripe_customer_id=COALESCE(stripe_customer_id,$2), updated_at=now()
			WHERE id=$1`, userID, customerID); err != nil {
			return AccountStatus{}, err
		}
	}
	var checkoutStatus string
	err = tx.QueryRow(ctx, `UPDATE stripe_checkout_sessions SET
		provider_session_id=CASE WHEN status='creating' THEN $3 ELSE provider_session_id END,
		customer_id=CASE WHEN $4='' THEN customer_id ELSE $4 END,
		status=CASE WHEN status='creating' THEN 'open' ELSE status END,
		updated_at=now()
		WHERE id=$1 AND user_id=$2
		  AND (status='creating'
		       OR (status IN ('open','completed') AND provider_session_id=$3))
		RETURNING status`, reservationID, userID, sessionID, customerID).Scan(&checkoutStatus)
	if err != nil {
		if isNoRows(err) {
			return AccountStatus{}, ErrConflict
		}
		return AccountStatus{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE stripe_compensations SET
		status='suppressed',lease_token=NULL,lease_expires_at=NULL,
		last_error='checkout recorded',completed_at=now(),updated_at=now()
		WHERE action='recover_checkout' AND object_id=$1 AND user_id=$2
		  AND status IN ('pending','running')`, reservationID, userID); err != nil {
		return AccountStatus{}, err
	}
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return AccountStatus{}, err
	}
	if checkoutStatus == "open" && (status.State == AccountDeletionPending ||
		status.State == AccountDeleted || status.State == AccountSuspended) {
		if err := enqueueStripeCompensationTx(
			ctx, tx, userID, StripeExpireCheckout, sessionID,
		); err != nil {
			return AccountStatus{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return AccountStatus{}, err
	}
	return status, nil
}

// RecordStripeCheckoutSessionExpired converges local state after the request
// successfully expires a provider session whose bind returned an error. It is
// safe after an unknown commit outcome: a committed open row becomes expired,
// while an uncommitted creating row is bound and expired in one transaction.
// The customer mapping is committed before recovery is suppressed.
func (s *Store) RecordStripeCheckoutSessionExpired(
	ctx context.Context,
	reservationID, userID, customerID, sessionID string,
) error {
	release, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return err
	}
	defer release()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return err
	}
	var mappedCustomer *string
	if err := tx.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`, userID).
		Scan(&mappedCustomer); err != nil {
		return err
	}
	var reservedCustomer *string
	if err := tx.QueryRow(ctx, `SELECT customer_id FROM stripe_checkout_sessions
		WHERE id=$1 AND user_id=$2 FOR UPDATE`, reservationID, userID).
		Scan(&reservedCustomer); err != nil {
		if isNoRows(err) {
			return ErrConflict
		}
		return err
	}
	expectedCustomer := customerID
	if mappedCustomer != nil && *mappedCustomer != "" {
		if expectedCustomer != "" && *mappedCustomer != expectedCustomer {
			return errors.New("Stripe customer changed during checkout expiration")
		}
		expectedCustomer = *mappedCustomer
	}
	if reservedCustomer != nil && *reservedCustomer != "" {
		if expectedCustomer != "" && *reservedCustomer != expectedCustomer {
			return errors.New("Stripe reservation customer changed during checkout expiration")
		}
		expectedCustomer = *reservedCustomer
	}
	customerID = expectedCustomer
	if customerID != "" {
		if _, err := tx.Exec(ctx, `UPDATE users SET
			stripe_customer_id=COALESCE(stripe_customer_id,$2),updated_at=now()
			WHERE id=$1`, userID, customerID); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE stripe_checkout_sessions SET
		provider_session_id=COALESCE(provider_session_id,$3),
		customer_id=CASE WHEN $4='' THEN customer_id ELSE $4 END,
		status='expired',updated_at=now()
		WHERE id=$1 AND user_id=$2 AND status IN ('creating','open')
		  AND (provider_session_id IS NULL OR provider_session_id=$3)`,
		reservationID, userID, sessionID, customerID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE stripe_compensations SET
		status='suppressed',lease_token=NULL,lease_expires_at=NULL,
		last_error='checkout expired after bind error',completed_at=now(),updated_at=now()
		WHERE action='recover_checkout' AND object_id=$1 AND user_id=$2
		  AND status IN ('pending','running')`, reservationID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) StripeCheckoutRecovery(
	ctx context.Context,
	reservationID string,
) (StripeCheckoutRecovery, error) {
	var recovery StripeCheckoutRecovery
	err := s.pool.QueryRow(ctx, `SELECT c.id,c.user_id,c.customer_id,
		COALESCE(u.email,''),u.name,c.price_id,c.success_url,c.cancel_url
		FROM stripe_checkout_sessions c JOIN users u ON u.id=c.user_id
		WHERE c.id=$1 AND c.status='creating'`, reservationID).Scan(
		&recovery.ID, &recovery.UserID, &recovery.CustomerID,
		&recovery.Email, &recovery.Name, &recovery.PriceID,
		&recovery.SuccessURL, &recovery.CancelURL,
	)
	if isNoRows(err) {
		return StripeCheckoutRecovery{}, ErrNotFound
	}
	return recovery, err
}

func (s *Store) CompleteStripeCheckoutRecovery(
	ctx context.Context,
	reservationID, customerID, sessionID string,
) error {
	var userID string
	if err := s.pool.QueryRow(ctx, `SELECT user_id FROM stripe_checkout_sessions
		WHERE id=$1 AND status='creating'`, reservationID).Scan(&userID); err != nil {
		if isNoRows(err) {
			return ErrConflict
		}
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return err
	}
	var existingCustomer *string
	if err := tx.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`, userID).
		Scan(&existingCustomer); err != nil {
		return err
	}
	if existingCustomer != nil && *existingCustomer != "" && *existingCustomer != customerID {
		return errors.New("Stripe customer changed during checkout recovery")
	}
	if customerID != "" {
		if _, err := tx.Exec(ctx, `UPDATE users SET
			stripe_customer_id=COALESCE(stripe_customer_id,$2), updated_at=now()
			WHERE id=$1`, userID, customerID); err != nil {
			return err
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE stripe_checkout_sessions SET
		provider_session_id=$2,customer_id=$3,status='expired',updated_at=now()
		WHERE id=$1 AND user_id=$4 AND status='creating'`,
		reservationID, sessionID, customerID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return tx.Commit(ctx)
}

// RecordStripeCheckoutCompleted first requires the event, reservation, and
// user customer identities to agree. It returns false when lifecycle state
// forbids the new entitlement. In that case cancellation is durably queued in
// the same transaction and the webhook can acknowledge without granting Pro.
func (s *Store) RecordStripeCheckoutCompleted(
	ctx context.Context,
	sessionID, reservationID, userID, customerID, subscriptionID string,
) (bool, error) {
	release, err := s.lockAccountLifecycle(ctx, userID)
	if err != nil {
		return false, err
	}
	defer release()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err := lockSubscriptionUserTx(ctx, tx, userID); err != nil {
		return false, err
	}
	expectedCustomer := customerID
	var mappedCustomer *string
	if err := tx.QueryRow(ctx, `SELECT stripe_customer_id FROM users WHERE id=$1`, userID).
		Scan(&mappedCustomer); err != nil {
		return false, err
	}
	if mappedCustomer != nil && *mappedCustomer != "" {
		if expectedCustomer != "" && expectedCustomer != *mappedCustomer {
			return false, errors.New("Stripe customer changed during checkout completion")
		}
		expectedCustomer = *mappedCustomer
	}
	rows, err := tx.Query(ctx, `SELECT id,user_id,status,
		COALESCE(provider_session_id,''),COALESCE(customer_id,'')
		FROM stripe_checkout_sessions
		WHERE provider_session_id=$1
		   OR (NULLIF($2,'') IS NOT NULL AND id=$2)
		   OR ($2='' AND user_id=$3 AND status='creating')
		ORDER BY id FOR UPDATE`, sessionID, reservationID, userID)
	if err != nil {
		return false, err
	}
	providerRowID := ""
	reservationRowID := ""
	for rows.Next() {
		var id, rowUserID, rowStatus, providerID, rowCustomerID string
		if err := rows.Scan(&id, &rowUserID, &rowStatus, &providerID, &rowCustomerID); err != nil {
			rows.Close()
			return false, err
		}
		if rowUserID != userID {
			rows.Close()
			return false, ErrConflict
		}
		if rowCustomerID != "" {
			if expectedCustomer != "" && expectedCustomer != rowCustomerID {
				rows.Close()
				return false, errors.New("Stripe reservation customer changed during checkout completion")
			}
			expectedCustomer = rowCustomerID
		}
		if providerID == sessionID {
			providerRowID = id
		}
		if (reservationID != "" && id == reservationID) ||
			(reservationID == "" && rowStatus == "creating") {
			reservationRowID = id
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()

	if providerRowID != "" && reservationRowID != "" && providerRowID != reservationRowID {
		return false, ErrConflict
	}
	customerID = expectedCustomer
	if customerID != "" {
		if _, err := tx.Exec(ctx, `UPDATE users SET
			stripe_customer_id=COALESCE(stripe_customer_id,$2),updated_at=now()
			WHERE id=$1`, userID, customerID); err != nil {
			return false, err
		}
	}
	canonicalID := providerRowID
	if reservationRowID != "" {
		canonicalID = reservationRowID
	}
	if canonicalID == "" {
		canonicalID = sessionID
		if _, err := tx.Exec(ctx, `INSERT INTO stripe_checkout_sessions
			(id,provider_session_id,user_id,customer_id,status,subscription_id,completed_at)
			VALUES ($1,$1,$2,$3,'completed',NULLIF($4,''),now())`,
			sessionID, userID, customerID, subscriptionID); err != nil {
			return false, err
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE stripe_checkout_sessions SET
			provider_session_id=$2,
			customer_id=CASE WHEN $3='' THEN customer_id ELSE $3 END,
			status='completed',
			subscription_id=COALESCE(NULLIF($4,''),subscription_id),
			completed_at=COALESCE(completed_at,now()),updated_at=now()
			WHERE id=$1`, canonicalID, sessionID, customerID, subscriptionID); err != nil {
			return false, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE stripe_compensations SET
		status='suppressed',lease_token=NULL,lease_expires_at=NULL,
		last_error='checkout completed',completed_at=now(),updated_at=now()
		WHERE action='recover_checkout' AND object_id=$1 AND user_id=$2
		  AND status IN ('pending','running')`, canonicalID, userID); err != nil {
		return false, err
	}
	var deletionRequestedAt, deletedAt, suspendedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT deletion_requested_at,deleted_at,suspended_at
		FROM users WHERE id=$1`, userID).Scan(
		&deletionRequestedAt, &deletedAt, &suspendedAt,
	); err != nil {
		return false, err
	}
	allowed := deletionRequestedAt == nil && deletedAt == nil && suspendedAt == nil
	if !allowed {
		if err := enqueueStripeCompensationTx(
			ctx, tx, userID, StripeCancelSubscription, subscriptionID,
		); err != nil {
			return false, err
		}
	}
	return allowed, tx.Commit(ctx)
}

func (s *Store) ClaimStripeCompensation(
	ctx context.Context,
	lease time.Duration,
) (*StripeCompensation, error) {
	if lease <= 0 {
		lease = time.Minute
	}
	token := uid("stripe_lease")
	var job StripeCompensation
	err := s.pool.QueryRow(ctx, `UPDATE stripe_compensations SET
		status='running', attempts=attempts+1, lease_token=$1,
		lease_expires_at=now()+$2::interval, updated_at=now()
		WHERE id=(
			SELECT id FROM stripe_compensations
			WHERE (status='pending' AND next_attempt_at<=now())
			   OR (status='running' AND lease_expires_at<=now())
			ORDER BY next_attempt_at,id
			FOR UPDATE SKIP LOCKED LIMIT 1
		)
		RETURNING id,user_id,action,object_id,attempts,generation,
			COALESCE(provider_result_id,''),lease_token`,
		token, lease.String()).Scan(
		&job.ID, &job.UserID, &job.Action, &job.ObjectID, &job.Attempts,
		&job.Generation, &job.ProviderResultID, &job.LeaseToken,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &job, err
}

// BeginStripeCompensation serializes the lifecycle recheck with support
// cancellation. The caller holds the returned advisory-lock release function
// through the remote mutation, so no deletion-only side effect can begin after
// CancelAccountDeletion has restored the account. Refunds already queued after
// a charge/cancellation remain obligations and are never suppressed.
func (s *Store) BeginStripeCompensation(
	ctx context.Context,
	job StripeCompensation,
) (func(), bool, error) {
	release, err := s.lockAccountLifecycle(ctx, job.UserID)
	if err != nil {
		return nil, false, err
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM stripe_compensations
		WHERE id=$1 AND lease_token=$2`, job.ID, job.LeaseToken).Scan(&status); err != nil {
		release()
		if isNoRows(err) {
			return nil, false, ErrConflict
		}
		return nil, false, err
	}
	if status != "running" {
		release()
		return nil, false, nil
	}
	if job.Action == StripeRecoverCheckout || job.Action == StripeRefundPayment || job.Action == StripeRefundCharge {
		return release, true, nil
	}
	account, err := s.AccountAccess(ctx, job.UserID)
	if err != nil {
		release()
		return nil, false, err
	}
	if account.State == AccountDeletionPending || account.State == AccountDeleted || account.State == AccountSuspended {
		return release, true, nil
	}
	tag, err := s.pool.Exec(ctx, `UPDATE stripe_compensations SET
		status='suppressed',lease_token=NULL,lease_expires_at=NULL,
		last_error='account lifecycle restored',updated_at=now()
		WHERE id=$1 AND status='running' AND lease_token=$2`, job.ID, job.LeaseToken)
	release()
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 0 {
		return nil, false, ErrConflict
	}
	return nil, false, nil
}

func (s *Store) SetStripeCompensationProviderResult(
	ctx context.Context,
	job StripeCompensation,
	providerResultID string,
) error {
	tag, err := s.pool.Exec(ctx, `UPDATE stripe_compensations SET
		provider_result_id=$3,updated_at=now()
		WHERE id=$1 AND status='running' AND lease_token=$2`,
		job.ID, job.LeaseToken, providerResultID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

// MarkStripeCompensationProviderStarted is the durable boundary before a
// remote subscription cancellation. If the provider outcome or the following
// local completion is uncertain, support restoration waits for the worker to
// reconcile this job instead of deriving entitlement from stale local truth.
func (s *Store) MarkStripeCompensationProviderStarted(
	ctx context.Context,
	job StripeCompensation,
) error {
	tag, err := s.pool.Exec(ctx, `UPDATE stripe_compensations SET
		provider_started_at=COALESCE(provider_started_at,now()),updated_at=now()
		WHERE id=$1 AND action='cancel_subscription'
		  AND status='running' AND lease_token=$2`, job.ID, job.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

// SuppressStripeCancellationAtPeriodEnd records provider truth that the
// subscription is already scheduled to end without refunding or ending the
// paid period early. The live subscription row is deliberately preserved. If
// a later webhook or reconciliation observes cancel_at_period_end=false while
// the lifecycle remains closed, enqueueStripeCompensationTx reopens this job.
func (s *Store) SuppressStripeCancellationAtPeriodEnd(
	ctx context.Context,
	job StripeCompensation,
) error {
	tag, err := s.pool.Exec(ctx, `UPDATE stripe_compensations SET
		status='suppressed',lease_token=NULL,lease_expires_at=NULL,
		last_error='subscription cancels at period end',completed_at=now(),updated_at=now()
		WHERE id=$1 AND action='cancel_subscription'
		  AND status='running' AND lease_token=$2`, job.ID, job.LeaseToken)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

// AdvanceStripeRefundGeneration starts a new logical, idempotent refund after
// Stripe reports that the prior refund definitively failed or was canceled.
// Network/unknown errors do not call this: they retry the same generation.
func (s *Store) AdvanceStripeRefundGeneration(
	ctx context.Context,
	job StripeCompensation,
	jobErr error,
) error {
	tag, err := s.pool.Exec(ctx, `UPDATE stripe_compensations SET
		status='pending',generation=generation+1,provider_result_id=NULL,
		lease_token=NULL,lease_expires_at=NULL,
		next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*(2^LEAST(attempts-1,7)))),
		last_error=$3,updated_at=now()
		WHERE id=$1 AND status='running' AND lease_token=$2`,
		job.ID, job.LeaseToken, jobErr.Error())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

func (s *Store) FinishStripeCompensation(
	ctx context.Context,
	job StripeCompensation,
	jobErr error,
) error {
	if jobErr == nil {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if job.Action == StripeCancelSubscription {
			if err := lockSubscriptionUserTx(ctx, tx, job.UserID); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, `UPDATE stripe_compensations SET
			status='succeeded', lease_token=NULL, lease_expires_at=NULL,
			last_error='', completed_at=now(), updated_at=now()
			WHERE id=$1 AND status='running' AND lease_token=$2`, job.ID, job.LeaseToken)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrConflict
		}
		switch job.Action {
		case StripeExpireCheckout:
			_, err = tx.Exec(ctx, `UPDATE stripe_checkout_sessions
				SET status='expired',updated_at=now()
				WHERE provider_session_id=$1 AND status='open'`, job.ObjectID)
		case StripeCancelSubscription:
			// A raced Checkout can be cancelled before its subscription-created
			// webhook arrives. Insert a terminal ordering row in that case so the
			// delayed pre-cancellation event cannot grant entitlement after restore.
			tag, err = tx.Exec(ctx, `INSERT INTO user_subscriptions
				(stripe_subscription_id,user_id,status,price_id,plan_tier,
				 cancel_at_period_end,canceled_at,ended_at,stripe_event_created)
				VALUES ($1,$2,'canceled','','free',false,now(),now(),
					extract(epoch FROM now())::bigint)
				ON CONFLICT (stripe_subscription_id) DO UPDATE SET
					status='canceled',cancel_at_period_end=false,
					canceled_at=COALESCE(user_subscriptions.canceled_at,now()),
					ended_at=COALESCE(user_subscriptions.ended_at,now()),
					stripe_event_created=GREATEST(user_subscriptions.stripe_event_created,
						excluded.stripe_event_created),updated_at=now()
				WHERE user_subscriptions.user_id=excluded.user_id`,
				job.ObjectID, job.UserID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return ErrConflict
			}
			var deletionRequestedAt, deletedAt, suspendedAt *time.Time
			if err = tx.QueryRow(ctx, `SELECT deletion_requested_at,deleted_at,suspended_at
				FROM users WHERE id=$1`, job.UserID).Scan(
				&deletionRequestedAt, &deletedAt, &suspendedAt,
			); err != nil {
				return err
			}
			if deletionRequestedAt != nil || deletedAt != nil || suspendedAt != nil {
				err = s.projectClosedUserPlanTx(ctx, tx, job.UserID)
			} else {
				err = s.deriveUserPlanTx(ctx, tx, job.UserID)
			}
		}
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	tag, err := s.pool.Exec(ctx, `UPDATE stripe_compensations SET
		status='pending', lease_token=NULL, lease_expires_at=NULL,
		next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*(2^LEAST(attempts-1,7)))),
		last_error=$3, updated_at=now()
		WHERE id=$1 AND status='running' AND lease_token=$2`,
		job.ID, job.LeaseToken, jobErr.Error())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}
