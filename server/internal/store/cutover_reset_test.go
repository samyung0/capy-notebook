package store

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/migrations"
)

// Migration 0080, the Rust cutover reset: it refuses while a source (Office
// or text) has unpublished edits or effects, a refresh in flight or a rebuild
// pending, while Office editing is not paused or while a note's projection
// lags (trashed or not); otherwise every source drops its state and rows under
// a new epoch, every note, mindmap and diagram drops its Yjs rows and moves its
// room past the old one, pending references become empty paragraphs in place,
// live items stay, and the storage recount equals what the triggers booked.
// Each run rolls back.
func TestCutoverResetMigration(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "cutover_reset")
	office := maintenanceTestEdited(t, s, owner, "lesson.docx", false)
	_, textFile := sourceTestFile(t, s, owner, "notes.txt", "txt")
	sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, textFile.ID), "text-edit")
	text := textFile.ID

	note, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "note", Title: "Cutover", Content: materialTestContent(t, "")})
	if err != nil {
		t.Fatal(err)
	}
	mindmap, diagram := uid("mat"), uid("mat")
	quiz, err := s.CreateMaterial(ctx, Material{CreatedBy: owner, Kind: "quiz", Title: "Live quiz",
		Content: quizProjection(t, 1, 1, 10, "a").Raw, Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		// A note stored before fences were resolved: its pending reference
		// holds the quiz's answer keys.
		`UPDATE materials SET content='{"schemaVersion":1,"value":[{"type":"p","id":"b1","children":[{"text":"kept"}]},` +
			`{"type":"material_ref","id":"r1","refKind":"quiz","pending":"answer: SECRET","children":[{"text":""}]},` +
			`{"type":"p","id":"b2","children":[{"text":"after"}]}]}' WHERE id='` + note.ID + `'`,
		`INSERT INTO material_yjs_documents (material_id,room_schema,state,stored_version,projected_version,log_bytes,log_rows)
			VALUES ('` + note.ID + `',2,'\x0000',3,3,2,1)`,
		`INSERT INTO material_yjs_updates (material_id,seq,update) VALUES ('` + note.ID + `',3,'\x0102')`,
		`INSERT INTO material_yjs_documents (material_id,state,stored_version,projected_version) VALUES ('` + quiz.ID + `','\x00',1,1)`,
		`INSERT INTO material_yjs_keys (material_id,state) VALUES ('` + quiz.ID + `','\x00')`,
		// Mindmaps and diagrams are Plate rooms too.
		`INSERT INTO materials (id,created_by,kind,title) VALUES ('` + mindmap + `','` + owner + `','mindmap','Map'),('` + diagram + `','` + owner + `','diagram','Flow')`,
		`INSERT INTO material_yjs_documents (material_id,room_schema,state,stored_version,projected_version) VALUES
			('` + mindmap + `',3,'\x00',2,2),('` + diagram + `',1,'\x00',1,1)`,
	} {
		if _, err = s.pool.Exec(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	reset, err := migrations.FS.ReadFile("0080_cutover_reset.sql")
	if err != nil {
		t.Fatal(err)
	}
	var revisionBefore int64
	if err = s.pool.QueryRow(ctx, `SELECT revision FROM materials WHERE id=$1`, note.ID).Scan(&revisionBefore); err != nil {
		t.Fatal(err)
	}

	run := func(steps ...string) (pgx.Tx, error) {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
		for _, q := range append([]string{
			// Other tests' rows (other packages share the database) count as
			// published and projected; the lock keeps new ones out.
			`LOCK TABLE source_documents, material_yjs_documents IN SHARE ROW EXCLUSIVE MODE`,
			`UPDATE source_documents SET indexed_checkpoint=checkpoint,pending_effects='[]',running_job_id=NULL,rebuild_pending=false,
				rebuild_refusal=NULL,published_state=NULL,published_state_seed_sha256=NULL WHERE file_id NOT IN ('` + office + `','` + text + `')`,
			`UPDATE material_yjs_documents SET projected_version=stored_version WHERE material_id<>'` + note.ID + `'`,
			// 0100 dropped the AI edit Undo table this body still releases.
			`CREATE TEMP TABLE agent_edit_inverses (resource_kind text, resource_id text, undo_status text, undo_reason text,
				inverse jsonb, guards jsonb, inverse_bytes bigint, updated_at timestamptz) ON COMMIT DROP`,
		}, steps...) {
			if _, err = tx.Exec(ctx, q); err != nil {
				t.Fatal(q, err)
			}
		}
		if _, err = tx.Exec(ctx, string(reset)); err != nil {
			_ = tx.Rollback(ctx) // release the locks for the next run
		}
		return tx, err
	}
	publishedOffice := `UPDATE source_documents SET indexed_checkpoint=checkpoint,pending_effects='[]' WHERE file_id='` + office + `'`
	publishedText := `UPDATE source_documents SET indexed_checkpoint=checkpoint,pending_effects='[]' WHERE file_id='` + text + `'`
	paused := `INSERT INTO office_editing_pause DEFAULT VALUES ON CONFLICT DO NOTHING`
	lagging := `UPDATE material_yjs_documents SET stored_version=4 WHERE material_id='` + note.ID + `'`
	trashed := `UPDATE materials SET trashed_at=now(),trash_episode_id='ep_cutover',purge_after=now()+interval '30 days' WHERE id='` + note.ID + `'`
	officeEffects := `UPDATE source_documents SET pending_effects='[{"type":"text","before":"a","after":"b"}]' WHERE file_id='` + office + `'`
	job := `INSERT INTO jobs (id,type,status) VALUES ('job_` + office + `','source_refresh','running')`
	refreshing := `UPDATE source_documents SET running_job_id='job_` + office + `' WHERE file_id='` + office + `'`
	rebuilding := `UPDATE source_documents SET rebuild_pending=true WHERE file_id='` + office + `'`
	for _, refusal := range []struct {
		steps []string
		want  string
	}{
		{[]string{publishedText, paused}, "unpublished edits"},
		// publish-all never publishes a text source: the guard covers it.
		{[]string{publishedOffice, paused}, "unpublished edits"},
		{[]string{publishedOffice, publishedText}, "not paused"},
		{[]string{publishedOffice, publishedText, paused, officeEffects}, "unpublished edits"},
		{[]string{publishedOffice, publishedText, paused, job, refreshing}, "unpublished edits"},
		{[]string{publishedOffice, publishedText, paused, rebuilding}, "unpublished edits"},
		{[]string{publishedOffice, publishedText, paused, lagging}, "projection is behind"},
		// A trashed material never projects: it still refuses.
		{[]string{publishedOffice, publishedText, paused, lagging, trashed}, "projection is behind"},
	} {
		if _, err = run(refusal.steps...); err == nil || !strings.Contains(err.Error(), refusal.want) {
			t.Fatalf("reset after %v: %v, want %q", refusal.steps, err, refusal.want)
		}
	}

	tx, err := run(publishedOffice, publishedText, paused)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{office, text} {
		var epoch, rows int64
		var dropped bool
		if err = tx.QueryRow(ctx, `SELECT d.epoch,(SELECT count(*) FROM source_document_updates u WHERE u.file_id=d.file_id),
			d.state IS NULL AND d.state_seed_sha256 IS NULL AND d.seed_bytes=0 AND d.log_bytes=0 AND d.log_rows=0 AND d.pending_effects='[]'::jsonb
			FROM source_documents d WHERE d.file_id=$1`, file).Scan(&epoch, &rows, &dropped); err != nil {
			t.Fatal(err)
		}
		if epoch != 2 || rows != 0 || !dropped {
			t.Fatalf("source %s: epoch=%d rows=%d dropped=%v", file, epoch, rows, dropped)
		}
	}
	// The note bootstraps from its projection on the next open, in a room
	// past every name the old state had.
	var yjsRows, logRows, room, revision int64
	var content string
	if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM material_yjs_documents WHERE material_id=m.id),
		(SELECT count(*) FROM material_yjs_updates WHERE material_id=m.id),
		COALESCE((SELECT room_schema FROM material_yjs_documents WHERE material_id=m.id), 1 + m.trash_restores),
		m.content::text, m.revision
		FROM materials m WHERE m.id=$1`, note.ID).Scan(&yjsRows, &logRows, &room, &content, &revision); err != nil {
		t.Fatal(err)
	}
	if yjsRows != 0 || logRows != 0 || room != 3 {
		t.Fatalf("note: yjs rows=%d log rows=%d room schema=%d", yjsRows, logRows, room)
	}
	if strings.Contains(content, "pending") || revision != revisionBefore+1 {
		t.Fatalf("note projection after the reset (revision %d): %s", revision, content)
	}
	// The reference became an empty paragraph with its id, in its place.
	doc, err := materialdoc.Parse(content)
	if err != nil {
		t.Fatal(err)
	}
	var blocks []string
	for _, node := range doc.Value {
		blocks = append(blocks, fmt.Sprintf("%v:%v:%v", node["id"], node["type"], node["children"]))
	}
	if got := strings.Join(blocks, " "); got != "b1:p:[map[text:kept]] r1:p:[map[text:]] b2:p:[map[text:after]]" {
		t.Fatalf("note blocks after the reset: %s", got)
	}
	if err = materialdoc.ValidateKind(content, "note"); err != nil {
		t.Fatalf("the note cannot seed a room: %v", err)
	}
	for material, want := range map[string]int64{mindmap: 4, diagram: 2} {
		if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM material_yjs_documents WHERE material_id=m.id) * 1000
			+ COALESCE((SELECT room_schema FROM material_yjs_documents WHERE material_id=m.id), 1 + m.trash_restores)
			FROM materials m WHERE m.id=$1`, material).Scan(&room); err != nil {
			t.Fatal(err)
		}
		if room != want {
			t.Fatalf("%s: rows*1000 + room schema = %d, want no row and room %d", material, room, want)
		}
	}
	var liveRows int64
	if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM material_yjs_documents WHERE material_id=$1)
		+ (SELECT count(*) FROM material_yjs_keys WHERE material_id=$1)`, quiz.ID).Scan(&liveRows); err != nil {
		t.Fatal(err)
	}
	if liveRows != 2 {
		t.Fatalf("the live quiz lost its rooms: %d rows", liveRows)
	}
	if booked, recount := chargeTestLedger(t, tx, owner); booked != recount {
		t.Fatalf("booked %d, reconciliation recounts %d", booked, recount)
	}
}
