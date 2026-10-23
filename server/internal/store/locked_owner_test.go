package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/planlimits"
)

// lockOwner puts an account in a locked lifecycle state.
func lockOwner(t *testing.T, s *Store, userID, state string) {
	t.Helper()
	lock := `UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=$1`
	if state == "suspended" {
		lock = `UPDATE users SET suspended_at=now(), suspended_reason='test suspension' WHERE id=$1`
	}
	if _, err := s.pool.Exec(context.Background(), lock, userID); err != nil {
		t.Fatal(err)
	}
}

// A suspended owner's public workspace and its content answer not found to a
// member, as a deletion-pending owner's do (Epo 2026-10-16): the workspace,
// the lists (workspaces, search, member-scope files and materials, Explore),
// the note read the room token mint takes, chat (whose lock comes before its
// role read), comments and copying the owner's editor assets. The owner keeps
// the locked-account answer. Security regression: fails if any of these
// admits the member, lists the content or answers the owner's account state.
func TestLockedOwnerHidesWorkspaceContentFromMembers(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	f := editorAssetFixture{t: t, s: s, ctx: ctx}
	rich := json.RawMessage(`[{"type":"p","children":[{"text":"hello"}]}]`)
	for _, state := range []string{"suspended", "deletion_pending"} {
		t.Run(state, func(t *testing.T) {
			f.t = t
			owner := newBlobTestUser(t, s, "u_hidden_owner")
			member := newBlobTestUser(t, s, "u_hidden_member")
			ws, err := s.CreateWorkspace(ctx, owner, WorkspaceCreate{Name: "Hidden workspace", Tags: []TagRef{}})
			if err != nil {
				t.Fatal(err)
			}
			addWorkspaceEditor(t, s, ws.ID, member)
			if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, ws.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.createReadyFile(ctx, ws.ID, owner, "lesson.pdf", "pdf", nil, "", 100, "sources/"+uid("base")); err != nil {
				t.Fatal(err)
			}
			note, err := s.CreateMaterial(ctx, Material{
				CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name,
				Kind: "note", Title: "Hidden note", Content: noteWithImages(t),
			})
			if err != nil {
				t.Fatal(err)
			}
			asset := f.ready(owner, ws.ID, note.ID)
			quiz, err := s.CreateMaterial(ctx, Material{
				CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name,
				Kind: "quiz", Title: "Hidden quiz", Content: quizWithImages(t),
			})
			if err != nil {
				t.Fatal(err)
			}
			deck, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{ID: uid("card"), Front: "A", Back: "B"}})
			if err != nil {
				t.Fatal(err)
			}
			cards, err := s.CreateMaterial(ctx, Material{
				CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name,
				Kind: "flashcards", Title: "Hidden cards", Content: deck,
			})
			if err != nil {
				t.Fatal(err)
			}
			discussion, err := s.CreateCommentDiscussion(ctx, note.ID, member, nil, nil, nil, 1, "", rich)
			if err != nil {
				t.Fatal(err)
			}
			own, err := s.CreateWorkspace(ctx, member, WorkspaceCreate{Name: "Member workspace", Tags: []TagRef{}})
			if err != nil {
				t.Fatal(err)
			}
			ownNote, err := s.CreateMaterial(ctx, Material{
				CreatedBy: member, WorkspaceID: own.ID, WorkspaceName: own.Name,
				Kind: "note", Title: "Member note", Content: noteWithImages(t),
			})
			if err != nil {
				t.Fatal(err)
			}
			lockOwner(t, s, owner, state)

			if _, err := s.WorkspaceAccess(ctx, member, ws.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("workspace read = %v, want not found", err)
			}
			listed, err := s.ListWorkspaces(ctx, member, "", "", "")
			if err != nil || slices.ContainsFunc(listed, func(w Workspace) bool { return w.ID == ws.ID }) {
				t.Fatalf("workspace list = %v (%v), want the workspace left out", listed, err)
			}
			found, err := s.Search(ctx, member, "hidden")
			if err != nil || slices.ContainsFunc(found, func(r SearchResult) bool { return r.ID == ws.ID || r.ID == cards.ID }) {
				t.Fatalf("search = %v (%v), want the workspace and its flashcards left out", found, err)
			}
			files, err := s.ListOwnedFiles(ctx, member, FileListFilter{Member: true})
			if err != nil || len(files.Items) != 0 {
				t.Fatalf("member files = %v (%v), want none", files.Items, err)
			}
			materials, err := s.ListOwnedMaterials(ctx, member, MaterialListFilter{Member: true})
			if err != nil || slices.ContainsFunc(materials.Items, func(m MaterialListItem) bool { return m.WorkspaceID == ws.ID }) {
				t.Fatalf("member materials = %v (%v), want the owner's left out", materials.Items, err)
			}
			exploreWorkspaces, _, err := s.ListPublicWorkspaces(ctx, member, "")
			if err != nil || slices.ContainsFunc(exploreWorkspaces, func(w PublicWorkspace) bool { return w.ID == ws.ID }) {
				t.Fatalf("explore workspaces = %v (%v), want the workspace left out", exploreWorkspaces, err)
			}
			exploreQuizzes, _, err := s.ListPublicQuizzes(ctx, member, "")
			if err != nil || slices.ContainsFunc(exploreQuizzes, func(q PublicQuiz) bool { return q.ID == quiz.ID }) {
				t.Fatalf("explore quizzes = %v (%v), want the quiz left out", exploreQuizzes, err)
			}
			exploreCards, _, err := s.ListPublicFlashcardSets(ctx, member, "")
			if err != nil || slices.ContainsFunc(exploreCards, func(c PublicFlashcardSet) bool { return c.ID == cards.ID }) {
				t.Fatalf("explore flashcards = %v (%v), want the set left out", exploreCards, err)
			}
			if _, err := s.MaterialEffectiveRole(ctx, member, note.ID); !errors.Is(err, ErrNotFound) {
				t.Fatalf("note read = %v, want not found", err)
			}
			if _, err := s.CreateConversation(ctx, member, ws.ID, ""); !errors.Is(err, ErrNotFound) {
				t.Fatalf("member chat = %v, want not found", err)
			}
			if _, err := s.AddComment(ctx, discussion.ID, member, rich); !errors.Is(err, ErrNotFound) {
				t.Fatalf("member comment = %v, want not found", err)
			}
			roomy := planlimits.Limits{ImageBytes: 2 << 20, SourceFileBytes: 10 << 20}
			if adopted, _, err := s.AdoptEditorAssets(ctx, member, own.ID, ownNote.ID, []string{asset.ID}, roomy); err != nil || adopted[asset.ID] != "" {
				t.Fatalf("copying the owner's asset = %v (%v), want it left out", adopted, err)
			}

			var locked *AccountLockedError
			if _, err := s.CreateConversation(ctx, owner, ws.ID, ""); !errors.As(err, &locked) || string(locked.State) != state {
				t.Fatalf("owner chat = %v, want the owner's %s account", err, state)
			}
		})
	}
}

