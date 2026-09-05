package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/obs"
)

// A credit is 1000 tokens of the standard chat model. Everything else is
// priced relative to that so one number can be shown to a user.
//
// These are policy, not physics: they are the numbers we charge, deliberately
// decoupled from provider invoices so a provider price change does not silently
// change what users get. Drift against real spend is caught by comparing the
// ledger to provider dashboards, not by deriving one from the other.
const MicrosPerCredit = 1_000_000

// reservationTTL bounds how long an unsettled reservation holds budget. It is
// longer than the pipeline's 90s sync timeout and longer than a realistic chat
// stream, so a settle always wins the race against the sweeper.
const reservationTTL = 30 * time.Minute

var ErrCreditsExhausted = errors.New("llm credits exhausted")

// ErrTooManyLLMLeases means the actor already has ConcurrentLLMLeases
// unsettled platform-paid calls. Distinct from credits exhausted: the budget
// may still have room.
var ErrTooManyLLMLeases = errors.New("too many llm leases")

// ErrTooManyIngestLeases means the actor already has ConcurrentIngestLeases
// pending or running pipeline reservations. Distinct from too-many-llm-leases and from
// credits exhausted.
var ErrTooManyIngestLeases = errors.New("too many ingest leases")

var ErrProviderSessionClosed = errors.New("provider session closed")
var ErrProviderCallConflict = errors.New("provider call id reused with different usage")
var ErrProviderReceiptExpired = errors.New("provider call receipt deadline elapsed")
var ErrTerminalCallNotAllowed = errors.New("terminal provider call not allowed")

// ConcurrentLLMLeases caps unsettled platform-paid model calls per actor.
// Worst-case overshoot is this many in-flight settlements. BYOK does not take
// a lease. Ingest uses ConcurrentIngestLeases instead.
const ConcurrentLLMLeases = 5

// ConcurrentIngestLeases caps pending+running parse/ingest pipelines per actor.
const ConcurrentIngestLeases = 20

// ingestReservationHold is far enough that a live pending job is never
// swept. Orphans with no job row are released after ingestReservationOrphanAge.
const ingestReservationHold = 100 * 365 * 24 * time.Hour
const ingestReservationOrphanAge = 24 * time.Hour

// CreditsExhaustedError is deliberately distinct from QuotaExceededError. They
// render as different sentences: one is "you are out of credits", the other is
// "the owner of this workspace is out of space", and a user can act on only one
// of them.
type CreditsExhaustedError struct {
	UserID          string
	UsedMicros      int64
	ReservedMicros  int64
	RequestedMicros int64
	LimitMicros     int64
	PlanTier        PlanTier
}

func (e *CreditsExhaustedError) Error() string {
	return fmt.Sprintf("%s: used=%d reserved=%d requested=%d limit=%d",
		ErrCreditsExhausted, e.UsedMicros, e.ReservedMicros, e.RequestedMicros, e.LimitMicros)
}

func (e *CreditsExhaustedError) Unwrap() error { return ErrCreditsExhausted }

type CreditUsage struct {
	UserID         string    `json:"userId"`
	UsedMicros     int64     `json:"creditsUsedMicros"`
	ReservedMicros int64     `json:"creditsReservedMicros"`
	LimitMicros    int64     `json:"creditsLimitMicros"`
	PlanTier       PlanTier  `json:"planTier"`
	PeriodStart    time.Time `json:"periodStart"`
}

// UsageBucket is one grouping on the user-facing usage page. Credits only;
// there is no USD estimate on the ledger.
type UsageBucket struct {
	Key          string `json:"key"`
	Events       int64  `json:"events"`
	CreditMicros int64  `json:"creditMicros"`
}

// UsageEventView is one ledger row as shown to the actor who spent it.
type UsageEventView struct {
	CreatedAt    time.Time `json:"createdAt"`
	Kind         string    `json:"kind"`
	Surface      string    `json:"surface"`
	ProviderSlug string    `json:"providerSlug"`
	ModelSlug    string    `json:"modelSlug"`
	InputTokens  int64     `json:"inputTokens"`
	OutputTokens int64     `json:"outputTokens"`
	Units        int64     `json:"units"`
	Unit         string    `json:"unit"`
	CreditMicros int64     `json:"creditMicros"`
}

// UsageReport is the actor's current-period spend plus a recent event list.
// It reads the append-only usage_events ledger for this user.
type UsageReport struct {
	ByKind    []UsageBucket    `json:"byKind" nullable:"false"`
	BySurface []UsageBucket    `json:"bySurface" nullable:"false"`
	Recent    []UsageEventView `json:"recent" nullable:"false"`
}

// UsageEvent is one metered consumption. Token fields are provider-reported;
// Units carries the resource's real billing unit, while parse timing stays in
// typed telemetry fields and does not determine the charge.
type UsageEvent struct {
	TraceID                  string
	ActorUserID              string
	WorkspaceID              string
	Kind                     string
	Surface                  string
	Provider                 string
	Model                    string
	Thinking                 string
	InputTokens              int64
	OutputTokens             int64
	Units                    int64
	Unit                     string
	ParsePages               int64
	ParseOCRPages            int64
	ParseCPUMilliseconds     int64
	ParseElapsedMilliseconds int64
	CreditMicros             int64
	CatalogModel             models.Ref
	ModelVersion             int
	ReservationID            string
	ProviderCallID           string
	IdempotencyKey           string
	Metadata                 map[string]any
}

