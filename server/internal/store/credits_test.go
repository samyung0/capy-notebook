package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func newCreditsTestUser(t *testing.T, s *Store) string {
	t.Helper()
	ctx := context.Background()
	id := uid("u_cred")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email, plan_tier)
		VALUES ($1, 'Credits Test', $2, $3)`, id, fmt.Sprintf("%s@example.test", id), PlanFree); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id)
	})
	return id
}

func creditSpend(micros int64) UsageEvent {
	return UsageEvent{
		Kind:         KindLLM,
		Surface:      SurfaceChat,
		Provider:     "deepseek",
		Model:        "test",
		InputTokens:  1,
		OutputTokens: 1,
		Unit:         "tokens",
		CreditMicros: micros,
	}
}

func mustBalance(t *testing.T, s *Store, userID string) CreditUsage {
	t.Helper()
	usage, err := s.CreditBalance(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return usage
}

func eventCount(t *testing.T, s *Store, userID, reservationID string) int64 {
	t.Helper()
	var n int64
	err := s.pool.QueryRow(context.Background(), `
		SELECT count(*) FROM usage_events
		WHERE actor_user_id=$1 AND reservation_id=$2`, userID, reservationID).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestReserveThenSettleReplacesTheHoldWithMeasuredCost(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	id, err := s.ReserveCredits(ctx, userID, "", SurfaceChat, EstimateChatMicros)
	if err != nil {
		t.Fatal(err)
	}
	held := mustBalance(t, s, userID)
	if held.ReservedMicros != EstimateChatMicros || held.UsedMicros != 0 {
		t.Fatalf("after reserve: used=%d reserved=%d", held.UsedMicros, held.ReservedMicros)
	}

	const spent int64 = 1_500_000
	if err := s.SettleCredits(ctx, id, creditSpend(spent)); err != nil {
		t.Fatal(err)
	}
	got := mustBalance(t, s, userID)
	if got.ReservedMicros != 0 || got.UsedMicros != spent {
		t.Fatalf("after settle: used=%d reserved=%d, want used=%d reserved=0",
			got.UsedMicros, got.ReservedMicros, spent)
	}
	if n := eventCount(t, s, userID, id); n != 1 {
		t.Fatalf("ledger rows = %d, want 1", n)
	}
}

func TestSettleCreditsTwiceDoesNotDoubleCharge(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	id, err := s.ReserveCredits(ctx, userID, "", SurfaceChat, EstimateChatMicros)
	if err != nil {
		t.Fatal(err)
	}
	const spent int64 = 2_000_000
	event := creditSpend(spent)
	if err := s.SettleCredits(ctx, id, event); err != nil {
		t.Fatal(err)
	}
	if err := s.SettleCredits(ctx, id, event); err != nil {
		t.Fatal(err)
	}

	got := mustBalance(t, s, userID)
	if got.UsedMicros != spent || got.ReservedMicros != 0 {
		t.Fatalf("retry charged again: used=%d reserved=%d, want used=%d reserved=0",
			got.UsedMicros, got.ReservedMicros, spent)
	}
	if n := eventCount(t, s, userID, id); n != 1 {
		t.Fatalf("ledger rows = %d, want 1", n)
	}
}

func TestConcurrentReservesAtTheRemainingBudgetBoundaryAdmitOne(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	// Leave room for exactly one EstimateChatMicros hold. The gate is
	// used+reserved+estimate > limit, so equality is still admitted.
	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros)
		VALUES ($1, $2)`, userID, limit-EstimateChatMicros); err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	var ids []string
	var errs []error
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			id, err := s.ReserveCredits(ctx, userID, "", SurfaceChat, EstimateChatMicros)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errs = append(errs, err)
				return
			}
			ids = append(ids, id)
		}()
	}
	close(start)
	wg.Wait()

	if len(ids) != 1 || len(errs) != 1 {
		t.Fatalf("concurrent reserve: %d succeeded, %d failed, want 1 and 1", len(ids), len(errs))
	}
	var exhausted *CreditsExhaustedError
	if !errors.As(errs[0], &exhausted) {
		t.Fatalf("losing reserve error = %v, want CreditsExhaustedError", errs[0])
	}
	got := mustBalance(t, s, userID)
	if got.ReservedMicros != EstimateChatMicros {
		t.Fatalf("reserved=%d, want the single admitted hold %d", got.ReservedMicros, EstimateChatMicros)
	}
}

func TestSweepThenLateSettleChargesOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	id, err := s.ReserveCredits(ctx, userID, "", SurfaceChat, EstimateChatMicros)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE credit_reservations
		SET expires_at = now() - interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}

	released, err := s.SweepExpiredReservations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if released < 1 {
		t.Fatalf("sweeper released %d, want at least this reservation", released)
	}
	afterSweep := mustBalance(t, s, userID)
	if afterSweep.ReservedMicros != 0 || afterSweep.UsedMicros != 0 {
		t.Fatalf("after sweep: used=%d reserved=%d, want both 0",
			afterSweep.UsedMicros, afterSweep.ReservedMicros)
	}

	const spent int64 = 900_000
	event := creditSpend(spent)
	if err := s.SettleCredits(ctx, id, event); err != nil {
		t.Fatal(err)
	}
	if err := s.SettleCredits(ctx, id, event); err != nil {
		t.Fatal(err)
	}

	got := mustBalance(t, s, userID)
	if got.UsedMicros != spent || got.ReservedMicros != 0 {
		t.Fatalf("late settle: used=%d reserved=%d, want used=%d reserved=0",
			got.UsedMicros, got.ReservedMicros, spent)
	}
	if n := eventCount(t, s, userID, id); n != 1 {
		t.Fatalf("ledger rows = %d, want 1", n)
	}
}

func TestStalePeriodDoesNotBlockTheNewMonth(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits
		(user_id, period_start, used_micros)
		VALUES ($1, date_trunc('month', now())::date - interval '1 month', $2)`,
		userID, limit); err != nil {
		t.Fatal(err)
	}

	reported := mustBalance(t, s, userID)
	if reported.UsedMicros != 0 {
		t.Fatalf("CreditBalance used=%d, want 0 for a lapsed period", reported.UsedMicros)
	}

	id, err := s.ReserveCredits(ctx, userID, "", SurfaceChat, EstimateChatMicros)
	if err != nil {
		t.Fatalf("reserve against last month's full balance: %v", err)
	}
	got := mustBalance(t, s, userID)
	if got.UsedMicros != 0 || got.ReservedMicros != EstimateChatMicros {
		t.Fatalf("after rollover reserve: used=%d reserved=%d", got.UsedMicros, got.ReservedMicros)
	}
	if err := s.ReleaseCredits(ctx, id); err != nil {
		t.Fatal(err)
	}
}

func TestGetBillingIncludesCreditCounters(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	info, err := s.GetBilling(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if info.CreditsLimitMicros != CreditLimitMicros(PlanFree) {
		t.Fatalf("limit=%d, want free allowance", info.CreditsLimitMicros)
	}
	if info.CreditsUsedMicros != 0 || info.CreditsReservedMicros != 0 {
		t.Fatalf("fresh user used=%d reserved=%d", info.CreditsUsedMicros, info.CreditsReservedMicros)
	}
	if info.CreditsPeriodStart.IsZero() {
		t.Fatal("creditsPeriodStart should be set")
	}

	if err := s.RecordUsage(ctx, UsageEvent{
		ActorUserID:  userID,
		Kind:         KindLLM,
		Surface:      SurfaceChat,
		CreditMicros: 2_500_000,
	}); err != nil {
		t.Fatal(err)
	}
	info, err = s.GetBilling(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if info.CreditsUsedMicros != 2_500_000 {
		t.Fatalf("used=%d after record", info.CreditsUsedMicros)
	}
}

func TestUserUsageReportScopesToActorAndGroupsCurrentPeriod(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	other := newCreditsTestUser(t, s)

	if err := s.RecordUsage(ctx,
		UsageEvent{ActorUserID: userID, Kind: KindLLM, Surface: SurfaceChat, ModelKey: "deepseek-flash", CreditMicros: 1_000_000, InputTokens: 10, OutputTokens: 4},
		UsageEvent{ActorUserID: userID, Kind: KindEmbedding, Surface: SurfaceIngest, CreditMicros: 200_000},
		UsageEvent{ActorUserID: other, Kind: KindLLM, Surface: SurfaceChat, CreditMicros: 9_000_000},
	); err != nil {
		t.Fatal(err)
	}

	report, err := s.UserUsageReport(ctx, userID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Recent) != 2 {
		t.Fatalf("recent=%d, want 2 (other actor excluded)", len(report.Recent))
	}
	var llm, embed int64
	for _, b := range report.ByKind {
		switch b.Key {
		case KindLLM:
			llm = b.CreditMicros
		case KindEmbedding:
			embed = b.CreditMicros
		}
	}
	if llm != 1_000_000 || embed != 200_000 {
		t.Fatalf("byKind llm=%d embed=%d", llm, embed)
	}
	var chat, ingest int64
	for _, b := range report.BySurface {
		switch b.Key {
		case SurfaceChat:
			chat = b.CreditMicros
		case SurfaceIngest:
			ingest = b.CreditMicros
		}
	}
	if chat != 1_000_000 || ingest != 200_000 {
		t.Fatalf("bySurface chat=%d ingest=%d", chat, ingest)
	}
	if report.Recent[0].CreditMicros == 0 && report.Recent[1].CreditMicros == 0 {
		t.Fatal("recent rows should include credit micros, not USD")
	}
}
