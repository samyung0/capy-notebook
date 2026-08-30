package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/obs"
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

func platformSessionRates() (TokenRates, TokenRates) {
	return TokenRates{Model: models.Ref{ProviderSlug: "test", ModelSlug: "test-llm"}, ModelVersion: 1},
		TokenRates{Model: models.Ref{ProviderSlug: "test", ModelSlug: "test-embed"}, ModelVersion: 1}
}

func mustBeginPlatformSession(t *testing.T, ctx context.Context, s *Store, userID string) string {
	t.Helper()
	llm, embed := platformSessionRates()
	id, err := s.BeginProviderSession(
		ctx, userID, "", SurfaceChat, models.PaidByPlatform, llm, embed, "",
	)
	if err != nil {
		t.Fatal(err)
	}
	return id
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

func mustInsertProviderCall(
	t *testing.T,
	s *Store,
	sessionID string,
	call ProviderCallUsage,
) {
	t.Helper()
	ctx := context.Background()
	if call.Purpose == "terminal" {
		if _, err := s.pool.Exec(ctx, `UPDATE provider_sessions
			SET terminal_call_id=$2 WHERE id=$1`, sessionID, call.CallID); err != nil {
			t.Fatal(err)
		}
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO provider_calls
			(id, reservation_id, actor_user_id, kind, purpose, thinking)
		SELECT $2, id, actor_user_id, $3, $4, $5
		FROM provider_sessions WHERE id=$1`,
		sessionID, call.CallID, call.Kind, call.Purpose, call.Thinking)
	if err != nil {
		t.Fatal(err)
	}
	if tag.RowsAffected() != 1 {
		t.Fatalf("provider session %q was not found", sessionID)
	}
}

func TestProviderSessionSettlesEachCallOnceAndReportsTerminalState(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, reserved_micros)
		VALUES ($1, $2)`, userID, limit-1); err != nil {
		t.Fatal(err)
	}
	llmCfg, err := reg.Get(ctx, models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	llm := RatesFromConfig(llmCfg)
	embed := TokenRates{Model: models.Ref{ProviderSlug: "openrouter", ModelSlug: "qwen/qwen3-embedding-4b"}, ModelVersion: 1}
	sessionID, err := s.BeginProviderSession(
		ctx,
		userID,
		"",
		SurfaceChat,
		models.PaidByPlatform,
		llm,
		embed,
		"",
	)
	if err != nil {
		t.Fatal(err)
	}

	first := ProviderCallUsage{
		CallID:      "pc_1",
		Kind:        KindLLM,
		Purpose:     "agent",
		Thinking:    models.ThinkingHigh,
		Provider:    "deepseek",
		Model:       "deepseek-v4-flash",
		InputTokens: 1,
	}
	if _, err := s.SettleProviderCall(ctx, sessionID, first); !errors.Is(
		err,
		ErrProviderCallConflict,
	) {
		t.Fatalf("settlement without authorized stub: %v", err)
	}
	mustInsertProviderCall(t, s, sessionID, first)
	settlement, err := s.SettleProviderCall(ctx, sessionID, first)
	if err != nil {
		t.Fatal(err)
	}
	if !settlement.CreditsExhausted || !settlement.TerminalCallAllowed {
		t.Fatalf("first settlement = %#v", settlement)
	}
	var callThinking, eventThinking string
	if err := s.pool.QueryRow(ctx,
		`SELECT thinking FROM provider_calls WHERE id=$1`, first.CallID,
	).Scan(&callThinking); err != nil {
		t.Fatal(err)
	}
	if err := s.pool.QueryRow(ctx,
		`SELECT thinking FROM usage_events WHERE provider_call_id=$1`, first.CallID,
	).Scan(&eventThinking); err != nil {
		t.Fatal(err)
	}
	if callThinking != models.ThinkingHigh || eventThinking != models.ThinkingHigh {
		t.Fatalf("call thinking = %q, event thinking = %q", callThinking, eventThinking)
	}
	balance := mustBalance(t, s, userID)
	used := balance.UsedMicros
	if used >= limit || balance.ReservedMicros != limit-1 {
		t.Fatalf("post-call balance = %#v, want used below limit and reservation retained", balance)
	}
	duplicate, err := s.SettleProviderCall(ctx, sessionID, first)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Duplicate || mustBalance(t, s, userID).UsedMicros != used {
		t.Fatalf("duplicate settlement = %#v", duplicate)
	}

	embeddingCall := ProviderCallUsage{
		CallID:      "pc_embed",
		Kind:        KindEmbedding,
		Purpose:     "embedding",
		Provider:    "openrouter",
		Model:       "qwen/qwen3-embedding-4b",
		InputTokens: 20,
	}
	mustInsertProviderCall(t, s, sessionID, embeddingCall)
	embedding, err := s.SettleProviderCall(ctx, sessionID, embeddingCall)
	if err != nil {
		t.Fatal(err)
	}
	if !embedding.CreditsExhausted || !embedding.TerminalCallAllowed {
		t.Fatalf("embedding settlement = %#v", embedding)
	}
	if mustBalance(t, s, userID).UsedMicros != used {
		t.Fatal("query embedding changed actor credits")
	}
	terminalCall := ProviderCallUsage{
		CallID:       "pc_terminal",
		Kind:         KindLLM,
		Purpose:      "terminal",
		Thinking:     models.ThinkingInstant,
		Provider:     "deepseek",
		Model:        "deepseek-v4-flash",
		OutputTokens: 1,
	}
	mustInsertProviderCall(t, s, sessionID, terminalCall)
	terminal, err := s.SettleProviderCall(ctx, sessionID, terminalCall)
	if err != nil {
		t.Fatal(err)
	}
	if !terminal.CreditsExhausted || terminal.TerminalCallAllowed {
		t.Fatalf("terminal settlement = %#v", terminal)
	}
	if err := s.SettleCredits(ctx, sessionID); err != nil {
		t.Fatal(err)
	}
	if n := eventCount(t, s, userID, sessionID); n != 3 {
		t.Fatalf("provider call rows = %d, want 3", n)
	}
}

func TestAudioProviderCallSettlesRoundedSecondsOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	sessionID := mustBeginPlatformSession(t, ctx, s, userID)
	call := ProviderCallUsage{
		CallID:   "pc_audio",
		Kind:     KindAudio,
		Purpose:  "transcription",
		Provider: "elevenlabs",
		Model:    "transcribe-1",
		Units:    4,
		Unit:     "seconds",
	}
	mustInsertProviderCall(t, s, sessionID, call)

	if _, err := s.SettleProviderCall(ctx, sessionID, call); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SettleProviderCall(ctx, sessionID, call); err != nil {
		t.Fatal(err)
	}
	var kind, unit string
	var units, credits int64
	if err := s.pool.QueryRow(ctx, `
		SELECT kind, units, unit, credit_micros FROM usage_events
		WHERE reservation_id=$1 AND provider_call_id=$2`, sessionID, call.CallID,
	).Scan(&kind, &units, &unit, &credits); err != nil {
		t.Fatal(err)
	}
	if kind != KindAudio || units != 4 || unit != "seconds" || credits != 1_000_000 {
		t.Fatalf("audio usage = %q %d %q %d", kind, units, unit, credits)
	}
	if n := eventCount(t, s, userID, sessionID); n != 1 {
		t.Fatalf("audio provider rows = %d, want 1", n)
	}
}

func TestUserKeyProviderSessionRecordsZeroCreditCallsPastPlatformLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros)
		VALUES ($1, $2)`, userID, limit); err != nil {
		t.Fatal(err)
	}
	sessionID, err := s.BeginProviderSession(
		ctx,
		userID,
		"",
		SurfaceChat,
		models.PaidByUser,
		TokenRates{Model: models.Ref{ProviderSlug: "openai", ModelSlug: "gpt-byok"}, ModelVersion: 1},
		TokenRates{Model: models.Ref{ProviderSlug: "openrouter", ModelSlug: "qwen/qwen3-embedding-4b"}, ModelVersion: 1},
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	call := ProviderCallUsage{
		CallID:      "pc_byok",
		Kind:        KindLLM,
		Purpose:     "agent",
		Thinking:    models.ThinkingInstant,
		InputTokens: 100,
	}
	mustInsertProviderCall(t, s, sessionID, call)
	settlement, err := s.SettleProviderCall(ctx, sessionID, call)
	if err != nil {
		t.Fatal(err)
	}
	if settlement.CreditsExhausted || settlement.TerminalCallAllowed {
		t.Fatalf("BYOK settlement = %#v", settlement)
	}
	if got := mustBalance(t, s, userID).UsedMicros; got != limit {
		t.Fatalf("BYOK changed credits: %d", got)
	}
}

func TestClosedProviderSessionAcceptsLateReceiptWithoutContinuation(t *testing.T) {
	s := openAccessTestStore(t)
	const traceID = "0123456789abcdef0123456789abcdef"
	ctx := obs.WithTrace(context.Background(), traceID, "0123456789abcdef")
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	limit := CreditLimitMicros(PlanFree)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros)
		VALUES ($1, $2)`, userID, limit-1); err != nil {
		t.Fatal(err)
	}
	llmCfg, err := reg.Get(ctx, models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	sessionID, err := s.BeginProviderSession(
		ctx,
		userID,
		"",
		SurfaceChat,
		models.PaidByPlatform,
		RatesFromConfig(llmCfg),
		TokenRates{Model: models.Ref{ProviderSlug: "openrouter", ModelSlug: "qwen/qwen3-embedding-4b"}, ModelVersion: 1},
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	call := ProviderCallUsage{
		CallID:      "pc_late",
		Kind:        KindLLM,
		Purpose:     "agent",
		Thinking:    models.ThinkingInstant,
		Provider:    "deepseek",
		Model:       "deepseek-v4-flash",
		InputTokens: 1,
	}
	mustInsertProviderCall(t, s, sessionID, call)
	if err := s.ReleaseCredits(ctx, sessionID); err != nil {
		t.Fatal(err)
	}
	settlement, err := s.SettleProviderCall(ctx, sessionID, call)
	if err != nil {
		t.Fatal(err)
	}
	if !settlement.CreditsExhausted || settlement.TerminalCallAllowed {
		t.Fatalf("late settlement = %#v", settlement)
	}
	duplicate, err := s.SettleProviderCall(ctx, sessionID, call)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Duplicate || duplicate.TerminalCallAllowed {
		t.Fatalf("late duplicate = %#v", duplicate)
	}
	if n := eventCount(t, s, userID, sessionID); n != 1 {
		t.Fatalf("late provider call rows = %d, want 1", n)
	}
	var recordedTrace string
	if err := s.pool.QueryRow(ctx, `
		SELECT COALESCE(trace_id, '') FROM usage_events
		WHERE reservation_id=$1 AND provider_call_id=$2`,
		sessionID, call.CallID,
	).Scan(&recordedTrace); err != nil {
		t.Fatal(err)
	}
	if recordedTrace != traceID {
		t.Fatalf("late receipt trace = %q, want %q", recordedTrace, traceID)
	}
}

func providerCallStatus(t *testing.T, s *Store, callID string) (status string, credits int64) {
	t.Helper()
	err := s.pool.QueryRow(context.Background(), `
		SELECT status, credit_micros FROM provider_calls WHERE id=$1`,
		callID).Scan(&status, &credits)
	if err != nil {
		t.Fatal(err)
	}
	return status, credits
}

func TestBeginProviderSessionRejectsWhenUsedOrReservedAtLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	limit := CreditLimitMicros(PlanFree)
	llm, embed := platformSessionRates()

	usedID := newCreditsTestUser(t, s)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits (user_id, used_micros)
		VALUES ($1, $2)`, usedID, limit); err != nil {
		t.Fatal(err)
	}
	_, err := s.BeginProviderSession(
		ctx, usedID, "", SurfaceChat, models.PaidByPlatform, llm, embed, "",
	)
	var usedExhausted *CreditsExhaustedError
	if !errors.As(err, &usedExhausted) {
		t.Fatalf("used at limit: %v", err)
	}

	reservedID := newCreditsTestUser(t, s)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits
		(user_id, used_micros, reserved_micros) VALUES ($1, 0, $2)`, reservedID, limit); err != nil {
		t.Fatal(err)
	}
	_, err = s.BeginProviderSession(
		ctx, reservedID, "", SurfaceChat, models.PaidByPlatform, llm, embed, "",
	)
	var reservedExhausted *CreditsExhaustedError
	if !errors.As(err, &reservedExhausted) {
		t.Fatalf("reserved at limit: %v", err)
	}
	if reservedExhausted.ReservedMicros != limit {
		t.Fatalf("reserved error reserved=%d, want %d", reservedExhausted.ReservedMicros, limit)
	}
}

