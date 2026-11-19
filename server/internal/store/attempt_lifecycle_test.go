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
	if _, err := s.CheckQuizQuestion(ctx, userID, quiz.ID, QuizCheck{
		Answers: map[string]any{}, Question: map[string]any{"id": "q1", "parts": []any{}}, Order: []string{"q1"},
	}, time.Now()); err == nil {
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

// Study → History pages attempts sorted by score and filtered by the quiz's
// workspace in SQL.
func TestStudyHistorySortsFiltersAndPages(t *testing.T) {
	f := newStudyFixture(t, "u_attempt_list")
	ctx := context.Background()
	other, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Other", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	attempt := func(wsID, wsName string, correct float64) string {
		quiz, err := f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: uid("Quiz "), WorkspaceID: wsID, WorkspaceName: wsName, Questions: json.RawMessage(studyQuestions), Privacy: PrivacyPrivate})
		if err != nil {
			t.Fatal(err)
		}
		// Both questions earn correct/2 of their mark.
		var qs []map[string]any
		if err := json.Unmarshal([]byte(studySnapshot), &qs); err != nil {
			t.Fatal(err)
		}
		for _, q := range qs {
			q["parts"].([]any)[0].(map[string]any)["awarded"] = correct / 2
		}
		snapshot, _ := json.Marshal(qs)
		return checkQuiz(t, f.s, f.user, quiz.ID, snapshot, studyAnswers).ID
	}
	high := attempt(f.ws.ID, f.ws.Name, 2)
	low := attempt(f.ws.ID, f.ws.Name, 1)
	attempt(other.ID, other.Name, 0)

	list, more, err := f.s.StudyHistory(ctx, f.user, HistoryParams{Sort: "score", Ascending: true, Workspaces: []string{f.ws.ID}, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != low || !more || *list[0].WorkspaceID != f.ws.ID || list[0].Status != HistoryDone {
		t.Fatalf("first page = %+v, more %v", list, more)
	}
	list, more, err = f.s.StudyHistory(ctx, f.user, HistoryParams{Sort: "score", Ascending: true, Workspaces: []string{f.ws.ID}, Offset: 1, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].ID != high || more {
		t.Fatalf("second page = %+v, more %v", list, more)
	}
	if list, _, err = f.s.StudyHistory(ctx, f.user, HistoryParams{Limit: 10}); err != nil || len(list) != 3 {
		t.Fatalf("unfiltered = %d attempts, %v", len(list), err)
	}
}

// History offers only the newest try of a quiz checked partway to go on; an
// older partway try just ended there (Epo 2026-11-13).
func TestStudyHistoryContinuesTheNewestTry(t *testing.T) {
	f := newStudyFixture(t, "u_history_tries")
	ctx := context.Background()
	quiz := f.quiz(t)
	var qs []json.RawMessage
	if err := json.Unmarshal([]byte(studySnapshot), &qs); err != nil {
		t.Fatal(err)
	}
	firstOnly := []byte("[" + string(qs[0]) + "]")
	older := checkQuiz(t, f.s, f.user, quiz.ID, firstOnly, studyAnswers).ID
	newer := checkQuiz(t, f.s, f.user, quiz.ID, firstOnly, studyAnswers).ID
	list, _, err := f.s.StudyHistory(ctx, f.user, HistoryParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	status := map[string]HistoryStatus{}
	for _, r := range list {
		if r.Answered != 1 || r.Items != len(qs) {
			t.Fatalf("row = %+v, want 1 of %d answered", r, len(qs))
		}
		status[r.ID] = r.Status
	}
	if status[newer] != HistoryOpen || status[older] != HistoryPartial {
		t.Fatalf("statuses = %v, want the newer open and the older partial", status)
	}
	// The status filter pages what matches.
	for _, c := range []struct {
		statuses []HistoryStatus
		offset   int
		want     string
		more     bool
	}{
		{[]HistoryStatus{HistoryOpen}, 0, newer, false},
		{[]HistoryStatus{HistoryPartial}, 0, older, false},
		{[]HistoryStatus{HistoryOpen, HistoryPartial}, 0, newer, true},
		{[]HistoryStatus{HistoryOpen, HistoryPartial}, 1, older, false},
	} {
		got, more, err := f.s.StudyHistory(ctx, f.user, HistoryParams{Statuses: c.statuses, Offset: c.offset, Limit: 1})
		if err != nil || len(got) != 1 || got[0].ID != c.want || more != c.more {
			t.Fatalf("statuses %v from %d = %+v, more %v, %v", c.statuses, c.offset, got, more, err)
		}
	}
	// Continue offers the newer try until it is removed from it.
	if cont, err := f.s.ContinueRows(ctx, f.user, "", time.Now()); err != nil || len(cont) != 1 || cont[0].ID != newer {
		t.Fatalf("continue = %+v, %v", cont, err)
	}
	if err := f.s.HideContinue(ctx, f.user, HistoryQuiz, newer); err != nil {
		t.Fatal(err)
	}
	if cont, err := f.s.ContinueRows(ctx, f.user, "", time.Now()); err != nil || len(cont) != 0 {
		t.Fatalf("continue after removing = %+v, %v", cont, err)
	}
}
