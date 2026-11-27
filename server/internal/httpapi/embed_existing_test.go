package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A note's Quiz picker (Epo 2026-11-27): the workspace read says it holds a
// quiz, and Insert makes the note's own copy of the one picked; a source of
// another kind than asked is not found.
func TestNoteInsertsACopyOfAPickedQuiz(t *testing.T) {
	h, st := openInternalHTTP(t)
	ctx := context.Background()
	note, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: "u_owner", WorkspaceID: "ws_e2e_private", Kind: "note", Title: "Picks a quiz",
		Content: noteTestContent(t, "body"), Privacy: "private",
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, note.ID)
	content, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1",`+
		`"blocks":[{"type":"text","text":"Q?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],`+
		`"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := st.CreateMaterial(ctx, store.Material{
		CreatedBy: "u_owner", WorkspaceID: "ws_e2e_private", Kind: "quiz", Title: "Picked", Content: content,
	})
	if err != nil {
		t.Fatal(err)
	}
	cleanupMaterial(t, st, quiz.ID)

	rec := doAsUser(t, h, http.MethodGet, "/api/workspaces/ws_e2e_private", "u_owner", nil)
	var workspace struct {
		HasQuiz *bool `json:"hasQuiz"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &workspace); err != nil || workspace.HasQuiz == nil || !*workspace.HasQuiz {
		t.Fatalf("workspace read = %d %s, want hasQuiz true", rec.Code, rec.Body.String())
	}

	rec = doAsUser(t, h, http.MethodPost, "/api/materials/"+note.ID+"/embedded", "u_owner",
		map[string]any{"kind": "quiz", "sourceId": quiz.ID})
	var made struct {
		ID   string `json:"id"`
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &made); rec.Code != http.StatusCreated || err != nil ||
		made.ID == "" || made.ID == quiz.ID || made.Kind != "quiz" {
		t.Fatalf("insert = %d %s, want the note's own copy", rec.Code, rec.Body.String())
	}
	copied, err := st.GetMaterial(ctx, made.ID)
	if err != nil || copied.ParentMaterialID != note.ID {
		t.Fatalf("copy = %+v, %v; want it under the note", copied, err)
	}

	rec = doAsUser(t, h, http.MethodPost, "/api/materials/"+note.ID+"/embedded", "u_owner",
		map[string]any{"kind": "flashcards", "sourceId": quiz.ID})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("a quiz inserted as flashcards = %d %s, want 404", rec.Code, rec.Body.String())
	}
}
