package store

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
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

// ErrInvalidProviderCall is a receipt that can never settle (missing ids, an
// unknown kind or thinking level, negative usage); retrying it fails the same way.
var ErrInvalidProviderCall = errors.New("invalid provider call")

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
	PurchasedMicros int64
	PlanTier        PlanTier
}

func (e *CreditsExhaustedError) Error() string {
	return fmt.Sprintf("%s: used=%d reserved=%d requested=%d limit=%d purchased=%d",
		ErrCreditsExhausted, e.UsedMicros, e.ReservedMicros, e.RequestedMicros, e.LimitMicros,
		e.PurchasedMicros)
}

func exhaustedError(usage CreditUsage) *CreditsExhaustedError {
	return &CreditsExhaustedError{
		UserID:          usage.UserID,
		UsedMicros:      usage.UsedMicros,
		ReservedMicros:  usage.ReservedMicros,
		LimitMicros:     usage.LimitMicros,
		PurchasedMicros: usage.PurchasedMicros,
		PlanTier:        usage.PlanTier,
	}
}

func (e *CreditsExhaustedError) Unwrap() error { return ErrCreditsExhausted }

// CreditUsage is the monthly allowance (LimitMicros, UsedMicros) plus the
// never-expiring purchased balance, which is negative while credits are owed.
type CreditUsage struct {
	UserID          string    `json:"userId"`
	UsedMicros      int64     `json:"creditsUsedMicros"`
	ReservedMicros  int64     `json:"creditsReservedMicros"`
	LimitMicros     int64     `json:"creditsLimitMicros"`
	PurchasedMicros int64     `json:"creditsPurchasedMicros"`
	CarriedMicros   int64     `json:"creditsCarriedMicros"`
	PlanTier        PlanTier  `json:"planTier"`
	PeriodStart     time.Time `json:"periodStart"`
	// ReloadPending admits work at zero during a started auto-reload's
	// 60-second window (credit_reload_pending).
	ReloadPending bool `json:"-"`
}

