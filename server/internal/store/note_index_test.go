package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

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
		Content: "# Heading\n\nbody",
	})
	if err != nil {
		t.Fatal(err)
	}
	if dirty, _, _ := noteIndexState(t, s, note.ID); !dirty {
		t.Fatal("a new workspace note is dirty until it is indexed")
	}
	standalone, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, Kind: "note", Title: "Standalone", Content: "# Standalone\n\nbody",
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
// jobs (migrations 0082 and 0083). A job that failed with no edit since its
// admission parks the note (dirty, index_error, counted in pendingNotes) until
// its next edit; an edit made while the job ran keeps the note due, whether
// the job failed or finished, so it is admitted again.
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
				Content: "# Heading\n\nbody",
			})
			if err != nil {
				t.Fatal(err)
			}
			jobID, err := s.RequestMaterialIndex(ctx, note.ID)
			if err != nil {
				t.Fatal(err)
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
			if stats.PendingNotes != 1 {
				t.Fatalf("pendingNotes = %d, want the released note counted", stats.PendingNotes)
			}
			if tc.parked {
				if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
					t.Fatalf("a parked note waits for its next edit, got %v", err)
				}
				edit(t, note.ID, ownerID, "edited after the failure")
			}
			if next, err := s.RequestMaterialIndex(ctx, note.ID); err != nil || next == jobID {
				t.Fatalf("a due note is admitted again: job=%s err=%v", next, err)
			}
		})
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
		Content: "body",
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
		if text.Text != materialdoc.JoinIndexBlocks(text.Blocks) {
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