func TestBeginProviderSessionCapsOpenLeases(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	llm, embed := platformSessionRates()

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
			id, err := s.BeginProviderSession(
				ctx, userID, "", SurfaceChat, models.PaidByPlatform, llm, embed, "",
			)
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

func TestSweepThenLateProviderCallChargesOnce(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	userID := newCreditsTestUser(t, s)
	llmCfg, err := reg.Get(ctx, models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	sessionID, err := s.BeginProviderSession(
		ctx,
		userID,
		"",
		SurfaceChat,
		models.PaidByPlatform,
		RatesFromConfig(llmCfg),
		TokenRates{Model: models.Ref{ProviderSlug: "openrouter", ModelSlug: "qwen/qwen3-embedding-4b"}, ModelVersion: 1},
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	call := ProviderCallUsage{
		CallID:      "pc_swept",
		Kind:        KindLLM,
		Purpose:     "agent",
		Thinking:    models.ThinkingInstant,
		Provider:    "deepseek",
		Model:       "deepseek-v4-flash",
		InputTokens: 1,
	}
	mustInsertProviderCall(t, s, sessionID, call)
	if _, err := s.pool.Exec(ctx, `UPDATE provider_sessions
		SET expires_at = now() - interval '1 second' WHERE id=$1`, sessionID); err != nil {
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

	settlement, err := s.SettleProviderCall(ctx, sessionID, call)
	if err != nil {
		t.Fatal(err)
	}
	if settlement.TerminalCallAllowed {
		t.Fatalf("swept session must not continue: %#v", settlement)
	}
	duplicate, err := s.SettleProviderCall(ctx, sessionID, call)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Duplicate {
		t.Fatalf("late duplicate = %#v", duplicate)
	}
	if n := eventCount(t, s, userID, sessionID); n != 1 {
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

	id := mustBeginPlatformSession(t, ctx, s, userID)
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
		UsageEvent{ActorUserID: userID, Kind: KindLLM, Surface: SurfaceChat, CatalogModel: models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}, CreditMicros: 1_000_000, InputTokens: 10, OutputTokens: 4},
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

	chatID := mustBeginPlatformSession(t, ctx, s, userID)
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
		t.Fatalf("begin ingest at used limit: %v", err)
	}

	reservedID := newCreditsTestUser(t, s)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_credits
		(user_id, used_micros, reserved_micros) VALUES ($1, 0, $2)`, reservedID, limit); err != nil {
		t.Fatal(err)
	}
	_, err = s.BeginIngestSpend(ctx, reservedID, "")
	if !errors.As(err, &exhausted) {
		t.Fatalf("begin ingest at reserved limit: %v", err)
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
	if _, err := s.pool.Exec(ctx, `UPDATE provider_sessions
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

	var reservationID, processingRoute string
	if err := s.pool.QueryRow(ctx,
		`SELECT payload->>'reservationId', payload->'processingPlan'->>'route'
		 FROM jobs WHERE payload->>'fileId'=$1`,
		f.ID,
	).Scan(&reservationID, &processingRoute); err != nil {
		t.Fatal(err)
	}
	if reservationID == "" {
		t.Fatal("job payload missing reservationId")
	}
	if processingRoute != "raw_text" {
		t.Fatalf("processing route = %q, want raw_text", processingRoute)
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
