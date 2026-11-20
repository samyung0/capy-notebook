package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/blob"
	"github.com/samyung0/capy-notebook/server/internal/httpapi"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// openCanvasHTTP serves the seeded workspace ws_e2e_private (u_owner its owner,
// u_editor an editor, u_viewer a viewer, u_other outside it) with collaboration
// configured, as every deployment has it. No canvas route commands the
// collaboration server, so a request to it fails the test (found on UAT
// 2026-11-10: a canvas path that failed only where it was configured).
func openCanvasHTTP(t *testing.T) (http.Handler, *store.Store) {
	t.Helper()
	ctx := context.Background()
	st, err := store.New(ctx, testdb.URL(t))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(st.Close)
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the collaboration server was asked %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(sidecar.Close)
	st.ConfigureCollaboration(sidecar.URL, "collab-test-secret")
	return httpapi.New(st, blob.NewMemory(), nil, nil, "docling", httpapi.Config{
		AuthDisabled:        true,
		E2EAuth:             true,
		E2ESecret:           "e2e-test-secret",
		E2EUserIDs:          []string{"u_owner", "u_editor", "u_viewer", "u_other"},
		CollaborationSecret: "collab-test-secret",
	}), st
}

type canvasJSON struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Version     int64  `json:"version"`
	WorkspaceID string `json:"workspaceId"`
	Shared      bool   `json:"shared"`
	Own         bool   `json:"own"`
	CreatorName string `json:"creatorName"`
}

// makeCanvas makes a canvas of the user's, in the seeded workspace or in none,
// and shares it there when asked.
func makeCanvas(t *testing.T, h http.Handler, st *store.Store, user, workspaceID string, shared bool) canvasJSON {
	t.Helper()
	body := map[string]any{"title": "Canvas of " + user}
	if workspaceID != "" {
		body["workspaceId"] = workspaceID
	}
	rec := doReq(t, h, http.MethodPost, "/api/canvases", user, body)
	var made canvasJSON
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &made) != nil {
		t.Fatalf("%s making a canvas → %d %s", user, rec.Code, rec.Body)
	}
	cleanupMaterial(t, st, made.ID)
	if made.Shared || !made.Own || made.Version != 0 || made.WorkspaceID != workspaceID {
		t.Fatalf("a new canvas = %+v", made)
	}
	if shared {
		rec = doReq(t, h, http.MethodPatch, "/api/canvases/"+made.ID, user, map[string]any{"shared": true})
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &made) != nil || !made.Shared {
			t.Fatalf("%s sharing a canvas → %d %s", user, rec.Code, rec.Body)
		}
	}
	return made
}

// canvasToken asks for the user's room token: its status, and the access and
// room it grants.
func canvasToken(t *testing.T, h http.Handler, user, canvasID string, body any) (status int, access, room string) {
	t.Helper()
	rec := doReq(t, h, http.MethodPost, "/api/materials/"+canvasID+"/collaboration-token", user, body)
	var token struct {
		Token  string `json:"token"`
		Access string `json:"access"`
		Room   string `json:"room"`
	}
	if rec.Code == http.StatusCreated {
		if err := json.Unmarshal(rec.Body.Bytes(), &token); err != nil || token.Token == "" {
			t.Fatalf("%s token = %s (%v)", user, rec.Body, err)
		}
	}
	return rec.Code, token.Access, token.Room
}

