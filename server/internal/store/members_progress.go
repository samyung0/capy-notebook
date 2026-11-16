package store

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/review"
)

// Study → Members (boards Main, G4 and G2; todo-study-tracking.md §4): how each
// member of a class is doing, for its owner and teaching assistants (editor
// members) only. Members never see it. A member's topic labels are the ones
// their own Summary shows (topicStandings read as them).

// MemberProgress is one member's line on Members, and their row of By topic.
type MemberProgress struct {
	UserID    string `json:"userId"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	MemberMarks
	// PracticeWeek counts the questions they checked in practice (quizzes and
	// reviews, not assignments) over the last seven days.
	PracticeWeek int `json:"practiceWeek"`
	// StorageFull: their own storage is full (StorageUsage.Full), so they can't
	// upload files (Epo 2026-11-08, Q722).
	StorageFull bool           `json:"storageFull"`
	Topics      []SummaryTopic `json:"topics" nullable:"false"`
}

// MemberMarks is a member's standing on the assignments given to them.
type MemberMarks struct {
	// Overall is their counted marks, after any late penalty, over the marks
	// decided so far, across their submitted marked assignments (0 to 1);
	// absent before any. Practice never counts.
	Overall *float64 `json:"overall,omitempty"`
	// Assigned counts the published assignments given to them; Done those they
	// submitted or ticked; Missing the marked ones past due with nothing
	// submitted.
	Assigned int `json:"assigned"`
	Done     int `json:"done"`
	Missing  int `json:"missing"`
}

// MembersTopic is a column of By topic: a topic any member has standing in,
// and its size, the most questions any member can answer in it.
type MembersTopic struct {
	Group     string  `json:"group" enum:"topic,others"`
	TopicID   *string `json:"topicId,omitempty"`
	Name      string  `json:"name,omitempty"`
	Questions int     `json:"questions"`
}

// MembersProgress is Study → Members: the class's viewer members by name, and
// the topics in reading order with Other files last.
type MembersProgress struct {
	Members []MemberProgress `json:"members" nullable:"false"`
	Topics  []MembersTopic   `json:"topics" nullable:"false"`
}

// practiceWindow is what "this week" covers on Members.
const practiceWindow = 7 * 24 * time.Hour

// membersStaff refuses anyone but a class's owner and editor members.
func (s *Store) membersStaff(ctx context.Context, userID, wsID string) error {
	staff, err := s.assignmentStaff(ctx, s.pool, userID, wsID)
	if err != nil {
		return err
	}
	if !staff {
		return ErrForbidden
	}
	return nil
}

// WorkspaceMembersProgress reads Study → Members for a class's owner and
// teaching assistants.
func (s *Store) WorkspaceMembersProgress(ctx context.Context, userID, wsID string, now time.Time) (MembersProgress, error) {
	out := MembersProgress{Members: []MemberProgress{}, Topics: []MembersTopic{}}
	if err := s.membersStaff(ctx, userID, wsID); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT wm.user_id, COALESCE(NULLIF(u.name,''), u.id),
			COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, '')
		FROM workspace_members wm JOIN users u ON u.id=wm.user_id
		WHERE wm.workspace_id=$1 AND wm.role='viewer'
		ORDER BY COALESCE(NULLIF(u.name,''), u.id), wm.user_id`, wsID)
	if err != nil {
		return out, err
	}
	ids := []string{}
	for rows.Next() {
		var mp MemberProgress
		if err := rows.Scan(&mp.UserID, &mp.Name, &mp.AvatarURL); err != nil {
			rows.Close()
			return out, err
		}
		out.Members = append(out.Members, mp)
		ids = append(ids, mp.UserID)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return out, err
	}
	marks, err := s.membersMarks(ctx, wsID, ids, now)
	if err != nil {
		return out, err
	}
	practice, err := s.membersPracticeWeek(ctx, wsID, ids, now)
	if err != nil {
		return out, err
	}
	// The whole class at once, never a query per member (Q723, finding 3).
	standings, err := s.membersStandings(ctx, wsID, ids, now)
	if err != nil {
		return out, err
	}
	full, err := s.membersStorageFull(ctx, ids)
	if err != nil {
		return out, err
	}
	sizes := map[string]int{}
	held := map[string]bool{}
	for i := range out.Members {
		mp := &out.Members[i]
		mp.MemberMarks = marks[mp.UserID]
		mp.PracticeWeek = practice[mp.UserID]
		mp.StorageFull = full[mp.UserID]
		mp.Topics = standings[mp.UserID]
		if mp.Topics == nil {
			mp.Topics = []SummaryTopic{}
		}
		for _, t := range mp.Topics {
			key := topicKey(t.TopicID)
			held[key] = true
			sizes[key] = max(sizes[key], t.Asked+t.Unattempted)
		}
	}
	topics, err := s.pool.Query(ctx, `SELECT id, name FROM topics WHERE workspace_id=$1 ORDER BY position, id`, wsID)
	if err != nil {
		return out, err
	}
	defer topics.Close()
	for topics.Next() {
		var t MembersTopic
		var id string
		if err := topics.Scan(&id, &t.Name); err != nil {
			return out, err
		}
		if held[id] {
			t.Group, t.TopicID, t.Questions = GroupTopic, &id, sizes[id]
			out.Topics = append(out.Topics, t)
		}
	}
	if err := topics.Err(); err != nil {
		return out, err
	}
	if held[""] {
		out.Topics = append(out.Topics, MembersTopic{Group: GroupOthers, Questions: sizes[""]})
	}
	return out, nil
}

