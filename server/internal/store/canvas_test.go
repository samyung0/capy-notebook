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
