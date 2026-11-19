package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/migrations"
)

// readyAsset is one ready editor asset of the material, completed just now.
func readyAsset(t *testing.T, s *Store, materialID, userID, purpose string) string {
	t.Helper()
	id := uid("asset")
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO editor_assets
		(id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,$3,$3,'asset',$4,$5,'application/octet-stream',10,'ready',now())`,
		id, materialID, userID, purpose, "editor-assets/canvas/"+uid("blob")); err != nil {
		t.Fatal(err)
	}
	return id
}

// canvasFixture is a workspace with its owner (f.user), an editor, a viewer
// and someone outside it, with collaboration configured as every deployment
// has it: nothing Go does to a canvas commands the collaboration server, so a
// request to it fails the test (found on UAT 2026-11-10, when every canvas
// save was refused only where it was configured).
type canvasFixture struct {
	studyFixture
	editor, viewer, outsider string
}

func newCanvasFixture(t *testing.T, label string) canvasFixture {
	t.Helper()
	f := canvasFixture{studyFixture: newStudyFixture(t, label)}
	f.editor = newBlobTestUser(t, f.s, label+"-editor")
	f.viewer = newBlobTestUser(t, f.s, label+"-viewer")
	f.outsider = newBlobTestUser(t, f.s, label+"-outsider")
	if _, err := f.s.pool.Exec(context.Background(), `INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES ($1,$2,'editor'), ($1,$3,'viewer')`, f.ws.ID, f.editor, f.viewer); err != nil {
		t.Fatal(err)
	}
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the collaboration server was asked %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(sidecar.Close)
	f.s.ConfigureCollaboration(sidecar.URL, "command-secret")
	t.Cleanup(func() { f.s.ConfigureCollaboration("", "") })
	return f
}

// canvas makes a canvas of the user's in the fixture's workspace, shared with
// it or not.
func (f canvasFixture) canvas(t *testing.T, userID string, shared bool) Material {
	t.Helper()
	ctx := context.Background()
	mt, err := f.s.CreateCanvas(ctx, userID, uid("Canvas "), f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if shared {
		if _, err := f.s.SetCanvasShared(ctx, userID, mt.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	return mt
}

// storeBoard is the canvas's Yjs row as the collaboration server leaves it
// after a store: the folded state and the update log's bytes at a version. Go
// never writes this row.
func storeBoard(t *testing.T, s *Store, materialID string, stateBytes, logBytes int, version int64) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(), `INSERT INTO material_yjs_documents
		(material_id, state, log_bytes, stored_version) VALUES ($1,$2,$3,$4)
		ON CONFLICT (material_id) DO UPDATE SET state=EXCLUDED.state, log_bytes=EXCLUDED.log_bytes,
			stored_version=EXCLUDED.stored_version`,
		materialID, make([]byte, stateBytes), logBytes, version); err != nil {
		t.Fatal(err)
	}
}

// boardProjection is what a canvas room sends Go for its stored version: the
// canvas_board block itself, naming the images on the board.
func boardProjection(t *testing.T, version int64, images ...string) materialdoc.Projection {
	t.Helper()
	named := make([]map[string]any, len(images))
	for i, id := range images {
		named[i] = map[string]any{"assetId": id}
	}
	raw, err := json.Marshal(map[string]any{"schemaVersion": 1, "value": []any{map[string]any{
		"type": "canvas_board", "id": "board", "children": []any{map[string]any{"text": ""}},
		"version": version, "images": named,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return testProjection(t, string(raw))
}

// A canvas is private to its creator until they share it with the workspace
// it was drawn in; the members then hold it by their workspace role, and
// someone outside the workspace holds nothing either way. A canvas in no
// workspace is its creator's alone. Both readers of the rule agree.
func TestACanvasFollowsItsWorkspacesRolesOnceShared(t *testing.T) {
	f := newCanvasFixture(t, "canvas-roles")
	ctx := context.Background()
	private := f.canvas(t, f.user, false)
	shared := f.canvas(t, f.user, true)
	own, err := f.s.CreateCanvas(ctx, f.user, "Own", "")
	if err != nil {
		t.Fatal(err)
	}
	if private.Kind != MaterialCanvas || private.CanvasWorkspaceID != f.ws.ID || private.WorkspaceID != "" ||
		private.OwnerUserID != f.user || private.Privacy != "private" {
		t.Fatalf("a workspace canvas = %+v", private)
	}
	creatorOnly := map[string]WorkspaceRole{f.user: RoleOwner, f.editor: "", f.viewer: "", f.outsider: ""}
	for _, c := range []struct {
		name     string
		material string
		want     map[string]WorkspaceRole
	}{
		{"private", private.ID, creatorOnly},
		{"shared", shared.ID, map[string]WorkspaceRole{f.user: RoleOwner, f.editor: RoleEditor, f.viewer: RoleViewer, f.outsider: ""}},
		{"in no workspace", own.ID, creatorOnly},
	} {
		for user, want := range c.want {
			role, err := f.s.MaterialEffectiveRole(ctx, user, c.material)
			if role != want || (want == "") != errors.Is(err, ErrNotFound) {
				t.Errorf("%s canvas, %s: role %q (%v), want %q", c.name, user, role, err, want)
			}
			readable, err := f.s.ReadableMaterialIDs(ctx, user, []string{c.material})
			if err != nil || (len(readable) == 1) != (want != "") {
				t.Errorf("%s canvas, %s: readable %v (%v), want role %q", c.name, user, readable, err, want)
			}
		}
	}
}

// PROVISIONAL (contract open question 3): a canvas's creator alone shares,
// unshares, renames and deletes it, and shares only while a workspace owner or
// editor; a canvas in no workspace is never shared.
func TestACanvasIsAdministeredByItsCreator(t *testing.T) {
	f := newCanvasFixture(t, "canvas-admin")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, false)

	shared, err := f.s.SetCanvasShared(ctx, f.editor, canvas.ID, true)
	if err != nil || !shared.Shared || shared.ID != canvas.ID {
		t.Fatalf("the creator sharing: %+v, %v", shared.Shared, err)
	}
	if got, err := f.s.GetCanvas(ctx, f.viewer, canvas.ID); err != nil || !got.Shared {
		t.Fatalf("a member reading the shared canvas: %+v, %v", got.Shared, err)
	}
	// The workspace's owner holds it as an owner and still administers nothing.
	if _, err := f.s.SetCanvasShared(ctx, f.user, canvas.ID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("the workspace owner unsharing: %v", err)
	}
	title := "Renamed"
	if _, err := f.s.UpdateMaterial(ctx, canvas.ID, MaterialPatch{Title: &title, UpdatedBy: f.user}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("the workspace owner renaming: %v", err)
	}
	if _, err := f.s.TrashMaterial(ctx, f.user, canvas.ID, "", AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the workspace owner deleting: %v", err)
	}
	if renamed, err := f.s.UpdateMaterial(ctx, canvas.ID, MaterialPatch{Title: &title, UpdatedBy: f.editor}); err != nil || renamed.Title != title {
		t.Fatalf("the creator renaming: %q, %v", renamed.Title, err)
	}
	if unshared, err := f.s.SetCanvasShared(ctx, f.editor, canvas.ID, false); err != nil || unshared.Shared {
		t.Fatalf("the creator unsharing: %+v, %v", unshared.Shared, err)
	}
	if _, err := f.s.GetCanvas(ctx, f.viewer, canvas.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a member reading the unshared canvas: %v", err)
	}
	if _, err := f.s.TrashMaterial(ctx, f.editor, canvas.ID, "", AgentOperation{}); err != nil {
		t.Fatalf("the creator deleting: %v", err)
	}

	// A viewer shares none of theirs, and a canvas in no workspace has nobody
	// to share with.
	viewers := f.canvas(t, f.viewer, false)
	if _, err := f.s.SetCanvasShared(ctx, f.viewer, viewers.ID, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a viewer sharing: %v", err)
	}
	own, err := f.s.CreateCanvas(ctx, f.editor, "Own", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SetCanvasShared(ctx, f.editor, own.ID, true); !errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("sharing a canvas in no workspace: %v", err)
	}
}

// A workspace's Canvas tab lists the caller's canvases there and the other
// members' shared ones, each saying whether it is shared and the caller's own,
// another member's naming who made it. The account's Canvas page lists the
// caller's own alone.
func TestAWorkspacesCanvasesListTheCallersAndTheSharedOnes(t *testing.T) {
	f := newCanvasFixture(t, "canvas-list")
	ctx := context.Background()
	mine := f.canvas(t, f.viewer, false)
	theirs := f.canvas(t, f.editor, true)
	f.canvas(t, f.editor, false)

	page, err := f.s.ListCanvases(ctx, f.viewer, f.ws.ID, 50, "")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]CanvasListItem{}
	for _, item := range page.Items {
		got[item.ID] = item
	}
	if len(got) != 2 || !got[mine.ID].Own || got[mine.ID].Shared || got[mine.ID].CreatorName != "" ||
		got[theirs.ID].Own || !got[theirs.ID].Shared || got[theirs.ID].CreatorName != "Blob Test" ||
		got[theirs.ID].WorkspaceID != f.ws.ID || got[theirs.ID].WorkspaceName != f.ws.Name {
		t.Fatalf("the viewer's workspace canvases = %+v", page.Items)
	}
	all, err := f.s.ListCanvases(ctx, f.viewer, "", 50, "")
	if err != nil || len(all.Items) != 1 || all.Items[0].ID != mine.ID || !all.Items[0].Own {
		t.Fatalf("the viewer's own canvases = %+v, %v", all.Items, err)
	}
}

// The Canvas tab lists what opens: a shared canvas leaves the other members'
// list while its creator's account is suspended, as it stops opening for them,
// and comes back with the account.
func TestAWorkspacesCanvasesFollowTheirCreatorsAccount(t *testing.T) {
	f := newCanvasFixture(t, "canvas-list-creator")
	ctx := context.Background()
	theirs := f.canvas(t, f.editor, true)
	listed := func() int {
		t.Helper()
		page, err := f.s.ListCanvases(ctx, f.viewer, f.ws.ID, 50, "")
		if err != nil {
			t.Fatal(err)
		}
		return len(page.Items)
	}
	for _, step := range []struct {
		sql    string
		listed int
		opens  error
	}{
		{`UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, 0, ErrNotFound},
		{`UPDATE users SET suspended_at=NULL, suspended_reason=NULL WHERE id=$1`, 1, nil},
	} {
		if _, err := f.s.pool.Exec(ctx, step.sql, f.editor); err != nil {
			t.Fatal(err)
		}
		_, err := f.s.GetCanvas(ctx, f.viewer, theirs.ID)
		if got := listed(); got != step.listed || !errors.Is(err, step.opens) {
			t.Fatalf("after %q the viewer lists %d and opens it with %v, want %d and %v", step.sql, got, err, step.listed, step.opens)
		}
	}
}

