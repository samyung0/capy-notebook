package store

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// questionTopicsFixture is a workspace with topics Cells and Genetics and a
// quiz filed in Cells whose q2 names topics of its own (Genetics by default).
type questionTopicsFixture struct {
	studyFixture
	cells, genetics string
	qs              []map[string]any
	quiz            Quiz
}

func newQuestionTopicsFixture(t *testing.T, label string) questionTopicsFixture {
	t.Helper()
	return newQuestionTopicsFixtureWith(t, label, func(_, genetics string) []any { return []any{genetics} })
}

// newQuestionTopicsFixtureWith names q2's own topics from the topics' ids.
func newQuestionTopicsFixtureWith(t *testing.T, label string, own func(cells, genetics string) []any) questionTopicsFixture {
	t.Helper()
	f := questionTopicsFixture{studyFixture: newStudyFixture(t, label)}
	ctx := context.Background()
	f.cells, f.genetics = uid("tp"), uid("tp")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO topics (id, workspace_id, name, position) VALUES ($1,$3,'Cells',0), ($2,$3,'Genetics',1)`,
		f.cells, f.genetics, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(studyQuestions), &f.qs); err != nil {
		t.Fatal(err)
	}
	f.qs[1]["topicIds"] = own(f.cells, f.genetics)
	raw, err := json.Marshal(f.qs)
	if err != nil {
		t.Fatal(err)
	}
	if f.quiz, err = f.s.CreateQuiz(ctx, Quiz{UserID: f.user, Name: "Two topics", WorkspaceID: f.ws.ID, WorkspaceName: f.ws.Name,
		Questions: raw, Privacy: PrivacyPrivate}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET topic_id=$2 WHERE id=$1`, f.quiz.ID, f.cells); err != nil {
		t.Fatal(err)
	}
	return f
}

