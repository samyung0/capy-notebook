package store

import (
	"context"
	"errors"
)

// Ownership transfer hands a workspace to another member. It moves no storage
// charges: every file, asset and material stays charged to the account that
// uploaded or created it (uploader pays, Sam 2026-10-18). It is independent
// of account deletion: deleting an account hides every owned workspace during
// the grace window and destroys it at purge, even when collaborators remain.

// ErrTransferSelf reports a transfer to the current owner.
var ErrTransferSelf = errors.New("workspace already belongs to this user")

// TransferWorkspace hands a workspace to another member. Owner-only, and
// refused past the recipient's owned-workspace and file caps.
func (s *Store) TransferWorkspace(
	ctx context.Context,
	actorID, workspaceID, recipientID string,
) (Workspace, error) {
	if err := s.AssertWorkspaceOwner(ctx, actorID, workspaceID); err != nil {
		return Workspace{}, err
	}
	if recipientID == actorID {
		return Workspace{}, ErrTransferSelf
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Workspace{}, err
	}
	defer tx.Rollback(ctx)

	var currentOwner string
	err = tx.QueryRow(ctx, `SELECT user_id FROM workspaces WHERE id=$1 FOR UPDATE`,
		workspaceID).Scan(&currentOwner)
	if isNoRows(err) {
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, err
	}
	// Re-checked under the lock: the owner may have changed since the assertion.
	if currentOwner != actorID {
		return Workspace{}, ErrForbidden
	}
	// Workspace-scoped writes take the workspace lock before lifecycle locks.
	// A locked recipient reads as a non-member: its state and reason stay its
	// own (review C2).
	if err := s.lockAccountSessionsTx(ctx, tx, actorID, recipientID); err != nil {
		return Workspace{}, HideOtherAccountLock(err, actorID)
	}
	recipientLimits, err := s.gateOwnedWorkspacesTx(ctx, tx, recipientID, 1)
	if err != nil {
		return Workspace{}, err
	}

	// The recipient has to be a live member; handing a workspace to a
	// tombstone would strand it.
	var recipientRole WorkspaceRole
	err = tx.QueryRow(ctx, `SELECT wm.role
		FROM workspace_members wm
		JOIN users u ON u.id = wm.user_id
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND u.deleted_at IS NULL
		FOR UPDATE OF wm`, workspaceID, recipientID).Scan(&recipientRole)
	if isNoRows(err) {
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, err
	}
	files, reservedFiles, err := s.workspaceFileUsageTx(ctx, tx, workspaceID)
	if err != nil {
		return Workspace{}, err
	}
	if files+reservedFiles > recipientLimits.FilesPerWorkspace {
		return Workspace{}, &FileLimitExceededError{
			WorkspaceID: workspaceID,
			Used:        files,
			Reserved:    reservedFiles,
			Limit:       recipientLimits.FilesPerWorkspace,
			Kind:        "workspace",
		}
	}

	if _, err := tx.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`,
		workspaceID, recipientID); err != nil {
		return Workspace{}, err
	}

	// Role swap. The outgoing owner keeps editor access rather than losing the
	// workspace outright, which is the least surprising outcome and is trivially
	// reversible by the new owner.
	if _, err := tx.Exec(ctx, `UPDATE workspace_members
		SET role='owner', updated_at=now() WHERE workspace_id=$1 AND user_id=$2`,
		workspaceID, recipientID); err != nil {
		return Workspace{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor')
		ON CONFLICT (workspace_id, user_id) DO UPDATE
			SET role='editor', updated_at=now()`,
		workspaceID, actorID); err != nil {
		return Workspace{}, err
	}
	// Invites were the old owner's; the new owner starts with none pending
	// (human authorization, 2026-10-19 10b).
	if _, err := tx.Exec(ctx, `UPDATE workspace_invites SET revoked_at=now()
		WHERE workspace_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`, workspaceID); err != nil {
		return Workspace{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, recipientID, workspaceID)
}

// WorkspacesDestroyedByDeletion lists every workspace the user owns. Ownership
// controls lifecycle: collaborators lose access while deletion is pending and
// the workspace is destroyed with the owner after the grace window.
func (s *Store) WorkspacesDestroyedByDeletion(
	ctx context.Context,
	userID string,
) ([]Workspace, error) {
	return s.ownedWorkspaces(ctx, userID)
}

// WorkspacesBlockingDeletion remains for API compatibility. Collaborators do
// not block deletion because the owner is the workspace lifecycle authority.
func (s *Store) WorkspacesBlockingDeletion(
	context.Context,
	string,
) ([]Workspace, error) {
	return []Workspace{}, nil
}

// ownedWorkspaces lists every workspace owned by the user.
func (s *Store) ownedWorkspaces(
	ctx context.Context,
	userID string,
) ([]Workspace, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+wsCols+`
		FROM workspaces w
		WHERE w.user_id=$1
		ORDER BY w.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Workspace{}
	for rows.Next() {
		w, err := s.scanWorkspace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
