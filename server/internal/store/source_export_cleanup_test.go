package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSourceExportFailureSerializesAccountCancellation(t *testing.T) {
	for _, cancelOwner := range []bool{false, true} {
		t.Run(map[bool]string{false: "requester", true: "owner"}[cancelOwner], func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			// The owner sorts first, exercising cancellation's storage-delta FK
			// while the failure request waits for the requesting account.
			owner := newBlobTestUser(t, s, "a_export_owner")
			actor := newBlobTestUser(t, s, "z_export_actor")
			_, file, _, job := testRefreshRequest(t, s, owner, actor)
			candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
			if err != nil {
				t.Fatal(err)
			}
			target := actor
			if cancelOwner {
				target = owner
			}
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
		})
	}
}

func TestSourceExportFailureCleansUpAfterRequesterRevocation(t *testing.T) {
	for _, revoked := range []string{"removed", "suspended", "deletion_pending"} {
		t.Run(revoked, func(t *testing.T) {
			s := openAccessTestStore(t)
			ctx := context.Background()
			owner := newBlobTestUser(t, s, "cleanup_owner")
			actor := newBlobTestUser(t, s, "cleanup_actor")
			ws, file, _, job := testRefreshRequest(t, s, owner, actor)
			candidate, err := s.ClaimSourceRefresh(ctx, file.ID, job.JobID)
			if err != nil {
				t.Fatal(err)
			}
			switch revoked {
			case "removed":
				err = s.RemoveWorkspaceMember(ctx, owner, ws.ID, actor)
			case "suspended":
				_, err = s.pool.Exec(ctx, `UPDATE users SET suspended_at=now(),suspended_reason='test' WHERE id=$1`, actor)
			case "deletion_pending":
				_, err = s.pool.Exec(ctx, `UPDATE users SET deletion_requested_at=now(),purge_after=now()+interval '30 days' WHERE id=$1`, actor)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = s.FailSourceRefresh(ctx, file.ID, job.JobID, candidate.LeaseToken, "export failed", false); err != nil {
				t.Fatalf("revoked requester blocked export cleanup: %v", err)
			}
			retry, err := s.RequestSourceRefresh(ctx, owner, file.ID, false)
			if err != nil || retry.JobID == job.JobID {
				t.Fatalf("cleanup blocked owner retry: %+v %v", retry, err)
			}
		})
	}
}