func topicKey(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

// membersStandings is each member's Summary standings (topicStandings reads one
// member through it), for the whole class in one pass: the class's quizzes and
// each member's own, their sizes, and the class's answers grouped by member,
// each labelled by review.TopicLabel.
func (s *Store) membersStandings(ctx context.Context, wsID string, users []string, now time.Time) (map[string][]SummaryTopic, error) {
	rows, err := s.pool.Query(ctx, `SELECT u.id, m.id, m.revision, COALESCE(m.topic_id, m.practice_topic_id), t.name,
			`+quizAssignedToSQL("m.id", "u.id")+` IS NOT NULL
				OR NOT workspace_item_visible(`+materialHiddenSQL+`, m.workspace_id, u.id)
		FROM unnest($2::text[]) u(id)
		JOIN materials m ON m.workspace_id=$1 OR (m.practice_workspace_id=$1 AND m.owner_user_id=u.id)
		LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
		WHERE m.kind='quiz' AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
			AND workspace_item_visible(m.hidden, m.workspace_id, u.id)
		ORDER BY t.id IS NULL, t.position, m.id`, wsID, users)
	if err != nil {
		return nil, err
	}
	type quiz struct {
		user, id, key string
		// A quiz assigned to them, or held from them by an open assignment, counts
		// only what was answered, as itemCounts leaves it out.
		assigned bool
	}
	out := map[string][]SummaryTopic{}
	at := map[string]map[string]int{}
	var quizzes []quiz
	revisions := map[string]int64{}
	for rows.Next() {
		var q quiz
		var revision int64
		var t SummaryTopic
		var name *string
		if err := rows.Scan(&q.user, &q.id, &revision, &t.TopicID, &name, &q.assigned); err != nil {
			rows.Close()
			return nil, err
		}
		t.Group = GroupOthers
		if t.TopicID != nil {
			q.key, t.Group, t.Name = *t.TopicID, GroupTopic, *name
		}
		if at[q.user] == nil {
			at[q.user] = map[string]int{}
		}
		if _, seen := at[q.user][q.key]; !seen {
			at[q.user][q.key] = len(out[q.user])
			out[q.user] = append(out[q.user], t)
		}
		quizzes = append(quizzes, q)
		revisions[q.id] = revision
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sizes, err := s.quizSizes(ctx, revisions)
	if err != nil {
		return nil, err
	}
	totals := map[string]map[string]int{}
	for _, q := range quizzes {
		if totals[q.user] == nil {
			totals[q.user] = map[string]int{}
		}
		if !q.assigned {
			totals[q.user][q.key] += sizes[q.id]
		}
	}
	// A changed mark is a new row, and the latest for an attempt's part stands. A
	// review's check has no attempt, so each of its rows does.
	rows, err = s.pool.Query(ctx, `SELECT ae.user_id, COALESCE(m.topic_id, m.practice_topic_id), ae.material_id, ae.question_id, COALESCE(ae.attempt_id, ''), ae.item_hash, ae.awarded, ae.marks, ae.key_seen, ae.created_at
		FROM answer_events ae JOIN materials m ON m.id=ae.material_id
		WHERE ae.workspace_id=$1 AND ae.user_id = ANY($2) AND m.kind='quiz' AND m.trashed_at IS NULL
			AND m.parent_material_id IS NULL AND workspace_item_visible(m.hidden, m.workspace_id, ae.user_id)
			AND NOT EXISTS (SELECT 1 FROM answer_events newer WHERE newer.material_id=ae.material_id AND newer.question_id=ae.question_id
				AND newer.attempt_id=ae.attempt_id AND newer.part_id=ae.part_id AND newer.id>ae.id)
			AND NOT `+gradesHeldSQL+`
		ORDER BY ae.created_at, ae.id`, wsID, users)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := map[string]map[string][]review.PartAnswer{}
	for rows.Next() {
		var user, materialID string
		var topicID *string
		var p review.PartAnswer
		if err := rows.Scan(&user, &topicID, &materialID, &p.QuestionID, &p.AttemptID, &p.Hash, &p.Awarded, &p.Marks, &p.KeySeen, &p.At); err != nil {
			return nil, err
		}
		// A cloned quiz keeps its question ids.
		p.QuestionID = materialID + "/" + p.QuestionID
		if parts[user] == nil {
			parts[user] = map[string][]review.PartAnswer{}
		}
		key := topicKey(topicID)
		parts[user][key] = append(parts[user][key], p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for user, topics := range out {
		for i := range topics {
			key := topicKey(topics[i].TopicID)
			standing := review.TopicLabel(parts[user][key], now)
			topics[i].Label, topics[i].Right, topics[i].Partial, topics[i].Wrong = standing.Label, standing.Right, standing.Partial, standing.Wrong
			topics[i].Asked = standing.Asked
			// ponytail: answers to questions since removed still count as asked;
			// reading each quiz's current ids here would parse them all.
			topics[i].Unattempted = max(0, totals[user][key]-standing.Asked)
			if !standing.LastAt.IsZero() {
				last := standing.LastAt
				topics[i].LastAt = &last
			}
		}
	}
	return out, nil
}

// quizSizes is each quiz's item count at its revision, from parsedItems when
// it holds that revision, else parsed; a quiz whose content is refused has
// none, as itemCounts reads them.
func (s *Store) quizSizes(ctx context.Context, revisions map[string]int64) (map[string]int, error) {
	out := map[string]int{}
	var misses []string
	parsedItems.Lock()
	for id, revision := range revisions {
		if hit, ok := parsedItems.m[id]; ok && hit.revision == revision {
			out[id] = len(hit.items)
		} else {
			misses = append(misses, id)
		}
	}
	parsedItems.Unlock()
	if len(misses) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT `+materialCols+` FROM materials WHERE id = ANY($1)`, misses)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		mt, err := scanMaterial(rows)
		if err != nil {
			return nil, err
		}
		items, err := itemsOf(mt)
		if refused(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[mt.ID] = len(items)
	}
	return out, rows.Err()
}

// membersStorageFull is StorageUsage.Full for every member in one query: the
// plan read as effectiveSubscriptionStateForUser reads it, the bytes as
// unlockedStorageUsage counts them.
func (s *Store) membersStorageFull(ctx context.Context, users []string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `SELECT u.id, CASE
			WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
				WHERE any_sub.user_id=u.id) THEN u.plan_tier
			ELSE COALESCE((SELECT live.plan_tier FROM user_subscriptions live
				WHERE live.user_id=u.id AND live.status IN `+entitlingStatuses+`
					AND (live.current_period_end IS NULL OR live.current_period_end > now() - `+renewalTolerance+`)
				ORDER BY (live.plan_tier='pro') DESC,
					live.current_period_end DESC NULLS FIRST LIMIT 1), 'free')
			END,
			COALESCE(st.used_bytes, 0) + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas d WHERE d.user_id=u.id), 0),
			COALESCE(st.reserved_bytes, 0)
		FROM users u LEFT JOIN user_storage st ON st.user_id=u.id
		WHERE u.id = ANY($1)`, users)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var usage StorageUsage
		if err := rows.Scan(&usage.UserID, &usage.PlanTier, &usage.UsedBytes, &usage.ReservedBytes); err != nil {
			return nil, err
		}
		limits, err := s.PlanLimits(usage.PlanTier)
		if err != nil {
			return nil, err
		}
		usage.LimitBytes = limits.StorageBytes
		out[usage.UserID] = usage.Full()
	}
	return out, rows.Err()
}

// membersMarks reads each member's standing on the class's published
// assignments, from the submission of theirs that counts (countedAttemptOrder).
func (s *Store) membersMarks(ctx context.Context, wsID string, users []string, now time.Time) (map[string]MemberMarks, error) {
	out := map[string]MemberMarks{}
	var ids []string
	rows, err := s.pool.Query(ctx, `SELECT id FROM assignments WHERE workspace_id=$1 AND NOT draft AND NOT own`, wsID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `WITH e AS (`+assigneesSQL+`),
		l AS (
			SELECT DISTINCT ON (t.assignment_id, t.user_id) t.assignment_id, t.user_id, t.total, t.waiting_marks, `+attemptMarkSQL+` AS mark
			FROM attempts t JOIN e ON e.assignment_id=t.assignment_id AND e.user_id=t.user_id
			JOIN assignments a ON a.id=t.assignment_id
			WHERE t.submitted_at IS NOT NULL
			ORDER BY t.assignment_id, t.user_id, `+countedAttemptOrder+`)
		SELECT e.user_id, count(*)::int,
			count(*) FILTER (WHERE l.assignment_id IS NOT NULL OR d.user_id IS NOT NULL)::int,
			count(*) FILTER (WHERE a.kind='marked' AND l.assignment_id IS NULL AND a.due_at <= $3)::int,
			sum(l.mark)::float8, sum(l.total - l.waiting_marks)::float8
		FROM e JOIN assignments a ON a.id=e.assignment_id
		LEFT JOIN l ON l.assignment_id=e.assignment_id AND l.user_id=e.user_id
		LEFT JOIN assignment_done d ON d.assignment_id=e.assignment_id AND d.user_id=e.user_id
		WHERE e.user_id = ANY($2)
		GROUP BY e.user_id`, ids, users, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var user string
		var mm MemberMarks
		var mark, decided *float64
		if err := rows.Scan(&user, &mm.Assigned, &mm.Done, &mm.Missing, &mark, &decided); err != nil {
			return nil, err
		}
		if mark != nil && decided != nil && *decided > 0 {
			overall := *mark / *decided
			mm.Overall = &overall
		}
		out[user] = mm
	}
	return out, rows.Err()
}

// practiceChecksSQL counts checked questions: an attempt's question once, a
// review's each time (all its parts share one created_at).
const practiceChecksSQL = `count(DISTINCT COALESCE(ae.material_id,'') || '/' || ae.question_id || '/' || COALESCE(ae.attempt_id, ae.created_at::text))::int`

// membersPracticeWeek counts each member's practice questions over the window.
func (s *Store) membersPracticeWeek(ctx context.Context, wsID string, users []string, now time.Time) (map[string]int, error) {
	rows, err := s.pool.Query(ctx, `SELECT ae.user_id, `+practiceChecksSQL+`
		FROM answer_events ae
		WHERE ae.workspace_id=$1 AND ae.user_id = ANY($2) AND ae.source IN ('quiz','review') AND ae.created_at > $3
		GROUP BY ae.user_id`, wsID, users, now.Add(-practiceWindow))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var user string
		var n int
		if err := rows.Scan(&user, &n); err != nil {
			return nil, err
		}
		out[user] = n
	}
	return out, rows.Err()
}

/* --------------------------------------------------------------- profile */

// MemberProfile is a member's profile (board G2): the grade so far, every
// assignment given to them, their topics with labels and evidence, the
// questions still missed and recent work.
type MemberProfile struct {
	UserID    string    `json:"userId"`
	Name      string    `json:"name"`
	AvatarURL string    `json:"avatarUrl,omitempty"`
	JoinedAt  time.Time `json:"joinedAt"`
	// LastActiveAt is their latest answer or submission here.
	LastActiveAt *time.Time `json:"lastActiveAt,omitempty"`
	StorageFull  bool       `json:"storageFull"`
	MemberMarks
	Assignments []MemberAssignment `json:"assignments" nullable:"false"`
	Topics      []SummaryTopic     `json:"topics" nullable:"false"`
	Missed      []MissedQuestion   `json:"missed" nullable:"false"`
	Activity    []MemberActivity   `json:"activity" nullable:"false"`
}

// MemberAssignment is one published assignment given to the member, oldest
// due first.
type MemberAssignment struct {
	ID    string     `json:"id"`
	Kind  string     `json:"kind" enum:"marked,unmarked"`
	Title string     `json:"title"`
	DueAt *time.Time `json:"dueAt,omitempty"`
	// AttemptID is the submission that counts; DoneAt when it was submitted, or
	// an unmarked one ticked.
	AttemptID *string    `json:"attemptId,omitempty"`
	DoneAt    *time.Time `json:"doneAt,omitempty"`
	// Mark is after any late penalty, of Total; WaitingMarks are not decided yet.
	Mark         *float64 `json:"mark,omitempty"`
	Total        *float64 `json:"total,omitempty"`
	WaitingMarks float64  `json:"waitingMarks"`
	Running      bool     `json:"running"`
	Missing      bool     `json:"missing"`
}

// MissedQuestion is a question whose latest check was not right.
type MissedQuestion struct {
	MaterialID string  `json:"materialId"`
	QuestionID string  `json:"questionId"`
	Text       string  `json:"text"`
	Group      string  `json:"group" enum:"topic,others"`
	TopicID    *string `json:"topicId,omitempty"`
	TopicName  string  `json:"topicName,omitempty"`
	// Misses counts the checks of it that were not right.
	Misses int       `json:"misses"`
	At     time.Time `json:"at"`
}

// MemberActivity is one piece of recent work: an attempt at a class practice
// quiz, a day's reviews in a topic (or an attempt at their own practice), or a
// submitted assignment. Practice shows only counts.
type MemberActivity struct {
	Kind string `json:"kind" enum:"practice,review,assignment"`
	// Title is the quiz's or assignment's; a review's topic is in TopicName,
	// Group others when it has none.
	Title     string    `json:"title,omitempty"`
	Group     string    `json:"group,omitempty" enum:"topic,others"`
	TopicName string    `json:"topicName,omitempty"`
	Questions int       `json:"questions"`
	At        time.Time `json:"at"`
}

// Caps on the profile's lists.
const (
	missedShown   = 5
	activityShown = 5
)

// WorkspaceMemberProfile reads a member's profile for a class's owner and
// teaching assistants. Only viewer members have one.
func (s *Store) WorkspaceMemberProfile(ctx context.Context, userID, wsID, memberID string, now time.Time) (MemberProfile, error) {
	out := MemberProfile{UserID: memberID, Assignments: []MemberAssignment{}, Topics: []SummaryTopic{}, Missed: []MissedQuestion{}, Activity: []MemberActivity{}}
	if err := s.membersStaff(ctx, userID, wsID); err != nil {
		return out, err
	}
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(u.name,''), u.id),
			COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, ''), wm.created_at,
			GREATEST((SELECT max(created_at) FROM answer_events WHERE workspace_id=$1 AND user_id=$2),
				(SELECT max(t.submitted_at) FROM attempts t JOIN assignments a ON a.id=t.assignment_id
					WHERE a.workspace_id=$1 AND NOT a.own AND t.user_id=$2))
		FROM workspace_members wm JOIN users u ON u.id=wm.user_id
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.role='viewer'`, wsID, memberID).
		Scan(&out.Name, &out.AvatarURL, &out.JoinedAt, &out.LastActiveAt)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	marks, err := s.membersMarks(ctx, wsID, []string{memberID}, now)
	if err != nil {
		return out, err
	}
	out.MemberMarks = marks[memberID]
	if out.Assignments, err = s.memberAssignments(ctx, wsID, memberID, now); err != nil {
		return out, err
	}
	if out.Topics, err = s.topicStandings(ctx, memberID, wsID, now); err != nil {
		return out, err
	}
	if out.Missed, err = s.memberMissed(ctx, wsID, memberID); err != nil {
		return out, err
	}
	if out.Activity, err = s.memberActivity(ctx, wsID, memberID); err != nil {
		return out, err
	}
	usage, err := s.StorageUsage(ctx, memberID)
	if err != nil {
		return out, err
	}
	out.StorageFull = usage.Full()
	return out, nil
}

