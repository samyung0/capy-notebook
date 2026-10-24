package billing

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v82"

	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// openChargingReload opens the test database with one user whose $10 reload
// on the saved card pm_old is charging, and stubs the Stripe calls: the charge
// answers *outcome (declined, no retry scheduled yet) and voided collects the
// invoices voided.
func openChargingReload(t *testing.T) (*store.Store, store.ReloadCharge, *ReloadResult, *[]string) {
	t.Helper()
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
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_credits
		(user_id, auto_reload_enabled, reload_amount_cents, reload_pm_id, reload_pm_type)
		VALUES ($1, true, 1000, 'pm_old', 'card')`, userID); err != nil {
		t.Fatal(err)
	}
	charge := store.ReloadCharge{ID: "cp_" + userID, UserID: userID, AmountCents: 1000}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO credit_purchases
		(id, user_id, kind, status, amount_cents, credits_micros, reload_pm_id)
		VALUES ($1, $2, 'reload', 'charging', 1000, $3, 'pm_old')`,
		charge.ID, userID, store.CreditsMicrosForCents(1000)); err != nil {
		t.Fatal(err)
	}
	outcome := &ReloadResult{InvoiceID: "in_" + userID, Open: true, DeclineReason: "generic_decline"}
	voided := &[]string{}
	chargeReload = func(store.ReloadCharge) (ReloadResult, error) { return *outcome, nil }
	voidInvoice = func(id string) error {
		*voided = append(*voided, id)
		return nil
	}
	t.Cleanup(func() { chargeReload, voidInvoice = ChargeReload, VoidInvoice })
	return st, charge, outcome, voided
}

func reloadStatus(t *testing.T, st *store.Store, purchaseID string) string {
	t.Helper()
	var s string
	if err := st.Pool().QueryRow(context.Background(), `SELECT status FROM credit_purchases
		WHERE id = $1`, purchaseID).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// The worker reads its declined invoice before Stripe schedules the retry. The
// reload stays charging until Stripe has decided, so one Stripe retries is
// first recorded retrying, which a top-up, a new card or turning auto-reload
// off voids, and never failed.
func TestDeclinedReloadIsRecordedOnceStripeDecides(t *testing.T) {
	ctx := context.Background()
	st, charge, outcome, voided := openChargingReload(t)

	ProcessReload(ctx, st, charge)
	if got := reloadStatus(t, st, charge.ID); got != "charging" {
		t.Fatalf("status = %q right after the decline, want charging until Stripe decides", got)
	}
	// The resume reads the retry Stripe scheduled.
	outcome.NextAttempt = time.Now().Add(24 * time.Hour)
	ProcessReload(ctx, st, charge)
	if got := reloadStatus(t, st, charge.ID); got != "retrying" || len(*voided) != 0 {
		t.Fatalf("status = %q voided = %q, want retrying", got, *voided)
	}
	if voidable, err := st.RetryingReloadInvoices(ctx, charge.UserID); err != nil || len(voidable) != 1 {
		t.Fatalf("reload invoices to void = %v err=%v, want the declined one", voidable, err)
	}
	// An invoice Stripe gave up on (uncollectible) is failed.
	outcome.NextAttempt, outcome.Open = time.Time{}, false
	ProcessReload(ctx, st, charge)
	if got := reloadStatus(t, st, charge.ID); got != "failed" {
		t.Fatalf("status = %q, want failed", got)
	}
}

// Auto-reload turned off, or a new card saved, while a declined reload is
// still charging voids it once Stripe schedules its retry, as the switch and
// the card void a reload already retrying.
func TestReloadGivenUpWhileChargingIsVoidedOnItsRetry(t *testing.T) {
	cases := map[string]func(context.Context, *store.Store, string) error{
		"turned off": func(ctx context.Context, st *store.Store, userID string) error {
			_, err := st.SetAutoReload(ctx, userID, false, 1000, 0)
			return err
		},
		"new card": func(ctx context.Context, st *store.Store, userID string) error {
			return st.SavePaymentMethod(ctx, userID, store.PaymentMethod{ID: "pm_new", Type: "card"}, false)
		},
	}
	for name, giveUp := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			st, charge, outcome, voided := openChargingReload(t)
			ProcessReload(ctx, st, charge)
			if err := giveUp(ctx, st, charge.UserID); err != nil {
				t.Fatal(err)
			}
			outcome.NextAttempt = time.Now().Add(24 * time.Hour)
			ProcessReload(ctx, st, charge)
			if got := reloadStatus(t, st, charge.ID); got != "void" ||
				!slices.Equal(*voided, []string{outcome.InvoiceID}) {
				t.Fatalf("status = %q voided = %q, want the retry voided", got, *voided)
			}
		})
	}
}

// Security: only a card earns the starter credits. A Link method has no card
// key, so it grants nothing and nothing from its email is kept.
func TestPaymentMethodInfoKeysOnlyCards(t *testing.T) {
	card := PaymentMethodInfo(&stripe.PaymentMethod{
		ID: "pm_card", Type: stripe.PaymentMethodTypeCard,
		Card: &stripe.PaymentMethodCard{Fingerprint: "fp_1", Last4: "4242"},
	})
	if card.CardKey != "card:fp_1" {
		t.Fatalf("card key = %q, want card:fp_1", card.CardKey)
	}
	link := PaymentMethodInfo(&stripe.PaymentMethod{
		ID: "pm_link", Type: stripe.PaymentMethodTypeLink,
		Link: &stripe.PaymentMethodLink{Email: "someone@example.test"},
	})
	if link.CardKey != "" {
		t.Fatalf("a Link method got card key %q", link.CardKey)
	}
}
