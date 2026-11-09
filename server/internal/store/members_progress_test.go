package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// logPractice adds one practice check of question q in a quiz attempt at at,
// with the question's hash from its earlier answers.
func logPractice(t *testing.T, f assignmentFixture, user, attempt, question string, awarded float64, at time.Time) {
	t.Helper()
	if _, err := f.s.pool.Exec(context.Background(), `INSERT INTO answer_events (user_id, workspace_id, material_id, question_id, item_hash,
			source, attempt_id, key_seen, created_at, part_id, answer_type, awarded, marks, grader)
		VALUES ($1, $2, $3, $4, COALESCE((SELECT item_hash FROM answer_events WHERE material_id=$3 AND question_id=$4 LIMIT 1), 'h'),
			'quiz', $5, false, $6, $4 || 'p', 'mcq', $7, 1, 'deterministic')`,
		user, f.ws.ID, f.quiz.ID, question, attempt, at, awarded); err != nil {
		t.Fatal(err)
	}
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
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	// q1 right, q2 wrong, the open q3 waiting: 1 of the 3 marks decided.
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "diffusion", "p3": "Water moves in",
	}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	logPractice(t, f, f.viewer, "pa1", "q1", 1, now.Add(-24*time.Hour))
	logPractice(t, f, f.viewer, "pa1", "q2", 0, now.Add(-24*time.Hour))
	logPractice(t, f, f.viewer, "pa0", "q1", 1, now.Add(-10*24*time.Hour))
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO user_storage (user_id, used_bytes) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes=EXCLUDED.used_bytes`,
		f.other, mustPlanLimits(t, f.s, PlanFree).StorageBytes); err != nil {
		t.Fatal(err)
	}

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

// TestMemberProfile: the profile lists the assignment with its counted mark,
// the question still missed with its prompt, and recent work; only staff read
// it, and only of a viewer member.
func TestMemberProfile(t *testing.T) {
	f := newAssignmentFixture(t, "member-profile")
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	created, err := f.s.CreateAssignment(ctx, f.user, f.ws.ID, f.form(t, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.s.StartAssignment(ctx, f.viewer, created.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.SubmitAssignmentAttempt(ctx, f.viewer, run.ID, map[string]any{
		"p1": []any{float64(1)}, "p2": "diffusion",
	}, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	logPractice(t, f, f.viewer, "pa1", "q2", 0, now.Add(2*time.Minute))

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
	if got.Overall == nil || got.LastActiveAt == nil || len(got.Topics) != 1 {
		t.Fatalf("overall %v, last active %v, topics %+v", got.Overall, got.LastActiveAt, got.Topics)
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
}
