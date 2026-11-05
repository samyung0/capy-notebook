package store

import (
	"context"
	"encoding/json"
	"errors"
	"hash/fnv"
	"math"
	"math/rand"
	"reflect"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/questions"
)

// Assignments (todo-study-tracking.md §4, §5, §7; openwiki/study-progress.md
// #assignments): work a class's owner or teaching assistants give its members.
// A marked one serves a frozen copy of a quiz, never the quiz; an unmarked one
// is a title and files members tick off. Only a class has them: in a personal
// workspace they are hidden, not deleted, until it changes back (board U3).

const (
	AssignmentMarked   = "marked"
	AssignmentUnmarked = "unmarked"

	// assignmentGrace is how long past its time or its closing an attempt still
	// takes a save or a submit: the browser submits at zero or on hearing it
	// closed, and the request takes a moment.
	assignmentGrace = 15 * time.Second
	// assignmentAggregateMin is how many results a shared number needs (Epo
	// 2026-11-03, §11.8: aggregates need at least 5 members).
	assignmentAggregateMin = practiceAverageMin
	// assignmentNoteMax caps a comment on an answer.
	assignmentNoteMax = 2000
)

var (
	// ErrAssignmentClosed refuses starting or submitting after the owner closed it.
	ErrAssignmentClosed = errors.New("this assignment is closed")
	// ErrAssignmentNoAttempts refuses a start with every attempt used.
	ErrAssignmentNoAttempts = errors.New("no attempts are left on this assignment")
	// ErrAttemptFinished refuses a save or submit of a submitted attempt.
	ErrAttemptFinished = errors.New("this attempt has been submitted")
	// ErrAssignmentQuizGone refuses publishing a draft whose quiz was deleted.
	ErrAssignmentQuizGone = errors.New("the quiz this assignment was made from is gone")
)

// AssignmentInputError refuses a form value; its text is shown as is.
type AssignmentInputError struct{ Detail string }

func (e *AssignmentInputError) Error() string { return e.Detail }

func assignmentInput(detail string) error { return &AssignmentInputError{Detail: detail} }

// Assignment is one row of Study → Assignments and the head of an assignment's
// pages. Manage is for a class's owner and editor members, Mine for whoever it
// was given to (an owner or editor who ticked themselves gets both).
type Assignment struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Kind        string    `json:"kind" enum:"marked,unmarked"`
	Title       string    `json:"title"`
	PostedAt    time.Time `json:"postedAt"`
	// PostedBy is the name of who made it, empty once the account is gone.
	PostedBy string     `json:"postedBy"`
	DueAt    *time.Time `json:"dueAt,omitempty"`
	// ClosedAt is when it closed: by hand, or at the due date under NoLate.
	ClosedAt *time.Time `json:"closedAt,omitempty"`
	// Closed: as ClosedAt, and an unmarked one past its due date, which only
	// leaves the open list.
	Closed bool `json:"closed"`
	Draft  bool `json:"draft"`
	// NoLate: it closes itself at the due date. Off, late work is open until it
	// is closed by hand, with LatePenaltyPct (0, 20 or 50) off its mark.
	NoLate         bool `json:"noLate"`
	LatePenaltyPct int  `json:"latePenaltyPct"`
	// TimeLimitMin, when set, starts the server's clock at Start.
	TimeLimitMin *int `json:"timeLimitMin,omitempty"`
	Attempts     int  `json:"attempts"`
	// Questions and Marks are the frozen copy's; 0 on a draft and when unmarked.
	Questions int     `json:"questions"`
	Marks     float64 `json:"marks"`
	// TopicIDs: its quiz's topic, or its files' with the most-used first.
	TopicIDs []string         `json:"topicIds" nullable:"false"`
	Files    []AssignmentFile `json:"files" nullable:"false"`
	// PracticeQuizID is its quiz once that shows as practice to the caller.
	PracticeQuizID *string           `json:"practiceQuizId,omitempty"`
	Manage         *AssignmentManage `json:"manage,omitempty"`
	Mine           *AssignmentMine   `json:"mine,omitempty"`
}

// AssignmentFile is an unmarked assignment's file or material.
type AssignmentFile struct {
	FileID     *string `json:"fileId,omitempty"`
	MaterialID *string `json:"materialId,omitempty"`
	Name       string  `json:"name"`
	// Kind is the file's or material's kind, which picks its icon.
	Kind string `json:"kind"`
}

// AssignmentManage is what its owner and teaching assistants read.
type AssignmentManage struct {
	QuizID *string `json:"quizId,omitempty"`
	// QuizTitle is its quiz's current title, for the edit form.
	QuizTitle string `json:"quizTitle,omitempty"`
	// QuizTrashed: its quiz is in the trash, with nothing to open or republish.
	QuizTrashed    bool     `json:"quizTrashed,omitempty"`
	AssignAll      bool     `json:"assignAll"`
	Assignees      []string `json:"assignees" nullable:"false"`
	ApproveAIMarks bool     `json:"approveAiMarks"`
	ShowAnswers    bool     `json:"showAnswers"`
	Shuffle        bool     `json:"shuffle"`
	// Assigned counts who it went to; Done those who submitted or ticked it.
	Assigned int `json:"assigned"`
	Done     int `json:"done"`
	// Average is the submitted members' counted marks, after any late penalty, over
	// the marks decided so far (0 to 1), once at least five submitted.
	Average *float64 `json:"average,omitempty"`
	// ToApprove counts answers waiting for the owner, in any submission of a
	// member's: one that does not count yet can still become the highest.
	ToApprove int `json:"toApprove"`
}

// AssignmentMine is the caller's own state on an assignment given to them.
type AssignmentMine struct {
	// Done: a marked one submitted, an unmarked one ticked.
	Done   bool       `json:"done"`
	DoneAt *time.Time `json:"doneAt,omitempty"`
	// RunningAttemptID is the attempt in progress.
	RunningAttemptID *string `json:"runningAttemptId,omitempty"`
	AttemptsUsed     int     `json:"attemptsUsed"`
	// CountedAttemptID is the submission that counts (countedAttemptOrder), which
	// the rest of this reads.
	CountedAttemptID *string `json:"countedAttemptId,omitempty"`
	// Correct is the marks decided; Mark the same after any late penalty, which
	// is what counts.
	Correct        *float64 `json:"correct,omitempty"`
	Mark           *float64 `json:"mark,omitempty"`
	Total          *float64 `json:"total,omitempty"`
	WaitingMarks   float64  `json:"waitingMarks"`
	WaitingAnswers int      `json:"waitingAnswers"`
	// Late: submitted after its due date; LatePenaltyPct is what that cost.
	Late           bool `json:"late"`
	LatePenaltyPct int  `json:"latePenaltyPct"`
	// Missing: a marked one past its due date with nothing submitted.
	Missing bool `json:"missing"`
}

// AssignmentList is Study → Assignments. Members counts the workspace's viewer
// members, for its owner and teaching assistants.
type AssignmentList struct {
	Items   []Assignment `json:"items" nullable:"false"`
	Members *int         `json:"members,omitempty"`
}

// AssignmentForm is what the New assignment dialog sets. Questions is the
// quiz's current content, read by the caller after projecting live edits; a
// marked assignment freezes it unless it is a draft.
type AssignmentForm struct {
	Kind           string
	Title          string
	QuizID         string
	Questions      []map[string]any
	DueAt          *time.Time
	TimeLimitMin   *int
	Attempts       int
	NoLate         bool
	LatePenaltyPct int
	AssignAll      bool
	Assignees      []string
	Draft          bool
	ApproveAIMarks bool
	ShowAnswers    bool
	Shuffle        bool
	Files          []AssignmentFileRef
}

// AssignmentFileRef names one file or material of an unmarked assignment.
type AssignmentFileRef struct {
	FileID     string `json:"fileId,omitempty"`
	MaterialID string `json:"materialId,omitempty"`
}

/* ------------------------------------------------------------------- reads */

// assignmentStaff is the caller's standing in a class: true for an owner or
// editor member (persisted: a share-role editor sees only their own). A workspace
// that is not a class has no assignments for anyone.
func (s *Store) assignmentStaff(ctx context.Context, q rowQueryer, userID, wsID string) (bool, error) {
	member, effective, err := workspaceRoles(ctx, q, userID, wsID)
	if err != nil {
		return false, err
	}
	if effective == "" {
		return false, ErrNotFound
	}
	var kind WorkspaceKind
	if err := q.QueryRow(ctx, `SELECT kind FROM workspaces WHERE id=$1`, wsID).Scan(&kind); err != nil {
		return false, err
	}
	if kind != WorkspaceClass {
		return false, ErrNotFound
	}
	return RoleCanEdit(member), nil
}

const assignmentCols = `a.id, a.workspace_id, a.kind, a.title, a.posted_at, COALESCE(NULLIF(u.name,''), u.id, ''),
	a.due_at, a.closed_at, a.no_late, a.late_penalty_pct, a.draft, a.time_limit_min, a.attempts_allowed, a.question_count, a.total_marks::float8,
	a.source_quiz_id, COALESCE(m.title,''), m.topic_id, COALESCE(m.hidden, false), m.trashed_at IS NOT NULL,
	a.assign_all, a.approve_ai_marks, a.show_answers, a.shuffle, a.released_at`

