package store

import (
	"context"
	"sort"
	"time"
)

// A workspace's Practice page (Epo 2026-11-03, boards P1 and P2). Every quiz
// the caller can see is practice: each untrashed, top-level quiz of the
// workspace, hidden ones only for its owners and editors. Topic sessions are today's
// review sessions over questions only, so the page's suggestions are scored
// on questions too.

const (
	// practiceSuggestions caps the page's Suggested list.
	practiceSuggestions = 3
	// practiceAverageMin is how many members must have tried a quiz before
	// its group average shows (Epo 2026-11-03, §11.8: aggregates need at
	// least 5 members).
	practiceAverageMin = 5
)

type Practice struct {
	// Suggestions are this workspace's suggested reviews over its questions,
	// at most three, while study progress shows.
	Suggestions []ReviewSuggestion `json:"suggestions" nullable:"false"`
	Quizzes     []PracticeQuiz     `json:"quizzes" nullable:"false"`
	// Reviews are the caller's own topic reviews ("Only you"), one per topic
	// (or Other files), latest first.
	Reviews []PracticeReview `json:"reviews" nullable:"false"`
	// Members counts the workspace's viewer members; a class's owner and
	// editors only.
	Members *int `json:"members,omitempty"`
}

// PracticeQuiz is one quiz members can see, in reading order.
type PracticeQuiz struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	TopicID   *string `json:"topicId,omitempty"`
	Questions int     `json:"questions"`
	// Best is the caller's best attempt by share of marks.
	Best *SessionScore `json:"best,omitempty"`
	// TriedBy counts viewer members with an attempt; a class's owner and
	// editors only.
	TriedBy *int `json:"triedBy,omitempty"`
	// Average is the mean of those members' best scores (0 to 1), once at
	// least five of them tried; a class's owner and editors only.
	Average *float64 `json:"average,omitempty"`
	// AssignmentClosedAt is when the assignment it was given as closed, which
	// made it practice (Epo 2026-11-03).
	AssignmentClosedAt *time.Time `json:"assignmentClosedAt,omitempty"`
}

// PracticeReview is the caller's reviews of one topic (or of Other files)
// that answered a question.
type PracticeReview struct {
	Group   string  `json:"group" enum:"topic,others"`
	TopicID *string `json:"topicId,omitempty"`
	// Questions is the latest session's served item count.
	Questions int `json:"questions"`
	// Best is the session with the best share of marks.
	Best   SessionScore `json:"best"`
	LastAt time.Time    `json:"lastAt"`
}

// WorkspacePractice reads the Practice page. A class's owner and editors
// (canEdit) manage it: the quizzes with the members' use of each, never their
// answers, and nothing of their own. Everyone else, and everyone in a personal
// workspace where each sees only their own, practises: suggestions, the quizzes
// and their own reviews (Epo 2026-11-04, board U3).
func (s *Store) WorkspacePractice(ctx context.Context, userID, wsID string, canEdit bool, now time.Time) (Practice, error) {
	out := Practice{Suggestions: []ReviewSuggestion{}, Quizzes: []PracticeQuiz{}, Reviews: []PracticeReview{}}
	var kind WorkspaceKind
	if err := s.pool.QueryRow(ctx, `SELECT kind FROM workspaces WHERE id=$1`, wsID).Scan(&kind); err != nil {
		return out, err
	}
	if err := s.practiceQuizzes(ctx, userID, wsID, &out); err != nil {
		return out, err
	}
	if canEdit && kind == WorkspaceClass {
		return out, s.practiceMembers(ctx, wsID, &out)
	}
	if err := s.practiceSuggestions(ctx, userID, wsID, &out, now); err != nil {
		return out, err
	}
	return out, s.practiceReviews(ctx, userID, wsID, &out)
}

func (s *Store) practiceSuggestions(ctx context.Context, userID, wsID string, out *Practice, now time.Time) error {
	on, err := s.StudyEnabled(ctx, userID, wsID)
	if err != nil || !on {
		return err
	}
	prefsRaw, err := s.StudyPreferencesOf(ctx, userID)
	if err != nil {
		return err
	}
	prefs := reviewPrefsOf(prefsRaw)
	prefs.Items = "quiz"
	items, history, err := s.scoredWorkspace(ctx, userID, wsID, prefs, now)
	if err != nil {
		return err
	}
	// The learner is in this workspace now, so its interest is full.
	list := groupSuggestions(items, history, 1)
	if len(list) > practiceSuggestions {
		list = list[:practiceSuggestions]
	}
	if err := s.nameTopics(ctx, list); err != nil {
		return err
	}
	out.Suggestions = append(out.Suggestions, list...)
	return nil
}