// A canvas opens one room whatever its visibility (Epo 2026-11-18). A private
// one gives its creator alone a token; shared with its workspace, owners and
// editors write, a viewer reads, and someone outside the workspace finds
// nothing. Unshared, the others find nothing again.
func TestCanvasRoomTokensFollowTheWorkspaceRolesOnceShared(t *testing.T) {
	h, st := openCanvasHTTP(t)
	canvas := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", false)
	expect := func(when string, want map[string]string) {
		t.Helper()
		for user, access := range want {
			status, got, room := canvasToken(t, h, user, canvas.ID, nil)
			if access == "" {
				if status != http.StatusNotFound {
					t.Errorf("%s: %s token = %d, want 404", when, user, status)
				}
				continue
			}
			if status != http.StatusCreated || got != access || room != "material:"+canvas.ID+":schema:1" {
				t.Errorf("%s: %s token = %d %q in %q, want %q", when, user, status, got, room, access)
			}
		}
	}
	creatorOnly := map[string]string{"u_editor": "write", "u_owner": "", "u_viewer": "", "u_other": ""}
	expect("private", creatorOnly)

	rec := doReq(t, h, http.MethodPatch, "/api/canvases/"+canvas.ID, "u_editor", map[string]any{"shared": true})
	expectStatus(t, rec, http.StatusOK, "the creator sharing")
	expect("shared", map[string]string{"u_editor": "write", "u_owner": "write", "u_viewer": "read", "u_other": ""})
	// A page that only watches asks to read; a canvas has no keys document.
	if status, access, _ := canvasToken(t, h, "u_owner", canvas.ID, map[string]any{"access": "read"}); status != http.StatusCreated || access != "read" {
		t.Errorf("an owner asking to read = %d %q", status, access)
	}
	if status, _, _ := canvasToken(t, h, "u_editor", canvas.ID, map[string]any{"document": "keys"}); status != http.StatusNotFound {
		t.Errorf("a canvas's keys document = %d, want 404", status)
	}

	rec = doReq(t, h, http.MethodPatch, "/api/canvases/"+canvas.ID, "u_editor", map[string]any{"shared": false})
	expectStatus(t, rec, http.StatusOK, "the creator unsharing")
	expect("unshared", creatorOnly)

	// A canvas of one's own, in no workspace, is its creator's alone.
	own := makeCanvas(t, h, st, "u_editor", "", false)
	if status, access, _ := canvasToken(t, h, "u_editor", own.ID, nil); status != http.StatusCreated || access != "write" {
		t.Errorf("the creator's token for a canvas of their own = %d %q", status, access)
	}
	if status, _, _ := canvasToken(t, h, "u_owner", own.ID, nil); status != http.StatusNotFound {
		t.Errorf("another person's token for it = %d, want 404", status)
	}
}

// A canvas whose payer (its creator) is at its storage limit is read-only for
// everyone who holds it, its creator included.
func TestAFullPayersCanvasRoomIsReadOnly(t *testing.T) {
	h, st := openCanvasHTTP(t)
	ctx := context.Background()
	canvas := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	const full = 1000000000000000
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_storage_deltas (user_id, delta_bytes) VALUES ('u_editor', $1)`, full); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM user_storage_deltas WHERE user_id='u_editor' AND delta_bytes=$1`, full)
	})
	for _, user := range []string{"u_editor", "u_owner", "u_viewer"} {
		if status, access, _ := canvasToken(t, h, user, canvas.ID, nil); status != http.StatusCreated || access != "read" {
			t.Errorf("%s token for a full payer's canvas = %d %q, want read", user, status, access)
		}
	}
}

// A canvas whose payer is frozen is read-only for the members who hold it, and
// a frozen member reads the canvases they hold.
func TestAFrozenPayersCanvasRoomIsReadOnly(t *testing.T) {
	f := overQuotaFixture(t, 20)
	ctx := context.Background()
	frozen := f.material.CreatedBy
	// Two shared canvases of the healthy editor's in the frozen owner's
	// workspace; the second becomes the frozen account's, as one it made
	// before it lapsed.
	healthy := makeCanvas(t, f.member, f.store, "u_editor", f.workspaceID, true)
	lapsed := makeCanvas(t, f.member, f.store, "u_editor", f.workspaceID, true)
	if _, err := f.store.Pool().Exec(ctx, `UPDATE materials SET owner_user_id=$2, created_by=$2 WHERE id=$1`, lapsed.ID, frozen); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name   string
		h      http.Handler
		actor  string
		canvas string
		access string
	}{
		{"an editor on the frozen payer's canvas", f.member, "u_editor", lapsed.ID, "read"},
		{"the frozen creator on their canvas", f.owner, "", lapsed.ID, "read"},
		{"the frozen owner on a healthy payer's canvas", f.owner, "", healthy.ID, "read"},
		{"its healthy creator", f.member, "u_editor", healthy.ID, "write"},
	} {
		if status, access, _ := canvasToken(t, c.h, c.actor, c.canvas, nil); status != http.StatusCreated || access != c.access {
			t.Errorf("%s: token = %d %q, want %q", c.name, status, access, c.access)
		}
	}
}

