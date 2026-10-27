package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

func noteIndexState(t *testing.T, s *Store, id string) (dirty bool, job *string, indexErr *string) {
	t.Helper()
	if err := s.pool.QueryRow(context.Background(),
		`SELECT index_dirty_at IS NOT NULL, index_job_id, index_error FROM materials WHERE id=$1`, id).
		Scan(&dirty, &job, &indexErr); err != nil {
		t.Fatal(err)
	}
	return dirty, job, indexErr
}

// staleNote backdates a note's dirty mark past NoteIndexStale, so a change
// under the token threshold is due.
func staleNote(t *testing.T, s *Store, id string) {
	t.Helper()
	if _, err := s.pool.Exec(context.Background(),
		`UPDATE materials SET index_dirty_at=now()-interval '11 minutes' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
}

func TestNoteIndexDirtyMarkAndJobAdmission(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newBlobTestUser(t, s, "u_note_index")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Indexed", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Indexed note",
		Content: materialTestContent(t, "# Heading\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if dirty, _, _ := noteIndexState(t, s, note.ID); !dirty {
		t.Fatal("a new workspace note is dirty until it is indexed")
	}
	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Standalone", Content: materialTestContent(t, "# Standalone\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if dirty, _, _ := noteIndexState(t, s, standalone.ID); dirty {
		t.Fatal("standalone notes are never indexed")
	}
	if _, err := s.RequestMaterialIndex(ctx, standalone.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("standalone note is not indexable, got %v", err)
	}

	text, err := s.MaterialIndexText(ctx, note.ID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if text.Title != "Indexed note" || text.Text != "# Heading\n\nbody" {
		t.Fatalf("index text = %+v", text)
	}

	staleNote(t, s, note.ID)
	jobID, err := s.RequestMaterialIndex(ctx, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	dirty, job, _ := noteIndexState(t, s, note.ID)
	if dirty || job == nil || *job != jobID {
		t.Fatalf("queued note state: dirty=%v job=%v", dirty, job)
	}
	var jobType, materialID string
	if err := s.pool.QueryRow(ctx, `SELECT type, payload->>'materialId' FROM jobs WHERE id=$1`, jobID).
		Scan(&jobType, &materialID); err != nil {
		t.Fatal(err)
	}
	if jobType != "ingest" || materialID != note.ID {
		t.Fatalf("job = %s %s", jobType, materialID)
	}
	if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("a queued note is not due again, got %v", err)
	}

	// A content change makes the note dirty again even while a job runs, and
	// clears a previous failure.
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_error='boom' WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: 1, Value: []map[string]any{
		materialdoc.ParagraphNode("changed"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	dirty, job, indexErr := noteIndexState(t, s, note.ID)
	if !dirty || job == nil || indexErr != nil {
		t.Fatalf("edited note state: dirty=%v job=%v err=%v", dirty, job, indexErr)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET auto_process=false WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_job_id=NULL WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("auto reindex off keeps the note out of the queue, got %v", err)
	}
}

// Every way a note index job ends releases the note through the trigger on
// jobs (migrations 0082, 0083 and 0098). A job that failed with no edit since
// its admission leaves the note due, retried at most twice: the third such
// failure parks it (dirty, index_error, listed as failed) until its
// next edit (Epo 2026-10-20). An edit made while the job ran keeps the note
// due, whether the job failed or finished, so it is admitted again.
func TestNoteIndexJobEndReleasesTheNote(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	edit := func(t *testing.T, noteID, ownerID, text string) {
		t.Helper()
		content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: 1, Value: []map[string]any{
			materialdoc.ParagraphNode(text),
		}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.UpdateMaterial(ctx, noteID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
			t.Fatal(err)
		}
	}
	cancelPipelineJob := func(jobID, _ string) error {
		_, err := s.pool.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'failed','lifecycle','account_deletion','account deletion requested')`, jobID)
		return err
	}
	for _, tc := range []struct {
		name   string
		end    func(jobID, ownerID string) error
		edited bool // an edit lands while the job runs
		parked bool
	}{
		{"cancel_pipeline_jobs", cancelPipelineJob, false, true},
		{"cancel_user_async_work", func(_, ownerID string) error {
			_, err := s.pool.Exec(ctx, `SELECT cancel_user_async_work($1)`, ownerID)
			return err
		}, false, true},
		{"failed_after_an_edit", cancelPipelineJob, true, false},
		{"done_after_an_edit", func(jobID, _ string) error {
			_, err := s.pool.Exec(ctx, `UPDATE jobs SET status='done' WHERE id=$1`, jobID)
			return err
		}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ownerID := newBlobTestUser(t, s, "u_note_release")
			ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Released", Tags: []TagRef{}})
			if err != nil {
				t.Fatal(err)
			}
			note, err := s.CreateMaterial(ctx, Material{
				CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Released note",
				Content: materialTestContent(t, "# Heading\n\nbody"),
			})
			if err != nil {
				t.Fatal(err)
			}
			admit := func() string {
				t.Helper()
				staleNote(t, s, note.ID)
				jobID, err := s.RequestMaterialIndex(ctx, note.ID)
				if err != nil {
					t.Fatal(err)
				}
				return jobID
			}
			jobID := admit()
			if tc.parked {
				// Two failures leave the note due; the third parks it.
				for range 2 {
					if err := tc.end(jobID, ownerID); err != nil {
						t.Fatal(err)
					}
					if dirty, job, indexErr := noteIndexState(t, s, note.ID); !dirty || job != nil || indexErr != nil {
						t.Fatalf("a retried note: dirty=%v job=%v err=%v", dirty, job, indexErr)
					}
					jobID = admit()
				}
			}
			if tc.edited {
				edit(t, note.ID, ownerID, "edited while indexing")
			}
			if err := tc.end(jobID, ownerID); err != nil {
				t.Fatal(err)
			}
			dirty, job, indexErr := noteIndexState(t, s, note.ID)
			if job != nil || !dirty || (indexErr != nil) != tc.parked {
				t.Fatalf("released note state: dirty=%v job=%v err=%v", dirty, job, indexErr)
			}
			stats, err := s.WorkspaceStats(ctx, ownerID, ws.ID)
			if err != nil {
				t.Fatal(err)
			}
			want := "waiting"
			if tc.parked {
				want = "failed"
			}
			if len(stats.NoteChanges) != 1 || stats.NoteChanges[0].State != want {
				t.Fatalf("noteChanges = %+v, want the released note %s", stats.NoteChanges, want)
			}
			if tc.parked {
				if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
					t.Fatalf("a parked note waits for its next edit, got %v", err)
				}
				edit(t, note.ID, ownerID, "edited after the failure")
				var failures int
				if err := s.pool.QueryRow(ctx, `SELECT index_failures FROM materials WHERE id=$1`, note.ID).Scan(&failures); err != nil || failures != 0 {
					t.Fatalf("an edit leaves %d index failures (%v)", failures, err)
				}
			}
			staleNote(t, s, note.ID)
			if next, err := s.RequestMaterialIndex(ctx, note.ID); err != nil || next == jobID {
				t.Fatalf("a due note is admitted again: job=%s err=%v", next, err)
			}
		})
	}
}

