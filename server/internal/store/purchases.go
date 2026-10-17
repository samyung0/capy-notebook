package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// Top-ups and auto-reloads sell credits at $1 per 1,000 (human/observability-metering.md).
const (
	TopUpMinCents  = 800
	TopUpMaxCents  = 10000
	creditsPerCent = 10
)

// reloadWindow is how long new work is admitted at zero while a reload charges;
// it matches credit_reload_pending in 0088_purchased_credits.sql.
const reloadWindow = 60 * time.Second

func CreditsMicrosForCents(cents int64) int64 {
	return cents * creditsPerCent * MicrosPerCredit
}

var (
	ErrNoPaymentMethod         = errors.New("no saved payment method")
	ErrPaymentMethodNotInstant = errors.New("payment method is not instant")
	// The API schema bounds these; reaching the store with one is a bug.
	errInvalidCreditSetting = errors.New("invalid credit setting")
)

type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// SpendingLimitError refuses a manual top-up that would pass the monthly
// spending limit, on its own or together with a reload being charged.
type SpendingLimitError struct {
	LimitCents     int64
	SpentCents     int64
	ChargingCents  int64
	RequestedCents int64
}

func (e *SpendingLimitError) Error() string {
	return fmt.Sprintf("monthly spending limit: limit=%d spent=%d charging=%d requested=%d",
		e.LimitCents, e.SpentCents, e.ChargingCents, e.RequestedCents)
}

// PaymentMethod is the saved card or Link method auto-reload charges.
type PaymentMethod struct {
	ID       string `json:"-"`
	Type     string `json:"type"`
	Brand    string `json:"brand,omitempty"`
	Last4    string `json:"last4,omitempty"`
	ExpMonth int    `json:"expMonth,omitempty"`
	ExpYear  int    `json:"expYear,omitempty"`
}

// Instant methods confirm at once; auto-reload accepts only these.
func (p PaymentMethod) Instant() bool { return p.Type == "card" || p.Type == "link" }

// ReloadState is the latest auto-reload as the notices show it.
type ReloadState struct {
	// Status is the latest reload's: charging, retrying, failed, paid or void;
	// empty when there has been none.
	Status        string     `json:"status,omitempty" enum:"charging,retrying,failed,paid,void"`
	AmountCents   int64      `json:"amountCents"`
	NextAttemptAt *time.Time `json:"nextAttemptAt,omitempty"`
	DeclineReason string     `json:"declineReason,omitempty"`
	// Skipped is set when this month's reload would have passed the limit.
	Skipped bool `json:"skipped"`
}

// CreditSettings are the purchased-credit controls on the Subscription tab.
type CreditSettings struct {
	AutoReload            bool           `json:"autoReload"`
	ReloadAmountCents     int64          `json:"reloadAmountCents"`
	ReloadThresholdMicros int64          `json:"reloadThresholdMicros"`
	PaymentMethod         *PaymentMethod `json:"paymentMethod,omitempty"`
	PaymentMethodInstant  bool           `json:"paymentMethodInstant"`
	// SpendingLimitCents is absent when no limit is set.
	SpendingLimitCents  *int64      `json:"spendingLimitCents,omitempty"`
	SpentThisMonthCents int64       `json:"spentThisMonthCents"`
	Reload              ReloadState `json:"reload"`
}

func utcMonthStart() time.Time { return monthStart() }

// monthSpendCentsTx is what the spending limit counts: paid and charging
// top-ups and reloads this UTC month (by when they were paid), pre-tax.
func monthSpendCentsTx(ctx context.Context, q rowQuerier, userID string) (spent, charging int64, err error) {
	err = q.QueryRow(ctx, `
		SELECT COALESCE(sum(amount_cents), 0),
		       COALESCE(sum(amount_cents) FILTER (WHERE status = 'charging'), 0)
		FROM credit_purchases
		WHERE user_id = $1 AND status IN ('charging', 'paid')
		  AND COALESCE(paid_at, created_at) >= $2`, userID, utcMonthStart()).Scan(&spent, &charging)
	return spent, charging, err
}

