package store

import (
	"context"
	"time"
)

// creditCheckoutReuseMargin is the time an open credit Checkout must have
// left to be handed out again, so the user can still finish it.
const creditCheckoutReuseMargin = 5 * time.Minute

// OpenCreditCheckout returns the page of the user's open Checkout of kind
// (billing.KindTopUp or KindReloadMethod) for amountCents (0 for the card),
// or "" when there is none to reuse.
func (s *Store) OpenCreditCheckout(ctx context.Context, userID, kind string, amountCents int64) (string, error) {
	var url string
	err := s.pool.QueryRow(ctx, `SELECT url FROM credit_checkouts
		WHERE user_id=$1 AND kind=$2 AND amount_cents=$3 AND expires_at > $4`,
		userID, kind, amountCents, time.Now().Add(creditCheckoutReuseMargin)).Scan(&url)
	if isNoRows(err) {
		return "", nil
	}
	return url, err
}

// RecordCreditCheckout keeps a new credit Checkout for reuse until it expires;
// it replaces the user's earlier one of that kind.
func (s *Store) RecordCreditCheckout(ctx context.Context, userID, kind string, amountCents int64, sessionID, url string, expiresAt time.Time) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO credit_checkouts (user_id, kind, amount_cents, session_id, url, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (user_id, kind) DO UPDATE SET amount_cents=EXCLUDED.amount_cents,
			session_id=EXCLUDED.session_id, url=EXCLUDED.url, expires_at=EXCLUDED.expires_at`,
		userID, kind, amountCents, sessionID, url, expiresAt)
	return err
}

// ForgetCreditCheckout drops a completed credit Checkout so it is not reused.
func (s *Store) ForgetCreditCheckout(ctx context.Context, sessionID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM credit_checkouts WHERE session_id=$1`, sessionID)
	return err
}
