package store

import (
	"context"
	"errors"
	"slices"
	"sort"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Learning's Overview (todo-learning-page.md, Epo 2026-11-04): what to do next
// across every workspace the user studies in, and how each stands. Every row
// comes from a stated rule; nothing here calls a model.

const (
	// learningRows caps What to do next, and learningPractice the practice
	// rows in it; suggestions fill what is left.
	learningRows     = 4
	learningPractice = 3
	// learningContinueWindow is how long something left partway stays offered.
	learningContinueWindow = 14 * 24 * time.Hour
	// learningStartWindow is how recently a workspace must have been opened or
	// practised for its next new quiz or set to be offered.
	learningStartWindow = 30 * 24 * time.Hour
	learningWeek        = 7 * 24 * time.Hour

	LearningSession = "session"
	LearningQuiz    = "quiz"
	LearningStart   = "start"
	LearningReview  = "review"
)

// LearningRow is one row of What to do next. A session row continues SessionID
// (Group, TopicName); a quiz row continues MaterialID's try; a start row opens
// MaterialID; a review row starts Suggestion.
type LearningRow struct {
	Kind          string  `json:"kind" enum:"session,quiz,start,review"`
	WorkspaceID   string  `json:"workspaceId"`
	WorkspaceName string  `json:"workspaceName"`
	SessionID     *string `json:"sessionId,omitempty"`
	Group         string  `json:"group,omitempty" enum:"topic,others,workspace,"`
	TopicName     string  `json:"topicName,omitempty"`
	MaterialID    *string `json:"materialId,omitempty"`
	MaterialKind  string  `json:"materialKind,omitempty" enum:"quiz,flashcards,"`
	Title         string  `json:"title,omitempty"`
	// Answered of Total: items answered in a session, questions checked in a
	// quiz. A start row's Total is its size.
	Answered   int               `json:"answered"`
	Total      int               `json:"total"`
	At         *time.Time        `json:"at,omitempty"`
	Suggestion *ReviewSuggestion `json:"suggestion,omitempty"`
}

// LearningLabelCount is how many of a workspace's topics hold a label.
type LearningLabelCount struct {
	Label string `json:"label" enum:"not_started,attempted,needs_practice,familiar,proficient,mastered"`
	Count int    `json:"count"`
}

// LearningWorkspace is one row of Workspaces.
type LearningWorkspace struct {
	WorkspaceID string               `json:"workspaceId"`
	Name        string               `json:"name"`
	IconID      string               `json:"iconId"`
	Labels      []LearningLabelCount `json:"labels" nullable:"false"`
	// Tried of Items: rated items with their current content, of all items.
	Tried           int        `json:"tried"`
	Items           int        `json:"items"`
	LastPractisedAt *time.Time `json:"lastPractisedAt,omitempty"`
}

// LearningTeach is a class the user owns or edits: nothing of it is studied
// here, the row only opens its Members.
type LearningTeach struct {
	WorkspaceID string `json:"workspaceId"`
	Name        string `json:"name"`
	IconID      string `json:"iconId"`
	Members     int    `json:"members"`
}

// LearningOverview is the Overview tab.
type LearningOverview struct {
	Next          []LearningRow       `json:"next" nullable:"false"`
	Workspaces    []LearningWorkspace `json:"workspaces" nullable:"false"`
	Teaches       []LearningTeach     `json:"teaches" nullable:"false"`
	WeekQuestions int                 `json:"weekQuestions"`
	WeekCards     int                 `json:"weekCards"`
}

type learningWorkspace struct {
	id, name, iconID string
	joined           bool // owner or member, not a link or public visitor
	lastPractised    *time.Time
	lastVisit        *time.Time
	sizes            map[string]int
}

// learningScope splits the user's workspaces: those they study in, and the
// classes they own or edit. A link or public visitor counts once they have
// practised there; Hide study progress leaves a workspace out.
func (s *Store) learningScope(ctx context.Context, userID string) ([]*learningWorkspace, []LearningTeach, error) {
	rows, err := s.pool.Query(ctx, `SELECT w.id, w.name, w.icon_id, w.kind, COALESCE(wm.role,''), w.user_id=$1,
			COALESCE((SELECT enabled FROM workspace_study st WHERE st.user_id=$1 AND st.workspace_id=w.id), true),
			(SELECT max(sp.updated_at) FROM study_progress sp WHERE sp.user_id=$1 AND sp.workspace_id=w.id),
			(SELECT v.opened_at FROM workspace_visits v WHERE v.user_id=$1 AND v.workspace_id=w.id),
			(SELECT count(*) FROM workspace_members m WHERE m.workspace_id=w.id AND m.role='viewer')
		FROM workspaces w
		JOIN users owner ON owner.id=w.user_id
		LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$1
		WHERE owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
			AND (owner.suspended_at IS NULL OR owner.id=$1)
			AND (w.user_id=$1 OR wm.user_id IS NOT NULL
				OR EXISTS (SELECT 1 FROM study_progress sp WHERE sp.user_id=$1 AND sp.workspace_id=w.id))
		ORDER BY w.name, w.id`, userID)
	if err != nil {
		return nil, nil, err
	}
	type row struct {
		ws      learningWorkspace
		kind    WorkspaceKind
		role    WorkspaceRole
		owner   bool
		enabled bool
		members int
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.ws.id, &r.ws.name, &r.ws.iconID, &r.kind, &r.role, &r.owner, &r.enabled,
			&r.ws.lastPractised, &r.ws.lastVisit, &r.members); err != nil {
			rows.Close()
			return nil, nil, err
		}
		all = append(all, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	out := []*learningWorkspace{}
	teaches := []LearningTeach{}
	for i := range all {
		r := &all[i]
		if r.owner {
			r.role = RoleOwner
		}
		r.ws.joined = r.role != ""
		if r.role == "" {
			// A visitor: access can end after progress was recorded.
			effective, err := s.WorkspaceEffectiveRole(ctx, userID, r.ws.id)
			if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
				continue
			}
			if err != nil {
				return nil, nil, err
			}
			r.role = effective
		}
		if r.kind == WorkspaceClass && RoleCanEdit(r.role) {
			if r.ws.joined {
				teaches = append(teaches, LearningTeach{WorkspaceID: r.ws.id, Name: r.ws.name, IconID: r.ws.iconID, Members: r.members})
			}
			continue
		}
		if r.enabled {
			out = append(out, &r.ws)
		}
	}
	return out, teaches, nil
}

// LearningOverview reads the Overview tab.
func (s *Store) LearningOverview(ctx context.Context, userID string, now time.Time) (LearningOverview, error) {
	out := LearningOverview{Next: []LearningRow{}, Workspaces: []LearningWorkspace{}}
	scope, teaches, err := s.learningScope(ctx, userID)
	if err != nil {
		return out, err
	}
	out.Teaches = teaches
	if len(scope) == 0 {
		return out, nil
	}
	prefsRaw, err := s.StudyPreferencesOf(ctx, userID)
	if err != nil {
		return out, err
	}
	// Suggestions start the topic session's dialog, which holds questions only,
	// as on Practice and the Dashboard (Epo 2026-11-04).
	prefs := reviewPrefsOf(prefsRaw)
	prefs.Items = "quiz"
	var suggestions []ReviewSuggestion
	ids := make([]string, 0, len(scope))
	byID := make(map[string]*learningWorkspace, len(scope))
	for _, ws := range scope {
		ids = append(ids, ws.id)
		byID[ws.id] = ws
		counts, err := s.itemCounts(ctx, userID, ws.id)
		if err != nil {
			return out, err
		}
		ws.sizes = make(map[string]int, len(counts))
		items := 0
		for _, c := range counts {
			ws.sizes[c.MaterialID] = c.Size
			items += c.Size
		}
		pool, err := s.reviewPool(ctx, userID, ws.id, now)
		if err != nil {
			return out, err
		}
		if items > 0 {
			row, err := s.learningWorkspaceRow(ctx, userID, ws, len(pool), items, now)
			if err != nil {
				return out, err
			}
			out.Workspaces = append(out.Workspaces, row)
		}
		if ws.lastPractised == nil {
			continue
		}
		history, err := s.reviewHistory(ctx, userID, pool)
		if err != nil {
			return out, err
		}
		for _, sg := range groupSuggestions(scoreItems(pool, history, prefs), history, interest(now.Sub(*ws.lastPractised))) {
			sg.WorkspaceID, sg.WorkspaceName, sg.IconID = ws.id, ws.name, ws.iconID
			suggestions = append(suggestions, sg)
		}
	}
	sort.SliceStable(out.Workspaces, func(i, j int) bool {
		a, b := out.Workspaces[i].LastPractisedAt, out.Workspaces[j].LastPractisedAt
		return b == nil && a != nil || a != nil && b != nil && a.After(*b)
	})
	practice, err := s.learningContinue(ctx, userID, ids, byID, now)
	if err != nil {
		return out, err
	}
	if len(practice) < learningPractice {
		fresh, err := s.learningStart(ctx, userID, scope, now)
		if err != nil {
			return out, err
		}
		practice = append(practice, fresh...)
	}
	if len(practice) > learningPractice {
		practice = practice[:learningPractice]
	}
	out.Next = append(out.Next, practice...)
	if err := s.learningSuggestions(ctx, &out, suggestions); err != nil {
		return out, err
	}
	out.WeekQuestions, out.WeekCards, err = s.learningWeek(ctx, userID, ids, now)
	return out, err
}

func (s *Store) learningWorkspaceRow(ctx context.Context, userID string, ws *learningWorkspace, tried, items int, now time.Time) (LearningWorkspace, error) {
	row := LearningWorkspace{WorkspaceID: ws.id, Name: ws.name, IconID: ws.iconID, Labels: []LearningLabelCount{},
		Tried: tried, Items: items, LastPractisedAt: ws.lastPractised}
	topics, err := s.topicStandings(ctx, userID, ws.id, now)
	if err != nil {
		return row, err
	}
	// Weakest first, so a row reads what needs attention before what is fine.
	for _, label := range []string{review.LabelNeedsPractice, review.LabelAttempted, review.LabelFamiliar, review.LabelProficient, review.LabelMastered, review.LabelNotStarted} {
		n := 0
		for _, t := range topics {
			if t.Label == label {
				n++
			}
		}
		if n > 0 {
			row.Labels = append(row.Labels, LearningLabelCount{Label: label, Count: n})
		}
	}
	return row, nil
}

// learningContinue is what the user left partway, newest first: unfinished
// sessions and quizzes with fewer questions checked than they hold.
func (s *Store) learningContinue(ctx context.Context, userID string, ids []string, byID map[string]*learningWorkspace, now time.Time) ([]LearningRow, error) {
	since := now.Add(-learningContinueWindow)
	out := []LearningRow{}
	rows, err := s.pool.Query(ctx, `SELECT rs.id, rs.workspace_id, rs.group_kind, COALESCE(t.name, ''),
			(SELECT count(*) FROM review_answers ra WHERE ra.session_id=rs.id), jsonb_array_length(rs.items), rs.last_answer_at
		FROM review_sessions rs LEFT JOIN topics t ON t.id=rs.topic_id
		WHERE rs.user_id=$1 AND rs.finished_at IS NULL AND rs.workspace_id = ANY($2) AND rs.last_answer_at >= $3`, userID, ids, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r LearningRow
		var id string
		var at time.Time
		if err := rows.Scan(&id, &r.WorkspaceID, &r.Group, &r.TopicName, &r.Answered, &r.Total, &at); err != nil {
			rows.Close()
			return nil, err
		}
		r.Kind, r.SessionID, r.At = LearningSession, &id, &at
		r.WorkspaceName = byID[r.WorkspaceID].name
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.pool.Query(ctx, `SELECT DISTINCT ON (a.material_id) a.material_id, COALESCE(m.workspace_id, m.practice_workspace_id), m.title,
			jsonb_array_length(a.questions), a.taken_at
		FROM attempts a JOIN materials m ON m.id=a.material_id
		WHERE a.user_id=$1 AND a.kind='quiz' AND COALESCE(m.workspace_id, m.practice_workspace_id) = ANY($2) AND a.taken_at >= $3
			AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
			AND workspace_item_visible(m.hidden, m.workspace_id, $1)
		ORDER BY a.material_id, a.taken_at DESC`, userID, ids, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r LearningRow
		var id string
		var at time.Time
		if err := rows.Scan(&id, &r.WorkspaceID, &r.Title, &r.Answered, &at); err != nil {
			return nil, err
		}
		ws := byID[r.WorkspaceID]
		if r.Total = ws.sizes[id]; r.Answered >= r.Total {
			continue
		}
		r.Kind, r.MaterialID, r.MaterialKind, r.At, r.WorkspaceName = LearningQuiz, &id, "quiz", &at, ws.name
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.After(*out[j].At) })
	return out, nil
}

// learningStart is each recently used workspace's first quiz or set the user
// has never practised, in reading order, the workspace opened last first.
func (s *Store) learningStart(ctx context.Context, userID string, scope []*learningWorkspace, now time.Time) ([]LearningRow, error) {
	since := now.Add(-learningStartWindow)
	recent := func(t *time.Time) bool { return t != nil && t.After(since) }
	var ws []*learningWorkspace
	for _, w := range scope {
		if w.joined && (recent(w.lastVisit) || recent(w.lastPractised)) {
			ws = append(ws, w)
		}
	}
	latest := func(w *learningWorkspace) time.Time {
		var t time.Time
		for _, c := range []*time.Time{w.lastVisit, w.lastPractised} {
			if c != nil && c.After(t) {
				t = *c
			}
		}
		return t
	}
	sort.SliceStable(ws, func(i, j int) bool { return latest(ws[i]).After(latest(ws[j])) })
	ids := make([]string, 0, len(ws))
	for _, w := range ws {
		ids = append(ids, w.id)
	}
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT m.id, m.workspace_id, m.title, m.kind FROM materials m
		LEFT JOIN topics t ON t.id=m.topic_id
		LEFT JOIN study_progress sp ON sp.material_id=m.id AND sp.user_id=$1
		WHERE m.workspace_id = ANY($2) AND m.kind IN ('quiz','flashcards') AND m.trashed_at IS NULL
			AND m.parent_material_id IS NULL AND sp.material_id IS NULL
			AND workspace_item_visible(m.hidden, m.workspace_id, $1)
		ORDER BY m.topic_id IS NULL, t.position, m.position, m.created_at DESC, m.id`, userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	first := map[string]LearningRow{}
	for rows.Next() {
		var id, wsID, title, kind string
		if err := rows.Scan(&id, &wsID, &title, &kind); err != nil {
			return nil, err
		}
		if _, ok := first[wsID]; ok {
			continue
		}
		w := ws[slices.IndexFunc(ws, func(c *learningWorkspace) bool { return c.id == wsID })]
		// A size of 0 is empty or refused: nothing to start.
		size := w.sizes[id]
		if size == 0 {
			continue
		}
		first[wsID] = LearningRow{Kind: LearningStart, WorkspaceID: wsID, WorkspaceName: w.name, MaterialID: &id,
			MaterialKind: kind, Title: title, Total: size}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []LearningRow{}
	for _, w := range ws {
		if r, ok := first[w.id]; ok {
			out = append(out, r)
		}
	}
	return out, nil
}

// learningSuggestions fills What to do next with the highest scored
// suggestions, at most suggestionsPerWS per workspace, past any topic already
// being continued.
func (s *Store) learningSuggestions(ctx context.Context, out *LearningOverview, list []ReviewSuggestion) error {
	sort.SliceStable(list, func(i, j int) bool { return list[i].score > list[j].score })
	if err := s.nameTopics(ctx, list); err != nil {
		return err
	}
	perWS := map[string]int{}
	for i := range list {
		if len(out.Next) >= learningRows {
			break
		}
		sg := &list[i]
		if perWS[sg.WorkspaceID] == suggestionsPerWS || continuing(out.Next, sg) {
			continue
		}
		perWS[sg.WorkspaceID]++
		out.Next = append(out.Next, LearningRow{Kind: LearningReview, WorkspaceID: sg.WorkspaceID, WorkspaceName: sg.WorkspaceName, Suggestion: sg})
	}
	return nil
}

func continuing(rows []LearningRow, sg *ReviewSuggestion) bool {
	return slices.ContainsFunc(rows, func(r LearningRow) bool {
		return r.Kind == LearningSession && r.WorkspaceID == sg.WorkspaceID && r.Group == sg.Group &&
			(sg.TopicName == "" || r.TopicName == sg.TopicName)
	})
}

// learningWeek counts answers in scope in the last seven days.
func (s *Store) learningWeek(ctx context.Context, userID string, ids []string, now time.Time) (questions, cards int, err error) {
	err = s.pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE m.kind='quiz'), count(*) FILTER (WHERE m.kind='flashcards')
		FROM review_log rl JOIN materials m ON m.id=rl.material_id
		WHERE rl.user_id=$1 AND rl.reviewed_at >= $2 AND COALESCE(m.workspace_id, m.practice_workspace_id) = ANY($3)`, userID, now.Add(-learningWeek), ids).Scan(&questions, &cards)
	return questions, cards, err
}

