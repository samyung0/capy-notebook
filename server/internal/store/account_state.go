package store

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
)

// AccountState is the single derived lifecycle state every write gate consults.
// It is computed from the users lifecycle columns, the subscription record and
// storage usage; callers must never re-derive it from those inputs themselves,
// because the API, the collaboration server and the ingest pipeline all have to
// agree on one answer.
type AccountState string

const (
	// AccountActive is an unrestricted account.
	AccountActive AccountState = "active"
	// AccountOverQuotaGrace is a lapsed subscription whose stored bytes exceed
	// the tier limit, still inside the buffer window. It behaves exactly like an
	// active account at its hard quota: storage growth fails the quota check,
	// the content it pays for is view-only (assertContentEditableTx) and
	// everything else stays available.
	AccountOverQuotaGrace AccountState = "over_quota_grace"
	// AccountOverQuotaFrozen follows grace once the buffer expires. The account
	// is read-only apart from reading, downloading, deleting, workspace chat,
	// narrowing exposure, billing and account settings, in both directions: it
	// edits nowhere, and nobody edits what it pays for. It persists until the
	// user frees space or resubscribes. Nothing is ever deleted on reaching it.
	AccountOverQuotaFrozen AccountState = "over_quota_frozen"
	// AccountDeletionPending is a requested deletion inside its grace window.
	// Authentication is refused and sessions are revoked. Content stays intact
	// until purge; only support can cancel via cmd/cancel-deletion.
	AccountDeletionPending AccountState = "deletion_pending"
	// AccountSuspended rejects all writes. Nothing sets it automatically; there
	// is no suspension policy yet.
	AccountSuspended AccountState = "suspended"
	// AccountDeleted is a purged tombstone. Authentication is refused.
	AccountDeleted AccountState = "deleted"
)

func (AccountState) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "AccountState", "active", "over_quota_grace", "over_quota_frozen",
		"deletion_pending", "suspended", "deleted")
}

// ErrAccountLocked reports a write refused because of the account's lifecycle
// state rather than a permission or quota problem.
var ErrAccountLocked = errors.New("account locked")

// AccountLockedError carries the state so handlers can emit a machine-readable
// code and the frontend can route to the matching screen.
type AccountLockedError struct {
	UserID string
	State  AccountState
	Reason string
}

func (e *AccountLockedError) Error() string {
	return ErrAccountLocked.Error() + ": " + string(e.State)
}

func (e *AccountLockedError) Unwrap() error { return ErrAccountLocked }

// Code is the stable identifier the frontend switches on.
func (e *AccountLockedError) Code() string {
	switch e.State {
	case AccountDeleted:
		return "account_deleted"
	case AccountDeletionPending:
		return "account_deletion_pending"
	case AccountSuspended:
		return "account_suspended"
	case AccountOverQuotaGrace, AccountOverQuotaFrozen:
		return "account_over_quota"
	default:
		return "account_locked"
	}
}

// AccountStatus is the resolved lifecycle snapshot for one user.
type AccountStatus struct {
	UserID              string       `json:"userId"`
	State               AccountState `json:"state"`
	PlanTier            PlanTier     `json:"planTier"`
	DeletionRequestedAt *time.Time   `json:"deletionRequestedAt,omitempty"`
	PurgeAfter          *time.Time   `json:"purgeAfter,omitempty"`
	SuspendedReason     string       `json:"suspendedReason,omitempty"`
	// Stored plus reserved bytes against the current plan limit, and the level
	// they reach. WithStorageUsage fills them; write gates skip those reads.
	StorageUsedBytes  int64             `json:"storageUsedBytes"`
	StorageLimitBytes int64             `json:"storageLimitBytes"`
	StorageUsage      StorageUsageLevel `json:"storageUsage"`
	// GraceEndsAt is when over_quota_grace becomes over_quota_frozen.
	GraceEndsAt *time.Time `json:"graceEndsAt,omitempty"`
}

// StorageUsageLevel is how close an account is to its plan limit.
type StorageUsageLevel string

const (
	StorageUsageOK        StorageUsageLevel = "ok"
	StorageUsageNearLimit StorageUsageLevel = "near_limit"
	StorageUsageFull      StorageUsageLevel = "full"
)

func (StorageUsageLevel) Schema(r huma.Registry) *huma.Schema {
	return enumRef(r, "StorageUsageLevel", "ok", "near_limit", "full")
}

// StorageUsageLevelFor is the one place the usage level is decided: full at
// 100% of the limit or more, near_limit from 95%.
func StorageUsageLevelFor(usedBytes, limitBytes int64) StorageUsageLevel {
	switch {
	case usedBytes >= limitBytes:
		return StorageUsageFull
	case usedBytes*100 >= limitBytes*95:
		return StorageUsageNearLimit
	}
	return StorageUsageOK
}

