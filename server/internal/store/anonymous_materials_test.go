package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// Signed-out reads reach only standalone, non-embedded link/public materials
// of an active owner, and an image only when the quiz references it.
func TestAnonymousMaterialsVisibilityAndAssets(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_anon_owner")
	assetID, strayID := uid("asset"), uid("asset")
	content, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[{"type":"image","image":{"assetId":"`+assetID+`"},"width":10,"height":10,"description":"Figure"}],
		"parts":[{"id":"q1-a","blocks":[{"type":"text","text":"Explain."}],"answer":{"type":"open","accepted":["Because."],"hints":[]},"markscheme":["States why"],"solution":[]}],
		"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, Kind: "quiz", Title: "Shared quiz", Content: content})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{assetID, strayID} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO editor_assets
			(id,material_id,user_id,created_by,name,purpose,object_path,content_type,size_bytes,status,completed_at)
			VALUES ($1,$2,$3,$3,'figure.png','image',$4,'image/png',10,'ready',now())`,
			id, quiz.ID, ownerID, "editor-assets/"+id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AnonymousQuiz(ctx, quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private quiz err = %v, want not found", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='link' WHERE id=$1`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.AnonymousQuiz(ctx, quiz.ID)
	if err != nil || got.Name != "Shared quiz" {
		t.Fatalf("link quiz = %+v, %v", got, err)
	}
	if _, err := s.AnonymousFlashcards(ctx, quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("quiz read as flashcards err = %v", err)
	}
	if path, _, err := s.AnonymousQuizAssetPath(ctx, quiz.ID, assetID); err != nil || path != "editor-assets/"+assetID {
		t.Fatalf("referenced asset = %q, %v", path, err)
	}
	if _, _, err := s.AnonymousQuizAssetPath(ctx, quiz.ID, strayID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unreferenced asset err = %v, want not found", err)
	}

	workspace, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Public", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	inWorkspace, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, WorkspaceID: workspace.ID,
		WorkspaceName: workspace.Name, Kind: "quiz", Title: "Workspace quiz", Content: content})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AnonymousQuiz(ctx, inWorkspace.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("public workspace quiz err = %v, want not found", err)
	}

	cards, err := s.CreateFlashcardSet(ctx, ownerID, "Shared cards", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='public' WHERE id=$1`, cards.ID); err != nil {
		t.Fatal(err)
	}
	set, err := s.AnonymousFlashcards(ctx, cards.ID)
	if err != nil || len(set.Cards) != 1 {
		t.Fatalf("public flashcards = %+v, %v", set, err)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AnonymousQuiz(ctx, quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("suspended owner's quiz err = %v, want not found", err)
	}
}
