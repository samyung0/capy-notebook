package store

import (
	"context"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// SetItemHidden hides a workspace file or top-level material from the
// workspace's members, or shows it again (Epo 2026-11-03), for an actor who
// edits the workspace. Hiding evicts the item's live collaboration rooms, so
// a viewer reading it reconnects and is refused; owners and editors rejoin.
// A standalone or embedded item has no members to hide it from: not found.
func (s *Store) SetItemHidden(ctx context.Context, actorID string, kind agenttools.ResourceKind, id string, hidden bool) error {
	table := "files"
	if kind == agenttools.KindMaterial {
		table = "materials"
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var wsID *string
	embedded := false
	query := `SELECT workspace_id, false FROM files WHERE id=$1 AND trashed_at IS NULL`
	if table == "materials" {
		query = `SELECT workspace_id, parent_material_id IS NOT NULL FROM materials WHERE id=$1 AND trashed_at IS NULL`
	}
	if err := tx.QueryRow(ctx, query, id).Scan(&wsID, &embedded); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if wsID == nil || embedded {
		return ErrNotFound
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, *wsID, actorID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE `+table+` SET hidden=$2 WHERE id=$1 AND trashed_at IS NULL AND hidden<>$2`, id, hidden)
	if err != nil {
		return err
	}
	if hidden && tag.RowsAffected() > 0 {
		evict := `SELECT enqueue_source_collaboration_eviction($1, 'drain')`
		if table == "materials" {
			evict = `SELECT enqueue_material_collaboration_eviction($1, 'access-changed', 'drain')`
		}
		if _, err := tx.Exec(ctx, evict, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
