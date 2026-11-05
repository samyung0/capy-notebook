package store

import (
	"context"
	"encoding/json"
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

func TestTopicSessionPrefs(t *testing.T) {
	unset := StudyPreferences{}
	if got := topicSessionPrefs(reviewPrefsOf(unset), unset); got.Size != 10 || got.Items != "quiz" {
		t.Fatalf("no size picked = %+v", got)
	}
	picked := StudyPreferences{ReviewSize: 20}
	if got := topicSessionPrefs(reviewPrefsOf(picked), picked); got.Size != 20 {
		t.Fatalf("20 picked = %+v", got)
	}
}

// A clone keeps its kind for an owner or editor, and is personal for anyone else.
func TestCloneKind(t *testing.T) {
	for _, tc := range []struct {
		source WorkspaceKind
		member WorkspaceRole
		want   WorkspaceKind
	}{
		{WorkspaceClass, RoleOwner, WorkspaceClass},
		{WorkspaceClass, RoleEditor, WorkspaceClass},
		{WorkspaceClass, RoleViewer, WorkspacePersonal},
		{WorkspaceClass, "", WorkspacePersonal},
		{WorkspacePersonal, RoleOwner, WorkspacePersonal},
		{WorkspacePersonal, RoleViewer, WorkspacePersonal},
	} {
		if got := cloneKind(tc.source, tc.member); got != tc.want {
			t.Fatalf("cloneKind(%s, %q) = %s, want %s", tc.source, tc.member, got, tc.want)
		}
	}
}

// The Practice page lists the quiz with its questions and the caller's best
// attempt; a class's owner and editors also see how many viewer members tried
// it, and the group average once five did. In a personal workspace nobody
// does. Topic sessions say why each item came.
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
	session, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, true, ReviewOptions{}, time.Now())
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
	session, err = f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupWorkspace}, true, ReviewOptions{}, time.Now())
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

	// A personal workspace keeps each person to their own.
	got, err = f.s.WorkspacePractice(ctx, f.user, f.ws.ID, true, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got.Members != nil || got.Quizzes[0].TriedBy != nil || got.Quizzes[0].Average != nil {
		t.Fatalf("personal practice shows members: %+v", got)
	}
	class := WorkspaceClass
	if _, err := f.s.UpdateWorkspace(ctx, f.user, f.ws.ID, WorkspacePatch{Kind: &class}); err != nil {
		t.Fatal(err)
	}
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

// A member's own practice quiz is theirs alone: it counts in their Practice and
// stays off the class's files, its owner's Practice included.
func TestMemberPracticeQuiz(t *testing.T) {
	f := newStudyFixture(t, "u_own_practice")
	ctx := context.Background()
	member := newBlobTestUser(t, f.s, "u_own_practice_member")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, member); err != nil {
		t.Fatal(err)
	}
	made, err := f.s.CreateMaterialDraft(ctx, MaterialDraft{
		ActorUserID: member, Kind: "quiz", Title: "My practice",
		Questions: json.RawMessage(studyQuestions), PracticeWorkspaceID: f.ws.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	mine, err := f.s.WorkspacePractice(ctx, member, f.ws.ID, false, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(mine.Quizzes) != 1 || mine.Quizzes[0].ID != made.ID || !mine.Quizzes[0].OnlyYou {
		t.Fatalf("the member's practice = %+v", mine.Quizzes)
	}
	theirs, err := f.s.WorkspacePractice(ctx, f.user, f.ws.ID, true, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(theirs.Quizzes) != 0 {
		t.Fatalf("the owner's practice = %+v", theirs.Quizzes)
	}
}

// The Dashboard names the owner and counts members (the owner included); its
// Activity lists files and materials newest first with who added them,
// leaving trashed ones out, and hidden ones out for a viewer: the owner gets
// them with their mark.
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
	if len(got.Activity) != 1 || got.Activity[0].Hidden || got.Activity[0].Kind != ActivityAdded || *got.Activity[0].MaterialID != quiz.ID || got.Activity[0].ActorID != f.user {
		t.Fatalf("activity = %+v", got.Activity)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET hidden=true WHERE id=$1`, quiz.ID); err != nil {
		t.Fatal(err)
	}
	if got, err = f.s.WorkspaceDashboard(ctx, member, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if len(got.Activity) != 0 {
		t.Fatalf("the viewer's activity lists the hidden quiz: %+v", got.Activity)
	}
	if got, err = f.s.WorkspaceDashboard(ctx, f.user, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if len(got.Activity) != 1 || !got.Activity[0].Hidden {
		t.Fatalf("the owner's activity = %+v", got.Activity)
	}
}

// Learning's Overview offers a member their class and leaves a class's owner
// only its Members row; a first answer moves the quiz from Start to Workspaces
// with its topic's standing, and what was left partway leads the list.
func TestLearningOverview(t *testing.T) {
	f := newStudyFixture(t, "u_learning")
	ctx := context.Background()
	quiz := f.quiz(t)
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_visits (user_id, workspace_id) VALUES ($1,$2)`, f.user, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.LearningOverview(ctx, f.user, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Next) != 1 || got.Next[0].Kind != LearningStart || *got.Next[0].MaterialID != quiz.ID || got.Next[0].Total != 2 {
		t.Fatalf("before an answer, next = %+v", got.Next)
	}
	if len(got.Workspaces) != 1 || got.Workspaces[0].Tried != 0 || got.Workspaces[0].Items < 2 || len(got.Teaches) != 0 {
		t.Fatalf("before an answer, overview = %+v", got)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET kind='class' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	got, err = f.s.LearningOverview(ctx, f.user, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Next) != 0 || len(got.Workspaces) != 0 || len(got.Teaches) != 1 || got.Teaches[0].WorkspaceID != f.ws.ID {
		t.Fatalf("a class's owner, overview = %+v", got)
	}
}

// TestDashboardNamesActorsToMembers (security regression): a link or public
// visitor gets the Dashboard's rows without who did them, as they get no member
// list; members and the owner keep the names. Fails if WorkspaceDashboard stops
// leaving the actor out.
func TestDashboardNamesActorsToMembers(t *testing.T) {
	f := newStudyFixture(t, "u_dashboard_visitor")
	ctx := context.Background()
	member := newBlobTestUser(t, f.s, "u_dashboard_visitor_member")
	visitor := newBlobTestUser(t, f.s, "u_dashboard_visitor_public")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,'viewer')`, f.ws.ID, member); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE workspaces SET privacy='public' WHERE id=$1`, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	quiz := f.quiz(t)
	file := uploadWorkspaceFile(t, f.s, f.user, f.ws.ID)
	got, err := f.s.WorkspaceDashboard(ctx, visitor, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Activity) != 2 {
		t.Fatalf("the visitor's activity = %+v", got.Activity)
	}
	for _, it := range got.Activity {
		if it.ActorID != "" || it.ActorName != "" || it.ActorAvatarURL != "" {
			t.Fatalf("the visitor reads who did it: %+v", it)
		}
	}
	for _, reader := range []string{member, f.user} {
		got, err := f.s.WorkspaceDashboard(ctx, reader, f.ws.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, it := range got.Activity {
			if it.ActorID != f.user || it.ActorName == "" {
				t.Fatalf("%s reads no actor on %+v (quiz %s, file %s)", reader, it, quiz.ID, file.ID)
			}
		}
	}
}
