package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// A person's canvases (Epo 2026-11-09, todo-workspace-canvas-storage.md): a
// standalone material of kind canvas, owned and paid for by the person who
// makes it. One drawn in a workspace names it in canvas_workspace_id; a member
// has any number there (Epo 2026-11-12), as on the account's Canvas page. Its
// board lives in the canvas's collaboration room (Epo 2026-11-18); the
// document is the one block the room projects, naming the board's images. Its
// creator alone sees it until they share it with the workspace (canvas_shared),
// whose members then hold it by their workspace role
// (materialAccessRow.canvasRole).

// Who administers a canvas. PROVISIONAL, open question 3 of the canvas
// collaboration contract (Epo to answer): its creator alone shares, unshares
// and renames it (SetCanvasShared, UpdateMaterial), and deletes it (the
// standalone rule of trashMaterialTx: only the owner of a material in no
// workspace trashes it).
func canvasAdmin(creatorID, userID string) bool {
	return userID != "" && creatorID == userID
}

// Who may share a canvas with its workspace. PROVISIONAL, open question 3 (as
// canvasAdmin): its creator while an owner or editor there, so a viewer shares
// none of theirs; unsharing needs no role.
func canShareCanvas(workspaceRole WorkspaceRole) bool {
	return RoleCanEdit(workspaceRole)
}

