package store

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

func TestWithReasons(t *testing.T) {
	items := []ReviewItem{{MaterialID: "m", ItemID: "new"}, {MaterialID: "m", ItemID: "missed"}, {MaterialID: "m", ItemID: "faded"}}
	fresh := []ranked{{studyItem: studyItem{ReviewItem: ReviewItem{MaterialID: "m", ItemID: "new"}}}}
	history := map[string][]review.Rating{
		"m/missed": {review.Good, review.Again},
		"m/faded":  {review.Good, review.Hard},
	}
	withReasons(items, fresh, history)
	if items[0].Reason != ReasonNew || items[1].Reason != ReasonMissed || items[2].Reason != ReasonFading {
		t.Fatalf("reasons = %+v", items)
	}
}

// The Practice page lists the quiz with its questions and the caller's best
// attempt; owners and editors also see how many viewer members tried it, and
// the group average once five did. Topic sessions say why each item came.
func TestWorkspacePractice(t *testing.T) {
	f := newStudyFixture(t, "u_practice")
	ctx := context.Background()
	quiz := f.quiz(t)

	got, err := f.s.WorkspacePractice(ctx, f.user, f.ws.ID, false, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Quizzes) != 1 || got.Quizzes[0].ID != quiz.ID || got.Quizzes[0].Questions != 2 || got.Quizzes[0].Best != nil || got.Members != nil {
		t.Fatalf("practice before an attempt = %+v", got)
	}
	session, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, true, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range session.Items {
		if it.Reason != ReasonNew {
			t.Fatalf("an unrated question served as %q", it.Reason)
		}
	}

	// One of two right: q1 rated Good, q2 missed.
	checkQuiz(t, f.s, f.user, quiz.ID, []byte(studySnapshot), studyAnswers)
	session, err = f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, true, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, it := range session.Items {
		reasons[it.ItemID] = it.Reason
	}
	if reasons["q1"] != ReasonFading || reasons["q2"] != ReasonMissed {
		t.Fatalf("reasons after the attempt = %v", reasons)
	}

	// Five viewer members tried it, one twice; an editor's attempt is left out.
	addAttempt := func(user string, correct float64) {
		if _, err := f.s.pool.Exec(ctx, `INSERT INTO attempts (id, user_id, material_id, kind, correct, total, pct)
			VALUES ($1,$2,$3,'quiz',$4,2,0)`, uuid.NewString(), user, quiz.ID, correct); err != nil {
			t.Fatal(err)
		}
	}
	join := func(label, role string) string {
		user := newBlobTestUser(t, f.s, label)
		if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)`, f.ws.ID, user, role); err != nil {
			t.Fatal(err)
		}
		return user
	}
	for i, score := range []float64{2, 2, 1, 1, 0} {
		user := join("u_practice_viewer"+string(rune('a'+i)), "viewer")
		addAttempt(user, score)
		if i == 4 {
			addAttempt(user, 2)
		}
	}
	addAttempt(join("u_practice_editor", "editor"), 0)
	join("u_practice_idle", "viewer")

	got, err = f.s.WorkspacePractice(ctx, f.user, f.ws.ID, true, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	q := got.Quizzes[0]
	if q.Best == nil || q.Best.Correct != 1 || q.Best.Total != 2 {
		t.Fatalf("best = %+v", q.Best)
	}
	if got.Members == nil || *got.Members != 6 || q.TriedBy == nil || *q.TriedBy != 5 {
		t.Fatalf("members = %v, tried by %v", got.Members, q.TriedBy)
	}
	// Best scores 1, 1, 0.5, 0.5 and 1 average 0.8.
	if q.Average == nil || *q.Average < 0.799 || *q.Average > 0.801 {
		t.Fatalf("average = %v", q.Average)
	}
}

// The Dashboard names the owner and counts members (the owner included); its
// Activity lists files and materials newest first with who added them,
// leaving trashed ones out.
func TestWorkspaceDashboard(t *testing.T) {
	f := newStudyFixture(t, "u_dashboard")
	ctx := context.Background()
	member := newBlobTestUser(t, f.s, "u_dashboard_member")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, member); err != nil {
		t.Fatal(err)
	}
	quiz := f.quiz(t)
	trashed := f.set(t, [2]string{"Golgi", "Ships proteins"})
	if _, err := f.s.TrashMaterial(ctx, f.user, trashed[0].MaterialID, "", AgentOperation{}); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.WorkspaceDashboard(ctx, member, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.OwnerName == "" || got.Members != 2 {
		t.Fatalf("dashboard header = %+v", got)
	}
	if len(got.Activity) != 1 || got.Activity[0].Kind != ActivityAdded || *got.Activity[0].MaterialID != quiz.ID || got.Activity[0].ActorID != f.user {
		t.Fatalf("activity = %+v", got.Activity)
	}
}