// readAssignments reads the rows matching where (assignments a, users u and
// materials m aliased) and fills what the caller may see of them; a caller who
// is not staff keeps only those given to them.
func (s *Store) readAssignments(ctx context.Context, userID string, staff bool, now time.Time, where string, args ...any) ([]Assignment, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+assignmentCols+`
		FROM assignments a LEFT JOIN users u ON u.id=a.created_by LEFT JOIN materials m ON m.id=a.source_quiz_id
		WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type source struct {
		topicID  *string
		hidden   bool
		trashed  bool
		released *time.Time
	}
	var list []Assignment
	sources := map[string]source{}
	for rows.Next() {
		var a Assignment
		var manage AssignmentManage
		var src source
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.Kind, &a.Title, &a.PostedAt, &a.PostedBy,
			&a.DueAt, &a.ClosedAt, &a.NoLate, &a.LatePenaltyPct, &a.Draft, &a.TimeLimitMin, &a.Attempts, &a.Questions, &a.Marks,
			&manage.QuizID, &manage.QuizTitle, &src.topicID, &src.hidden, &src.trashed,
			&manage.AssignAll, &manage.ApproveAIMarks, &manage.ShowAnswers, &manage.Shuffle, &src.released); err != nil {
			return nil, err
		}
		a.ClosedAt = assignmentClosedAt(a.NoLate, a.DueAt, a.ClosedAt, now)
		a.Closed = a.ClosedAt != nil || (a.Kind == AssignmentUnmarked && a.DueAt != nil && !a.DueAt.After(now))
		a.TopicIDs, a.Files = []string{}, []AssignmentFile{}
		if src.topicID != nil {
			a.TopicIDs = []string{*src.topicID}
		}
		manage.Assignees = []string{}
		manage.QuizTrashed = src.trashed
		if staff {
			a.Manage = &manage
		}
		// Hidden again by the owner, it is no longer practice for members.
		if manage.QuizID != nil && src.released != nil && !src.trashed && (staff || !src.hidden) {
			a.PracticeQuizID = manage.QuizID
		}
		sources[a.ID] = src
		list = append(list, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(list) == 0 {
		return []Assignment{}, nil
	}
	ids := make([]string, len(list))
	at := make(map[string]int, len(list))
	for i, a := range list {
		ids[i], at[a.ID] = a.ID, i
	}
	if err := s.fillAssignmentFiles(ctx, userID, ids, at, list); err != nil {
		return nil, err
	}
	if staff {
		if err := s.fillAssignmentManage(ctx, ids, at, list); err != nil {
			return nil, err
		}
	}
	if err := s.fillAssignmentMine(ctx, userID, ids, at, list, now); err != nil {
		return nil, err
	}
	if staff {
		return list, nil
	}
	mine := list[:0]
	for _, a := range list {
		if a.Mine != nil {
			mine = append(mine, a)
		}
	}
	return mine, nil
}

// assignmentClosedAt is when it closed, if it has: by hand, or under No late
// submissions at its due date, the earlier of the two. A due date alone closes
// nothing (Epo 2026-11-04): late work stays open until it is closed by hand.
func assignmentClosedAt(noLate bool, due, closed *time.Time, now time.Time) *time.Time {
	if noLate && due != nil && !due.After(now) && (closed == nil || due.Before(*closed)) {
		return due
	}
	return closed
}

// assignmentLate is whether a submission came after the due date. Under No late
// submissions nothing is late: a running attempt is submitted for its member.
func assignmentLate(noLate bool, due *time.Time, submitted time.Time) bool {
	return !noLate && due != nil && submitted.After(*due)
}

// penaltyFor is the percentage a late submission loses.
func penaltyFor(late bool, pct int) int {
	if late {
		return pct
	}
	return 0
}

// penalisedMark is a submission's mark after a late penalty, to two places. The
// penalty is a share of the mark itself, so it holds as open parts are marked.
// Per-part marks, answer events and reviews keep the marks as awarded: lateness
// says nothing about what the member knows.
func penalisedMark(correct float64, pct int) float64 {
	return math.Round(correct*float64(100-pct)) / 100
}

// attemptMarkSQL is a submission's mark after any late penalty (attempts t of
// assignments a), as assignmentLate and penalisedMark have it.
const attemptMarkSQL = `round(t.correct * (100 - CASE WHEN NOT a.no_late AND t.submitted_at > a.due_at
	THEN a.late_penalty_pct ELSE 0 END) / 100.0, 2)`

// countedAttemptOrder puts first the submission of a member's that counts (Epo
// 2026-11-05): the highest share of its own total after any late penalty, as a
// republish can change the total, a tie to the latest. It reads live: correct is
// the marks decided so far, so marking an open part or changing the penalty or
// due date can change which one it is.
const countedAttemptOrder = attemptMarkSQL + ` / NULLIF(t.total, 0) DESC NULLS LAST, t.submitted_at DESC`

// fillAssignmentFiles adds each unmarked assignment's files the caller can see,
// in the order added, and takes its topics from them, the most used first.
func (s *Store) fillAssignmentFiles(ctx context.Context, userID string, ids []string, at map[string]int, list []Assignment) error {
	rows, err := s.pool.Query(ctx, `SELECT af.assignment_id, f.id, m.id, COALESCE(f.name, m.title), COALESCE(f.kind::text, m.kind::text),
			COALESCE(f.topic_id, m.topic_id)
		FROM assignment_files af
		JOIN assignments a ON a.id=af.assignment_id
		LEFT JOIN files f ON f.id=af.file_id AND f.trashed_at IS NULL
		LEFT JOIN materials m ON m.id=af.material_id AND m.trashed_at IS NULL
		WHERE af.assignment_id = ANY($1) AND (f.id IS NOT NULL OR m.id IS NOT NULL)
			AND workspace_item_visible(COALESCE(f.hidden, m.hidden), a.workspace_id, $2)
		ORDER BY af.assignment_id, af.position`, ids, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	used := map[string]map[string]int{}
	for rows.Next() {
		var id string
		var file AssignmentFile
		var topic *string
		if err := rows.Scan(&id, &file.FileID, &file.MaterialID, &file.Name, &file.Kind, &topic); err != nil {
			return err
		}
		a := &list[at[id]]
		a.Files = append(a.Files, file)
		if topic != nil {
			if used[id] == nil {
				used[id] = map[string]int{}
			}
			if used[id][*topic] == 0 {
				a.TopicIDs = append(a.TopicIDs, *topic)
			}
			used[id][*topic]++
		}
	}
	for id, counts := range used {
		topics := list[at[id]].TopicIDs
		sort.SliceStable(topics, func(i, j int) bool { return counts[topics[i]] > counts[topics[j]] })
	}
	return rows.Err()
}

// assigneesSQL lists who each of the assignments in $1 went to: the workspace's
// viewers when it is for all members, plus anyone named who is still a member.
// A workspace that is not a class gives them to nobody until it changes back.
const assigneesSQL = `SELECT a.id AS assignment_id, wm.user_id
	FROM assignments a JOIN workspaces aw ON aw.id=a.workspace_id AND aw.kind='class'
	JOIN workspace_members wm ON wm.workspace_id=a.workspace_id
	WHERE a.id = ANY($1) AND ((a.assign_all AND wm.role='viewer')
		OR EXISTS (SELECT 1 FROM assignment_assignees aa WHERE aa.assignment_id=a.id AND aa.user_id=wm.user_id))`

// fillAssignmentManage adds the counts and the named assignees.
func (s *Store) fillAssignmentManage(ctx context.Context, ids []string, at map[string]int, list []Assignment) error {
	rows, err := s.pool.Query(ctx, `WITH e AS (`+assigneesSQL+`),
		l AS (
			SELECT DISTINCT ON (t.assignment_id, t.user_id) t.assignment_id, t.total, t.waiting_marks, `+attemptMarkSQL+` AS mark
			FROM attempts t JOIN e ON e.assignment_id=t.assignment_id AND e.user_id=t.user_id
			JOIN assignments a ON a.id=t.assignment_id
			WHERE t.submitted_at IS NOT NULL
			ORDER BY t.assignment_id, t.user_id, `+countedAttemptOrder+`),
		c AS (SELECT assignment_id, count(*) AS n FROM e GROUP BY 1),
		d AS (SELECT d.assignment_id, count(*) AS n FROM assignment_done d
			JOIN e ON e.assignment_id=d.assignment_id AND e.user_id=d.user_id GROUP BY 1),
		r AS (SELECT assignment_id, count(*) AS n, avg(mark / NULLIF(total - waiting_marks, 0))::float8 AS mean
			FROM l GROUP BY 1),
		w AS (SELECT t.assignment_id, sum(t.waiting_answers)::int AS n
			FROM attempts t JOIN e ON e.assignment_id=t.assignment_id AND e.user_id=t.user_id
			WHERE t.submitted_at IS NOT NULL GROUP BY 1)
		SELECT c.assignment_id, c.n, COALESCE(d.n, 0), COALESCE(r.n, 0), r.mean, COALESCE(w.n, 0)
		FROM c LEFT JOIN d ON d.assignment_id=c.assignment_id LEFT JOIN r ON r.assignment_id=c.assignment_id
		LEFT JOIN w ON w.assignment_id=c.assignment_id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var assigned, ticked, submitted, waiting int
		var mean *float64
		if err := rows.Scan(&id, &assigned, &ticked, &submitted, &mean, &waiting); err != nil {
			return err
		}
		m := list[at[id]].Manage
		m.Assigned, m.Done, m.ToApprove = assigned, ticked+submitted, waiting
		if submitted >= assignmentAggregateMin {
			m.Average = mean
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	// Who is still a member: a departed name would be refused when the form saves.
	named, err := s.pool.Query(ctx, `SELECT x.assignment_id, x.user_id FROM assignment_assignees x
		JOIN assignments a ON a.id=x.assignment_id
		JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.user_id=x.user_id
		WHERE x.assignment_id = ANY($1) ORDER BY x.assignment_id, x.user_id`, ids)
	if err != nil {
		return err
	}
	defer named.Close()
	for named.Next() {
		var id, user string
		if err := named.Scan(&id, &user); err != nil {
			return err
		}
		m := list[at[id]].Manage
		m.Assignees = append(m.Assignees, user)
	}
	return named.Err()
}

// fillAssignmentMine adds the caller's state on the published assignments that
// went to them.
func (s *Store) fillAssignmentMine(ctx context.Context, userID string, ids []string, at map[string]int, list []Assignment, now time.Time) error {
	rows, err := s.pool.Query(ctx, `WITH e AS (`+assigneesSQL+`)
		SELECT e.assignment_id,
			(SELECT done_at FROM assignment_done d WHERE d.assignment_id=e.assignment_id AND d.user_id=$2),
			(SELECT t.id FROM attempts t WHERE t.assignment_id=e.assignment_id AND t.user_id=$2 AND t.submitted_at IS NULL),
			(SELECT count(*) FROM attempts t WHERE t.assignment_id=e.assignment_id AND t.user_id=$2 AND t.submitted_at IS NOT NULL),
			l.id, l.correct::float8, l.total::float8, COALESCE(l.waiting_marks, 0)::float8, COALESCE(l.waiting_answers, 0), l.submitted_at
		FROM e
		LEFT JOIN LATERAL (SELECT t.id, t.correct, t.total, t.waiting_marks, t.waiting_answers, t.submitted_at
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.assignment_id=e.assignment_id AND t.user_id=$2 AND t.submitted_at IS NOT NULL
			ORDER BY `+countedAttemptOrder+` LIMIT 1) l ON true
		WHERE e.user_id=$2`, ids, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var mine AssignmentMine
		var submittedAt *time.Time
		if err := rows.Scan(&id, &mine.DoneAt, &mine.RunningAttemptID, &mine.AttemptsUsed,
			&mine.CountedAttemptID, &mine.Correct, &mine.Total, &mine.WaitingMarks, &mine.WaitingAnswers, &submittedAt); err != nil {
			return err
		}
		a := &list[at[id]]
		if a.Draft {
			continue
		}
		if submittedAt != nil {
			mine.DoneAt = submittedAt
			mine.Late = assignmentLate(a.NoLate, a.DueAt, *submittedAt)
			mine.LatePenaltyPct = penaltyFor(mine.Late, a.LatePenaltyPct)
			mark := penalisedMark(*mine.Correct, mine.LatePenaltyPct)
			mine.Mark = &mark
		}
		mine.Done = mine.DoneAt != nil
		mine.Missing = a.Kind == AssignmentMarked && !mine.Done && a.DueAt != nil && !a.DueAt.After(now)
		a.Mine = &mine
	}
	return rows.Err()
}

// ListAssignments is Study → Assignments: every assignment for a class's owner
// and editor members, the published ones given to them for anyone else. Open
// ones come first by due date, the latest closed after them.
func (s *Store) ListAssignments(ctx context.Context, userID, wsID string, now time.Time) (AssignmentList, error) {
	out := AssignmentList{Items: []Assignment{}}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, wsID)
	if err != nil {
		return out, err
	}
	out.Items, err = s.readAssignments(ctx, userID, staff, now, `a.workspace_id=$1`, wsID)
	if err != nil {
		return out, err
	}
	sort.SliceStable(out.Items, func(i, j int) bool {
		a, b := out.Items[i], out.Items[j]
		if a.Closed != b.Closed {
			return b.Closed
		}
		switch {
		case a.DueAt == nil && b.DueAt == nil:
			return a.PostedAt.After(b.PostedAt)
		case a.DueAt == nil:
			return false
		case b.DueAt == nil:
			return true
		case a.Closed:
			return a.DueAt.After(*b.DueAt)
		}
		return a.DueAt.Before(*b.DueAt)
	})
	if staff {
		var members int
		if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND role='viewer'`, wsID).Scan(&members); err != nil {
			return out, err
		}
		out.Members = &members
	}
	return out, nil
}

// GetAssignment reads one assignment the caller may see.
func (s *Store) GetAssignment(ctx context.Context, userID, id string, now time.Time) (Assignment, error) {
	wsID, err := s.assignmentWorkspace(ctx, id)
	if err != nil {
		return Assignment{}, err
	}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, wsID)
	if err != nil {
		return Assignment{}, err
	}
	list, err := s.readAssignments(ctx, userID, staff, now, `a.id=$1`, id)
	if err != nil {
		return Assignment{}, err
	}
	if len(list) == 0 {
		return Assignment{}, ErrNotFound
	}
	return list[0], nil
}

func (s *Store) assignmentWorkspace(ctx context.Context, id string) (string, error) {
	var wsID string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM assignments WHERE id=$1`, id).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return wsID, err
}

/* ------------------------------------------------------------------ writes */

