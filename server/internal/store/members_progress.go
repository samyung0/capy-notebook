package store

import (
	"context"
	"slices"
	"sort"
	"time"

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
	// decided so far, across their submitted graded quizzes and graded
	// Assignments, a grade counting over its points (0 to 1); absent before
	// any. Practice never counts.
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
	topics, err := s.topicsOf(ctx, wsID)
	if err != nil {
		return out, err
	}
	// The whole class at once, never a query per member (Q723, finding 3).
	standings, err := s.membersStandings(ctx, wsID, ids, topics, now)
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
	for _, id := range topics.order {
		if held[id] {
			out.Topics = append(out.Topics, MembersTopic{Group: GroupTopic, TopicID: &id, Name: topics.names[id], Questions: sizes[id]})
		}
	}
	if held[""] {
		out.Topics = append(out.Topics, MembersTopic{Group: GroupOthers, Questions: sizes[""]})
	}
	return out, nil
}

// topicKeys is an item's topics (itemTopics) as keys, Other files' "" when
// it has none.
func topicKeys(ids []string) []string {
	if len(ids) == 0 {
		return []string{""}
	}
	return ids
}

func topicKey(id *string) string {
	if id == nil {
		return ""
	}
	return *id
}

// standingQuizSQL admits a quiz row m whose answers count in user's standings:
// one they see, or a graded quiz's own (migration 0174), held from them but
// answered through its assignment, its answers waiting for release
// (gradesHeldSQL) and counting only as answered.
func standingQuizSQL(user string) string {
	return `(m.assignment_id IS NOT NULL OR workspace_item_visible(m.hidden, m.workspace_id, ` + user + `))`
}

