package store

import (
	"context"
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
	if _, err := s.pool.Exec(ctx, `UPDATE workspaces SET auto_reindex=false WHERE id=$1`, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_job_id=NULL WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestMaterialIndex(ctx, note.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("auto reindex off keeps the note out of the queue, got %v", err)
	}
}