// The Indexing tab lists notes whose index is behind their content with their
// state, and the owner's Process queues a note's index job at once, below the
// token threshold, with auto process off, and for a parked note (Epo
// 2026-10-21). Like a file's Process it is the owner's alone.
func TestNoteChangesListAndProcessNow(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newBlobTestUser(t, s, "u_note_process")
	editorID := newBlobTestUser(t, s, "u_note_process_editor")
	viewerID := newBlobTestUser(t, s, "u_note_process_viewer")
	strangerID := newBlobTestUser(t, s, "u_note_process_stranger")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Process now", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id,user_id,role)
		VALUES ($1,$2,'editor'),($1,$3,'viewer')`, ws.ID, editorID, viewerID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET auto_process=false WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Process me",
		Content: materialTestContent(t, "# Heading\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	listed := func(want string) {
		t.Helper()
		stats, err := s.WorkspaceStats(ctx, ownerID, ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		if want == "" {
			if len(stats.NoteChanges) != 0 {
				t.Fatalf("noteChanges = %+v, want none", stats.NoteChanges)
			}
			return
		}
		if len(stats.NoteChanges) != 1 || stats.NoteChanges[0].MaterialID != note.ID ||
			stats.NoteChanges[0].Title != "Process me" || stats.NoteChanges[0].State != want {
			t.Fatalf("noteChanges = %+v, want the note %s", stats.NoteChanges, want)
		}
	}
	listed("waiting")

	for _, tc := range []struct {
		actor string
		want  error
	}{{strangerID, ErrNotFound}, {viewerID, ErrForbidden}, {editorID, ErrForbidden}} {
		if _, err := s.ProcessNoteChanges(ctx, tc.actor, note.ID); !errors.Is(err, tc.want) {
			t.Fatalf("Process by %s = %v, want %v", tc.actor, err, tc.want)
		}
	}
	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Standalone", Content: materialTestContent(t, "body"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProcessNoteChanges(ctx, ownerID, standalone.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a standalone note is never indexed, got %v", err)
	}

	// Fresh, small and auto process off: the scheduler's path refuses it.
	if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("automatic admission = %v, want not due", err)
	}
	jobID, err := s.ProcessNoteChanges(ctx, ownerID, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	var automatic bool
	var reservation string
	if err := s.pool.QueryRow(ctx, `SELECT (payload->>'automatic')::boolean, payload->>'reservationId'
		FROM jobs WHERE id=$1 AND type='ingest' AND payload->>'materialId'=$2`, jobID, note.ID).
		Scan(&automatic, &reservation); err != nil {
		t.Fatal(err)
	}
	if automatic || reservation == "" {
		t.Fatalf("job automatic=%v reservation=%q, want a reserved manual job", automatic, reservation)
	}
	listed("queued")
	if _, err := s.ProcessNoteChanges(ctx, ownerID, note.ID); !errors.Is(err, ErrProcessingStarted) {
		t.Fatalf("a queued note = %v, want processing_started", err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='running', attempts=1 WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	listed("processing")
	if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='done' WHERE id=$1`, jobID); err != nil {
		t.Fatal(err)
	}
	listed("")
	if _, err := s.ProcessNoteChanges(ctx, ownerID, note.ID); !errors.Is(err, ErrNothingToProcess) {
		t.Fatalf("an indexed note = %v, want nothing_to_process", err)
	}

	// A parked note waits for its next edit, or for Process.
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_dirty_at=now(), index_error='boom', index_failures=3 WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	listed("failed")
	if _, err := s.ProcessNoteChanges(ctx, ownerID, note.ID); err != nil {
		t.Fatal(err)
	}
	listed("queued")

	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_job_id=NULL, index_dirty_at=now() WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TrashMaterial(ctx, ownerID, note.ID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	listed("")
	if _, err := s.ProcessNoteChanges(ctx, ownerID, note.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a trashed note = %v, want not found", err)
	}
}

