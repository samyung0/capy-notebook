package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// resolveUploadChapterID validates an existing chapter or find-or-creates a
// named chapter inside the caller's transaction. Locking the workspace row
// serializes concurrent upload-created chapters with the same name.
func resolveUploadChapterID(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID string,
	chapterID *string,
	chapterName string,
) (*string, error) {
	if chapterID != nil {
		var chapterWorkspaceID string
		err := tx.QueryRow(ctx, `SELECT workspace_id FROM chapters WHERE id=$1`, *chapterID).
			Scan(&chapterWorkspaceID)
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if chapterWorkspaceID != workspaceID {
			return nil, ErrForbidden
		}
		return chapterID, nil
	}

	chapterName = strings.TrimSpace(chapterName)
	if chapterName == "" {
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
		`SELECT id FROM chapters
		 WHERE workspace_id=$1 AND lower(name)=lower($2)
		 ORDER BY position
		 LIMIT 1`,
		workspaceID, chapterName,
	).Scan(&existingID)
	if err == nil {
		return &existingID, nil
	}
	if !isNoRows(err) {
		return nil, err
	}

	var position int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM chapters WHERE workspace_id=$1`, workspaceID).
		Scan(&position); err != nil {
		return nil, err
	}
	newID := uid("ch")
	if _, err := tx.Exec(ctx,
		`INSERT INTO chapters (id, workspace_id, name, position) VALUES ($1,$2,$3,$4)`,
		newID, workspaceID, chapterName, position,
	); err != nil {
		return nil, err
	}
	return &newID, nil
}
