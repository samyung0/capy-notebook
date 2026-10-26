package httpapi_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/httpapi"
)

var blankDocx = []byte("PK\x03\x04 blank docx bytes")

// openBlankFiles is the deck fixture behind a handler that signs its editor
// and viewer in, with the engine's create answering a blank DOCX.
func openBlankFiles(t *testing.T) (deckFileFixture, *officeAuthority) {
	t.Helper()
	fx := openDeckFiles(t)
	fx.h = httpapi.New(fx.st, fx.mem, nil, nil, "docling", httpapi.Config{
		AuthDisabled: true, E2EAuth: true, E2ESecret: "e2e-test-secret",
		E2EUserIDs: []string{fx.editor, fx.viewer}, CollaborationSecret: "collab-test-secret",
	})
	return fx, newOfficeAuthority(t, fx.st, map[string]string{
		"/internal/documents/create": `{"content":"` + base64.StdEncoding.EncodeToString(blankDocx) + `"}`,
	})
}

// An editor's blank DOCX is the engine's starter, stored as a ready source it
// pays for and that is not processed, in the chapter it named, under the
// trimmed name with one extension.
func TestCreateBlankFileStoresTheStarter(t *testing.T) {
	fx, authority := openBlankFiles(t)

	rec := doAsUser(t, fx.h, http.MethodPost, "/api/workspaces/"+fx.ws+"/files/blank", fx.editor,
		map[string]any{"format": "docx", "name": " Untitled  document 1.DOCX ", "chapterId": fx.ch})
	var file struct {
		ID, Name, Kind, Status string
		ChapterID              *string `json:"chapterId"`
		Indexed                bool
	}
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &file) != nil ||
		file.Name != "Untitled document 1.docx" || file.Kind != "doc" || file.Status != "ready" ||
		file.Indexed || file.ChapterID == nil || *file.ChapterID != fx.ch {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	if sent := authority.sent("/internal/documents/create"); len(sent) != 1 ||
		string(sent[0]["format"]) != `"docx"` || string(sent[0]["commands"]) != `[]` ||
		string(sent[0]["actorUserId"]) != `"`+fx.editor+`"` {
		t.Fatalf("authority got %v", sent)
	}
	var payer, mode, blobPath string
	if err := fx.st.Pool().QueryRow(context.Background(),
		`SELECT user_id, parse_mode, blob_path FROM files WHERE id=$1`, file.ID).
		Scan(&payer, &mode, &blobPath); err != nil {
		t.Fatal(err)
	}
	if payer != fx.editor || mode != "none" {
		t.Fatalf("payer=%s parse_mode=%s, want the editor and none", payer, mode)
	}
	if stored, _, ok := fx.mem.Object(blobPath); !ok || string(stored) != string(blankDocx) {
		t.Fatalf("stored object %q = %q", blobPath, stored)
	}
}

// A viewer cannot add files, so the engine never builds one.
func TestCreateBlankFileRefusesAViewer(t *testing.T) {
	fx, authority := openBlankFiles(t)

	rec := doAsUser(t, fx.h, http.MethodPost, "/api/workspaces/"+fx.ws+"/files/blank", fx.viewer,
		map[string]any{"format": "xlsx", "name": "Grades"})
	if rec.Code != http.StatusNotFound || len(authority.sent("/internal/documents/create")) != 0 {
		t.Fatalf("viewer create = %d %s", rec.Code, rec.Body.String())
	}
}

// An editor at its storage limit is refused before the engine builds
// anything, so nothing is stored.
func TestCreateBlankFileTakesTheStorageGate(t *testing.T) {
	fx, authority := openBlankFiles(t)
	if _, err := fx.st.Pool().Exec(context.Background(),
		`INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, 1099511627776)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=1099511627776`, fx.editor); err != nil {
		t.Fatal(err)
	}

	rec := doAsUser(t, fx.h, http.MethodPost, "/api/workspaces/"+fx.ws+"/files/blank", fx.editor,
		map[string]any{"format": "docx", "name": "Essay"})
	if rec.Code != http.StatusForbidden || errorCode(t, rec) != "storage_quota_exceeded" ||
		len(authority.sent("/internal/documents/create")) != 0 {
		t.Fatalf("full create = %d %s", rec.Code, rec.Body.String())
	}
}