// Full reports stored plus reserved bytes at or over the limit (grace
// included): the content the account pays for is view-only.
func (u StorageUsage) Full() bool {
	return StorageUsageLevelFor(u.UsedBytes+u.ReservedBytes, u.LimitBytes) == StorageUsageFull
}

// CanAuthenticate reports whether the identity may hold a session at all.
func (a AccountStatus) CanAuthenticate() bool {
	return a.State == AccountActive || a.State == AccountOverQuotaGrace || a.State == AccountOverQuotaFrozen
}

// CanEdit reports whether the account may create or edit anything. Grace
// passes: its storage growth fails the ordinary quota check instead.
func (a AccountStatus) CanEdit() bool {
	return a.State == AccountActive || a.State == AccountOverQuotaGrace
}

// OverQuota reports the lapsed, over-limit states that receive reminders.
func (a AccountStatus) OverQuota() bool {
	return a.State == AccountOverQuotaGrace || a.State == AccountOverQuotaFrozen
}

// Err returns the locked error for a state that forbids creating and editing,
// or nil.
func (a AccountStatus) Err() error {
	if a.CanEdit() {
		return nil
	}
	return &AccountLockedError{UserID: a.UserID, State: a.State, Reason: a.SuspendedReason}
}

// MutateErr returns the locked error for a state that forbids even the actions
// a frozen account keeps (deleting, narrowing exposure, account settings).
func (a AccountStatus) MutateErr() error {
	if a.CanAuthenticate() {
		return nil
	}
	return &AccountLockedError{UserID: a.UserID, State: a.State, Reason: a.SuspendedReason}
}

// overQuotaBufferDays is how long a lapsed, over-limit account stays in grace
// before freezing. Content is never deleted at either boundary.
const overQuotaBufferDays = 14

// AccountAccess resolves the lifecycle state for a user. It is the only place
// the state machine is evaluated.
func (s *Store) AccountAccess(ctx context.Context, userID string) (AccountStatus, error) {
	return s.accountAccess(ctx, s.pool, userID)
}

// MaterialOwnerAccess resolves the lifecycle state of the account charged for a
// material's bytes. A frozen or locked owner makes the material read-only for
// every collaborator, whatever their own state.
func (s *Store) MaterialOwnerAccess(
	ctx context.Context,
	materialID string,
) (AccountStatus, error) {
	var ownerID string
	err := s.pool.QueryRow(ctx,
		`SELECT owner_user_id FROM materials WHERE id=$1 AND trashed_at IS NULL`, materialID).Scan(&ownerID)
	if isNoRows(err) {
		return AccountStatus{}, ErrNotFound
	}
	if err != nil {
		return AccountStatus{}, err
	}
	return s.accountAccess(ctx, s.pool, ownerID)
}

// WithStorageUsage fills the usage fields an account reports: stored plus
// reserved bytes against the current plan limit (Free once a paid period has
// lapsed, as the quota check applies it) and their level.
func (s *Store) WithStorageUsage(ctx context.Context, status AccountStatus) (AccountStatus, error) {
	usage, err := s.StorageUsage(ctx, status.UserID)
	if err != nil {
		return status, err
	}
	status.StorageUsedBytes = usage.UsedBytes + usage.ReservedBytes
	status.StorageLimitBytes = usage.LimitBytes
	status.StorageUsage = StorageUsageLevelFor(status.StorageUsedBytes, status.StorageLimitBytes)
	return status, nil
}

// assertEditableTx refuses an edit when any of the accounts (the actor and
// the storage owner) cannot edit: a frozen account edits nowhere, and nobody
// edits what a frozen account pays for. Empty ids are skipped.
func (s *Store) assertEditableTx(ctx context.Context, q rowQueryer, userIDs ...string) error {
	for i, id := range userIDs {
		if id == "" || slices.Contains(userIDs[:i], id) {
			continue
		}
		status, err := s.accountAccess(ctx, q, id)
		if err != nil {
			return err
		}
		if err := status.Err(); err != nil {
			return err
		}
	}
	return nil
}

// assertContentEditableTx admits a content edit (edit mode, comments,
// annotations): assertEditableTx, and the storage owner under its limit. At
// or over it (full, grace included) every editable file and material is
// view-only, while organizing (rename, move, reorder, delete) goes on.
func (s *Store) assertContentEditableTx(ctx context.Context, q rowQueryer, ownerID, actorID string) error {
	if err := s.assertEditableTx(ctx, q, ownerID, actorID); err != nil {
		return err
	}
	return s.storageFullErr(ctx, q, ownerID)
}

