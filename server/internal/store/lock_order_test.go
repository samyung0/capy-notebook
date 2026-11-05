package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/samyung0/capy-notebook/server/internal/models"
)

// holdWorkspaceThenAccount plays a source checkpoint or access check
// (sourceLockTx): it locks the workspace, waits until run is blocked behind
// it, then locks the owner account. A run that took the account before the
// workspace deadlocks here (40P01) instead of finishing after the commit.
func holdWorkspaceThenAccount(t *testing.T, s *Store, workspaceID, accountID string, run func(context.Context) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, workspaceID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	waitBlockedBy(t, ctx, s, writer)
	if _, err := writer.Exec(ctx, `SELECT 1 FROM users WHERE id=$1 FOR NO KEY UPDATE`, accountID); err != nil {
		t.Fatalf("workspace writer: %v", err)
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("run after the workspace writer: %v", err)
	}
}

func waitBlockedBy(t *testing.T, ctx context.Context, s *Store, tx pgx.Tx) {
	t.Helper()
	pid := tx.Conn().PgConn().PID()
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		var blocked bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1::int=ANY(pg_blocking_pids(a.pid)))`, pid).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("run never waited on the workspace writer")
		}
	}
}

func TestNoteIndexRequestLocksWorkspaceBeforeAccount(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	s.SetModelRegistry(reg)
	ownerID := newBlobTestUser(t, s, "u_index_order")
	ws, err := s.CreateWorkspace(ctx, ownerID, WorkspaceCreate{Name: "Indexed", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	note, err := s.CreateMaterial(ctx, Material{
		CreatedBy: ownerID, WorkspaceID: ws.ID, WorkspaceName: ws.Name, Kind: "note", Title: "Note",
		Content: materialTestContent(t, "# Heading\n\nbody"),
	})
	if err != nil {
		t.Fatal(err)
	}
	staleNote(t, s, note.ID)
	holdWorkspaceThenAccount(t, s, ws.ID, ownerID, func(ctx context.Context) error {
		_, err := s.RequestMaterialIndex(ctx, note.ID)
		return err
	})
}

func TestProviderSessionLocksWorkspaceBeforeAccount(t *testing.T) {
	s := openAccessTestStore(t)
	ctx := context.Background()
	userID := newCreditsTestUser(t, s)
	ws, err := s.CreateWorkspace(ctx, userID, WorkspaceCreate{Name: "Chat", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	llm, embed := platformSessionRates()
	holdWorkspaceThenAccount(t, s, ws.ID, userID, func(ctx context.Context) error {
		_, err := s.BeginProviderSession(ctx, userID, ws.ID, SurfaceChat, llm, embed, "")
		return err
	})
}

// Enqueueing holds workspace and account locks; a read on a second pool
// connection could wait behind requests that wait on those locks. With one
// connection, that wait never ends.
func TestIngestJobPayloadStaysOnItsTransaction(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	config := s.pool.Config().Copy()
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	single := NewWithPool(pool)
	reg, err := models.New(ctx, s.Pool())
	if err != nil {
		t.Fatal(err)
	}
	single.SetModelRegistry(reg)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err := single.ingestJobPayload(ctx, tx, "u_actor", map[string]any{"fileId": "f_1"}); err != nil {
		t.Fatalf("payload inside the only connection's transaction: %v", err)
	}
}

// A writer's recheck reads; it must not queue behind a workspace write (a
// checkpoint or a note save holding the workspace and the account).
func TestSourceAccessCheckTakesNoLocks(t *testing.T) {
	s := openAccessTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	owner := newBlobTestUser(t, s, "source_check_owner")
	ws, file := sourceTestFile(t, s, owner, "lesson.docx", "doc")
	doc := sourceTestSeed(t, s, owner, file.ID)
	writer, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, file.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(ctx, `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`, ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(ctx, `SELECT 1 FROM users WHERE id=$1 FOR NO KEY UPDATE`, owner); err != nil {
		t.Fatal(err)
	}
	if err := s.CheckSourceAccess(ctx, owner, file.ID, doc.Epoch, true); err != nil {
		t.Fatalf("edit admission behind a workspace writer: %v", err)
	}
}

// lockStep is one row a writer locks: its statement and the row's id.
type lockStep struct{ sql, id string }

const (
	lockWorkspaceRow  = `SELECT 1 FROM workspaces WHERE id=$1 FOR UPDATE`
	lockAccountRow    = `SELECT 1 FROM users WHERE id=$1 FOR NO KEY UPDATE`
	lockAttemptRow    = `SELECT 1 FROM attempts WHERE id=$1 FOR UPDATE`
	lockAssignmentRow = `SELECT 1 FROM assignments WHERE id=$1 FOR UPDATE`
	lockMaterialRow   = `SELECT 1 FROM materials WHERE id=$1 FOR UPDATE`
)

// holdThenRun locks first as a writer does, waits until run is blocked behind
// it, then goes on to lock next. A run that took any of next before waiting
// deadlocks here (40P01), and one of the two is refused.
func holdThenRun(t *testing.T, s *Store, first lockStep, next []lockStep, run func(context.Context) error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	writer, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(ctx, first.sql, first.id); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	waitBlockedBy(t, ctx, s, writer)
	for _, step := range next {
		if _, err := writer.Exec(ctx, step.sql, step.id); err != nil {
			t.Errorf("writer: %v", err)
			break
		}
	}
	_ = writer.Rollback(context.Background())
	if err := <-done; err != nil {
		t.Errorf("run after the writer: %v", err)
	}
}

// TestStudyWritesTakeTheWorkspaceFirst: staff writes and teardown take the
// workspace FOR UPDATE and then accounts and rows, so a learner's write whose
// foreign key waits on that row while it holds its account or its attempt
// deadlocks with them. Each takes the row FOR KEY SHARE before anything else.
func TestStudyWritesTakeTheWorkspaceFirst(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	answers := map[string]any{"p1": []any{float64(1)}, "p2": "osmosis"}
	assigned := func(t *testing.T, label string) (assignmentFixture, Assignment) {
		t.Helper()
		f := newAssignmentFixture(t, label)
		created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
		if err != nil {
			t.Fatal(err)
		}
		return f, created
	}
	running := func(t *testing.T, label string) (assignmentFixture, Assignment, AssignmentAttempt) {
		t.Helper()
		f, created := assigned(t, label)
		run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
		if err != nil {
			t.Fatal(err)
		}
		return f, created, run
	}
	// A running attempt with something saved, past its time because it closed
	// longer ago than the grace.
	overrun := func(t *testing.T, label string) (assignmentFixture, AssignmentAttempt) {
		t.Helper()
		f, created, run := running(t, label)
		if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, answers, now); err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now.Add(-2*assignmentGrace)); err != nil {
			t.Fatal(err)
		}
		return f, run
	}
	workspace := func(f assignmentFixture) lockStep { return lockStep{lockWorkspaceRow, f.ws.ID} }

	t.Run("start", func(t *testing.T) {
		f, created := assigned(t, "locks-start")
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAccountRow, f.viewer}}, func(ctx context.Context) error {
			_, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
			return err
		})
	})
	t.Run("submit", func(t *testing.T) {
		f, _, run := running(t, "locks-submit")
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAccountRow, f.viewer}, {lockAttemptRow, run.ID}}, func(ctx context.Context) error {
			_, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, answers, now)
			return err
		})
	})
	t.Run("sweep", func(t *testing.T) {
		f, run := overrun(t, "locks-sweep")
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAttemptRow, run.ID}}, func(ctx context.Context) error {
			return f.s.finishAttemptIfRunning(ctx, run.ID, now)
		})
		var submitted *time.Time
		if err := f.s.pool.QueryRow(ctx, `SELECT submitted_at FROM attempts WHERE id=$1`, run.ID).Scan(&submitted); err != nil || submitted == nil {
			t.Errorf("the sweep left it running: %v, %v", submitted, err)
		}
	})
	t.Run("save past its time", func(t *testing.T) {
		f, run := overrun(t, "locks-save")
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAttemptRow, run.ID}}, func(ctx context.Context) error {
			if err := f.s.SaveAssignmentAnswers(ctx, f.viewer, run.ID, answers, now); !errors.Is(err, ErrAttemptFinished) {
				return fmt.Errorf("save = %w", err)
			}
			return nil
		})
	})
	t.Run("review check", func(t *testing.T) {
		f := newAssignmentFixture(t, "locks-review")
		graded, given := gradeAttempt(frozenFixture(t), answers)
		score := 1.0
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAccountRow, f.viewer}}, func(ctx context.Context) error {
			return f.s.RateItem(ctx, f.viewer, Rating{MaterialID: f.quiz.ID, ItemID: "q1", Score: &score, Graded: graded[0], Answers: given}, now)
		})
	})
	t.Run("quiz check", func(t *testing.T) {
		f := newAssignmentFixture(t, "locks-quiz")
		graded, given := gradeAttempt(frozenFixture(t), answers)
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAccountRow, f.viewer}}, func(ctx context.Context) error {
			_, err := f.s.CheckQuizQuestion(ctx, f.viewer, f.quiz.ID, QuizCheck{
				Answers: given, Question: graded[0], Order: []string{"q1", "q2", "q3"}, Marks: map[string]float64{"q1": 1, "q2": 2, "q3": 3},
			}, now)
			return err
		})
	})
	closed := func(t *testing.T, label string) (assignmentFixture, Assignment) {
		t.Helper()
		f, created, run := running(t, label)
		if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, answers, now); err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SetAssignmentClosed(ctx, f.user, created.ID, true, now); err != nil {
			t.Fatal(err)
		}
		return f, created
	}
	t.Run("release", func(t *testing.T) {
		f, created := closed(t, "locks-release")
		holdThenRun(t, f.s, workspace(f), []lockStep{{lockAssignmentRow, created.ID}}, func(ctx context.Context) error {
			return f.s.releaseAssignment(ctx, created.ID, now)
		})
	})
	// Purging a quiz deletes the material and its foreign key then takes the
	// assignment; an account purge does that with no workspace row held.
	t.Run("release against a purge of its quiz", func(t *testing.T) {
		f, created := closed(t, "locks-release-purge")
		if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET hidden=true WHERE id=$1`, f.quiz.ID); err != nil {
			t.Fatal(err)
		}
		holdThenRun(t, f.s, lockStep{lockMaterialRow, f.quiz.ID}, []lockStep{{lockAssignmentRow, created.ID}}, func(ctx context.Context) error {
			return f.s.releaseAssignment(ctx, created.ID, now)
		})
	})
}