// A suspended or deletion-pending owner's source rooms are evicted with
// discard, as their note rooms are, so a viewer holding one open reconnects
// through the access check and gets not found (Epo 2026-10-16, migration
// 0090). Security regression: fails if the lifecycle trigger leaves them open.
func TestLockedOwnerEvictsTheirSourceRooms(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	for _, state := range []string{"suspended", "deletion_pending"} {
		t.Run(state, func(t *testing.T) {
			owner := newBlobTestUser(t, s, "u_evict_source_owner")
			_, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
			doc := sourceTestSeed(t, s, owner, file.ID)
			room := fmt.Sprintf("source:%s:epoch:%d", file.ID, doc.Epoch)
			if _, err := s.pool.Exec(ctx, `DELETE FROM collaboration_eviction_outbox WHERE payload->>'room'=$1`, room); err != nil {
				t.Fatal(err)
			}
			lockOwner(t, s, owner, state)
			var mode string
			if err := s.pool.QueryRow(ctx, `SELECT payload->>'mode' FROM collaboration_eviction_outbox
				WHERE channel='capy:collaboration:evict' AND payload->>'room'=$1`, room).Scan(&mode); err != nil || mode != "discard" {
				t.Fatalf("source room eviction = %q (%v), want discard", mode, err)
			}
		})
	}
}
