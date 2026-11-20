package store

import (
	"context"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/migrations"
)

// Migration 0179, the note figure maps reset: a note whose saved content holds
// a chart, plot or graph drops its Yjs rows and moves its room past the old
// one; a note without a figure keeps its room; a lagging projection refuses.
// Each run rolls back.
func TestNoteFigureMapsResetMigration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "note_figure_reset")
	figure, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "note", Title: "Figure", Content: materialTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "note", Title: "Plain", Content: materialTestContent(t, "text")})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`UPDATE materials SET content='{"schemaVersion":1,"value":[{"type":"graph","id":"g1","children":[{"text":""}],` +
			`"block":{"type":"graph","width":320,"height":190,"board":{"bbox":[-5,5,5,-5],"axis":true,"grid":true},"elements":[]}}]}' WHERE id='` + figure.ID + `'`,
		`INSERT INTO material_yjs_documents (material_id,room_schema,state,stored_version,projected_version) VALUES
			('` + figure.ID + `',2,'\x00',3,3),('` + plain.ID + `',2,'\x00',3,3)`,
	} {
		if _, err = s.pool.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	reset, err := migrations.FS.ReadFile("0179_note_figure_maps.sql")
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
		for _, q := range append([]string{`UPDATE material_yjs_documents SET projected_version=stored_version WHERE material_id<>'` + figure.ID + `'`}, steps...) {
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

	lagging := `UPDATE material_yjs_documents SET stored_version=4 WHERE material_id='` + figure.ID + `'`
	if _, err = run(lagging); err == nil || !strings.Contains(err.Error(), "projection behind") {
		t.Fatalf("reset over a lagging projection: %v", err)
	}

	read, err := run()
	if err != nil {
		t.Fatal(err)
	}
	rows := `SELECT count(*) FROM material_yjs_documents WHERE material_id=$1`
	restores := `SELECT trash_restores FROM materials WHERE id=$1`
	if n := read(rows, figure.ID); n != 0 {
		t.Fatalf("the figure note kept %d Yjs rows", n)
	}
	if n := read(restores, figure.ID); n != 2 {
		t.Fatalf("the figure note's next room is %d, want past room 2", n+1)
	}
	if n := read(rows, plain.ID); n != 1 {
		t.Fatalf("the plain note has %d Yjs rows, want its room kept", n)
	}
}
