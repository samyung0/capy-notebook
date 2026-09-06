package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestSourceCheckpointSerializesRequesterCancellation(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner := newBlobTestUser(t, s, "a_checkpoint_owner")
	actor := newBlobTestUser(t, s, "z_checkpoint_actor")
	_, file, doc, job := testRefreshRequest(t, s, owner, actor)
	deletion, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	if _, err = deletion.Exec(ctx, `UPDATE users SET deletion_requested_at=now(),purge_after=now()+interval '30 days' WHERE id=$1`, actor); err != nil {
		t.Fatal(err)
	}
	if _, err = deletion.Exec(ctx, `SELECT id FROM jobs WHERE id=$1 FOR UPDATE`, job.JobID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, saveErr := s.SaveSourceCheckpoint(ctx, file.ID, SourceCheckpoint{ActorIDs: []string{actor}, Epoch: doc.Epoch, ExpectedCheckpoint: doc.Checkpoint, State: []byte("late-state"), PendingEffects: json.RawMessage(`[]`)})
		done <- saveErr
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
			t.Fatal("checkpoint did not wait for the cancelling actor")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Candidate cleanup inserts a delta referencing the owner already locked by
	// the checkpoint. That FK must not wait for the checkpoint's actor lock.
	if _, err = deletion.Exec(ctx, `SELECT cancel_user_async_work($1)`, actor); err != nil {
		t.Fatalf("account cancellation raced checkpoint: %v", err)
	}
	if err = deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var locked *AccountLockedError
	if err = <-done; !errors.As(err, &locked) || locked.State != AccountDeletionPending {
		t.Fatalf("checkpoint after requester deletion = %v", err)
	}
	var state string
	var running *string
	if err = s.pool.QueryRow(ctx, `SELECT convert_from(state,'UTF8'),running_job_id FROM source_documents WHERE file_id=$1`, file.ID).Scan(&state, &running); err != nil {
		t.Fatal(err)
	}
	if state != "new-state" || running != nil {
		t.Fatalf("cancellation lost authored state or kept work: %s %v", state, running)
	}
}
