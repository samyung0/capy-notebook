package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/planlimits"
)

var ErrWorkspaceLimitExceeded = errors.New("workspace limit exceeded")

type WorkspaceLimitExceededError struct {
	Used  int
	Limit int
}

func (e *WorkspaceLimitExceededError) Error() string {
	return fmt.Sprintf("%s: used=%d limit=%d", ErrWorkspaceLimitExceeded, e.Used, e.Limit)
}

func (e *WorkspaceLimitExceededError) Unwrap() error {
	return ErrWorkspaceLimitExceeded
}

// gateWorkspacesTx admits one more workspace for userID, owned or joined: the
// plan's cap counts both together (Epo 2026-10-28), as one count of its
// workspace_members rows, since every owner holds one with role owner. It
// serializes on the user's row. OwnedWorkspaces == 0 is the in-memory
// representation of SQL NULL (unlimited), which passes without a count.
func (s *Store) gateWorkspacesTx(ctx context.Context, tx pgx.Tx, userID string) (planlimits.Limits, error) {
	if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
		return planlimits.Limits{}, err
	}
	status, err := s.accountAccess(ctx, tx, userID)
	if err != nil {
		return planlimits.Limits{}, err
	}
	if err := status.Err(); err != nil {
		return planlimits.Limits{}, err
	}
	tier, err := s.effectivePlanTierForUser(ctx, tx, userID)
	if err != nil {
		return planlimits.Limits{}, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return planlimits.Limits{}, err
	}
	if limits.OwnedWorkspaces == 0 {
		return limits, nil
	}
	// Writing the row, not only locking it, makes a repeatable-read clone
	// whose snapshot predates a create or accept fail with 40001 and retry
	// rather than count past the cap (Epo 2026-10-28).
	if _, err := tx.Exec(ctx, `UPDATE users SET name=name WHERE id=$1`, userID); err != nil {
		return planlimits.Limits{}, err
	}
	var used int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE user_id=$1`, userID).
		Scan(&used); err != nil {
		return planlimits.Limits{}, err
	}
	if used >= limits.OwnedWorkspaces {
		return planlimits.Limits{}, &WorkspaceLimitExceededError{Used: used, Limit: limits.OwnedWorkspaces}
	}
	return limits, nil
}
