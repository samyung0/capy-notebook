package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

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

const (
	FreeCreditsPerMonth = 1_000
	ProCreditsPerMonth  = 20_000
)

// reservationTTL bounds how long an unsettled reservation holds budget. It is
// longer than the pipeline's 90s sync timeout and longer than a realistic chat
// stream, so a settle always wins the race against the sweeper.
const reservationTTL = 30 * time.Minute

func CreditLimitMicros(tier PlanTier) int64 {
	if tier == PlanPro {
		return ProCreditsPerMonth * MicrosPerCredit
	}
	return FreeCreditsPerMonth * MicrosPerCredit
}

var ErrCreditsExhausted = errors.New("llm credits exhausted")

// ErrTooManyLLMLeases means the actor already has ConcurrentLLMLeases
// unsettled platform-paid calls. Distinct from credits exhausted: the budget
// may still have room.
var ErrTooManyLLMLeases = errors.New("too many llm leases")

// ConcurrentLLMLeases caps unsettled platform-paid model calls per actor.
// Worst-case overshoot is this many in-flight settlements. BYOK does not take
// a lease.
const ConcurrentLLMLeases = 5

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

// UsageBucket is one grouping on the user-facing usage page. Cost-USD is
// omitted on purpose: that column is reconciliation-only.
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
	ModelKey     string    `json:"modelKey"`
	InputTokens  int64     `json:"inputTokens"`
	OutputTokens int64     `json:"outputTokens"`
	Units        int64     `json:"units"`
	Unit         string    `json:"unit"`
	CreditMicros int64     `json:"creditMicros"`
}

// UsageReport is the actor's current-period spend plus a recent event list.
// It reads usage_events for this user, not usage_daily (operator rollup).
type UsageReport struct {
	ByKind    []UsageBucket    `json:"byKind" nullable:"false"`
	BySurface []UsageBucket    `json:"bySurface" nullable:"false"`
	Recent    []UsageEventView `json:"recent" nullable:"false"`
}

// UsageEvent is one metered consumption. Token fields are provider-reported;
// Units carries everything that is not a token (GPU milliseconds, bytes, mail
// count) so a single ledger covers every resource.
type UsageEvent struct {
	TraceID       string
	ActorUserID   string
	WorkspaceID   string
	Kind          string
	Surface       string
	Provider      string
	Model         string
	InputTokens   int64
	OutputTokens  int64
	Units         int64
	Unit          string
	CreditMicros  int64
	CostMicroUSD  int64
	ModelKey      string
	ModelVersion  int
	ReservationID string
	Metadata      map[string]any
}

// Usage kinds and surfaces. Kept as constants because they are the grouping
// keys in every dashboard query and rollup row; a typo creates a silent second
// category rather than an error.
const (
	KindLLM       = "llm"
	KindEmbedding = "embedding"
	KindCaption   = "caption"
	KindParseGPU  = "parse_gpu"
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
	var tier PlanTier
	if err := tx.QueryRow(ctx, `SELECT plan_tier FROM users WHERE id=$1`, userID).Scan(&tier); err != nil {
		if isNoRows(err) {
			return usage, ErrNotFound
		}
		return usage, err
	}
	// The UPDATE both takes the lock and resets a stale period in one
	// statement, so two concurrent first-requests of a month cannot both
	// observe the previous period's balance.
	err := tx.QueryRow(ctx, `
		UPDATE user_credits
		SET period_start = date_trunc('month', now())::date,
		    used_micros = CASE
		      WHEN period_start < date_trunc('month', now())::date THEN 0
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
	usage.LimitMicros = CreditLimitMicros(tier)
	return usage, nil
}

// CreditBalance reads without locking, for display and for the operator
// dashboard. The gate must not use this.
func (s *Store) CreditBalance(ctx context.Context, userID string) (CreditUsage, error) {
	var usage CreditUsage
	var tier PlanTier
	var periodStart *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT u.plan_tier,
		       COALESCE(c.used_micros, 0),
		       COALESCE(c.reserved_micros, 0),
		       c.period_start
		FROM users u
		LEFT JOIN user_credits c ON c.user_id = u.id
		WHERE u.id = $1`, userID).Scan(&tier, &usage.UsedMicros, &usage.ReservedMicros, &periodStart)
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
		}
	} else {
		usage.PeriodStart = monthStart()
	}
	usage.UserID = userID
	usage.PlanTier = tier
	usage.LimitMicros = CreditLimitMicros(tier)
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
	if usage.UsedMicros+usage.ReservedMicros >= usage.LimitMicros {
		return &CreditsExhaustedError{
			UserID:         userID,
			UsedMicros:     usage.UsedMicros,
			ReservedMicros: usage.ReservedMicros,
			LimitMicros:    usage.LimitMicros,
			PlanTier:       usage.PlanTier,
		}
	}
	return nil
}