// CreditSettings reads the Subscription tab's credit controls.
func (s *Store) CreditSettings(ctx context.Context, userID string) (CreditSettings, error) {
	var out CreditSettings
	var pmID, pmType, pmBrand, pmLast4 *string
	var pmExpMonth, pmExpYear *int
	var skippedAt *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT auto_reload_enabled, reload_amount_cents, reload_threshold_micros,
		       reload_pm_id, reload_pm_type, reload_pm_brand, reload_pm_last4,
		       reload_pm_exp_month, reload_pm_exp_year, spending_limit_cents, reload_skipped_at
		FROM user_credits WHERE user_id = $1`, userID).Scan(
		&out.AutoReload, &out.ReloadAmountCents, &out.ReloadThresholdMicros,
		&pmID, &pmType, &pmBrand, &pmLast4, &pmExpMonth, &pmExpYear,
		&out.SpendingLimitCents, &skippedAt)
	if isNoRows(err) {
		// No counter row yet: the column defaults.
		out.ReloadAmountCents = 1000
		return out, nil
	}
	if err != nil {
		return out, err
	}
	if pmID != nil {
		pm := PaymentMethod{ID: *pmID, Type: deref(pmType), Brand: deref(pmBrand), Last4: deref(pmLast4)}
		if pmExpMonth != nil && pmExpYear != nil {
			pm.ExpMonth, pm.ExpYear = *pmExpMonth, *pmExpYear
		}
		out.PaymentMethod = &pm
		out.PaymentMethodInstant = pm.Instant()
	}
	out.Reload.Skipped = skippedAt != nil && !skippedAt.Before(utcMonthStart())
	if out.SpentThisMonthCents, _, err = monthSpendCentsTx(ctx, s.pool, userID); err != nil {
		return out, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT status, amount_cents, next_attempt_at, COALESCE(decline_reason, '')
		FROM credit_purchases WHERE user_id = $1 AND kind = 'reload'
		ORDER BY created_at DESC LIMIT 1`, userID).Scan(
		&out.Reload.Status, &out.Reload.AmountCents, &out.Reload.NextAttemptAt, &out.Reload.DeclineReason)
	if err != nil && !isNoRows(err) {
		return out, err
	}
	return out, nil
}