// memberAssignments lists the published assignments given to the member.
func (s *Store) memberAssignments(ctx context.Context, wsID, memberID string, now time.Time) ([]MemberAssignment, error) {
	out := []MemberAssignment{}
	var ids []string
	rows, err := s.pool.Query(ctx, `SELECT id FROM assignments WHERE workspace_id=$1 AND NOT draft AND NOT own`, wsID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(ids) == 0 {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `WITH e AS (`+assigneesSQL+`)
		SELECT a.id, a.kind, a.title, a.due_at, l.id, COALESCE(l.submitted_at,
				(SELECT d.done_at FROM assignment_done d WHERE d.assignment_id=a.id AND d.user_id=$2)),
			l.mark::float8, l.total::float8, COALESCE(l.waiting_marks, 0)::float8,
			EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=a.id AND t.user_id=$2 AND t.submitted_at IS NULL)
		FROM e JOIN assignments a ON a.id=e.assignment_id
		LEFT JOIN LATERAL (SELECT t.id, t.submitted_at, t.total, t.waiting_marks, `+attemptMarkSQL+` AS mark
			FROM attempts t WHERE t.assignment_id=a.id AND t.user_id=$2 AND t.submitted_at IS NOT NULL
			ORDER BY `+countedAttemptOrder+` LIMIT 1) l ON true
		WHERE e.user_id=$2
		ORDER BY COALESCE(a.due_at, a.posted_at), a.id`, ids, memberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a MemberAssignment
		if err := rows.Scan(&a.ID, &a.Kind, &a.Title, &a.DueAt, &a.AttemptID, &a.DoneAt, &a.Mark, &a.Total, &a.WaitingMarks, &a.Running); err != nil {
			return nil, err
		}
		a.Missing = a.Kind == AssignmentMarked && a.DoneAt == nil && a.DueAt != nil && !a.DueAt.After(now)
		out = append(out, a)
	}
	return out, rows.Err()
}

// memberMissed is the questions whose latest check by the member was not
// right, most missed first, from the class's own quizzes their Summary counts.
// A member's own practice quiz ("In class, only them", no workspace) is private
// and stays out (Q723, finding 2), and an assignment's answers wait for its
// grades as labels do (finding 7).
func (s *Store) memberMissed(ctx context.Context, wsID, memberID string) ([]MissedQuestion, error) {
	rows, err := s.pool.Query(ctx, `SELECT ae.material_id, ae.question_id, COALESCE(ae.attempt_id, ''), ae.item_hash,
			ae.awarded, ae.marks, ae.created_at, COALESCE(m.topic_id, m.practice_topic_id), t.name
		FROM answer_events ae JOIN materials m ON m.id=ae.material_id
		LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
		WHERE ae.workspace_id=$1 AND ae.user_id=$2 AND m.workspace_id=$1 AND m.kind='quiz' AND m.trashed_at IS NULL
			AND m.parent_material_id IS NULL AND workspace_item_visible(m.hidden, m.workspace_id, $2)
			AND NOT EXISTS (SELECT 1 FROM answer_events newer WHERE newer.material_id=ae.material_id AND newer.question_id=ae.question_id
				AND newer.attempt_id=ae.attempt_id AND newer.part_id=ae.part_id AND newer.id>ae.id)
			AND NOT `+gradesHeldSQL+`
		ORDER BY ae.created_at, ae.id`, wsID, memberID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type check struct {
		awarded, marks float64
		at             time.Time
	}
	type question struct {
		MissedQuestion
		hash   string
		checks map[string]*check
		order  []string
	}
	byQuestion := map[string]*question{}
	var keys []string
	for rows.Next() {
		var mq MissedQuestion
		var attempt, hash string
		var awarded, marks float64
		var at time.Time
		var name *string
		if err := rows.Scan(&mq.MaterialID, &mq.QuestionID, &attempt, &hash, &awarded, &marks, &at, &mq.TopicID, &name); err != nil {
			return nil, err
		}
		key := mq.MaterialID + "/" + mq.QuestionID
		q := byQuestion[key]
		if q == nil {
			q = &question{MissedQuestion: mq}
			byQuestion[key] = q
			keys = append(keys, key)
		}
		// An edited question starts again, as its label does.
		if q.hash != hash {
			q.hash, q.checks, q.order = hash, map[string]*check{}, nil
		}
		ck := attempt
		if ck == "" {
			ck = at.Format(time.RFC3339Nano)
		}
		c := q.checks[ck]
		if c == nil {
			c = &check{}
			q.checks[ck] = c
			q.order = append(q.order, ck)
		}
		c.awarded, c.marks, c.at = c.awarded+awarded, c.marks+marks, at
		if name != nil {
			q.TopicName = *name
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	var missed []*question
	for _, key := range keys {
		q := byQuestion[key]
		latest := q.checks[q.order[len(q.order)-1]]
		if latest.marks <= 0 || latest.awarded >= latest.marks {
			continue
		}
		for _, ck := range q.order {
			if c := q.checks[ck]; c.awarded < c.marks {
				q.Misses++
			}
		}
		q.At = latest.at
		missed = append(missed, q)
	}
	sort.SliceStable(missed, func(i, j int) bool {
		if missed[i].Misses != missed[j].Misses {
			return missed[i].Misses > missed[j].Misses
		}
		return missed[i].At.After(missed[j].At)
	})
	out := []MissedQuestion{}
	for _, q := range missed {
		if len(out) == missedShown {
			break
		}
		text, err := s.questionText(ctx, q.MaterialID, q.QuestionID)
		if err != nil {
			return nil, err
		}
		// A question since removed from its quiz has nothing to show.
		if text == "" {
			continue
		}
		q.Text = text
		q.Group = GroupOthers
		if q.TopicID != nil {
			q.Group = GroupTopic
		}
		out = append(out, q.MissedQuestion)
	}
	return out, nil
}

// questionText is a quiz question's prompt, empty once it is gone or its quiz
// can't be read.
func (s *Store) questionText(ctx context.Context, materialID, questionID string) (string, error) {
	mt, err := scanMaterial(s.pool.QueryRow(ctx, `SELECT `+materialCols+` FROM materials WHERE id=$1`, materialID))
	if isNoRows(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	items, err := itemsOf(mt)
	if refused(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	for _, it := range items {
		if it.ItemID == questionID && it.Question != nil {
			return strings.Join(strings.Fields(questions.PromptText(it.Question)), " "), nil
		}
	}
	return "", nil
}

// memberActivity is the member's latest work here: practice quiz attempts,
// each day's reviews per topic, and assignment submissions.
func (s *Store) memberActivity(ctx context.Context, wsID, memberID string) ([]MemberActivity, error) {
	// A member's own practice quiz is private ("Only you"): it shows as its
	// topic, like a review, never by title.
	rows, err := s.pool.Query(ctx, `(SELECT CASE WHEN m.workspace_id=$1 THEN 'practice' ELSE 'review' END,
				CASE WHEN m.workspace_id=$1 THEN m.title END, COALESCE(m.topic_id, m.practice_topic_id), t.name,
				`+practiceChecksSQL+`, max(ae.created_at)
			FROM answer_events ae JOIN materials m ON m.id=ae.material_id
			LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
			WHERE ae.workspace_id=$1 AND ae.user_id=$2 AND ae.source='quiz'
			GROUP BY ae.attempt_id, m.workspace_id, m.title, COALESCE(m.topic_id, m.practice_topic_id), t.name)
		UNION ALL
		(SELECT 'review', NULL, COALESCE(m.topic_id, m.practice_topic_id), t.name, `+practiceChecksSQL+`, max(ae.created_at)
			FROM answer_events ae LEFT JOIN materials m ON m.id=ae.material_id
			LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id)
			WHERE ae.workspace_id=$1 AND ae.user_id=$2 AND ae.source='review'
			GROUP BY date_trunc('day', ae.created_at), COALESCE(m.topic_id, m.practice_topic_id), t.name)
		UNION ALL
		(SELECT 'assignment', a.title, NULL, NULL, a.question_count, t.submitted_at
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE a.workspace_id=$1 AND NOT a.own AND t.user_id=$2 AND t.submitted_at IS NOT NULL)
		ORDER BY 6 DESC LIMIT $3`, wsID, memberID, activityShown)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MemberActivity{}
	for rows.Next() {
		var a MemberActivity
		var title, topicID, topicName *string
		if err := rows.Scan(&a.Kind, &title, &topicID, &topicName, &a.Questions, &a.At); err != nil {
			return nil, err
		}
		if title != nil {
			a.Title = *title
		}
		if a.Kind == "review" {
			a.Group = GroupOthers
			if topicID != nil && topicName != nil {
				a.Group, a.TopicName = GroupTopic, *topicName
			}
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