/* --------------------------------------------------------------- topics */

// SummaryTopic is one topic's standing, for Summary and Workspaces.
type SummaryTopic struct {
	Group   string  `json:"group" enum:"topic,others"`
	TopicID *string `json:"topicId,omitempty"`
	Name    string  `json:"name,omitempty"`
	Label   string  `json:"label" enum:"not_started,attempted,needs_practice,familiar,proficient,mastered"`
	// Right, Partial and Wrong count each question's latest answer; Asked is
	// their sum.
	Right   int `json:"right"`
	Partial int `json:"partial"`
	Wrong   int `json:"wrong"`
	Asked   int `json:"asked"`
	// Unattempted counts the topic's questions with no answer yet, those of a
	// quiz left partway included.
	Unattempted int        `json:"unattempted"`
	LastAt      *time.Time `json:"lastAt,omitempty"`
}

// StudyTopics is Study → Summary: the caller's own standing per topic. Enabled
// is false while Hide study progress hides it.
type StudyTopics struct {
	Enabled bool           `json:"enabled"`
	Topics  []SummaryTopic `json:"topics" nullable:"false"`
}

// WorkspaceStudyTopics reads Summary, refused to a class's owner and editors
// (canEdit), who have no results of their own.
func (s *Store) WorkspaceStudyTopics(ctx context.Context, userID, wsID string, canEdit bool, now time.Time) (StudyTopics, error) {
	out := StudyTopics{Topics: []SummaryTopic{}}
	var kind WorkspaceKind
	if err := s.pool.QueryRow(ctx, `SELECT kind FROM workspaces WHERE id=$1`, wsID).Scan(&kind); err != nil {
		return out, err
	}
	if canEdit && kind == WorkspaceClass {
		return out, ErrForbidden
	}
	var err error
	if out.Enabled, err = s.StudyEnabled(ctx, userID, wsID); err != nil || !out.Enabled {
		return out, err
	}
	out.Topics, err = s.topicStandings(ctx, userID, wsID, now)
	return out, err
}

