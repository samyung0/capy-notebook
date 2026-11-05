package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// nextTopicPositionTx is a new topic's position in wsID, the end of its list,
// refusing one past the workspace owner's plan cap (10 on Free, 20 on Pro, Epo
// 2026-11-03). It locks the workspace row, which serializes topic creates; a
// workspace already past the cap after a downgrade keeps its topics.
func (s *Store) nextTopicPositionTx(ctx context.Context, tx pgx.Tx, wsID string) (int, error) {
	tier, err := s.lockWorkspaceOwnerPlanTx(ctx, tx, wsID)
	if err != nil {
		return 0, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return 0, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM topics WHERE workspace_id=$1`, wsID).
		Scan(&count); err != nil {
		return 0, err
	}
	if count >= limits.TopicsPerWorkspace {
		return 0, ErrTooManyTopics
	}
	return count, nil
}

// assertUploadTopicFitsTx refuses an upload naming a new topic the workspace has
// no room for, before its bytes are sent. resolveUploadTopicID still decides when
// the file arrives, as another topic may take the last place in between.
func (s *Store) assertUploadTopicFitsTx(ctx context.Context, tx pgx.Tx, workspaceID, topicName string) error {
	topicName = strings.TrimSpace(topicName)
	if workspaceID == "" || topicName == "" {
		return nil
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM topics WHERE workspace_id=$1 AND lower(name)=lower($2))`,
		workspaceID, topicName).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	_, err := s.nextTopicPositionTx(ctx, tx, workspaceID)
	return err
}

// resolveUploadTopicID validates an existing topic or find-or-creates a
// named topic inside the caller's transaction. Locking the workspace row
// serializes concurrent topics created by name (uploads, bank copies).
func (s *Store) resolveUploadTopicID(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID string,
	topicID *string,
	topicName string,
) (*string, error) {
	if topicID != nil {
		var topicWorkspaceID string
		err := tx.QueryRow(ctx, `SELECT workspace_id FROM topics WHERE id=$1`, *topicID).
			Scan(&topicWorkspaceID)
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if topicWorkspaceID != workspaceID {
			return nil, ErrForbidden
		}
		return topicID, nil
	}

	topicName = strings.TrimSpace(topicName)
	if topicName == "" {
		return nil, nil
	}

	var lockedWorkspaceID string
	if err := tx.QueryRow(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, workspaceID).
		Scan(&lockedWorkspaceID); err != nil {
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	var existingID string
	err := tx.QueryRow(ctx,
		`SELECT id FROM topics
		 WHERE workspace_id=$1 AND lower(name)=lower($2)
		 ORDER BY position
		 LIMIT 1`,
		workspaceID, topicName,
	).Scan(&existingID)
	if err == nil {
		return &existingID, nil
	}
	if !isNoRows(err) {
		return nil, err
	}

	position, err := s.nextTopicPositionTx(ctx, tx, workspaceID)
	if err != nil {
		return nil, err
	}
	newID := uid("tp")
	if _, err := tx.Exec(ctx,
		`INSERT INTO topics (id, workspace_id, name, position) VALUES ($1,$2,$3,$4)`,
		newID, workspaceID, topicName, position,
	); err != nil {
		return nil, err
	}
	return &newID, nil
}
