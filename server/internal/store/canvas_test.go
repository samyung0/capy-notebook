package store

import (
	"context"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// readyAsset is one ready editor asset of the material, for a canvas save to name.
func readyAsset(t *testing.T, s *Store, materialID, userID, purpose string) string {
	t.Helper()
	id := uid("asset")
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO editor_assets
		(id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,$3,$3,'canvas.ydoc.gz',$4,$5,'application/gzip',10,'ready',now())`,
		id, materialID, userID, purpose, "editor-assets/canvas/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	return id
}

// A member's canvas is their own: made on first open as a standalone material
// linked to the workspace, one per member, saved with a revision check and only
// its own ready assets, never shared or copied, and gone when they leave
// (Epo 2026-11-09).
func TestWorkspaceCanvasIsPersonalAndGoesWithTheMembership(t *testing.T) {
	f := newStudyFixture(t, "canvas")
	ctx := context.Background()
	member := newBlobTestUser(t, f.s, "canvas-member")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'viewer')`, f.ws.ID, member); err != nil {
		t.Fatal(err)
	}

	mine, err := f.s.WorkspaceCanvas(ctx, f.user, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if mine.Kind != MaterialCanvas || mine.CanvasWorkspaceID != f.ws.ID || mine.WorkspaceID != "" ||
		mine.OwnerUserID != f.user || mine.Title != f.ws.Name || mine.Privacy != "private" {
		t.Fatalf("the canvas = %+v", mine)
	}
	again, err := f.s.WorkspaceCanvas(ctx, f.user, f.ws.ID)
	if err != nil || again.ID != mine.ID {
		t.Fatalf("a second open made another canvas: %v %v", again.ID, err)
	}
	theirs, err := f.s.WorkspaceCanvas(ctx, member, f.ws.ID)
	if err != nil || theirs.ID == mine.ID {
		t.Fatalf("the member's canvas = %v, err %v", theirs.ID, err)
	}
	board, err := materialdoc.ReadCanvasBoard(mine.Content)
	if err != nil || board.BoardAssetID != "" || board.Version != 0 || len(board.ImageAssetIDs) != 0 {
		t.Fatalf("a fresh canvas's block = %+v, err %v", board, err)
	}

	// A save records the board asset and the images, both this canvas's own
	// ready assets, and counts the version; it lands at the revision the browser
	// read, and a stale revision is refused.
	boardAsset := readyAsset(t, f.s, mine.ID, f.user, "board")
	image := readyAsset(t, f.s, mine.ID, f.user, "image")
	saved, err := f.s.SaveWorkspaceCanvas(ctx, f.user, mine.ID, boardAsset, []string{image}, mine.Revision)
	if err != nil {
		t.Fatal(err)
	}
	board, err = materialdoc.ReadCanvasBoard(saved.Content)
	if err != nil || board.BoardAssetID != boardAsset || board.Version != 1 || len(board.ImageAssetIDs) != 1 {
		t.Fatalf("the saved block = %+v, err %v", board, err)
	}
	// The pruner keeps what the block names: both assets stay ready.
	var trashed int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE material_id=$1 AND trashed_at IS NOT NULL`, mine.ID).Scan(&trashed); err != nil {
		t.Fatal(err)
	}
	if trashed != 0 {
		t.Fatalf("%d of the canvas's named assets were trashed", trashed)
	}
	next := readyAsset(t, f.s, mine.ID, f.user, "board")
	if _, err := f.s.SaveWorkspaceCanvas(ctx, f.user, mine.ID, next, []string{}, mine.Revision); !errors.Is(err, ErrConflict) {
		t.Fatalf("a stale save was taken: %v", err)
	}
	if _, err := f.s.SaveWorkspaceCanvas(ctx, member, mine.ID, next, []string{}, saved.Revision); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another member saved my canvas: %v", err)
	}
	// Another material's asset, or an image where the board goes, is refused.
	foreign := readyAsset(t, f.s, theirs.ID, member, "board")
	if _, err := f.s.SaveWorkspaceCanvas(ctx, f.user, mine.ID, foreign, []string{}, saved.Revision); !errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("another canvas's asset was taken: %v", err)
	}
	if _, err := f.s.SaveWorkspaceCanvas(ctx, f.user, mine.ID, image, []string{}, saved.Revision); !errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("an image was taken as the board: %v", err)
	}
	// An image the pruner trashed is named again (its delete undone on the
	// canvas): the save takes it and its prune restores it.
	if _, err := f.s.pool.Exec(ctx, `UPDATE editor_assets SET trashed_at=now() WHERE id=$1`, image); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SaveWorkspaceCanvas(ctx, f.user, mine.ID, next, []string{image}, saved.Revision); err != nil {
		t.Fatalf("a save naming a trashed image again: %v", err)
	}
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM editor_assets WHERE id=$1 AND trashed_at IS NOT NULL`, image).Scan(&trashed); err != nil {
		t.Fatal(err)
	}
	if trashed != 0 {
		t.Fatal("the image named again stayed trashed")
	}
	// The ids a save may name: the canvas's image assets, a trashed one too,
	// and never its board.
	if _, err := f.s.pool.Exec(ctx, `UPDATE editor_assets SET trashed_at=now() WHERE id=$1`, image); err != nil {
		t.Fatal(err)
	}
	if own, err := f.s.CanvasImageAssets(ctx, mine.ID); err != nil || len(own) != 1 || own[0] != image {
		t.Fatalf("the canvas's image assets = %v, err %v", own, err)
	}

	// Never shared, never copied.
	if _, err := f.s.UpdateStandaloneMaterialPrivacy(ctx, f.user, mine.ID, "", "link"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a canvas was shared: %v", err)
	}
	if _, err := f.s.CloneMaterial(ctx, member, mine.ID, CloneTarget{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a canvas was cloned: %v", err)
	}

	// Leaving takes the member's canvas; the owner's stays.
	if _, _, err := f.s.RemoveWorkspaceMemberWithResult(ctx, member, f.ws.ID, member); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetMaterial(ctx, theirs.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the leaver's canvas stayed: %v", err)
	}
	if _, err := f.s.GetMaterial(ctx, mine.ID); err != nil {
		t.Fatalf("the owner's canvas went: %v", err)
	}
}

// The account's Canvas page (Epo 2026-11-10): a person makes canvases of their
// own in no workspace, as many as they like, saved as a workspace canvas is,
// and lists them with their workspaces' canvases, each of those under its
// workspace. Nobody else opens one.
func TestCanvasesOfOnesOwnListWithTheWorkspaces(t *testing.T) {
	f := newStudyFixture(t, "own-canvases")
	ctx := context.Background()
	other := newBlobTestUser(t, f.s, "own-canvases-other")
	inWorkspace, err := f.s.WorkspaceCanvas(ctx, f.user, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	first, err := f.s.CreateCanvas(ctx, f.user, "Exam plan")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.CreateCanvas(ctx, f.user, "Scratch")
	if err != nil {
		t.Fatal(err)
	}
	if first.CanvasWorkspaceID != "" || first.WorkspaceID != "" || first.OwnerUserID != f.user || first.Kind != MaterialCanvas {
		t.Fatalf("a canvas of one's own = %+v", first)
	}
	board := readyAsset(t, f.s, first.ID, f.user, "board")
	if _, err := f.s.SaveWorkspaceCanvas(ctx, f.user, first.ID, board, []string{}, first.Revision); err != nil {
		t.Fatalf("saving a canvas of one's own: %v", err)
	}
	if _, err := f.s.OwnCanvas(ctx, other, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("someone else opened it: %v", err)
	}

	list, err := f.s.ListCanvases(ctx, f.user)
	if err != nil || len(list) != 3 {
		t.Fatalf("the canvases = %+v, err %v", list, err)
	}
	byID := map[string]CanvasListItem{}
	for _, item := range list {
		byID[item.ID] = item
	}
	if row := byID[inWorkspace.ID]; row.WorkspaceID != f.ws.ID || row.WorkspaceName != f.ws.Name || row.WorkspaceIconID == "" {
		t.Fatalf("the workspace's canvas row = %+v", row)
	}
	if row := byID[first.ID]; row.WorkspaceID != "" || row.Title != "Exam plan" {
		t.Fatalf("the row of a canvas of one's own = %+v", row)
	}
	if _, listed := byID[second.ID]; !listed {
		t.Fatal("the second canvas of one's own is not listed")
	}
	// A workspace's canvas opens through its workspace, not by id.
	if _, err := f.s.OwnCanvas(ctx, f.user, inWorkspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a workspace's canvas opened by id: %v", err)
	}
}
