package billing

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// The worker reads its declined invoice before Stripe schedules the retry. The
// reload stays charging until Stripe has decided, so one Stripe retries is
// first recorded retrying, which a top-up, a new card or turning auto-reload
// off voids, and never failed.
func TestDeclinedReloadIsRecordedOnceStripeDecides(t *testing.T) {
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	userID := fmt.Sprintf("u_reload_%d", time.Now().UnixNano())
	if _, err := st.Pool().Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
		VALUES ($1, 'Reload Test', $1 || '@example.test', 'free')`, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	charge := store.ReloadCharge{ID: "cp_" + userID, UserID: userID, AmountCents: 1000}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO credit_purchases
		(id, user_id, kind, status, amount_cents, credits_micros, reload_pm_id)
		VALUES ($1, $2, 'reload', 'charging', 1000, $3, 'pm_test')`,
		charge.ID, userID, store.CreditsMicrosForCents(1000)); err != nil {
		t.Fatal(err)
	}
	outcome := ReloadResult{InvoiceID: "in_" + userID, Open: true, DeclineReason: "generic_decline"}
	chargeReload = func(store.ReloadCharge) (ReloadResult, error) { return outcome, nil }
	t.Cleanup(func() { chargeReload = ChargeReload })
	status := func() string {
		t.Helper()
		var s string
		if err := st.Pool().QueryRow(ctx, `SELECT status FROM credit_purchases WHERE id = $1`,
			charge.ID).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}

	// Declined, no retry scheduled yet.
	ProcessReload(ctx, st, charge)
	if got := status(); got != "charging" {
		t.Fatalf("status = %q right after the decline, want charging until Stripe decides", got)
	}
	// The resume reads the retry Stripe scheduled.
	outcome.NextAttempt = time.Now().Add(24 * time.Hour)
	ProcessReload(ctx, st, charge)
	if got := status(); got != "retrying" {
		t.Fatalf("status = %q, want retrying", got)
	}
	if voidable, err := st.RetryingReloadInvoices(ctx, userID); err != nil || len(voidable) != 1 {
		t.Fatalf("reload invoices to void = %v err=%v, want the declined one", voidable, err)
	}
	// An invoice Stripe gave up on (uncollectible) is failed.
	outcome.NextAttempt, outcome.Open = time.Time{}, false
	ProcessReload(ctx, st, charge)
	if got := status(); got != "failed" {
		t.Fatalf("status = %q, want failed", got)
	}
}
