package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Ownership transfer lets an owner hand a workspace and its storage charges to
// another member. It is independent of account deletion: deleting an account
// hides every owned workspace during the grace window and destroys it at purge,
// even when collaborators remain.
//
// The workspace's storage owner is denormalized onto four tables (files.user_id,
// materials.owner_user_id, upload_sessions.user_id, editor_assets.user_id). Those
// columns were only ever safe because nothing could change them after insert:
// the owner-deriving triggers fire on insert and on a workspace move, never on a
// workspace changing hands. Transfer therefore has to rewrite all four
// explicitly, and every byte has to land on the recipient's counter in the same
// transaction — see TestOwnerColumnsAreCoveredByTransfer, which fails if a fifth
// owner column appears.

// ErrTransferSelf reports a transfer to the current owner.
var ErrTransferSelf = errors.New("workspace already belongs to this user")

// ownerColumns is every (table, column) pair carrying a denormalized storage
// owner. Transfer rewrites each one; the accounting triggers on these tables
// convert an owner change into the matching counter movement.
var ownerColumns = []struct{ table, column string }{
	{"files", "user_id"},
	{"materials", "owner_user_id"},
	{"upload_sessions", "user_id"},
	{"editor_assets", "user_id"},
}

// TransferWorkspace moves a workspace and everything charged for it to another
// member. Owner-only, and refused if the recipient cannot fit the bytes.
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
	// Workspace-scoped writes take the workspace lock before lifecycle and
	// storage locks. Transfer uses the same order so it cannot deadlock with an
	// upload/material insert while also making the owner immutable for this tx.
	if err := s.lockAccountSessionsTx(ctx, tx, actorID, recipientID); err != nil {
		return Workspace{}, err
	}
	recipientLimits, err := s.gateOwnedWorkspacesTx(ctx, tx, recipientID, 1)
	if err != nil {
		return Workspace{}, err
	}

	// Both counter rows are locked in a fixed order. Two transfers crossing
	// between the same pair of users would otherwise deadlock.
	first, second := actorID, recipientID
	if second < first {
		first, second = second, first
	}
	if err := s.lockStorageRowTx(ctx, tx, first); err != nil {
		return Workspace{}, err
	}
	if err := s.lockStorageRowTx(ctx, tx, second); err != nil {
		return Workspace{}, err
	}

	// The recipient has to be a live member. Handing a workspace to a stranger
	// would charge them for bytes they never agreed to, and handing it to a
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

	bytes, err := s.workspaceChargedBytesTx(ctx, tx, workspaceID)
	if err != nil {
		return Workspace{}, err
	}
	// Gated on the recipient, not the sender: the sender is giving bytes up.
	// Reservations count toward the request because they land on the recipient
	// too, and an upload finishing after the transfer must still fit.
	if err := s.gateStorageTx(ctx, tx, recipientID, bytes.used+bytes.reserved); err != nil {
		return Workspace{}, err
	}

	if _, err := tx.Exec(ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`,
		workspaceID, recipientID); err != nil {
		return Workspace{}, err
	}
	for _, col := range ownerColumns {
		// Table and column names are from the fixed list above, never from input.
		query := fmt.Sprintf(
			`UPDATE %s SET %s=$2 WHERE workspace_id=$1 AND %s IS DISTINCT FROM $2`,
			col.table, col.column, col.column)
		if _, err := tx.Exec(ctx, query, workspaceID, recipientID); err != nil {
			return Workspace{}, fmt.Errorf("transfer %s.%s: %w", col.table, col.column, err)
		}
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

	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, recipientID, workspaceID, false)
}

type workspaceBytes struct {
	used     int64
	reserved int64
}

// workspaceChargedBytesTx totals what the workspace costs its owner, split the
// same way the counters are. Materials use owner_user_id rather than
// workspace_id because a standalone material has no workspace, so only the ones
// actually filed here move.
func (s *Store) workspaceChargedBytesTx(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID string,
) (workspaceBytes, error) {
	var out workspaceBytes
	err := tx.QueryRow(ctx, `SELECT
			COALESCE((SELECT sum(size_bytes) FROM files WHERE workspace_id=$1), 0)
			+ COALESCE((SELECT sum(size_bytes) FROM editor_assets
				WHERE workspace_id=$1 AND status='ready'), 0)
			+ COALESCE((SELECT sum(size_bytes) FROM materials WHERE workspace_id=$1), 0)
			+ COALESCE((SELECT sum(d.storage_bytes) FROM source_documents d JOIN files f ON f.id=d.file_id WHERE f.workspace_id=$1),0)
			+ COALESCE((SELECT sum(c.storage_bytes) FROM source_refresh_candidates c JOIN files f ON f.id=c.file_id WHERE f.workspace_id=$1),0),
			COALESCE((SELECT sum(COALESCE(reserved_size, declared_size)) FROM upload_sessions
				WHERE workspace_id=$1 AND status='pending' AND expires_at > now()), 0)`,
		workspaceID).Scan(&out.used, &out.reserved)
	return out, err
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