// check answers question i of the quiz in attempt (new when empty).
func (f questionTopicsFixture) check(t *testing.T, attempt string, i int, right bool) string {
	t.Helper()
	q := f.qs[i]
	part := q["parts"].([]any)[0].(map[string]any)
	correct := part["answer"].(map[string]any)["correct"].(bool)
	answers := map[string]any{part["id"].(string): correct == right}
	graded, _, _ := questions.Graded(q, answers, nil)
	d, err := f.s.CheckQuizQuestion(context.Background(), f.user, f.quiz.ID, QuizCheck{
		AttemptID: attempt, Answers: answers, Question: graded,
		Order: []string{"q1", "q2"}, Marks: map[string]float64{"q1": 1, "q2": 1},
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return d.ID
}

// standings is the caller's Summary as "name asked/unattempted" per topic.
func (f questionTopicsFixture) standings(t *testing.T) map[string][2]int {
	t.Helper()
	got, err := f.s.topicStandings(context.Background(), f.user, f.ws.ID, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][2]int{}
	for _, st := range got {
		out[st.Name] = [2]int{st.Asked, st.Unattempted}
	}
	return out
}

// Mastery counts each question under its own topic (Epo 2026-11-15): the
// labels and sizes, the stored answer topic, and Practise a topic, which picks
// by question topic. A question whose topic is gone follows its quiz's, and so
// does one whose quiz moved to a workspace without that topic.
func TestMasteryCountsQuestionsUnderTheirOwnTopic(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_question_topics")
	ctx := context.Background()
	f.check(t, f.check(t, "", 0, true), 1, false)

	if got := f.standings(t); len(got) != 2 || got["Cells"] != [2]int{1, 0} || got["Genetics"] != [2]int{1, 0} {
		t.Fatalf("standings = %v, want q1 under Cells and q2 under Genetics", got)
	}
	if n := f.count(t, `SELECT count(*) FROM answer_events WHERE material_id=$1
		AND topic_ids = ARRAY[CASE question_id WHEN 'q1' THEN $2 ELSE $3 END]`, f.quiz.ID, f.cells, f.genetics); n != 2 {
		t.Fatalf("answers with their question's topic = %d, want 2", n)
	}
	session, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupTopic, TopicID: &f.genetics}, true, ReviewOptions{}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(session.Items) != 1 || session.Items[0].ItemID != "q2" {
		t.Fatalf("Genetics session = %+v, want q2 only", session.Items)
	}
	if n, err := f.s.StudyQuestionCount(ctx, f.user, f.ws.ID, GroupTopic, &f.cells, time.Now()); err != nil || n != 1 {
		t.Fatalf("Cells holds %d questions (%v), want 1", n, err)
	}

	if _, err := f.s.pool.Exec(ctx, `DELETE FROM topics WHERE id=$1`, f.genetics); err != nil {
		t.Fatal(err)
	}
	if got := f.standings(t); len(got) != 1 || got["Cells"] != [2]int{2, 0} {
		t.Fatalf("standings once Genetics is deleted = %v, want both under Cells", got)
	}

	moved, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Elsewhere", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	biology := uid("tp")
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO topics (id, workspace_id, name, position) VALUES ($1,$2,'Biology',0)`, biology, moved.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO topics (id, workspace_id, name, position) VALUES ($1,$2,'Genetics',1)`, f.genetics, f.ws.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET workspace_id=$2, topic_id=$3 WHERE id=$1`, f.quiz.ID, moved.ID, biology); err != nil {
		t.Fatal(err)
	}
	if n, err := f.s.StudyQuestionCount(ctx, f.user, moved.ID, GroupTopic, &biology, time.Now()); err != nil || n != 2 {
		t.Fatalf("the moved quiz's topic holds %d questions (%v), want 2", n, err)
	}
}

// A deleted quiz's answers still count toward the topic each was given in
// (answer_events.topic_ids), a part marked again counting once.
func TestDeletedQuizAnswersKeepTheirTopic(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_question_topics_deleted")
	ctx := context.Background()
	f.check(t, f.check(t, "", 0, true), 1, false)
	// q2 marked again in the same attempt, as an assignment's open part is.
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO answer_events (user_id, workspace_id, material_id, question_id, item_hash,
			source, attempt_id, key_seen, created_at, part_id, answer_type, awarded, marks, grader, topic_ids)
		SELECT user_id, workspace_id, material_id, question_id, item_hash, source, attempt_id, key_seen, created_at,
			part_id, answer_type, marks, marks, grader, topic_ids
		FROM answer_events WHERE material_id=$1 AND question_id='q2'`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM materials WHERE id=$1`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	got, err := f.s.topicStandings(ctx, f.user, f.ws.ID, time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "Cells" || got[0].Right != 1 || got[1].Name != "Genetics" || got[1].Right != 1 || got[1].Wrong != 0 {
		t.Fatalf("standings after the quiz is deleted = %+v", got)
	}
}

// A part of a deleted quiz marked again with no topic (its question had none
// of its own) replaces the earlier mark instead of letting it keep counting.
func TestDeletedQuizRemarkWithoutTopicReplacesTheOldMark(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_question_topics_remark")
	ctx := context.Background()
	f.check(t, f.check(t, "", 0, false), 1, true)
	if _, err := f.s.pool.Exec(ctx, `DELETE FROM materials WHERE id=$1`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO answer_events (user_id, workspace_id, material_id, question_id, item_hash,
			source, attempt_id, key_seen, created_at, part_id, answer_type, awarded, marks, grader, topic_ids)
		SELECT user_id, workspace_id, NULL, question_id, item_hash, source, attempt_id, key_seen, created_at + interval '1 second',
			part_id, answer_type, marks, marks, 'owner', '{}'
		FROM answer_events WHERE material_id IS NULL AND question_id='q1'`); err != nil {
		t.Fatal(err)
	}
	if got := f.standings(t); len(got) != 1 || got["Genetics"] != [2]int{1, 0} {
		t.Fatalf("standings = %v, want Genetics only once q1's mark lost its topic", got)
	}
}

