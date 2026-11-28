package httpapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/auth"
	"github.com/samyung0/capy-notebook/server/internal/store"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// doCollaboration calls a collaboration-service route with its secret.
func doCollaboration(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Collaboration-Secret", "collab-test-secret")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// Files are view-only (Q852 A, Q853 A): /me says so, an editor's Office and
// text files open their read session only, and every route that would edit
// one refuses as forbidden (read as not found): the edit session and room
// token, the room service's join, save and processing request, Process,
// Blank DOCX/XLSX and a thumbnail capture.
func TestFilesViewOnlyRefusesEveryFileEditRoute(t *testing.T) {
	testdb.SkipWhileFilesEditable(t)
	fx, authority := openBlankFiles(t)
	docx, md := officeSource(t, fx, "essay.docx"), officeSource(t, fx, "notes.md")
	for _, name := range []string{"essay.docx", "notes.md"} {
		if _, err := fx.mem.PutObjectOnce(context.Background(), "sources/office_"+fx.ws+"_"+name,
			bytes.NewReader([]byte("stored bytes")), "application/octet-stream", ""); err != nil {
			t.Fatal(err)
		}
	}

	rec := doAsUser(t, fx.h, http.MethodGet, "/api/me", fx.editor, nil)
	var me struct {
		FilesEditable *bool `json:"filesEditable"`
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &me) != nil || me.FilesEditable == nil || *me.FilesEditable {
		t.Fatalf("me = %d %s, want filesEditable false", rec.Code, rec.Body.String())
	}
	for _, id := range []string{docx, md} {
		rec = doAsUser(t, fx.h, http.MethodGet, "/api/files/"+id+"/source-session?view=true", fx.editor, nil)
		var view struct{ Access string }
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &view) != nil || view.Access != "read" {
			t.Fatalf("%s view session = %d %s, want a read session", id, rec.Code, rec.Body.String())
		}
		for _, call := range []struct{ method, path string }{
			{http.MethodGet, "/api/files/" + id + "/source-session"},
			{http.MethodPost, "/api/files/" + id + "/collaboration-token"},
			{http.MethodPost, "/api/files/" + id + "/process-changes"},
		} {
			if rec = doAsUser(t, fx.h, call.method, call.path, fx.editor, map[string]any{}); rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s = %d %s, want refused", call.method, call.path, rec.Code, rec.Body.String())
			}
		}
		for _, call := range []struct {
			method, path string
			body         any
		}{
			{http.MethodGet, "/internal/collaboration/files/" + id + "/access?actorId=" + fx.editor + "&epoch=1&edit=true", nil},
			{http.MethodGet, "/internal/collaboration/files/" + id + "/access?actorId=" + fx.editor + "&epoch=1", nil},
			{http.MethodPost, "/internal/collaboration/files/" + id + "/refresh", map[string]any{"actorId": fx.editor, "automatic": true}},
			{http.MethodPost, "/internal/collaboration/files/" + id + "/checkpoint", map[string]any{
				"actorIds": []string{fx.editor}, "workspaceId": fx.ws, "epoch": 1, "expectedCheckpoint": 0,
				"baseRevision": 1, "update": base64.StdEncoding.EncodeToString([]byte{0}), "pendingEffects": []any{}, "netTokens": 0,
			}},
		} {
			if rec = doCollaboration(t, fx.h, call.method, call.path, call.body); rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s = %d %s, want refused", call.method, call.path, rec.Code, rec.Body.String())
			}
		}
	}
	var updates int
	if err := fx.st.Pool().QueryRow(context.Background(),
		`SELECT count(*) FROM source_document_updates WHERE file_id = ANY($1)`, []string{docx, md}).Scan(&updates); err != nil || updates != 0 {
		t.Fatalf("saved updates = %d (%v), want none", updates, err)
	}

	rec = doAsUser(t, fx.h, http.MethodPost, "/api/workspaces/"+fx.ws+"/files/blank", fx.editor,
		map[string]any{"format": "docx", "name": "Plan"})
	if rec.Code != http.StatusNotFound || len(authority.sent("/internal/documents/create")) != 0 {
		t.Fatalf("blank = %d %s, want refused before the engine", rec.Code, rec.Body.String())
	}
	if rec = doAsUser(t, fx.h, http.MethodPost, "/api/files/blank", fx.editor,
		map[string]any{"format": "xlsx", "name": "Grades"}); rec.Code != http.StatusNotFound {
		t.Fatalf("standalone blank = %d %s, want refused", rec.Code, rec.Body.String())
	}

	req := httptest.NewRequest(http.MethodPost, "/api/files/"+docx+"/thumbnail", bytes.NewReader([]byte("RIFF")))
	req.Header.Set("Content-Type", "image/webp")
	req.Header.Set(auth.HeaderE2EUserID, fx.editor)
	req.Header.Set(auth.HeaderE2ESecret, "e2e-test-secret")
	rec = httptest.NewRecorder()
	fx.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("thumbnail = %d %s, want refused", rec.Code, rec.Body.String())
	}
}

