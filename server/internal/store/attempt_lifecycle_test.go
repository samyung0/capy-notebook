package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestSuspendedUserCannotWriteAttemptHistory(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newBlobTestUser(t, s, "u_attempt_suspended")
	if _, err := s.pool.Exec(ctx, `UPDATE users SET
		suspended_at=now(), suspended_reason='test' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	wrong := []json.RawMessage{json.RawMessage(`{"id":"q_1"}`)}
	if err := s.AddMistakes(ctx, userID, wrong); err == nil {
		t.Fatal("suspended user added a mistake")
	}
	if err := s.ClearMistakesExcept(ctx, userID, []string{"q_1"}); err == nil {
		t.Fatal("suspended user cleared mistakes")
	}
	if _, err := s.CreateAttempt(
		ctx, userID, ReviewMistakesQuizID, 0, 1,
		json.RawMessage(`{}`), json.RawMessage(`[]`),
	); err == nil {
		t.Fatal("suspended user created an attempt")
	}
	var attempts, mistakes int
	if err := s.pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM attempts WHERE user_id=$1),
		(SELECT count(*) FROM mistakes WHERE user_id=$1)`, userID).
		Scan(&attempts, &mistakes); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 || mistakes != 0 {
		t.Fatalf("post-suspension rows: attempts=%d mistakes=%d", attempts, mistakes)
	}
}

func TestFileAndAccountDeletionDoNotWaitForWorkerHeldJobRows(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	t.Run("file", func(t *testing.T) {
		ownerID := newBlobTestUser(t, s, "u_delete_file_lock")
		ws, err := s.CreateWorkspace(ctx, ownerID, "Delete without job wait", ColorGreen, []TagRef{})
		if err != nil {
			t.Fatal(err)
		}
		file, err := s.CreateSourceReady(
			ctx, ws.ID, ownerID, "locked.pdf", "pdf", nil, "", 1, "sources/"+uid("blob"),
		)
		if err != nil {
			t.Fatal(err)
		}
		jobID := uid("job")
		if _, err := s.pool.Exec(ctx, `INSERT INTO jobs (id,type,payload,status,attempts)
			VALUES ($1,'ingest',jsonb_build_object('fileId',$2::text),'running',1)`,
			jobID, file.ID); err != nil {
			t.Fatal(err)
		}
		workerTx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer workerTx.Rollback(ctx)
		if _, err := workerTx.Exec(ctx, `SELECT id FROM jobs WHERE id=$1 FOR UPDATE`, jobID); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- s.DeleteFile(ctx, ownerID, file.ID) }()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("file deletion waited for a worker-held job row")
		}
	})

	t.Run("account", func(t *testing.T) {
		userID := newBlobTestUser(t, s, "u_delete_account_lock")
		jobID := uid("job")
		if _, err := s.pool.Exec(ctx, `INSERT INTO jobs (id,type,payload,status,attempts)
			VALUES ($1,'ingest',jsonb_build_object('actorUserId',$2::text),'running',1)`,
			jobID, userID); err != nil {
			t.Fatal(err)
		}
		workerTx, err := s.pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer workerTx.Rollback(ctx)
		if _, err := workerTx.Exec(ctx, `SELECT id FROM jobs WHERE id=$1 FOR UPDATE`, jobID); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() {
			_, err := s.RequestAccountDeletion(ctx, userID, false)
			done <- err
		}()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("account deletion waited for a worker-held job row")
		}
	})
}