// checkAssignmentForm checks the form against the workspace, in the write's
// transaction: its quiz, assignees and files must belong here.
func checkAssignmentForm(ctx context.Context, tx pgx.Tx, wsID string, form AssignmentForm) error {
	if form.Kind != AssignmentMarked && form.Kind != AssignmentUnmarked {
		return assignmentInput("choose marked or unmarked")
	}
	title := strings.TrimSpace(form.Title)
	if title == "" || len([]rune(title)) > 120 {
		return assignmentInput("a title has 1 to 120 characters")
	}
	if form.Attempts < 1 || form.Attempts > 10 {
		return assignmentInput("attempts are 1 to 10")
	}
	if err := checkLatePolicy(form); err != nil {
		return err
	}
	if form.TimeLimitMin != nil && (*form.TimeLimitMin < 1 || *form.TimeLimitMin > 1440) {
		return assignmentInput("a time limit is 1 to 1440 minutes")
	}
	if !form.AssignAll && len(form.Assignees) == 0 {
		return assignmentInput("choose who it is for")
	}
	if form.Kind == AssignmentMarked {
		if !form.Draft && form.DueAt == nil {
			return assignmentInput("choose a due date")
		}
		if len(form.Files) > 0 {
			return assignmentInput("a marked assignment takes a quiz, not files")
		}
	} else if form.QuizID != "" || form.TimeLimitMin != nil {
		return assignmentInput("an unmarked assignment has no quiz or time limit")
	}
	if len(form.Assignees) > 0 {
		var known int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND user_id = ANY($2)`,
			wsID, form.Assignees).Scan(&known); err != nil {
			return err
		}
		if known != len(uniqueStrings(form.Assignees)) {
			return assignmentInput("only members can be assigned")
		}
	}
	for _, f := range form.Files {
		var found bool
		var err error
		switch {
		case f.FileID != "" && f.MaterialID == "":
			err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL)`,
				f.FileID, wsID).Scan(&found)
		case f.MaterialID != "" && f.FileID == "":
			err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM materials WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL AND parent_material_id IS NULL)`,
				f.MaterialID, wsID).Scan(&found)
		}
		if err != nil {
			return err
		}
		if !found {
			return assignmentInput("a file is not in this workspace")
		}
	}
	return nil
}

// checkLatePolicy holds the due date's policy to what the form offers: it needs a
// marked assignment with a due date, and a penalty only applies when late work
// is taken.
func checkLatePolicy(form AssignmentForm) error {
	switch form.LatePenaltyPct {
	case 0, 20, 50:
	default:
		return assignmentInput("a late penalty is none, 20% or 50%")
	}
	if !form.NoLate && form.LatePenaltyPct == 0 {
		return nil
	}
	if form.Kind != AssignmentMarked || form.DueAt == nil {
		return assignmentInput("a late policy needs a marked assignment with a due date")
	}
	if form.NoLate && form.LatePenaltyPct != 0 {
		return assignmentInput("no late submissions leaves nothing to penalise")
	}
	return nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// lockAssignmentStaffTx admits an owner or editor member of the class, not
// frozen, and holds the workspace row (and the also accounts) for the write.
func (s *Store) lockAssignmentStaffTx(ctx context.Context, tx pgx.Tx, wsID, actorID string, also ...string) error {
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, actorID, also...); err != nil {
		return err
	}
	staff, err := s.assignmentStaff(ctx, tx, actorID, wsID)
	if err != nil {
		return err
	}
	if !staff {
		return ErrNotFound
	}
	return nil
}

// assignmentPayer reads an assignment's workspace and whoever its frozen copy is
// charged to, for the writes that take that charge off them.
func (s *Store) assignmentPayer(ctx context.Context, id string) (string, *string, error) {
	var wsID string
	var payer *string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id, frozen_by FROM assignments WHERE id=$1`, id).Scan(&wsID, &payer)
	if isNoRows(err) {
		return "", nil, ErrNotFound
	}
	return wsID, payer, err
}

// lockAssignmentPayerRowsTx holds the workspace and, in id order, the rows of the
// owner, the actor and whoever a frozen copy is charged to, for a write that moves
// that charge. The meter's foreign key needs the payer's row held, but their account
// state decides nothing: a publisher suspended or leaving must not hide the
// assignment from the class's staff.
func (s *Store) lockAssignmentPayerRowsTx(ctx context.Context, tx pgx.Tx, wsID, actorID string, payer *string) error {
	ownerID, err := s.storageOwnerTx(ctx, tx, wsID)
	if err != nil {
		return err
	}
	ids := []string{ownerID, actorID}
	if payer != nil {
		ids = append(ids, *payer)
	}
	_, err = tx.Exec(ctx, `SELECT 1 FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`, ids)
	return err
}

// assignmentOpenSQL is a published assignment row a still taking work: neither
// closed by hand nor past a No late submissions due date.
const assignmentOpenSQL = `NOT a.draft AND a.closed_at IS NULL AND NOT (a.no_late AND a.due_at <= now())`

// quizAssignedToSQL reads the open assignment a viewer member takes this quiz
// through, the earliest due, or null (Epo 2026-11-04). While it reads an id the
// row lists for them, hidden or not, and opens that assignment, while the quiz
// itself is refused (materialEffectiveAccess) and is not their practice.
func quizAssignedToSQL(quiz, user string) string {
	return `(SELECT a.id FROM assignments a
		JOIN workspaces aw ON aw.id=a.workspace_id AND aw.kind='class'
		JOIN workspace_members am ON am.workspace_id=a.workspace_id AND am.user_id=` + user + ` AND am.role='viewer'
		WHERE a.source_quiz_id=` + quiz + ` AND ` + assignmentOpenSQL + `
			AND (a.assign_all OR EXISTS (SELECT 1 FROM assignment_assignees x WHERE x.assignment_id=a.id AND x.user_id=` + user + `))
		ORDER BY a.due_at, a.id LIMIT 1)`
}

// quizAssignmentOpenSQL reads whether any open assignment uses this quiz; only
// the workspace's owner and teaching assistants clone it then.
func quizAssignmentOpenSQL(quiz string) string {
	return `EXISTS (SELECT 1 FROM assignments a JOIN workspaces aw ON aw.id=a.workspace_id AND aw.kind='class'
		WHERE a.source_quiz_id=` + quiz + ` AND ` + assignmentOpenSQL + `)`
}

// materialAssignedCols reads a materials row m's Assigned and AssignmentID for
// the caller: the icon shows to whoever it went to and whoever edits the quiz.
func materialAssignedCols(user string) string {
	return `m.kind='quiz' AND m.workspace_id IS NOT NULL AND (` + quizAssignedToSQL("m.id", user) + ` IS NOT NULL
			OR (` + quizAssignmentOpenSQL("m.id") + ` AND ` + editableWorkspaceSQL("m.workspace_id", user) + `)),
		COALESCE(` + quizAssignedToSQL("m.id", user) + `, '')`
}

// CreateAssignment makes an assignment, freezing a marked one's quiz unless it
// is a draft. It changes nothing about the quiz (Epo 2026-11-04).
func (s *Store) CreateAssignment(ctx context.Context, actorID, wsID string, form AssignmentForm, now time.Time) (Assignment, error) {
	id := uid("as")
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		if err := checkAssignmentForm(ctx, tx, wsID, form); err != nil {
			return err
		}
		if form.Kind == AssignmentMarked {
			var quiz bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM materials WHERE id=$1 AND workspace_id=$2 AND kind='quiz'
				AND trashed_at IS NULL AND parent_material_id IS NULL)`, form.QuizID, wsID).Scan(&quiz); err != nil {
				return err
			}
			if !quiz {
				return assignmentInput("choose a quiz in this workspace")
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO assignments (id, workspace_id, created_by, kind, title, source_quiz_id,
				due_at, time_limit_min, attempts_allowed, no_late, late_penalty_pct, assign_all, draft, approve_ai_marks, show_answers, shuffle, posted_at, created_at)
			VALUES ($1,$2,$3,$4,$5,NULLIF($6::text,''),$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$16)`,
			id, wsID, actorID, form.Kind, strings.TrimSpace(form.Title), form.QuizID,
			form.DueAt, form.TimeLimitMin, form.Attempts, form.NoLate, form.LatePenaltyPct, form.AssignAll,
			form.ApproveAIMarks, form.ShowAnswers, form.Shuffle, now); err != nil {
			return err
		}
		if err := writeAssignmentLists(ctx, tx, id, form); err != nil {
			return err
		}
		if form.Draft {
			return nil
		}
		return s.publishAssignmentTx(ctx, tx, id, wsID, actorID, form.Kind, form.Questions, now)
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// writeAssignmentLists replaces its named assignees and files.
func writeAssignmentLists(ctx context.Context, tx pgx.Tx, id string, form AssignmentForm) error {
	if _, err := tx.Exec(ctx, `DELETE FROM assignment_assignees WHERE assignment_id=$1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO assignment_assignees (assignment_id, user_id)
		SELECT $1::text, unnest($2::text[])`, id, uniqueStrings(form.Assignees)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM assignment_files WHERE assignment_id=$1`, id); err != nil {
		return err
	}
	for i, f := range form.Files {
		if _, err := tx.Exec(ctx, `INSERT INTO assignment_files (assignment_id, file_id, material_id, position)
			VALUES ($1, NULLIF($2::text,''), NULLIF($3::text,''), $4)`, id, f.FileID, f.MaterialID, i); err != nil {
			return err
		}
	}
	return nil
}

// publishAssignmentTx makes it members', posted now. A marked one freezes its
// quiz: its questions with their keys, and its images as new rows of the
// workspace with no material, so editing or deleting the quiz leaves them. The
// actor pays for the copied images, as for a clone (Epo 2026-10-11), and for the
// frozen questions (Epo 2026-11-05), so this is the last that fits their storage.
// A republish pays only for what it adds to what it replaces.
func (s *Store) publishAssignmentTx(ctx context.Context, tx pgx.Tx, id, wsID, actorID, kind string, qs []map[string]any, now time.Time) error {
	if kind == AssignmentUnmarked {
		_, err := tx.Exec(ctx, `UPDATE assignments SET draft=false, posted_at=$2 WHERE id=$1`, id, now)
		return err
	}
	if len(qs) == 0 {
		return assignmentInput("this quiz has no questions")
	}
	var assetIDs []string
	for _, q := range qs {
		assetIDs = append(assetIDs, questions.AssetIDs(q)...)
	}
	idMap, err := s.copyFrozenAssetsTx(ctx, tx, id, wsID, actorID, assetIDs, now)
	if err != nil {
		return err
	}
	var marks float64
	for _, q := range qs {
		if !questions.RewriteAssetIDs(q, idMap) {
			return assignmentInput("a question's image has been removed")
		}
		_, m := questionMarks(q)
		marks += m
	}
	if marks <= 0 {
		return assignmentInput("this quiz has no marks")
	}
	frozen, err := json.Marshal(qs)
	if err != nil {
		return err
	}
	size, err := storageJSONSizeTx(ctx, tx, string(frozen))
	if err != nil {
		return err
	}
	var replaced int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT frozen_bytes FROM assignments WHERE id=$1 AND frozen_by=$2), 0)`, id, actorID).Scan(&replaced); err != nil {
		return err
	}
	if err := s.gateStorageTx(ctx, tx, actorID, max(size-replaced, 0)); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE assignments SET draft=false, posted_at=$2, questions=$3, question_count=$4, total_marks=$5,
		frozen_by=$6, frozen_bytes=$7 WHERE id=$1`,
		id, now, frozen, len(qs), marks, actorID, size)
	return err
}

// copyFrozenAssetsTx copies the quiz's ready images and returns old id → new id.
// An image the assignment already holds from an earlier publish keeps its row.
func (s *Store) copyFrozenAssetsTx(ctx context.Context, tx pgx.Tx, assignmentID, wsID, actorID string, ids []string, now time.Time) (map[string]string, error) {
	idMap := map[string]string{}
	if len(ids) == 0 {
		return idMap, nil
	}
	rows, err := tx.Query(ctx, `SELECT s.id, s.object_path, s.size_bytes, h.id FROM editor_assets s
		LEFT JOIN LATERAL (SELECT x.id FROM editor_assets x WHERE x.assignment_id=$3 AND x.object_path=s.object_path
			AND x.status='ready' AND x.trashed_at IS NULL LIMIT 1) h ON true
		WHERE s.id = ANY($1) AND s.workspace_id=$2 AND s.status='ready' AND s.trashed_at IS NULL`, uniqueStrings(ids), wsID, assignmentID)
	if err != nil {
		return nil, err
	}
	copies := map[string]string{}
	var paths []string
	var bytes int64
	for rows.Next() {
		var id, path string
		var size int64
		var held *string
		if err := rows.Scan(&id, &path, &size, &held); err != nil {
			rows.Close()
			return nil, err
		}
		if held != nil {
			idMap[id] = *held
			continue
		}
		idMap[id] = uid("asset")
		copies[id] = idMap[id]
		paths = append(paths, path)
		bytes += size
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if bytes > 0 {
		if err := s.gateStorageTx(ctx, tx, actorID, bytes); err != nil {
			return nil, err
		}
	}
	if err := lockCloneBlobPathsTx(ctx, tx, paths); err != nil {
		return nil, err
	}
	for oldID, newID := range copies {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, assignment_id, user_id, created_by, name, purpose, object_path, content_type, size_bytes,
			 status, etag, created_at, completed_at, thumbnail_key)
			SELECT $1::text, workspace_id, NULL::text, $5::text, $2::text, $2::text, name, purpose, object_path, content_type, size_bytes,
				'ready', etag, $3::timestamptz, $3::timestamptz, thumbnail_key
			FROM editor_assets WHERE id=$4`, newID, actorID, now, oldID, assignmentID); err != nil {
			return nil, err
		}
	}
	return idMap, nil
}