// SetAutoReload saves the auto-reload switch, amount and threshold. Turning it
// on needs a saved instant payment method.
func (s *Store) SetAutoReload(
	ctx context.Context, userID string, enabled bool, amountCents, thresholdMicros int64,
) (armed bool, err error) {
	if amountCents < TopUpMinCents || amountCents > TopUpMaxCents || thresholdMicros < 0 {
		return false, errInvalidCreditSetting
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := s.lockedCreditUsageTx(ctx, tx, userID); err != nil {
		return false, err
	}
	var pmType *string
	if err := tx.QueryRow(ctx, `SELECT reload_pm_type FROM user_credits WHERE user_id = $1`, userID).
		Scan(&pmType); err != nil {
		return false, err
	}
	if enabled && pmType == nil {
		return false, ErrNoPaymentMethod
	}
	if enabled && !(PaymentMethod{Type: *pmType}).Instant() {
		return false, ErrPaymentMethodNotInstant
	}
	// Saving never arms a reload (turning it off and on must not buy another
	// try after a failure); it reports the arming the save leaves.
	if err := tx.QueryRow(ctx, `UPDATE user_credits
		SET auto_reload_enabled = $2, reload_amount_cents = $3, reload_threshold_micros = $4,
		    reload_skipped_at = NULL, updated_at = now()
		WHERE user_id = $1 RETURNING reload_armed`, userID, enabled, amountCents, thresholdMicros).
		Scan(&armed); err != nil {
		return false, err
	}
	return armed, tx.Commit(ctx)
}

// ArmReload re-arms auto-reload after a paid Pro subscription invoice.
func (s *Store) ArmReload(ctx context.Context, userID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE user_credits SET reload_armed = true WHERE user_id = $1`, userID)
	return err
}

// SetSpendingLimit sets the monthly limit in cents; 0 removes it. A changed
// limit lets a skipped reload try again.
func (s *Store) SetSpendingLimit(ctx context.Context, userID string, limitCents int64) error {
	if limitCents < 0 {
		return errInvalidCreditSetting
	}
	var limit *int64
	if limitCents > 0 {
		limit = &limitCents
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := s.lockedCreditUsageTx(ctx, tx, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET spending_limit_cents = $2, reload_skipped_at = NULL, updated_at = now()
		WHERE user_id = $1`, userID, limit); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SavePaymentMethod stores the auto-reload method. onlyIfNone keeps an
// existing one: a top-up's card is saved only when none is. A new card arms
// one reload.
func (s *Store) SavePaymentMethod(ctx context.Context, userID string, pm PaymentMethod, onlyIfNone bool) error {
	var expMonth, expYear *int
	if pm.ExpMonth > 0 {
		expMonth, expYear = &pm.ExpMonth, &pm.ExpYear
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO user_credits (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING;`, userID)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE user_credits
		SET reload_pm_id = $2, reload_pm_type = $3, reload_pm_brand = NULLIF($4, ''),
		    reload_pm_last4 = NULLIF($5, ''), reload_pm_exp_month = $6, reload_pm_exp_year = $7,
		    reload_armed = true, updated_at = now()
		WHERE user_id = $1 AND (NOT $8 OR reload_pm_id IS NULL)`,
		userID, pm.ID, pm.Type, pm.Brand, pm.Last4, expMonth, expYear, onlyIfNone)
	return err
}

// CheckTopUpLimit refuses a top-up that would pass the monthly spending limit.
func (s *Store) CheckTopUpLimit(ctx context.Context, userID string, amountCents int64) error {
	var limit *int64
	err := s.pool.QueryRow(ctx, `SELECT spending_limit_cents FROM user_credits WHERE user_id = $1`, userID).
		Scan(&limit)
	if isNoRows(err) || (err == nil && limit == nil) {
		return nil
	}
	if err != nil {
		return err
	}
	spent, charging, err := monthSpendCentsTx(ctx, s.pool, userID)
	if err != nil {
		return err
	}
	if spent+amountCents <= *limit {
		return nil
	}
	return &SpendingLimitError{LimitCents: *limit, SpentCents: spent, ChargingCents: charging, RequestedCents: amountCents}
}

// BindStripeCustomer records a customer created for a top-up and returns the
// customer the user ends up with (an earlier one wins).
func (s *Store) BindStripeCustomer(ctx context.Context, userID, customerID string) (string, error) {
	var bound string
	err := s.pool.QueryRow(ctx, `UPDATE users
		SET stripe_customer_id = COALESCE(stripe_customer_id, $2), updated_at = now()
		WHERE id = $1 RETURNING stripe_customer_id`, userID, customerID).Scan(&bound)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return bound, err
}

// addPurchasedTx moves the purchased balance; negative takes credits back.
func addPurchasedTx(ctx context.Context, tx pgx.Tx, userID string, micros int64) error {
	if _, err := tx.Exec(ctx, `INSERT INTO user_credits (user_id) VALUES ($1)
		ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE user_credits
		SET purchased_micros = purchased_micros + $2, updated_at = now()
		WHERE user_id = $1`, userID, micros)
	return err
}

// GrantTopUp credits a paid top-up once per Checkout session. It returns the
// reload invoices still being retried, which the caller voids.
func (s *Store) GrantTopUp(
	ctx context.Context, userID, checkoutSessionID, paymentIntentID string, amountCents int64,
) (granted bool, retrying []string, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	credits := CreditsMicrosForCents(amountCents)
	tag, err := tx.Exec(ctx, `INSERT INTO credit_purchases
		(id, user_id, kind, status, amount_cents, credits_micros,
		 stripe_checkout_session_id, stripe_payment_intent_id, paid_at)
		VALUES ($1, $2, 'topup', 'paid', $3, $4, $5, NULLIF($6, ''), now())
		ON CONFLICT (stripe_checkout_session_id) DO NOTHING`,
		uid("cp"), userID, amountCents, credits, checkoutSessionID, paymentIntentID)
	if err != nil {
		return false, nil, err
	}
	if tag.RowsAffected() == 1 {
		if err := addPurchasedTx(ctx, tx, userID, credits); err != nil {
			return false, nil, err
		}
		// A paid top-up arms one reload.
		if _, err := tx.Exec(ctx, `UPDATE user_credits SET reload_armed = true
			WHERE user_id = $1`, userID); err != nil {
			return false, nil, err
		}
	}
	if retrying, err = retryingReloadInvoices(ctx, tx, userID); err != nil {
		return false, nil, err
	}
	return tag.RowsAffected() == 1, retrying, tx.Commit(ctx)
}

// RetryingReloadInvoices are the reload invoices Stripe is still retrying,
// which a top-up, a new card or turning auto-reload off voids.
func (s *Store) RetryingReloadInvoices(ctx context.Context, userID string) ([]string, error) {
	return retryingReloadInvoices(ctx, s.pool, userID)
}

func retryingReloadInvoices(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, userID string,
) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT stripe_invoice_id FROM credit_purchases
		WHERE user_id = $1 AND kind = 'reload' AND status = 'retrying'
		  AND stripe_invoice_id IS NOT NULL`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// ReloadRetryUnwanted reports whether a reload Stripe is retrying was given up
// while it charged: auto-reload is off now, or the saved card is not the one it
// charged. The caller voids it as the switch or the new card would have.
func (s *Store) ReloadRetryUnwanted(ctx context.Context, invoiceID string) (bool, error) {
	var unwanted bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM credit_purchases p
		JOIN user_credits c ON c.user_id = p.user_id
		WHERE p.stripe_invoice_id = $1 AND p.kind = 'reload' AND p.status = 'retrying'
		  AND (NOT c.auto_reload_enabled OR c.reload_pm_id IS DISTINCT FROM p.reload_pm_id))`,
		invoiceID).Scan(&unwanted)
	return unwanted, err
}

