package store

import (
	"context"
	"fmt"
	"math/rand/v2"
	"regexp"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Account chat's create_workspace (Epo 2026-10-28): an optional name, else
// "New Workspace (n)" with the lowest n none of the user's own workspaces is
// named with; a random Waves icon and no cover, as the New workspace dialog
// gives; no Undo.

var newWorkspaceNameRE = regexp.MustCompile(`^New Workspace \(([1-9][0-9]*)\)$`)

// nextNewWorkspaceNameTx is the default name. gateWorkspacesTx has
// serialized on the user's row, so two creates cannot take the same n.
func nextNewWorkspaceNameTx(ctx context.Context, tx pgx.Tx, userID string) (string, error) {
	rows, err := tx.Query(ctx, `SELECT name FROM workspaces WHERE user_id=$1 AND name LIKE 'New Workspace (%)'`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	taken := map[int]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return "", err
		}
		if m := newWorkspaceNameRE.FindStringSubmatch(name); m != nil {
			n, _ := strconv.Atoi(m[1])
			taken[n] = true
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	n := 1
	for taken[n] {
		n++
	}
	return fmt.Sprintf("New Workspace (%d)", n), nil
}

// randomWaveIconID is one of the Waves icons the New workspace dialog picks
// from (WorkspaceFormDialog, icon-catalog.json).
func randomWaveIconID() string {
	return fmt.Sprintf("waves-%02d", rand.IntN(11)+1)
}

// CreateWorkspaceOperation creates an account chat's workspace and records its
// receipt in one transaction; a replay of the same call returns the receipt.
// The receipt names the workspace (WorkspaceID) and carries no effect, so the
// chat offers no Undo.
func (s *Store) CreateWorkspaceOperation(ctx context.Context, actorID string, input WorkspaceCreate, op AgentOperation) (_ AgentOperation, created bool, _ error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, false, err
	}
	defer tx.Rollback(ctx)
	existing, err := lockAgentOperationTx(ctx, tx, op.ID, op.RequestHash)
	if err != nil {
		return AgentOperation{}, false, err
	}
	if existing != nil {
		return *existing, false, nil
	}
	if input.IconID == nil {
		icon := randomWaveIconID()
		input.IconID = &icon
	}
	if input.Name == "" {
		// The gate below locks the account first; name it after that.
		if err := s.lockAccountSessionsTx(ctx, tx, actorID); err != nil {
			return AgentOperation{}, false, err
		}
		if input.Name, err = nextNewWorkspaceNameTx(ctx, tx, actorID); err != nil {
			return AgentOperation{}, false, err
		}
	}
	id, err := s.createWorkspaceTx(ctx, tx, actorID, input)
	if err != nil {
		return AgentOperation{}, false, err
	}
	op.Kind = "create_workspace"
	op.WorkspaceID = id
	op.Outcome = agenttools.OutcomeSucceeded
	op.Effect, op.Error = nil, nil
	if err := insertAgentOperationTx(ctx, tx, op); err != nil {
		return AgentOperation{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentOperation{}, false, err
	}
	return op, true, nil
}