// AvailableMicros is what the gate admits against: the monthly allowance left
// plus the purchased balance, minus open reservations.
func (u CreditUsage) AvailableMicros() int64 {
	return max(u.LimitMicros-u.UsedMicros, 0) + u.PurchasedMicros - u.ReservedMicros
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

// UsageReport is the actor's current-period spend grouped by product surface.
// It reads the append-only usage_events ledger for this user.
type UsageReport struct {
	BySurface []UsageBucket `json:"bySurface" nullable:"false"`
}

// UsageEventPage is one newest-first page of the actor's ledger rows.
type UsageEventPage struct {
	Items []UsageEventView `json:"items" nullable:"false"`
	Next  string           `json:"next,omitempty"`
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
	CachedReadTokens int64
	CacheWriteTokens int64
	ReasoningTokens  int64
	CacheAnomaly     string
	// ModelVersion is the catalog version a rerank called; zero for every
	// other kind, which is labeled from the session's pins.
	ModelVersion int
	// ServedBy is the provider OpenRouter routed the call to, kept in the
	// usage event's metadata only.
	ServedBy string
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
	KindRerank    = "rerank" // zero credits like a query embedding, labeled with the reranker row called
	KindAudio     = "audio"  // transcribed seconds, priced per second by resource rate
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
	if userID == "" {
		return usage, ErrNotFound
	}
	tier, err := s.effectivePlanTierForUser(ctx, tx, userID)
	if err != nil {
		return usage, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return usage, err
	}
	// The rollover UPDATE takes the row lock when it fires, so two concurrent
	// first-requests of a month cannot both roll; the second re-reads the
	// rolled row.
	if _, err := tx.Exec(ctx, `SELECT roll_user_credits($1, $2)`, userID, limits.CreditMicros); err != nil {
		return usage, err
	}
	err = tx.QueryRow(ctx, `
		SELECT used_micros, reserved_micros, period_start, purchased_micros, carried_micros,
		       credit_reload_pending(user_id)
		FROM user_credits WHERE user_id = $1 FOR UPDATE`, userID).
		Scan(&usage.UsedMicros, &usage.ReservedMicros, &usage.PeriodStart,
			&usage.PurchasedMicros, &usage.CarriedMicros, &usage.ReloadPending)
	if err != nil {
		return usage, err
	}
	usage.UserID = userID
	usage.PlanTier = tier
	usage.LimitMicros = limits.CreditMicros
	return usage, nil
}

// CreditBalance reads without locking, for display and for the operator
// dashboard. The gate must not use this. It leaves ReloadPending unset: the
// operator role cannot execute credit_reload_pending.
func (s *Store) CreditBalance(ctx context.Context, userID string) (CreditUsage, error) {
	var usage CreditUsage
	tier, err := s.effectivePlanTierForUser(ctx, s.pool, userID)
	if err != nil {
		return usage, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return usage, err
	}
	var periodStart *time.Time
	var purchased *int64
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(c.used_micros, 0),
		       COALESCE(c.reserved_micros, 0),
		       c.period_start,
		       c.purchased_micros,
		       COALESCE(c.carried_micros, 0)
		FROM users u
		LEFT JOIN user_credits c ON c.user_id = u.id
		WHERE u.id = $1`, userID).
		Scan(&usage.UsedMicros, &usage.ReservedMicros, &periodStart, &purchased,
			&usage.CarriedMicros)
	if isNoRows(err) {
		return usage, ErrNotFound
	}
	if err != nil {
		return usage, err
	}
	usage.UserID = userID
	usage.PlanTier = tier
	usage.LimitMicros = limits.CreditMicros
	if purchased == nil {
		// No counter row yet: the account still holds its starter grant.
		usage.PurchasedMicros = StarterGrantMicros
		usage.PeriodStart = monthStart()
		return usage, nil
	}
	usage.PurchasedMicros = *purchased
	usage.PeriodStart = *periodStart
	// A lapsed period has not been rolled yet; show what roll_user_credits will
	// produce so the UI matches what the next request is gated against.
	if periodStart.Before(monthStart()) {
		moved := min(max(-usage.PurchasedMicros, 0), usage.LimitMicros)
		usage.UsedMicros = moved
		usage.CarriedMicros = moved
		usage.PurchasedMicros += moved
		usage.PeriodStart = monthStart()
	}
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
	usage, err := s.unlockedGateUsage(ctx, userID)
	if err != nil {
		return err
	}
	return admit(ctx, s.pool, usage)
}

// unlockedGateUsage is CreditBalance plus ReloadPending, read only when the
// balance alone would refuse.
func (s *Store) unlockedGateUsage(ctx context.Context, userID string) (CreditUsage, error) {
	usage, err := s.CreditBalance(ctx, userID)
	if err != nil || usage.AvailableMicros() > 0 {
		return usage, err
	}
	err = s.pool.QueryRow(ctx, `SELECT credit_reload_pending($1)`, userID).Scan(&usage.ReloadPending)
	return usage, err
}

// StarterGrantMicros is the one-off 800 credits every account starts with in
// its purchased balance (the column default of user_credits.purchased_micros).
const StarterGrantMicros = 800 * MicrosPerCredit

// The estimate headroom lets one admitted job overrun what is available by
// 30% of the monthly limit (kept in integers so the boundary is exact). The
// browser's estimate is trusted here because the parser receipt still bills
// the measured pages: a low estimate only lets a user finish one job past the
// limit before the next interactive request refuses.
const (
	creditHeadroomNumerator   = 3
	creditHeadroomDenominator = 10
)

// AssertCreditsForEstimate is the upload-reservation gate: the plain
// exhaustion check plus a refusal when the estimated cost would land past the
// headroom. Unlocked like AssertCreditsAvailable; the job's own claim rechecks.
func (s *Store) AssertCreditsForEstimate(ctx context.Context, userID string, estimateMicros int64) error {
	usage, err := s.unlockedGateUsage(ctx, userID)
	if err != nil {
		return err
	}
	if err := admit(ctx, s.pool, usage); err != nil {
		return err
	}
	if !estimateExceedsHeadroom(usage, estimateMicros) {
		return nil
	}
	return exhaustedError(usage)
}

func estimateExceedsHeadroom(usage CreditUsage, estimateMicros int64) bool {
	if estimateMicros <= 0 {
		return false
	}
	// A client-supplied estimate this large refuses before any arithmetic it
	// could overflow.
	if estimateMicros > math.MaxInt64/(2*creditHeadroomDenominator) {
		return true
	}
	excess := estimateMicros - usage.AvailableMicros()
	return excess*creditHeadroomDenominator > usage.LimitMicros*creditHeadroomNumerator
}

// exhaustedIfOverLimit refuses new work once nothing is available, unless a
// started auto-reload's 60-second window is open (credit_reload_pending).
func exhaustedIfOverLimit(usage CreditUsage) error {
	if usage.AvailableMicros() > 0 || usage.ReloadPending {
		return nil
	}
	return exhaustedError(usage)
}

// admit is the gate: exhaustedIfOverLimit, except that a request finding
// credits at zero starts an armed auto-reload (claim_credit_reload), which opens
// the window and lets it through.
func admit(ctx context.Context, q rowQuerier, usage CreditUsage) error {
	if exhaustedIfOverLimit(usage) == nil {
		return nil
	}
	var claimed bool
	if err := q.QueryRow(ctx, `SELECT claim_credit_reload($1)`, usage.UserID).Scan(&claimed); err != nil {
		return err
	}
	if claimed {
		return nil
	}
	return exhaustedError(usage)
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
	// The session row's foreign key share-locks the workspace. Taken after the
	// account, that lock waited on a workspace writer (FOR UPDATE) that waited
	// on this account: workspace first, as every workspace write does.
	if workspaceID != "" {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR KEY SHARE`, workspaceID); err != nil {
			return "", err
		}
	}
	if err := s.lockAccountSessionsTx(ctx, tx, actorUserID); err != nil {
		return "", err
	}

	if paidBy == models.PaidByPlatform {
		usage, err := s.lockedCreditUsageTx(ctx, tx, actorUserID)
		if err != nil {
			return "", err
		}
		if err := admit(ctx, tx, usage); err != nil {
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
		return out, fmt.Errorf("%w: session id and provider call id are required", ErrInvalidProviderCall)
	}
	if call.Kind != KindLLM && call.Kind != KindEmbedding && call.Kind != KindRerank {
		return out, fmt.Errorf("%w: kind %q", ErrInvalidProviderCall, call.Kind)
	}
	if (call.Kind == KindEmbedding || call.Kind == KindRerank) && call.Thinking != "" {
		return out, fmt.Errorf("%w: embedding and rerank calls cannot have thinking", ErrInvalidProviderCall)
	}
	if call.Kind == KindLLM && !models.IsKnownThinking(call.Thinking) {
		return out, fmt.Errorf("%w: thinking %q", ErrInvalidProviderCall, call.Thinking)
	}
	if call.InputTokens < 0 || call.OutputTokens < 0 || call.CachedReadTokens < 0 ||
		call.CacheWriteTokens < 0 || call.ReasoningTokens < 0 {
		return out, fmt.Errorf("%w: usage cannot be negative", ErrInvalidProviderCall)
	}
	if (call.Kind == KindRerank) != (call.ModelVersion > 0) || call.ModelVersion < 0 {
		return out, fmt.Errorf("%w: rerank calls, and only they, name their catalog version", ErrInvalidProviderCall)
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
			       input_tokens, output_tokens,
			       COALESCE((metadata->>'cachedReadTokens')::bigint, 0),
			       COALESCE((metadata->>'cacheWriteTokens')::bigint, 0),
			       COALESCE((metadata->>'reasoningTokens')::bigint, 0),
			       COALESCE(metadata->>'cacheAnomaly', ''),
			       CASE WHEN kind = 'rerank' THEN model_version ELSE 0 END,
			       COALESCE(metadata->>'servedBy', '')
			FROM usage_events
			WHERE reservation_id = $1 AND provider_call_id = $2`,
			sessionID, call.CallID,
		).Scan(
			&recorded.Kind, &recorded.Purpose, &recorded.Thinking, &recorded.Provider, &recorded.Model,
			&recorded.InputTokens, &recorded.OutputTokens,
			&recorded.CachedReadTokens, &recorded.CacheWriteTokens,
			&recorded.ReasoningTokens, &recorded.CacheAnomaly, &recorded.ModelVersion,
			&recorded.ServedBy,
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
	if call.Kind == KindEmbedding || call.Kind == KindRerank {
		catalogModel, modelVersion = embeddingRef, embeddingVersion
		if call.Kind == KindRerank {
			// DeepInfra's transport identity is the catalog identity.
			catalogModel = models.Ref{ProviderSlug: call.Provider, ModelSlug: call.Model}
			modelVersion = call.ModelVersion
		}
		if s.registry == nil {
			return settlement, fmt.Errorf("%w: registry not configured", ErrModelUnavailable)
		}
		cfg, err := s.registry.Get(ctx, catalogModel, modelVersion)
		if err != nil {
			return settlement, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
		}
		if call.Kind == KindRerank && !cfg.Allows(models.SlotRerank) {
			return settlement, fmt.Errorf("%w: %s v%d is not a reranker", ErrModelUnavailable, catalogModel, modelVersion)
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
	if call.ServedBy != "" {
		meta["servedBy"] = call.ServedBy
	}
	if call.InputTokens == 0 && call.OutputTokens == 0 {
		meta["usageMissing"] = true
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
		Unit:           "tokens",
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
		  cached_read_tokens=$10,
		  cache_write_tokens=$11,
		  reasoning_tokens=$12,
		  cache_anomaly=$13,
		  credit_micros=$5,
		  received_at=now(),
		  applied_at=now()
		 WHERE id=$1 AND reservation_id=$2 AND kind=$3 AND purpose=$4
		   AND status='open'`,
		call.CallID, sessionID, call.Kind, call.Purpose, out.credits,
		call.Provider, call.Model, call.InputTokens, call.OutputTokens,
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
		after := balance
		if err := tx.QueryRow(ctx, `SELECT used_micros, purchased_micros FROM spend_user_credits($1, $2, $3)`,
			out.actorUserID, out.credits, balance.LimitMicros).
			Scan(&after.UsedMicros, &after.PurchasedMicros); err != nil {
			return settlement, err
		}
		if err := admit(ctx, tx, after); err != nil {
			var exhausted *CreditsExhaustedError
			if !errors.As(err, &exhausted) {
				return settlement, err
			}
			settlement.CreditsExhausted = true
		}
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
		   AND surface = $2 AND paid_by <> $3`,
		actorUserID, SurfaceIngest, models.PaidBySystem).Scan(&used)
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
	if err := admit(ctx, tx, usage); err != nil {
		return "", err
	}

	var open int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM provider_sessions
		 WHERE actor_user_id = $1 AND status = 'open' AND expires_at > now()
		   AND surface = $2 AND paid_by <> $3`,
		actorUserID, SurfaceIngest, models.PaidBySystem).Scan(&open); err != nil {
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

// beginSystemIngestSessionTx opens the ingest session of a maintenance
// republish (paid_by 'system'): no credit check and no lease on the actor's
// ingest slots, and the pipeline settles its usage at zero credits.
func beginSystemIngestSessionTx(ctx context.Context, tx pgx.Tx, actorUserID, workspaceID string) (string, error) {
	id := uid("cr")
	_, err := tx.Exec(ctx, `
		INSERT INTO provider_sessions
			(id, actor_user_id, workspace_id, trace_id, surface, reserved_micros, paid_by, expires_at)
		VALUES ($1, $2, $3, $4, $5, 0, $6, now() + ($7 * interval '1 millisecond'))`,
		id, actorUserID, workspaceID, nullString(obs.TraceID(ctx)), SurfaceIngest,
		models.PaidBySystem, ingestReservationHold.Milliseconds(),
	)
	return id, err
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
		usage, err := s.lockedCreditUsageTx(ctx, tx, userID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT spend_user_credits($1, $2, $3)`,
			userID, micros, usage.LimitMicros); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// UserUsageReport is the Usage tab: this actor's current month by surface.
func (s *Store) UserUsageReport(ctx context.Context, userID string) (UsageReport, error) {
	out := UsageReport{BySurface: []UsageBucket{}}
	if userID == "" {
		return out, ErrNotFound
	}
	rows, err := s.pool.Query(ctx, `
		SELECT surface, count(*), COALESCE(sum(credit_micros), 0)
		FROM usage_events
		WHERE actor_user_id = $1 AND created_at >= $2
		GROUP BY surface
		ORDER BY sum(credit_micros) DESC, surface`, userID, monthStart())
	if err != nil {
		return out, err
	}
	out.BySurface, err = scanUsageBuckets(rows)
	return out, err
}

const usageEventPageMax = 20

// usageEventSorts are Detailed usage's sortable columns: the expression each
// sorts by and its SQL type, so the cursor's text key casts back.
var usageEventSorts = map[string]struct{ expr, typ string }{
	"date":    {"created_at", "timestamptz"},
	"model":   {"lower(catalog_provider_slug || '/' || catalog_model_slug)", "text"},
	"tokens":  {"input_tokens + output_tokens", "bigint"},
	"credits": {"credit_micros", "bigint"},
}

// UsageEventParams sorts and pages ListUsageEvents. Before is the opaque Next
// of the previous page in the same sort.
type UsageEventParams struct {
	Sort      string
	Ascending bool
	Limit     int
	Before    string
}

// ListUsageEvents keyset-pages this actor's ledger rows for the Detailed
// usage tab, by the sort column then (created_at, id) in the same direction,
// so rows charged while the user pages never shift a page.
func (s *Store) ListUsageEvents(ctx context.Context, userID string, p UsageEventParams) (UsageEventPage, error) {
	page := UsageEventPage{Items: []UsageEventView{}}
	if userID == "" {
		return page, ErrNotFound
	}
	sort, ok := usageEventSorts[p.Sort]
	if !ok {
		sort = usageEventSorts["date"]
	}
	limit := p.Limit
	if limit <= 0 || limit > usageEventPageMax {
		limit = usageEventPageMax
	}
	var cursorKey *string
	var cursorAt time.Time
	var cursorID int64
	if p.Before != "" {
		raw, err := base64.RawURLEncoding.DecodeString(p.Before)
		// The key goes last: a model name may hold the separator.
		parts := strings.SplitN(string(raw), "|", 3)
		if err != nil || len(parts) != 3 {
			return page, ErrInvalidCursor
		}
		parsedAt, atErr := time.Parse(time.RFC3339Nano, parts[0])
		parsedID, idErr := strconv.ParseInt(parts[1], 10, 64)
		key := parts[2]
		var keyErr error
		switch sort.typ {
		case "bigint":
			_, keyErr = strconv.ParseInt(key, 10, 64)
		case "timestamptz":
			_, keyErr = time.Parse(time.RFC3339Nano, key)
		}
		if atErr != nil || idErr != nil || keyErr != nil {
			return page, ErrInvalidCursor
		}
		cursorKey, cursorAt, cursorID = &key, parsedAt, parsedID
	}
	dir, cmp := "DESC", "<"
	if p.Ascending {
		dir, cmp = "ASC", ">"
	}
	// The key is read back as text; timestamps in RFC 3339 so they parse.
	keyText := "(" + sort.expr + ")::text"
	if sort.typ == "timestamptz" {
		keyText = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT id, created_at, kind, surface, catalog_provider_slug, catalog_model_slug,
		       input_tokens, output_tokens, units, unit, credit_micros, %[4]s AS sort_key
		FROM usage_events
		WHERE actor_user_id = $1
		  AND ($2::text IS NULL OR (%[1]s, created_at, id) %[3]s ($2::text::%[5]s, $3::timestamptz, $4::bigint))
		ORDER BY %[1]s %[2]s, created_at %[2]s, id %[2]s
		LIMIT $5`, sort.expr, dir, cmp, keyText, sort.typ), userID, cursorKey, cursorAt, cursorID, limit+1)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	var ids []int64
	var keys []string
	for rows.Next() {
		var id int64
		var key string
		var ev UsageEventView
		if err := rows.Scan(
			&id, &ev.CreatedAt, &ev.Kind, &ev.Surface, &ev.ProviderSlug, &ev.ModelSlug,
			&ev.InputTokens, &ev.OutputTokens, &ev.Units, &ev.Unit, &ev.CreditMicros, &key,
		); err != nil {
			return page, err
		}
		ids = append(ids, id)
		keys = append(keys, key)
		page.Items = append(page.Items, ev)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if len(page.Items) > limit {
		last := page.Items[limit-1]
		page.Items = page.Items[:limit]
		page.Next = base64.RawURLEncoding.EncodeToString([]byte(
			last.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" +
				strconv.FormatInt(ids[limit-1], 10) + "|" + keys[limit-1]))
	}
	return page, nil
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
		        WHERE j.type IN ('parse', 'ingest', 'source_refresh')
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
