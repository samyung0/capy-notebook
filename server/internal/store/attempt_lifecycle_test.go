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
	quiz, err := s.CreateQuiz(ctx, Quiz{UserID: userID, Name: "Q", Questions: json.RawMessage(`[]`), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET
		suspended_at=now(), suspended_reason='test' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateAttempt(
		ctx, userID, quiz.ID, 0, 1,
		json.RawMessage(`{}`), json.RawMessage(`[]`),
	); err == nil {
		t.Fatal("suspended user created an attempt")
	}
	var attempts int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE user_id=$1`, userID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatalf("post-suspension attempts = %d", attempts)
	}
}

func TestFileAndAccountDeletionDoNotWaitForWorkerHeldJobRows(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()

	t.Run("file", func(t *testing.T) {
		ownerID := newBlobTestUser(t, s, "u_delete_file_lock")
		ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Delete without job wait", Tags: []TagRef{}})
		if err != nil {
			t.Fatal(err)
		}
		file, err := s.createReadyFile(
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
		go func() {
			_, err := s.TrashFile(ctx, ownerID, file.ID, AgentOperation{})
			done <- err
		}()
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

// All results filters attempts by the quiz's workspace.
func TestListAttemptsCarriesWorkspaceID(t *testing.T) {
	f := newStudyFixture(t, "u_attempt_workspace")
	ctx := context.Background()
	quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Quiz", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name, Questions: json.RawMessage(studyQuestions), Privacy: PrivacyPrivate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.CreateAttempt(ctx, f.user, quiz.ID, 1, 2, json.RawMessage(`{}`), json.RawMessage(studySnapshot)); err != nil {
		t.Fatal(err)
	}
	list, err := f.s.ListAttempts(ctx, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].WorkspaceID == nil || *list[0].WorkspaceID != f.ws.ID {
		t.Fatalf("attempts = %+v", list)
	}
}
