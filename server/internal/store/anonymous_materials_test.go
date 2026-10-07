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
		"parts":[{"id":"q1-a","blocks":[{"type":"text","text":"Explain."}],"answer":{"type":"open","accepted":["Because."],"hints":[]},"marks":1,"markscheme":[{"text":"States why","marks":1}],"solution":[]}],
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
	// The set starts with one blank card, which visitors never receive.
	appendCard(t, s, ownerID, cards.ID, "Front", "Back")
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='public' WHERE id=$1`, cards.ID); err != nil {
		t.Fatal(err)
	}
	set, err := s.AnonymousFlashcards(ctx, cards.ID)
	if err != nil || len(set.Cards) != 1 || set.Cards[0].Front != "Front" {
		t.Fatalf("public flashcards = %+v, %v", set, err)
	}
	// A visitor reads only the images of the cards they study.
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	shown, hidden := f.ready(ownerID, "", cards.ID), f.ready(ownerID, "", cards.ID)
	setCards(t, s, ownerID, cards.ID, func(c []materialdoc.Card) []materialdoc.Card {
		for i := range c {
			if c[i].Front == "Front" {
				c[i].Image = &materialdoc.CardImage{AssetID: shown.ID}
			} else {
				c[i].Image = &materialdoc.CardImage{AssetID: hidden.ID}
			}
		}
		return c
	})
	if path, _, err := s.AnonymousFlashcardAssetPath(ctx, cards.ID, shown.ID); err != nil || path != shown.ObjectPath {
		t.Fatalf("studied card image = %q, %v", path, err)
	}
	if _, _, err := s.AnonymousFlashcardAssetPath(ctx, cards.ID, hidden.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("blank card's image err = %v, want not found", err)
	}

	if _, err := s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(), suspended_reason='test' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AnonymousQuiz(ctx, quiz.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("suspended owner's quiz err = %v, want not found", err)
	}
}

// A link note reads with its owner's name and avatar, and its link reaches only
// the images the note shows.
func TestAnonymousNoteAuthorAndAssets(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_anon_note_owner")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET name='Mrs Lee', avatar_icon_id='avataaars-05' WHERE id=$1`, ownerID); err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, Kind: "note", Title: "Shared note", Content: noteWithImages(t)})
	if err != nil {
		t.Fatal(err)
	}
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	shown, hidden := f.ready(ownerID, "", note.ID), f.ready(ownerID, "", note.ID)
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET content=$2::jsonb WHERE id=$1`, note.ID, noteWithImages(t, shown.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AnonymousNote(ctx, note.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private note err = %v, want not found", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='link' WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.AnonymousNote(ctx, note.ID)
	if err != nil || got.Name != "Shared note" || !json.Valid(got.Content) {
		t.Fatalf("link note = %+v, %v", got, err)
	}
	if got.Author != (MaterialAuthor{Name: "Mrs Lee", AvatarURL: "/icons/avataaars-05.svg"}) {
		t.Fatalf("author = %+v", got.Author)
	}
	if path, _, err := s.AnonymousNoteAssetPath(ctx, note.ID, shown.ID); err != nil || path != shown.ObjectPath {
		t.Fatalf("shown image = %q, %v", path, err)
	}
	if _, _, err := s.AnonymousNoteAssetPath(ctx, note.ID, hidden.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unshown image err = %v, want not found", err)
	}
}

// A visible note carries the quizzes and flashcard sets its content references
// and owns, in reference order; its link reaches their images and grades only
// those quizzes. An unreferenced or trashed row is left out.
func TestAnonymousNoteEmbeds(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	ownerID := newBlobTestUser(t, s, "u_anon_embed_owner")
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: ownerID, Kind: "note", Title: "Embeds", Content: "# Embeds\n\nbody"})
	if err != nil {
		t.Fatal(err)
	}
	embed := func(draft EmbeddedDraft) Material {
		mt, err := s.CreateEmbeddedMaterial(ctx, ownerID, note.ID, draft)
		if err != nil {
			t.Fatal(err)
		}
		return mt
	}
	quiz := embed(EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(`[]`)})
	quizImage := f.ready(ownerID, "", quiz.ID)
	quizContent := quizWithImages(t, quizImage.ID)
	if _, err := s.UpdateMaterial(ctx, quiz.ID, MaterialPatch{Content: &quizContent, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	cards := embed(EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}, {"", ""}}})
	cardImage := f.ready(ownerID, "", cards.ID)
	setCards(t, s, ownerID, cards.ID, func(c []materialdoc.Card) []materialdoc.Card {
		c[0].Image = &materialdoc.CardImage{AssetID: cardImage.ID}
		return c
	})
	trashed := embed(EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"gone", "gone"}}})
	unreferenced := embed(EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(`[]`)})
	strayImage := f.ready(ownerID, "", unreferenced.ID)
	strayContent := quizWithImages(t, strayImage.ID)
	if _, err := s.UpdateMaterial(ctx, unreferenced.ID, MaterialPatch{Content: &strayContent, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	content := noteWithRefs(t, cards, quiz, trashed, cards)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id=$2,
		purge_after=now() + interval '1 day' WHERE id=$1`, trashed.ID, uid("trash")); err != nil {
		t.Fatal(err)
	}

	if _, err := s.AnonymousNote(ctx, note.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private note err = %v, want not found", err)
	}
	if _, _, err := s.AnonymousNoteAssetPath(ctx, note.ID, quizImage.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("private note's quiz image err = %v, want not found", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET privacy='link' WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	got, err := s.AnonymousNote(ctx, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Embeds) != 2 || got.Embeds[0].ID != cards.ID || got.Embeds[1].ID != quiz.ID ||
		len(got.Embeds[0].Cards) != 1 || got.Embeds[0].Cards[0].Front != "front" || got.Embeds[0].Questions != nil ||
		got.Embeds[1].Kind != "quiz" || got.Embeds[1].Cards != nil {
		t.Fatalf("embeds = %+v", got.Embeds)
	}

	for _, asset := range []EditorAsset{quizImage, cardImage} {
		if path, _, err := s.AnonymousNoteAssetPath(ctx, note.ID, asset.ID); err != nil || path != asset.ObjectPath {
			t.Fatalf("embedded image %s = %q, %v", asset.ID, path, err)
		}
	}
	if _, _, err := s.AnonymousNoteAssetPath(ctx, note.ID, strayImage.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unreferenced quiz's image err = %v, want not found", err)
	}
	if qs, err := s.AnonymousNoteQuiz(ctx, note.ID, quiz.ID); err != nil || !json.Valid(qs) {
		t.Fatalf("note quiz = %s, %v", qs, err)
	}
	for _, id := range []string{unreferenced.ID, cards.ID} {
		if _, err := s.AnonymousNoteQuiz(ctx, note.ID, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("note quiz %s err = %v, want not found", id, err)
		}
	}
}