// UpdateAssignment saves the form's settings; the kind, the quiz and a published
// assignment's frozen copy stay. A running attempt keeps its deadline.
func (s *Store) UpdateAssignment(ctx context.Context, actorID, id string, form AssignmentForm, now time.Time) (Assignment, error) {
	wsID, err := s.assignmentWorkspace(ctx, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		var kind string
		var draft bool
		var quizID *string
		if err := tx.QueryRow(ctx, `SELECT kind, draft, source_quiz_id FROM assignments WHERE id=$1 FOR UPDATE`, id).Scan(&kind, &draft, &quizID); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		form.Kind, form.Draft, form.QuizID = kind, draft, ""
		if quizID != nil {
			form.QuizID = *quizID
		}
		if err := checkAssignmentForm(ctx, tx, wsID, form); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE assignments SET title=$2, due_at=$3, time_limit_min=$4, attempts_allowed=$5,
				no_late=$6, late_penalty_pct=$7, assign_all=$8, approve_ai_marks=$9, show_answers=$10, shuffle=$11 WHERE id=$1`,
			id, strings.TrimSpace(form.Title), form.DueAt, form.TimeLimitMin, form.Attempts,
			form.NoLate, form.LatePenaltyPct, form.AssignAll, form.ApproveAIMarks, form.ShowAnswers, form.Shuffle); err != nil {
			return err
		}
		return writeAssignmentLists(ctx, tx, id, form)
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// PublishAssignment gives a draft to its members. questions is its quiz's
// current content, or nil when the quiz is gone.
func (s *Store) PublishAssignment(ctx context.Context, actorID, id string, qs []map[string]any, now time.Time) (Assignment, error) {
	wsID, err := s.assignmentWorkspace(ctx, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		var kind string
		var draft bool
		var due *time.Time
		if err := tx.QueryRow(ctx, `SELECT kind, draft, due_at FROM assignments WHERE id=$1 FOR UPDATE`, id).Scan(&kind, &draft, &due); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		if !draft {
			return nil
		}
		if kind == AssignmentMarked && due == nil {
			return assignmentInput("choose a due date")
		}
		if kind == AssignmentMarked && qs == nil {
			return ErrAssignmentQuizGone
		}
		return s.publishAssignmentTx(ctx, tx, id, wsID, actorID, kind, qs, now)
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// RepublishAssignment replaces an open marked assignment's frozen copy with its
// quiz as it is now (Epo 2026-11-05). A running attempt reads the new copy on its
// next load, without the saved answers that no longer fit (dropStaleAnswersTx); a
// submitted one keeps its graded copy and marks. Images it stops using stay until
// it is deleted, as submissions may show them. questions is nil when the quiz is gone.
func (s *Store) RepublishAssignment(ctx context.Context, actorID, id string, qs []map[string]any, now time.Time) (Assignment, error) {
	wsID, payer, err := s.assignmentPayer(ctx, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentPayerRowsTx(ctx, tx, wsID, actorID, payer); err != nil {
			return err
		}
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		// The counters before the row, as reconciliation takes them.
		counters := []string{actorID}
		if payer != nil {
			counters = uniqueStrings(append(counters, *payer))
		}
		sort.Strings(counters)
		for _, user := range counters {
			if err := s.lockStorageRowTx(ctx, tx, user); err != nil {
				return err
			}
		}
		var kind string
		var draft, noLate bool
		var due, closed *time.Time
		if err := tx.QueryRow(ctx, `SELECT kind, draft, no_late, due_at, closed_at FROM assignments WHERE id=$1 FOR UPDATE`, id).
			Scan(&kind, &draft, &noLate, &due, &closed); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		if kind != AssignmentMarked || draft {
			return assignmentInput("only a published marked assignment can be republished")
		}
		if assignmentClosedAt(noLate, due, closed, now) != nil {
			return ErrAssignmentClosed
		}
		if qs == nil {
			return ErrAssignmentQuizGone
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT questions FROM assignments WHERE id=$1`, id).Scan(&raw); err != nil {
			return err
		}
		before, err := decodeFrozen(raw)
		if err != nil {
			return err
		}
		if err := s.publishAssignmentTx(ctx, tx, id, wsID, actorID, kind, qs, now); err != nil {
			return err
		}
		return dropStaleAnswersTx(ctx, tx, id, before, qs)
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// dropStaleAnswersTx takes out of its running attempts the saved answers that no
// longer mean what the member chose in the new copy. Every writer of an attempt
// takes the workspace first, which the caller holds.
func dropStaleAnswersTx(ctx context.Context, tx pgx.Tx, id string, before, after []map[string]any) error {
	rows, err := tx.Query(ctx, `SELECT id, answers FROM attempts WHERE assignment_id=$1 AND submitted_at IS NULL FOR UPDATE`, id)
	if err != nil {
		return err
	}
	saved := map[string][]byte{}
	for rows.Next() {
		var attempt string
		var raw []byte
		if err := rows.Scan(&attempt, &raw); err != nil {
			rows.Close()
			return err
		}
		saved[attempt] = raw
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	was, now := partAnswers(before), partAnswers(after)
	for attempt, raw := range saved {
		var answers map[string]any
		if err := json.Unmarshal(raw, &answers); err != nil {
			return err
		}
		kept := make(map[string]any, len(answers))
		for part, value := range answers {
			if a, b := was[part], now[part]; a != nil && b != nil && stillAnswers(a, b, value) {
				kept[part] = value
			}
		}
		if len(kept) == len(answers) {
			continue
		}
		next, err := json.Marshal(kept)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE attempts SET answers=$2 WHERE id=$1`, attempt, next); err != nil {
			return err
		}
	}
	return nil
}

// partAnswers maps each part's id to its answer.
func partAnswers(qs []map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, q := range qs {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			a, _ := p["answer"].(map[string]any)
			out[id] = a
		}
	}
	return out
}

// stillAnswers reads whether a saved answer still means what the member chose
// once a part changed, as practice's readers have it (AttemptBody's stillAnswers,
// D9): a chosen option, ordering item or matching option that is gone or moved, or
// a changed number of gaps, drops it.
func stillAnswers(before, after map[string]any, value any) bool {
	if before["type"] != after["type"] {
		return false
	}
	switch before["type"] {
	case "mcq":
		chosen, ok := value.([]any)
		was, _ := before["options"].([]any)
		now, _ := after["options"].([]any)
		if !ok {
			return false
		}
		for _, raw := range chosen {
			at, isNumber := raw.(float64)
			i := int(at)
			if !isNumber || i < 0 || i >= len(was) || i >= len(now) || !reflect.DeepEqual(was[i], now[i]) {
				return false
			}
		}
	case "ordering":
		return sameItems(before["items"], after["items"])
	case "matching":
		chosen, ok := value.(map[string]any)
		now, _ := after["options"].([]any)
		if !ok {
			return false
		}
		for _, option := range chosen {
			if !slices.ContainsFunc(now, func(o any) bool { return reflect.DeepEqual(o, option) }) {
				return false
			}
		}
	case "gaps":
		was, _ := before["accepted"].([]any)
		now, _ := after["accepted"].([]any)
		return len(was) == len(now)
	}
	return true
}

// sameItems reads whether two ordering parts hold the same items, in any order.
func sameItems(a, b any) bool {
	sorted := func(raw any) []string {
		list, _ := raw.([]any)
		out := make([]string, 0, len(list))
		for _, item := range list {
			text, _ := item.(string)
			out = append(out, text)
		}
		slices.Sort(out)
		return out
	}
	return slices.Equal(sorted(a), sorted(b))
}

// AssignmentSourceQuiz names a draft's quiz, for the caller to read before
// publishing; empty when it was deleted or trashed.
func (s *Store) AssignmentSourceQuiz(ctx context.Context, id string) (string, error) {
	var quizID *string
	err := s.pool.QueryRow(ctx, `SELECT m.id FROM assignments a
		LEFT JOIN materials m ON m.id=a.source_quiz_id AND m.trashed_at IS NULL WHERE a.id=$1`, id).Scan(&quizID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil || quizID == nil {
		return "", err
	}
	return *quizID, nil
}

// SetAssignmentClosed closes it by hand, stopping late submissions and making its
// quiz practice, or reopens it. A running attempt goes on for the grace, for its
// page to send what it holds (the caller tells it, Epo 2026-11-05); past that the
// sweep or the member's next request submits what was saved.
func (s *Store) SetAssignmentClosed(ctx context.Context, actorID, id string, closed bool, now time.Time) (Assignment, error) {
	wsID, err := s.assignmentWorkspace(ctx, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		at := &now
		if !closed {
			at = nil
		}
		_, err := tx.Exec(ctx, `UPDATE assignments SET closed_at=$2 WHERE id=$1 AND NOT draft`, id, at)
		return err
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// RunningAttemptUsers names who has an attempt running on the assignment.
func (s *Store) RunningAttemptUsers(ctx context.Context, id string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT user_id FROM attempts WHERE assignment_id=$1 AND submitted_at IS NULL`, id)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// DeleteAssignment deletes it with its attempts, frozen questions and images,
// which leave their payer's meter (a trigger's); its quiz is as it was.
func (s *Store) DeleteAssignment(ctx context.Context, actorID, id string) error {
	wsID, payer, err := s.assignmentPayer(ctx, id)
	if err != nil {
		return err
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentPayerRowsTx(ctx, tx, wsID, actorID, payer); err != nil {
			return err
		}
		// Deleting is one of the things a frozen account keeps (Epo 2026-11-05).
		if _, err := s.lockWorkspaceEditorRecoveryTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		staff, err := s.assignmentStaff(ctx, tx, actorID, wsID)
		if err != nil {
			return err
		}
		if !staff {
			return ErrNotFound
		}
		// The counter before the row, as reconciliation takes them.
		if payer != nil {
			if err := s.lockStorageRowTx(ctx, tx, *payer); err != nil {
				return err
			}
		}
		tag, err := tx.Exec(ctx, `DELETE FROM assignments WHERE id=$1`, id)
		if err == nil && tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return err
	})
}

func decodeFrozen(raw []byte) ([]map[string]any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var qs []map[string]any
	err := json.Unmarshal(raw, &qs)
	return qs, err
}

// assignedTx reports whether the published assignment went to userID.
func assignedTx(ctx context.Context, q rowQueryer, id, userID string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `WITH e AS (`+assigneesSQL+`)
		SELECT EXISTS (SELECT 1 FROM e WHERE e.user_id=$2)`, []string{id}, userID).Scan(&ok)
	return ok, err
}

// SetAssignmentDone is a member's tick on an unmarked assignment.
func (s *Store) SetAssignmentDone(ctx context.Context, userID, id string, done bool, now time.Time) error {
	var wsID, kind string
	var draft bool
	err := s.pool.QueryRow(ctx, `SELECT workspace_id, kind, draft FROM assignments WHERE id=$1`, id).Scan(&wsID, &kind, &draft)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// Not a class, or its owner's account is locked: nothing is ticked.
	if _, err := s.assignmentStaff(ctx, s.pool, userID, wsID); err != nil {
		return err
	}
	assigned, err := assignedTx(ctx, s.pool, id, userID)
	if err != nil {
		return err
	}
	if draft || !assigned {
		return ErrNotFound
	}
	if kind != AssignmentUnmarked {
		return assignmentInput("a marked assignment is done when it is submitted")
	}
	if !done {
		_, err = s.pool.Exec(ctx, `DELETE FROM assignment_done WHERE assignment_id=$1 AND user_id=$2`, id, userID)
		return err
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO assignment_done (assignment_id, user_id, done_at) VALUES ($1,$2,$3)
		ON CONFLICT (assignment_id, user_id) DO NOTHING`, id, userID, now)
	return err
}

/* ---------------------------------------------------------------- attempts */

// AssignmentAttempt is a member's try: running, its answer-free questions and
// what they saved, with the server's clock; submitted, its graded copy. A
// member's own results lose the keys when the owner turned Show answers off.
type AssignmentAttempt struct {
	ID            string     `json:"id"`
	AssignmentID  string     `json:"assignmentId"`
	UserID        string     `json:"userId"`
	UserName      string     `json:"userName"`
	UserAvatarURL string     `json:"userAvatarUrl,omitempty"`
	Title         string     `json:"title"`
	Status        string     `json:"status" enum:"running,submitted"`
	StartedAt     *time.Time `json:"startedAt,omitempty"`
	// DeadlineAt is when the time runs out; Now is the server's clock, which
	// the page's timer counts against.
	DeadlineAt    *time.Time `json:"deadlineAt,omitempty"`
	Now           time.Time  `json:"now"`
	SubmittedAt   *time.Time `json:"submittedAt,omitempty"`
	AutoSubmitted bool       `json:"autoSubmitted"`
	Late          bool       `json:"late"`
	// Late: submitted after the due date; LatePenaltyPct is what that cost.
	LatePenaltyPct int `json:"latePenaltyPct"`
	// Correct of Total: every mark decided so far over the whole paper; the
	// WaitingMarks of WaitingAnswers wait for the owner. Mark is Correct after any
	// late penalty, which is what counts.
	Correct        float64 `json:"correct"`
	Mark           float64 `json:"mark"`
	Total          float64 `json:"total"`
	WaitingMarks   float64 `json:"waitingMarks"`
	WaitingAnswers int     `json:"waitingAnswers"`
	// ShowAnswers: this view carries the keys.
	ShowAnswers bool             `json:"showAnswers"`
	Answers     map[string]any   `json:"answers" nullable:"false"`
	Questions   []map[string]any `json:"questions" nullable:"false"`
	// RemovedAssetIDs are the running attempt's images no longer there.
	RemovedAssetIDs []string `json:"removedAssetIds" nullable:"false"`
}

// attemptRow is an assignment attempt with its assignment's rules.
type attemptRow struct {
	id, assignmentID, userID, wsID, sourceID string
	startedAt, deadline, submitted, dueAt    *time.Time
	closedAt, released                       *time.Time
	noLate, auto, showAnswers, shuffle       bool
	latePenaltyPct                           int
	correct, total, waitingMarks             float64
	waitingAnswers                           int
	answers, graded, frozen                  []byte
}

const attemptRowCols = `t.id, t.assignment_id, t.user_id, a.workspace_id, COALESCE(a.source_quiz_id,''),
	t.started_at, t.deadline_at, t.submitted_at, a.due_at, a.closed_at, a.released_at,
	a.no_late, a.late_penalty_pct, t.auto_submitted, a.show_answers, a.shuffle, t.correct::float8, t.total::float8, t.waiting_marks::float8, t.waiting_answers,
	t.answers, t.questions, a.questions`

func scanAttemptRow(row pgx.Row) (attemptRow, error) {
	var r attemptRow
	err := row.Scan(&r.id, &r.assignmentID, &r.userID, &r.wsID, &r.sourceID,
		&r.startedAt, &r.deadline, &r.submitted, &r.dueAt, &r.closedAt, &r.released,
		&r.noLate, &r.latePenaltyPct, &r.auto, &r.showAnswers, &r.shuffle, &r.correct, &r.total, &r.waitingMarks, &r.waitingAnswers,
		&r.answers, &r.graded, &r.frozen)
	if isNoRows(err) {
		return r, ErrNotFound
	}
	return r, err
}

// expired: closed by hand or timed out, past the grace (the browser submits what
// is on the page, and that takes a moment).
func (r attemptRow) expired(now time.Time) bool {
	return (r.closedAt != nil && now.After(r.closedAt.Add(assignmentGrace))) || r.timedOut(now)
}

// timedOut: its time or a No late submissions due date ran out, past the grace.
// It marks a submission automatic, which the page says was the time running out;
// staff closing it is not that.
func (r attemptRow) timedOut(now time.Time) bool {
	if r.noLate && r.dueAt != nil && now.After(r.dueAt.Add(assignmentGrace)) {
		return true
	}
	return r.deadline != nil && now.After(r.deadline.Add(assignmentGrace))
}

// StartAssignment starts the member's attempt, or returns the one running. A
// time limit starts the clock here, on the server.
func (s *Store) StartAssignment(ctx context.Context, userID, id string, now time.Time) (AssignmentAttempt, error) {
	var attemptID string
	var view AssignmentAttempt
	wsID, err := s.assignmentWorkspace(ctx, id)
	if err != nil {
		return view, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockWorkspaceKeyShareTx(ctx, tx, wsID); err != nil {
			return err
		}
		if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
			return err
		}
		// Not a class, or its owner's account is locked: nothing starts or submits.
		if _, err := s.assignmentStaff(ctx, tx, userID, wsID); err != nil {
			return err
		}
		var kind, title, wsName string
		var draft, noLate bool
		var due, closedAt *time.Time
		var limit, allowed int
		var hasLimit *int
		var total float64
		err := tx.QueryRow(ctx, `SELECT a.kind, a.title, w.name, a.draft, a.no_late, a.due_at, a.closed_at, a.time_limit_min, a.attempts_allowed, a.total_marks::float8
			FROM assignments a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=$1 FOR SHARE OF a`, id).
			Scan(&kind, &title, &wsName, &draft, &noLate, &due, &closedAt, &hasLimit, &allowed, &total)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		assigned, err := assignedTx(ctx, tx, id, userID)
		if err != nil {
			return err
		}
		if draft || kind != AssignmentMarked || !assigned {
			return ErrNotFound
		}
		if hasLimit != nil {
			limit = *hasLimit
		}
		// One start at a time, so two tabs share one attempt.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "assignment-start:"+id+":"+userID); err != nil {
			return err
		}
		running, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.assignment_id=$1 AND t.user_id=$2 AND t.submitted_at IS NULL FOR UPDATE OF t`, id, userID))
		if err == nil {
			if !running.expired(now) {
				attemptID = running.id
				return nil
			}
			if err := s.finishAttemptTx(ctx, tx, running, nil, running.timedOut(now), now); err != nil {
				return err
			}
		} else if !errors.Is(err, ErrNotFound) {
			return err
		}
		if assignmentClosedAt(noLate, due, closedAt, now) != nil {
			return ErrAssignmentClosed
		}
		var used int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM attempts WHERE assignment_id=$1 AND user_id=$2 AND submitted_at IS NOT NULL`, id, userID).Scan(&used); err != nil {
			return err
		}
		if used >= allowed {
			return ErrAssignmentNoAttempts
		}
		attemptID = uid("at")
		var deadline *time.Time
		if limit > 0 {
			at := now.Add(time.Duration(limit) * time.Minute)
			deadline = &at
		}
		_, err = tx.Exec(ctx, `INSERT INTO attempts (id, user_id, workspace_id, kind, assignment_id, quiz_name, workspace_name,
				total, started_at, taken_at, deadline_at)
			VALUES ($1,$2,$3,'assignment',$4,$5,$6,$7,$8,$8,$9)`,
			attemptID, userID, wsID, id, title, truncateRunes(wsName, 80), total, now, deadline)
		return err
	})
	if err != nil {
		return view, err
	}
	return s.GetAssignmentAttempt(ctx, userID, attemptID, now)
}

func truncateRunes(s string, limit int) string {
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit])
}

// SaveAssignmentAnswers replaces the running attempt's saved answers. Past its
// time it submits what was saved before and refuses (ErrAttemptFinished).
func (s *Store) SaveAssignmentAnswers(ctx context.Context, userID, attemptID string, answers map[string]any, now time.Time) error {
	if err := checkAssignmentAnswers(answers); err != nil {
		return err
	}
	expired := false
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		// This runs every few seconds per member: it leaves the frozen copy out.
		var r attemptRow
		err := tx.QueryRow(ctx, `SELECT a.workspace_id, t.submitted_at, t.deadline_at, a.closed_at, a.no_late, a.due_at
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`, attemptID, userID).
			Scan(&r.wsID, &r.submitted, &r.deadline, &r.closedAt, &r.noLate, &r.dueAt)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := s.assignmentStaff(ctx, tx, userID, r.wsID); err != nil {
			return err
		}
		if r.submitted != nil {
			return ErrAttemptFinished
		}
		if r.expired(now) {
			expired = true
			return nil
		}
		raw, err := json.Marshal(answers)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE attempts SET answers=$2 WHERE id=$1`, attemptID, raw)
		return err
	})
	if err == nil && expired {
		// In its own transaction: submitting takes the workspace first, and a save
		// (every few seconds per member) holds the attempt without it.
		if err := s.finishAttemptIfRunning(ctx, attemptID, now); err != nil {
			return err
		}
		return ErrAttemptFinished
	}
	return err
}

