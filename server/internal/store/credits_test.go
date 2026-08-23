package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/evonotes/server/internal/models"
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

func TestBeginThenSettleWritesMeasuredCost(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	id, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
	if err != nil {
		t.Fatal(err)
	}
	held := mustBalance(t, s, userID)
	if held.ReservedMicros != 0 || held.UsedMicros != 0 {
		t.Fatalf("after begin: used=%d reserved=%d", held.UsedMicros, held.ReservedMicros)
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

	id, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
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

func TestBeginSpendRejectsWhenUsedAtLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros)
		VALUES ($1, $2)`, userID, limit); err != nil {
		t.Fatal(err)
	}
	_, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
	var exhausted *CreditsExhaustedError
	if !errors.As(err, &exhausted) {
		t.Fatalf("begin at limit: %v", err)
	}
}

func TestBeginSpendCapsOpenLeases(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	var ids []string
	var errs []error
	for range ConcurrentLLMLeases + 1 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			id, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
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

	if len(ids) != ConcurrentLLMLeases || len(errs) != 1 {
		t.Fatalf("concurrent begin: %d succeeded, %d failed, want %d and 1",
			len(ids), len(errs), ConcurrentLLMLeases)
	}
	if !errors.Is(errs[0], ErrTooManyLLMLeases) {
		t.Fatalf("losing begin error = %v, want ErrTooManyLLMLeases", errs[0])
	}
	got := mustBalance(t, s, userID)
	if got.ReservedMicros != 0 {
		t.Fatalf("reserved=%d, want 0", got.ReservedMicros)
	}
}

func TestSweepThenLateSettleChargesOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	id, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
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

	id, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
	if err != nil {
		t.Fatalf("begin against last month's full balance: %v", err)
	}
	got := mustBalance(t, s, userID)
	if got.UsedMicros != 0 || got.ReservedMicros != 0 {
		t.Fatalf("after rollover begin: used=%d reserved=%d", got.UsedMicros, got.ReservedMicros)
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

func TestBeginIngestSpendCapsAndSettles(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)

	var ids []string
	for range ConcurrentIngestLeases {
		id, err := s.BeginIngestSpend(ctx, userID, "")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if _, err := s.BeginIngestSpend(ctx, userID, ""); !errors.Is(err, ErrTooManyIngestLeases) {
		t.Fatalf("21st ingest lease: %v", err)
	}
	slots, err := s.IngestSlots(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != ConcurrentIngestLeases || slots.SlotsFree != 0 {
		t.Fatalf("slots %#v", slots)
	}

	chatID, err := s.BeginSpend(ctx, userID, "", SurfaceChat)
	if err != nil {
		t.Fatalf("ingest leases must not consume LLM slots: %v", err)
	}
	if err := s.ReleaseCredits(ctx, chatID); err != nil {
		t.Fatal(err)
	}

	if err := s.SettleCredits(ctx, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.ReleaseCredits(ctx, ids[1]); err != nil {
		t.Fatal(err)
	}
	slots, err = s.IngestSlots(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != ConcurrentIngestLeases-2 || slots.SlotsFree != 2 {
		t.Fatalf("after close: %#v", slots)
	}
}

func TestBeginIngestSpendRejectsWhenUsedAtLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros)
		VALUES ($1, $2)`, userID, limit); err != nil {
		t.Fatal(err)
	}
	_, err := s.BeginIngestSpend(ctx, userID, "")
	var exhausted *CreditsExhaustedError
	if !errors.As(err, &exhausted) {
		t.Fatalf("begin ingest at limit: %v", err)
	}
}

func TestSweepReleasesOrphanIngestReservation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	id, err := s.BeginIngestSpend(ctx, userID, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE credit_reservations
		SET created_at = now() - interval '25 hours' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	released, err := s.SweepExpiredReservations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if released < 1 {
		t.Fatalf("orphan ingest not swept: %d", released)
	}
	slots, err := s.IngestSlots(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != 0 {
		t.Fatalf("orphan still counted: %#v", slots)
	}
}

func TestCreateSourceWithJobTakesIngestLease(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	owner := newBlobTestUser(t, s, "u_ingest_lease")
	ws, err := s.CreateWorkspace(ctx, owner, "Ingest lease", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}

	f, _, err := s.CreateSourceWithJob(ctx, ws.ID, owner, "notes.md", "md",
		nil, "", 1, "sources/"+uid("blob"), "", "", "none", false)
	if err != nil {
		t.Fatal(err)
	}
	slots, err := s.IngestSlots(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != 1 || slots.SlotsFree != ConcurrentIngestLeases-1 {
		t.Fatalf("after ingest enqueue: %#v", slots)
	}

	var reservationID string
	if err := s.pool.QueryRow(ctx,
		`SELECT payload->>'reservationId' FROM jobs WHERE payload->>'fileId'=$1`,
		f.ID,
	).Scan(&reservationID); err != nil {
		t.Fatal(err)
	}
	if reservationID == "" {
		t.Fatal("job payload missing reservationId")
	}

	if _, err := s.CreateSourceReady(ctx, ws.ID, owner, "clip.mp3", "audio",
		nil, "", 1, "sources/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	slots, err = s.IngestSlots(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != 1 {
		t.Fatalf("store-only file took an ingest slot: %#v", slots)
	}
}

func TestCreateSourceWithJobWithoutRegistryLeavesNoLease(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_ingest_noreg")
	ws, err := s.CreateWorkspace(ctx, owner, "No registry", ColorGreen, []TagRef{})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = s.CreateSourceWithJob(ctx, ws.ID, owner, "notes.md", "md",
		nil, "", 1, "sources/"+uid("blob"), "", "", "none", false)
	if !errors.Is(err, ErrIngestUnpinnable) {
		t.Fatalf("err = %v, want ErrIngestUnpinnable", err)
	}
	slots, err := s.IngestSlots(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if slots.SlotsUsed != 0 {
		t.Fatalf("rolled-back enqueue left a lease: %#v", slots)
	}
}
