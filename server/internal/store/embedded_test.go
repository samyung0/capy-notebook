package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

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
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
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
	if _, err := s.CreateEmbeddedMaterial(ctx, ownerID, quiz.ID, EmbeddedDraft{Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`)}); !errors.Is(err, ErrNotFound) {
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

	// A save leaves an unreferenced row alone for its first minute (its block
	// may not have reached the note yet) and trashes it after, whether or not
	// a save ever referenced it; referencing it again restores it.
	onlyQuiz := noteWithRefs(t, quiz)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &onlyQuiz, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMaterial(ctx, cards.ID); err != nil {
		t.Fatalf("a new unreferenced row is kept for its first minute: %v", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET created_at=now()-interval '2 minutes'
		WHERE parent_material_id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &onlyQuiz, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMaterial(ctx, cards.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a never-referenced row over a minute old should be trashed, got %v", err)
	}
	// purgeIn is how long a trashed row of this note waits for the sweep.
	purgeIn := func(id string) time.Duration {
		t.Helper()
		var seconds float64
		if err := s.pool.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM purge_after-now()) FROM materials WHERE id=$1`, id).Scan(&seconds); err != nil {
			t.Fatal(err)
		}
		return time.Duration(seconds) * time.Second
	}
	if left := purgeIn(cards.ID); left < 23*time.Hour || left > 24*time.Hour {
		t.Fatalf("an unreferenced row is purged in %s, want a day", left)
	}
	content := noteWithRefs(t, quiz, cards)
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
		if left := purgeIn(id); left < 29*24*time.Hour {
			t.Fatalf("a row trashed with its note is purged in %s, want the note's 30 days", left)
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
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
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
		Kind: "quiz", Questions: json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`),
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

// A pasted quiz or flashcard block becomes the target note's own: its own row
// keeps its id unless the block asks for a copy, another readable note's row
// (live or trashed) is copied with its images and fresh card ids and charged
// to the target's payer, every duplicate block gets a copy of its own, and an
// unreadable or purged one is left out.
func TestAdoptEmbeddedMaterials(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	ownerID := newBlobTestUser(t, s, "u_adopt_embed_owner")
	editorID := newBlobTestUser(t, s, "u_adopt_embed_editor")
	viewerID := newBlobTestUser(t, s, "u_adopt_embed_viewer")
	strangerID := newBlobTestUser(t, s, "u_adopt_embed_stranger")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Target ws", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'editor'),($1,$3,'viewer')`, ws.ID, editorID, viewerID); err != nil {
		t.Fatal(err)
	}
	sourceWS, err := s.CreateWorkspace(ctx, editorID, WorkspaceCreate{Name: "Source ws", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	newNote := func(createdBy string, workspace Workspace, title string) Material {
		note, err := s.CreateMaterial(ctx, Material{
			CreatedBy: createdBy, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name,
			Kind: "note", Title: title, Content: "# " + title + "\n\nbody",
		})
		if err != nil {
			t.Fatal(err)
		}
		return note
	}
	embed := func(actorID, noteID string, draft EmbeddedDraft) Material {
		mt, err := s.CreateEmbeddedMaterial(ctx, actorID, noteID, draft)
		if err != nil {
			t.Fatal(err)
		}
		return mt
	}
	// What a save that dropped the reference does (trashEmbeddedRowTx).
	trash := func(id string) {
		if _, err := s.pool.Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id=$2,
			purge_after=now() + interval '30 days' WHERE id=$1`, id, uid("trash")); err != nil {
			t.Fatal(err)
		}
	}
	questions := json.RawMessage(`[{"id":"q1","stem":[],"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`)
	target := newNote(ownerID, ws, "Target")
	source := newNote(editorID, sourceWS, "Source")
	own := embed(ownerID, target.ID, EmbeddedDraft{Kind: "quiz", Questions: questions})
	quiz := embed(editorID, source.ID, EmbeddedDraft{Kind: "quiz", Questions: questions})
	image := f.ready(editorID, sourceWS.ID, quiz.ID)
	quizContent := quizWithImages(t, image.ID)
	if _, err := s.UpdateMaterial(ctx, quiz.ID, MaterialPatch{Content: &quizContent, UpdatedBy: editorID}); err != nil {
		t.Fatal(err)
	}
	cards := embed(editorID, source.ID, EmbeddedDraft{Kind: "flashcards", Cards: [][2]string{{"front", "back"}}})
	cardImage := f.ready(editorID, sourceWS.ID, cards.ID)
	setCards(t, s, editorID, cards.ID, func(c []materialdoc.Card) []materialdoc.Card {
		c[0].Image = &materialdoc.CardImage{AssetID: cardImage.ID}
		return c
	})
	cut := embed(editorID, source.ID, EmbeddedDraft{Kind: "quiz", Questions: questions})
	trash(cut.ID)
	foreignNote, err := s.CreateMaterial(ctx, Material{CreatedBy: strangerID, Kind: "note", Title: "Foreign", Content: "# Foreign\n\nbody"})
	if err != nil {
		t.Fatal(err)
	}
	foreign := embed(strangerID, foreignNote.ID, EmbeddedDraft{Kind: "quiz", Questions: questions})

	usedBefore, editorBefore := f.used(ownerID), f.used(editorID)
	blocks := func(ids ...string) []EmbeddedAdoption {
		out := make([]EmbeddedAdoption, len(ids))
		for i, id := range ids {
			out[i] = EmbeddedAdoption{SourceID: id}
		}
		return out
	}
	list, refused, err := s.AdoptEmbeddedMaterials(ctx, editorID, target.ID,
		blocks(own.ID, quiz.ID, cards.ID, cut.ID, foreign.ID, "mat_purged"))
	if err != nil || refused {
		t.Fatal(err, refused)
	}
	adopted := map[string]string{}
	for i, id := range []string{own.ID, quiz.ID, cards.ID, cut.ID, foreign.ID, "mat_purged"} {
		adopted[id] = list[i]
	}
	if adopted[own.ID] != own.ID || adopted[foreign.ID] != "" || adopted["mat_purged"] != "" {
		t.Fatalf("adopted = %v, want the own row, three copies and no foreign row", adopted)
	}
	for _, id := range []string{quiz.ID, cards.ID, cut.ID} {
		copied, err := s.GetMaterial(ctx, adopted[id])
		if err != nil || adopted[id] == id {
			t.Fatalf("copy of %s = %q, %v", id, adopted[id], err)
		}
		if copied.ParentMaterialID != target.ID || copied.WorkspaceID != ws.ID || copied.OwnerUserID != ownerID {
			t.Fatalf("copy = %+v", copied)
		}
	}
	quizCopy, err := s.GetMaterial(ctx, adopted[quiz.ID])
	if err != nil {
		t.Fatal(err)
	}
	// "Target · Quiz" is the note's own quiz, so the copy gets a number.
	if !strings.HasPrefix(quizCopy.Title, "Target · Quiz ") {
		t.Fatalf("copy title = %q", quizCopy.Title)
	}
	assetIDs, err := materialdoc.EditorAssetIDs(quizCopy.Content)
	if err != nil || len(assetIDs) != 1 || assetIDs[0] == image.ID {
		t.Fatalf("copy image ids = %v, %v; want one rewritten id", assetIDs, err)
	}
	copiedImage, err := s.GetEditorAsset(ctx, assetIDs[0])
	if err != nil {
		t.Fatal(err)
	}
	if copiedImage.MaterialID != quizCopy.ID || copiedImage.WorkspaceID != ws.ID ||
		copiedImage.UserID != ownerID || copiedImage.ObjectPath != image.ObjectPath || copiedImage.Status != "ready" {
		t.Fatalf("copied image = %+v", copiedImage)
	}
	sourceCards, err := s.ListCards(ctx, cards.ID)
	if err != nil {
		t.Fatal(err)
	}
	copiedCards, err := s.ListCards(ctx, adopted[cards.ID])
	if err != nil {
		t.Fatal(err)
	}
	if len(copiedCards) != 1 || copiedCards[0].ID == sourceCards[0].ID {
		t.Fatalf("copied cards = %+v, want one card under a new id", copiedCards)
	}
	if copiedCards[0].Image == nil || copiedCards[0].Image.AssetID == cardImage.ID {
		t.Fatalf("copied card image = %+v, want its own copy", copiedCards[0].Image)
	}
	if f.used(ownerID) <= usedBefore+100 || f.used(editorID) != editorBefore {
		t.Fatalf("charged owner %d, editor %d; want the target's payer charged",
			f.used(ownerID)-usedBefore, f.used(editorID)-editorBefore)
	}

	// The same quiz in several blocks: each block asking for a copy gets its
	// own, the note's own row included, and one not asking keeps it.
	twice, _, err := s.AdoptEmbeddedMaterials(ctx, editorID, target.ID, []EmbeddedAdoption{
		{SourceID: own.ID}, {SourceID: own.ID, Copy: true}, {SourceID: own.ID, Copy: true},
		{SourceID: quiz.ID}, {SourceID: quiz.ID, Copy: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if twice[0] != own.ID || len(map[string]bool{
		own.ID: true, twice[1]: true, twice[2]: true, quiz.ID: true, twice[3]: true, twice[4]: true,
	}) != 6 {
		t.Fatalf("duplicate blocks = %v, want the own id then four distinct copies", twice)
	}
	ownCopy, err := s.GetMaterial(ctx, twice[1])
	if err != nil || ownCopy.ParentMaterialID != target.ID || ownCopy.Kind != "quiz" {
		t.Fatalf("own row copy = %+v, %v", ownCopy, err)
	}

	// The note's own trashed row keeps its id and leaves the trash at once,
	// unless the block asks for a copy.
	trash(own.ID)
	trashed, _, err := s.AdoptEmbeddedMaterials(ctx, editorID, target.ID,
		[]EmbeddedAdoption{{SourceID: own.ID}, {SourceID: own.ID, Copy: true}})
	if err != nil || trashed[0] != own.ID || trashed[1] == "" || trashed[1] == own.ID {
		t.Fatalf("trashed own row = %v, %v", trashed, err)
	}
	if _, err := s.GetMaterial(ctx, own.ID); err != nil {
		t.Fatalf("own row after its block came back: %v", err)
	}

	if _, _, err := s.AdoptEmbeddedMaterials(ctx, viewerID, target.ID, blocks(quiz.ID)); err == nil {
		t.Fatal("a viewer adopted into the note")
	}
	limit := mustPlanLimits(t, s, PlanFree).StorageBytes
	if _, err := s.pool.Exec(ctx, `UPDATE user_storage SET used_bytes=$2 WHERE user_id=$1`, ownerID, limit); err != nil {
		t.Fatal(err)
	}
	// Over the quota the copy is left out and the call says so; the own row
	// still answers.
	if list, refused, err := s.AdoptEmbeddedMaterials(ctx, editorID, target.ID, blocks(own.ID, quiz.ID)); err != nil || !refused ||
		list[0] != own.ID || list[1] != "" {
		t.Fatalf("adopt over quota = %v refused %v, %v", list, refused, err)
	}
}
