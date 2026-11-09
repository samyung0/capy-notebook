package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// logPractice adds one practice check of question q of quiz material in a quiz
// attempt at at, with the question's hash from its earlier answers.
func logPractice(t *testing.T, f assignmentFixture, material, user, attempt, question string, awarded float64, at time.Time) {
	t.Helper()
	if _, err := f.s.pool.Exec(context.Background(), `INSERT INTO answer_events (user_id, workspace_id, material_id, question_id, item_hash,
			source, attempt_id, key_seen, created_at, part_id, answer_type, awarded, marks, grader)
		VALUES ($1, $2, $3, $4, COALESCE((SELECT item_hash FROM answer_events WHERE material_id=$3 AND question_id=$4 LIMIT 1), 'h'),
			'quiz', $5, false, $6, $4 || 'p', 'mcq', $7, 1, 'deterministic')`,
		user, f.ws.ID, material, question, attempt, at, awarded); err != nil {
		t.Fatal(err)
	}
}

// fillStorage puts a member at their Free plan's storage limit.
func fillStorage(t *testing.T, f assignmentFixture, user string) {
	t.Helper()
	if _, err := f.s.pool.Exec(context.Background(), `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`,
		user, mustPlanLimits(t, f.s, PlanFree).StorageBytes); err != nil {
		t.Fatal(err)
	}
}

// ownPractice makes a member's own practice quiz in the class ("In class, only
// them"): it has no workspace.
func ownPractice(t *testing.T, f assignmentFixture, user string) Material {
	t.Helper()
	made, err := f.s.CreateMaterialDraft(context.Background(), MaterialDraft{
		ActorUserID: user, Kind: "quiz", Title: "My own practice",
		Questions: json.RawMessage(assignmentQuestions), PracticeWorkspaceID: f.ws.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return made
}

// TestMembersProgress: staff read every viewer member's line, from the
// submission that counts, practice counted over the week and storage full;
// members and outsiders are refused.
func TestMembersProgress(t *testing.T) {
	f := newAssignmentFixture(t, "members-progress")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	// q1 right, q2 wrong, the open q3 waiting: 1 of the 3 marks decided.
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "diffusion", "p3": "Water moves in",
	}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	logPractice(t, f, f.quiz.ID, f.viewer, "pa1", "q1", 1, now.Add(-24*time.Hour))
	logPractice(t, f, f.quiz.ID, f.viewer, "pa1", "q2", 0, now.Add(-24*time.Hour))
	logPractice(t, f, f.quiz.ID, f.viewer, "pa0", "q1", 1, now.Add(-10*24*time.Hour))
	fillStorage(t, f, f.other)

	later := now.Add(2 * time.Hour)
	for _, staff := range []string{f.user, f.editor} {
		got, err := f.s.WorkspaceMembersProgress(ctx, staff, f.ws.ID, later)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Members) != 2 {
			t.Fatalf("members = %+v, want the two viewers", got.Members)
		}
		by := map[string]MemberProgress{}
		for _, mp := range got.Members {
			by[mp.UserID] = mp
		}
		v, o := by[f.viewer], by[f.other]
		if v.Assigned != 1 || v.Done != 1 || v.Missing != 0 || v.Overall == nil || *v.Overall != 1.0/3 {
			t.Fatalf("the viewer = %+v overall %v", v.MemberMarks, v.Overall)
		}
		if v.PracticeWeek != 2 || v.StorageFull {
			t.Fatalf("the viewer's practice %d, storage full %v", v.PracticeWeek, v.StorageFull)
		}
		if o.Assigned != 1 || o.Done != 0 || o.Missing != 1 || o.Overall != nil || !o.StorageFull {
			t.Fatalf("the other member = %+v, storage full %v", o.MemberMarks, o.StorageFull)
		}
		// An assigned quiz counts only what was answered, as Summary does.
		if len(v.Topics) != 1 || v.Topics[0].Asked != 2 || len(got.Topics) != 1 || got.Topics[0].Questions != 2 {
			t.Fatalf("topics = %+v, columns %+v", v.Topics, got.Topics)
		}
	}

	if _, err := f.s.WorkspaceMembersProgress(ctx, f.viewer, f.ws.ID, later); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a member read Members: %v", err)
	}
	outsider := newBlobTestUser(t, f.s, "members-progress-outsider")
	if _, err := f.s.WorkspaceMembersProgress(ctx, outsider, f.ws.ID, later); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an outsider read Members: %v", err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='personal' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.WorkspaceMembersProgress(ctx, f.user, f.ws.ID, later); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a personal workspace has Members: %v", err)
	}
}

