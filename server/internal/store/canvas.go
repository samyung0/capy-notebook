package store

import (
	"context"
	"errors"
	"fmt"
	"time"

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

// CanvasListItem is one of a person's canvases: one of their own, or the one
// they drew in a workspace (WorkspaceID names it).
type CanvasListItem struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	WorkspaceID     string    `json:"workspaceId,omitempty" doc:"The workspace whose Canvas tab this is; none for a canvas of the caller's own"`
	WorkspaceName   string    `json:"workspaceName,omitempty"`
	WorkspaceIconID string    `json:"workspaceIconId,omitempty"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// CanvasPage is one page of a person's canvases.
type CanvasPage struct {
	Items      []CanvasListItem `json:"items" nullable:"false"`
	NextCursor string           `json:"nextCursor,omitempty" doc:"Absent on the last page"`
}

// A person's own canvases come first, latest saved first, then the ones of
// their workspaces: an own canvas sorts a thousand years ahead of any save.
var canvasSort = listSort{
	column: "(CASE WHEN m.canvas_workspace_id IS NULL THEN m.updated_at + interval '1000 years' ELSE m.updated_at END)",
	kind:   "time",
}

// ListCanvases pages through every canvas the caller owns: their own, latest
// saved first, then the ones of their workspaces (Epo 2026-11-10: the account's
// Canvas page shows all there are, a page at a time). A workspace whose owner's
// account is no longer live is left out, like every other read of that
// workspace.
func (s *Store) ListCanvases(ctx context.Context, userID string, limit int, cursor string) (CanvasPage, error) {
	if limit <= 0 || limit > listPageMax {
		limit = listPageMax
	}
	args := []any{userID}
	clause, cursorArgs, err := cursorClause(canvasSort, "m.id", false, cursor, len(args)+1)
	if err != nil {
		return CanvasPage{}, err
	}
	args = append(args, cursorArgs...)
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, COALESCE(m.canvas_workspace_id, ''),
			COALESCE(w.name, ''), COALESCE(w.icon_id, ''), m.updated_at, `+canvasSort.column+`
		FROM materials m LEFT JOIN workspaces w ON w.id = m.canvas_workspace_id
		WHERE m.kind='canvas' AND m.owner_user_id=$1 AND m.trashed_at IS NULL
			AND (m.canvas_workspace_id IS NULL OR `+liveWorkspaceSQL("m.canvas_workspace_id")+`)`+
		clause+orderClause(canvasSort, "m.id", false)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return CanvasPage{}, err
	}
	var keys []time.Time
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (CanvasListItem, error) {
		var item CanvasListItem
		var key time.Time
		err := row.Scan(&item.ID, &item.Title, &item.WorkspaceID, &item.WorkspaceName, &item.WorkspaceIconID, &item.UpdatedAt, &key)
		keys = append(keys, key)
		return item, err
	})
	if err != nil {
		return CanvasPage{}, err
	}
	page := CanvasPage{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextCursor = encodeListCursor(cursorPrimary(canvasSort, keys[limit-1], "", 0), items[limit-1].ID)
	}
	return page, nil
}

// CreateCanvas makes a canvas of the caller's own, in no workspace.
func (s *Store) CreateCanvas(ctx context.Context, userID, title string) (Material, error) {
	content, err := materialdoc.CanvasDocument(materialdoc.CanvasBoard{ImageAssetIDs: []string{}})
	if err != nil {
		return Material{}, err
	}
	return s.CreateMaterial(ctx, Material{
		CreatedBy: userID, Kind: MaterialCanvas, Title: title, Content: content, Privacy: "private",
	})
}

// OwnCanvas is one of the caller's own canvases, in no workspace, by id. Anyone
// else's, another kind of material, or a workspace's canvas (opened through its
// workspace, whose membership it follows) is not found.
func (s *Store) OwnCanvas(ctx context.Context, userID, materialID string) (Material, error) {
	mt, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return Material{}, err
	}
	if mt.Kind != MaterialCanvas || mt.OwnerUserID != userID || mt.CanvasWorkspaceID != "" {
		return Material{}, ErrNotFound
	}
	return mt, nil
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