// The note list takes the cap that bounds the file list (the owner's files
// per workspace), lists work in flight first, and counts the notes past it.
func TestNoteChangesListIsCapped(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newBlobTestUser(t, s, "u_note_cap")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Capped", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	limits, err := s.PayerPlanLimits(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	var newest Material
	for i := range limits.FilesPerWorkspace + 1 {
		if newest, err = s.CreateMaterial(ctx, Material{
			CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note",
			Title: fmt.Sprintf("Capped %03d", i), Content: materialTestContent(t, "body"),
		}); err != nil {
			t.Fatal(err)
		}
	}
	// The newest edit falls past the cap unless its job lists it first.
	if _, err := s.ProcessNoteChanges(ctx, ownerID, newest.ID); err != nil {
		t.Fatal(err)
	}
	stats, err := s.WorkspaceStats(ctx, ownerID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats.NoteChanges) != limits.FilesPerWorkspace || stats.MoreNoteChanges != 1 {
		t.Fatalf("listed %d notes and %d more, want %d and 1", len(stats.NoteChanges), stats.MoreNoteChanges, limits.FilesPerWorkspace)
	}
	if first := stats.NoteChanges[0]; first.MaterialID != newest.ID || first.State != "queued" {
		t.Fatalf("first listed note = %+v, want the queued newest note", first)
	}
}