// shuffledQuestions is the attempt's own order of the questions, the same at
// every read, from a seed of its id.
func shuffledQuestions(attemptID string, qs []map[string]any) []map[string]any {
	h := fnv.New64a()
	_, _ = h.Write([]byte(attemptID))
	r := rand.New(rand.NewSource(int64(h.Sum64())))
	out := append([]map[string]any{}, qs...)
	r.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	return out
}

// checkAssignmentAnswers bounds what a save stores; the body cap bounds the rest.
func checkAssignmentAnswers(answers map[string]any) error {
	for _, value := range answers {
		if text, ok := value.(string); ok && len([]rune(text)) > fieldlimits.QuizOpenAnswer {
			return assignmentInput("an answer is too long")
		}
	}
	return nil
}

// SubmitAssignmentAttempt submits the running attempt with its final answers.
// Past its time the answers sent are ignored, and what was saved is submitted.
// A second submit of a submitted attempt changes nothing and returns it.
func (s *Store) SubmitAssignmentAttempt(ctx context.Context, userID, attemptID string, answers map[string]any, now time.Time) (AssignmentAttempt, error) {
	if err := checkAssignmentAnswers(answers); err != nil {
		return AssignmentAttempt{}, err
	}
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		if err := s.lockAccountSessionsTx(ctx, tx, userID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id
			WHERE t.id=$1 AND t.user_id=$2 FOR UPDATE OF t`, attemptID, userID))
		if err != nil {
			return err
		}
		if _, err := s.assignmentStaff(ctx, tx, userID, r.wsID); err != nil {
			return err
		}
		if r.submitted != nil {
			return nil
		}
		if r.expired(now) {
			return s.finishAttemptTx(ctx, tx, r, nil, r.timedOut(now), now)
		}
		return s.finishAttemptTx(ctx, tx, r, answers, false, now)
	})
	if err != nil {
		return AssignmentAttempt{}, err
	}
	return s.GetAssignmentAttempt(ctx, userID, attemptID, now)
}

// finishAttemptTx grades a running attempt: closed parts here, with today's
// deterministic scoring; an answered open part waits ("Not marked") for the
// owner, and no model is called. answers nil means what was saved. It logs the
// decided parts and, once its quiz shows as practice, rates them.
func (s *Store) finishAttemptTx(ctx context.Context, tx pgx.Tx, r attemptRow, answers map[string]any, auto bool, now time.Time) error {
	if answers == nil {
		answers = map[string]any{}
		if len(r.answers) > 0 {
			if err := json.Unmarshal(r.answers, &answers); err != nil {
				return err
			}
		}
	}
	frozen, err := decodeFrozen(r.frozen)
	if err != nil {
		return err
	}
	graded, given := gradeAttempt(frozen, answers)
	correct, total, waitingMarks, waitingAnswers := attemptTotals(graded)
	pct := 0
	if total > 0 {
		pct = int(correct / total * 100)
	}
	rawAnswers, err := json.Marshal(given)
	if err != nil {
		return err
	}
	rawGraded, err := json.Marshal(graded)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE attempts SET answers=$2, questions=$3, correct=$4, total=$5, pct=$6, taken_at=$7,
			submitted_at=$7, auto_submitted=$8, waiting_marks=$9, waiting_answers=$10 WHERE id=$1`,
		r.id, rawAnswers, rawGraded, correct, total, pct, now, auto, waitingMarks, waitingAnswers); err != nil {
		return err
	}
	mt := Material{ID: r.sourceID, WorkspaceID: r.wsID}
	for _, q := range graded {
		if err := logAnswerTx(ctx, tx, r.userID, mt, q, given, answerSourceAssignment, r.id, now); err != nil {
			return err
		}
	}
	if r.released != nil {
		return s.rateAttemptTx(ctx, tx, r.userID, r.sourceID, graded, given, now)
	}
	return nil
}

// gradeAttempt keeps the answers to parts of the frozen copy and grades each
// question: closed parts scored, an answered open part left waiting.
func gradeAttempt(frozen []map[string]any, answers map[string]any) ([]map[string]any, map[string]any) {
	given := map[string]any{}
	graded := make([]map[string]any, len(frozen))
	for i, q := range frozen {
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			id, _ := p["id"].(string)
			a, _ := p["answer"].(map[string]any)
			value, ok := answers[id]
			if !ok {
				continue
			}
			if text, isText := value.(string); a["type"] == "open" && (!isText || len([]rune(text)) > fieldlimits.QuizOpenAnswer) {
				continue
			} else if isText && a["type"] == "open" && strings.TrimSpace(text) == "" {
				continue
			}
			given[id] = value
		}
		out, _, _ := questions.Graded(q, given, nil)
		list, _ := out["parts"].([]any)
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			a, _ := p["answer"].(map[string]any)
			id, _ := p["id"].(string)
			if a["type"] == "open" && given[id] != nil {
				p["pending"] = true
				delete(p, "itemAwards")
			}
		}
		graded[i] = out
	}
	return graded, given
}

