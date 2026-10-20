package store

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// TestUserDeleteCascadeTakesEverythingItPaysFor pins the FK layout: a hard
// DELETE of a user is never blocked and takes everything charged to that
// user's storage quota with it, including what it created in another user's
// workspace (uploader pays, Sam 2026-10-18), while that workspace survives.
//
// Application logic never hard-deletes a user — deletion is a soft flag plus a
// PII scrub — so this exercises the schema's fallback behaviour directly.
func TestUserDeleteCascadeTakesEverythingItPaysFor(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	leaverID := uid("u_leaver")
	hostID := uid("u_host")
	for _, id := range []string{leaverID, hostID} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
			VALUES ($1, 'Cascade Test', $2)`, id, fmt.Sprintf("%s@example.test", id)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`,
			[]string{leaverID, hostID})
	})

	// The leaver's own workspace, with a file and a tagged material in it.
	ownWS, err := s.CreateWorkspace(ctx, leaverID, WorkspaceCreate{Name: "Leaver workspace", Tags: []TagRef{{Value: "cascade-tag"}}})
	if err != nil {
		t.Fatal(err)
	}
	ownFile, err := s.createReadyFile(ctx, ownWS.ID, leaverID, "own.md", "md", nil, "", 10, "sources/own")
	if err != nil {
		t.Fatal(err)
	}
	ownMaterial, err := s.CreateMaterial(ctx, Material{
		CreatedBy: leaverID, WorkspaceID: ownWS.ID, Kind: "note", Title: "Own note", Content: materialTestContent(t, ""),
	})
	if err != nil {
		t.Fatal(err)
	}

	// A material the leaver authored inside the host's workspace, charged to
	// the leaver.
	hostWS, err := s.CreateWorkspace(ctx, hostID, WorkspaceCreate{Name: "Host workspace", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	addWorkspaceEditor(t, s, hostWS.ID, leaverID)
	guestContent, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{
		ID: uid("c"), Front: "front", Back: "back",
	}})
	if err != nil {
		t.Fatal(err)
	}
	guestMaterial, err := s.CreateMaterial(ctx, Material{
		CreatedBy: leaverID, WorkspaceID: hostWS.ID, Kind: "flashcards",
		Title: "Guest flashcardSet", Content: guestContent,
	})
	if err != nil {
		t.Fatal(err)
	}
	if guestMaterial.OwnerUserID != leaverID {
		t.Fatalf("guest material payer = %q, want its author %q",
			guestMaterial.OwnerUserID, leaverID)
	}

	if _, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, leaverID); err != nil {
		t.Fatalf("hard delete of a user must never be blocked: %v", err)
	}

	for _, tc := range []struct {
		what  string
		query string
		arg   string
		want  int
	}{
		{"workspace", `SELECT count(*) FROM workspaces WHERE id=$1`, ownWS.ID, 0},
		{"file", `SELECT count(*) FROM files WHERE id=$1`, ownFile.ID, 0},
		{"own material", `SELECT count(*) FROM materials WHERE id=$1`, ownMaterial.ID, 0},
		{"tag catalog", `SELECT count(*) FROM tags WHERE user_id=$1`, leaverID, 0},
		{"entity tag link", `SELECT count(*) FROM entity_tags WHERE workspace_id=$1`, ownWS.ID, 0},
		{"host workspace", `SELECT count(*) FROM workspaces WHERE id=$1`, hostWS.ID, 1},
		{"guest material", `SELECT count(*) FROM materials WHERE id=$1`, guestMaterial.ID, 0},
	} {
		var got int
		if err := s.pool.QueryRow(ctx, tc.query, tc.arg).Scan(&got); err != nil {
			t.Fatalf("%s: %v", tc.what, err)
		}
		if got != tc.want {
			t.Errorf("%s rows = %d, want %d", tc.what, got, tc.want)
		}
	}

}

// TestChapterReferencesCannotCrossWorkspaces pins the composite chapter foreign
// key. Without it a file can be filed under a chapter belonging to a different
// workspace, which renders as a tree that silently loses the file.
func TestChapterReferencesCannotCrossWorkspaces(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	ownerID := uid("u_chapter")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1, 'Chapter Test', $2)`, ownerID, fmt.Sprintf("%s@example.test", ownerID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID)
	})

	first, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "First", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Second", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	foreignChapter, err := s.AddChapter(ctx, second.ID, ownerID, "Elsewhere")
	if err != nil {
		t.Fatal(err)
	}

	_, err = s.pool.Exec(ctx, `INSERT INTO files (id, workspace_id, user_id, chapter_id, name, kind)
		VALUES ($1,$2,$3,$4,'cross.md','md')`,
		uid("f"), first.ID, ownerID, foreignChapter.ID)
	if err == nil {
		t.Fatal("a file was filed under a chapter from another workspace")
	}
}

func TestAddChapterStopsAtTheWorkspaceLimit(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	ownerID := uid("u_chapter")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users (id, name, email)
		VALUES ($1, 'Chapter Test', $2)`, ownerID, fmt.Sprintf("%s@example.test", ownerID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, ownerID)
	})
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Full", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	for n := range MaxChaptersPerWorkspace {
		if _, err := s.AddChapter(ctx, ws.ID, ownerID, fmt.Sprintf("Chapter %d", n+1)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddChapter(ctx, ws.ID, ownerID, "One too many"); !errors.Is(err, ErrTooManyChapters) {
		t.Fatalf("chapter past the limit: err = %v, want ErrTooManyChapters", err)
	}
}
