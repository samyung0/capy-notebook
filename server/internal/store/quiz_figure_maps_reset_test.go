package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/migrations"
)

// Migration 0178, the quiz figure maps reset: every quiz drops its Yjs rows
// (its keys row with them) and moves its room past the old one; a note and a
// flashcard set keep theirs; a lagging quiz projection refuses. Each run
// rolls back.
func TestQuizFigureMapsResetMigration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "quiz_figure_reset")
	quizContent, err := materialdoc.QuizDocument(json.RawMessage(`[{"id":"q1","stem":[{"type":"text","text":"Why?"}],
		"parts":[{"id":"q1-a","blocks":[{"type":"text","text":"Explain."}],"answer":{"type":"open","accepted":["Because."]},"marks":1,"markscheme":[{"text":"States why","marks":1}],"solution":[]}],
		"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	cardsContent, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{ID: uid("c"), Front: "front", Back: "back"}})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "quiz", Title: "Quiz", Content: quizContent})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "note", Title: "Note", Content: materialTestContent(t, "text")})
	if err != nil {
		t.Fatal(err)
	}
	cards, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "flashcards", Title: "Cards", Content: cardsContent})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO material_yjs_documents (material_id,room_schema,state,stored_version,projected_version) VALUES
			('` + quiz.ID + `',2,'\x00',3,3),('` + note.ID + `',2,'\x00',3,3),('` + cards.ID + `',2,'\x00',3,3)`,
		`INSERT INTO material_yjs_keys (material_id,state) VALUES ('` + quiz.ID + `','\x00')`,
	} {
		if _, err = s.pool.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	reset, err := migrations.FS.ReadFile("0178_quiz_figure_maps.sql")
	if err != nil {
		t.Fatal(err)
	}
	run := func(steps ...string) (func(string, string) int64, error) {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
		// Other tests' rows (other packages share the database) count as
		// projected.
		for _, q := range append([]string{`UPDATE material_yjs_documents SET projected_version=stored_version WHERE material_id<>'` + quiz.ID + `'`}, steps...) {
			if _, err = tx.Exec(ctx, q); err != nil {
				t.Fatal(q, err)
			}
		}
		if _, err = tx.Exec(ctx, string(reset)); err != nil {
			_ = tx.Rollback(ctx)
			return nil, err
		}
		return func(query, id string) int64 {
			var n int64
			if err := tx.QueryRow(ctx, query, id).Scan(&n); err != nil {
				t.Fatal(err)
			}
			return n
		}, nil
	}

	lagging := `UPDATE material_yjs_documents SET stored_version=4 WHERE material_id='` + quiz.ID + `'`
	if _, err = run(lagging); err == nil || !strings.Contains(err.Error(), "projection is behind") {
		t.Fatalf("reset over a lagging projection: %v", err)
	}

	read, err := run()
	if err != nil {
		t.Fatal(err)
	}
	rows := `SELECT count(*) FROM material_yjs_documents WHERE material_id=$1`
	keys := `SELECT count(*) FROM material_yjs_keys WHERE material_id=$1`
	restores := `SELECT trash_restores FROM materials WHERE id=$1`
	if n := read(rows, quiz.ID) + read(keys, quiz.ID); n != 0 {
		t.Fatalf("the quiz kept %d Yjs rows", n)
	}
	if n := read(restores, quiz.ID); n != 2 {
		t.Fatalf("the quiz's next room is %d, want past room 2", n+1)
	}
	for name, id := range map[string]string{"note": note.ID, "flashcard set": cards.ID} {
		if n := read(rows, id); n != 1 {
			t.Fatalf("the %s has %d Yjs rows, want its room kept", name, n)
		}
		if n := read(restores, id); n != 0 {
			t.Fatalf("the %s's trash_restores is %d, want it untouched", name, n)
		}
	}
}