type ProviderCallUsage struct {
	CallID           string
	Kind             string
	Purpose          string
	Thinking         string
	Provider         string
	Model            string
	InputTokens      int64
	OutputTokens     int64
	Units            int64
	Unit             string
	CachedReadTokens int64
	CacheWriteTokens int64
	ReasoningTokens  int64
	CacheAnomaly     string
}

type ProviderCallSettlement struct {
	CreditsExhausted    bool
	TerminalCallAllowed bool
	Duplicate           bool
}

// Usage kinds and surfaces. Kept as constants because they are the grouping
// keys in every ledger report; a typo creates a silent second category rather
// than an error.
const (
	KindLLM       = "llm"
	KindEmbedding = "embedding"
	KindAudio     = "audio"
	KindCaption   = "caption"
	KindParse     = "parse"
	KindEmail     = "email"
)

const (
	SurfaceChat     = "chat"
	SurfaceGenerate = "generate"
	SurfaceEditor   = "editor"
	SurfaceQuiz     = "quiz"
	SurfaceIngest   = "ingest"
	SurfaceSystem   = "system"
)

/* --------------------------------------------------------------- counter */

func (s *Store) ensureCreditsRowTx(ctx context.Context, tx pgx.Tx, userID string) error {
	if userID == "" {
		return ErrNotFound
	}
	_, err := tx.Exec(ctx, `INSERT INTO user_credits (user_id)
		VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, userID)
	return err
}

// lockedCreditUsageTx reads the counter under a row lock, rolling the period
// over first. The rollover is lazy on purpose: a monthly cron that fails to run
// would hand every user an unlimited month, whereas a read that has not
// happened yet cannot have spent anything.
func (s *Store) lockedCreditUsageTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
) (CreditUsage, error) {
	var usage CreditUsage
	if err := s.ensureCreditsRowTx(ctx, tx, userID); err != nil {
		return usage, err
	}
	tier, err := s.effectivePlanTierForUser(ctx, tx, userID)
	if err != nil {
		return usage, err
	}
	// The UPDATE both takes the lock and resets a stale period in one
	// statement, so two concurrent first-requests of a month cannot both
	// observe the previous period's balance.
	err = tx.QueryRow(ctx, `
		UPDATE user_credits
		SET period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date,
		    used_micros = CASE
		      WHEN period_start < date_trunc('month', now() AT TIME ZONE 'UTC')::date THEN 0
		      ELSE used_micros END,
		    updated_at = now()
		WHERE user_id = $1
		RETURNING used_micros, reserved_micros, period_start`, userID).
		Scan(&usage.UsedMicros, &usage.ReservedMicros, &usage.PeriodStart)
	if err != nil {
		return usage, err
	}
	usage.UserID = userID
	usage.PlanTier = tier
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return usage, err
	}
	usage.LimitMicros = limits.CreditMicros
	return usage, nil
}

// CreditBalance reads without locking, for display and for the operator
// dashboard. The gate must not use this.
func (s *Store) CreditBalance(ctx context.Context, userID string) (CreditUsage, error) {
	var usage CreditUsage
	tier, err := s.effectivePlanTierForUser(ctx, s.pool, userID)
	if err != nil {
		return usage, err
	}
	var periodStart *time.Time
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(c.used_micros, 0),
		       COALESCE(c.reserved_micros, 0),
		       c.period_start
		FROM users u
		LEFT JOIN user_credits c ON c.user_id = u.id
		WHERE u.id = $1`, userID).
		Scan(&usage.UsedMicros, &usage.ReservedMicros, &periodStart)
	if isNoRows(err) {
		return usage, ErrNotFound
	}
	if err != nil {
		return usage, err
	}
	// A row whose period has lapsed has not been rolled over yet; report zero
	// rather than last month's total so the UI matches what the next request
	// will actually be gated against.
	if periodStart != nil {
		usage.PeriodStart = *periodStart
		if periodStart.Before(monthStart()) {
			usage.UsedMicros = 0
			usage.PeriodStart = monthStart()
		}
	} else {
		usage.PeriodStart = monthStart()
	}
	usage.UserID = userID
	usage.PlanTier = tier
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return usage, err
	}
	usage.LimitMicros = limits.CreditMicros
	return usage, nil
}

// AssertCreditsAvailable is an unlocked "is there anything left" check, for
// spend that is already covered by a reservation opened earlier in the same
// request. The chat agent's material-creation tool is the case: the turn was
// reserved when the stream opened, but the loop can run long enough for the
// budget to be exhausted by something else in between.
//
// It deliberately takes no lock and reserves nothing. Using the full gate here
// would double-count the turn against itself.
func (s *Store) AssertCreditsAvailable(ctx context.Context, userID string) error {
	usage, err := s.CreditBalance(ctx, userID)
	if err != nil {
		return err
	}
	return exhaustedIfOverLimit(usage)
}