// StorageFullErr is the account's QuotaExceededError while it is at or over
// its storage limit (full, grace included), nil otherwise.
func (s *Store) StorageFullErr(ctx context.Context, userID string) error {
	return s.storageFullErr(ctx, s.pool, userID)
}

func (s *Store) storageFullErr(ctx context.Context, q rowQueryer, userID string) error {
	usage, err := s.unlockedStorageUsage(ctx, q, userID)
	if err != nil {
		return err
	}
	if usage.Full() {
		return &QuotaExceededError{
			UserID: userID, UsedBytes: usage.UsedBytes, ReservedBytes: usage.ReservedBytes,
			LimitBytes: usage.LimitBytes, PlanTier: usage.PlanTier,
		}
	}
	return nil
}

// AccountSessionAllowed answers the auth middleware's narrower question without
// exposing the full status, so the auth package stays independent of this one.
// An unknown user is allowed: the middleware provisions rows lazily, and a
// concurrent first request must not be rejected.
//
// Purged, suspended, and deletion-pending accounts are refused entirely.
// Cancellation of a scheduled deletion is support-only (cmd/cancel-deletion).
func (s *Store) AccountSessionAllowed(
	ctx context.Context,
	userID string,
) (bool, string, error) {
	var deletedAt, suspendedAt, deletionRequestedAt *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT deleted_at, suspended_at, deletion_requested_at FROM users WHERE id=$1`,
		userID).Scan(&deletedAt, &suspendedAt, &deletionRequestedAt)
	if isNoRows(err) {
		return true, "", nil
	}
	if err != nil {
		return false, "", err
	}
	if deletedAt != nil {
		return false, (&AccountLockedError{State: AccountDeleted}).Code(), nil
	}
	if deletionRequestedAt != nil {
		return false, (&AccountLockedError{State: AccountDeletionPending}).Code(), nil
	}
	if suspendedAt != nil {
		return false, (&AccountLockedError{State: AccountSuspended}).Code(), nil
	}
	return true, "", nil
}

// UserProvisioned reports whether Clerk identity provisioning has produced a
// local row. Tombstones count as provisioned; AccountSessionAllowed applies the
// lifecycle verdict separately.
func (s *Store) UserProvisioned(ctx context.Context, userID string) (bool, error) {
	var provisioned bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)`, userID,
	).Scan(&provisioned)
	return provisioned, err
}