// attemptTotals sums a graded copy: marks decided, the paper's marks, and the
// marks and answers (questions with an open part) still waiting.
func attemptTotals(graded []map[string]any) (correct, total, waitingMarks float64, waitingAnswers int) {
	for _, q := range graded {
		awarded, marks := questionMarks(q)
		correct, total = correct+awarded, total+marks
		waiting := false
		parts, _ := q["parts"].([]any)
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			if pending, _ := p["pending"].(bool); pending {
				m, _ := p["marks"].(float64)
				waitingMarks += m
				waiting = true
			}
		}
		if waiting {
			waitingAnswers++
		}
	}
	return correct, total, waitingMarks, waitingAnswers
}

// rateAttemptTx rates the attempt's fully marked questions on its quiz, now that
// the quiz shows as practice (§11.6: marked-assignment questions join reviews
// once the assignment closes). A question no longer in the quiz is not rated.
func (s *Store) rateAttemptTx(ctx context.Context, tx pgx.Tx, userID, quizID string, graded []map[string]any, given map[string]any, now time.Time) error {
	if quizID == "" {
		return nil
	}
	mt, err := scanMaterial(tx.QueryRow(ctx, `SELECT `+materialCols+` FROM materials WHERE id=$1 AND trashed_at IS NULL`, quizID))
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := lockRating(ctx, tx, userID, quizID); err != nil {
		return err
	}
	for _, q := range graded {
		if questionWaiting(q) {
			continue
		}
		if err := rateQuestionTx(ctx, tx, userID, mt, q, given, now); err != nil {
			return err
		}
	}
	return nil
}

func questionWaiting(q map[string]any) bool {
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		if pending, _ := p["pending"].(bool); pending {
			return true
		}
	}
	return false
}

// GetAssignmentAttempt reads an attempt for the member who took it or the
// class's owner and editor members. An attempt whose time ran out is submitted
// first. A running attempt is readable by its member only.
func (s *Store) GetAssignmentAttempt(ctx context.Context, userID, attemptID string, now time.Time) (AssignmentAttempt, error) {
	r, err := s.readAttempt(ctx, attemptID)
	if err != nil {
		return AssignmentAttempt{}, err
	}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, r.wsID)
	if err != nil {
		return AssignmentAttempt{}, err
	}
	own := r.userID == userID
	if !own && !staff {
		return AssignmentAttempt{}, ErrNotFound
	}
	if r.submitted == nil && !own {
		return AssignmentAttempt{}, ErrNotFound
	}
	if r.submitted == nil && r.expired(now) {
		if err := s.finishAttemptIfRunning(ctx, attemptID, now); err != nil {
			return AssignmentAttempt{}, err
		}
		if r, err = s.readAttempt(ctx, attemptID); err != nil {
			return AssignmentAttempt{}, err
		}
	}
	return s.attemptView(ctx, r, staff, now)
}

func (s *Store) readAttempt(ctx context.Context, attemptID string) (attemptRow, error) {
	return scanAttemptRow(s.pool.QueryRow(ctx, `SELECT `+attemptRowCols+`
		FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1`, attemptID))
}

// lockAttemptWorkspaceTx takes an attempt's workspace first (see
// lockWorkspaceKeyShareTx); an attempt that is gone is its caller's to report.
func lockAttemptWorkspaceTx(ctx context.Context, tx pgx.Tx, attemptID string) error {
	var wsID string
	err := tx.QueryRow(ctx, `SELECT a.workspace_id FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1`, attemptID).Scan(&wsID)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return lockWorkspaceKeyShareTx(ctx, tx, wsID)
}