// practiceQuizzes lists the quizzes in reading order (topics in order, then
// unfiled) with their question counts and the caller's best attempt. A quiz
// whose stored content the current rules refuse is left out, as itemCounts
// leaves it out.
func (s *Store) practiceQuizzes(ctx context.Context, userID, wsID string, out *Practice) error {
	sizes, err := s.itemCounts(ctx, userID, wsID)
	if err != nil {
		return err
	}
	size := make(map[string]int, len(sizes))
	for _, it := range sizes {
		size[it.MaterialID] = it.Size
	}
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.title, m.topic_id FROM materials m
		LEFT JOIN topics t ON t.id=m.topic_id
		WHERE m.workspace_id=$1 AND m.kind='quiz' AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
			AND workspace_item_visible(m.hidden, m.workspace_id, $2)
			AND `+quizAssignedToSQL("m.id", "$2")+` IS NULL
		ORDER BY m.topic_id IS NULL, t.position, m.position, m.created_at DESC, m.id`, wsID, userID)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var q PracticeQuiz
		if err := rows.Scan(&q.ID, &q.Title, &q.TopicID); err != nil {
			rows.Close()
			return err
		}
		n, ok := size[q.ID]
		if !ok {
			continue
		}
		q.Questions = n
		ids = append(ids, q.ID)
		out.Quizzes = append(out.Quizzes, q)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return err
	}
	at := make(map[string]int, len(out.Quizzes))
	for i, q := range out.Quizzes {
		at[q.ID] = i
	}
	if err := s.practiceClosedAssignments(ctx, wsID, at, out); err != nil {
		return err
	}
	rows, err = s.pool.Query(ctx, `SELECT DISTINCT ON (material_id) material_id, correct::float8, total::float8
		FROM attempts WHERE user_id=$1 AND material_id = ANY($2) AND kind='quiz' AND total > 0
		ORDER BY material_id, correct / total DESC, taken_at DESC`, userID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var best SessionScore
		if err := rows.Scan(&id, &best.Correct, &best.Total); err != nil {
			return err
		}
		out.Quizzes[at[id]].Best = &best
	}
	return rows.Err()
}

// practiceClosedAssignments notes each quiz whose assignment has closed.
func (s *Store) practiceClosedAssignments(ctx context.Context, wsID string, at map[string]int, out *Practice) error {
	// Closing is what released it: at the due date under No late submissions, else
	// by hand. A reopened one keeps the time it was released.
	rows, err := s.pool.Query(ctx, `SELECT source_quiz_id,
			max(COALESCE(CASE WHEN no_late THEN LEAST(closed_at, due_at) ELSE closed_at END, released_at))
		FROM assignments WHERE workspace_id=$1 AND source_quiz_id IS NOT NULL AND released_at IS NOT NULL
		GROUP BY source_quiz_id`, wsID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var closed time.Time
		if err := rows.Scan(&id, &closed); err != nil {
			return err
		}
		if i, ok := at[id]; ok {
			out.Quizzes[i].AssignmentClosedAt = &closed
		}
	}
	return rows.Err()
}

// practiceMembers counts the viewer members and, per quiz, those who tried it
// and the mean of their best scores once enough tried. Owners and editors
// are not counted: assignments and practice are for members who study.
func (s *Store) practiceMembers(ctx context.Context, wsID string, out *Practice) error {
	var members int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND role='viewer'`, wsID).
		Scan(&members); err != nil {
		return err
	}
	out.Members = &members
	ids := make([]string, len(out.Quizzes))
	at := make(map[string]int, len(out.Quizzes))
	for i, q := range out.Quizzes {
		ids[i], at[q.ID] = q.ID, i
		zero := 0
		out.Quizzes[i].TriedBy = &zero
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `WITH best AS (
			SELECT a.material_id, a.user_id, max(a.correct / a.total)::float8 AS score
			FROM attempts a JOIN workspace_members wm ON wm.user_id=a.user_id AND wm.workspace_id=$1 AND wm.role='viewer'
			WHERE a.material_id = ANY($2) AND a.kind='quiz' AND a.total > 0
			GROUP BY a.material_id, a.user_id)
		SELECT material_id, count(*), avg(score) FROM best GROUP BY material_id`, wsID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var tried int
		var avg float64
		if err := rows.Scan(&id, &tried, &avg); err != nil {
			return err
		}
		q := &out.Quizzes[at[id]]
		q.TriedBy = &tried
		if tried >= practiceAverageMin {
			q.Average = &avg
		}
	}
	return rows.Err()
}

// practiceReviews groups the caller's topic and Other files sessions that
// answered a question: the latest session's size, the best session's marks.
// Sessions whose topic was deleted (topic NULL in a topic group) drop.
func (s *Store) practiceReviews(ctx context.Context, userID, wsID string, out *Practice) error {
	rows, err := s.pool.Query(ctx, `WITH s AS (
			SELECT rs.group_kind, rs.topic_id, rs.last_answer_at, jsonb_array_length(rs.items) AS served,
				(SELECT sum(correct) FROM review_answers WHERE session_id=rs.id AND kind='question')::float8 AS qc,
				(SELECT sum(total) FROM review_answers WHERE session_id=rs.id AND kind='question')::float8 AS qt
			FROM review_sessions rs
			WHERE rs.user_id=$1 AND rs.workspace_id=$2
				AND (rs.group_kind='others' OR (rs.group_kind='topic' AND rs.topic_id IS NOT NULL)))
		SELECT DISTINCT ON (group_kind, topic_id) group_kind, topic_id,
			(SELECT served FROM s l WHERE l.group_kind=s.group_kind AND l.topic_id IS NOT DISTINCT FROM s.topic_id AND l.qt > 0
				ORDER BY l.last_answer_at DESC LIMIT 1),
			qc, qt,
			(SELECT max(last_answer_at) FROM s l WHERE l.group_kind=s.group_kind AND l.topic_id IS NOT DISTINCT FROM s.topic_id AND l.qt > 0)
		FROM s WHERE qt > 0
		ORDER BY group_kind, topic_id, qc / qt DESC, last_answer_at DESC`, userID, wsID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var r PracticeReview
		if err := rows.Scan(&r.Group, &r.TopicID, &r.Questions, &r.Best.Correct, &r.Best.Total, &r.LastAt); err != nil {
			return err
		}
		out.Reviews = append(out.Reviews, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.SliceStable(out.Reviews, func(i, j int) bool { return out.Reviews[i].LastAt.After(out.Reviews[j].LastAt) })
	return nil
}