// A workspace's canvases (Epo 2026-11-12, shared ones Epo 2026-11-18): a member
// lists the ones they drew there and the other members' shared ones, each
// saying whether it is shared and their own, another member's naming who made
// it, and opens those by id; someone outside the workspace reaches none of it.
func TestWorkspaceCanvasesListTheCallersAndTheSharedOnes(t *testing.T) {
	h, st := openCanvasHTTP(t)
	mine := makeCanvas(t, h, st, "u_viewer", "ws_e2e_private", false)
	theirs := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	hidden := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", false)

	rec := doReq(t, h, http.MethodGet, "/api/canvases?workspaceId=ws_e2e_private", "u_viewer", nil)
	var page struct {
		Items []canvasJSON `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("list → %d %s", rec.Code, rec.Body)
	}
	listed := map[string]canvasJSON{}
	for _, item := range page.Items {
		listed[item.ID] = item
	}
	if _, private := listed[hidden.ID]; private || !listed[mine.ID].Own || listed[mine.ID].Shared || listed[mine.ID].CreatorName != "" ||
		listed[theirs.ID].Own || !listed[theirs.ID].Shared || listed[theirs.ID].CreatorName != "E2E Editor" ||
		listed[theirs.ID].WorkspaceID != "ws_e2e_private" {
		t.Fatalf("the viewer's workspace canvases = %+v", page.Items)
	}

	rec = doReq(t, h, http.MethodGet, "/api/canvases/"+theirs.ID, "u_viewer", nil)
	var opened canvasJSON
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &opened) != nil || !opened.Shared || opened.Own {
		t.Fatalf("a member opening a shared canvas → %d %s", rec.Code, rec.Body)
	}
	expectStatus(t, doReq(t, h, http.MethodGet, "/api/canvases/"+hidden.ID, "u_viewer", nil), http.StatusNotFound, "a member opening a private canvas")
	for _, call := range []struct{ method, path string }{
		{http.MethodGet, "/api/canvases?workspaceId=ws_e2e_private"},
		{http.MethodPost, "/api/canvases"},
		{http.MethodGet, "/api/canvases/" + theirs.ID},
	} {
		var body any
		if call.method == http.MethodPost {
			body = map[string]any{"title": "Mine", "workspaceId": "ws_e2e_private"}
		}
		if rec := doReq(t, h, call.method, call.path, "u_other", body); rec.Code != http.StatusNotFound {
			t.Errorf("non-member %s %s → %d, want 404", call.method, call.path, rec.Code)
		}
	}
}

// PROVISIONAL (contract open question 3): a canvas's creator alone shares,
// unshares, renames and deletes it, and shares only while a workspace owner or
// editor; a canvas in no workspace is never shared. The save route is gone:
// the board is written through its room.
func TestACanvasIsSharedRenamedAndDeletedByItsCreator(t *testing.T) {
	h, st := openCanvasHTTP(t)
	canvas := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	path := "/api/canvases/" + canvas.ID
	rename := map[string]any{"title": "Renamed"}

	// The workspace's owner holds the shared canvas as an owner and still
	// administers nothing of it (the material routes answer a refused edit as
	// not found).
	expectStatus(t, doReq(t, h, http.MethodPatch, path, "u_owner", map[string]any{"shared": false}), http.StatusForbidden, "the workspace owner unsharing")
	expectStatus(t, doReq(t, h, http.MethodPatch, "/api/materials/"+canvas.ID+"/metadata", "u_owner", rename), http.StatusNotFound, "the workspace owner renaming")
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/materials/"+canvas.ID, "u_owner", nil), http.StatusNotFound, "the workspace owner deleting")
	expectStatus(t, doReq(t, h, http.MethodPatch, path, "u_other", map[string]any{"shared": false}), http.StatusNotFound, "someone outside the workspace unsharing")

	expectStatus(t, doReq(t, h, http.MethodPatch, "/api/materials/"+canvas.ID+"/metadata", "u_editor", rename), http.StatusOK, "the creator renaming")
	rec := doReq(t, h, http.MethodPatch, path, "u_editor", map[string]any{"shared": false})
	var unshared canvasJSON
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &unshared) != nil || unshared.Shared || unshared.Title != "Renamed" {
		t.Fatalf("the creator unsharing → %d %s", rec.Code, rec.Body)
	}
	expectStatus(t, doReq(t, h, http.MethodPut, path, "u_editor", map[string]any{"revision": 1, "boardAssetId": "asset_1", "imageAssetIds": []string{}}),
		http.StatusMethodNotAllowed, "the removed save route")
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/materials/"+canvas.ID, "u_editor", nil), http.StatusNoContent, "the creator deleting")

	viewers := makeCanvas(t, h, st, "u_viewer", "ws_e2e_private", false)
	expectStatus(t, doReq(t, h, http.MethodPatch, "/api/canvases/"+viewers.ID, "u_viewer", map[string]any{"shared": true}), http.StatusForbidden, "a viewer sharing")
	own := makeCanvas(t, h, st, "u_editor", "", false)
	expectStatus(t, doReq(t, h, http.MethodPatch, "/api/canvases/"+own.ID, "u_editor", map[string]any{"shared": true}), http.StatusUnprocessableEntity, "sharing a canvas in no workspace")
}

// A shared canvas takes the images of everyone who edits it, each paying for
// their own (uploader pays): its creator and the workspace's owner and editors.
// A viewer adds none, and a private canvas takes its creator's alone.
func TestASharedCanvasTakesItsEditorsImages(t *testing.T) {
	h, st := openCanvasHTTP(t)
	shared := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	private := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", false)
	png := testPNG(108)
	meta := map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": len(png), "contentType": "image/png"}
	for _, c := range []struct {
		user   string
		canvas string
		status int
	}{
		{"u_editor", shared.ID, http.StatusCreated},
		{"u_owner", shared.ID, http.StatusCreated},
		{"u_viewer", shared.ID, http.StatusForbidden},
		{"u_owner", private.ID, http.StatusNotFound},
	} {
		rec := postUpload(t, h, "/api/materials/"+c.canvas+"/editor-assets/uploads", c.user, meta, "image/png", png)
		expectStatus(t, rec, c.status, c.user+" adding an image to "+c.canvas)
	}
	var payers []string
	rows, err := st.Pool().Query(context.Background(), `SELECT user_id FROM editor_assets
		WHERE material_id=$1 AND status='ready' ORDER BY user_id`, shared.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var payer string
		if err := rows.Scan(&payer); err != nil {
			t.Fatal(err)
		}
		payers = append(payers, payer)
	}
	if len(payers) != 2 || payers[0] != "u_editor" || payers[1] != "u_owner" {
		t.Fatalf("the shared canvas's images are paid by %v, want each uploader", payers)
	}
}

// A canvas takes no board asset, its board living in its room; a quiz's drawn
// sample answer still uploads one, and a canvas still takes its images.
func TestACanvasTakesNoBoardAsset(t *testing.T) {
	h, st := openCanvasHTTP(t)
	canvas := makeCanvas(t, h, st, "u_owner", "ws_e2e_private", false)
	board := map[string]any{"name": "board.ydoc.gz", "purpose": "board", "sizeBytes": 4096, "contentType": "application/gzip"}
	image := map[string]any{"name": "figure.png", "purpose": "image", "sizeBytes": 10, "contentType": "image/png"}
	for _, c := range []struct {
		what     string
		material string
		meta     map[string]any
		status   int
	}{
		{"a board asset for a canvas", canvas.ID, board, http.StatusBadRequest},
		{"an image for a canvas", canvas.ID, image, http.StatusCreated},
		{"a quiz's sample answer board", "qz_e2e_private", board, http.StatusCreated},
	} {
		rec, _ := takeTicket(t, h, "/api/materials/"+c.material+"/editor-assets/uploads", "u_owner", c.meta)
		expectStatus(t, rec, c.status, c.what)
	}
}

// canvasAccessJSON is what a canvas's response says of the caller's editing,
// in a note's field names.
type canvasAccessJSON struct {
	Role         *string `json:"role"`
	Capabilities struct {
		CanView          bool `json:"canView"`
		CanEdit          bool `json:"canEdit"`
		CanEditContent   bool `json:"canEditContent"`
		CanManageMembers bool `json:"canManageMembers"`
	} `json:"capabilities"`
	StorageFull string `json:"storageFull"`
	Trash       *struct {
		EpisodeID  string `json:"episodeId"`
		CanRestore bool   `json:"canRestore"`
	} `json:"trash"`
}

func readCanvasAccess(t *testing.T, h http.Handler, user, canvasID string) canvasAccessJSON {
	t.Helper()
	rec := doReq(t, h, http.MethodGet, "/api/canvases/"+canvasID, user, nil)
	var got canvasAccessJSON
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &got) != nil {
		t.Fatalf("%s reading canvas %s → %d %s", user, canvasID, rec.Code, rec.Body)
	}
	return got
}

// A canvas says what a note says of the caller's editing (role, capabilities,
// storageFull): its creator owns it, the other members hold their workspace
// role, a viewer edits nothing, and while its payer is at its storage limit the
// editors still edit its metadata but not its board, told whose storage it is.
func TestACanvasSaysTheCallersRoleAndWhyItIsReadOnly(t *testing.T) {
	h, st := openCanvasHTTP(t)
	ctx := context.Background()
	canvas := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	expect := func(when, user, role string, edit, content bool, full string) {
		t.Helper()
		got := readCanvasAccess(t, h, user, canvas.ID)
		if got.Role == nil || *got.Role != role || !got.Capabilities.CanView || got.Capabilities.CanEdit != edit ||
			got.Capabilities.CanEditContent != content || got.Capabilities.CanManageMembers ||
			got.StorageFull != full || got.Trash != nil {
			t.Errorf("%s: %s reads %+v", when, user, got)
		}
	}
	expect("healthy", "u_editor", "owner", true, true, "")
	expect("healthy", "u_owner", "owner", true, true, "")
	expect("healthy", "u_viewer", "viewer", false, false, "")

	const full = 1000000000000000
	if _, err := st.Pool().Exec(ctx, `INSERT INTO user_storage_deltas (user_id, delta_bytes) VALUES ('u_editor', $1)`, full); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM user_storage_deltas WHERE user_id='u_editor' AND delta_bytes=$1`, full)
	})
	expect("payer full", "u_editor", "owner", true, false, "self")
	expect("payer full", "u_owner", "owner", true, false, "payer")
	expect("payer full", "u_viewer", "viewer", false, false, "")
}