// Sharing takes the workspace's row as a role change there does, so a share
// lands under the role its creator holds then: one racing a demotion waits for
// it and is refused.
func TestSharingACanvasWaitsForARoleChange(t *testing.T) {
	f := newCanvasFixture(t, "canvas-share-lock")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, false)
	// A demotion in flight, holding the row lockWorkspaceMutationTx takes.
	demotion, err := f.s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer demotion.Rollback(ctx)
	if _, err := demotion.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := demotion.Exec(ctx, `UPDATE workspace_members SET role='viewer'
		WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.editor); err != nil {
		t.Fatal(err)
	}
	shared := make(chan error, 1)
	go func() {
		_, err := f.s.SetCanvasShared(ctx, f.editor, canvas.ID, true)
		shared <- err
	}()
	select {
	case err := <-shared:
		t.Fatalf("the share did not wait for the role change: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if err := demotion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-shared; !errors.Is(err, ErrForbidden) {
		t.Fatalf("the share after the demotion: %v", err)
	}
	if got, err := f.s.GetCanvas(ctx, f.editor, canvas.ID); err != nil || got.Shared {
		t.Fatalf("the canvas after the refused share: shared %v, %v", got.Shared, err)
	}
}

// An editor keeps paying for the images it put on a shared canvas. Once it can
// no longer open the canvas (taken back, or the editor removed from the
// workspace) its Files page lists each as an image in a note it lost: marked
// lost with nothing to open, also after the canvas is trashed.
func TestAnEditorsImagesOnACanvasItLostAreMarkedLost(t *testing.T) {
	f := newCanvasFixture(t, "canvas-lost-images")
	ctx := context.Background()
	canvas := f.canvas(t, f.user, true)
	image := readyAsset(t, f.s, canvas.ID, f.editor, "image")
	// The Files page's one list, which reads each embed through ListEditorAssets.
	listed := func(want ...string) map[string]EditorAssetItem {
		t.Helper()
		page, err := f.s.ListItems(ctx, f.editor, ItemListFilter{})
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]EditorAssetItem{}
		for _, item := range page.Items {
			if item.Embed != nil {
				got[item.Embed.ID] = *item.Embed
			}
		}
		if len(got) != len(want) {
			t.Fatalf("listed %+v, want %v", got, want)
		}
		return got
	}
	open := EditorAssetItem{MaterialID: canvas.ID, WorkspaceID: f.ws.ID}
	lost := EditorAssetItem{LostAccess: true}
	expect := func(item EditorAssetItem, want EditorAssetItem, title string) {
		t.Helper()
		if item.LostAccess != want.LostAccess || item.MaterialID != want.MaterialID || item.WorkspaceID != want.WorkspaceID ||
			item.MaterialTitle != title || item.WorkspaceName != f.ws.Name {
			t.Fatalf("item %+v, want lostAccess %v opening %q under %q in %q", item, want.LostAccess, want.MaterialID, title, f.ws.Name)
		}
	}
	expect(listed(image)[image], open, canvas.Title)

	if _, err := f.s.SetCanvasShared(ctx, f.user, canvas.ID, false); err != nil {
		t.Fatal(err)
	}
	expect(listed(image)[image], lost, canvas.Title)
	onlyLost, err := f.s.ListEditorAssets(ctx, f.editor, EditorAssetFilter{Access: EditorAssetsLost})
	if err != nil || len(onlyLost.Items) != 1 || onlyLost.Items[0].ID != image {
		t.Fatalf("the editor's lost media = %+v, %v", onlyLost.Items, err)
	}
	if _, err := f.s.TrashMaterial(ctx, f.user, canvas.ID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	expect(listed(image)[image], lost, canvas.Title)

	// Removed from the workspace, the editor loses a canvas still shared with it.
	second := f.canvas(t, f.user, true)
	other := readyAsset(t, f.s, second.ID, f.editor, "image")
	if err := f.s.RemoveWorkspaceMember(ctx, f.user, f.ws.ID, f.editor); err != nil {
		t.Fatal(err)
	}
	expect(listed(image, other)[other], lost, second.Title)
}

// The account's Canvas page (Epo 2026-11-10): a person makes canvases of their
// own in no workspace and lists them, a page at a time, before the ones they
// drew in their workspaces, each of those under its workspace.
func TestCanvasesOfOnesOwnListWithTheWorkspaces(t *testing.T) {
	f := newCanvasFixture(t, "own-canvases")
	ctx := context.Background()
	inWorkspace := f.canvas(t, f.user, false)
	first, err := f.s.CreateCanvas(ctx, f.user, "Exam plan", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.s.CreateCanvas(ctx, f.user, "Scratch", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET updated_at=now() + interval '1 minute' WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	var list []CanvasListItem
	cursor := ""
	for {
		page, err := f.s.ListCanvases(ctx, f.user, "", 2, cursor)
		if err != nil || len(page.Items) > 2 {
			t.Fatalf("a page of canvases = %+v, err %v", page, err)
		}
		list = append(list, page.Items...)
		if cursor = page.NextCursor; cursor == "" {
			break
		}
	}
	if len(list) != 3 || list[0].ID != first.ID || list[1].ID != second.ID || list[2].ID != inWorkspace.ID {
		t.Fatalf("the canvases = %+v", list)
	}
	if row := list[2]; row.WorkspaceID != f.ws.ID || row.WorkspaceName != f.ws.Name || row.WorkspaceIconID == "" {
		t.Fatalf("the workspace's canvas row = %+v", row)
	}
	if row := list[0]; row.WorkspaceID != "" || row.Title != "Exam plan" {
		t.Fatalf("the row of a canvas of one's own = %+v", row)
	}
}

// A new canvas is the empty block and no Yjs row: the collaboration server
// seeds the board's first state when the canvas is first opened. Its document
// is never written by a content patch.
func TestANewCanvasHasNoYjsRowAndTakesNoContentPatch(t *testing.T) {
	f := newCanvasFixture(t, "canvas-create")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, false)
	board, err := materialdoc.ReadCanvasBoard(canvas.Content)
	if err != nil || board.Version != 0 || len(board.ImageAssetIDs) != 0 {
		t.Fatalf("a new canvas's block = %+v, %v", board, err)
	}
	doc, err := materialdoc.Parse(canvas.Content)
	if err != nil || doc.Value[0]["id"] != materialdoc.CanvasBoardID {
		t.Fatalf("a new canvas's block id = %v, %v", doc.Value[0]["id"], err)
	}
	var rows int
	if err := f.s.pool.QueryRow(ctx, `SELECT count(*) FROM material_yjs_documents WHERE material_id=$1`, canvas.ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("a new canvas has %d Yjs rows (%v)", rows, err)
	}

	patch, err := materialdoc.CanvasDocument(materialdoc.CanvasBoard{Version: 5, ImageAssetIDs: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.UpdateMaterial(ctx, canvas.ID, MaterialPatch{Content: &patch, UpdatedBy: f.editor}); !errors.Is(err, materialdoc.ErrInvalid) {
		t.Fatalf("a content patch for a canvas: %v", err)
	}
	if kept, err := f.s.GetMaterial(ctx, canvas.ID); err != nil || kept.Content != canvas.Content || kept.Revision != canvas.Revision {
		t.Fatalf("the refused patch changed the canvas: %v", err)
	}
}

// A canvas room's projection writes the block it sends. An image the board no
// longer names is trashed once it is 60 seconds old, one named again comes
// back, and an id that is not this canvas's asset stays in the block.
func TestACanvasProjectionWritesItsBlockAndPrunesItsImages(t *testing.T) {
	f := newCanvasFixture(t, "canvas-projection")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, true)
	kept := readyAsset(t, f.s, canvas.ID, f.editor, "image")
	removed := readyAsset(t, f.s, canvas.ID, f.viewer, "image")
	fresh := readyAsset(t, f.s, canvas.ID, f.editor, "image")
	if _, err := f.s.pool.Exec(ctx, `UPDATE editor_assets SET completed_at=now() - interval '2 minutes'
		WHERE id = ANY($1::text[])`, []string{kept, removed}); err != nil {
		t.Fatal(err)
	}
	trashed := func() []string {
		t.Helper()
		rows, err := f.s.pool.Query(ctx, `SELECT id FROM editor_assets
			WHERE material_id=$1 AND trashed_at IS NOT NULL ORDER BY id`, canvas.ID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		ids := []string{}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		return ids
	}

	storeBoard(t, f.s, canvas.ID, 300, 0, 2)
	projected, err := f.s.ProjectMaterialContent(ctx, canvas.ID, boardProjection(t, 2, kept, "asset_elsewhere"), 2, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := f.s.GetMaterial(ctx, canvas.ID)
	if err != nil {
		t.Fatal(err)
	}
	board, err := materialdoc.ReadCanvasBoard(stored.Content)
	if err != nil || board.Version != 2 || !slices.Equal(board.ImageAssetIDs, []string{kept, "asset_elsewhere"}) {
		t.Fatalf("the projected block = %+v, %v", board, err)
	}
	if projected.Revision != canvas.Revision+1 || stored.Revision != projected.Revision || !stored.UpdatedAt.After(canvas.UpdatedAt) {
		t.Fatalf("the projection left revision %d (was %d), updated %v", stored.Revision, canvas.Revision, stored.UpdatedAt)
	}
	if got := trashed(); !slices.Equal(got, []string{removed}) {
		t.Fatalf("trashed %v, want only the old image the board dropped (%s); the fresh one is %s", got, removed, fresh)
	}

	storeBoard(t, f.s, canvas.ID, 300, 0, 3)
	if _, err := f.s.ProjectMaterialContent(ctx, canvas.ID, boardProjection(t, 3, kept, removed, fresh), 3, nil); err != nil {
		t.Fatal(err)
	}
	if got := trashed(); len(got) != 0 {
		t.Fatalf("an image named again stayed trashed: %v", got)
	}
}

// A canvas is charged its content JSON plus the Yjs bytes its room has stored,
// as of its last projection, to its creator: the storage counter follows it
// and Billing shows it under Canvas.
func TestACanvasIsChargedItsStoredBoard(t *testing.T) {
	f := newCanvasFixture(t, "canvas-charge")
	ctx := context.Background()
	usage := func() int64 {
		t.Helper()
		u, err := f.s.StorageUsage(ctx, f.editor)
		if err != nil {
			t.Fatal(err)
		}
		return u.UsedBytes
	}
	sizes := func(id string) (charged, content int64) {
		t.Helper()
		if err := f.s.pool.QueryRow(ctx, `SELECT size_bytes, octet_length(content::text) FROM materials WHERE id=$1`, id).
			Scan(&charged, &content); err != nil {
			t.Fatal(err)
		}
		return charged, content
	}
	before := usage()
	canvas := f.canvas(t, f.editor, true)
	charged, content := sizes(canvas.ID)
	if charged != content || usage() != before+content {
		t.Fatalf("a new canvas is charged %d for %d bytes of content; usage grew %d", charged, content, usage()-before)
	}

	// The room stored 4,000 bytes of state and 1,500 of updates, then
	// projected; a later store folded it down to 2,000 and projected again.
	for _, store := range []struct {
		state, log int
		version    int64
	}{{4000, 1500, 2}, {2000, 0, 3}} {
		storeBoard(t, f.s, canvas.ID, store.state, store.log, store.version)
		projected, err := f.s.ProjectMaterialContent(ctx, canvas.ID, boardProjection(t, store.version), store.version, nil)
		if err != nil {
			t.Fatal(err)
		}
		charged, content = sizes(canvas.ID)
		want := content + int64(store.state+store.log)
		if charged != want || projected.SizeBytes != want || usage() != before+want {
			t.Fatalf("version %d: charged %d (projection says %d), want %d; usage grew %d",
				store.version, charged, projected.SizeBytes, want, usage()-before)
		}
	}

	b, err := f.s.storageBreakdown(ctx, f.editor)
	if err != nil {
		t.Fatal(err)
	}
	var used, reserved int64
	if err := f.s.pool.QueryRow(ctx, storageRecountSQL, f.editor).Scan(&used, &reserved); err != nil {
		t.Fatal(err)
	}
	if b.CanvasBytes != charged || b.FilesBytes+b.ImagesBytes+b.CanvasBytes != used {
		t.Fatalf("breakdown %+v, want the canvas's %d under Canvas, adding up to %d", b, charged, used)
	}
}

// Unsharing a canvas queues a revoke of its room, so the other members'
// channels are rechecked and its creator stays joined; sharing queues nothing.
// A member removed from the workspace, or lowered in it, has their channels on
// its canvases rechecked the same way.
func TestCanvasAccessChangesQueueARevokeOnlyWhenTheyNarrow(t *testing.T) {
	f := newCanvasFixture(t, "canvas-evictions")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, false)
	share := func(shared bool) func() error {
		return func() error {
			_, err := f.s.SetCanvasShared(ctx, f.editor, canvas.ID, shared)
			return err
		}
	}
	exec := func(sql string, args ...any) func() error {
		return func() error {
			_, err := f.s.pool.Exec(ctx, sql, args...)
			return err
		}
	}
	revoke := []string{"evict revoke"}
	for _, step := range []struct {
		name   string
		change func() error
		want   []string
	}{
		{"shared", share(true), nil},
		{"shared again", share(true), nil},
		{"a member lowered", exec(`UPDATE workspace_members SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.editor), revoke},
		{"a member removed", exec(`DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.viewer), revoke},
		{"unshared", share(false), revoke},
	} {
		if got := queuedEvictions(t, f.s, step.change); !slices.Equal(got, step.want) {
			t.Fatalf("%s queued %v, want %v", step.name, got, step.want)
		}
	}
	var room string
	if err := f.s.pool.QueryRow(ctx, `SELECT payload->>'room' FROM collaboration_eviction_outbox`).Scan(&room); err != nil ||
		room != "material:"+canvas.ID+":schema:1" {
		t.Fatalf("the revoke names room %q (%v)", room, err)
	}
}

// PROVISIONAL (contract open question 2): leaving a workspace takes every
// canvas the leaver drew there, shared or not, as their marked drawings go
// (Epo 2026-11-09); the other members' stay.
func TestALeaversCanvasesGoWithTheMembership(t *testing.T) {
	f := newCanvasFixture(t, "canvas-leaver")
	ctx := context.Background()
	theirs := f.canvas(t, f.editor, true)
	stays := f.canvas(t, f.user, true)
	if _, _, err := f.s.RemoveWorkspaceMemberWithResult(ctx, f.editor, f.ws.ID, f.editor); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.GetMaterial(ctx, theirs.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the leaver's canvas stayed: %v", err)
	}
	if _, err := f.s.MaterialEffectiveRole(ctx, f.editor, stays.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the leaver still holds the owner's shared canvas: %v", err)
	}
	if _, err := f.s.GetMaterial(ctx, stays.ID); err != nil {
		t.Fatalf("the owner's canvas went: %v", err)
	}
}

// A canvas takes no link or public sharing and is never copied.
func TestACanvasIsNeverLinkedOrCopied(t *testing.T) {
	f := newCanvasFixture(t, "canvas-closed")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, true)
	if _, err := f.s.UpdateStandaloneMaterialPrivacy(ctx, f.editor, canvas.ID, "", "link"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a canvas took a link: %v", err)
	}
	if _, err := f.s.CloneMaterial(ctx, f.user, canvas.ID, CloneTarget{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a canvas was cloned: %v", err)
	}
}

// Migrations 0181 to 0183 over a database at 0180: every canvas of the old
// kind goes with its board asset, its charge released, and a board asset is
// capped as a drawn sample answer's again; then the sharing flag and the
// board's charge apply. The run rolls back.
func TestCanvasRoomMigrationsApplyOverOldCanvases(t *testing.T) {
	f := newCanvasFixture(t, "canvas-migrate")
	ctx := context.Background()
	canvas := f.canvas(t, f.editor, false)
	note, err := f.s.CreateMaterial(ctx, Material{CreatedBy: f.editor, Kind: "note", Title: "Stays", Content: materialTestContent(t, "kept")})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	// Back to 0180: no flag, the board cap 0164 set, and a saved canvas with a
	// board asset over a sample answer's cap.
	exec(`DROP TRIGGER materials_canvas_unshared_eviction ON materials`)
	exec(`DROP FUNCTION canvas_unshared_eviction_trigger()`)
	exec(`DROP INDEX materials_canvas_workspace_idx`)
	exec(`ALTER TABLE materials DROP CONSTRAINT materials_canvas_shared_check`)
	exec(`ALTER TABLE materials DROP COLUMN canvas_shared`)
	exec(`ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_size_check`)
	exec(`ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_size_check CHECK (purpose<>'board' OR size_bytes <= 2097152)`)
	const board = `INSERT INTO editor_assets
		(id, material_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes, status, completed_at)
		VALUES ($1,$2,$3,$3,'canvas.ydoc.gz','board',$4,'application/gzip',300000,'ready',now())`
	exec(board, uid("asset"), canvas.ID, f.editor, "editor-assets/canvas/"+uid("blob"))
	charged := func() int64 {
		t.Helper()
		var used, reserved int64
		if err := tx.QueryRow(ctx, storageRecountSQL, f.editor).Scan(&used, &reserved); err != nil {
			t.Fatal(err)
		}
		return used
	}
	before := charged()

	for _, name := range []string{"0181_canvas_rooms_clear.sql", "0182_canvas_shared.sql", "0183_canvas_board_bytes.sql"} {
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		exec(string(body))
	}
	var canvases, assets, notes int
	if err := tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM materials WHERE kind='canvas'),
		(SELECT count(*) FROM editor_assets WHERE material_id=$1), (SELECT count(*) FROM materials WHERE id=$2)`,
		canvas.ID, note.ID).Scan(&canvases, &assets, &notes); err != nil {
		t.Fatal(err)
	}
	if canvases != 0 || assets != 0 || notes != 1 {
		t.Fatalf("after the clear: %d canvases, %d of the canvas's assets, %d of the note", canvases, assets, notes)
	}
	if released := before - charged(); released < 300000 {
		t.Fatalf("the clear released %d bytes of the creator's storage, want the board's 300000 and the canvas's", released)
	}
	var shared bool
	if err := tx.QueryRow(ctx, `SELECT canvas_shared FROM materials WHERE id=$1`, note.ID).Scan(&shared); err != nil || shared {
		t.Fatalf("the flag after 0182 = %v, %v", shared, err)
	}
	// A sample answer's board asset is capped at 250 KiB again.
	_, err = tx.Exec(ctx, board, uid("asset"), note.ID, f.editor, "editor-assets/canvas/"+uid("blob"))
	if err == nil || !strings.Contains(err.Error(), "editor_assets_size_check") {
		t.Fatalf("a 300000 byte board asset after 0181: %v", err)
	}
}