// topicStandings is every topic holding a quiz the caller can see, in reading
// order with Other files last, each with its label. An answer counts toward its
// quiz's topic: questions carry no topic of their own yet, and flashcards stay
// out of mastery. Trashed and deleted quizzes leave their answers out.
func (s *Store) topicStandings(ctx context.Context, userID, wsID string, now time.Time) ([]SummaryTopic, error) {
	sizes, err := s.itemCounts(ctx, userID, wsID)
	if err != nil {
		return nil, err
	}
	size := make(map[string]int, len(sizes))
	for _, it := range sizes {
		size[it.MaterialID] = it.Size
	}
	rows, err := s.pool.Query(ctx, `SELECT m.id, COALESCE(m.topic_id, m.practice_topic_id), t.name
		FROM materials m LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
		WHERE (m.workspace_id=$1 OR (m.practice_workspace_id=$1 AND m.owner_user_id=$2)) AND m.kind='quiz' AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
			AND workspace_item_visible(m.hidden, m.workspace_id, $2)
		ORDER BY t.id IS NULL, t.position, m.id`, wsID, userID)
	if err != nil {
		return nil, err
	}
	out := []SummaryTopic{}
	at := map[string]int{}
	totals := map[string]int{}
	for rows.Next() {
		var id string
		var t SummaryTopic
		var name *string
		if err := rows.Scan(&id, &t.TopicID, &name); err != nil {
			rows.Close()
			return nil, err
		}
		key := ""
		t.Group = GroupOthers
		if t.TopicID != nil {
			key, t.Group, t.Name = *t.TopicID, GroupTopic, *name
		}
		if _, seen := at[key]; !seen {
			at[key] = len(out)
			out = append(out, t)
		}
		totals[key] += size[id]
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.pool.Query(ctx, `SELECT COALESCE(m.topic_id, m.practice_topic_id), ae.material_id, ae.question_id, ae.item_hash, ae.awarded, ae.marks, ae.key_seen, ae.created_at
		FROM answer_events ae JOIN materials m ON m.id=ae.material_id
		WHERE ae.workspace_id=$1 AND ae.user_id=$2 AND m.kind='quiz' AND m.trashed_at IS NULL
			AND m.parent_material_id IS NULL AND workspace_item_visible(m.hidden, m.workspace_id, $2)
		ORDER BY ae.created_at, ae.id`, wsID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := map[string][]review.PartAnswer{}
	for rows.Next() {
		var topicID *string
		var materialID string
		var p review.PartAnswer
		if err := rows.Scan(&topicID, &materialID, &p.QuestionID, &p.Hash, &p.Awarded, &p.Marks, &p.KeySeen, &p.At); err != nil {
			return nil, err
		}
		// A cloned quiz keeps its question ids.
		p.QuestionID = materialID + "/" + p.QuestionID
		key := ""
		if topicID != nil {
			key = *topicID
		}
		parts[key] = append(parts[key], p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		key := ""
		if out[i].TopicID != nil {
			key = *out[i].TopicID
		}
		standing := review.TopicLabel(parts[key], now)
		out[i].Label, out[i].Right, out[i].Partial, out[i].Wrong = standing.Label, standing.Right, standing.Partial, standing.Wrong
		out[i].Asked = standing.Asked
		// ponytail: answers to questions since removed still count as asked;
		// reading each quiz's current ids here would parse them all.
		out[i].Unattempted = max(0, totals[key]-standing.Asked)
		if !standing.LastAt.IsZero() {
			last := standing.LastAt
			out[i].LastAt = &last
		}
	}
	return out, nil
}