// MarkReloadVoid records a retrying reload invoice voided by a manual top-up.
func (s *Store) MarkReloadVoid(ctx context.Context, invoiceID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE credit_purchases
		SET status = 'void', next_attempt_at = NULL
		WHERE stripe_invoice_id = $1 AND status IN ('charging', 'retrying', 'failed')`, invoiceID)
	return err
}

/* ------------------------------------------------------------ auto-reload */

// ReloadCharge is one reload the worker charges.
type ReloadCharge struct {
	ID              string
	UserID          string
	CustomerID      string
	PaymentMethodID string
	AmountCents     int64
	// Skipped: the spending limit stopped it; there is nothing to charge.
	Skipped bool
}

// ReloadCandidates lists open accounts whose auto-reload is armed, or was
// started by a request at zero and still needs its charge. StartReload decides
// under the counter lock with the effective plan.
func (s *Store) ReloadCandidates(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.user_id FROM user_credits c
		JOIN users u ON u.id = c.user_id
		WHERE c.auto_reload_enabled AND (c.reload_armed OR c.reload_started_at IS NOT NULL)
		  AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL AND u.suspended_at IS NULL`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// StartReload charges a reload a request already started at zero, or starts
// an armed one whose credits reached the threshold. It returns nil when there is
// nothing to charge; a reload that would pass the spending limit is skipped and
// the user emailed instead.
func (s *Store) StartReload(ctx context.Context, userID string) (*ReloadCharge, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	usage, err := s.lockedCreditUsageTx(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	var started *time.Time
	var armed, enabled, closed, busy, skipped bool
	var threshold, amount int64
	var limit *int64
	var pmID, pmType, customerID *string
	if err := tx.QueryRow(ctx, `
		SELECT c.reload_started_at, c.reload_armed, c.auto_reload_enabled,
		       c.reload_threshold_micros, c.reload_amount_cents, c.spending_limit_cents,
		       c.reload_pm_id, c.reload_pm_type, u.stripe_customer_id,
		       u.deleted_at IS NOT NULL OR u.deletion_requested_at IS NOT NULL
		         OR u.suspended_at IS NOT NULL,
		       EXISTS (SELECT 1 FROM credit_purchases p
		         WHERE p.user_id = c.user_id AND p.kind = 'reload'
		           AND (p.status IN ('charging', 'retrying')
		             OR (c.reload_started_at IS NOT NULL AND p.created_at >= c.reload_started_at))),
		       c.reload_skipped_at IS NOT NULL AND c.reload_skipped_at >= $2
		FROM user_credits c JOIN users u ON u.id = c.user_id
		WHERE c.user_id = $1`, userID, utcMonthStart()).
		Scan(&started, &armed, &enabled, &threshold, &amount, &limit,
			&pmID, &pmType, &customerID, &closed, &busy, &skipped); err != nil {
		return nil, err
	}
	usable := enabled && !closed && pmID != nil && customerID != nil &&
		PaymentMethod{Type: deref(pmType)}.Instant()
	switch {
	case busy:
		return nil, nil
	case started != nil && !usable:
		// A request started it, but it can no longer be charged: end the window.
		_, err := tx.Exec(ctx, `UPDATE user_credits SET reload_started_at = NULL
			WHERE user_id = $1`, userID)
		if err != nil {
			return nil, err
		}
		return nil, tx.Commit(ctx)
	case started == nil && (!armed || !usable || skipped || usage.AvailableMicros() > threshold):
		return nil, nil
	}
	if limit != nil {
		spent, _, err := monthSpendCentsTx(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		if spent+amount > *limit {
			if err := s.skipReloadTx(ctx, tx, userID, amount, *limit); err != nil {
				return nil, err
			}
			return &ReloadCharge{UserID: userID, Skipped: true}, nil
		}
	}
	charge := &ReloadCharge{
		ID: uid("cp"), UserID: userID, CustomerID: *customerID,
		PaymentMethodID: *pmID, AmountCents: amount,
	}
	if _, err := tx.Exec(ctx, `INSERT INTO credit_purchases
		(id, user_id, kind, status, amount_cents, credits_micros, reload_pm_id)
		VALUES ($1, $2, 'reload', 'charging', $3, $4, $5)`,
		charge.ID, userID, amount, CreditsMicrosForCents(amount), *pmID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET reload_started_at = COALESCE(reload_started_at, now()), reload_armed = false
		WHERE user_id = $1`, userID); err != nil {
		return nil, err
	}
	return charge, tx.Commit(ctx)
}

func (s *Store) skipReloadTx(ctx context.Context, tx pgx.Tx, userID string, amount, limit int64) error {
	var skippedAt time.Time
	// Skipped is not a failure: it stays armed for a raised limit or next month.
	if err := tx.QueryRow(ctx, `UPDATE user_credits
		SET reload_skipped_at = now(), reload_started_at = NULL, reload_armed = true
		WHERE user_id = $1 RETURNING reload_skipped_at`, userID).Scan(&skippedAt); err != nil {
		return err
	}
	var email *string
	var locale string
	if err := tx.QueryRow(ctx, `SELECT email, locale FROM users WHERE id = $1`, userID).
		Scan(&email, &locale); err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{"amountCents": amount, "limitCents": limit})
	if err != nil {
		return err
	}
	if _, err := EnqueueEmailTx(ctx, tx, EmailOutboxParams{
		UserID:         userID,
		ToEmail:        deref(email),
		Template:       "credit-reload-skipped",
		Locale:         locale,
		Payload:        payload,
		IdempotencyKey: fmt.Sprintf("credit-reload-skipped:%s:%d", userID, skippedAt.UnixNano()),
		Category:       "billing",
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// StaleReloadCharges are reloads left charging by a worker that stopped
// mid-charge; resuming reuses the same Stripe idempotency keys.
func (s *Store) StaleReloadCharges(ctx context.Context, olderThan time.Duration) ([]ReloadCharge, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.user_id, u.stripe_customer_id, p.reload_pm_id, p.amount_cents
		FROM credit_purchases p
		JOIN users u ON u.id = p.user_id
		WHERE p.status = 'charging' AND p.kind = 'reload'
		  AND p.created_at < now() - $1::interval
		  AND p.created_at > now() - interval '23 hours'
		  AND u.stripe_customer_id IS NOT NULL AND p.reload_pm_id IS NOT NULL`,
		olderThan.String())
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (ReloadCharge, error) {
		var c ReloadCharge
		err := row.Scan(&c.ID, &c.UserID, &c.CustomerID, &c.PaymentMethodID, &c.AmountCents)
		return c, err
	})
}

// UnsettledReload is a reload invoice the app has not seen settle.
type UnsettledReload struct {
	ID        string
	UserID    string
	InvoiceID string
	Status    string
}

// UnsettledReloads are the reload invoices the daily reconciliation re-reads:
// retrying or failed, and charging ones the worker has left for an hour, from
// the last 90 days.
func (s *Store) UnsettledReloads(ctx context.Context) ([]UnsettledReload, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, user_id, stripe_invoice_id, status
		FROM credit_purchases
		WHERE kind = 'reload' AND stripe_invoice_id IS NOT NULL
		  AND created_at > now() - interval '90 days'
		  AND (status IN ('retrying', 'failed')
		    OR (status = 'charging' AND created_at < now() - interval '1 hour'))
		ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (UnsettledReload, error) {
		var r UnsettledReload
		err := row.Scan(&r.ID, &r.UserID, &r.InvoiceID, &r.Status)
		return r, err
	})
}

// StuckReload is a reload still charging after its idempotency keys expired.
type StuckReload struct {
	ID        string
	InvoiceID string
}

// StuckReloadCharges are reloads left charging for 23 hours; the caller voids
// their invoice and marks them failed.
func (s *Store) StuckReloadCharges(ctx context.Context) ([]StuckReload, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, COALESCE(stripe_invoice_id, '')
		FROM credit_purchases
		WHERE status = 'charging' AND kind = 'reload' AND created_at <= now() - interval '23 hours'`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (StuckReload, error) {
		var r StuckReload
		err := row.Scan(&r.ID, &r.InvoiceID)
		return r, err
	})
}

// SetReloadInvoice links a charging reload to its Stripe invoice.
func (s *Store) SetReloadInvoice(ctx context.Context, purchaseID, invoiceID string) error {
	_, err := s.pool.Exec(ctx, `UPDATE credit_purchases SET stripe_invoice_id = $2
		WHERE id = $1 AND stripe_invoice_id IS NULL`, purchaseID, invoiceID)
	return err
}

// MarkReloadPaid credits a paid reload invoice once, whichever of the worker
// and the invoice.paid webhook gets there first, and ends the charging window.
func (s *Store) MarkReloadPaid(ctx context.Context, purchaseID, invoiceID, paymentIntentID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID string
	var credits int64
	err = tx.QueryRow(ctx, `UPDATE credit_purchases
		SET status = 'paid', paid_at = now(), next_attempt_at = NULL,
		    stripe_invoice_id = COALESCE(stripe_invoice_id, NULLIF($2, '')),
		    stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, NULLIF($3, ''))
		WHERE (id = $1 OR stripe_invoice_id = $2) AND kind = 'reload' AND status <> 'paid'
		RETURNING user_id, credits_micros`, purchaseID, invoiceID, paymentIntentID).
		Scan(&userID, &credits)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := addPurchasedTx(ctx, tx, userID, credits); err != nil {
		return err
	}
	usage, err := s.lockedCreditUsageTx(ctx, tx, userID)
	if err != nil {
		return err
	}
	// Re-armed only when the reload lifted credits above the threshold, so a
	// paid reload never chains into another.
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET reload_started_at = NULL,
		    reload_armed = reload_armed OR $2 > reload_threshold_micros
		WHERE user_id = $1`, userID, usage.AvailableMicros()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// MarkReloadFailed records a declined reload: retrying while Stripe has a next
// attempt, failed once it stopped. New work at zero is refused from here on.
func (s *Store) MarkReloadFailed(
	ctx context.Context, purchaseID, invoiceID string, nextAttempt time.Time, declineReason string,
) error {
	status := "failed"
	var next *time.Time
	if !nextAttempt.IsZero() {
		status, next = "retrying", &nextAttempt
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID, was string
	err = tx.QueryRow(ctx, `WITH before AS (
		  SELECT id, status FROM credit_purchases
		  WHERE (id = $1 OR stripe_invoice_id = $2) AND kind = 'reload'
		    AND status IN ('charging', 'retrying', 'failed')
		  FOR UPDATE
		)
		UPDATE credit_purchases p
		SET status = $3, next_attempt_at = $4, decline_reason = NULLIF($5, ''),
		    stripe_invoice_id = COALESCE(p.stripe_invoice_id, NULLIF($2, ''))
		FROM before WHERE p.id = before.id
		RETURNING p.user_id, before.status`, purchaseID, invoiceID, status, next, declineReason).
		Scan(&userID, &was)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	// Only the reload that was charging ends the window; re-reading an older
	// failed one (daily reconciliation) leaves a newer reload's window alone.
	if was == "charging" {
		if _, err := tx.Exec(ctx, `UPDATE user_credits SET reload_started_at = NULL
			WHERE user_id = $1`, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

/* ------------------------------------------------------ refunds, disputes */

// ReverseRefund takes back credits in proportion to the amount refunded so
// far (Stripe reports it cumulatively, so redeliveries change nothing).
func (s *Store) ReverseRefund(ctx context.Context, paymentIntentID string, refundedCents, chargedCents int64) (string, error) {
	if chargedCents <= 0 {
		return "", nil
	}
	return s.adjustPurchase(ctx, paymentIntentID, func(credits, refunded, _ int64) (int64, int64) {
		target := min(credits, credits*refundedCents/chargedCents)
		return target, -(target - refunded)
	}, "refunded_micros")
}

// HoldDispute takes back what is left of a purchase when a dispute opens.
func (s *Store) HoldDispute(ctx context.Context, paymentIntentID string) (string, error) {
	return s.adjustPurchase(ctx, paymentIntentID, func(credits, refunded, disputed int64) (int64, int64) {
		if disputed > 0 {
			return disputed, 0
		}
		hold := credits - refunded
		return hold, -hold
	}, "disputed_micros")
}

// ReleaseDispute gives the held credits back when a dispute closes won.
func (s *Store) ReleaseDispute(ctx context.Context, paymentIntentID string) (string, error) {
	return s.adjustPurchase(ctx, paymentIntentID, func(_, _, disputed int64) (int64, int64) {
		return 0, disputed
	}, "disputed_micros")
}

// adjustPurchase sets one reversal column and moves the purchased balance by
// the delta next returns, under the purchase row lock. It returns the user
// whose credits moved, or "" when nothing changed. An unknown payment intent
// (a Pro subscription charge) is ignored.
func (s *Store) adjustPurchase(
	ctx context.Context, paymentIntentID string,
	next func(credits, refunded, disputed int64) (column, delta int64), column string,
) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var id, userID string
	var credits, refunded, disputed int64
	err = tx.QueryRow(ctx, `SELECT id, user_id, credits_micros, refunded_micros, disputed_micros
		FROM credit_purchases WHERE stripe_payment_intent_id = $1 FOR UPDATE`, paymentIntentID).
		Scan(&id, &userID, &credits, &refunded, &disputed)
	if isNoRows(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	value, delta := next(credits, refunded, disputed)
	if delta == 0 {
		return "", nil
	}
	if _, err := tx.Exec(ctx, `UPDATE credit_purchases SET `+column+` = $2 WHERE id = $1`, id, value); err != nil {
		return "", err
	}
	if err := addPurchasedTx(ctx, tx, userID, delta); err != nil {
		return "", err
	}
	return userID, tx.Commit(ctx)
}
