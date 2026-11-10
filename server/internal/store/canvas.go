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
// the same member's canvas (WorkspaceCanvas then reads the one that won), and
// when a trashed canvas is restored beside the live one made since.
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
// board asset and the images now on the canvas, each a ready asset of this
// material with that purpose (anything else is refused as invalid), and the
// save's version, one past the last. The caller's revision must be the stored
// one (ErrConflict otherwise: the same person's other tab saved first). The
// pruner trashes the board asset and images the new document no longer names.
func (s *Store) SaveWorkspaceCanvas(ctx context.Context, userID, materialID, boardAssetID string, imageAssetIDs []string, revision int64) (Material, error) {
	current, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return Material{}, err
	}
	if current.Kind != MaterialCanvas || current.OwnerUserID != userID {
		return Material{}, ErrNotFound
	}
	last, err := materialdoc.ReadCanvasBoard(current.Content)
	if err != nil {
		return Material{}, err
	}
	// A stale tab hears that first (UpdateMaterial checks it again, in its transaction).
	if current.Revision != revision {
		return Material{}, ErrConflict
	}
	if err := s.assertCanvasAssets(ctx, materialID, boardAssetID, imageAssetIDs); err != nil {
		return Material{}, err
	}
	content, err := materialdoc.CanvasDocument(materialdoc.CanvasBoard{
		BoardAssetID: boardAssetID, Version: last.Version + 1, ImageAssetIDs: imageAssetIDs,
	})
	if err != nil {
		return Material{}, err
	}
	return s.UpdateMaterial(ctx, materialID, MaterialPatch{
		Content: &content, ExpectedRevision: &revision, UpdatedBy: userID,
	})
}

// assertCanvasAssets checks the save names only this material's ready assets:
// the board an untrashed `board` asset, each image an `image` asset. An image
// the pruner trashed may be named again (its delete undone on the canvas): the
// save's prune restores it, as a note's does.
func (s *Store) assertCanvasAssets(ctx context.Context, materialID, boardAssetID string, imageAssetIDs []string) error {
	want := map[string]string{boardAssetID: "board"}
	for _, id := range imageAssetIDs {
		want[id] = "image"
	}
	ids := make([]string, 0, len(want))
	for id := range want {
		ids = append(ids, id)
	}
	rows, err := s.pool.Query(ctx, `SELECT id, purpose, trashed_at IS NOT NULL FROM editor_assets
		WHERE material_id=$1 AND status='ready' AND id = ANY($2::text[])`, materialID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	found := 0
	for rows.Next() {
		var id, purpose string
		var trashed bool
		if err := rows.Scan(&id, &purpose, &trashed); err != nil {
			return err
		}
		if want[id] != purpose || (trashed && purpose == "board") {
			return fmt.Errorf("%w: asset %s is not a %s of this canvas", materialdoc.ErrInvalid, id, want[id])
		}
		found++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found != len(want) {
		return fmt.Errorf("%w: a save names only this canvas's ready assets", materialdoc.ErrInvalid)
	}
	return nil
}

// CanvasImageAssets are the canvas's ready image assets, one the pruner trashed
// included: the ids a save may name. The browser names from this list, so an
// image deleted for good (Files › Embeds) is left out of the next save, and one
// trashed after its delete on the canvas was undone is named again.
func (s *Store) CanvasImageAssets(ctx context.Context, materialID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM editor_assets
		WHERE material_id=$1 AND purpose='image' AND status='ready' ORDER BY created_at, id`, materialID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
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