// CanvasListItem is one of the canvases a person sees: one of their own, one
// they drew in a workspace (WorkspaceID names it), or another member's shared
// with that workspace.
type CanvasListItem struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	WorkspaceID     string    `json:"workspaceId,omitempty" doc:"The workspace whose Canvas tab this is; none for a canvas of the caller's own"`
	WorkspaceName   string    `json:"workspaceName,omitempty"`
	WorkspaceIconID string    `json:"workspaceIconId,omitempty"`
	Shared          bool      `json:"shared" doc:"Shared with its workspace: the members hold it by their workspace role"`
	Own             bool      `json:"own" doc:"The caller made it"`
	CreatorName     string    `json:"creatorName,omitempty" doc:"Who made it, on another member's canvas; absent on the caller's own"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

// Canvas is a canvas material with its sharing.
type Canvas struct {
	Material
	// Shared is canvas_shared: the workspace it was drawn in holds it.
	Shared bool
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

// ListCanvases pages through every canvas the caller made: their own, latest
// saved first, then the ones of their workspaces (Epo 2026-11-10: the account's
// Canvas page shows all there are, a page at a time). A workspace id lists its
// Canvas tab instead (Epo 2026-11-12): the ones the caller drew there and the
// other members' shared ones (Epo 2026-11-18); the caller's membership is the
// route's to check. A workspace whose owner's account is no longer live is
// left out, like every other read of that workspace, and so is a canvas whose
// creator's is not: the list holds what GetCanvas opens.
func (s *Store) ListCanvases(ctx context.Context, userID, workspaceID string, limit int, cursor string) (CanvasPage, error) {
	if limit <= 0 || limit > listPageMax {
		limit = listPageMax
	}
	args := []any{userID}
	which := `m.owner_user_id=$1`
	if workspaceID != "" {
		args = append(args, workspaceID)
		which = fmt.Sprintf(`m.canvas_workspace_id=$%d AND (m.owner_user_id=$1 OR m.canvas_shared)`, len(args))
	}
	clause, cursorArgs, err := cursorClause(canvasSort, "m.id", false, cursor, len(args)+1)
	if err != nil {
		return CanvasPage{}, err
	}
	args = append(args, cursorArgs...)
	args = append(args, limit+1)
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, COALESCE(m.canvas_workspace_id, ''),
			COALESCE(w.name, ''), COALESCE(w.icon_id, ''), m.canvas_shared, m.owner_user_id=$1,
			CASE WHEN m.owner_user_id=$1 THEN '' ELSE COALESCE(NULLIF(creator.name,''), creator.id) END,
			m.updated_at, `+canvasSort.column+`
		FROM materials m JOIN users creator ON creator.id = m.owner_user_id
		LEFT JOIN workspaces w ON w.id = m.canvas_workspace_id
		WHERE m.kind='canvas' AND `+which+` AND m.trashed_at IS NULL
			-- The creator's lifecycle hides a canvas, as materialEffectiveAccess reads it.
			AND creator.deleted_at IS NULL AND creator.deletion_requested_at IS NULL
			AND (creator.suspended_at IS NULL OR creator.id=$1)
			AND (m.canvas_workspace_id IS NULL OR `+liveWorkspaceSQL("m.canvas_workspace_id")+`)`+
		clause+orderClause(canvasSort, "m.id", false)+fmt.Sprintf(` LIMIT $%d`, len(args)), args...)
	if err != nil {
		return CanvasPage{}, err
	}
	var keys []time.Time
	items, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (CanvasListItem, error) {
		var item CanvasListItem
		var key time.Time
		err := row.Scan(&item.ID, &item.Title, &item.WorkspaceID, &item.WorkspaceName, &item.WorkspaceIconID,
			&item.Shared, &item.Own, &item.CreatorName, &item.UpdatedAt, &key)
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

// CreateCanvas makes a canvas of the caller's, private to them, drawn in the
// workspace if one is named (the caller's membership is the route's to check),
// else in none. Its document is the empty block (version 0, no images); the
// board's first state is seeded by the collaboration server when the canvas is
// first opened, so no Yjs row is written here.
func (s *Store) CreateCanvas(ctx context.Context, userID, title, workspaceID string) (Material, error) {
	content, err := materialdoc.CanvasDocument(materialdoc.CanvasBoard{ImageAssetIDs: []string{}})
	if err != nil {
		return Material{}, err
	}
	return s.CreateMaterial(ctx, Material{
		CreatedBy: userID, Kind: MaterialCanvas, Title: title, Content: content, Privacy: "private",
		CanvasWorkspaceID: workspaceID,
	})
}

// GetCanvas is a canvas the caller holds a role on
// (materialAccessRow.canvasRole). Anyone else's, or another kind of material,
// is not found.
func (s *Store) GetCanvas(ctx context.Context, userID, materialID string) (Canvas, error) {
	mt, err := s.GetMaterial(ctx, materialID)
	if err != nil {
		return Canvas{}, err
	}
	if mt.Kind != MaterialCanvas {
		return Canvas{}, ErrNotFound
	}
	if _, err := s.MaterialEffectiveRole(ctx, userID, materialID); err != nil {
		return Canvas{}, err
	}
	canvas := Canvas{Material: mt}
	err = s.pool.QueryRow(ctx, `SELECT canvas_shared FROM materials WHERE id=$1 AND trashed_at IS NULL`,
		materialID).Scan(&canvas.Shared)
	if isNoRows(err) {
		return Canvas{}, ErrNotFound
	}
	return canvas, err
}

// SetCanvasShared shares a canvas with the workspace it was drawn in, or takes
// it back (Epo 2026-11-18): the one room stays, and unsharing closes the other
// members' channels through the revoke migration 0182 queues. A canvas of
// one's own, in no workspace, is refused as invalid. Who may is canvasAdmin
// and canShareCanvas.
func (s *Store) SetCanvasShared(ctx context.Context, userID, materialID string, shared bool) (Canvas, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Canvas{}, err
	}
	defer tx.Rollback(ctx)
	// A canvas out of the caller's reach is not found, whoever made it.
	if _, err := materialEffectiveAccess(ctx, tx, userID, materialID); err != nil {
		return Canvas{}, err
	}
	var kind MaterialKind
	var creatorID string
	var workspaceID *string
	if err := tx.QueryRow(ctx, `SELECT kind, owner_user_id, canvas_workspace_id
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, materialID).Scan(&kind, &creatorID, &workspaceID); err != nil {
		if isNoRows(err) {
			return Canvas{}, ErrNotFound
		}
		return Canvas{}, err
	}
	if kind != MaterialCanvas {
		return Canvas{}, ErrNotFound
	}
	if !canvasAdmin(creatorID, userID) {
		return Canvas{}, ErrForbidden
	}
	if workspaceID == nil {
		return Canvas{}, fmt.Errorf("%w: a canvas in no workspace cannot be shared", materialdoc.ErrInvalid)
	}
	// The workspace's row comes first, as for every write there: a role change
	// (SetWorkspaceMemberRole) takes it too, so the role read below is the one
	// the share lands under. It locks the creator's account with it.
	if _, err := s.lockWorkspaceMutationTx(ctx, tx, *workspaceID, userID); err != nil {
		return Canvas{}, err
	}
	if shared {
		role, _, err := workspaceRoles(ctx, tx, userID, *workspaceID)
		if err != nil {
			return Canvas{}, err
		}
		if !canShareCanvas(role) {
			return Canvas{}, ErrForbidden
		}
	}
	// A frozen account edits nothing, its sharing included; the creator is the
	// payer, so one check covers both.
	if err := s.assertEditableTx(ctx, tx, creatorID); err != nil {
		return Canvas{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE materials SET canvas_shared=$2
		WHERE id=$1 AND trashed_at IS NULL AND canvas_shared<>$2`, materialID, shared); err != nil {
		return Canvas{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Canvas{}, err
	}
	return s.GetCanvas(ctx, userID, materialID)
}

// CanvasImageAssets are the canvas's ready image assets, one the pruner trashed
// included (a board that names it again restores it): the images the board can
// still show, so the browser tells one deleted for good (Files › Embeds) from
// one it has yet to load.
func (s *Store) CanvasImageAssets(ctx context.Context, materialID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM editor_assets
		WHERE material_id=$1 AND purpose='image' AND status='ready' ORDER BY created_at, id`, materialID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// dropLeaverCanvasTx deletes the member's canvases in the workspace they leave
// (or are removed from), its assets with it (Epo 2026-11-09: it goes with the
// membership, as their marked drawings do). PROVISIONAL for a shared canvas,
// open question 2 of the canvas collaboration contract (Epo to answer): one
// the leaver shared goes too, with what the other members drew on it.
func dropLeaverCanvasTx(ctx context.Context, tx pgx.Tx, wsID, userID string) error {
	if _, err := tx.Exec(ctx, `DELETE FROM materials
		WHERE kind='canvas' AND canvas_workspace_id=$1 AND owner_user_id=$2`, wsID, userID); err != nil {
		return fmt.Errorf("drop the leaver's canvases: %w", err)
	}
	return nil
}