func monthStart() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

/* ------------------------------------------------------- begin / settle */

// BeginSpend opens a 0-amount lease on the actor's inference budget. The
// returned id must be passed to SettleCredits or ReleaseCredits; anything
// neither settled nor released is swept once it expires.
//
// There is no estimated hold. The gate is used >= limit, plus at most
// ConcurrentLLMLeases open rows for this actor. Settlement writes the measured
// cost. The user_credits row lock serializes concurrent begins so the count
// cannot race past the cap.
func (s *Store) BeginSpend(
	ctx context.Context,
	actorUserID, workspaceID, surface string,
) (string, error) {
	if actorUserID == "" {
		return "", ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	usage, err := s.lockedCreditUsageTx(ctx, tx, actorUserID)
	if err != nil {
		return "", err
	}
	if usage.UsedMicros >= usage.LimitMicros {
		return "", &CreditsExhaustedError{
			UserID:         actorUserID,
			UsedMicros:     usage.UsedMicros,
			ReservedMicros: usage.ReservedMicros,
			LimitMicros:    usage.LimitMicros,
			PlanTier:       usage.PlanTier,
		}
	}

	var open int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM credit_reservations
		 WHERE actor_user_id = $1 AND status = 'open' AND expires_at > now()`,
		actorUserID).Scan(&open); err != nil {
		return "", err
	}
	if open >= ConcurrentLLMLeases {
		return "", ErrTooManyLLMLeases
	}

	id := uid("cr")
	var wsID *string
	if workspaceID != "" {
		wsID = &workspaceID
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO credit_reservations
			(id, actor_user_id, workspace_id, trace_id, surface, amount_micros, expires_at)
		VALUES ($1, $2, $3, $4, $5, 0, now() + ($6 * interval '1 millisecond'))`,
		id, actorUserID, wsID, nullString(obs.TraceID(ctx)), surface,
		reservationTTL.Milliseconds(),
	); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// SettleCredits closes a reservation and records what was actually consumed.
// Events may be empty, which settles the reservation at zero — the normal
// outcome when a provider returned no usage at all.
//
// Settlement is idempotent on reservation id: a retry after a successful
// settle is a no-op, and a late settle after the sweeper released the hold
// charges at most once. Without that, a client disconnect that is saved twice
// double-bills.
func (s *Store) SettleCredits(ctx context.Context, reservationID string, events ...UsageEvent) error {
	if reservationID == "" {
		return s.RecordUsage(ctx, events...)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var actorUserID string
	var amountMicros int64
	err = tx.QueryRow(ctx, `
		UPDATE credit_reservations
		SET status = 'settled', settled_at = now()
		WHERE id = $1 AND status = 'open'
		RETURNING actor_user_id, amount_micros`, reservationID).Scan(&actorUserID, &amountMicros)
	if isNoRows(err) {
		// Open is gone: already settled, released, or swept. Charging is
		// decided by that status, not by blindly appending to the ledger —
		// RecordUsage here is how a retry after a successful settle used to
		// double-charge.
		return s.settleClosedReservationTx(ctx, tx, reservationID, events)
	}
	if err != nil {
		return err
	}

	spent, err := insertReservationEventsTx(ctx, tx, reservationID, actorUserID, events)
	if err != nil {
		return err
	}

	// Release the hold and charge the measured amount in one statement so the
	// counter is never transiently wrong.
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET reserved_micros = GREATEST(0, reserved_micros - $2),
		    used_micros = used_micros + $3,
		    updated_at = now()
		WHERE user_id = $1`, actorUserID, amountMicros, spent); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// settleClosedReservationTx finishes a settle whose reservation is no longer
// open. The row lock serializes two late settles so they cannot both observe
// an empty ledger and both charge.
func (s *Store) settleClosedReservationTx(
	ctx context.Context,
	tx pgx.Tx,
	reservationID string,
	events []UsageEvent,
) error {
	var status, actorUserID string
	err := tx.QueryRow(ctx, `
		SELECT status, actor_user_id FROM credit_reservations
		WHERE id = $1 FOR UPDATE`, reservationID).Scan(&status, &actorUserID)
	if isNoRows(err) {
		return s.RecordUsage(ctx, events...)
	}
	if err != nil {
		return err
	}
	if status == "settled" {
		return nil
	}

	var existing int64
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM usage_events WHERE reservation_id = $1`,
		reservationID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}

	spent, err := insertReservationEventsTx(ctx, tx, reservationID, actorUserID, events)
	if err != nil {
		return err
	}
	if spent == 0 {
		return tx.Commit(ctx)
	}
	if err := s.ensureCreditsRowTx(ctx, tx, actorUserID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET used_micros = used_micros + $2, updated_at = now()
		WHERE user_id = $1`, actorUserID, spent); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func insertReservationEventsTx(
	ctx context.Context,
	tx pgx.Tx,
	reservationID, actorUserID string,
	events []UsageEvent,
) (int64, error) {
	var spent int64
	for i := range events {
		events[i].ReservationID = reservationID
		if events[i].ActorUserID == "" {
			events[i].ActorUserID = actorUserID
		}
		spent += events[i].CreditMicros
		if err := insertUsageEventTx(ctx, tx, events[i]); err != nil {
			return 0, err
		}
	}
	return spent, nil
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
	var amountMicros int64
	err = tx.QueryRow(ctx, `
		UPDATE credit_reservations
		SET status = 'released', settled_at = now()
		WHERE id = $1 AND status = 'open'
		RETURNING actor_user_id, amount_micros`, reservationID).Scan(&actorUserID, &amountMicros)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE user_credits
		SET reserved_micros = GREATEST(0, reserved_micros - $2), updated_at = now()
		WHERE user_id = $1`, actorUserID, amountMicros); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RecordUsage appends metered consumption that was never reserved: ingest work
// triggered by an upload, GPU parse time, outbound mail. These cannot be gated
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
		if err := insertUsageEventTx(ctx, tx, ev); err != nil {
			return err
		}
		byUser[ev.ActorUserID] += ev.CreditMicros
	}
	for userID, micros := range byUser {
		if micros == 0 {
			continue
		}
		if err := s.ensureCreditsRowTx(ctx, tx, userID); err != nil {
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
// grouped, plus the most recent ledger rows. It does not scan usage_daily —
// that table is the operator dashboard and lags the ledger by up to a minute.
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
		SELECT created_at, kind, surface, model_key,
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
			&ev.CreatedAt, &ev.Kind, &ev.Surface, &ev.ModelKey,
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

func insertUsageEventTx(ctx context.Context, tx pgx.Tx, ev UsageEvent) error {
	if ev.ActorUserID == "" {
		return nil
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
	_, err := tx.Exec(ctx, `
		INSERT INTO usage_events
			(trace_id, actor_user_id, workspace_id, kind, surface, provider, model,
			 model_key, model_version, cost_micro_usd,
			 input_tokens, output_tokens, units, unit, credit_micros, reservation_id, metadata)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		nullString(ev.TraceID), ev.ActorUserID, wsID, ev.Kind, ev.Surface,
		ev.Provider, ev.Model, ev.ModelKey, ev.ModelVersion, ev.CostMicroUSD,
		ev.InputTokens, ev.OutputTokens, ev.Units, ev.Unit,
		ev.CreditMicros, nullString(ev.ReservationID), ev.Metadata,
	)
	return err
}

func nullString(v string) *string {
	if v == "" {
		return nil
	}
	return &v
}

/* --------------------------------------------------------- maintenance */

// SweepExpiredReservations releases holds whose request died without settling
// — a killed replica, a panic, a context deadline. Without this a crash
// permanently reduces a user's budget.
func (s *Store) SweepExpiredReservations(ctx context.Context) (int64, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE credit_reservations
		SET status = 'released', settled_at = now()
		WHERE status = 'open' AND expires_at < now()
		RETURNING actor_user_id, amount_micros`)
	if err != nil {
		return 0, err
	}
	type release struct {
		userID string
		micros int64
	}
	var releases []release
	for rows.Next() {
		var r release
		if err := rows.Scan(&r.userID, &r.micros); err != nil {
			rows.Close()
			return 0, err
		}
		releases = append(releases, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, r := range releases {
		if _, err := s.pool.Exec(ctx, `UPDATE user_credits
			SET reserved_micros = GREATEST(0, reserved_micros - $2), updated_at = now()
			WHERE user_id = $1`, r.userID, r.micros); err != nil {
			return int64(len(releases)), err
		}
	}
	return int64(len(releases)), nil
}

// RollupUsage folds new ledger rows into usage_daily. It advances a watermark
// rather than recomputing, so cost is proportional to new events and the
// operator dashboard never touches the raw ledger.
func (s *Store) RollupUsage(ctx context.Context) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var watermark int64
	if err := tx.QueryRow(ctx,
		`SELECT last_event_id FROM usage_rollup_state WHERE id = true FOR UPDATE`,
	).Scan(&watermark); err != nil {
		return 0, err
	}

	// Only fold rows that can no longer be joined by an in-flight transaction,
	// so a row committed out of id order is not skipped past the watermark.
	var maxID int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(max(id), $1) FROM usage_events
		WHERE id > $1 AND created_at < now() - interval '1 minute'`, watermark,
	).Scan(&maxID); err != nil {
		return 0, err
	}
	if maxID <= watermark {
		return 0, tx.Commit(ctx)
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO usage_daily
			(day, actor_user_id, kind, surface, provider, model,
			 events, input_tokens, output_tokens, units, credit_micros)
		SELECT created_at::date, actor_user_id, kind, surface, provider, model,
		       count(*), sum(input_tokens), sum(output_tokens), sum(units), sum(credit_micros)
		FROM usage_events
		WHERE id > $1 AND id <= $2
		GROUP BY 1,2,3,4,5,6
		ON CONFLICT (day, actor_user_id, kind, surface, provider, model) DO UPDATE SET
			events        = usage_daily.events + EXCLUDED.events,
			input_tokens  = usage_daily.input_tokens + EXCLUDED.input_tokens,
			output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens,
			units         = usage_daily.units + EXCLUDED.units,
			credit_micros = usage_daily.credit_micros + EXCLUDED.credit_micros`,
		watermark, maxID)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE usage_rollup_state SET last_event_id = $1, last_run_at = now() WHERE id = true`,
		maxID,
	); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

// ReconcileCredits recomputes counters from the ledger, repairing drift from
// crashes between an event insert and its counter update.
func (s *Store) ReconcileCredits(ctx context.Context) (int64, error) {
	// Only the current period is repairable: past months have been rolled up
	// and their ledger rows may already be outside the retention window.
	tag, err := s.pool.Exec(ctx, `
		UPDATE user_credits c
		SET used_micros = COALESCE((
		      SELECT sum(e.credit_micros) FROM usage_events e
		      WHERE e.actor_user_id = c.user_id
		        AND e.created_at >= date_trunc('month', now())
		    ), 0),
		    reserved_micros = COALESCE((
		      SELECT sum(r.amount_micros) FROM credit_reservations r
		      WHERE r.actor_user_id = c.user_id AND r.status = 'open'
		    ), 0),
		    updated_at = now()
		WHERE c.period_start = date_trunc('month', now())::date`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
