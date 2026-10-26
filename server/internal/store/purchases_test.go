package store

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const credit = int64(MicrosPerCredit)

// seedCredits sets one user's counter for this month.
func seedCredits(t *testing.T, s *Store, userID string, used, purchased int64) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO user_credits
		(user_id, used_micros, purchased_micros) VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET used_micros = $2, purchased_micros = $3`,
		userID, used, purchased); err != nil {
		t.Fatal(err)
	}
}

// enableReload turns auto-reload on with a saved card and a Stripe customer.
func enableReload(t *testing.T, s *Store, userID string, amountCents int64, limitCents *int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.pool.Exec(ctx, `UPDATE users SET stripe_customer_id = $2 WHERE id = $1`,
		userID, "cus_"+userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE user_credits SET auto_reload_enabled = true,
		reload_amount_cents = $2, reload_pm_id = 'pm_test', reload_pm_type = 'card',
		spending_limit_cents = $3 WHERE user_id = $1`, userID, amountCents, limitCents); err != nil {
		t.Fatal(err)
	}
}

func TestSpendTakesAllowanceThenPurchasedAndOwesTheRest(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	limit := mustPlanLimits(t, s, PlanFree).CreditMicros
	seedCredits(t, s, userID, limit-10*credit, 50*credit)

	if err := s.RecordUsage(ctx, UsageEvent{
		ActorUserID: userID, Kind: KindLLM, Surface: SurfaceChat, CreditMicros: 100 * credit,
	}); err != nil {
		t.Fatal(err)
	}
	got := mustBalance(t, s, userID)
	if got.UsedMicros != limit || got.PurchasedMicros != -40*credit {
		t.Fatalf("used=%d purchased=%d, want %d and -40 credits owed", got.UsedMicros, got.PurchasedMicros, limit)
	}
	var exhausted *CreditsExhaustedError
	if err := s.AssertCreditsAvailable(ctx, userID); !errors.As(err, &exhausted) {
		t.Fatalf("owing credits admitted new work: %v", err)
	}
}

