package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

func testRefreshRequest(t *testing.T, s *Store, owner, actor string) (Workspace, File, SourceSession, SourceProcessResult) {
	t.Helper()
	ctx := context.Background()
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	if actor != owner {
		if _, err := s.pool.Exec(ctx, `INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'editor')`, ws.ID, actor); err != nil {
			t.Fatal(err)
		}
	}
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	// The actor edits; only the owner may request a manual refresh.
	doc := sourceTestEdit(t, s, actor, sourceTestSeed(t, s, owner, file.ID), "new-state")
	job, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	return ws, file, doc, job
}
func testRefreshFinalize(t *testing.T, s *Store, doc SourceSession, job SourceProcessResult) SourceRefreshCandidate {
	t.Helper()
	ctx := context.Background()
	candidate, err := s.ClaimSourceRefresh(ctx, doc.FileID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	err = s.FinalizeSourceRefresh(ctx, doc.FileID, SourceRefreshFinalize{JobID: job.JobID, Epoch: doc.Epoch, Checkpoint: doc.Checkpoint, LeaseToken: candidate.LeaseToken, SourceSHA256: strings.Repeat("b", 64), SizeBytes: 120, SourceETag: "etag-b"})
	if err != nil {
		t.Fatal(err)
	}
	return candidate
}

func TestSourceLostFinalizeAcknowledgmentPreservesAcceptedWork(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "finalize_owner")
	_, file, doc, job := testRefreshRequest(t, s, owner, owner)
	candidate := testRefreshFinalize(t, s, doc, job)
	if err := s.FailSourceRefresh(ctx, file.ID, job.JobID, candidate.LeaseToken, "lost acknowledgment", false); !errors.Is(err, ErrConflict) {
		t.Fatalf("exporter cancelled accepted work: %v", err)
	}
	var kind, status string
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT j.type,j.status,(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$2) FROM jobs j WHERE j.id=$1`, job.JobID, file.ID).Scan(&kind, &status, &count); err != nil {
		t.Fatal(err)
	}
	if kind != "parse" || status != "pending" || count != 1 {
		t.Fatalf("accepted work changed: %s %s %d", kind, status, count)
	}
}

func TestSourceAccountCancellationAllowsManualRetry(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "cancel_owner")
	actor := newBlobTestUser(t, s, "cancel_actor")
	_, file, _, job := testRefreshRequest(t, s, owner, actor)
	if _, err := s.pool.Exec(ctx, `SELECT cancel_user_async_work($1)`, owner); err != nil {
		t.Fatal(err)
	}
	var running *string
	var candidates int
	var state string
	if err := s.pool.QueryRow(ctx, `SELECT running_job_id,convert_from(state,'UTF8'),(SELECT count(*) FROM source_refresh_candidates WHERE file_id=$1) FROM source_documents WHERE file_id=$1`, file.ID).Scan(&running, &state, &candidates); err != nil {
		t.Fatal(err)
	}
	if running != nil || candidates != 0 || state != "new-state" {
		t.Fatalf("cancellation stranded state: %v %d %s", running, candidates, state)
	}
	retry, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
	if err != nil || retry.JobID == job.JobID {
		t.Fatalf("manual retry remained blocked: %+v %v", retry, err)
	}
}