// A note's index text holds its embedded quizzes and flashcard sets at their
// references, and an item's content write (a save or its room's projection)
// marks the note dirty as the note's own edits do, clearing its last failure.
func TestEmbeddedItemsIndexInTheirNote(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_note_items")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Items", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "With items",
		Content: materialTestContent(t, "body"),
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
	indexed := func() MaterialIndexText {
		t.Helper()
		text, err := s.MaterialIndexText(ctx, note.ID, ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		if text.Text != materialdoc.JoinNoteBlocks(text.Blocks) {
			t.Fatalf("text %q is not its blocks' join %+v", text.Text, text.Blocks)
		}
		return text
	}
	if text := indexed(); text.Text != "intro\n\nTrue?\n\nfront\nback" || len(text.Blocks) != 3 {
		t.Fatalf("index text = %+v", text)
	}
	settle := func() {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_dirty_at=NULL, index_error='boom' WHERE id=$1`,
			note.ID); err != nil {
			t.Fatal(err)
		}
	}
	dirtied := func(how string) {
		t.Helper()
		if dirty, _, indexErr := noteIndexState(t, s, note.ID); !dirty || indexErr != nil {
			t.Fatalf("after %s the note is dirty=%v err=%v", how, dirty, indexErr)
		}
	}

	settle()
	saved, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{ID: "c_new", Front: "osmosis", Back: "water"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, cards.ID, MaterialPatch{Content: &saved, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	dirtied("a card set save")
	if text := indexed(); text.Blocks[2].Text != "osmosis\nwater" {
		t.Fatalf("after the save the index text = %+v", text)
	}

	settle()
	if _, err := s.pool.Exec(ctx, `INSERT INTO material_yjs_documents (material_id, state, stored_version)
		VALUES ($1, '\x00'::bytea, 1)`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProjectMaterialContent(ctx, quiz.ID, quizProjection(t, 1, 1, 10, "z"), 1, nil); err != nil {
		t.Fatal(err)
	}
	dirtied("a quiz room's projection")
	if text := indexed(); text.Blocks[1].Text != "zxxxxxxxxx" {
		t.Fatalf("after the projection the index text = %+v", text)
	}
}

// Epo 2026-10-17: a dirty note is reindexed once its change since the last
// index (indexed_blocks) reaches NoteIndexTokens net tokens, or once it goes
// stale; chat reads the same changes per turn, and a placeholder resolves to
// its block's text on both sides.
func TestNoteChangesGateReindexAndReadForChat(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newBlobTestUser(t, s, "u_note_changes")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Changes", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	doc := func(texts ...string) string {
		t.Helper()
		nodes := []map[string]any{}
		for i, text := range texts {
			nodes = append(nodes, map[string]any{"type": "p", "id": fmt.Sprintf("p%d", i+1),
				"children": []any{map[string]any{"text": text}}})
		}
		content, err := materialdoc.Marshal(materialdoc.Envelope{SchemaVersion: 1, Value: nodes})
		if err != nil {
			t.Fatal(err)
		}
		return content
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Changing",
		Content: doc("cells divide", "membranes"),
	})
	if err != nil {
		t.Fatal(err)
	}
	pendingTokens := func() *int64 {
		t.Helper()
		var tokens *int64
		if err := s.pool.QueryRow(ctx, `SELECT pending_tokens FROM materials WHERE id=$1`, note.ID).Scan(&tokens); err != nil {
			t.Fatal(err)
		}
		return tokens
	}

	if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("a small fresh change is not due, got %v", err)
	}
	if tokens := pendingTokens(); tokens == nil || *tokens == 0 || *tokens >= NoteIndexTokens {
		t.Fatalf("pending tokens = %v, want the small change measured", tokens)
	}
	pending, err := s.NotePendingChanges(ctx, ws.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || len(pending[0].Changes) != 2 || pending[0].Changes[0].Operation != "add" {
		t.Fatalf("a never-indexed note reads as added blocks: %+v", pending)
	}

	// The index job ends: its blocks are the baseline.
	indexed, err := s.MaterialIndexText(ctx, note.ID, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := json.Marshal(indexed.Blocks)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET indexed_blocks=$2, index_dirty_at=NULL, pending_tokens=NULL
		WHERE id=$1`, note.ID, baseline); err != nil {
		t.Fatal(err)
	}
	if pending, err := s.NotePendingChanges(ctx, ws.ID, nil); err != nil || len(pending) != 0 {
		t.Fatalf("an indexed note has no changes: %+v %v", pending, err)
	}

	// A large edit clears the measure and is due at once.
	long := strings.Repeat("界", NoteIndexTokens+10)
	content := doc("cells divide", long)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	if tokens := pendingTokens(); tokens != nil {
		t.Fatalf("a content write keeps pending tokens %d", *tokens)
	}
	pending, err = s.NotePendingChanges(ctx, ws.ID, []string{note.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || len(pending[0].Changes) != 1 || pending[0].Changes[0].BlockID != "p2" ||
		pending[0].Changes[0].Operation != "replace" {
		t.Fatalf("pending changes = %+v", pending)
	}
	if other, err := s.NotePendingChanges(ctx, ws.ID, []string{"m_other"}); err != nil || len(other) != 0 {
		t.Fatalf("narrowed to another note: %+v %v", other, err)
	}
	resolved, err := s.ResolveNoteChange(ctx, ws.ID, note.ID, "p2")
	if err != nil || resolved.Before != "membranes" || resolved.After != long {
		t.Fatalf("resolve = %+v %v", resolved, err)
	}
	if _, err := s.ResolveNoteChange(ctx, ws.ID, note.ID, "p9"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unknown block resolves to %v", err)
	}
	if _, err := s.RequestMaterialIndex(ctx, note.ID); err != nil {
		t.Fatalf("a change over the threshold is due: %v", err)
	}
}

// Q415 (Epo 2026-10-27): a note's changes are computed once per revision and
// kept in its effects_cache; a cached read computes nothing, a content write
// (the note's or an embedded item's) and the index clear the cache, and an
// entry for another revision, or one computed before the row changed, is
// never served.
func TestNoteChangesAreCachedPerRevision(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	ownerID := newBlobTestUser(t, s, "u_note_cache")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Cached", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Cached",
		Content: materialTestContent(t, "body"),
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
	content := noteWithRefs(t, cards)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &content, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	cache := func() (revision *int64, labels []string) {
		t.Helper()
		var raw []byte
		if err := s.pool.QueryRow(ctx, `SELECT (effects_cache->'at'->>'revision')::bigint, effects_cache->'effects'
			FROM materials WHERE id=$1`, note.ID).Scan(&revision, &raw); err != nil {
			t.Fatal(err)
		}
		var effects []materialdoc.NoteEffect
		if raw != nil {
			if err := json.Unmarshal(raw, &effects); err != nil {
				t.Fatal(err)
			}
		}
		for _, effect := range effects {
			labels = append(labels, effect.Label)
		}
		return revision, labels
	}
	read := func() []string {
		t.Helper()
		pending, err := s.NotePendingChanges(ctx, ws.ID, []string{note.ID})
		if err != nil {
			t.Fatal(err)
		}
		var labels []string
		for _, p := range pending {
			for _, change := range p.Changes {
				labels = append(labels, change.Label)
			}
		}
		return labels
	}
	// An entry at the note's current revision (a marker unless effects are
	// given), at noteEffectsFormat unless another format is given.
	plantAs := func(format int, effects string) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `UPDATE materials SET effects_cache=jsonb_build_object(
				'at', jsonb_build_object('revision', revision, 'format', $2::int), 'effects', $3::jsonb)
			WHERE id=$1`, note.ID, format, effects); err != nil {
			t.Fatal(err)
		}
	}
	plant := func() {
		t.Helper()
		plantAs(noteEffectsFormat, `[{"id":"x","kind":"text","operation":"add","label":"planted","blockId":"b"}]`)
	}
	cleared := func(how string) {
		t.Helper()
		if revision, _ := cache(); revision != nil {
			t.Fatalf("after %s the cache holds revision %d", how, *revision)
		}
	}
	var revision int64
	revisionNow := func() int64 {
		t.Helper()
		if err := s.pool.QueryRow(ctx, `SELECT revision FROM materials WHERE id=$1`, note.ID).Scan(&revision); err != nil {
			t.Fatal(err)
		}
		return revision
	}

	// The reindex measure fills the cache with the changes it computed.
	if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("a small change is not due, got %v", err)
	}
	at, computed := cache()
	if at == nil || *at != revisionNow() || len(computed) != 2 {
		t.Fatalf("after the measure the cache is %v %v", at, computed)
	}
	if got := read(); strings.Join(got, "|") != strings.Join(computed, "|") {
		t.Fatalf("a read gave %v, the measure cached %v", got, computed)
	}
	// A cached read computes nothing: it serves the entry as stored.
	plant()
	if got := read(); len(got) != 1 || got[0] != "planted" {
		t.Fatalf("a cached read gave %v", got)
	}
	// Q435: an entry of another format, or one that no longer decodes, is
	// computed again.
	plantAs(noteEffectsFormat+1, `[{"id":"x","kind":"text","operation":"add","label":"planted","blockId":"b"}]`)
	if got := read(); strings.Join(got, "|") != strings.Join(computed, "|") {
		t.Fatalf("an entry of another format was served: %v", got)
	}
	plantAs(noteEffectsFormat, `[{"id":"x","kind":"text","operation":5}]`)
	if got := read(); strings.Join(got, "|") != strings.Join(computed, "|") {
		t.Fatalf("an unreadable entry gave %v", got)
	}

	// An entry for another revision is never served, and a read replaces it.
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET revision=revision+1 WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	if got := read(); strings.Join(got, "|") != strings.Join(computed, "|") {
		t.Fatalf("a stale entry was served: %v", got)
	}
	if at, _ := cache(); at == nil || *at != revisionNow() {
		t.Fatalf("the read cached revision %v, want %d", at, revision)
	}

	// The note's own content write and an embedded item's both clear it.
	plant()
	edited := noteWithRefs(t, cards)
	if _, err := s.UpdateMaterial(ctx, note.ID, MaterialPatch{Content: &edited, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	cleared("a content write")
	plant()
	saved, err := materialdoc.FlashcardsDocument([]materialdoc.Card{{ID: "c_new", Front: "osmosis", Back: "water"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, cards.ID, MaterialPatch{Content: &saved, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	cleared("an embedded item's write")
	if got := read(); len(got) != 2 || got[0] == "planted" {
		t.Fatalf("after the item's write a read gave %v", got)
	}

	// Changes computed before the row changed are not kept: the item's write
	// landed without a new revision, after the read that computed them.
	var xmin string
	if err := s.pool.QueryRow(ctx, `SELECT revision, xmin::text FROM materials WHERE id=$1`, note.ID).
		Scan(&revision, &xmin); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, cards.ID, MaterialPatch{Content: &saved, UpdatedBy: ownerID}); err != nil {
		t.Fatal(err)
	}
	s.cacheNoteChanges(ctx, note.ID, revision, xmin, nil)
	cleared("a cache write computed before the row changed")

	// Q435: a cache write that fails is logged, and the read still answers
	// the changes it computed (here a trigger refuses this note's writes).
	if _, err := s.pool.Exec(ctx, `CREATE FUNCTION q435_refuse_cache() RETURNS trigger AS $$
		BEGIN RAISE EXCEPTION 'cache write refused'; END $$ LANGUAGE plpgsql`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, fmt.Sprintf(`CREATE TRIGGER q435_refuse_cache BEFORE UPDATE OF effects_cache ON materials
		FOR EACH ROW WHEN (NEW.id = '%s' AND NEW.effects_cache IS NOT NULL) EXECUTE FUNCTION q435_refuse_cache()`, note.ID)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS q435_refuse_cache ON materials`)
		_, _ = s.pool.Exec(context.Background(), `DROP FUNCTION IF EXISTS q435_refuse_cache()`)
	})
	if got := read(); len(got) != 2 || got[0] == "planted" {
		t.Fatalf("with its cache write refused a read gave %v", got)
	}
	cleared("a refused cache write")
}

// TestNoteIndexSchedulerQuery runs NOTE_INDEX_SQL from
// collaboration-rs/crates/sources/src/refresh.rs verbatim with its trigger
// constants, which must equal Go admission's.
func TestNoteIndexSchedulerQuery(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	noteSQL := schedulerSource(t, `(?s)const NOTE_INDEX_SQL: &str = "(.*?)";`)
	tokens := schedulerSource(t, `const NOTE_INDEX_TOKENS: i64 = (\d+);`)
	idle := schedulerSource(t, `const NOTE_INDEX_IDLE: &str = "(.*?)";`)
	stale := schedulerSource(t, `const NOTE_INDEX_STALE: &str = "(.*?)";`)
	if tokens != fmt.Sprint(NoteIndexTokens) || stale != "10 minutes" || NoteIndexStale != 10*time.Minute {
		t.Fatalf("refresh.rs tokens %s stale %s, Go %d %s", tokens, stale, NoteIndexTokens, NoteIndexStale)
	}
	ownerID := newBlobTestUser(t, s, "u_note_scheduler")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Scheduled", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Scheduled",
		Content: materialTestContent(t, "body"),
	})
	if err != nil {
		t.Fatal(err)
	}
	listed := func(edited, dirty string, pending *int64) bool {
		t.Helper()
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// Only this note competes for the batch; the rollback restores the rest.
		if _, err := tx.Exec(ctx, `UPDATE materials SET index_error='other test' WHERE id<>$1 AND index_dirty_at IS NOT NULL`, note.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `UPDATE materials SET updated_at=now()-$2::interval,
			index_dirty_at=now()-$3::interval, pending_tokens=$4 WHERE id=$1`, note.ID, edited, dirty, pending); err != nil {
			t.Fatal(err)
		}
		var found bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM (`+noteSQL+`) n WHERE n.id=$4)`,
			NoteIndexTokens, idle, stale, note.ID).Scan(&found); err != nil {
			t.Fatal(err)
		}
		return found
	}
	small, large := int64(NoteIndexTokens-1), int64(NoteIndexTokens)
	for _, tc := range []struct {
		name          string
		edited, dirty string
		pending       *int64
		want          bool
	}{
		{"unmeasured and idle", "2 minutes", "2 minutes", nil, true},
		{"unmeasured while typing", "1 second", "2 minutes", nil, false},
		{"small and idle", "2 minutes", "2 minutes", &small, false},
		{"large and idle", "2 minutes", "2 minutes", &large, true},
		{"large while typing", "1 second", "2 minutes", &large, false},
		{"small and stale", "1 second", "11 minutes", &small, true},
	} {
		if got := listed(tc.edited, tc.dirty, tc.pending); got != tc.want {
			t.Errorf("%s: listed=%v", tc.name, got)
		}
	}
}
