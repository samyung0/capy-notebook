package store

import (
	"context"
	"errors"
	"time"

	"github.com/danielgtaylor/huma/v2"
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
	// the tier limit, still inside the buffer window. Creation and upload are
	// blocked; existing materials accept shrinking edits only.
	AccountOverQuotaGrace AccountState = "over_quota_grace"
	// AccountOverQuotaFrozen is the same restriction after the buffer expires.
	// It persists until the user frees space or resubscribes. Nothing is ever
	// deleted on reaching this state.
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
	// Set only for the over-quota states, so the UI can explain how much has to
	// be freed before the account unlocks.
	StorageUsedBytes  int64 `json:"storageUsedBytes"`
	StorageLimitBytes int64 `json:"storageLimitBytes"`
	// GraceEndsAt is when over_quota_grace becomes over_quota_frozen.
	GraceEndsAt *time.Time `json:"graceEndsAt,omitempty"`
}

// CanAuthenticate reports whether the identity may hold a session at all.
func (a AccountStatus) CanAuthenticate() bool { return a.State != AccountDeleted }

// CanCreate reports whether new workspaces, files, materials, uploads or clones
// are permitted.
func (a AccountStatus) CanCreate() bool { return a.State == AccountActive }

// CanEdit reports whether existing content may be mutated in any direction.
func (a AccountStatus) CanEdit() bool { return a.State == AccountActive }

// ShrinkOnly reports whether existing material documents may only be edited in
// the shrinking direction. An over-quota account has to stay able to delete
// content, otherwise it can never recover.
func (a AccountStatus) ShrinkOnly() bool {
	return a.State == AccountOverQuotaGrace || a.State == AccountOverQuotaFrozen
}

// CanMutate reports whether the account may delete content or apply shrink-only
// material edits. Full edits still require CanEdit.
func (a AccountStatus) CanMutate() bool { return a.CanEdit() || a.ShrinkOnly() }

// Err returns the locked error for a state that forbids writes, or nil.
func (a AccountStatus) Err() error {
	if a.CanEdit() {
		return nil
	}
	return &AccountLockedError{UserID: a.UserID, State: a.State, Reason: a.SuspendedReason}
}

// CreateErr returns the locked error when creation is forbidden.
func (a AccountStatus) CreateErr() error {
	if a.CanCreate() {
		return nil
	}
	return &AccountLockedError{UserID: a.UserID, State: a.State, Reason: a.SuspendedReason}
}

// MutateErr returns the locked error when deletes / shrink edits are forbidden.
func (a AccountStatus) MutateErr() error {
	if a.CanMutate() {
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
// material's bytes, which is the account whose limits govern whether the
// document may grow. Every byte a collaborator adds lands on owner_user_id, so
// a write gate keyed on the connecting user answers the wrong question in both
// directions: it restricts an over-quota editor inside a healthy owner's
// workspace, and lets an active editor push an over-quota owner further over.
func (s *Store) MaterialOwnerAccess(
	ctx context.Context,
	materialID string,
) (AccountStatus, error) {
	var ownerID string
	err := s.pool.QueryRow(ctx,
		`SELECT owner_user_id FROM materials WHERE id=$1`, materialID).Scan(&ownerID)
	if isNoRows(err) {
		return AccountStatus{}, ErrNotFound
	}
	if err != nil {
		return AccountStatus{}, err
	}
	return s.accountAccess(ctx, s.pool, ownerID)
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
	if suspendedAt != nil {
		return false, (&AccountLockedError{State: AccountSuspended}).Code(), nil
	}
	if deletionRequestedAt != nil {
		return false, (&AccountLockedError{State: AccountDeletionPending}).Code(), nil
	}
	return true, "", nil
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

	// Ordered by severity: a purged account is terminal, and an explicit
	// suspension or deletion request outranks a billing restriction.
	switch {
	case deletedAt != nil:
		status.State = AccountDeleted
		return status, nil
	case suspendedAt != nil:
		status.State = AccountSuspended
		return status, nil
	case deletionRequestedAt != nil:
		status.State = AccountDeletionPending
		return status, nil
	}

	status.State = AccountActive
	if err := s.applyQuotaState(ctx, q, &status); err != nil {
		return status, err
	}
	return status, nil
}

// applyQuotaState downgrades an otherwise-active account when its paid period
// has lapsed and its stored bytes exceed the tier limit. Both conditions are
// required: a lapse alone is harmless if the user fits in the free tier, and
// being over the limit on a live subscription is a billing question, not a
// lifecycle one.
func (s *Store) applyQuotaState(
	ctx context.Context,
	q rowQueryer,
	status *AccountStatus,
) error {
	var lapsedAt *time.Time
	// The most recently ended paid period. A subscription that is still current
	// (or renews later) reports a future timestamp, which leaves the account
	// active; a user who never subscribed reports NULL.
	err := q.QueryRow(ctx, `SELECT max(current_period_end)
		FROM user_subscriptions
		WHERE user_id=$1 AND current_period_end IS NOT NULL`, status.UserID).Scan(&lapsedAt)
	if err != nil && !isNoRows(err) {
		return err
	}
	if lapsedAt == nil || lapsedAt.After(time.Now()) {
		return nil
	}

	usage, err := s.unlockedStorageUsage(ctx, q, status.UserID)
	if err != nil {
		return err
	}
	if usage.UsedBytes+usage.ReservedBytes <= usage.LimitBytes {
		return nil
	}
	status.StorageUsedBytes = usage.UsedBytes + usage.ReservedBytes
	status.StorageLimitBytes = usage.LimitBytes

	graceEnds := lapsedAt.AddDate(0, 0, overQuotaBufferDays)
	status.GraceEndsAt = &graceEnds
	if time.Now().Before(graceEnds) {
		status.State = AccountOverQuotaGrace
	} else {
		status.State = AccountOverQuotaFrozen
	}
	return nil
}
