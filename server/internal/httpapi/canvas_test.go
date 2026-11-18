package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