// membersStandings is each member's Summary standings (topicStandings reads one
// member through it), for the whole class in one pass: the class's quizzes and
// each member's own, their questions by topic (itemTopics, a question fully
// under each of its topics), and the class's answers grouped by member, each
// labelled by review.TopicLabel. A trashed quiz's answers still count, toward
// its questions' topics (Epo 2026-11-15), though its questions no longer add
// to a topic's size; a deleted quiz's count toward the topics they were given
// in (answer_events.topic_ids).
func (s *Store) membersStandings(ctx context.Context, wsID string, users []string, topics workspaceTopics, now time.Time) (map[string][]SummaryTopic, error) {
	rows, err := s.pool.Query(ctx, `SELECT u.id, m.id, m.revision, COALESCE(m.topic_id, m.practice_topic_id),
			m.assignment_id IS NOT NULL OR NOT workspace_item_visible(`+materialHiddenSQL+`, m.workspace_id, u.id), m.trashed_at IS NOT NULL
		FROM unnest($2::text[]) u(id)
		JOIN materials m ON m.workspace_id=$1 OR (m.practice_workspace_id=$1 AND m.owner_user_id=u.id)
		WHERE m.kind='quiz' AND m.parent_material_id IS NULL AND `+standingQuizSQL("u.id")+`
			AND (m.trashed_at IS NULL OR EXISTS (SELECT 1 FROM answer_events ae WHERE ae.material_id=m.id AND ae.user_id=u.id))`, wsID, users)
	if err != nil {
		return nil, err
	}
	type quiz struct {
		user, id string
		// A graded quiz's own quiz, or one hidden from them, counts only what
		// was answered, as itemCounts leaves it out.
		assigned bool
		// A trashed quiz counts only through the answers it was given.
		trashed bool
	}
	var quizzes []quiz
	revisions := map[string]int64{}
	quizTopic := map[string]*string{}
	for rows.Next() {
		var q quiz
		var revision int64
		var topicID *string
		if err := rows.Scan(&q.user, &q.id, &revision, &topicID, &q.assigned, &q.trashed); err != nil {
			rows.Close()
			return nil, err
		}
		quizzes = append(quizzes, q)
		revisions[q.id], quizTopic[q.id] = revision, topicID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	docs, err := s.cachedItems(ctx, revisions)
	if err != nil {
		return nil, err
	}
	// Each quiz's questions per topic, and the questions counting toward
	// topics other than their quiz's, by material/question id.
	sizes := map[string]map[string]int{}
	moved := map[string][]string{}
	for id, items := range docs {
		sizes[id] = map[string]int{}
		for _, it := range items {
			keys := topicKeys(itemTopics(it, quizTopic[id], topics))
			for _, key := range keys {
				sizes[id][key]++
			}
			if !slices.Equal(keys, []string{topicKey(quizTopic[id])}) {
				moved[id+"/"+it.ItemID] = keys
			}
		}
	}
	held := map[string]map[string]bool{}
	totals := map[string]map[string]int{}
	hold := func(user, key string) {
		if held[user] == nil {
			held[user], totals[user] = map[string]bool{}, map[string]int{}
		}
		held[user][key] = true
	}
	for _, q := range quizzes {
		if q.trashed {
			continue
		}
		hold(q.user, topicKey(quizTopic[q.id]))
		for key, n := range sizes[q.id] {
			hold(q.user, key)
			if !q.assigned {
				totals[q.user][key] += n
			}
		}
	}
	// A changed mark is a new row, and the latest for an attempt's part stands. A
	// review's check has no attempt, so each of its rows does. A deleted quiz's
	// rows (no material) are matched here by attempt and part instead, before
	// those without a topic are dropped, so a later mark with none still
	// replaces an earlier one.
	rows, err = s.pool.Query(ctx, `SELECT ae.user_id, CASE WHEN ae.material_id IS NULL THEN ae.topic_ids END,
			COALESCE(ae.material_id, ''), ae.question_id, ae.part_id, COALESCE(ae.attempt_id, ''), ae.item_hash, ae.awarded, ae.marks, ae.key_seen, ae.created_at
		FROM answer_events ae LEFT JOIN materials m ON m.id=ae.material_id
		WHERE ae.workspace_id=$1 AND ae.user_id = ANY($2)
			AND (ae.material_id IS NULL
				OR m.kind='quiz' AND m.parent_material_id IS NULL AND `+standingQuizSQL("ae.user_id")+`)
			AND NOT EXISTS (SELECT 1 FROM answer_events newer WHERE newer.material_id=ae.material_id AND newer.question_id=ae.question_id
				AND newer.attempt_id=ae.attempt_id AND newer.part_id=ae.part_id AND newer.id>ae.id)
			AND NOT `+gradesHeldSQL+`
		ORDER BY ae.created_at, ae.id`, wsID, users)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type answer struct {
		user string
		keys []string
		p    review.PartAnswer
		// part names a deleted quiz's attempt part, whose latest row stands.
		part string
	}
	var answers []answer
	latest := map[string]int{}
	for rows.Next() {
		var a answer
		var given []string
		var materialID, partID string
		if err := rows.Scan(&a.user, &given, &materialID, &a.p.QuestionID, &partID, &a.p.AttemptID, &a.p.Hash, &a.p.Awarded, &a.p.Marks, &a.p.KeySeen, &a.p.At); err != nil {
			return nil, err
		}
		if materialID == "" {
			// A deleted quiz's answer with no topic of the workspace's counts
			// nowhere.
			for _, id := range given {
				if topics.has(id) {
					a.keys = append(a.keys, id)
				}
			}
			if a.p.AttemptID != "" {
				a.part = a.p.AttemptID + "/" + a.p.QuestionID + "/" + partID
				latest[a.part] = len(answers)
			}
		} else if topic, ok := quizTopic[materialID]; !ok {
			continue // a quiz moved to another workspace since
		} else if keys, ok := moved[materialID+"/"+a.p.QuestionID]; ok {
			a.keys = keys
		} else {
			a.keys = []string{topicKey(topic)}
		}
		// A cloned quiz keeps its question ids.
		a.p.QuestionID = materialID + "/" + a.p.QuestionID
		answers = append(answers, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	parts := map[string]map[string][]review.PartAnswer{}
	for i, a := range answers {
		if a.part != "" && latest[a.part] != i {
			continue
		}
		for _, key := range a.keys {
			hold(a.user, key)
			if parts[a.user] == nil {
				parts[a.user] = map[string][]review.PartAnswer{}
			}
			parts[a.user][key] = append(parts[a.user][key], a.p)
		}
	}
	out := map[string][]SummaryTopic{}
	for _, user := range users {
		keys := held[user]
		for _, id := range append(slices.Clone(topics.order), "") {
			if !keys[id] {
				continue
			}
			t := SummaryTopic{Group: GroupOthers}
			if id != "" {
				t.Group, t.TopicID, t.Name = GroupTopic, &id, topics.names[id]
			}
			standing := review.TopicLabel(parts[user][id], now)
			t.Label, t.Right, t.Partial, t.Wrong = standing.Label, standing.Right, standing.Partial, standing.Wrong
			t.Asked = standing.Asked
			// ponytail: answers to questions since removed (or whose quiz is
			// deleted) still count as asked; reading each quiz's current ids
			// here would parse them all.
			t.Unattempted = max(0, totals[user][id]-standing.Asked)
			if !standing.LastAt.IsZero() {
				last := standing.LastAt
				t.LastAt = &last
			}
			out[user] = append(out[user], t)
		}
	}
	return out, nil
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
// assignments, from the submission of theirs that counts (countedAttemptOrder)
// and their grades on graded Assignments (gradesSQL).
func (s *Store) membersMarks(ctx context.Context, wsID string, users []string, now time.Time) (map[string]MemberMarks, error) {
	out := map[string]MemberMarks{}
	var ids []string
	rows, err := s.pool.Query(ctx, `SELECT id FROM assignments WHERE workspace_id=$1 AND NOT draft`, wsID)
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
			ORDER BY t.assignment_id, t.user_id, `+countedAttemptOrder+`),
		g AS (`+gradesSQL+` WHERE g.assignment_id = ANY($1))
		SELECT e.user_id, count(*)::int,
			count(*) FILTER (WHERE l.assignment_id IS NOT NULL OR d.user_id IS NOT NULL)::int,
			count(*) FILTER (WHERE a.kind='marked' AND l.assignment_id IS NULL AND a.due_at <= $3)::int,
			sum(COALESCE(l.mark, g.mark))::float8, sum(COALESCE(l.total - l.waiting_marks, g.total))::float8
		FROM e JOIN assignments a ON a.id=e.assignment_id
		LEFT JOIN l ON l.assignment_id=e.assignment_id AND l.user_id=e.user_id
		LEFT JOIN g ON g.assignment_id=e.assignment_id AND g.user_id=e.user_id
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
	Missed      []StudyQuestion    `json:"missed" nullable:"false"`
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
	// Mark is after any late penalty, of Total (a graded Assignment's grade of
	// its points); WaitingMarks are not decided yet.
	Mark         *float64 `json:"mark,omitempty"`
	Total        *float64 `json:"total,omitempty"`
	WaitingMarks float64  `json:"waitingMarks"`
	Running      bool     `json:"running"`
	Missing      bool     `json:"missing"`
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
	out := MemberProfile{UserID: memberID, Assignments: []MemberAssignment{}, Topics: []SummaryTopic{}, Missed: []StudyQuestion{}, Activity: []MemberActivity{}}
	if err := s.membersStaff(ctx, userID, wsID); err != nil {
		return out, err
	}
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(u.name,''), u.id),
			COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, ''), wm.created_at,
			GREATEST((SELECT max(created_at) FROM answer_events WHERE workspace_id=$1 AND user_id=$2),
				(SELECT max(t.submitted_at) FROM attempts t JOIN assignments a ON a.id=t.assignment_id
					WHERE a.workspace_id=$1 AND t.user_id=$2))
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
	topics, err := s.topicsOf(ctx, wsID)
	if err != nil {
		return out, err
	}
	standings, err := s.membersStandings(ctx, wsID, []string{memberID}, topics, now)
	if err != nil {
		return out, err
	}
	if standings[memberID] != nil {
		out.Topics = standings[memberID]
	}
	// Frequently wrong: the first of the member's wrong questions, the rest
	// behind its See all (WorkspaceMemberQuestions).
	missed, err := s.studyQuestions(ctx, wsID, memberID, QuestionsFilter{Wrong: true}, false, topics)
	if err != nil {
		return out, err
	}
	out.Missed = missed[:min(len(missed), missedShown)]
	if out.Activity, err = s.memberActivity(ctx, wsID, memberID, topics); err != nil {
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
	rows, err := s.pool.Query(ctx, `SELECT id FROM assignments WHERE workspace_id=$1 AND NOT draft`, wsID)
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
			COALESCE(l.mark, g.mark)::float8, COALESCE(l.total, g.total)::float8, COALESCE(l.waiting_marks, 0)::float8,
			EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=a.id AND t.user_id=$2 AND t.submitted_at IS NULL)
		FROM e JOIN assignments a ON a.id=e.assignment_id
		LEFT JOIN LATERAL (SELECT t.id, t.submitted_at, t.total, t.waiting_marks, `+attemptMarkSQL+` AS mark
			FROM attempts t WHERE t.assignment_id=a.id AND t.user_id=$2 AND t.submitted_at IS NOT NULL
			ORDER BY `+countedAttemptOrder+` LIMIT 1) l ON true
		LEFT JOIN (`+gradesSQL+`) g ON g.assignment_id=a.id AND g.user_id=$2
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

// findItem is the item with id among items.
func findItem(items []studyItem, id string) (studyItem, bool) {
	for _, it := range items {
		if it.ItemID == id {
			return it, true
		}
	}
	return studyItem{}, false
}

// memberActivity is the member's latest work here: practice quiz attempts,
// each day's reviews per topic, and assignment submissions.
func (s *Store) memberActivity(ctx context.Context, wsID, memberID string, topics workspaceTopics) ([]MemberActivity, error) {
	// A member's own practice quiz is private ("Only you"): it shows as its
	// topic, like a review, never by title.
	rows, err := s.pool.Query(ctx, `(SELECT CASE WHEN m.workspace_id=$1 THEN 'practice' ELSE 'review' END,
				CASE WHEN m.workspace_id=$1 THEN m.title END, t.id, t.name,
				`+practiceChecksSQL+`, max(ae.created_at)
			FROM answer_events ae JOIN materials m ON m.id=ae.material_id
			LEFT JOIN topics t ON t.id=COALESCE(m.topic_id, m.practice_topic_id) AND t.workspace_id=$1
			WHERE ae.workspace_id=$1 AND ae.user_id=$2 AND ae.source='quiz'
			GROUP BY ae.attempt_id, m.workspace_id, m.title, t.id, t.name)
		UNION ALL
		(SELECT 'assignment', a.title, NULL, NULL, a.question_count, t.submitted_at
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE a.workspace_id=$1 AND t.user_id=$2 AND t.submitted_at IS NOT NULL)
		ORDER BY 6 DESC LIMIT $3`, wsID, memberID, activityShown)
	if err != nil {
		return nil, err
	}
	out := []MemberActivity{}
	for rows.Next() {
		var a MemberActivity
		var title, topicID, topicName *string
		if err := rows.Scan(&a.Kind, &title, &topicID, &topicName, &a.Questions, &a.At); err != nil {
			rows.Close()
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
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	reviews, err := s.memberReviewDays(ctx, wsID, memberID, topics)
	if err != nil {
		return nil, err
	}
	out = append(out, reviews...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	if len(out) > activityShown {
		out = out[:activityShown]
	}
	return out, nil
}

// memberReviewDays is the member's reviews on their latest days with any, each
// day's grouped by each question's topics, a check under every one (Epo
// 2026-11-15, itemTopics over its quiz's current content); a deleted quiz's by
// the topics it was given in.
func (s *Store) memberReviewDays(ctx context.Context, wsID, memberID string, topics workspaceTopics) ([]MemberActivity, error) {
	rows, err := s.pool.Query(ctx, `SELECT COALESCE(ae.material_id, ''), COALESCE(m.revision, 0), COALESCE(m.topic_id, m.practice_topic_id), ae.topic_ids,
			ae.question_id, ae.created_at, date_trunc('day', ae.created_at)
		FROM answer_events ae LEFT JOIN materials m ON m.id=ae.material_id
		WHERE ae.workspace_id=$1 AND ae.user_id=$2 AND ae.source='review'
			AND ae.created_at >= (SELECT min(d) FROM (SELECT DISTINCT date_trunc('day', created_at) d FROM answer_events
				WHERE workspace_id=$1 AND user_id=$2 AND source='review' ORDER BY d DESC LIMIT $3) days)`, wsID, memberID, activityShown)
	if err != nil {
		return nil, err
	}
	type event struct {
		material, question string
		quizTopic          *string
		given              []string
		at, day            time.Time
	}
	var events []event
	revisions := map[string]int64{}
	for rows.Next() {
		var e event
		var revision int64
		if err := rows.Scan(&e.material, &revision, &e.quizTopic, &e.given, &e.question, &e.at, &e.day); err != nil {
			rows.Close()
			return nil, err
		}
		if e.material != "" {
			revisions[e.material] = revision
		}
		events = append(events, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	docs, err := s.cachedItems(ctx, revisions)
	if err != nil {
		return nil, err
	}
	type group struct {
		MemberActivity
		checks map[string]bool
	}
	byKey := map[string]*group{}
	var order []*group
	for _, e := range events {
		ids := e.given
		if e.material != "" {
			ids = nil
			if it, ok := findItem(docs[e.material], e.question); ok {
				ids = itemTopics(it, e.quizTopic, topics)
			} else if e.quizTopic != nil {
				ids = []string{*e.quizTopic}
			}
		}
		var held []string
		for _, id := range ids {
			if topics.has(id) {
				held = append(held, id)
			}
		}
		for _, topic := range topicKeys(held) {
			key := e.day.String() + "/" + topic
			g := byKey[key]
			if g == nil {
				g = &group{MemberActivity: MemberActivity{Kind: "review", Group: GroupOthers}, checks: map[string]bool{}}
				if topic != "" {
					g.Group, g.TopicName = GroupTopic, topics.names[topic]
				}
				byKey[key] = g
				order = append(order, g)
			}
			// A review's check is its question's parts sharing a time.
			g.checks[e.material+"/"+e.question+"/"+e.at.String()] = true
			if e.at.After(g.At) {
				g.At = e.at
			}
		}
	}
	out := make([]MemberActivity, 0, len(order))
	for _, g := range order {
		g.Questions = len(g.checks)
		out = append(out, g.MemberActivity)
	}
	return out, nil
}
