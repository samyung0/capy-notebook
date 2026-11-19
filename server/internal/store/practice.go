package store

import (
	"context"
	"slices"
	"sort"
	"time"
)

// A workspace's Practice page (Epo 2026-11-03, boards P1 and P2). Every quiz
// and flashcard set the caller can see is practice (sets since Epo
// 2026-11-13): each untrashed, top-level one of the workspace, hidden ones
// only for its owners and editors. Topic sessions are today's
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
	Items       []PracticeItem     `json:"items" nullable:"false"`
	// Reviews are the caller's own topic reviews ("Only you"), one per topic
	// (or Other files), latest first.
	Reviews []PracticeReview `json:"reviews" nullable:"false"`
	// Members counts the workspace's viewer members; a class's owner and
	// editors only.
	Members *int `json:"members,omitempty"`
}

// PracticeItem is one quiz or flashcard set members can see, in reading
// order.
type PracticeItem struct {
	Kind    string  `json:"kind" enum:"quiz,flashcards"`
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	TopicID *string `json:"topicId,omitempty"`
	// Covers is what it covers (Epo 2026-11-15): its topic first, then the
	// workspace's other topics its questions name as their own, in topic
	// order; empty with none.
	Covers []string `json:"covers" nullable:"false"`
	// Size counts a quiz's questions or a set's cards.
	Size int `json:"size"`
	// OnlyYou is the caller's own generated quiz (Make my own practice).
	OnlyYou bool `json:"onlyYou,omitempty"`
	// Best is the caller's best attempt by share of marks (of cards first
	// rated Good or Easy, for a set; only runs through every card).
	Best *SessionScore `json:"best,omitempty"`
	// TriedBy counts viewer members with an attempt (a set's run through
	// every card); a class's owner and editors only.
	TriedBy *int `json:"triedBy,omitempty"`
	// Average is the mean of those members' best scores (0 to 1), once at
	// least five of them tried; a class's owner and editors only.
	Average *float64 `json:"average,omitempty"`
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
	out := Practice{Suggestions: []ReviewSuggestion{}, Items: []PracticeItem{}, Reviews: []PracticeReview{}}
	var kind WorkspaceKind
	if err := s.pool.QueryRow(ctx, `SELECT kind FROM workspaces WHERE id=$1`, wsID).Scan(&kind); err != nil {
		return out, err
	}
	if err := s.practiceItems(ctx, userID, wsID, &out); err != nil {
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

// practiceItems lists the quizzes and sets in reading order (topics in
// order, then unfiled) with their sizes and the caller's best attempt. One
// whose stored content the current rules refuse is left out, as itemCounts
// leaves it out.
func (s *Store) practiceItems(ctx context.Context, userID, wsID string, out *Practice) error {
	sizes, err := s.itemCounts(ctx, userID, wsID)
	if err != nil {
		return err
	}
	size := make(map[string]int, len(sizes))
	named := map[string][]string{}
	for _, it := range sizes {
		size[it.MaterialID] = it.Size
		if len(it.questionTopics) > 0 {
			named[it.MaterialID] = it.questionTopics
		}
	}
	// The topic order, read only when a question names a topic of its own.
	var topics workspaceTopics
	if len(named) > 0 {
		if topics, err = s.topicsOf(ctx, wsID); err != nil {
			return err
		}
	}
	rows, err := s.pool.Query(ctx, `SELECT m.kind, m.id, m.title, COALESCE(m.topic_id, m.practice_topic_id), m.workspace_id IS NULL
		FROM materials m
		LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
		WHERE (m.workspace_id=$1 OR (m.practice_workspace_id=$1 AND m.owner_user_id=$2))
			AND m.kind IN ('quiz','flashcards') AND m.trashed_at IS NULL AND m.parent_material_id IS NULL AND m.assignment_id IS NULL
			AND workspace_item_visible(`+materialHiddenSQL+`, m.workspace_id, $2)
		ORDER BY t.id IS NULL, t.position, m.position, m.created_at DESC, m.id`, wsID, userID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var it PracticeItem
		if err := rows.Scan(&it.Kind, &it.ID, &it.Title, &it.TopicID, &it.OnlyYou); err != nil {
			rows.Close()
			return err
		}
		n, ok := size[it.ID]
		if !ok {
			continue
		}
		it.Size = n
		it.Covers = covers(it.TopicID, named[it.ID], topics.order)
		out.Items = append(out.Items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(out.Items) == 0 {
		return err
	}
	at := make(map[string]int, len(out.Items))
	for i, it := range out.Items {
		at[it.ID] = i
	}
	ids, kinds, counts := practiceScope(out.Items)
	rows, err = s.pool.Query(ctx, `WITH sz AS (SELECT * FROM unnest($2::text[], $3::text[], $4::int[]) AS sz(id, kind, size))
		SELECT DISTINCT ON (a.material_id) a.material_id, a.correct::float8, a.total::float8
		FROM attempts a JOIN sz ON sz.id=a.material_id AND sz.kind=a.kind
		WHERE a.user_id=$1 AND a.total > 0 AND `+practiceRunSQL+`
		ORDER BY a.material_id, a.correct / a.total DESC, a.taken_at DESC`, userID, ids, kinds, counts)
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
		out.Items[at[id]].Best = &best
	}
	return rows.Err()
}

// covers is an item's topic, then the other topics of the workspace (topics,
// in order) that its questions name as their own; a question's topic the
// workspace no longer holds follows the quiz's, so it adds none.
func covers(topic *string, named, topics []string) []string {
	out := []string{}
	if topic != nil {
		out = append(out, *topic)
	}
	for _, id := range topics {
		if slices.Contains(named, id) && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// practiceRunSQL keeps the attempts a best score reads: a quiz's every try,
// a set's runs through every card (a set's attempt counts only the cards
// rated so far, so a short run would read as a high score).
const practiceRunSQL = `(sz.kind='quiz' OR a.total >= sz.size)`

// practiceScope is the items' ids, kinds and sizes, for practiceRunSQL.
func practiceScope(items []PracticeItem) (ids, kinds []string, sizes []int) {
	for _, it := range items {
		ids, kinds, sizes = append(ids, it.ID), append(kinds, it.Kind), append(sizes, it.Size)
	}
	return ids, kinds, sizes
}

// practiceMembers counts the viewer members and, per quiz or set, those who
// tried it and the mean of their best scores once enough tried. Owners and editors
// are not counted: assignments and practice are for members who study.
func (s *Store) practiceMembers(ctx context.Context, wsID string, out *Practice) error {
	var members int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND role='viewer'`, wsID).
		Scan(&members); err != nil {
		return err
	}
	out.Members = &members
	at := make(map[string]int, len(out.Items))
	for i, it := range out.Items {
		at[it.ID] = i
		zero := 0
		out.Items[i].TriedBy = &zero
	}
	if len(out.Items) == 0 {
		return nil
	}
	ids, kinds, sizes := practiceScope(out.Items)
	rows, err := s.pool.Query(ctx, `WITH sz AS (SELECT * FROM unnest($2::text[], $3::text[], $4::int[]) AS sz(id, kind, size)),
		best AS (
			SELECT a.material_id, a.user_id, max(a.correct / a.total)::float8 AS score
			FROM attempts a JOIN sz ON sz.id=a.material_id AND sz.kind=a.kind
				JOIN workspace_members wm ON wm.user_id=a.user_id AND wm.workspace_id=$1 AND wm.role='viewer'
			WHERE a.total > 0 AND `+practiceRunSQL+`
			GROUP BY a.material_id, a.user_id)
		SELECT material_id, count(*), avg(score) FROM best GROUP BY material_id`, wsID, ids, kinds, sizes)
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
		it := &out.Items[at[id]]
		it.TriedBy = &tried
		if tried >= practiceAverageMin {
			it.Average = &avg
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