// Chat edits no file while files are view-only (Q854 A): edit_document and
// edit_office_document refuse a file and its create with the not-editable
// answer before the document authority hears of them, its file rows and
// Access lines say not editable, and its Undo of an earlier file edit is refused; a note still
// takes its edit.
func TestChatEditsNotesButNoFile(t *testing.T) {
	testdb.SkipWhileFilesEditable(t)
	h, st := openInternalHTTP(t)
	edits := 0
	authority := httptest.NewServer(withConverter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/documents/edit" {
			edits++
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op","outcome":"succeeded","kind":"edit_document"}`))
	})))
	t.Cleanup(authority.Close)
	st.ConfigureCollaboration(authority.URL, "collab-test-secret")
	ctx := context.Background()
	md, err := uploadSource(ctx, st, "ws_e2e_private", "u_editor", "view-only.md", 64, "sources/view_only_md")
	if err != nil {
		t.Fatal(err)
	}
	docx, err := uploadSource(ctx, st, "ws_e2e_private", "u_editor", "view-only.docx", 64, "sources/view_only_docx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = st.Pool().Exec(context.Background(), `DELETE FROM files WHERE id = ANY($1)`, []string{md.ID, docx.ID})
	})

	msgID := seedAssistantMessage(t, st, "u_editor", "ws_e2e_private")
	rec := doInternal(t, h, http.MethodPost, "/api/internal/materials", pipeSecret,
		noteBody(msgID, "call_view_only_note", "View-only round", "# Notes\n\nStill editable."))
	if rec.Code != http.StatusOK {
		t.Fatalf("create note = %d %s", rec.Code, rec.Body.String())
	}
	note := decodeReceipt(t, rec).Effect.Resource.ID
	cleanupMaterial(t, st, note)
	edit := func(call string, target map[string]any, office bool, commands []map[string]any) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/documents/edit", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor", "assistantMessageId": msgID,
			"toolCallId": call, "target": target, "commands": commands, "office": office,
		})
	}
	text := []map[string]any{{"type": "replace_text", "expected_text": "a", "text": "b"}}
	for _, refused := range []*httptest.ResponseRecorder{
		edit("call_view_only_md", map[string]any{"kind": "source_file", "id": md.ID}, false, text),
		edit("call_view_only_docx", map[string]any{"kind": "source_file", "id": docx.ID}, true,
			[]map[string]any{{"type": "replace_text", "target_id": "p1", "expected_text": "a", "text": "b"}}),
		doInternal(t, h, http.MethodPost, "/api/internal/documents/office/create", pipeSecret, map[string]any{
			"workspaceId": "ws_e2e_private", "userId": "u_editor", "assistantMessageId": msgID,
			"toolCallId": "call_view_only_create", "format": "docx", "title": "Plan",
		}),
	} {
		var body struct{ Code string }
		if refused.Code != http.StatusUnprocessableEntity || json.Unmarshal(refused.Body.Bytes(), &body) != nil || body.Code != "unsupported_format" {
			t.Fatalf("file edit = %d %s, want unsupported_format", refused.Code, refused.Body.String())
		}
	}
	if edits != 0 {
		t.Fatalf("the authority took %d file edits", edits)
	}
	rec = edit("call_view_only_note_edit", map[string]any{"kind": "material", "id": note}, false,
		[]map[string]any{{"type": "insert_markdown", "after_block_id": nil, "markdown": "A second section."}})
	if rec.Code != http.StatusOK || edits != 1 {
		t.Fatalf("note edit = %d %s (authority edits %d), want it applied", rec.Code, rec.Body.String(), edits)
	}

	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/list", pipeSecret,
		map[string]any{"workspaceId": "ws_e2e_private", "userId": "u_editor"})
	var listed struct {
		Items []struct {
			ID       string
			Editable bool
		}
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &listed) != nil {
		t.Fatalf("list = %d %s", rec.Code, rec.Body.String())
	}
	for _, item := range listed.Items {
		if (item.ID == md.ID || item.ID == docx.ID) && item.Editable {
			t.Fatalf("file row %s says editable", item.ID)
		}
	}

	rec = doInternal(t, h, http.MethodPost, "/api/internal/documents/access", pipeSecret, map[string]any{
		"actorUserId": "u_editor", "items": []map[string]string{{"kind": "source_file", "id": md.ID}},
	})
	var access struct {
		Items []struct{ CanRead, CanEdit, Editable bool }
	}
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &access) != nil || len(access.Items) != 1 ||
		!access.Items[0].CanRead || access.Items[0].CanEdit || access.Items[0].Editable {
		t.Fatalf("access = %d %s, want readable and not editable", rec.Code, rec.Body.String())
	}

	step := store.AgentOperation{Effect: &agenttools.ResourceEffect{
		Operation: agenttools.EffectEdited,
		Resource:  agenttools.ResourceRef{Kind: agenttools.KindSourceFile, ID: md.ID},
	}}
	if _, err := st.UndoDocumentEdit(ctx, "u_editor", step, nil, store.DocumentOperation{}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("undo of a file edit = %v, want forbidden", err)
	}
}