func exhaustedIfOverLimit(usage CreditUsage) error {
	if usage.UsedMicros+usage.ReservedMicros < usage.LimitMicros {
		return nil
	}
	return &CreditsExhaustedError{
		UserID:         usage.UserID,
		UsedMicros:     usage.UsedMicros,
		ReservedMicros: usage.ReservedMicros,
		LimitMicros:    usage.LimitMicros,
		PlanTier:       usage.PlanTier,
	}
}

func monthStart() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

/* ------------------------------------------------------- begin / settle */

func (s *Store) BeginProviderSession(
	ctx context.Context,
	actorUserID, workspaceID, surface, paidBy string,
	llm, embedding TokenRates,
	thinking string,
) (string, error) {
	if actorUserID == "" {
		return "", ErrNotFound
	}
	if paidBy != models.PaidByPlatform && paidBy != models.PaidByUser {
		return "", fmt.Errorf("invalid paid_by %q", paidBy)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := s.lockAccountSessionsTx(ctx, tx, actorUserID); err != nil {
		return "", err
	}

	if paidBy == models.PaidByPlatform {
		usage, err := s.lockedCreditUsageTx(ctx, tx, actorUserID)
		if err != nil {
			return "", err
		}
		if err := exhaustedIfOverLimit(usage); err != nil {
			return "", err
		}
		var open int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM provider_sessions
			 WHERE actor_user_id = $1 AND status = 'open' AND expires_at > now()
			   AND surface <> $2 AND paid_by = $3`,
			actorUserID, SurfaceIngest, models.PaidByPlatform).Scan(&open); err != nil {
			return "", err
		}
		if open >= ConcurrentLLMLeases {
			return "", ErrTooManyLLMLeases
		}
	}

	id := uid("cr")
	var wsID *string
	if workspaceID != "" {
		wsID = &workspaceID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO provider_sessions
			(id, actor_user_id, workspace_id, trace_id, surface, reserved_micros,
			 paid_by, llm_provider_slug, llm_model_slug, llm_model_version, thinking,
			 llm_micros_per_input_token, llm_micros_per_output_token,
			 llm_micros_per_cached_input_token,
			 embedding_provider_slug, embedding_model_slug, embedding_model_version, expires_at)
		VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
		        now() + ($17 * interval '1 millisecond'))`,
		id, actorUserID, wsID, nullString(obs.TraceID(ctx)), surface, paidBy,
		llm.Model.ProviderSlug, llm.Model.ModelSlug, llm.ModelVersion, thinking,
		llm.MicrosPerInputToken, llm.MicrosPerOutputToken, llm.MicrosPerCachedInputToken,
		embedding.Model.ProviderSlug, embedding.Model.ModelSlug, embedding.ModelVersion,
		reservationTTL.Milliseconds(),
	); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

type providerCallReceipt struct {
	actorUserID    string
	paidBy         string
	status         string
	credits        int64
	exhaustedAt    *time.Time
	terminalCallID *string
	duplicate      bool
}

func (r providerCallReceipt) flags() ProviderCallSettlement {
	exhausted := r.paidBy == models.PaidByPlatform && r.exhaustedAt != nil
	return ProviderCallSettlement{
		CreditsExhausted: exhausted,
		TerminalCallAllowed: r.status == "open" && exhausted &&
			(r.terminalCallID == nil || *r.terminalCallID == ""),
		Duplicate: r.duplicate,
	}
}

func (s *Store) SettleProviderCall(
	ctx context.Context,
	sessionID string,
	call ProviderCallUsage,
) (ProviderCallSettlement, error) {
	var out ProviderCallSettlement
	if sessionID == "" || call.CallID == "" {
		return out, fmt.Errorf("session id and provider call id are required")
	}
	if call.Kind != KindLLM && call.Kind != KindEmbedding && call.Kind != KindAudio {
		return out, fmt.Errorf("invalid provider call kind %q", call.Kind)
	}
	if call.Kind == KindEmbedding && call.Thinking != "" {
		return out, errors.New("embedding provider calls cannot have thinking")
	}
	if call.Kind == KindLLM && !models.IsKnownThinking(call.Thinking) {
		return out, fmt.Errorf("invalid provider call thinking %q", call.Thinking)
	}
	if call.Kind == KindAudio && (call.Thinking != "" || call.Unit != "seconds") {
		return out, errors.New("audio provider calls require second units and no thinking")
	}
	if call.Kind == KindAudio && (call.InputTokens != 0 || call.OutputTokens != 0 ||
		call.CachedReadTokens != 0 || call.CacheWriteTokens != 0 || call.ReasoningTokens != 0) {
		return out, errors.New("audio provider calls cannot carry token usage")
	}
	if call.InputTokens < 0 || call.OutputTokens < 0 || call.CachedReadTokens < 0 ||
		call.CacheWriteTokens < 0 || call.ReasoningTokens < 0 || call.Units < 0 {
		return out, fmt.Errorf("provider usage cannot be negative")
	}
	if call.Kind != KindAudio && (call.Units != 0 || call.Unit != "") {
		return out, errors.New("token provider calls cannot carry non-token units")
	}
	return s.settleProviderCallAtomic(ctx, sessionID, call)
}

// settleProviderCallAtomic records provider usage and updates the derived
// counter in one transaction. A retry observes either all of the prior
// settlement or none of it.
func (s *Store) settleProviderCallAtomic(
	ctx context.Context,
	sessionID string,
	call ProviderCallUsage,
) (ProviderCallSettlement, error) {
	var settlement ProviderCallSettlement
	var out providerCallReceipt
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return settlement, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		workspaceID, surface, traceID string
		llmRef, embeddingRef          models.Ref
		llmVersion, embeddingVersion  int
		snapshotted                   TokenRates
	)
	err = tx.QueryRow(ctx, `
		SELECT actor_user_id, COALESCE(workspace_id, ''), surface, paid_by,
		       COALESCE(trace_id, ''),
		       llm_provider_slug, llm_model_slug, llm_model_version,
		       embedding_provider_slug, embedding_model_slug, embedding_model_version,
		       llm_micros_per_input_token, llm_micros_per_output_token,
		       llm_micros_per_cached_input_token,
		       status, credits_exhausted_at, terminal_call_id
		FROM provider_sessions WHERE id = $1 FOR UPDATE`, sessionID).
		Scan(
			&out.actorUserID, &workspaceID, &surface, &out.paidBy,
			&traceID,
			&llmRef.ProviderSlug, &llmRef.ModelSlug, &llmVersion,
			&embeddingRef.ProviderSlug, &embeddingRef.ModelSlug, &embeddingVersion,
			&snapshotted.MicrosPerInputToken, &snapshotted.MicrosPerOutputToken,
			&snapshotted.MicrosPerCachedInputToken,
			&out.status, &out.exhaustedAt, &out.terminalCallID,
		)
	if isNoRows(err) {
		return settlement, ErrNotFound
	}
	if err != nil {
		return settlement, err
	}

	var stubSession, stubActor, stubKind, stubPurpose, stubThinking, stubStatus string
	var stubExpired bool
	err = tx.QueryRow(ctx, `
		SELECT reservation_id, actor_user_id, kind, purpose, thinking, status,
		       receipt_deadline_at <= now()
		  FROM provider_calls WHERE id=$1 FOR UPDATE`, call.CallID).
		Scan(&stubSession, &stubActor, &stubKind, &stubPurpose, &stubThinking, &stubStatus,
			&stubExpired)
	if isNoRows(err) {
		return settlement, ErrProviderCallConflict
	}
	if err != nil {
		return settlement, err
	}
	if stubSession != sessionID || stubActor != out.actorUserID ||
		stubKind != call.Kind || stubPurpose != call.Purpose || stubThinking != call.Thinking {
		return settlement, ErrProviderCallConflict
	}

	var duplicate bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
		  SELECT 1 FROM usage_events
		  WHERE reservation_id = $1 AND provider_call_id = $2
		)`, sessionID, call.CallID).Scan(&duplicate); err != nil {
		return settlement, err
	}
	if duplicate {
		if stubStatus != "applied" {
			return settlement, ErrProviderCallConflict
		}
		var recorded ProviderCallUsage
		if err := tx.QueryRow(ctx, `
			SELECT kind, COALESCE(metadata->>'purpose', ''), thinking, provider, model,
			       input_tokens, output_tokens, units,
			       CASE WHEN kind = 'audio' THEN unit ELSE '' END,
			       COALESCE((metadata->>'cachedReadTokens')::bigint, 0),
			       COALESCE((metadata->>'cacheWriteTokens')::bigint, 0),
			       COALESCE((metadata->>'reasoningTokens')::bigint, 0),
			       COALESCE(metadata->>'cacheAnomaly', '')
			FROM usage_events
			WHERE reservation_id = $1 AND provider_call_id = $2`,
			sessionID, call.CallID,
		).Scan(
			&recorded.Kind, &recorded.Purpose, &recorded.Thinking, &recorded.Provider, &recorded.Model,
			&recorded.InputTokens, &recorded.OutputTokens, &recorded.Units, &recorded.Unit,
			&recorded.CachedReadTokens, &recorded.CacheWriteTokens,
			&recorded.ReasoningTokens, &recorded.CacheAnomaly,
		); err != nil {
			return settlement, err
		}
		recorded.CallID = call.CallID
		if recorded != call {
			return settlement, ErrProviderCallConflict
		}
		out.duplicate = true
		settlement = out.flags()
		if err := tx.Commit(ctx); err != nil {
			return ProviderCallSettlement{}, err
		}
		return settlement, nil
	}
	if stubStatus == "open" && stubExpired {
		if _, err := tx.Exec(ctx, `UPDATE provider_calls SET
			status='abandoned', abandoned_at=now(),
			error_category='provider', error_code='receipt_timeout'
			WHERE id=$1 AND status='open'`, call.CallID); err != nil {
			return settlement, err
		}
		if stubPurpose == "terminal" {
			if _, err := tx.Exec(ctx, `UPDATE provider_sessions
				SET terminal_call_id=NULL
				WHERE id=$1 AND terminal_call_id=$2`, sessionID, call.CallID); err != nil {
				return settlement, err
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return ProviderCallSettlement{}, err
		}
		return settlement, ErrProviderReceiptExpired
	}
	if out.status != "open" && out.status != "settled" && out.status != "released" {
		return settlement, ErrProviderSessionClosed
	}
	if stubStatus != "open" {
		return settlement, ErrProviderCallConflict
	}
	if call.Purpose == "terminal" &&
		(out.terminalCallID == nil || *out.terminalCallID != call.CallID) {
		return settlement, ErrTerminalCallNotAllowed
	}
	settlement = out.flags()

	rates := TokenRates{}
	catalogModel, modelVersion := llmRef, llmVersion
	if call.Kind == KindEmbedding {
		catalogModel, modelVersion = embeddingRef, embeddingVersion
		if s.registry == nil {
			return settlement, fmt.Errorf("%w: registry not configured", ErrModelUnavailable)
		}
		cfg, err := s.registry.Get(ctx, embeddingRef, embeddingVersion)
		if err != nil {
			return settlement, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
		}
		rates = RatesFromConfig(cfg)
	} else if out.paidBy == models.PaidByPlatform {
		rates = snapshotted
		rates.Model = llmRef
		rates.ModelVersion = llmVersion
	}

	if call.Kind == KindLLM && out.paidBy == models.PaidByPlatform {
		out.credits = CreditsForTokens(
			rates,
			KindLLM,
			call.InputTokens,
			call.OutputTokens,
			call.CachedReadTokens,
		)
	} else if call.Kind == KindAudio && out.paidBy == models.PaidByPlatform {
		var audioRate int64
		if err := tx.QueryRow(ctx, `
				SELECT credit_micros_per_unit
				FROM resource_credit_rates
				WHERE resource_key=$1 AND active`, ResourceAudioSecond).Scan(&audioRate); err != nil {
			return settlement, err
		}
		out.credits = CreditsForAudioSeconds(call.Units, audioRate)
	}
	var balance CreditUsage
	if out.credits > 0 && out.paidBy == models.PaidByPlatform {
		balance, err = s.lockedCreditUsageTx(ctx, tx, out.actorUserID)
		if err != nil {
			return settlement, err
		}
	}
	meta := map[string]any{
		"callId":  call.CallID,
		"purpose": call.Purpose,
		"paidBy":  out.paidBy,
	}
	if call.CachedReadTokens > 0 {
		meta["cachedReadTokens"] = call.CachedReadTokens
	}
	if call.CacheWriteTokens > 0 {
		meta["cacheWriteTokens"] = call.CacheWriteTokens
	}
	if call.ReasoningTokens > 0 {
		meta["reasoningTokens"] = call.ReasoningTokens
	}
	if call.CacheAnomaly != "" {
		meta["cacheAnomaly"] = call.CacheAnomaly
	}
	if (call.Kind == KindLLM || call.Kind == KindEmbedding) && call.InputTokens == 0 && call.OutputTokens == 0 {
		meta["usageMissing"] = true
	}
	usageUnit := "tokens"
	if call.Kind == KindAudio {
		usageUnit = call.Unit
	}
	event := UsageEvent{
		TraceID:        traceID,
		ActorUserID:    out.actorUserID,
		WorkspaceID:    workspaceID,
		Kind:           call.Kind,
		Surface:        surface,
		Provider:       call.Provider,
		Model:          call.Model,
		Thinking:       call.Thinking,
		InputTokens:    call.InputTokens,
		OutputTokens:   call.OutputTokens,
		Units:          call.Units,
		Unit:           usageUnit,
		CreditMicros:   out.credits,
		CatalogModel:   catalogModel,
		ModelVersion:   modelVersion,
		ReservationID:  sessionID,
		ProviderCallID: call.CallID,
		Metadata:       meta,
	}
	inserted, err := insertUsageEventTx(ctx, tx, event)
	if err != nil {
		return settlement, err
	}
	if !inserted {
		return settlement, ErrProviderCallConflict
	}
	tag, err := tx.Exec(ctx, `
		UPDATE provider_calls SET
		  status='applied',
		  provider=$6,
		  model=$7,
		  input_tokens=$8,
		  output_tokens=$9,
		  units=$10,
		  unit=$11,
		  cached_read_tokens=$12,
		  cache_write_tokens=$13,
		  reasoning_tokens=$14,
		  cache_anomaly=$15,
		  credit_micros=$5,
		  received_at=now(),
		  applied_at=now()
		 WHERE id=$1 AND reservation_id=$2 AND kind=$3 AND purpose=$4
		   AND status='open'`,
		call.CallID, sessionID, call.Kind, call.Purpose, out.credits,
		call.Provider, call.Model, call.InputTokens, call.OutputTokens,
		call.Units, call.Unit,
		call.CachedReadTokens, call.CacheWriteTokens, call.ReasoningTokens,
		call.CacheAnomaly,
	)
	if err != nil {
		return settlement, err
	}
	if tag.RowsAffected() != 1 {
		return settlement, ErrProviderCallConflict
	}
	if out.status == "released" {
		if _, err := tx.Exec(ctx, `UPDATE provider_sessions
			SET status='settled' WHERE id=$1 AND status='released'`, sessionID); err != nil {
			return settlement, err
		}
	}
	if out.credits > 0 && out.paidBy == models.PaidByPlatform {
		used := balance.UsedMicros + out.credits
		if _, err := tx.Exec(ctx, `UPDATE user_credits
			SET used_micros = $2, updated_at = now()
			WHERE user_id = $1`, out.actorUserID, used); err != nil {
			return settlement, err
		}
		settlement.CreditsExhausted = used+balance.ReservedMicros >= balance.LimitMicros
	}
	if settlement.CreditsExhausted && out.exhaustedAt == nil {
		if _, err := tx.Exec(ctx, `UPDATE provider_sessions
			SET credits_exhausted_at = now() WHERE id = $1`, sessionID); err != nil {
			return settlement, err
		}
		now := time.Now()
		out.exhaustedAt = &now
	}
	settlement.TerminalCallAllowed = out.status == "open" && settlement.CreditsExhausted &&
		(out.terminalCallID == nil || *out.terminalCallID == "")
	settlement.Duplicate = out.duplicate
	if err := tx.Commit(ctx); err != nil {
		return ProviderCallSettlement{}, err
	}
	return settlement, nil
}

// IngestSlots is this actor's ingest concurrency remaining, across every
// workspace. The create path still refuses the 21st under a row lock.
type IngestSlots struct {
	SlotsFree  int `json:"slotsFree"`
	SlotsUsed  int `json:"slotsUsed"`
	SlotsLimit int `json:"slotsLimit"`
}

func (s *Store) IngestSlots(ctx context.Context, actorUserID string) (IngestSlots, error) {
	out := IngestSlots{SlotsLimit: ConcurrentIngestLeases, SlotsFree: ConcurrentIngestLeases}
	if actorUserID == "" {
		return out, ErrNotFound
	}
	var used int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM provider_sessions
		 WHERE actor_user_id = $1 AND status = 'open' AND expires_at > now()
		   AND surface = $2`,
		actorUserID, SurfaceIngest).Scan(&used)
	if err != nil {
		return out, err
	}
	out.SlotsUsed = used
	out.SlotsFree = ConcurrentIngestLeases - used
	if out.SlotsFree < 0 {
		out.SlotsFree = 0
	}
	return out, nil
}

