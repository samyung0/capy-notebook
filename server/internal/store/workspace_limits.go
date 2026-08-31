package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/evonotes/server/internal/planlimits"
)

var ErrWorkspaceLimitExceeded = errors.New("owned workspace limit exceeded")

type WorkspaceLimitExceededError struct {
	UserID    string
	Used      int
	Requested int
	Limit     int
	PlanTier  PlanTier
}

func (e *WorkspaceLimitExceededError) Error() string {
	return fmt.Sprintf(
		"%s: used=%d requested=%d limit=%d",
		ErrWorkspaceLimitExceeded,
		e.Used,
		e.Requested,
		e.Limit,
	)
}

func (e *WorkspaceLimitExceededError) Unwrap() error {
	return ErrWorkspaceLimitExceeded
}

// gateOwnedWorkspacesTx serializes finite ownership limits on the recipient's
// user row. OwnedWorkspaces == 0 is the in-memory representation of SQL NULL,
// so current free and Pro plans pass without a lock or count query.
func (s *Store) gateOwnedWorkspacesTx(
	ctx context.Context,
	tx pgx.Tx,
	userID string,
	requested int,
) (planlimits.Limits, error) {
	if requested < 0 {
		return planlimits.Limits{}, fmt.Errorf("negative workspace request: %d", requested)
	}
	var tier PlanTier
	if err := tx.QueryRow(ctx, `SELECT plan_tier FROM users WHERE id=$1`, userID).
		Scan(&tier); err != nil {
		if isNoRows(err) {
			return planlimits.Limits{}, ErrNotFound
		}
		return planlimits.Limits{}, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return planlimits.Limits{}, err
	}
	if limits.OwnedWorkspaces == 0 {
		return limits, nil
	}
	// Re-read the tier under the serialization lock. A concurrent plan change
	// must not leave us enforcing the stale tier selected above.
	if err := tx.QueryRow(ctx, `SELECT plan_tier FROM users WHERE id=$1 FOR UPDATE`, userID).
		Scan(&tier); err != nil {
		if isNoRows(err) {
			return planlimits.Limits{}, ErrNotFound
		}
		return planlimits.Limits{}, err
	}
	limits, err = s.PlanLimits(tier)
	if err != nil {
		return planlimits.Limits{}, err
	}
	if limits.OwnedWorkspaces == 0 {
		return limits, nil
	}
	var used int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE user_id=$1`, userID).
		Scan(&used); err != nil {
		return planlimits.Limits{}, err
	}
	if used+requested > limits.OwnedWorkspaces {
		return planlimits.Limits{}, &WorkspaceLimitExceededError{
			UserID: userID, Used: used, Requested: requested,
			Limit: limits.OwnedWorkspaces, PlanTier: tier,
		}
	}
	return limits, nil
}