// finishAttemptIfRunning submits what was saved, if nothing beat it to it.
func (s *Store) finishAttemptIfRunning(ctx context.Context, attemptID string, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := lockAttemptWorkspaceTx(ctx, tx, attemptID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1 FOR UPDATE OF t SKIP LOCKED`, attemptID))
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if r.submitted != nil || !r.expired(now) {
			return nil
		}
		return s.finishAttemptTx(ctx, tx, r, nil, r.timedOut(now), now)
	})
}

// attemptView renders an attempt for its caller.
func (s *Store) attemptView(ctx context.Context, r attemptRow, staff bool, now time.Time) (AssignmentAttempt, error) {
	v := AssignmentAttempt{
		ID: r.id, AssignmentID: r.assignmentID, UserID: r.userID, StartedAt: r.startedAt, DeadlineAt: r.deadline, Now: now,
		SubmittedAt: r.submitted, AutoSubmitted: r.auto, Correct: r.correct, Total: r.total,
		WaitingMarks: r.waitingMarks, WaitingAnswers: r.waitingAnswers,
		Answers: map[string]any{}, Questions: []map[string]any{}, RemovedAssetIDs: []string{},
	}
	if err := s.pool.QueryRow(ctx, `SELECT a.title, COALESCE(NULLIF(u.name,''), u.id, ''),
			COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, '')
		FROM assignments a LEFT JOIN users u ON u.id=$2 WHERE a.id=$1`, r.assignmentID, r.userID).
		Scan(&v.Title, &v.UserName, &v.UserAvatarURL); err != nil {
		return v, err
	}
	if len(r.answers) > 0 {
		if err := json.Unmarshal(r.answers, &v.Answers); err != nil {
			return v, err
		}
	}
	if r.submitted == nil {
		v.Status = "running"
		frozen, err := decodeFrozen(r.frozen)
		if err != nil {
			return v, err
		}
		if r.shuffle {
			frozen = shuffledQuestions(r.id, frozen)
		}
		v.Questions = questions.LearnerViews(frozen)
		var ids []string
		for _, q := range frozen {
			ids = append(ids, questions.AssetIDs(q)...)
		}
		removed, err := s.MissingEditorAssetIDs(ctx, ids)
		if err != nil {
			return v, err
		}
		if removed != nil {
			v.RemovedAssetIDs = removed
		}
		return v, nil
	}
	v.Status = "submitted"
	v.Late = assignmentLate(r.noLate, r.dueAt, *r.submitted)
	v.LatePenaltyPct = penaltyFor(v.Late, r.latePenaltyPct)
	v.Mark = penalisedMark(r.correct, v.LatePenaltyPct)
	v.ShowAnswers = staff || r.showAnswers
	graded, err := decodeFrozen(r.graded)
	if err != nil {
		return v, err
	}
	if err := s.nameCommenters(ctx, graded); err != nil {
		return v, err
	}
	if !v.ShowAnswers {
		graded = gradedWithoutKeys(graded)
	}
	v.Questions = graded
	return v, nil
}

// nameCommenters adds each comment's author name and avatar.
func (s *Store) nameCommenters(ctx context.Context, graded []map[string]any) error {
	var ids []string
	for _, q := range graded {
		if id, ok := q["commentBy"].(string); ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id, COALESCE(NULLIF(name,''), id),
		COALESCE('/icons/' || NULLIF(avatar_icon_id,'') || '.svg', avatar_url, '') FROM users WHERE id = ANY($1)`, uniqueStrings(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	names, avatars := map[string]string{}, map[string]string{}
	for rows.Next() {
		var id, name, avatar string
		if err := rows.Scan(&id, &name, &avatar); err != nil {
			return err
		}
		names[id], avatars[id] = name, avatar
	}
	for _, q := range graded {
		if id, ok := q["commentBy"].(string); ok {
			q["commentByName"], q["commentByAvatarUrl"] = names[id], avatars[id]
		}
	}
	return rows.Err()
}

// gradedWithoutKeys is a graded copy as a member sees it with Show answers off:
// the learner's question with each part's marks and the owner's comment.
func gradedWithoutKeys(graded []map[string]any) []map[string]any {
	out := make([]map[string]any, len(graded))
	for i, q := range graded {
		view := questions.LearnerView(q)
		for _, key := range []string{"comment", "commentByName", "commentByAvatarUrl"} {
			if value, ok := q[key]; ok {
				view[key] = value
			}
		}
		from, _ := q["parts"].([]any)
		parts, _ := view["parts"].([]any)
		for j, raw := range parts {
			p, _ := raw.(map[string]any)
			source, _ := from[j].(map[string]any)
			for _, key := range []string{"awarded", "pending"} {
				if value, ok := source[key]; ok {
					p[key] = value
				}
			}
		}
		out[i] = view
	}
	return out
}

/* ------------------------------------------------------------------- marks */

// AssignmentMark changes one question's marks in a member's answers, and its
// comment. Items are an open part's marks per marking point; Mark a closed
// part's. An empty Parts changes only the comment.
type AssignmentMark struct {
	QuestionID string               `json:"questionId"`
	Parts      []AssignmentPartMark `json:"parts" nullable:"false"`
	Comment    string               `json:"comment" maxLength:"2000"`
}

type AssignmentPartMark struct {
	PartID string    `json:"partId"`
	Items  []float64 `json:"items,omitempty"`
	Mark   *float64  `json:"mark,omitempty"`
}

// validHalfMark: a mark from 0 to the marks, in half marks.
func validHalfMark(v, marks float64) bool {
	doubled := v * 2
	return v >= 0 && v <= marks && doubled == float64(int64(doubled))
}

// MarkAssignmentAnswer applies an owner's or editor member's marks: a waiting
// open part stops waiting, and any part's mark can change (§7, board G3m). Each
// change is a new answer event; a question that stops waiting after its quiz
// shows as practice is rated.
func (s *Store) MarkAssignmentAnswer(ctx context.Context, actorID, attemptID string, mark AssignmentMark, now time.Time) (AssignmentAttempt, error) {
	if len([]rune(mark.Comment)) > assignmentNoteMax {
		return AssignmentAttempt{}, assignmentInput("a comment is too long")
	}
	first, err := s.readAttempt(ctx, attemptID)
	if err != nil {
		return AssignmentAttempt{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, first.wsID, actorID); err != nil {
			return err
		}
		r, err := scanAttemptRow(tx.QueryRow(ctx, `SELECT `+attemptRowCols+`
			FROM attempts t JOIN assignments a ON a.id=t.assignment_id WHERE t.id=$1 FOR UPDATE OF t`, attemptID))
		if err != nil {
			return err
		}
		if r.submitted == nil {
			return assignmentInput("this attempt has not been submitted")
		}
		graded, err := decodeFrozen(r.graded)
		if err != nil {
			return err
		}
		given := map[string]any{}
		if err := json.Unmarshal(r.answers, &given); err != nil {
			return err
		}
		var question map[string]any
		for _, q := range graded {
			if q["id"] == mark.QuestionID {
				question = q
			}
		}
		if question == nil {
			return ErrNotFound
		}
		waited := questionWaiting(question)
		changed, err := applyPartMarks(question, mark.Parts, actorID, now)
		if err != nil {
			return err
		}
		if mark.Comment != "" {
			question["comment"], question["commentBy"] = mark.Comment, actorID
		} else {
			delete(question, "comment")
			delete(question, "commentBy")
		}
		correct, total, waitingMarks, waitingAnswers := attemptTotals(graded)
		pct := 0
		if total > 0 {
			pct = int(correct / total * 100)
		}
		raw, err := json.Marshal(graded)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE attempts SET questions=$2, correct=$3, total=$4, pct=$5, waiting_marks=$6, waiting_answers=$7 WHERE id=$1`,
			attemptID, raw, correct, total, pct, waitingMarks, waitingAnswers); err != nil {
			return err
		}
		mt := Material{ID: r.sourceID, WorkspaceID: r.wsID}
		if err := logAnswerPartsTx(ctx, tx, r.userID, mt, question, given, answerSourceAssignment, attemptID, now, changed); err != nil {
			return err
		}
		if r.released == nil || !waited || questionWaiting(question) {
			return nil
		}
		// Reviews rate a member's latest submission (latestAttempts): an earlier one
		// marked now moves its mark alone.
		var latest bool
		if err := tx.QueryRow(ctx, `SELECT NOT EXISTS (SELECT 1 FROM attempts
			WHERE assignment_id=$1 AND user_id=$2 AND submitted_at > $3)`, r.assignmentID, r.userID, r.submitted).Scan(&latest); err != nil || !latest {
			return err
		}
		return s.rateAttemptTx(ctx, tx, r.userID, r.sourceID, []map[string]any{question}, given, now)
	})
	if err != nil {
		return AssignmentAttempt{}, err
	}
	return s.GetAssignmentAttempt(ctx, actorID, attemptID, now)
}

// applyPartMarks writes the marks into the graded question and returns which
// parts changed.
func applyPartMarks(question map[string]any, marks []AssignmentPartMark, actorID string, now time.Time) (map[string]bool, error) {
	parts, _ := question["parts"].([]any)
	byID := make(map[string]map[string]any, len(parts))
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		id, _ := p["id"].(string)
		byID[id] = p
	}
	changed := map[string]bool{}
	for _, mark := range marks {
		p := byID[mark.PartID]
		if p == nil {
			return nil, assignmentInput("that part is not in this question")
		}
		partMarks, _ := p["marks"].(float64)
		a, _ := p["answer"].(map[string]any)
		var awarded float64
		if a["type"] == "open" {
			_, itemMarks := questions.MarkItems(p)
			if len(mark.Items) != len(itemMarks) {
				return nil, assignmentInput("give a mark for every marking point")
			}
			for i, v := range mark.Items {
				if !validHalfMark(v, itemMarks[i]) {
					return nil, assignmentInput("a mark is out of range")
				}
				awarded += v
			}
			if awarded > partMarks {
				awarded = partMarks
			}
			p["itemAwards"] = mark.Items
		} else {
			if mark.Mark == nil || !validHalfMark(*mark.Mark, partMarks) {
				return nil, assignmentInput("a mark is out of range")
			}
			awarded = *mark.Mark
		}
		before, _ := p["awarded"].(float64)
		_, waiting := p["pending"]
		if waiting || before != awarded {
			changed[mark.PartID] = true
		}
		delete(p, "pending")
		p["awarded"] = awarded
		p["markedBy"] = actorID
		p["markedAt"] = now.UTC().Format(time.RFC3339)
	}
	return changed, nil
}

/* ------------------------------------------------------------------ report */

// AssignmentReport is an assignment's report (boards G3, G3m, A3). A question's
// shared numbers need at least five results (§11.8).
type AssignmentReport struct {
	Members   []AssignmentMemberRow      `json:"members" nullable:"false"`
	Questions []AssignmentQuestionReport `json:"questions" nullable:"false"`
	// Answers lists, for the Approve AI marks tab, each member's counted answer to
	// a question with an open part, and any other submission's answer still
	// waiting: once marked it can become the highest.
	Answers []AssignmentAnswerRow `json:"answers" nullable:"false"`
}

// AssignmentMemberRow is one member it went to.
type AssignmentMemberRow struct {
	UserID    string  `json:"userId"`
	Name      string  `json:"name"`
	AvatarURL string  `json:"avatarUrl,omitempty"`
	AttemptID *string `json:"attemptId,omitempty"`
	// AttemptID and SubmittedAt: the submission that counts (countedAttemptOrder),
	// which the rest of this reads; an unmarked one's tick.
	SubmittedAt *time.Time `json:"submittedAt,omitempty"`
	// Minutes taken, whole minutes rounded up.
	Minutes *int `json:"minutes,omitempty"`
	// Correct is the marks decided; Mark the same after any late penalty, which
	// is what counts.
	Correct *float64 `json:"correct,omitempty"`
	Mark    *float64 `json:"mark,omitempty"`
	Total   *float64 `json:"total,omitempty"`
	// WaitingAnswers counts every submission of theirs (AssignmentReport.Answers).
	WaitingAnswers int  `json:"waitingAnswers"`
	Late           bool `json:"late"`
	LatePenaltyPct int  `json:"latePenaltyPct"`
	Running        bool `json:"running"`
	// Missing: past due, nothing submitted.
	Missing bool `json:"missing"`
}

// AssignmentQuestionReport is one question of the frozen copy, with its keys,
// and how members did on it.
type AssignmentQuestionReport struct {
	Question map[string]any `json:"question"`
	// Submitted counts the members' answers to the question, blanks included.
	Submitted int `json:"submitted"`
	// Percent is the share with full marks (0 to 1); Average the mean mark, on a
	// question with an open part. Absent under five results.
	Percent *float64               `json:"percent,omitempty"`
	Average *float64               `json:"average,omitempty"`
	Parts   []AssignmentPartReport `json:"parts" nullable:"false"`
}

// AssignmentPartReport is one part's answers: chosen options, common wrong
// answers, or how often each marking point was awarded.
type AssignmentPartReport struct {
	PartID string `json:"partId"`
	// Options counts each option of a multiple choice, or true then false.
	Options []int `json:"options,omitempty"`
	// WrongAnswers are the commonest wrong short answers.
	WrongAnswers []AssignmentWrongAnswer `json:"wrongAnswers,omitempty"`
	Items        []AssignmentItemReport  `json:"items,omitempty"`
}

type AssignmentWrongAnswer struct {
	Text  string `json:"text"`
	Count int    `json:"count"`
}

// AssignmentItemReport is one marking point: Awarded of the Marked answers got
// any of its marks.
type AssignmentItemReport struct {
	Text    string  `json:"text"`
	Marks   float64 `json:"marks"`
	Awarded int     `json:"awarded"`
	Marked  int     `json:"marked"`
}

// AssignmentAnswerRow is one member's answer to a question with an open part.
type AssignmentAnswerRow struct {
	QuestionID string `json:"questionId"`
	UserID     string `json:"userId"`
	AttemptID  string `json:"attemptId"`
	// AttemptNumber is which of the member's submissions it is, the first being 1.
	AttemptNumber int `json:"attemptNumber"`
	// Waiting: an open part still waits for the owner.
	Waiting bool    `json:"waiting"`
	Awarded float64 `json:"awarded"`
	Marks   float64 `json:"marks"`
}

// wrongAnswersShown caps a short part's common wrong answers.
const wrongAnswersShown = 5

// GetAssignmentReport reads the report for a class's owner and editor members.
func (s *Store) GetAssignmentReport(ctx context.Context, userID, id string, now time.Time) (AssignmentReport, error) {
	out := AssignmentReport{Members: []AssignmentMemberRow{}, Questions: []AssignmentQuestionReport{}, Answers: []AssignmentAnswerRow{}}
	wsID, err := s.assignmentWorkspace(ctx, id)
	if err != nil {
		return out, err
	}
	staff, err := s.assignmentStaff(ctx, s.pool, userID, wsID)
	if err != nil {
		return out, err
	}
	if !staff {
		return out, ErrNotFound
	}
	var kind string
	var noLate bool
	var penalty int
	var due *time.Time
	var raw []byte
	if err := s.pool.QueryRow(ctx, `SELECT kind, no_late, late_penalty_pct, due_at, questions FROM assignments WHERE id=$1`, id).
		Scan(&kind, &noLate, &penalty, &due, &raw); err != nil {
		return out, err
	}
	frozen, err := decodeFrozen(raw)
	if err != nil {
		return out, err
	}
	members, err := s.reportMembers(ctx, id, kind, due, now)
	if err != nil {
		return out, err
	}
	out.Members = members
	if kind != AssignmentMarked {
		return out, nil
	}
	attempts, err := countedAttempts(ctx, s.pool, id)
	if err != nil {
		return out, err
	}
	at := make(map[string]int, len(members))
	for i, m := range members {
		at[m.UserID] = i
	}
	var counted []reportAttempt
	countedIDs := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		countedIDs = append(countedIDs, attempt.id)
		i, ok := at[attempt.userID]
		if !ok {
			continue
		}
		counted = append(counted, attempt)
		row := &out.Members[i]
		row.AttemptID, row.SubmittedAt, row.Correct, row.Total = &attempt.id, &attempt.submitted, &attempt.correct, &attempt.total
		row.WaitingAnswers += attempt.waitingAnswers
		row.Late = assignmentLate(noLate, due, attempt.submitted)
		row.LatePenaltyPct = penaltyFor(row.Late, penalty)
		mark := penalisedMark(attempt.correct, row.LatePenaltyPct)
		row.Mark = &mark
		row.Missing, row.Running = false, false
		if attempt.started != nil {
			minutes := int(attempt.submitted.Sub(*attempt.started).Round(time.Minute).Minutes())
			if minutes < 1 {
				minutes = 1
			}
			row.Minutes = &minutes
		}
	}
	others, err := waitingAttempts(ctx, s.pool, id, countedIDs)
	if err != nil {
		return out, err
	}
	var waiting []reportAttempt
	for _, attempt := range others {
		if i, ok := at[attempt.userID]; ok {
			waiting = append(waiting, attempt)
			out.Members[i].WaitingAnswers += attempt.waitingAnswers
		}
	}
	out.Questions, out.Answers = questionReports(withRemoved(frozen, counted, waiting), counted, waiting)
	return out, nil
}

// withRemoved adds, last, what a republish took out that a submission still holds:
// its marks stand and its open answers wait. A question that stayed takes back the
// parts it lost; one that left comes back whole.
func withRemoved(frozen []map[string]any, attempts ...[]reportAttempt) []map[string]any {
	seen := make(map[string]bool, len(frozen))
	for _, q := range frozen {
		id, _ := q["id"].(string)
		seen[id] = true
		parts, _ := q["parts"].([]any)
		held := map[string]bool{}
		for _, raw := range parts {
			p, _ := raw.(map[string]any)
			part, _ := p["id"].(string)
			held[part] = true
		}
		for _, list := range attempts {
			for _, attempt := range list {
				theirs, _ := attempt.graded[id]["parts"].([]any)
				for _, raw := range theirs {
					p, _ := raw.(map[string]any)
					if part, _ := p["id"].(string); !held[part] {
						held[part] = true
						parts = append(parts, raw)
					}
				}
			}
		}
		q["parts"] = parts
	}
	removed := map[string]map[string]any{}
	for _, list := range attempts {
		for _, attempt := range list {
			for id, q := range attempt.graded {
				if !seen[id] {
					removed[id] = q
				}
			}
		}
	}
	ids := make([]string, 0, len(removed))
	for id := range removed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := append([]map[string]any{}, frozen...)
	for _, id := range ids {
		out = append(out, removed[id])
	}
	return out
}

// reportMembers lists who it went to, by name; a member who ticked it reads as
// submitted then.
func (s *Store) reportMembers(ctx context.Context, id, kind string, due *time.Time, now time.Time) ([]AssignmentMemberRow, error) {
	rows, err := s.pool.Query(ctx, `WITH e AS (`+assigneesSQL+`)
		SELECT e.user_id, COALESCE(NULLIF(u.name,''), u.id), COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, ''),
			(SELECT d.done_at FROM assignment_done d WHERE d.assignment_id=e.assignment_id AND d.user_id=e.user_id),
			EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=e.assignment_id AND t.user_id=e.user_id AND t.submitted_at IS NULL)
		FROM e JOIN users u ON u.id=e.user_id
		ORDER BY COALESCE(NULLIF(u.name,''), u.id)`, []string{id})
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AssignmentMemberRow{}
	for rows.Next() {
		var row AssignmentMemberRow
		if err := rows.Scan(&row.UserID, &row.Name, &row.AvatarURL, &row.SubmittedAt, &row.Running); err != nil {
			return nil, err
		}
		row.Missing = kind == AssignmentMarked && due != nil && !due.After(now)
		out = append(out, row)
	}
	return out, rows.Err()
}

type reportAttempt struct {
	id, userID     string
	number         int
	started        *time.Time
	submitted      time.Time
	correct, total float64
	waitingAnswers int
	answers        map[string]any
	graded         map[string]map[string]any
}

const reportAttemptCols = `t.id, t.user_id, (SELECT count(*) FROM attempts x
		WHERE x.assignment_id=t.assignment_id AND x.user_id=t.user_id AND x.submitted_at <= t.submitted_at),
	t.started_at, t.submitted_at, t.correct::float8, t.total::float8, t.waiting_answers, t.answers, t.questions`

// countedAttempts reads each member's submission that counts.
func countedAttempts(ctx context.Context, q rowsQueryer, id string) ([]reportAttempt, error) {
	return readReportAttempts(ctx, q, `SELECT DISTINCT ON (t.user_id) `+reportAttemptCols+`
		FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.assignment_id=$1 AND t.submitted_at IS NOT NULL ORDER BY t.user_id, `+countedAttemptOrder, id)
}

// waitingAttempts reads the other submissions with an answer still waiting.
func waitingAttempts(ctx context.Context, q rowsQueryer, id string, counted []string) ([]reportAttempt, error) {
	return readReportAttempts(ctx, q, `SELECT `+reportAttemptCols+` FROM attempts t
		WHERE t.assignment_id=$1 AND t.submitted_at IS NOT NULL AND t.waiting_answers > 0 AND t.id <> ALL($2)
		ORDER BY t.user_id, t.submitted_at`, id, counted)
}

// latestAttempts reads each member's latest submission, which reviews rate: what
// they know now, whichever submission scored highest.
func latestAttempts(ctx context.Context, q rowsQueryer, id string) ([]reportAttempt, error) {
	return readReportAttempts(ctx, q, `SELECT DISTINCT ON (t.user_id) `+reportAttemptCols+` FROM attempts t
		WHERE t.assignment_id=$1 AND t.submitted_at IS NOT NULL ORDER BY t.user_id, t.submitted_at DESC`, id)
}

func readReportAttempts(ctx context.Context, q rowsQueryer, sql string, args ...any) ([]reportAttempt, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []reportAttempt
	for rows.Next() {
		var a reportAttempt
		var rawAnswers, rawQuestions []byte
		if err := rows.Scan(&a.id, &a.userID, &a.number, &a.started, &a.submitted, &a.correct, &a.total, &a.waitingAnswers, &rawAnswers, &rawQuestions); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(rawAnswers, &a.answers); err != nil {
			return nil, err
		}
		qs, err := decodeFrozen(rawQuestions)
		if err != nil {
			return nil, err
		}
		a.graded = make(map[string]map[string]any, len(qs))
		for _, q := range qs {
			id, _ := q["id"].(string)
			a.graded[id] = q
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// questionReports works out each question's numbers from the counted submissions,
// and its answer rows from those and the waiting answers of the others.
func questionReports(frozen []map[string]any, attempts, others []reportAttempt) ([]AssignmentQuestionReport, []AssignmentAnswerRow) {
	reports := make([]AssignmentQuestionReport, 0, len(frozen))
	rows := []AssignmentAnswerRow{}
	for _, q := range frozen {
		id, _ := q["id"].(string)
		list, _ := q["parts"].([]any)
		report := AssignmentQuestionReport{Question: q, Parts: make([]AssignmentPartReport, 0, len(list))}
		open := false
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			a, _ := p["answer"].(map[string]any)
			open = open || a["type"] == "open"
			report.Parts = append(report.Parts, partReport(p, attempts))
		}
		var fullMarks, marked int
		var awardedSum float64
		for _, attempt := range attempts {
			graded := attempt.graded[id]
			if graded == nil {
				continue
			}
			report.Submitted++
			awarded, marks := questionMarks(graded)
			waiting := questionWaiting(graded)
			if !waiting {
				marked++
				awardedSum += awarded
				if marks > 0 && awarded >= marks {
					fullMarks++
				}
			}
			// By their own copy: a republish may have changed the question since.
			if hasOpenPart(graded) {
				rows = append(rows, AssignmentAnswerRow{QuestionID: id, UserID: attempt.userID, AttemptID: attempt.id, AttemptNumber: attempt.number,
					Waiting: waiting, Awarded: awarded, Marks: marks})
			}
		}
		for _, attempt := range others {
			graded := attempt.graded[id]
			if graded != nil && questionWaiting(graded) {
				awarded, marks := questionMarks(graded)
				rows = append(rows, AssignmentAnswerRow{QuestionID: id, UserID: attempt.userID, AttemptID: attempt.id, AttemptNumber: attempt.number,
					Waiting: true, Awarded: awarded, Marks: marks})
			}
		}
		if marked >= assignmentAggregateMin {
			if open {
				average := awardedSum / float64(marked)
				report.Average = &average
			} else {
				percent := float64(fullMarks) / float64(marked)
				report.Percent = &percent
			}
		}
		reports = append(reports, report)
	}
	return reports, rows
}

func hasOpenPart(q map[string]any) bool {
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		if a, _ := p["answer"].(map[string]any); a["type"] == "open" {
			return true
		}
	}
	return false
}

func partReport(p map[string]any, attempts []reportAttempt) AssignmentPartReport {
	id, _ := p["id"].(string)
	a, _ := p["answer"].(map[string]any)
	out := AssignmentPartReport{PartID: id}
	graded := func(attempt reportAttempt) map[string]any {
		for _, q := range attempt.graded {
			parts, _ := q["parts"].([]any)
			for _, raw := range parts {
				gp, _ := raw.(map[string]any)
				if gp["id"] == id {
					return gp
				}
			}
		}
		return nil
	}
	switch a["type"] {
	case "mcq":
		options, _ := a["options"].([]any)
		out.Options = make([]int, len(options))
		for _, attempt := range attempts {
			chosen, _ := attempt.answers[id].([]any)
			for _, raw := range chosen {
				if i, ok := raw.(float64); ok && int(i) >= 0 && int(i) < len(options) {
					out.Options[int(i)]++
				}
			}
		}
	case "boolean":
		out.Options = make([]int, 2)
		for _, attempt := range attempts {
			if chosen, ok := attempt.answers[id].(bool); ok {
				if chosen {
					out.Options[0]++
				} else {
					out.Options[1]++
				}
			}
		}
	case "short":
		counts := map[string]int{}
		for _, attempt := range attempts {
			text, ok := attempt.answers[id].(string)
			text = strings.TrimSpace(text)
			gp := graded(attempt)
			if !ok || text == "" || gp == nil {
				continue
			}
			awarded, _ := gp["awarded"].(float64)
			marks, _ := gp["marks"].(float64)
			if awarded < marks {
				counts[strings.ToLower(text)]++
			}
		}
		for text, count := range counts {
			out.WrongAnswers = append(out.WrongAnswers, AssignmentWrongAnswer{Text: text, Count: count})
		}
		sort.Slice(out.WrongAnswers, func(i, j int) bool {
			if out.WrongAnswers[i].Count != out.WrongAnswers[j].Count {
				return out.WrongAnswers[i].Count > out.WrongAnswers[j].Count
			}
			return out.WrongAnswers[i].Text < out.WrongAnswers[j].Text
		})
		if len(out.WrongAnswers) > wrongAnswersShown {
			out.WrongAnswers = out.WrongAnswers[:wrongAnswersShown]
		}
	case "open":
		texts, marks := questions.MarkItems(p)
		out.Items = make([]AssignmentItemReport, len(texts))
		for i := range texts {
			out.Items[i] = AssignmentItemReport{Text: texts[i], Marks: marks[i]}
		}
		for _, attempt := range attempts {
			gp := graded(attempt)
			if gp == nil {
				continue
			}
			if pending, _ := gp["pending"].(bool); pending {
				continue
			}
			awards, _ := gp["itemAwards"].([]any)
			for i := range out.Items {
				out.Items[i].Marked++
				if i < len(awards) {
					if v, _ := awards[i].(float64); v > 0 {
						out.Items[i].Awarded++
					}
				}
			}
		}
	}
	return out
}

/* ------------------------------------------------------------------- sweep */

// SweepAssignments is the server closing what a closed tab cannot: it submits
// what running attempts saved once their time runs out or the assignment closes,
// by hand or at a No late submissions due date, past the grace, and shows a closed
// assignment's quiz as practice, once. A due date alone releases nothing (Epo
// 2026-11-04).
// The quiz stays hidden while another open assignment uses it. One row that
// fails is logged and passed over; each batch is a random pick, so rows that keep
// failing never fill it every minute and hold up the rest.
func (s *Store) SweepAssignments(ctx context.Context, limit int, now time.Time) (finished, released int, err error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.assignment_id IS NOT NULL AND t.submitted_at IS NULL
			AND (t.deadline_at <= $1 OR a.closed_at <= $1 OR (a.no_late AND a.due_at <= $1)) ORDER BY random() LIMIT $2`, now.Add(-assignmentGrace), limit)
	if err != nil {
		return 0, 0, err
	}
	attemptIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, 0, err
	}
	for _, id := range attemptIDs {
		if err := s.finishAttemptIfRunning(ctx, id, now); err != nil {
			obs.Log(ctx).Warn("assignment attempt not submitted", "attempt_id", id, "error", err)
			continue
		}
		finished++
	}
	rows, err = s.pool.Query(ctx, `SELECT id FROM assignments
		WHERE released_at IS NULL AND kind='marked' AND NOT draft AND (closed_at IS NOT NULL OR (no_late AND due_at <= $1))
		ORDER BY random() LIMIT $2`, now, limit)
	if err != nil {
		return finished, 0, err
	}
	assignmentIDs, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return finished, 0, err
	}
	for _, id := range assignmentIDs {
		if err := s.releaseAssignment(ctx, id, now); err != nil {
			obs.Log(ctx).Warn("assignment not released", "assignment_id", id, "error", err)
			continue
		}
		released++
	}
	return finished, released, nil
}