func (s *Store) BeginIngestSpend(
	ctx context.Context,
	actorUserID, workspaceID string,
) (string, error) {
	if actorUserID == "" {
		return "", ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	id, err := s.beginIngestSpendTx(ctx, tx, actorUserID, workspaceID)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func (s *Store) beginIngestSpendTx(
	ctx context.Context,
	tx pgx.Tx,
	actorUserID, workspaceID string,
) (string, error) {
	if err := s.lockAccountSessionsTx(ctx, tx, actorUserID); err != nil {
		return "", err
	}
	usage, err := s.lockedCreditUsageTx(ctx, tx, actorUserID)
	if err != nil {
		return "", err
	}
	if err := exhaustedIfOverLimit(usage); err != nil {
		return "", err
	}

	var open int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM provider_sessions
		 WHERE actor_user_id = $1 AND status = 'open' AND expires_at > now()
		   AND surface = $2`,
		actorUserID, SurfaceIngest).Scan(&open); err != nil {
		return "", err
	}
	if open >= ConcurrentIngestLeases {
		return "", ErrTooManyIngestLeases
	}

	id := uid("cr")
	var wsID *string
	if workspaceID != "" {
		wsID = &workspaceID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO provider_sessions
			(id, actor_user_id, workspace_id, trace_id, surface, reserved_micros, expires_at)
		VALUES ($1, $2, $3, $4, $5, 0, now() + ($6 * interval '1 millisecond'))`,
		id, actorUserID, wsID, nullString(obs.TraceID(ctx)), SurfaceIngest,
		ingestReservationHold.Milliseconds(),
	); err != nil {
		return "", err
	}
	return id, nil
}

// SettleCredits closes a reservation after its provider calls or ingest work
// have already been recorded. Measured spend is written by SettleProviderCall
// or RecordUsage, not here. A retry after close or sweep is a no-op.
func (s *Store) SettleCredits(ctx context.Context, reservationID string) error {
	if reservationID == "" {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var actorUserID string
	var reservedMicros int64
	err = tx.QueryRow(ctx, `
		UPDATE provider_sessions
		SET status = 'settled', settled_at = now()
		WHERE id = $1 AND status = 'open'
		RETURNING actor_user_id, reserved_micros`, reservationID).Scan(&actorUserID, &reservedMicros)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET reserved_micros = GREATEST(0, reserved_micros - $2),
		    updated_at = now()
		WHERE user_id = $1`, actorUserID, reservedMicros); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ReleaseCredits drops a reservation without charging, for a request that
// failed before spending anything.
func (s *Store) ReleaseCredits(ctx context.Context, reservationID string) error {
	if reservationID == "" {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var actorUserID string
	var reservedMicros int64
	err = tx.QueryRow(ctx, `
		UPDATE provider_sessions
		SET status = 'released', settled_at = now()
		WHERE id = $1 AND status = 'open'
		RETURNING actor_user_id, reserved_micros`, reservationID).Scan(&actorUserID, &reservedMicros)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET reserved_micros = GREATEST(0, reserved_micros - $2), updated_at = now()
		WHERE user_id = $1`, actorUserID, reservedMicros); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordUsage appends metered consumption that was never reserved: ingest work
// triggered by an upload, parsed pages, outbound mail. These cannot be gated
// in advance because nobody is waiting on them, but they still spend.
func (s *Store) RecordUsage(ctx context.Context, events ...UsageEvent) error {
	if len(events) == 0 {
		return nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	byUser := map[string]int64{}
	for _, ev := range events {
		if ev.ActorUserID == "" {
			continue
		}
		inserted, err := insertUsageEventTx(ctx, tx, ev)
		if err != nil {
			return err
		}
		if inserted {
			byUser[ev.ActorUserID] += ev.CreditMicros
		}
	}
	for userID, micros := range byUser {
		if micros == 0 {
			continue
		}
		if _, err := s.lockedCreditUsageTx(ctx, tx, userID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE user_credits
			SET used_micros = used_micros + $2, updated_at = now()
			WHERE user_id = $1`, userID, micros); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

const defaultUsageRecentLimit = 50

// UserUsageReport is the product usage page: this actor's current month,
// grouped, plus the most recent ledger rows.
func (s *Store) UserUsageReport(ctx context.Context, userID string, recentLimit int) (UsageReport, error) {
	out := UsageReport{
		ByKind:    []UsageBucket{},
		BySurface: []UsageBucket{},
		Recent:    []UsageEventView{},
	}
	if userID == "" {
		return out, ErrNotFound
	}
	if recentLimit <= 0 || recentLimit > 100 {
		recentLimit = defaultUsageRecentLimit
	}
	period := monthStart()

	kindRows, err := s.pool.Query(ctx, `
		SELECT kind, count(*), COALESCE(sum(credit_micros), 0)
		FROM usage_events
		WHERE actor_user_id = $1 AND created_at >= $2
		GROUP BY kind
		ORDER BY sum(credit_micros) DESC, kind`, userID, period)
	if err != nil {
		return out, err
	}
	out.ByKind, err = scanUsageBuckets(kindRows)
	if err != nil {
		return out, err
	}

	surfaceRows, err := s.pool.Query(ctx, `
		SELECT surface, count(*), COALESCE(sum(credit_micros), 0)
		FROM usage_events
		WHERE actor_user_id = $1 AND created_at >= $2
		GROUP BY surface
		ORDER BY sum(credit_micros) DESC, surface`, userID, period)
	if err != nil {
		return out, err
	}
	out.BySurface, err = scanUsageBuckets(surfaceRows)
	if err != nil {
		return out, err
	}

	recentRows, err := s.pool.Query(ctx, `
		SELECT created_at, kind, surface, catalog_provider_slug, catalog_model_slug,
		       input_tokens, output_tokens, units, unit, credit_micros
		FROM usage_events
		WHERE actor_user_id = $1
		ORDER BY created_at DESC, id DESC
		LIMIT $2`, userID, recentLimit)
	if err != nil {
		return out, err
	}
	defer recentRows.Close()
	for recentRows.Next() {
		var ev UsageEventView
		if err := recentRows.Scan(
			&ev.CreatedAt, &ev.Kind, &ev.Surface, &ev.ProviderSlug, &ev.ModelSlug,
			&ev.InputTokens, &ev.OutputTokens, &ev.Units, &ev.Unit, &ev.CreditMicros,
		); err != nil {
			return out, err
		}
		out.Recent = append(out.Recent, ev)
	}
	return out, recentRows.Err()
}

func scanUsageBuckets(rows pgx.Rows) ([]UsageBucket, error) {
	defer rows.Close()
	out := []UsageBucket{}
	for rows.Next() {
		var b UsageBucket
		if err := rows.Scan(&b.Key, &b.Events, &b.CreditMicros); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func insertUsageEventTx(ctx context.Context, tx pgx.Tx, ev UsageEvent) (bool, error) {
	if ev.ActorUserID == "" {
		return false, nil
	}
	if ev.Surface == "" {
		ev.Surface = SurfaceSystem
	}
	if ev.Metadata == nil {
		ev.Metadata = map[string]any{}
	}
	if ev.TraceID == "" {
		ev.TraceID = obs.TraceID(ctx)
	}
	var wsID *string
	if ev.WorkspaceID != "" {
		wsID = &ev.WorkspaceID
	}
	var inserted bool
	err := tx.QueryRow(ctx, `
		INSERT INTO usage_events
			(trace_id, actor_user_id, workspace_id, kind, surface, provider, model,
			 thinking, catalog_provider_slug, catalog_model_slug, model_version,
			 input_tokens, output_tokens, units, unit, parse_pages, parse_ocr_pages,
			 parse_cpu_milliseconds, parse_elapsed_milliseconds, credit_micros,
			 reservation_id, provider_call_id, idempotency_key, metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
		ON CONFLICT DO NOTHING
		RETURNING true`,
		nullString(ev.TraceID), ev.ActorUserID, wsID, ev.Kind, ev.Surface,
		ev.Provider, ev.Model, ev.Thinking,
		ev.CatalogModel.ProviderSlug, ev.CatalogModel.ModelSlug, ev.ModelVersion,
		ev.InputTokens, ev.OutputTokens, ev.Units, ev.Unit,
		ev.ParsePages, ev.ParseOCRPages, ev.ParseCPUMilliseconds,
		ev.ParseElapsedMilliseconds, ev.CreditMicros,
		nullString(ev.ReservationID), nullString(ev.ProviderCallID),
		nullString(ev.IdempotencyKey), ev.Metadata,
	).Scan(&inserted)
	if isNoRows(err) {
		return false, nil
	}
	return inserted, err
}

func nullString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

/* --------------------------------------------------------- maintenance */

// SweepExpiredProviderCalls closes attempts whose provider response and
// settlement grace have elapsed. Session closure stops new calls but leaves
// an already-open call settleable until this deadline.
func (s *Store) SweepExpiredProviderCalls(ctx context.Context) (int64, error) {
	var abandoned int64
	err := s.pool.QueryRow(ctx, `
		WITH locked_terminal_sessions AS MATERIALIZED (
		  SELECT s.id
		    FROM provider_sessions s
		   WHERE EXISTS (
		     SELECT 1 FROM provider_calls pc
		      WHERE pc.reservation_id=s.id AND pc.purpose='terminal'
		        AND pc.status='open' AND pc.receipt_deadline_at<now()
		   )
		   ORDER BY s.id
		   FOR UPDATE
		), abandoned AS (
		  UPDATE provider_calls pc
		     SET status = 'abandoned', abandoned_at = now(),
		         error_category = 'provider', error_code = 'receipt_timeout'
		   WHERE pc.status = 'open' AND pc.receipt_deadline_at < now()
		     AND (pc.purpose <> 'terminal' OR EXISTS (
		       SELECT 1 FROM locked_terminal_sessions s
		        WHERE s.id=pc.reservation_id
		     ))
		   RETURNING id, reservation_id, purpose
		), cleared_terminal AS (
		  UPDATE provider_sessions s SET terminal_call_id=NULL
		    FROM abandoned a
		   WHERE a.purpose='terminal' AND s.id=a.reservation_id
		     AND s.terminal_call_id=a.id
		   RETURNING s.id
		)
		SELECT count(*) FROM abandoned`).Scan(&abandoned)
	return abandoned, err
}

// SweepExpiredReservations releases holds whose request died without settling
// — a killed replica, a panic, a context deadline. Without this a crash
// permanently reduces a user's budget.
func (s *Store) SweepExpiredReservations(ctx context.Context) (int64, error) {
	var expired int64
	if err := s.pool.QueryRow(ctx, `
		WITH released AS (
		  UPDATE provider_sessions
		     SET status = 'released', settled_at = now()
		   WHERE status = 'open' AND expires_at < now()
		   RETURNING actor_user_id, reserved_micros
		), totals AS (
		  SELECT actor_user_id, sum(reserved_micros) AS reserved_micros
		    FROM released GROUP BY actor_user_id
		), counters AS (
		  UPDATE user_credits c
		     SET reserved_micros = GREATEST(0, c.reserved_micros - t.reserved_micros),
		         updated_at = now()
		    FROM totals t
		   WHERE c.user_id = t.actor_user_id
		   RETURNING c.user_id
		)
		SELECT count(*) FROM released`).Scan(&expired); err != nil {
		return 0, err
	}
	released, err := s.sweepOrphanIngestReservations(ctx)
	if err != nil {
		return expired, err
	}
	return expired + released, nil
}

func (s *Store) sweepOrphanIngestReservations(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `
		WITH released AS (
		  UPDATE provider_sessions r
		     SET status = 'released', settled_at = now()
		   WHERE r.status = 'open' AND r.surface = $1
		     AND r.created_at < now() - ($2 * interval '1 millisecond')
		     AND NOT EXISTS (
		       SELECT 1 FROM jobs j
		        WHERE j.type IN ('parse', 'ingest')
		          AND j.status IN ('pending', 'running')
		          AND j.payload->>'reservationId' = r.id
		     )
		   RETURNING actor_user_id, reserved_micros
		), totals AS (
		  SELECT actor_user_id, sum(reserved_micros) AS reserved_micros
		    FROM released GROUP BY actor_user_id
		), counters AS (
		  UPDATE user_credits c
		     SET reserved_micros = GREATEST(0, c.reserved_micros - t.reserved_micros),
		         updated_at = now()
		    FROM totals t
		   WHERE c.user_id = t.actor_user_id
		   RETURNING c.user_id
		)
		SELECT count(*) FROM released`,
		SurfaceIngest, ingestReservationOrphanAge.Milliseconds()).Scan(&n)
	return n, err
}