func TestRolloverTakesOwedCreditsFromTheNewAllowance(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	limit := mustPlanLimits(t, s, PlanFree).CreditMicros
	cases := []struct {
		name                    string
		owed                    int64
		wantUsed, wantPurchased int64
	}{
		{"allowance covers it", 40 * credit, 40 * credit, 0},
		{"more than the allowance stays owed", limit + 5*credit, limit, -5 * credit},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			userID := newCreditsTestUser(t, s)
			if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits
				(user_id, period_start, used_micros, purchased_micros)
				VALUES ($1, date_trunc('month', now())::date - interval '1 month', $2, $3)`,
				userID, limit, -tc.owed); err != nil {
				t.Fatal(err)
			}
			shown := mustBalance(t, s, userID)
			tx, err := s.pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			rolled, err := s.lockedCreditUsageTx(ctx, tx, userID)
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			for _, got := range []CreditUsage{shown, rolled} {
				if got.UsedMicros != tc.wantUsed || got.PurchasedMicros != tc.wantPurchased ||
					got.CarriedMicros != tc.wantUsed {
					t.Fatalf("used=%d purchased=%d carried=%d, want %d/%d/%d",
						got.UsedMicros, got.PurchasedMicros, got.CarriedMicros,
						tc.wantUsed, tc.wantPurchased, tc.wantUsed)
				}
			}
		})
	}
}

func reloadState(t *testing.T, s *Store, userID string) (started bool, armed bool) {
	t.Helper()
	if err := s.pool.QueryRow(context.Background(), `SELECT reload_started_at IS NOT NULL, reload_armed
		FROM user_credits WHERE user_id = $1`, userID).Scan(&started, &armed); err != nil {
		t.Fatal(err)
	}
	return started, armed
}

func TestRequestAtZeroStartsAnArmedReloadForSixtySeconds(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	seedCredits(t, s, userID, mustPlanLimits(t, s, PlanFree).CreditMicros, 0)
	var exhausted *CreditsExhaustedError
	if err := s.AssertCreditsAvailable(ctx, userID); !errors.As(err, &exhausted) {
		t.Fatalf("no reload, nothing left: %v", err)
	}

	enableReload(t, s, userID, 1000, nil)
	if err := s.AssertCreditsAvailable(ctx, userID); err != nil {
		t.Fatalf("the first request at zero starts the reload and is admitted: %v", err)
	}
	if started, armed := reloadState(t, s, userID); !started || armed {
		t.Fatalf("started=%v armed=%v, want a started, disarmed reload", started, armed)
	}
	if err := s.AssertCreditsAvailable(ctx, userID); err != nil {
		t.Fatalf("inside the window: %v", err)
	}
	charge, err := s.StartReload(ctx, userID)
	if err != nil || charge == nil {
		t.Fatalf("the worker charges a reload a request started: charge=%v err=%v", charge, err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE user_credits SET reload_started_at = now() - interval '61 seconds'
		WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if err := s.AssertCreditsAvailable(ctx, userID); !errors.As(err, &exhausted) {
		t.Fatalf("after the 60-second window: %v", err)
	}
}

func TestReloadChargesOncePaidAndBlocksWhileStripeRetries(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	seedCredits(t, s, userID, mustPlanLimits(t, s, PlanFree).CreditMicros, 0)
	enableReload(t, s, userID, 1000, nil)

	charge, err := s.StartReload(ctx, userID)
	if err != nil || charge == nil {
		t.Fatalf("armed reload at the threshold: charge=%v err=%v", charge, err)
	}
	if again, err := s.StartReload(ctx, userID); err != nil || again != nil {
		t.Fatalf("second start while charging: charge=%v err=%v", again, err)
	}
	// Saving the settings keeps the charging reload disarmed.
	if armed, err := s.SetAutoReload(ctx, userID, true, 1000, 0); err != nil || armed {
		t.Fatalf("a save re-armed the charging reload: armed=%v err=%v", armed, err)
	}
	next := time.Now().Add(24 * time.Hour)
	if err := s.MarkReloadFailed(ctx, charge.ID, "in_"+userID, next, "card_declined"); err != nil {
		t.Fatal(err)
	}
	var exhausted *CreditsExhaustedError
	if err := s.AssertCreditsAvailable(ctx, userID); !errors.As(err, &exhausted) {
		t.Fatalf("while Stripe retries, new work at zero is refused: %v", err)
	}
	settings, err := s.CreditSettings(ctx, userID)
	if err != nil || settings.Reload.Status != "retrying" || settings.Reload.NextAttemptAt == nil {
		t.Fatalf("reload state=%+v err=%v", settings.Reload, err)
	}

	for range 2 { // the worker and invoice.paid both report it
		if err := s.MarkReloadPaid(ctx, "", "in_"+userID, "pi_r"+userID); err != nil {
			t.Fatal(err)
		}
	}
	if got := mustBalance(t, s, userID); got.PurchasedMicros != 10_000*credit {
		t.Fatalf("purchased=%d, want one $10 reload of 10,000 credits", got.PurchasedMicros)
	}
	if started, armed := reloadState(t, s, userID); started || !armed {
		t.Fatalf("a paid reload above the threshold re-arms: started=%v armed=%v", started, armed)
	}
}

func TestReloadStripeGaveUpOnWaitsForATopUp(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	limit := mustPlanLimits(t, s, PlanFree).CreditMicros
	seedCredits(t, s, userID, limit, 0)
	enableReload(t, s, userID, 1000, nil)

	charge, err := s.StartReload(ctx, userID)
	if err != nil || charge == nil {
		t.Fatalf("charge=%v err=%v", charge, err)
	}
	// Stripe schedules no retry (a hard decline, or a card it never retries).
	if err := s.MarkReloadFailed(ctx, charge.ID, "in_"+userID, time.Time{}, "card_declined"); err != nil {
		t.Fatal(err)
	}
	var exhausted *CreditsExhaustedError
	if err := s.AssertCreditsAvailable(ctx, userID); !errors.As(err, &exhausted) {
		t.Fatalf("no new reload starts after a failure: %v", err)
	}
	if again, err := s.StartReload(ctx, userID); err != nil || again != nil {
		t.Fatalf("worker must not charge again: charge=%v err=%v", again, err)
	}
	// Turning it off and on again buys no new try; a top-up re-arms it.
	for _, enabled := range []bool{false, true} {
		if armed, err := s.SetAutoReload(ctx, userID, enabled, 1000, 0); err != nil || armed {
			t.Fatalf("enabled=%v armed=%v err=%v, want it left disarmed", enabled, armed, err)
		}
	}
	if _, _, err := s.GrantTopUp(ctx, userID, "cs_"+userID, "pi_"+userID, 800); err != nil {
		t.Fatal(err)
	}
	if _, armed := reloadState(t, s, userID); !armed {
		t.Fatal("a paid top-up re-arms auto-reload")
	}
}

func TestReloadOverTheSpendingLimitIsSkippedAndEmailed(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	seedCredits(t, s, userID, mustPlanLimits(t, s, PlanFree).CreditMicros, 0)
	limit := int64(1500)
	enableReload(t, s, userID, 1000, &limit)
	if _, _, err := s.GrantTopUp(ctx, userID, "cs_"+userID, "pi_"+userID, 800); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE user_credits SET used_micros = $2, purchased_micros = 0
		WHERE user_id = $1`, userID, mustPlanLimits(t, s, PlanFree).CreditMicros); err != nil {
		t.Fatal(err)
	}

	charge, err := s.StartReload(ctx, userID)
	if err != nil || charge == nil || !charge.Skipped {
		t.Fatalf("$8 spent + $10 reload over a $15 limit: charge=%+v err=%v", charge, err)
	}
	var emails int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM email_outbox
		WHERE user_id = $1 AND template = 'credit-reload-skipped'`, userID).Scan(&emails); err != nil {
		t.Fatal(err)
	}
	if emails != 1 {
		t.Fatalf("skip emails=%d, want 1", emails)
	}
	var exhausted *CreditsExhaustedError
	if err := s.AssertCreditsAvailable(ctx, userID); !errors.As(err, &exhausted) {
		t.Fatalf("a skipped reload must not admit work at zero: %v", err)
	}
	err = s.CheckTopUpLimit(ctx, userID, 800)
	var over *SpendingLimitError
	if !errors.As(err, &over) || over.LimitCents != limit || over.ChargingCents != 0 {
		t.Fatalf("manual top-up past the limit: %v", err)
	}
}

func TestTopUpGrantsOnceAndRefundsAndDisputesTakeCreditsBack(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	seedCredits(t, s, userID, 0, 0)
	for range 2 {
		if _, _, err := s.GrantTopUp(ctx, userID, "cs_"+userID, "pi_"+userID, 2000); err != nil {
			t.Fatal(err)
		}
	}
	purchased := func() int64 { return mustBalance(t, s, userID).PurchasedMicros }
	if got := purchased(); got != 20_000*credit {
		t.Fatalf("purchased=%d, want one $20 top-up", got)
	}
	for range 2 { // Stripe reports amount_refunded cumulatively
		if _, err := s.ReverseRefund(ctx, "pi_"+userID, 1000, 2000); err != nil {
			t.Fatal(err)
		}
	}
	if got := purchased(); got != 10_000*credit {
		t.Fatalf("after a half refund purchased=%d", got)
	}
	if _, err := s.HoldDispute(ctx, "pi_"+userID); err != nil {
		t.Fatal(err)
	}
	if got := purchased(); got != 0 {
		t.Fatalf("dispute holds what is left: purchased=%d", got)
	}
	if _, err := s.ReleaseDispute(ctx, "pi_"+userID); err != nil {
		t.Fatal(err)
	}
	if got := purchased(); got != 10_000*credit {
		t.Fatalf("a won dispute gives it back: purchased=%d", got)
	}
}

func TestDisputeBeforeItsPurchaseIsTakenBackOnTheDailyReread(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	seedCredits(t, s, userID, 0, 0)
	if moved, err := s.HoldDispute(ctx, "pi_"+userID); err != nil || moved != "" {
		t.Fatalf("no purchase yet: moved=%q err=%v", moved, err)
	}
	if _, _, err := s.GrantTopUp(ctx, userID, "cs_"+userID, "pi_"+userID, 1000); err != nil {
		t.Fatal(err)
	}
	// The daily reconciliation re-applies it; a second pass changes nothing.
	for pass, want := range []string{userID, ""} {
		moved, err := s.HoldDispute(ctx, "pi_"+userID)
		if err != nil || moved != want {
			t.Fatalf("pass %d: moved=%q err=%v", pass, moved, err)
		}
	}
	if got := mustBalance(t, s, userID).PurchasedMicros; got != 0 {
		t.Fatalf("purchased=%d, want the disputed top-up held", got)
	}
}

func TestDailySyncRereadsUnsettledReloadsWithoutEndingANewWindow(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	seedCredits(t, s, userID, 0, 0)
	insert := func(id, status, age string) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `INSERT INTO credit_purchases
			(id, user_id, kind, status, amount_cents, credits_micros, stripe_invoice_id, created_at)
			VALUES ($1, $2, 'reload', $3, 1000, $4, 'in_'||$1, now() - $5::interval)`,
			id, userID, status, CreditsMicrosForCents(1000), age); err != nil {
			t.Fatal(err)
		}
	}
	insert("cp_"+userID+"_retry", "retrying", "2 days")
	insert("cp_"+userID+"_failed", "failed", "10 days")
	insert("cp_"+userID+"_stuck", "charging", "2 hours")
	insert("cp_"+userID+"_live", "charging", "10 seconds")
	insert("cp_"+userID+"_paid", "paid", "1 day")
	insert("cp_"+userID+"_old", "failed", "100 days")

	reloads, err := s.UnsettledReloads(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range reloads {
		if r.UserID == userID {
			got = append(got, r.ID[len("cp_"+userID+"_"):])
		}
	}
	if len(got) != 3 || slices.Contains(got, "old") || slices.Contains(got, "live") {
		t.Fatalf("re-read %v, want retry, failed and the hour-old charging one", got)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE user_credits SET reload_started_at = now()
		WHERE user_id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkReloadFailed(ctx, "cp_"+userID+"_failed", "", time.Time{}, "expired_card"); err != nil {
		t.Fatal(err)
	}
	if started, _ := reloadState(t, s, userID); !started {
		t.Fatal("re-reading an old failed reload ended the live reload's window")
	}
}

// Security: the starter credits come once per account and once per card. A
// replayed event, a second card on the same account, the same card on another
// account and a method with no card key grant nothing, and concurrent events
// for one account grant once.
func TestStarterCreditsOncePerAccountAndCard(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	first := newCreditsTestUser(t, s)
	second := newCreditsTestUser(t, s)
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM starter_grants WHERE user_id = ANY($1)`,
			[]string{first, second})
	})
	grant := func(userID, cardKey string) bool {
		t.Helper()
		granted, err := s.GrantStarterCredits(ctx, userID, cardKey)
		if err != nil {
			t.Fatal(err)
		}
		return granted
	}
	if got := mustBalance(t, s, first).PurchasedMicros; got != 0 {
		t.Fatalf("new account holds %d purchased micros before any card", got)
	}
	if settings, err := s.CreditSettings(ctx, first); err != nil || !settings.StarterAvailable {
		t.Fatalf("new account starter available=%t err=%v", settings.StarterAvailable, err)
	}
	if !grant(first, "card:fp_a") {
		t.Fatal("first card granted nothing")
	}
	if grant(first, "card:fp_a") || grant(first, "card:fp_b") {
		t.Fatal("the account claimed the starter credits twice")
	}
	if grant(second, "card:fp_a") {
		t.Fatal("one card claimed the starter credits on two accounts")
	}
	if grant(second, "") {
		t.Fatal("a method with no card key claimed the starter credits")
	}
	if got := mustBalance(t, s, first).PurchasedMicros; got != StarterGrantMicros {
		t.Fatalf("first account purchased=%d, want %d", got, StarterGrantMicros)
	}
	if settings, err := s.CreditSettings(ctx, first); err != nil || settings.StarterAvailable {
		t.Fatalf("granted account starter available=%t err=%v", settings.StarterAvailable, err)
	}

	var wg sync.WaitGroup
	var granted atomic.Int32
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := s.GrantStarterCredits(ctx, second, "card:fp_c"+strconv.Itoa(i))
			if err != nil {
				t.Error(err)
			}
			if ok {
				granted.Add(1)
			}
		}()
	}
	wg.Wait()
	if granted.Load() != 1 || mustBalance(t, s, second).PurchasedMicros != StarterGrantMicros {
		t.Fatalf("concurrent cards granted %d times, purchased=%d", granted.Load(),
			mustBalance(t, s, second).PurchasedMicros)
	}
}