// TestMembersStandingsMatchSummary: the class's labels read at once are each
// member's own Summary (topicStandings read as them), with an assigned quiz,
// a member's own practice quiz in a topic and grades held for release.
func TestMembersStandingsMatchSummary(t *testing.T) {
	f := newAssignmentFixture(t, "members-standings")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	topic := "ch_" + f.ws.ID
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO topics (id, workspace_id, name, position) VALUES ($1, $2, 'Cells', 0)`, topic, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	own := ownPractice(t, f, f.viewer)
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET practice_topic_id=$2 WHERE id=$1`, own.ID, topic); err != nil {
		t.Fatal(err)
	}
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	held := f.form(t, now.Add(time.Hour))
	held.ShowGrades = GradesManual
	manual, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, held, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, take := range []struct{ user, id string }{{f.viewer, created.ID}, {f.other, manual.ID}} {
		run, err := f.s.StartAssignment(ctx, take.user, take.id, false, now)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.s.SubmitAssignmentAttempt(ctx, take.user, run.ID, map[string]any{"p1": []any{float64(1)}, "p2": "diffusion"}, now.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	logPractice(t, f, own.ID, f.viewer, "own1", "q1", 0, now.Add(2*time.Minute))
	logPractice(t, f, own.ID, f.viewer, "own1", "q2", 1, now.Add(2*time.Minute))
	logPractice(t, f, f.quiz.ID, f.other, "pa1", "q3", 1, now.Add(3*time.Minute))

	at := now.Add(time.Hour)
	members := []string{f.viewer, f.other}
	got, err := f.s.membersStandings(ctx, f.ws.ID, members, at)
	if err != nil {
		t.Fatal(err)
	}
	for _, member := range members {
		want, err := f.s.topicStandings(ctx, member, f.ws.ID, at)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got[member], want) {
			t.Fatalf("%s: read at once %+v, their Summary %+v", member, got[member], want)
		}
	}
	if len(got[f.viewer]) != 2 || len(got[f.other]) != 1 {
		t.Fatalf("the viewer's topics %+v, the other member's %+v", got[f.viewer], got[f.other])
	}
}

type queryCounter struct{ n atomic.Int64 }

func (c *queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.n.Add(1)
	return ctx
}