// The topics an answer stores are its own workspace's: an assignment whose
// quiz moved away keeps none of the other workspace's topics.
func TestAnswerTopicIsTheAnswersWorkspaces(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_question_topics_workspace")
	ctx := context.Background()
	other, err := f.s.CreateWorkspace(ctx, f.user, WorkspaceCreate{Name: "Class", Tags: []TagRef{}})
	if err != nil {
		t.Fatal(err)
	}
	graded, _, _ := questions.Graded(f.qs[0], map[string]any{"q1:part:1": true}, nil)
	tx, err := f.s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := logAnswerTx(ctx, tx, f.user, Material{ID: f.quiz.ID, WorkspaceID: other.ID}, graded, map[string]any{"q1:part:1": true},
		answerSourceAssignment, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	var topics []string
	if err := tx.QueryRow(ctx, `SELECT topic_ids FROM answer_events WHERE workspace_id=$1`, other.ID).Scan(&topics); err != nil {
		t.Fatal(err)
	}
	if len(topics) != 0 {
		t.Fatalf("topics = %v, want none from another workspace", topics)
	}
}

// A trashed quiz's answers still count (Epo 2026-11-15): toward its questions'
// topics in the labels and in Frequently wrong, though its questions no longer
// add to a topic's size.
func TestTrashedQuizAnswersCount(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_question_topics_trashed")
	ctx := context.Background()
	f.check(t, f.check(t, "", 0, true), 1, false)
	if _, err := f.s.pool.Exec(ctx, `UPDATE materials SET trashed_at=now(), trash_episode_id='ep_topics', purge_after=now()+interval '30 days' WHERE id=$1`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	if got := f.standings(t); len(got) != 2 || got["Cells"] != [2]int{1, 0} || got["Genetics"] != [2]int{1, 0} {
		t.Fatalf("standings = %v, want q1 under Cells and q2 under Genetics", got)
	}
	topics, err := f.s.topicsOf(ctx, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	missed, err := f.s.memberMissed(ctx, f.ws.ID, f.user, topics)
	if err != nil {
		t.Fatal(err)
	}
	if len(missed) != 1 || missed[0].QuestionID != "q2" || missed[0].TopicName != "Genetics" {
		t.Fatalf("missed = %+v, want q2 under Genetics", missed)
	}
}

// Recent activity groups a day's reviews by each question's topic (Epo
// 2026-11-15).
func TestReviewActivityGroupsByQuestionTopic(t *testing.T) {
	f := newQuestionTopicsFixture(t, "u_question_topics_activity")
	ctx := context.Background()
	if _, err := f.s.pool.Exec(ctx, `INSERT INTO answer_events (user_id, workspace_id, material_id, question_id, item_hash,
			source, key_seen, created_at, part_id, answer_type, awarded, marks, grader)
		SELECT $1, $2, $3, q, 'h', 'review', false, now() - n * interval '1 minute', q || ':part:1', 'boolean', 1, 1, 'deterministic'
		FROM (VALUES ('q1', 1), ('q2', 2)) v(q, n)`, f.user, f.ws.ID, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	topics, err := f.s.topicsOf(ctx, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.s.memberActivity(ctx, f.ws.ID, f.user, topics)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].TopicName != "Cells" || got[0].Questions != 1 || got[1].TopicName != "Genetics" || got[1].Questions != 1 {
		t.Fatalf("activity = %+v, want one review in Cells and one in Genetics", got)
	}
}

// A question with several topics of its own counts fully under each (Epo
// 2026-11-15): q2 on Cells and Genetics is asked in both standings, Practise a
// topic picks it under either, Frequently wrong names both, and its stored
// answer keeps both once its quiz is deleted.
func TestQuestionWithTwoTopicsCountsUnderEach(t *testing.T) {
	f := newQuestionTopicsFixtureWith(t, "u_question_topics_two", func(cells, genetics string) []any { return []any{cells, genetics} })
	ctx := context.Background()
	f.check(t, f.check(t, "", 0, true), 1, false)

	if got := f.standings(t); len(got) != 2 || got["Cells"] != [2]int{2, 0} || got["Genetics"] != [2]int{1, 0} {
		t.Fatalf("standings = %v, want q1 and q2 under Cells and q2 under Genetics", got)
	}
	for _, topic := range []string{f.cells, f.genetics} {
		session, err := f.s.WorkspaceReview(ctx, f.user, f.ws.ID, ReviewSessionInfo{Group: GroupTopic, TopicID: &topic}, true, ReviewOptions{}, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if !slices.ContainsFunc(session.Items, func(it ReviewItem) bool { return it.ItemID == "q2" }) {
			t.Fatalf("session on %s = %+v, want q2 in it", topic, session.Items)
		}
	}
	topics, err := f.s.topicsOf(ctx, f.ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	missed, err := f.s.memberMissed(ctx, f.ws.ID, f.user, topics)
	if err != nil {
		t.Fatal(err)
	}
	if len(missed) != 1 || missed[0].TopicName != "Cells, Genetics" {
		t.Fatalf("missed = %+v, want q2 named under Cells, Genetics", missed)
	}

	if _, err := f.s.pool.Exec(ctx, `DELETE FROM materials WHERE id=$1`, f.quiz.ID); err != nil {
		t.Fatal(err)
	}
	if got := f.standings(t); len(got) != 2 || got["Cells"] != [2]int{2, 0} || got["Genetics"] != [2]int{1, 0} {
		t.Fatalf("standings once the quiz is deleted = %v, want the stored topics", got)
	}
}