// releaseAssignment makes its quiz a normal visible one, practice for members,
// and rates what they submitted (§4, §11.6, Epo 2026-11-04). The owner can hide
// it again. Its locks run workspace, quiz, assignment: purging a quiz deletes the
// material and its foreign key then takes the assignment, with no workspace row
// held when an account purge does it.
func (s *Store) releaseAssignment(ctx context.Context, id string, now time.Time) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var wsID string
		var source *string
		err := tx.QueryRow(ctx, `SELECT workspace_id, source_quiz_id FROM assignments WHERE id=$1`, id).Scan(&wsID, &source)
		if isNoRows(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := lockWorkspaceKeyShareTx(ctx, tx, wsID); err != nil {
			return err
		}
		if source != nil {
			if _, err := tx.Exec(ctx, `SELECT 1 FROM materials WHERE id=$1 FOR NO KEY UPDATE`, *source); err != nil {
				return err
			}
		}
		var released *time.Time
		err = tx.QueryRow(ctx, `SELECT source_quiz_id, released_at FROM assignments WHERE id=$1 FOR UPDATE SKIP LOCKED`, id).Scan(&source, &released)
		if isNoRows(err) || released != nil {
			return nil
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE assignments SET released_at=$2 WHERE id=$1`, id, now); err != nil {
			return err
		}
		if source == nil {
			return nil
		}
		var othersOpen bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM assignments WHERE source_quiz_id=$1 AND id<>$2 AND NOT draft
			AND closed_at IS NULL AND NOT (no_late AND due_at <= $3))`, *source, id, now).Scan(&othersOpen); err != nil {
			return err
		}
		if !othersOpen {
			if _, err := tx.Exec(ctx, `UPDATE materials SET hidden=false WHERE id=$1 AND trashed_at IS NULL AND hidden`, *source); err != nil {
				return err
			}
		}
		attempts, err := latestAttempts(ctx, tx, id)
		if err != nil {
			return err
		}
		for _, attempt := range attempts {
			graded := make([]map[string]any, 0, len(attempt.graded))
			for _, q := range attempt.graded {
				graded = append(graded, q)
			}
			if err := s.rateAttemptTx(ctx, tx, attempt.userID, *source, graded, attempt.answers, now); err != nil {
				return err
			}
		}
		return nil
	})
}

/* ---------------------------------------------------------- sharing notice */

// SharingNotice is what a class's viewer member is yet to be told (board V1).
type SharingNotice struct {
	Due bool `json:"due"`
	// Owner is who they share with (Epo 2026-11-04), read only while it is due.
	Owner *MaterialAuthor `json:"owner,omitempty"`
}

// SharingNoticeFor reads the notice a member is due; anyone else is due nothing.
func (s *Store) SharingNoticeFor(ctx context.Context, userID, wsID string) (SharingNotice, error) {
	var owner MaterialAuthor
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(NULLIF(owner.name,''), owner.id),
			COALESCE('/icons/' || NULLIF(owner.avatar_icon_id,'') || '.svg', owner.avatar_url, '')
		FROM workspace_members wm
		JOIN workspaces w ON w.id=wm.workspace_id AND w.kind='class'
		JOIN users owner ON owner.id=w.user_id
		WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.role='viewer' AND wm.sharing_notice_seen_at IS NULL`, wsID, userID).
		Scan(&owner.Name, &owner.AvatarURL)
	if isNoRows(err) {
		return SharingNotice{}, nil
	}
	if err != nil {
		return SharingNotice{}, err
	}
	return SharingNotice{Due: true, Owner: &owner}, nil
}

// MarkSharingNoticeSeen records that the member was told, so it never shows twice.
func (s *Store) MarkSharingNoticeSeen(ctx context.Context, userID, wsID string, now time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE workspace_members SET sharing_notice_seen_at=$3
		WHERE workspace_id=$1 AND user_id=$2 AND sharing_notice_seen_at IS NULL`, wsID, userID, now)
	return err
}
