package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// A member's personal workspace canvas (Epo 2026-11-09,
// todo-workspace-canvas-storage.md): a standalone material of kind canvas
// linked to its workspace by canvas_workspace_id, owned and paid for by the
// member who draws it, seen by them alone. Its saved board is the material's
// own `board` editor asset; the document names it and the canvas's images.

// ErrCanvasExists is the unique index's answer when two opens race to create
// the same member's canvas; WorkspaceCanvas then reads the one that won.
var ErrCanvasExists = errors.New("the member's canvas already exists")

// WorkspaceCanvas is the caller's canvas for the workspace, made on first
// open with the workspace's name as its title. The caller must be a member
// (checked by the route).
func (s *Store) WorkspaceCanvas(ctx context.Context, userID, wsID string) (Material, error) {
	if mt, err := s.memberCanvas(ctx, userID, wsID); err == nil || !errors.Is(err, ErrNotFound) {
		return mt, err
	}
	var title string
	err := s.pool.QueryRow(ctx, `SELECT name FROM workspaces WHERE id=$1`, wsID).Scan(&title)
	if isNoRows(err) {
		return Material{}, ErrNotFound
	}
	if err != nil {
		return Material{}, err
	}
	content, err := materialdoc.CanvasDocument(materialdoc.CanvasBoard{ImageAssetIDs: []string{}})
	if err != nil {
		return Material{}, err
	}
	mt, err := s.CreateMaterial(ctx, Material{
		CreatedBy: userID, Kind: MaterialCanvas, Title: title, Content: content,
		Privacy: "private", CanvasWorkspaceID: wsID,
	})
	if errors.Is(err, ErrCanvasExists) {
		return s.memberCanvas(ctx, userID, wsID)
	}
	return mt, err
}

func (s *Store) memberCanvas(ctx context.Context, userID, wsID string) (Material, error) {
	mt, err := scanMaterial(s.pool.QueryRow(ctx, `SELECT `+materialCols+` FROM materials
		WHERE kind='canvas' AND canvas_workspace_id=$1 AND owner_user_id=$2 AND trashed_at IS NULL`,
		wsID, userID))
	if isNoRows(err) {
		return Material{}, ErrNotFound
	}
	return mt, err
}

// SaveWorkspaceCanvas writes the canvas's document after a save: the new
// board asset, the save's version and the images now on the canvas. The
// caller's revision must be the stored one (ErrConflict otherwise: the same
// person's other tab saved first). The pruner trashes the board asset and
// images the new document no longer names.
func (s *Store) SaveWorkspaceCanvas(ctx context.Context, userID, materialID string, board materialdoc.CanvasBoard, revision int64) (Material, error) {
	current, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return Material{}, err
	}
	if current.Kind != MaterialCanvas || current.OwnerUserID != userID {
		return Material{}, ErrNotFound
	}
	content, err := materialdoc.CanvasDocument(board)
	if err != nil {
		return Material{}, err
	}
	return s.UpdateMaterial(ctx, materialID, MaterialPatch{
		Content: &content, ExpectedRevision: &revision, UpdatedBy: userID,
	})
}

// dropLeaverCanvasTx deletes the member's canvas in the workspace they leave
// (or are removed from), its assets with it (Epo 2026-11-09: it goes with the
// membership, as their marked drawings do).
func dropLeaverCanvasTx(ctx context.Context, tx pgx.Tx, wsID, userID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM materials
		WHERE kind='canvas' AND canvas_workspace_id=$1 AND owner_user_id=$2`, wsID, userID); err != nil {
		return fmt.Errorf("drop the leaver's canvas: %w", err)
	}
	return nil
}
