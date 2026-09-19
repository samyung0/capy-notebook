package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func noteWithRefs(t *testing.T, refs ...Material) string {
	t.Helper()
	value := []map[string]any{materialdoc.ParagraphNode("intro")}
	for _, ref := range refs {
		value = append(value, materialdoc.MaterialRefNode(ref.ID, string(ref.Kind)))
	}
	raw, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: 1, Value: value})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestEmbeddedMaterialFollowsItsNote(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_embed_owner")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Embed", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Lecture 4",
		Content: "# Lecture 4\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","type":"boolean","level":"recall","prompt":"True?","correct":true}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if quiz.ParentMaterialID != note.ID || quiz.WorkspaceID != ws.ID || quiz.Title != "Lecture 4 · Quiz" {
		t.Fatalf("embedded quiz = %+v", quiz)
	}
	cards, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "flashcards", Cards: [][2]string{{"front", "back"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cards.Title != "Lecture 4 · Flashcards" {
		t.Fatalf("embedded flashcards title = %q", cards.Title)
	}
	if _, err := s.CreateEmbeddedMaterial(ctx, ownerID, quiz.ID, EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","type":"boolean","level":"recall","prompt":"True?","correct":true}]`)}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("embedding under a non-note should fail, got %v", err)
	}

	refs, err := s.ListMaterialRefs(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].ID != note.ID {
		t.Fatalf("tree should hide embedded rows: %+v", refs)
	}
	owned, err := s.ListOwnedMaterials(ctx, ownerID, MaterialListFilter{Kinds: []string{"quiz"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(owned.Items) != 1 || owned.Items[0].ID != quiz.ID {
		t.Fatalf("the Create list should include the embedded quiz: %+v", owned.Items)
	}
	if _, err := s.TrashMaterial(ctx, ownerID, quiz.ID, "", AgentOperation{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an embedded row cannot be trashed directly, got %v", err)
	}

	// A row nobody has referenced yet is still being inserted and is left
	// alone; once a projection has referenced it, dropping the reference
	// trashes it and referencing it again restores it.
	onlyQuiz := noteWithRefs(t, quiz)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &onlyQuiz, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMaterial(ctx, cards.ID); err != nil {
		t.Fatalf("a never-referenced row is left alone: %v", err)
	}
	content := noteWithRefs(t, quiz, cards)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &onlyQuiz, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMaterial(ctx, cards.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unreferenced row should be trashed, got %v", err)
	}
	trash, err := s.ListTrash(ctx, ownerID, "", 10, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(trash.Items) != 0 {
		t.Fatalf("embedded rows stay out of the trash listing: %+v", trash.Items)
	}
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	restored, err := s.GetMaterial(ctx, cards.ID)
	if err != nil {
		t.Fatalf("re-referenced row should be restored: %v", err)
	}
	if restored.ParentMaterialID != note.ID {
		t.Fatalf("restored row lost its parent: %+v", restored)
	}

	// Trashing the note takes its rows along in the same episode; restoring
	// the note brings them back.
	trashed, err := s.TrashMaterial(ctx, ownerID, note.ID, "", AgentOperation{})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{quiz.ID, cards.ID} {
		if _, err := s.GetMaterial(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("embedded row %s should be trashed with the note, got %v", id, err)
		}
	}
	if _, err := s.RestoreTrashed(ctx, ownerID, agenttools.KindMaterial, note.ID, trashed.Effect.TrashEpisodeID, AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{quiz.ID, cards.ID} {
		if _, err := s.GetMaterial(ctx, id); err != nil {
			t.Fatalf("embedded row %s should be restored with the note: %v", id, err)
		}
	}
}

func TestEmbeddedMaterialAccessAndCloneFollowTheNote(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_embed_share_owner")
	readerID := newBlobTestUser(t, s, "u_embed_share_reader")
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Shared note", Content: "# Shared\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","type":"boolean","level":"recall","prompt":"True?","correct":true}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	cards, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, EmbeddedDraft{
		Kind: "flashcards", Cards: [][2]string{{"front", "back"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	content := noteWithRefs(t, quiz, cards)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MaterialEffectiveRole(ctx, readerID, quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private note keeps its quiz private, got %v", err)
	}
	if _, err := s.UpdateStandaloneMaterialPrivacy(ctx, ownerID, quiz.ID, "", PrivacyLink); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an embedded row has no sharing of its own, got %v", err)
	}
	if _, err := s.UpdateStandaloneMaterialPrivacy(ctx, ownerID, note.ID, "", PrivacyLink); err != nil {
		t.Fatal(err)
	}
	role, err := s.MaterialEffectiveRole(ctx, readerID, quiz.ID)
	if err != nil || role != RoleViewer {
		t.Fatalf("link-shared note should expose its quiz to readers: role=%q err=%v", role, err)
	}

	clone, err := s.CloneMaterial(ctx, readerID, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	refs, err := materialdoc.ExtractMaterialRefs(clone.Content)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0].MaterialID == quiz.ID || refs[1].MaterialID == cards.ID {
		t.Fatalf("clone should reference its own copies: %+v", refs)
	}
	for _, ref := range refs {
		copied, err := s.GetMaterial(ctx, ref.MaterialID)
		if err != nil {
			t.Fatalf("cloned embedded row %s: %v", ref.MaterialID, err)
		}
		if copied.ParentMaterialID != clone.ID || copied.OwnerUserID != readerID || copied.WorkspaceID != "" {
			t.Fatalf("cloned embedded row = %+v", copied)
		}
	}
	clonedCards, err := s.ListCards(ctx, refs[1].MaterialID)
	if err != nil {
		t.Fatal(err)
	}
	if len(clonedCards) != 1 {
		t.Fatalf("cloned flashcards should keep their study rows: %+v", clonedCards)
	}

	// Workspace clone: the copied note points at the copied rows.
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Embed clone", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public', share_role='editor' WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	wsNote, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Workspace note",
		Content: "# Workspace note\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	wsQuiz, err := s.CreateEmbeddedMaterial(ctx, ownerID, wsNote.ID, EmbeddedDraft{
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","type":"boolean","level":"recall","prompt":"True?","correct":true}]`),
	})
	if err != nil {
		t.Fatal(err)
	}
	wsContent := noteWithRefs(t, wsQuiz)
	if _, err := s.UpdateMaterial(ctx, wsNote.ID, MaterialPatch{Content: &wsContent, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	wsClone, err := s.CloneWorkspace(ctx, readerID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	cloneRefs, err := s.ListMaterialRefs(ctx, wsClone.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(cloneRefs) != 1 {
		t.Fatalf("cloned tree should show the note only: %+v", cloneRefs)
	}
	clonedNote, err := s.GetMaterial(ctx, cloneRefs[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	noteRefs, err := materialdoc.ExtractMaterialRefs(clonedNote.Content)
	if err != nil {
		t.Fatal(err)
	}
	if len(noteRefs) != 1 || noteRefs[0].MaterialID == wsQuiz.ID {
		t.Fatalf("workspace clone should rewrite references: %+v", noteRefs)
	}
	clonedQuiz, err := s.GetMaterial(ctx, noteRefs[0].MaterialID)
	if err != nil {
		t.Fatal(err)
	}
	if clonedQuiz.ParentMaterialID != clonedNote.ID || clonedQuiz.WorkspaceID != wsClone.ID {
		t.Fatalf("cloned embedded quiz = %+v", clonedQuiz)
	}
}
