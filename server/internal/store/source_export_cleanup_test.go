package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSourceExportFailureSerializesAccountCancellation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The owner sorts first, exercising cancellation's storage-delta FK
	// while the failure request waits for the owning account.
	owner := newBlobTestUser(t, s, "a_export_owner")
	actor := newBlobTestUser(t, s, "z_export_actor")
	_, file, _, job := testRefreshRequest(t, s, owner, actor)
	candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
	if err != nil {
		t.Fatal(err)
	}
	target := owner
	deletion, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	if _, err = deletion.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR UPDATE`, target); err != nil {
		t.Fatal(err)
	}
	// Pause at cancel_user_async_work's selected-job lock boundary.
	if _, err = deletion.Exec(ctx, `SELECT id FROM jobs WHERE id=$1 FOR UPDATE`, job.JobID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		done <- s.FailSourceRefresh(ctx, file.ID, job.JobID, candidate.LeaseToken, "export failed", false)
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var blocked bool
		if err = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1::int=ANY(pg_blocking_pids(a.pid)))`, deletion.Conn().PgConn().PID()).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("export failure did not reach cancellation's lock boundary")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err = deletion.Exec(ctx, `SELECT cancel_user_async_work($1)`, target); err != nil {
		t.Fatalf("account cancellation raced export failure: %v", err)
	}
	if err = deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, ErrConflict) {
		t.Fatalf("cancelled export failure = %v, want stale claim", err)
	}
	var running *string
	var candidates int
	var state, status string
	if err = s.pool.QueryRow(ctx, `SELECT d.running_job_id,convert_from(d.state,'UTF8'),f.status,(SELECT count(*) FROM source_refresh_candidates WHERE file_id=f.id) FROM source_documents d JOIN files f ON f.id=d.file_id WHERE f.id=$1`, file.ID).Scan(&running, &state, &status, &candidates); err != nil {
		t.Fatal(err)
	}
	if running != nil || candidates != 0 || state != "new-state" || status != "ready" {
		t.Fatalf("cancellation changed authored/published state: %v %d %s %s", running, candidates, state, status)
	}
}
