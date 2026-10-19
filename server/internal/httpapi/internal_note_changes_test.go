package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Chat's per-turn note changes and their resolve: both need the pipeline
// secret and stay in the named workspace, the resolve acts as a user who may
// read it, and neither carries a quiz's answer keys or solutions (Epo
// 2026-10-18).
func TestNoteChangesStayInTheirWorkspaceAndCarryNoKeys(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	note, err := st.CreateMaterial(ctx, store.Material{CreatedBy: "u_editor", WorkspaceID: "ws_e2e_private",
		Kind: "note", Title: "Changed note", Content: noteTestContent(t, "# Notes\n\nbody")})
	if err != nil {
		t.Fatal(err)
	}
	question := `{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"Pending quiz prompt?"}],` +
		`"answer":{"type":"boolean","correct":true},"marks":1,"solution":[{"type":"text","text":"Worked solution marker"}]}],` +
		`"layout":"paper","labels":"letters"}`
	quiz, err := st.CreateEmbeddedMaterial(ctx, "u_editor", note.ID, store.EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[` + question + `]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	ref := materialdoc.MaterialRefNode(quiz.ID, "quiz")
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: materialdoc.SchemaVersion, Value: []map[string]any{
		materialdoc.ParagraphNode("intro"), ref,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.UpdateMaterial(ctx, note.ID, store.MaterialPatch{Content: &content, UpdatedBy: "u_editor"}); err != nil {
		t.Fatal(err)
	}
	keyFree := func(body string) bool {
		return !strings.Contains(body, "Worked solution marker") && !strings.Contains(body, `"correct"`)
	}

	changes := func(secret, workspaceID string) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/note-changes", secret, map[string]any{
			"workspaceId": workspaceID, "materialIds": []string{note.ID},
		})
	}
	if rec := changes("", "ws_e2e_private"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without the secret: %d %s", rec.Code, rec.Body.String())
	}
	if rec := changes(pipeSecret, "ws_e2e_link"); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), note.ID) {
		t.Fatalf("another workspace reads the note: %d %s", rec.Code, rec.Body.String())
	}
	rec := changes(pipeSecret, "ws_e2e_private")
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, note.ID) || !strings.Contains(body, "Pending quiz prompt?") || !keyFree(body) {
		t.Fatalf("note changes: %d %s", rec.Code, body)
	}

	resolve := func(userID, workspaceID string) *httptest.ResponseRecorder {
		return doInternal(t, h, http.MethodPost, "/api/internal/note-changes/resolve", pipeSecret, map[string]any{
			"workspaceId": workspaceID, "userId": userID, "materialId": note.ID, "blockId": ref["id"],
		})
	}
	for _, tc := range []struct{ name, userID, workspaceID string }{
		{"actor without access", "u_other", "ws_e2e_private"},
		{"note outside the workspace", "u_owner", "ws_e2e_link"},
	} {
		if rec := resolve(tc.userID, tc.workspaceID); rec.Code != http.StatusNotFound {
			t.Fatalf("%s: %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
	rec = resolve("u_viewer", "ws_e2e_private")
	var text struct{ Before, After string }
	if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &text) != nil ||
		text.Before != "" || !strings.Contains(text.After, "Pending quiz prompt?") || !keyFree(rec.Body.String()) {
		t.Fatalf("resolve as a reader: %d %s", rec.Code, rec.Body.String())
	}
}