func (c *queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// TestMembersProgressQueriesStayFlat (Q723, finding 3): Members reads a class
// of five in as many queries as a class of two.
func TestMembersProgressQueriesStayFlat(t *testing.T) {
	f := newAssignmentFixture(t, "members-queries")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now); err != nil {
		t.Fatal(err)
	}
	logPractice(t, f, f.quiz.ID, f.viewer, "pa1", "q1", 1, now)
	counter := &queryCounter{}
	config := f.s.pool.Config().Copy()
	config.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	counted := NewWithPool(pool)
	if err := counted.LoadPlanLimits(ctx); err != nil {
		t.Fatal(err)
	}
	queries := func(want int) int64 {
		t.Helper()
		counter.n.Store(0)
		got, err := counted.WorkspaceMembersProgress(ctx, f.user, f.ws.ID, now)
		if err != nil {
			t.Fatal(err)
		}
		if len(got.Members) != want {
			t.Fatalf("members = %d, want %d", len(got.Members), want)
		}
		return counter.n.Load()
	}
	queries(2) // parses the quiz once
	two := queries(2)
	for i, label := range []string{"a", "b", "c"} {
		member := newBlobTestUser(t, f.s, "members-queries-"+label)
		if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`, f.ws.ID, member); err != nil {
			t.Fatal(err)
		}
		logPractice(t, f, f.quiz.ID, member, "pa"+label, "q1", float64(i%2), now)
		fillStorage(t, f, member)
	}
	if five := queries(5); five != two {
		t.Fatalf("five members took %d queries, two took %d", five, two)
	}
}

// TestMemberProfile: the profile lists the assignment with its counted mark,
// the question still missed with its prompt, recent work and full storage;
// only staff read it, and only of the class's own viewer member.
func TestMemberProfile(t *testing.T) {
	f := newAssignmentFixture(t, "member-profile")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "diffusion",
	}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	logPractice(t, f, f.quiz.ID, f.viewer, "pa1", "q2", 0, now.Add(2*time.Minute))
	fillStorage(t, f, f.viewer)

	got, err := f.s.WorkspaceMemberProfile(ctx, f.editor, f.ws.ID, f.viewer, now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Assignments) != 1 {
		t.Fatalf("assignments = %+v", got.Assignments)
	}
	a := got.Assignments[0]
	if a.AttemptID == nil || *a.AttemptID != run.ID || a.Mark == nil || *a.Mark != 1 || a.Total == nil || *a.Total != 6 || a.DoneAt == nil {
		t.Fatalf("the assignment = %+v", a)
	}
	if got.Overall == nil || got.LastActiveAt == nil || len(got.Topics) != 1 || !got.StorageFull {
		t.Fatalf("overall %v, last active %v, topics %+v, storage full %v", got.Overall, got.LastActiveAt, got.Topics, got.StorageFull)
	}
	if len(got.Missed) != 1 || got.Missed[0].QuestionID != "q2" || got.Missed[0].Text != "Name it" || got.Missed[0].Misses != 2 {
		t.Fatalf("missed = %+v, want q2 missed twice", got.Missed)
	}
	if len(got.Activity) != 2 || got.Activity[0].Kind != "practice" || got.Activity[0].Questions != 1 ||
		got.Activity[1].Kind != "assignment" || got.Activity[1].Title != "Paper" {
		t.Fatalf("activity = %+v", got.Activity)
	}

	if _, err := f.s.WorkspaceMemberProfile(ctx, f.other, f.ws.ID, f.viewer, now); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a member read another's profile: %v", err)
	}
	if _, err := f.s.WorkspaceMemberProfile(ctx, f.user, f.ws.ID, f.editor, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a teaching assistant has a profile: %v", err)
	}
	outsider := newBlobTestUser(t, f.s, "member-profile-outsider")
	if _, err := f.s.WorkspaceMemberProfile(ctx, outsider, f.ws.ID, f.viewer, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an outsider read a profile: %v", err)
	}
	// Another class's viewer is nobody here.
	elsewhere, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Other class", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, elsewhere.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'viewer')`, elsewhere.ID, outsider); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.WorkspaceMemberProfile(ctx, f.user, f.ws.ID, outsider, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another class's viewer has a profile here: %v", err)
	}
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`, f.ws.ID, f.viewer); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.WorkspaceMemberProfile(ctx, f.user, f.ws.ID, f.viewer, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed member has a profile: %v", err)
	}
}

// TestMemberProfileKeepsOwnPracticePrivate (security regression: Members review
// finding 2, Q723): a member's own practice quiz leaves its misses out of Still
// missing and its title out of Recent activity.
func TestMemberProfileKeepsOwnPracticePrivate(t *testing.T) {
	f := newAssignmentFixture(t, "member-profile-private")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	own := ownPractice(t, f, f.viewer)
	logPractice(t, f, own.ID, f.viewer, "own1", "q1", 0, now)
	logPractice(t, f, f.quiz.ID, f.viewer, "pa1", "q2", 0, now.Add(time.Minute))

	got, err := f.s.WorkspaceMemberProfile(ctx, f.user, f.ws.ID, f.viewer, now.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Missed) != 1 || got.Missed[0].MaterialID != f.quiz.ID {
		t.Fatalf("missed = %+v, want the class quiz's miss alone", got.Missed)
	}
	if len(got.Activity) != 2 || got.Activity[1].Kind != "review" || got.Activity[1].Title != "" {
		t.Fatalf("activity = %+v, want their own practice as a review with no title", got.Activity)
	}
}

// TestStillMissingWaitsForGrades (Q723, finding 7): under Show grades Manual a
// wrong answer joins Still missing when staff release the grades, as labels do.
func TestStillMissingWaitsForGrades(t *testing.T) {
	f := newAssignmentFixture(t, "member-profile-grades")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	form := f.form(t, now.Add(time.Hour))
	form.ShowGrades = GradesManual
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, form, now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, false, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{"p2": "diffusion"}, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	missed := func() []MissedQuestion {
		t.Helper()
		got, err := f.s.WorkspaceMemberProfile(ctx, f.user, f.ws.ID, f.viewer, now.Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		return got.Missed
	}
	if got := missed(); len(got) != 0 {
		t.Fatalf("still missing before release = %+v", got)
	}
	if _, _, err := f.s.ReleaseAssignmentGrades(ctx, f.user, created.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got := missed(); len(got) != 1 || got[0].QuestionID != "q2" {
		t.Fatalf("still missing after release = %+v", got)
	}
}
