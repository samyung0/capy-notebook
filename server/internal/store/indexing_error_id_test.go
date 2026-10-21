package store

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// A failed row in the Indexing tab carries its error id (human frontend
// error-handling, 2026-10-21): the trace of the failed job's last ingest
// attempt, or of the gateway request that recorded an export failure; a row
// that is not failed carries none, and a save clears it (migration 0105).
func TestIndexingTabFailedRowsCarryTheirErrorID(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	owner := newBlobTestUser(t, s, "u_error_id")
	ws, file := sourceTestFile(t, s, owner, "notes.txt", "txt")
	doc := sourceTestEdit(t, s, owner, sourceTestSeed(t, s, owner, file.ID), "saved")
	attempt := func(jobID string, n int, trace string) {
		t.Helper()
		if _, err := s.pool.Exec(ctx, `INSERT INTO ingest_job_attempts(job_id,operation_id,attempt,job_type,environment,host_id,worker_instance_id,trace_id,queued_at,claimed_at) VALUES($1,$1,$2,'ingest','test','test','test',$3,now(),now())`, jobID, n, trace); err != nil {
			t.Fatal(err)
		}
	}
	stats := func() WorkspaceStats {
		t.Helper()
		out, err := s.WorkspaceStats(ctx, owner, ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	fileRow := func(state, errorID string) {
		t.Helper()
		got := stats().FileChanges
		if len(got) != 1 || got[0].State != state || got[0].ErrorID != errorID {
			t.Fatalf("fileChanges = %+v, want %s with error id %q", got, state, errorID)
		}
	}

	// A failed pipeline job: its last attempt's trace.
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	fileRow("queued", "")
	attempt(job.JobID, 1, "trace-retried-"+job.JobID)
	attempt(job.JobID, 2, "trace-failed-"+job.JobID)
	if _, err := s.pool.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'failed','pipeline','parse_failed','parser failed')`, job.JobID); err != nil {
		t.Fatal(err)
	}
	fileRow("failed", "trace-failed-"+job.JobID)
	sourceTestEdit(t, s, owner, doc, "saved again")
	fileRow("waiting", "")

	// An export failure the gateway records: that request's trace.
	if job, err = s.RequestSourceRefresh(ctx, owner, file.ID, false); err != nil {
		t.Fatal(err)
	}
	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	traced := obs.WithTrace(ctx, "trace-export-"+job.JobID, "span")
	if err := s.FailSourceRefresh(traced, file.ID, job.JobID, candidate.LeaseToken, "engine export failed", false); err != nil {
		t.Fatal(err)
	}
	fileRow("failed", "trace-export-"+job.JobID)

	// A note parked by its third failed index job: that job's attempt.
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: owner, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Failing note",
		Content: materialTestContent(t, "# Heading\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	staleNote(t, s, note.ID)
	noteJob, err := s.RequestMaterialIndex(ctx, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE materials SET index_failures=2 WHERE id=$1`, note.ID); err != nil {
		t.Fatal(err)
	}
	attempt(noteJob, 1, "trace-note-"+noteJob)
	if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='failed',error='ingest failed' WHERE id=$1`, noteJob); err != nil {
		t.Fatal(err)
	}
	if got := stats().NoteChanges; len(got) != 1 || got[0].State != "failed" || got[0].ErrorID != "trace-note-"+noteJob {
		t.Fatalf("noteChanges = %+v, want the failed note with its attempt's trace", got)
	}
}