// lockAccountSessionsTx serializes final write admission with deletion,
// suspension, and plan projection. IDs are locked in database order so a
// collaborator write can safely lock both the actor and the storage owner.
// Non-key locks let cancellation write an owner's storage-delta foreign key
// while a collaborator admission waits for the cancelling actor's row.
func (s *Store) lockAccountSessionsTx(
	ctx context.Context,
	tx pgx.Tx,
	userIDs ...string,
) error {
	unique := make(map[string]struct{}, len(userIDs))
	ids := make([]string, 0, len(userIDs))
	for _, id := range userIDs {
		if id == "" {
			continue
		}
		if _, exists := unique[id]; exists {
			continue
		}
		unique[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return ErrNotFound
	}
	rows, err := tx.Query(ctx, `SELECT id, deleted_at, deletion_requested_at,
			suspended_at, suspended_reason
		FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var id string
		var deletedAt, deletionRequestedAt, suspendedAt *time.Time
		var reason *string
		if err := rows.Scan(&id, &deletedAt, &deletionRequestedAt, &suspendedAt, &reason); err != nil {
			return err
		}
		seen++
		state := AccountActive
		switch {
		case deletedAt != nil:
			state = AccountDeleted
		case deletionRequestedAt != nil:
			state = AccountDeletionPending
		case suspendedAt != nil:
			state = AccountSuspended
		}
		if state != AccountActive {
			locked := &AccountLockedError{UserID: id, State: state}
			if reason != nil {
				locked.Reason = *reason
			}
			return locked
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if seen != len(ids) {
		return ErrNotFound
	}
	return nil
}

func (s *Store) accountAccess(
	ctx context.Context,
	q rowQueryer,
	userID string,
) (AccountStatus, error) {
	status := AccountStatus{UserID: userID}
	var (
		deletionRequestedAt *time.Time
		purgeAfter          *time.Time
		deletedAt           *time.Time
		suspendedAt         *time.Time
		suspendedReason     *string
	)
	err := q.QueryRow(ctx, `SELECT plan_tier, deletion_requested_at, purge_after,
			deleted_at, suspended_at, suspended_reason
		FROM users WHERE id=$1`, userID).
		Scan(&status.PlanTier, &deletionRequestedAt, &purgeAfter,
			&deletedAt, &suspendedAt, &suspendedReason)
	if isNoRows(err) {
		return status, ErrNotFound
	}
	if err != nil {
		return status, err
	}
	status.DeletionRequestedAt = deletionRequestedAt
	status.PurgeAfter = purgeAfter
	if suspendedReason != nil {
		status.SuspendedReason = *suspendedReason
	}

	// Ordered by severity: a purged account is terminal, and a destructive
	// deletion request must remain visible even when an operator suspension was
	// already present. Suspension still outranks billing restrictions.
	switch {
	case deletedAt != nil:
		status.State = AccountDeleted
		return status, nil
	case deletionRequestedAt != nil:
		status.State = AccountDeletionPending
		return status, nil
	case suspendedAt != nil:
		status.State = AccountSuspended
		return status, nil
	}

	status.State = AccountActive
	if err := s.applyQuotaState(ctx, q, &status); err != nil {
		return status, err
	}
	return status, nil
}

// applyQuotaState downgrades an otherwise-active account when its paid period
// has lapsed and its stored bytes exceed the tier limit. A live Free row does
// not erase that paid-lapse boundary: it selects Free limits, while the most
// recent expired Pro period still determines grace versus frozen.
func (s *Store) applyQuotaState(
	ctx context.Context,
	q rowQueryer,
	status *AccountStatus,
) error {
	var liveTier *PlanTier
	var expiredPeriodEnd, closedAt *time.Time
	var hasPaidSubscription bool
	err := q.QueryRow(ctx, `SELECT count(*) FILTER (WHERE plan_tier='pro') > 0,
		(SELECT live.plan_tier FROM user_subscriptions live
			WHERE live.user_id=$1 AND live.status IN `+entitlingStatuses+`
				AND (live.current_period_end IS NULL OR live.current_period_end > now())
			ORDER BY (live.plan_tier='pro') DESC,
				live.current_period_end DESC NULLS FIRST LIMIT 1),
		max(current_period_end) FILTER (
			WHERE plan_tier='pro' AND status IN `+entitlingStatuses+`
				AND current_period_end <= now()),
		max(LEAST(
			COALESCE(current_period_end, ended_at, canceled_at,
				to_timestamp(NULLIF(stripe_event_created, 0)), updated_at),
			COALESCE(ended_at, canceled_at,
				to_timestamp(NULLIF(stripe_event_created, 0)), updated_at)
		))
			FILTER (WHERE plan_tier='pro' AND status NOT IN `+entitlingStatuses+`)
		FROM user_subscriptions WHERE user_id=$1`, status.UserID).
		Scan(&hasPaidSubscription, &liveTier, &expiredPeriodEnd, &closedAt)
	if err != nil && !isNoRows(err) {
		return err
	}
	if !hasPaidSubscription {
		return nil
	}
	var lapsedAt *time.Time
	if liveTier != nil && *liveTier == PlanPro {
		status.PlanTier = *liveTier
		return nil
	}
	lapsedAt = expiredPeriodEnd
	if lapsedAt == nil || (closedAt != nil && closedAt.After(*lapsedAt)) {
		lapsedAt = closedAt
	}
	if lapsedAt == nil {
		// A live Free subscription without an observed paid-period boundary is
		// an ordinary Free account, not an over-quota lapse.
		return nil
	}
	// A missed Stripe webhook must not leave expired Pro entitlements active.
	// Keep the stored projection for reconciliation, but apply Free limits to
	// every request after the latest paid period ends.
	status.PlanTier = PlanFree

	usage, err := s.unlockedStorageUsage(ctx, q, status.UserID)
	if err != nil {
		return err
	}
	freeLimits, err := s.PlanLimits(PlanFree)
	if err != nil {
		return err
	}
	usage.PlanTier = PlanFree
	usage.LimitBytes = freeLimits.StorageBytes
	if usage.UsedBytes+usage.ReservedBytes <= usage.LimitBytes {
		return nil
	}
	status.StorageUsedBytes = usage.UsedBytes + usage.ReservedBytes
	status.StorageLimitBytes = usage.LimitBytes
	status.StorageUsage = StorageUsageFull

	graceEnds := lapsedAt.AddDate(0, 0, overQuotaBufferDays)
	status.GraceEndsAt = &graceEnds
	if time.Now().Before(graceEnds) {
		status.State = AccountOverQuotaGrace
	} else {
		status.State = AccountOverQuotaFrozen
	}
	return nil
}