// A frozen payer's canvas reads as a note of theirs does: nobody edits it, and
// no storage strip names anyone.
func TestAFrozenPayersCanvasSaysItIsReadOnly(t *testing.T) {
	f := overQuotaFixture(t, 20)
	ctx := context.Background()
	lapsed := makeCanvas(t, f.member, f.store, "u_editor", f.workspaceID, true)
	if _, err := f.store.Pool().Exec(ctx, `UPDATE materials SET owner_user_id=$2, created_by=$2 WHERE id=$1`,
		lapsed.ID, f.material.CreatedBy); err != nil {
		t.Fatal(err)
	}
	got := readCanvasAccess(t, f.member, "u_editor", lapsed.ID)
	if got.Role == nil || *got.Role != "editor" || !got.Capabilities.CanView || got.Capabilities.CanEdit ||
		got.Capabilities.CanEditContent || got.StorageFull != "" {
		t.Fatalf("an editor on a frozen payer's canvas reads %+v", got)
	}
}

// ⌘K search lists every canvas the caller can open (Epo 2026-11-18): their
// own, and another member's shared one, each opening on its workspace's Canvas
// panel at that canvas.
func TestSearchListsTheCanvasesTheCallerCanOpen(t *testing.T) {
	h, st := openCanvasHTTP(t)
	title := "Search board " + strconv.FormatInt(time.Now().UnixNano(), 36)
	create := func(user string, shared bool) string {
		t.Helper()
		rec := doReq(t, h, http.MethodPost, "/api/canvases", user, map[string]any{"title": title + " " + user, "workspaceId": "ws_e2e_private"})
		var made canvasJSON
		if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &made) != nil {
			t.Fatalf("%s making a canvas → %d %s", user, rec.Code, rec.Body)
		}
		cleanupMaterial(t, st, made.ID)
		if shared {
			expectStatus(t, doReq(t, h, http.MethodPatch, "/api/canvases/"+made.ID, user, map[string]any{"shared": true}), http.StatusOK, "sharing")
		}
		return made.ID
	}
	mine := create("u_viewer", false)
	theirs := create("u_editor", true)
	rec := doReq(t, h, http.MethodGet, "/api/search?q="+strings.ReplaceAll(title, " ", "+"), "u_viewer", nil)
	var results []struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
		Href string `json:"href"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &results) != nil {
		t.Fatalf("search → %d %s", rec.Code, rec.Body)
	}
	found := map[string]string{}
	for _, r := range results {
		if r.Kind == "canvas" {
			found[r.ID] = r.Href
		}
	}
	for _, id := range []string{mine, theirs} {
		if found[id] != "/workspaces/ws_e2e_private?view=canvas&c="+id {
			t.Errorf("canvas %s found at %q in %v", id, found[id], found)
		}
	}
}

// A canvas takes no comments, as it takes no content write: its board shows
// none.
func TestACanvasTakesNoComments(t *testing.T) {
	h, st := openCanvasHTTP(t)
	canvas := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	discussion := map[string]any{"anchorVersion": 1, "text": "Look here"}
	for _, user := range []string{"u_editor", "u_owner"} {
		rec := doReq(t, h, http.MethodPost, "/api/materials/"+canvas.ID+"/discussions", user, discussion)
		expectStatus(t, rec, http.StatusBadRequest, user+" commenting on a canvas")
		if !strings.Contains(rec.Body.String(), "a canvas takes no comments") {
			t.Errorf("%s commenting on a canvas: refused for another reason: %s", user, rec.Body.String())
		}
	}
}

// A trashed canvas opens read-only from its creator's Trash as a note does
// (Epo 2026-11-12): its read says so with every capability off, and its board
// is the stored state, the base and then each stored update in order. Nobody
// else reads either, a live canvas's board is its room's, and a restored one
// is live again.
func TestATrashedCanvasOpensReadOnlyFromItsCreatorsTrash(t *testing.T) {
	h, st := openCanvasHTTP(t)
	ctx := context.Background()
	canvas := makeCanvas(t, h, st, "u_editor", "ws_e2e_private", true)
	board := "/api/canvases/" + canvas.ID + "/board"
	expectStatus(t, doReq(t, h, http.MethodGet, board, "u_editor", nil), http.StatusNotFound, "a live canvas's board")
	if _, err := st.Pool().Exec(ctx, `INSERT INTO material_yjs_documents (material_id, state, stored_version, projected_version)
		VALUES ($1, '\x0102', 3, 3)`, canvas.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool().Exec(ctx, `INSERT INTO material_yjs_updates (material_id, seq, update)
		VALUES ($1, 3, '\x05'), ($1, 2, '\x0304')`, canvas.ID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/materials/"+canvas.ID, "u_editor", nil), http.StatusNoContent, "the creator deleting")

	got := readCanvasAccess(t, h, "u_editor", canvas.ID)
	if got.Role != nil || !got.Capabilities.CanView || got.Capabilities.CanEdit || got.Capabilities.CanEditContent ||
		got.StorageFull != "" || got.Trash == nil || got.Trash.EpisodeID == "" || !got.Trash.CanRestore {
		t.Fatalf("the creator reads the trashed canvas as %+v", got)
	}
	rec := doReq(t, h, http.MethodGet, board, "u_editor", nil)
	var stored struct {
		Updates [][]byte `json:"updates"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &stored) != nil || len(stored.Updates) != 3 ||
		string(stored.Updates[0]) != "\x01\x02" || string(stored.Updates[1]) != "\x03\x04" || string(stored.Updates[2]) != "\x05" {
		t.Fatalf("the trashed canvas's board → %d %s", rec.Code, rec.Body)
	}
	for _, user := range []string{"u_owner", "u_viewer", "u_other"} {
		expectStatus(t, doReq(t, h, http.MethodGet, "/api/canvases/"+canvas.ID, user, nil), http.StatusNotFound, user+" reading the trashed canvas")
		expectStatus(t, doReq(t, h, http.MethodGet, board, user, nil), http.StatusNotFound, user+" reading its board")
	}
	// Its creator could read it live, so its room says it was deleted.
	if status, _, _ := canvasToken(t, h, "u_editor", canvas.ID, nil); status != http.StatusGone {
		t.Errorf("a room token for the trashed canvas = %d, want 410", status)
	}

	expectStatus(t, doReq(t, h, http.MethodPost, "/api/trash/material/"+canvas.ID+"/restore", "u_editor",
		map[string]any{"episodeId": got.Trash.EpisodeID, "requestId": "restore-" + canvas.ID}), http.StatusOK, "the creator restoring")
	if back := readCanvasAccess(t, h, "u_editor", canvas.ID); back.Trash != nil || back.Role == nil || !back.Capabilities.CanEditContent {
		t.Fatalf("the restored canvas reads %+v", back)
	}
	expectStatus(t, doReq(t, h, http.MethodGet, board, "u_editor", nil), http.StatusNotFound, "a restored canvas's board")
}

// A trashed canvas never opened has stored no board: its board is empty.
func TestATrashedCanvasNeverOpenedHasAnEmptyBoard(t *testing.T) {
	h, st := openCanvasHTTP(t)
	canvas := makeCanvas(t, h, st, "u_editor", "", false)
	expectStatus(t, doReq(t, h, http.MethodDelete, "/api/materials/"+canvas.ID, "u_editor", nil), http.StatusNoContent, "the creator deleting")
	rec := doReq(t, h, http.MethodGet, "/api/canvases/"+canvas.ID+"/board", "u_editor", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"updates":[]`) {
		t.Fatalf("a never opened trashed canvas's board → %d %s", rec.Code, rec.Body)
	}
}
