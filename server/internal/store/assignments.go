package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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
	// assignmentNoteMax caps a comment on an answer.
	assignmentNoteMax = 2000
)

var (
	// ErrAssignmentClosed refuses starting or submitting after the owner closed it.
	ErrAssignmentClosed = errors.New("this assignment is closed")
	// ErrAssignmentNoAttempts refuses a start with every attempt used.
	ErrAssignmentNoAttempts = errors.New("no attempts are left on this assignment")
	// ErrPaperHandedIn: a member hands in one paper, and then answers no more
	// (Epo 2026-11-25).
	ErrPaperHandedIn = errors.New("you have handed in your paper already")
	// ErrAnsweredOnline: a member who answered online uploads no paper; the
	// first start picks the way for good (Epo 2026-11-25).
	ErrAnsweredOnline = errors.New("you answer this assignment online")
	// ErrAttemptFinished refuses a save or submit of a submitted attempt.
	ErrAttemptFinished = errors.New("this attempt has been submitted")
	// ErrAssignmentQuizGone refuses publishing a draft whose quiz was deleted.
	ErrAssignmentQuizGone = errors.New("the quiz this assignment was made from is gone")
	// ErrPaperTotalBelowMark refuses a file's graded quiz a total below a mark
	// already given (setPaperMarksTx).
	ErrPaperTotalBelowMark = errors.New("the total can't go below a mark already given")
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
	// Closed: as ClosedAt, for either kind (Epo 2026-11-09, "same rules").
	Closed bool `json:"closed"`
	Draft  bool `json:"draft"`
	// NoLate: it closes itself at the due date. Off, late work is open until it
	// is closed by hand, with a marked one's LatePenaltyPct (0, 20 or 50) off
	// its mark.
	NoLate         bool `json:"noLate"`
	LatePenaltyPct int  `json:"latePenaltyPct"`
	// TimeLimitMin, when set, starts the server's clock at Start.
	TimeLimitMin *int `json:"timeLimitMin,omitempty"`
	Attempts     int  `json:"attempts"`
	// Questions and Marks are the frozen copy's; 0 on a draft and when unmarked.
	Questions int     `json:"questions"`
	Marks     float64 `json:"marks"`
	// Points: a class's Assignment graded out of this many (Epo 2026-11-14),
	// each member's grade entered by staff (SetAssignmentGrade); absent, not
	// graded.
	Points *int `json:"points,omitempty"`
	// AllowUploads: a member may hand in a paper instead of answering in the app
	// ("Allow submission with uploads", Epo 2026-11-08).
	AllowUploads bool `json:"allowUploads"`
	// UploadOnly: a marked one is answered by upload only, never in the app
	// (Epo 2026-11-19); it goes with AllowUploads.
	UploadOnly bool `json:"uploadOnly"`
	// PaperFile: a graded quiz made from a file (Epo 2026-11-20), its question
	// paper the one entry of Files, read live; answered by upload only and
	// marked by hand out of Marks.
	PaperFile bool `json:"paperFile"`
	// TopicIDs: its quiz's topic, then the other topics its questions name as
	// their own (questionTopicsSQL), or its files' with the most-used first.
	TopicIDs []string         `json:"topicIds" nullable:"false"`
	Files    []AssignmentFile `json:"files" nullable:"false"`
	// GradesHidden: Show grades is manual and staff have not released them, so a
	// member reads no marks, comments or keys yet.
	GradesHidden bool              `json:"gradesHidden"`
	Manage       *AssignmentManage `json:"manage,omitempty"`
	Mine         *AssignmentMine   `json:"mine,omitempty"`
}

// AssignmentFile is an unmarked assignment's file or material.
type AssignmentFile struct {
	FileID     *string `json:"fileId,omitempty"`
	MaterialID *string `json:"materialId,omitempty"`
	Name       string  `json:"name"`
	// Kind is the file's or material's kind, which picks its icon.
	Kind string `json:"kind"`
	// WorkspaceID and WorkspaceName are where it sits and opens: the class's.
	WorkspaceID   *string `json:"workspaceId,omitempty"`
	WorkspaceName string  `json:"workspaceName,omitempty"`
	// ThumbnailKey is a file's page-1 WebP, which getAssignment signs into
	// ThumbnailURL; Preview is a text file's opening characters or a material's
	// card summary, so its card looks as on the Files page (Epo 2026-11-19).
	ThumbnailKey string          `json:"-"`
	ThumbnailURL *string         `json:"thumbnailUrl,omitempty" doc:"Hour-stable presigned GET of a file's page-1 thumbnail; the assignment's own read only"`
	Preview      MaterialPreview `json:"preview,omitempty" doc:"A text file's opening characters or a material's list-card preview (openwiki/thumbnails.md)"`
}

// AssignmentManage is what its owner and teaching assistants read.
type AssignmentManage struct {
	QuizID *string `json:"quizId,omitempty"`
	// QuizTitle is its quiz's current title, for the edit form.
	QuizTitle string `json:"quizTitle,omitempty"`
	// QuizChanged: its quiz's content was saved after it was last published,
	// so Republish would change what members take (Epo 2026-11-14).
	QuizChanged bool `json:"quizChanged,omitempty"`
	// QuizUpdatedAt is when its quiz was last saved, its Settings' "Last
	// edited" (Epo 2026-11-16); absent when the quiz is gone.
	QuizUpdatedAt *time.Time `json:"quizUpdatedAt,omitempty"`
	AssignAll     bool       `json:"assignAll"`
	Assignees     []string   `json:"assignees" nullable:"false"`
	// Marking: ai_approve (the AI, approved before members see it), ai or manual.
	Marking string `json:"marking" enum:"ai_approve,ai,manual"`
	// ShowAnswers is when members read the keys on their results: closed,
	// submitted or never.
	ShowAnswers string `json:"showAnswers" enum:"closed,submitted,never"`
	// ShowGrades is when members see their marks: automatic, or manual from
	// GradesReleasedAt, when staff released them.
	ShowGrades       string     `json:"showGrades" enum:"automatic,manual"`
	GradesReleasedAt *time.Time `json:"gradesReleasedAt,omitempty"`
	Shuffle          bool       `json:"shuffle"`
	// Assigned counts who it went to; Done those who submitted or ticked it.
	Assigned int `json:"assigned"`
	Done     int `json:"done"`
	// Average is the submitted members' counted marks, after any late penalty, over
	// the marks decided so far (0 to 1); on a graded Assignment the grades given,
	// after any late penalty, over its points.
	Average *float64 `json:"average,omitempty"`
	// ToApprove counts answers waiting for the owner, in any submission of a
	// member's: one that does not count yet can still become the highest. Under AI
	// marking NotGraded is how many of them have no AI mark yet (no credits, a
	// grade error, or not tried); the page shows the rest as to approve (Epo
	// 2026-11-08, mock T3).
	ToApprove int `json:"toApprove"`
	NotGraded int `json:"notGraded"`
	// Graded counts submissions with every mark decided, past members' too: a
	// graded quiz from a file asks before its total changes while any is
	// (Epo 2026-11-20), as setPaperMarksTx checks them all.
	Graded int `json:"graded"`
	// ApprovalsCheckedOff: the caller ticked the answers waiting off their To do
	// (SetAssignmentTodoCheck), and none was submitted since.
	ApprovalsCheckedOff bool `json:"approvalsCheckedOff"`
}

// AssignmentMine is the caller's own state on an assignment given to them.
type AssignmentMine struct {
	// Done: a marked one submitted, an unmarked one ticked.
	Done   bool       `json:"done"`
	DoneAt *time.Time `json:"doneAt,omitempty"`
	// RunningAttemptID is the attempt in progress.
	RunningAttemptID *string `json:"runningAttemptId,omitempty"`
	// AttemptsUsed counts answers in the app; PaperHandedIn the one upload,
	// after which nothing starts (Epo 2026-11-25).
	AttemptsUsed  int  `json:"attemptsUsed"`
	PaperHandedIn bool `json:"paperHandedIn"`
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
	// On a graded Assignment, Correct is the grade staff gave, Mark the same
	// after any late penalty (late from the tick or hand-in) and Total its
	// points; absent until graded.
	// CheckedOff: they ticked a marked one, or one handed in with files, off
	// their To do without doing it (SetAssignmentTodoCheck), at CheckedAt.
	// Done stays false.
	CheckedOff bool       `json:"checkedOff"`
	CheckedAt  *time.Time `json:"checkedAt,omitempty"`
	// HandIn is their work on an unmarked one that takes files (S3), in order.
	HandIn []PaperFile `json:"handIn,omitempty"`
}

// AssignmentList is Study → Assignments. Members counts the workspace's viewer
// members, for its owner and teaching assistants.
type AssignmentList struct {
	Items   []Assignment `json:"items" nullable:"false"`
	Members *int         `json:"members,omitempty"`
	// NextCursor reads the next page; empty when this is the last.
	NextCursor string `json:"nextCursor,omitempty"`
}

// AssignmentListParams page Study → Assignments and a member's To do (Epo
// 2026-11-13): Closed keeps the closed ones, Done the caller's done ones, and
// TopicIDs, when any, only those on one of them; Kind, when set, only that
// kind (Epo 2026-11-19). Sort orders by a column (an
// AssignmentSort), open ones still before closed ones; empty is the page's
// own order.
type AssignmentListParams struct {
	Closed    bool
	Done      bool
	TopicIDs  []string
	Kind      string
	Sort      string
	Ascending bool
	Offset    int
	Limit     int
}

// AssignmentSorts are the columns the list sorts by, as SQL; a row without the
// value goes last either way.
var AssignmentSorts = map[string]string{
	"title": `lower(a.title)`,
	"kind":  `a.kind`,
	// The first topic it shows: its quiz's, else its questions' first.
	"topic": `lower(COALESCE(tp.name, (SELECT t.name FROM topics t WHERE t.workspace_id=a.workspace_id AND t.id IN (` + questionTopicIDsSQL + `)
		ORDER BY t.position, t.id LIMIT 1)))`,
	"posted": `a.posted_at`,
	"due":    `a.due_at`,
}

// assignmentClosedSQL is assignmentClosedAt's "closed" for assignments a at $now.
func assignmentClosedSQL(now string) string {
	return `(a.closed_at IS NOT NULL OR (a.no_late AND a.due_at <= ` + now + `))`
}

// AssignmentForm is what the New assignment dialog sets. Questions is the
// quiz's current content, read by the caller after projecting live edits; a
// marked assignment freezes it unless it is a draft.
//
// A graded quiz's waiting form is stored as JSON with a Make a quiz run
// (Extraction.GradedQuiz); Questions, read when it is made, is not.
type AssignmentForm struct {
	Kind           string
	Title          string
	QuizID         string
	Questions      []map[string]any `json:"-"`
	DueAt          *time.Time
	TimeLimitMin   *int
	Attempts       int
	NoLate         bool
	LatePenaltyPct int
	AssignAll      bool
	Assignees      []string
	Draft          bool
	Marking        string
	ShowAnswers    string
	ShowGrades     string
	Shuffle        bool
	AllowUploads   bool
	UploadOnly     bool
	// PaperFile: a graded quiz whose question paper is its one file
	// (MakeFileGradedQuiz); set by the server, never read from a request.
	PaperFile bool
	Files     []AssignmentFileRef
	// Points grades an Assignment (unmarked) that takes uploads; nil, none.
	Points *int
	// TotalMarks is a file's graded quiz's total (Epo 2026-11-20), and only
	// theirs: what each hand-in is marked out of.
	TotalMarks *int
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
	kind, member, err := workspaceStanding(ctx, q, userID, wsID)
	if err != nil {
		return false, err
	}
	if kind != WorkspaceClass {
		return false, ErrNotFound
	}
	return RoleCanEdit(member), nil
}

// workspaceStanding reads the workspace's kind and the caller's membership of
// it (empty for a link or public visitor); someone with no way in is refused.
func workspaceStanding(ctx context.Context, q rowQueryer, userID, wsID string) (WorkspaceKind, WorkspaceRole, error) {
	member, effective, err := workspaceRoles(ctx, q, userID, wsID)
	if err != nil {
		return "", "", err
	}
	if effective == "" {
		return "", "", ErrNotFound
	}
	var kind WorkspaceKind
	if err := q.QueryRow(ctx, `SELECT kind FROM workspaces WHERE id=$1`, wsID).Scan(&kind); err != nil {
		return "", "", err
	}
	return kind, member, nil
}

var assignmentCols = `a.id, a.workspace_id, a.kind, a.title, a.posted_at, COALESCE(NULLIF(u.name,''), u.id, ''),
	a.due_at, a.closed_at, a.no_late, a.late_penalty_pct, a.draft, a.time_limit_min, a.attempts_allowed, a.question_count, a.total_marks::float8,
	a.source_quiz_id, COALESCE(m.title,''), m.topic_id,
	a.assign_all, a.marking, a.answers_shown, a.grades_shown, a.grades_released_at, a.shuffle, a.allow_uploads, a.upload_only,
	COALESCE(NOT a.draft AND m.updated_at > a.posted_at, false), m.updated_at, a.points, a.paper_file,
	` + questionTopicsSQL

// questionTopicIDsSQL is every topic id assignment a's questions name as
// their own (Epo 2026-11-15): the posted questions, or a draft's quiz as it
// stands. Each row's JSON is read once, not once per topic.
const questionTopicIDsSQL = `SELECT jsonb_array_elements_text(CASE WHEN a.draft
		THEN jsonb_path_query_array(m.content, 'lax $.value[*].children[*].question.topicIds[*]')
		ELSE jsonb_path_query_array(a.questions, 'lax $[*].topicIds[*]') END)`

// questionTopicsSQL lists the workspace's other topics, in order, that the
// assignment's questions name; a question's topic the workspace does not hold
// is ignored, so it adds none. The Topic filter and sort read the same.
const questionTopicsSQL = `ARRAY(SELECT t.id FROM topics t
		WHERE t.workspace_id=a.workspace_id AND t.id IS DISTINCT FROM m.topic_id AND t.id IN (` + questionTopicIDsSQL + `)
		ORDER BY t.position, t.id)`

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
	var list []Assignment
	for rows.Next() {
		var a Assignment
		var manage AssignmentManage
		var topicID *string
		var questionTopics []string
		if err := rows.Scan(&a.ID, &a.WorkspaceID, &a.Kind, &a.Title, &a.PostedAt, &a.PostedBy,
			&a.DueAt, &a.ClosedAt, &a.NoLate, &a.LatePenaltyPct, &a.Draft, &a.TimeLimitMin, &a.Attempts, &a.Questions, &a.Marks,
			&manage.QuizID, &manage.QuizTitle, &topicID,
			&manage.AssignAll, &manage.Marking, &manage.ShowAnswers, &manage.ShowGrades, &manage.GradesReleasedAt, &manage.Shuffle, &a.AllowUploads, &a.UploadOnly, &manage.QuizChanged, &manage.QuizUpdatedAt, &a.Points, &a.PaperFile, &questionTopics); err != nil {
			return nil, err
		}
		a.ClosedAt = assignmentClosedAt(a.NoLate, a.DueAt, a.ClosedAt, now)
		a.GradesHidden = gradesHidden(manage.ShowGrades, manage.GradesReleasedAt)
		a.Closed = a.ClosedAt != nil
		a.TopicIDs, a.Files = []string{}, []AssignmentFile{}
		if topicID != nil {
			a.TopicIDs = []string{*topicID}
		}
		a.TopicIDs = append(a.TopicIDs, questionTopics...)
		manage.Assignees = []string{}
		if staff {
			a.Manage = &manage
		}
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
	var managed []string
	for i, a := range list {
		ids[i], at[a.ID] = a.ID, i
		if a.Manage != nil {
			managed = append(managed, a.ID)
		}
	}
	if err := s.fillAssignmentFiles(ctx, userID, ids, at, list); err != nil {
		return nil, err
	}
	if len(managed) > 0 {
		if err := s.fillAssignmentManage(ctx, userID, managed, at, list); err != nil {
			return nil, err
		}
	}
	if err := s.fillAssignmentMine(ctx, userID, ids, at, list, now); err != nil {
		return nil, err
	}
	seen := list[:0]
	for _, a := range list {
		if a.Mine != nil || a.Manage != nil {
			seen = append(seen, a)
		}
	}
	return seen, nil
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

// gradesHidden: grades wait for staff to release them.
func gradesHidden(shown string, released *time.Time) bool {
	return shown == GradesManual && released == nil
}

// noLateDue is the due date that closes it under No late submissions.
func noLateDue(noLate bool, due *time.Time) *time.Time {
	if noLate {
		return due
	}
	return nil
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

// gradesSQL lists the grades on graded Assignments (Epo 2026-11-14): who,
// what they were given (correct) out of the points (total), and the mark that
// counts, after any late penalty, late reading the member's tick or hand-in as
// attemptMarkSQL reads a submission. A grade on one whose points were taken
// off is not read.
const gradesSQL = `SELECT g.assignment_id, g.user_id, g.points AS correct, a.points::numeric AS total,
		round(g.points * (100 - CASE WHEN NOT a.no_late AND d.done_at > a.due_at
			THEN a.late_penalty_pct ELSE 0 END) / 100.0, 2) AS mark
	FROM assignment_grades g JOIN assignments a ON a.id=g.assignment_id AND a.points IS NOT NULL
	LEFT JOIN assignment_done d ON d.assignment_id=g.assignment_id AND d.user_id=g.user_id`

// countedAttemptOrder puts first the submission of a member's that counts (Epo
// 2026-11-05): the highest share of its own total after any late penalty, as a
// republish can change the total, a tie to the latest. It reads live: correct is
// the marks decided so far, so marking an open part or changing the penalty or
// due date can change which one it is.
const countedAttemptOrder = attemptMarkSQL + ` / NULLIF(t.total, 0) DESC NULLS LAST, t.submitted_at DESC`

// fillAssignmentFiles adds each unmarked assignment's files the caller can see,
// in the order added, and takes its topics from them, the most used first.
func (s *Store) fillAssignmentFiles(ctx context.Context, userID string, ids []string, at map[string]int, list []Assignment) error {
	// An assignment's files are its workspace's. A file's graded quiz names its question paper to those given it, hidden
	// or not; a hidden one's topic, page 1 and opening text wait for their
	// Start, as FileReadRole opens it then.
	rows, err := s.pool.Query(ctx, `SELECT af.assignment_id, f.id, m.id, COALESCE(f.name, m.title), COALESCE(f.kind::text, m.kind::text),
			CASE WHEN o.shown THEN COALESCE(f.topic_id, m.topic_id) END, fw.id, COALESCE(fw.name, ''),
			CASE WHEN o.shown THEN COALESCE(f.thumbnail_key, '') ELSE '' END, CASE WHEN o.shown THEN COALESCE(f.preview, m.preview) END
		FROM assignment_files af
		JOIN assignments a ON a.id=af.assignment_id
		LEFT JOIN files f ON f.id=af.file_id AND f.trashed_at IS NULL
		LEFT JOIN materials m ON m.id=af.material_id AND m.trashed_at IS NULL
		LEFT JOIN workspaces fw ON fw.id=COALESCE(f.workspace_id, m.workspace_id)
		CROSS JOIN LATERAL (SELECT NOT workspace_item_visible(COALESCE(f.hidden, `+materialHiddenSQL+`), a.workspace_id, $2) AS unseen) v
		CROSS JOIN LATERAL (SELECT NOT v.unseen OR EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=a.id AND t.user_id=$2) AS shown) o
		WHERE af.assignment_id = ANY($1) AND (f.id IS NOT NULL OR m.id IS NOT NULL)
			AND ((a.paper_file AND NOT a.draft AND f.workspace_id=a.workspace_id) OR NOT v.unseen)
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
		if err := rows.Scan(&id, &file.FileID, &file.MaterialID, &file.Name, &file.Kind, &topic, &file.WorkspaceID, &file.WorkspaceName,
			&file.ThumbnailKey, &file.Preview); err != nil {
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

// givenSQL reads whether assignment a, in workspace aw, is given to member wm:
// in a class, its viewers when it is for all members and anyone named. A
// workspace that is not a class gives its assignments to nobody until it
// changes back.
const givenSQL = `(aw.kind='class' AND ((a.assign_all AND wm.role='viewer')
		OR EXISTS (SELECT 1 FROM assignment_assignees aa WHERE aa.assignment_id=a.id AND aa.user_id=wm.user_id)))`

// assigneesSQL lists who each of the assignments in $1 went to (givenSQL), among
// those still members.
const assigneesSQL = `SELECT a.id AS assignment_id, wm.user_id
	FROM assignments a JOIN workspaces aw ON aw.id=a.workspace_id
	JOIN workspace_members wm ON wm.workspace_id=a.workspace_id
	WHERE a.id = ANY($1) AND ` + givenSQL

// fillAssignmentManage adds the counts, the named assignees and whether the
// caller ticked the answers waiting off their To do.
func (s *Store) fillAssignmentManage(ctx context.Context, userID string, ids []string, at map[string]int, list []Assignment) error {
	rows, err := s.pool.Query(ctx, `WITH e AS (`+assigneesSQL+`),
		l AS (
			SELECT DISTINCT ON (t.assignment_id, t.user_id) t.assignment_id, t.total, t.waiting_marks, `+attemptMarkSQL+` AS mark
			FROM attempts t JOIN e ON e.assignment_id=t.assignment_id AND e.user_id=t.user_id
			JOIN assignments a ON a.id=t.assignment_id
			WHERE t.submitted_at IS NOT NULL
			ORDER BY t.assignment_id, t.user_id, `+countedAttemptOrder+`),
		g AS (SELECT gr.assignment_id, gr.mark, gr.total FROM (`+gradesSQL+`) gr
			JOIN e ON e.assignment_id=gr.assignment_id AND e.user_id=gr.user_id),
		c AS (SELECT assignment_id, count(*) AS n FROM e GROUP BY 1),
		d AS (SELECT d.assignment_id, count(*) AS n FROM assignment_done d
			JOIN e ON e.assignment_id=d.assignment_id AND e.user_id=d.user_id GROUP BY 1),
		r AS (SELECT assignment_id, count(*) AS n FROM l GROUP BY 1),
		-- A graded quiz's counted marks, or a graded Assignment's grades.
		v AS (SELECT assignment_id, avg(share)::float8 AS mean FROM (
				SELECT assignment_id, mark / NULLIF(total - waiting_marks, 0) AS share FROM l
				UNION ALL SELECT assignment_id, mark / total FROM g) x GROUP BY 1),
		w AS (SELECT t.assignment_id, sum(t.waiting_answers)::int AS n
			FROM attempts t JOIN e ON e.assignment_id=t.assignment_id AND e.user_id=t.user_id
			WHERE t.submitted_at IS NOT NULL GROUP BY 1),
		u AS (SELECT t.assignment_id, count(*)::int AS n
			FROM attempts t JOIN e ON e.assignment_id=t.assignment_id AND e.user_id=t.user_id
			JOIN assignments a ON a.id=t.assignment_id AND a.marking <> 'manual',
			LATERAL jsonb_array_elements(t.questions) q
			WHERE t.submitted_at IS NOT NULL AND t.waiting_answers > 0
				AND EXISTS (SELECT 1 FROM jsonb_array_elements(q->'parts') p
					WHERE p->>'pending' = 'true' AND NOT p ? 'aiAwards')
			GROUP BY 1),
		gr AS (SELECT t.assignment_id, count(*)::int AS n FROM attempts t
			WHERE t.assignment_id = ANY($1) AND t.submitted_at IS NOT NULL AND t.waiting_answers = 0 GROUP BY 1),
		k AS (SELECT x.assignment_id FROM assignment_todo_checks x
			WHERE x.assignment_id = ANY($1) AND x.user_id=$2 AND x.approvals
				AND x.checked_at >= COALESCE((SELECT max(t.submitted_at) FROM attempts t
					WHERE t.assignment_id=x.assignment_id AND t.submitted_at IS NOT NULL AND t.waiting_answers > 0), '-infinity'))
		SELECT c.assignment_id, c.n, COALESCE(d.n, 0), COALESCE(r.n, 0), v.mean, COALESCE(w.n, 0), COALESCE(u.n, 0),
			k.assignment_id IS NOT NULL, COALESCE(gr.n, 0)
		FROM c LEFT JOIN d ON d.assignment_id=c.assignment_id LEFT JOIN r ON r.assignment_id=c.assignment_id
		LEFT JOIN v ON v.assignment_id=c.assignment_id
		LEFT JOIN w ON w.assignment_id=c.assignment_id LEFT JOIN u ON u.assignment_id=c.assignment_id
		LEFT JOIN k ON k.assignment_id=c.assignment_id LEFT JOIN gr ON gr.assignment_id=c.assignment_id`, ids, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var assigned, ticked, submitted, waiting, ungraded, graded int
		var mean *float64
		var checkedOff bool
		if err := rows.Scan(&id, &assigned, &ticked, &submitted, &mean, &waiting, &ungraded, &checkedOff, &graded); err != nil {
			return err
		}
		m := list[at[id]].Manage
		m.Assigned, m.Done, m.ToApprove, m.NotGraded, m.Graded = assigned, ticked+submitted, waiting, ungraded, graded
		m.ApprovalsCheckedOff = checkedOff
		// From the first submission: staff see every member's mark anyway (Epo
		// 2026-11-13 dropped the five-result minimum here).
		m.Average = mean
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
			(SELECT x.checked_at FROM assignment_todo_checks x WHERE x.assignment_id=e.assignment_id AND x.user_id=$2 AND NOT x.approvals),
			(SELECT t.id FROM attempts t WHERE t.assignment_id=e.assignment_id AND t.user_id=$2 AND t.submitted_at IS NULL),
			(SELECT count(*) FROM attempts t WHERE t.assignment_id=e.assignment_id AND t.user_id=$2 AND t.submitted_at IS NOT NULL AND t.paper IS NULL),
			EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=e.assignment_id AND t.user_id=$2 AND t.submitted_at IS NOT NULL AND t.paper IS NOT NULL),
			l.id, l.correct::float8, l.total::float8, COALESCE(l.waiting_marks, 0)::float8, COALESCE(l.waiting_answers, 0), l.submitted_at,
			(SELECT g.points::float8 FROM assignment_grades g WHERE g.assignment_id=e.assignment_id AND g.user_id=$2)
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
		var grade *float64
		if err := rows.Scan(&id, &mine.DoneAt, &mine.CheckedAt, &mine.RunningAttemptID, &mine.AttemptsUsed, &mine.PaperHandedIn,
			&mine.CountedAttemptID, &mine.Correct, &mine.Total, &mine.WaitingMarks, &mine.WaitingAnswers, &submittedAt, &grade); err != nil {
			return err
		}
		a := &list[at[id]]
		if a.Draft {
			continue
		}
		if mine.DoneAt != nil && submittedAt == nil {
			// An unmarked one's tick is late as a submission is.
			mine.Late = assignmentLate(a.NoLate, a.DueAt, *mine.DoneAt)
		}
		// A graded Assignment's grade, late as its tick is.
		if a.Points != nil {
			mine.LatePenaltyPct = penaltyFor(mine.Late, a.LatePenaltyPct)
			if grade != nil {
				mark, total := penalisedMark(*grade, mine.LatePenaltyPct), float64(*a.Points)
				mine.Correct, mine.Mark, mine.Total = grade, &mark, &total
			}
		}
		if submittedAt != nil {
			mine.DoneAt = submittedAt
			mine.Late = assignmentLate(a.NoLate, a.DueAt, *submittedAt)
			mine.LatePenaltyPct = penaltyFor(mine.Late, a.LatePenaltyPct)
			mark := penalisedMark(*mine.Correct, mine.LatePenaltyPct)
			mine.Mark = &mark
		}
		if a.GradesHidden {
			mine.Correct, mine.Mark, mine.Total, mine.WaitingMarks, mine.WaitingAnswers = nil, nil, nil, 0, 0
			mine.LatePenaltyPct = 0
		} else if mine.WaitingAnswers > 0 {
			// No mark so far (Epo 2026-11-25): the counts say it is being graded.
			mine.Correct, mine.Mark, mine.Total = nil, nil, nil
		}
		mine.Done = mine.DoneAt != nil
		mine.CheckedOff = mine.CheckedAt != nil
		mine.Missing = a.Kind == AssignmentMarked && !mine.Done && a.DueAt != nil && !a.DueAt.After(now)
		a.Mine = &mine
	}
	if err := rows.Err(); err != nil {
		return err
	}
	var handIns []string
	for _, id := range ids {
		if a := list[at[id]]; a.Mine != nil && a.Kind == AssignmentUnmarked && a.AllowUploads {
			handIns = append(handIns, id)
		}
	}
	if len(handIns) == 0 {
		return nil
	}
	files, err := handInFiles(ctx, s.pool, handIns, []string{userID})
	if err != nil {
		return err
	}
	for _, id := range handIns {
		mine := list[at[id]].Mine
		mine.HandIn = files[[2]string{id, userID}]
		// Feedback given once their grade shows (S1): given and released.
		if mine.Mark == nil {
			withoutMarked(mine.HandIn)
		}
	}
	return nil
}

// ListAssignments is Study → Assignments, a page at a time: every assignment
// for a class's owner and editor members, the published ones given to them for
// anyone else. Open ones come first by due date, the latest closed after them;
// filtered, ordered and paged in SQL, as the To do page's Done tab is. A
// workspace that is not a class lists none, its class's work hidden until it
// changes back.
func (s *Store) ListAssignments(ctx context.Context, userID, wsID string, now time.Time, p AssignmentListParams) (AssignmentList, error) {
	out := AssignmentList{Items: []Assignment{}}
	kind, member, err := workspaceStanding(ctx, s.pool, userID, wsID)
	if err != nil || kind != WorkspaceClass {
		return out, err
	}
	staff := RoleCanEdit(member)
	// What readAssignments lets the caller see: staff every assignment, anyone
	// else what went to them (givenSQL).
	seen := `true`
	if !staff {
		seen = `NOT a.draft AND EXISTS (SELECT 1 FROM workspace_members wm
			JOIN workspaces aw ON aw.id=wm.workspace_id
			WHERE wm.workspace_id=a.workspace_id AND wm.user_id=$2 AND ` + givenSQL + `)`
	}
	closed := assignmentClosedSQL("$3")
	// The page's own order: open ones by due date, closed ones latest due first.
	order := `CASE WHEN NOT ` + closed + ` THEN a.due_at END ASC NULLS LAST,
			CASE WHEN ` + closed + ` THEN a.due_at END DESC NULLS LAST`
	if p.Sort != "" {
		// The handler holds sort to these columns.
		col, ok := AssignmentSorts[p.Sort]
		if !ok {
			return out, errors.New("unknown assignment sort " + p.Sort)
		}
		dir := "DESC"
		if p.Ascending {
			dir = "ASC"
		}
		order = col + ` ` + dir + ` NULLS LAST`
	}
	var topics []string
	if len(p.TopicIDs) > 0 {
		topics = p.TopicIDs
	}
	rows, err := s.pool.Query(ctx, `SELECT a.id FROM assignments a
		LEFT JOIN materials m ON m.id=a.source_quiz_id
		LEFT JOIN topics tp ON tp.id=m.topic_id
		WHERE a.workspace_id=$1 AND `+seen+`
			AND ($4 OR NOT `+closed+`)
			AND ($5 OR NOT (EXISTS (SELECT 1 FROM assignment_done d WHERE d.assignment_id=a.id AND d.user_id=$2)
				OR EXISTS (SELECT 1 FROM attempts t WHERE t.assignment_id=a.id AND t.user_id=$2 AND t.submitted_at IS NOT NULL)))
			AND ($6::text[] IS NULL OR m.topic_id = ANY($6) OR EXISTS (SELECT 1 FROM topics t
				WHERE t.workspace_id=a.workspace_id AND t.id = ANY($6) AND t.id IN (`+questionTopicIDsSQL+`)))
			AND ($9 = '' OR a.kind = $9)
		ORDER BY `+closed+`, `+order+`, a.posted_at DESC, a.id
		LIMIT $7 OFFSET $8`, wsID, userID, now, p.Closed, p.Done, topics, p.Limit+1, p.Offset, p.Kind)
	if err != nil {
		return out, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return out, err
	}
	if len(ids) > p.Limit {
		ids = ids[:p.Limit]
		out.NextCursor = strconv.Itoa(p.Offset + p.Limit)
	}
	if len(ids) > 0 {
		list, err := s.readAssignments(ctx, userID, staff, now, `a.id = ANY($1)`, ids)
		if err != nil {
			return out, err
		}
		read := make(map[string]Assignment, len(list))
		for _, a := range list {
			read[a.ID] = a
		}
		for _, id := range ids {
			if a, ok := read[id]; ok {
				out.Items = append(out.Items, a)
			}
		}
	}
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
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
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

// assignmentWorkspace reads the class an assignment is in.
func assignmentWorkspace(ctx context.Context, q rowQueryer, id string) (string, error) {
	var wsID string
	err := q.QueryRow(ctx, `SELECT workspace_id FROM assignments WHERE id=$1`, id).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return wsID, err
}

/* ------------------------------------------------------------------ writes */

// checkAssignmentForm checks the form against the workspace, in the write's
// transaction: an assignment's quiz, assignees and files must belong here, the
// files among those the actor sees.
func checkAssignmentForm(ctx context.Context, tx pgx.Tx, wsID, actorID string, form AssignmentForm) error {
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
	// An upload is handed in once (Epo 2026-11-25).
	if form.UploadOnly && form.Attempts != 1 {
		return assignmentInput("an assignment taking uploads only has one attempt")
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
		if len(form.Files) > 0 && !form.PaperFile {
			return assignmentInput("a marked assignment takes a quiz, not files")
		}
		if form.UploadOnly && !form.AllowUploads {
			return assignmentInput("an upload-only assignment takes uploads")
		}
	} else if form.QuizID != "" || form.TimeLimitMin != nil {
		return assignmentInput("an unmarked assignment has no quiz or time limit")
	} else if form.UploadOnly {
		return assignmentInput("only a marked assignment is upload-only")
	}
	if form.PaperFile != (form.TotalMarks != nil) {
		return assignmentInput("a graded quiz from a file, and only that, has total marks")
	}
	if form.TotalMarks != nil && (*form.TotalMarks < 1 || *form.TotalMarks > fieldlimits.AssignmentPoints) {
		return assignmentInput("total marks are 1 to " + strconv.Itoa(fieldlimits.AssignmentPoints))
	}
	if form.Points != nil {
		if form.Kind != AssignmentUnmarked {
			return assignmentInput("only an assignment is graded on points")
		}
		// Points grade what members hand in (Epo 2026-11-21): one taking no
		// uploads is only ticked done.
		if !form.AllowUploads {
			return assignmentInput("only an assignment taking uploads is graded on points")
		}
		if *form.Points < 1 || *form.Points > fieldlimits.AssignmentPoints {
			return assignmentInput("points are 1 to " + strconv.Itoa(fieldlimits.AssignmentPoints))
		}
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
			err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL
				AND workspace_item_visible(hidden, workspace_id, $3))`, f.FileID, wsID, actorID).Scan(&found)
		case f.MaterialID != "" && f.FileID == "":
			err = tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM materials WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL AND parent_material_id IS NULL AND assignment_id IS NULL
				AND workspace_item_visible(hidden, workspace_id, $3))`, f.MaterialID, wsID, actorID).Scan(&found)
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
// due date, and a penalty only applies to marks or a grade (a graded quiz, or an
// Assignment with points) when late work is taken.
func checkLatePolicy(form AssignmentForm) error {
	switch form.LatePenaltyPct {
	case 0, 20, 50:
	default:
		return assignmentInput("a late penalty is none, 20% or 50%")
	}
	if !form.NoLate && form.LatePenaltyPct == 0 {
		return nil
	}
	// Either kind closes at its due date under NoLate; only marks take a penalty.
	if form.DueAt == nil {
		return assignmentInput("a late policy needs a due date")
	}
	if form.Kind != AssignmentMarked && form.Points == nil && form.LatePenaltyPct != 0 {
		return assignmentInput("an ungraded assignment has no mark to penalise")
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
// frozen, and holds the workspace row for the write.
func (s *Store) lockAssignmentStaffTx(ctx context.Context, tx pgx.Tx, wsID, actorID string) error {
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, actorID); err != nil {
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
func (s *Store) lockAssignmentPayerRowsTx(ctx context.Context, tx pgx.Tx, wsID, actorID string, payer *string, more ...string) error {
	ownerID, err := s.storageOwnerTx(ctx, tx, wsID)
	if err != nil {
		return err
	}
	ids := append([]string{actorID, ownerID}, more...)
	if payer != nil {
		ids = append(ids, *payer)
	}
	_, err = tx.Exec(ctx, `SELECT 1 FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE`, ids)
	return err
}

// materialHiddenSQL is whether a materials row m is kept from everyone who
// does not edit its workspace, the flag workspace_item_visible and the access
// checks take: hidden by its owner, or a graded quiz's own quiz, held for good
// (migration 0174, Epo 2026-11-14).
const materialHiddenSQL = `(m.hidden OR m.assignment_id IS NOT NULL)`

// CreateAssignment makes an unmarked assignment. A marked one (a graded quiz)
// owns its quiz and is made with it (makeGradedQuizTx, Epo 2026-11-16), never
// from a quiz that already exists. Only a class's staff make either.
func (s *Store) CreateAssignment(ctx context.Context, actorID, wsID string, form AssignmentForm, now time.Time) (Assignment, error) {
	if form.Kind == AssignmentMarked {
		return Assignment{}, assignmentInput("make a graded quiz with its questions")
	}
	var id string
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		id, err = s.createAssignmentTx(ctx, tx, actorID, wsID, form, now)
		return err
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// checkNewAssignmentTx admits the form for a new assignment in the write's
// transaction, holding the workspace for its staff (lockAssignmentStaffTx).
func (s *Store) checkNewAssignmentTx(ctx context.Context, tx pgx.Tx, actorID, wsID string, form AssignmentForm, now time.Time) error {
	if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
		return err
	}
	if err := checkAssignmentForm(ctx, tx, wsID, actorID, form); err != nil {
		return err
	}
	return assertAssignmentRoomTx(ctx, tx, wsID, true, !form.Draft, now)
}

// createAssignmentTx inserts a new assignment and publishes it unless it is a
// draft. A marked one takes form.QuizID, a quiz written in this transaction
// (makeGradedQuizTx), as its own (migration 0174): it lists nowhere and goes
// with the assignment.
func (s *Store) createAssignmentTx(ctx context.Context, tx pgx.Tx, actorID, wsID string, form AssignmentForm, now time.Time) (string, error) {
	if err := s.checkNewAssignmentTx(ctx, tx, actorID, wsID, form, now); err != nil {
		return "", err
	}
	id := uid("as")
	if _, err := tx.Exec(ctx, `INSERT INTO assignments (id, workspace_id, created_by, kind, title, source_quiz_id,
			due_at, time_limit_min, attempts_allowed, no_late, late_penalty_pct, assign_all, draft, marking, answers_shown, grades_shown, shuffle, allow_uploads, upload_only, posted_at, created_at, points, paper_file)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6::text,''),$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$18,$20,$17,$17,$19,$21)`,
		id, wsID, actorID, form.Kind, strings.TrimSpace(form.Title), form.QuizID,
		form.DueAt, form.TimeLimitMin, form.Attempts, form.NoLate, form.LatePenaltyPct, form.AssignAll,
		form.Marking, form.ShowAnswers, form.ShowGrades, form.Shuffle, now, form.AllowUploads, form.Points, form.UploadOnly, form.PaperFile); err != nil {
		return "", err
	}
	if err := writeAssignmentLists(ctx, tx, id, form); err != nil {
		return "", err
	}
	if form.Kind == AssignmentMarked && form.QuizID != "" {
		if _, err := tx.Exec(ctx, `UPDATE materials SET assignment_id=$1, hidden=true WHERE id=$2`, id, form.QuizID); err != nil {
			return "", err
		}
	}
	if form.Draft {
		return id, nil
	}
	return id, s.publishAssignmentTx(ctx, tx, id, wsID, actorID, form.Kind, form.Questions, now)
}

// checkGradedQuizForm: a graded quiz's form is marked, and its quiz is the one
// made with it.
func checkGradedQuizForm(form AssignmentForm) error {
	if form.Kind != AssignmentMarked {
		return assignmentInput("a graded quiz is marked")
	}
	if form.QuizID != "" {
		return assignmentInput("a graded quiz's quiz is made with it")
	}
	return nil
}

// CheckGradedQuiz admits a graded quiz's form before the work that makes its
// quiz starts (Generate, a Make a quiz run), as makeGradedQuizTx will, and
// writes nothing.
func (s *Store) CheckGradedQuiz(ctx context.Context, actorID, wsID string, form AssignmentForm, now time.Time) error {
	if err := checkGradedQuizForm(form); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	return s.checkNewAssignmentTx(ctx, tx, actorID, wsID, form, now)
}

// MakeFileGradedQuiz makes a graded quiz from a file of workspace wsID (Epo
// 2026-11-20): the file is its question paper, read live rather than copied,
// members answer by upload, and staff mark each hand-in out of marks by hand.
// Its frozen copy is one open part worth marks (paperQuestion), so attempts,
// marking, late penalties and released grades read as any graded quiz's. A
// draft holds the copy already, which Publish gives out as it is.
func (s *Store) MakeFileGradedQuiz(ctx context.Context, actorID, wsID, fileID string, form AssignmentForm, now time.Time) (Assignment, error) {
	if err := checkGradedQuizForm(form); err != nil {
		return Assignment{}, err
	}
	// The range is checkAssignmentForm's, in the transaction.
	if form.TotalMarks == nil {
		return Assignment{}, assignmentInput("give the total marks")
	}
	marks := *form.TotalMarks
	var name string
	if err := s.pool.QueryRow(ctx, `SELECT name FROM files WHERE id=$1`, fileID).Scan(&name); err != nil {
		if isNoRows(err) {
			return Assignment{}, ErrNotFound
		}
		return Assignment{}, err
	}
	form.PaperFile, form.AllowUploads, form.UploadOnly, form.Marking = true, true, true, MarkingManual
	form.Files = []AssignmentFileRef{{FileID: fileID}}
	form.Questions = []map[string]any{paperQuestion(name, marks)}
	var id string
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var err error
		if id, err = s.createAssignmentTx(ctx, tx, actorID, wsID, form, now); err != nil || !form.Draft {
			return err
		}
		frozen, err := json.Marshal(form.Questions)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE assignments SET questions=$2, question_count=1, total_marks=$3 WHERE id=$1`, id, frozen, marks)
		return err
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// paperQuestion is a file's graded quiz's frozen copy: one question with no
// words and one open part worth the quiz's marks, the whole hand-in, whose one
// marking point is the file's name, so staff type one mark as for any open part.
func paperQuestion(name string, marks int) map[string]any {
	return map[string]any{
		"id": uid("q"), "stem": []any{}, "layout": "paper", "labels": "letters",
		"parts": []any{map[string]any{
			"id": uid("p"), "blocks": []any{}, "answer": map[string]any{"type": "open", "accepted": []any{}},
			"marks": float64(marks), "solution": []any{},
			"markscheme": []any{map[string]any{"text": truncateRunes(name, fieldlimits.QuestionMarkItem), "marks": float64(marks)}},
		}},
	}
}

// makeGradedQuizTx makes the graded quiz (mt.GradedQuiz) that owns mt, a
// workspace quiz written in this transaction with its images (Epo
// 2026-11-16: the dialog sends the settings and the questions together). A
// published one freezes the questions as stored. Nothing to make without a form.
func (s *Store) makeGradedQuizTx(ctx context.Context, tx pgx.Tx, mt Material, now time.Time) (string, error) {
	if mt.GradedQuiz == nil {
		return "", nil
	}
	form := *mt.GradedQuiz
	if err := checkGradedQuizForm(form); err != nil {
		return "", err
	}
	if mt.Kind != MaterialQuiz || mt.WorkspaceID == "" || mt.ParentMaterialID != "" {
		return "", fmt.Errorf("%w: only a workspace quiz is made for a graded quiz", materialdoc.ErrInvalid)
	}
	form.QuizID = mt.ID
	if !form.Draft {
		var content string
		if err := tx.QueryRow(ctx, `SELECT content FROM materials WHERE id=$1`, mt.ID).Scan(&content); err != nil {
			return "", err
		}
		raw, _, err := materialdoc.ExtractQuiz(content)
		if err != nil {
			return "", err
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &form.Questions); err != nil {
				return "", err
			}
		}
	}
	return s.createAssignmentTx(ctx, tx, mt.CreatedBy, mt.WorkspaceID, form, now)
}

// writeAssignees replaces its named assignees.
func writeAssignees(ctx context.Context, tx pgx.Tx, id string, form AssignmentForm) error {
	if _, err := tx.Exec(ctx, `DELETE FROM assignment_assignees WHERE assignment_id=$1`, id); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO assignment_assignees (assignment_id, user_id)
		SELECT $1::text, unnest($2::text[])`, id, uniqueStrings(form.Assignees))
	return err
}

// writeAssignmentLists replaces its named assignees and files.
func writeAssignmentLists(ctx context.Context, tx pgx.Tx, id string, form AssignmentForm) error {
	if err := writeAssignees(ctx, tx, id, form); err != nil {
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
// An assignment's are its class's images, and so are its copies.
func (s *Store) copyFrozenAssetsTx(ctx context.Context, tx pgx.Tx, assignmentID, wsID, actorID string, ids []string, now time.Time) (map[string]string, error) {
	idMap := map[string]string{}
	if len(ids) == 0 {
		return idMap, nil
	}
	rows, err := tx.Query(ctx, `SELECT s.id, s.object_path, s.size_bytes, h.id FROM editor_assets s
		LEFT JOIN LATERAL (SELECT x.id FROM editor_assets x WHERE x.assignment_id=$3 AND x.object_path=s.object_path
			AND x.status='ready' AND x.trashed_at IS NULL LIMIT 1) h ON true
		WHERE s.id = ANY($1) AND s.workspace_id=$2 AND s.status='ready' AND s.trashed_at IS NULL FOR SHARE OF s`, uniqueStrings(ids), wsID, assignmentID)
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
			SELECT $1::text, $6::text, NULL::text, $5::text, $2::text, $2::text, name, purpose, object_path, content_type, size_bytes,
				'ready', etag, $3::timestamptz, $3::timestamptz, thumbnail_key
			FROM editor_assets WHERE id=$4`, newID, actorID, now, oldID, assignmentID, wsID); err != nil {
			return nil, err
		}
	}
	return idMap, nil
}

// UpdateAssignment saves the form's settings; the kind, the quiz and a published
// assignment's frozen copy stay. A running attempt keeps its deadline.
func (s *Store) UpdateAssignment(ctx context.Context, actorID, id string, form AssignmentForm, now time.Time) (Assignment, error) {
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		var kind string
		var draft, paperFile bool
		var quizID *string
		if err := tx.QueryRow(ctx, `SELECT kind, draft, source_quiz_id, paper_file FROM assignments WHERE id=$1 FOR UPDATE`, id).Scan(&kind, &draft, &quizID, &paperFile); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		form.Kind, form.Draft, form.QuizID, form.PaperFile = kind, draft, "", paperFile
		// A file's graded quiz keeps its file, its upload and its hand marking.
		if paperFile {
			form.Files, form.AllowUploads, form.UploadOnly, form.Marking = nil, true, true, MarkingManual
		}
		if quizID != nil {
			form.QuizID = *quizID
		}
		if err := checkAssignmentForm(ctx, tx, wsID, actorID, form); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE assignments SET title=$2, due_at=$3, time_limit_min=$4, attempts_allowed=$5,
				no_late=$6, late_penalty_pct=$7, assign_all=$8, marking=$9, answers_shown=$10, grades_shown=$11, shuffle=$12, allow_uploads=$13, points=$14, upload_only=$15 WHERE id=$1`,
			id, strings.TrimSpace(form.Title), form.DueAt, form.TimeLimitMin, form.Attempts,
			form.NoLate, form.LatePenaltyPct, form.AssignAll, form.Marking, form.ShowAnswers, form.ShowGrades, form.Shuffle, form.AllowUploads, form.Points, form.UploadOnly); err != nil {
			return err
		}
		if form.Marking == MarkingManual {
			if err := dropAssignmentDrawingImagesTx(ctx, tx, id); err != nil {
				return err
			}
		}
		if paperFile {
			if err := setPaperMarksTx(ctx, tx, id, *form.TotalMarks); err != nil {
				return err
			}
			return writeAssignees(ctx, tx, id, form)
		}
		return writeAssignmentLists(ctx, tx, id, form)
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// setPaperMarksTx changes a file's graded quiz's total (Epo 2026-11-20): the
// marks given stay as they are, out of the new total, as Canvas and Google
// Classroom keep them; staff change them by hand. A total below a mark given
// is refused. The caller holds the assignment's row.
func setPaperMarksTx(ctx context.Context, tx pgx.Tx, id string, marks int) error {
	var total, highest float64
	if err := tx.QueryRow(ctx, `SELECT a.total_marks::float8, COALESCE((SELECT max(t.correct) FROM attempts t
			WHERE t.assignment_id=a.id AND t.submitted_at IS NOT NULL), 0)::float8
		FROM assignments a WHERE a.id=$1`, id).Scan(&total, &highest); err != nil {
		return err
	}
	if total == float64(marks) {
		return nil
	}
	if highest > float64(marks) {
		return ErrPaperTotalBelowMark
	}
	return rewritePaperTx(ctx, tx, id, func(part, item map[string]any) {
		part["marks"], item["marks"] = float64(marks), float64(marks)
	})
}

// ChangePaperFile points a file's graded quiz at another file of its
// workspace (Epo 2026-11-20, "Change file", as Gradescope replaces a template
// PDF): answers and marks stay, and those who started read the new file from
// their next open (paperReaderSQL follows the row). A file gone from it is
// chosen again the same way.
func (s *Store) ChangePaperFile(ctx context.Context, actorID, id, fileID string, now time.Time) (Assignment, error) {
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		var paperFile bool
		if err := tx.QueryRow(ctx, `SELECT paper_file FROM assignments WHERE id=$1 FOR UPDATE`, id).Scan(&paperFile); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		if !paperFile {
			return assignmentInput("only a graded quiz from a file has a question paper")
		}
		var name string
		err = tx.QueryRow(ctx, `SELECT name FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL
			AND workspace_item_visible(hidden, workspace_id, $3)`, fileID, wsID, actorID).Scan(&name)
		if isNoRows(err) {
			return assignmentInput("a file is not in this workspace")
		}
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM assignment_files WHERE assignment_id=$1`, id); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO assignment_files (assignment_id, file_id, position) VALUES ($1, $2, 0)`, id, fileID); err != nil {
			return err
		}
		return rewritePaperTx(ctx, tx, id, func(_, item map[string]any) {
			item["text"] = truncateRunes(name, fieldlimits.QuestionMarkItem)
		})
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// rewritePaperTx edits the one part of a file's graded quiz (paperQuestion)
// and its one marking point, in its stored copy and in each submission's
// graded copy, whose totals follow; a running attempt holds only its total.
// The stored copy's bytes are charged again to whoever froze it: a total's
// digits or a file's name move it by a few bytes, so no limit is checked.
func rewritePaperTx(ctx context.Context, tx pgx.Tx, id string, edit func(part, item map[string]any)) error {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT questions FROM assignments WHERE id=$1`, id).Scan(&raw); err != nil {
		return err
	}
	qs, err := decodeFrozen(raw)
	if err != nil {
		return err
	}
	if err := editPaperPart(qs, edit); err != nil {
		return err
	}
	_, marks := questionMarks(qs[0])
	frozen, err := json.Marshal(qs)
	if err != nil {
		return err
	}
	size, err := storageJSONSizeTx(ctx, tx, string(frozen))
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE assignments SET questions=$2, total_marks=$3,
		frozen_bytes=CASE WHEN frozen_by IS NULL THEN frozen_bytes ELSE $4 END WHERE id=$1`, id, frozen, marks, size); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE attempts SET total=$2 WHERE assignment_id=$1 AND submitted_at IS NULL`, id, marks); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id, questions FROM attempts WHERE assignment_id=$1 AND submitted_at IS NOT NULL FOR UPDATE`, id)
	if err != nil {
		return err
	}
	graded := map[string][]byte{}
	for rows.Next() {
		var attempt string
		var stored []byte
		if err := rows.Scan(&attempt, &stored); err != nil {
			rows.Close()
			return err
		}
		graded[attempt] = stored
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for attempt, stored := range graded {
		qs, err := decodeFrozen(stored)
		if err != nil {
			return err
		}
		if err := editPaperPart(qs, edit); err != nil {
			return err
		}
		correct, total, waitingMarks, waitingAnswers := attemptTotals(qs)
		pct := 0
		if total > 0 {
			pct = int(correct / total * 100)
		}
		next, err := json.Marshal(qs)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE attempts SET questions=$2, correct=$3, total=$4, pct=$5, waiting_marks=$6, waiting_answers=$7 WHERE id=$1`,
			attempt, next, correct, total, pct, waitingMarks, waitingAnswers); err != nil {
			return err
		}
	}
	return nil
}

// editPaperPart hands edit the copy's one part and its one marking point.
func editPaperPart(qs []map[string]any, edit func(part, item map[string]any)) error {
	if len(qs) == 1 {
		parts, _ := qs[0]["parts"].([]any)
		if len(parts) == 1 {
			part, _ := parts[0].(map[string]any)
			items, _ := part["markscheme"].([]any)
			if len(items) == 1 {
				if item, ok := items[0].(map[string]any); ok {
					edit(part, item)
					return nil
				}
			}
		}
	}
	return errors.New("a file's graded quiz has one part with one marking point")
}

// PublishAssignment gives a draft to its members. questions is its quiz's
// current content, or nil when the quiz is gone.
func (s *Store) PublishAssignment(ctx context.Context, actorID, id string, qs []map[string]any, now time.Time) (Assignment, error) {
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
	if err != nil {
		return Assignment{}, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		var kind string
		var draft, paperFile bool
		var due *time.Time
		var stored []byte
		if err := tx.QueryRow(ctx, `SELECT kind, draft, due_at, paper_file, questions FROM assignments WHERE id=$1 FOR UPDATE`, id).Scan(&kind, &draft, &due, &paperFile, &stored); err != nil {
			if isNoRows(err) {
				return ErrNotFound
			}
			return err
		}
		if !draft {
			return nil
		}
		// A file's draft holds its copy (MakeFileGradedQuiz); it has no quiz.
		if paperFile {
			var err error
			if qs, err = decodeFrozen(stored); err != nil {
				return err
			}
		}
		if kind == AssignmentMarked && due == nil {
			return assignmentInput("choose a due date")
		}
		if kind == AssignmentMarked && qs == nil {
			return ErrAssignmentQuizGone
		}
		// A class has room for so many open.
		if err := assertAssignmentRoomTx(ctx, tx, wsID, false, true, now); err != nil {
			return err
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
// longer mean what the member chose in the new copy, and moves each drawing to
// the part its canvas's drawing is stored under now, or drops it when no part
// answers in that canvas any more (moveDrawingsTx). Every writer of an attempt
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
	targets := drawingTargets(before, after)
	for attempt, raw := range saved {
		var answers map[string]any
		if err := json.Unmarshal(raw, &answers); err != nil {
			return err
		}
		kept := make(map[string]any, len(answers))
		for part, value := range answers {
			// A canvas answer is the drawing stored for it, which follows its
			// canvas (Epo 2026-11-24): named again below.
			if isDrawingAnswer(value) || was[part]["type"] == "canvas" {
				continue
			}
			if a, b := was[part], now[part]; a != nil && b != nil && stillAnswers(a, b, value) {
				kept[part] = value
			}
		}
		held, err := moveDrawingsTx(ctx, tx, attempt, targets)
		if err != nil {
			return err
		}
		kept = withDrawingAnswers(kept, held)
		if reflect.DeepEqual(kept, answers) {
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

// SetAssignmentClosed closes it by hand, stopping late submissions, or reopens
// it; a graded quiz's quiz stays held either way (Epo 2026-11-14). A running attempt goes on for the grace, for its
// page to send what it holds (the caller tells it, Epo 2026-11-05); past that the
// sweep or the member's next request submits what was saved.
func (s *Store) SetAssignmentClosed(ctx context.Context, actorID, id string, closed bool, now time.Time) (Assignment, error) {
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
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
			// Reopening a closed one takes a place among the open ones.
			var wasClosed bool
			if err := tx.QueryRow(ctx, `SELECT closed_at IS NOT NULL FROM assignments WHERE id=$1 AND NOT draft FOR UPDATE`, id).Scan(&wasClosed); err != nil && !isNoRows(err) {
				return err
			}
			if wasClosed {
				if err := assertAssignmentRoomTx(ctx, tx, wsID, false, true, now); err != nil {
					return err
				}
			}
		}
		_, err := tx.Exec(ctx, `UPDATE assignments SET closed_at=$2 WHERE id=$1 AND NOT draft`, id, at)
		return err
	})
	if err != nil {
		return Assignment{}, err
	}
	return s.GetAssignment(ctx, actorID, id, now)
}

// ReleaseAssignmentGrades shows members their grades on an assignment whose
// Show grades is manual (Epo 2026-11-08, mock T5). Marks decided later show as
// they land. Once it has also closed, the sweep rates what was submitted,
// unless its answers are Do not show (releaseAssignment).
func (s *Store) ReleaseAssignmentGrades(ctx context.Context, actorID, id string, now time.Time) (Assignment, []Notification, error) {
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
	if err != nil {
		return Assignment{}, nil, err
	}
	var sent []Notification
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentStaffTx(ctx, tx, wsID, actorID); err != nil {
			return err
		}
		var title string
		err := tx.QueryRow(ctx, `UPDATE assignments SET grades_released_at=$2
			WHERE id=$1 AND NOT draft AND grades_shown='manual' AND grades_released_at IS NULL
			RETURNING title`, id, now).Scan(&title)
		if isNoRows(err) {
			return nil
		}
		if err != nil {
			return err
		}
		// The bell tells each member who handed something in (T, Epo 2026-11-08),
		// and on a graded Assignment each one graded.
		rows, err := tx.Query(ctx, `SELECT user_id FROM attempts WHERE assignment_id=$1 AND submitted_at IS NOT NULL
			UNION SELECT user_id FROM assignment_grades WHERE assignment_id=$1`, id)
		if err != nil {
			return err
		}
		members, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		data, err := json.Marshal(map[string]string{"code": "grades_released", "assignmentId": id, "title": title})
		if err != nil {
			return err
		}
		href := "/workspaces/" + wsID + "/assignments?assignment=" + id
		for _, member := range members {
			n, err := CreateNotificationTx(ctx, tx, NotificationParams{
				UserID: member, Kind: NotifSystem, Data: data, Href: href, WorkspaceID: wsID, At: now,
			})
			if err != nil {
				return err
			}
			sent = append(sent, n)
		}
		return nil
	})
	if err != nil {
		return Assignment{}, nil, err
	}
	a, err := s.GetAssignment(ctx, actorID, id, now)
	return a, sent, err
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
// which leave their payer's meter (a trigger's); its own quiz goes with it.
func (s *Store) DeleteAssignment(ctx context.Context, actorID, id string) error {
	wsID, payer, err := s.assignmentPayer(ctx, id)
	if err != nil {
		return err
	}
	// Its own quiz goes with it (the foreign key), so whoever pays for the quiz
	// is held too. Set at creation, the unlocked read is stable.
	var quizOwners []string
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(array_agg(owner_user_id), '{}') FROM materials WHERE assignment_id=$1`, id).
		Scan(&quizOwners); err != nil {
		return err
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := s.lockAssignmentPayerRowsTx(ctx, tx, wsID, actorID, payer, quizOwners...); err != nil {
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
		// The counters before the rows, in id order, as reconciliation takes them.
		counters := quizOwners
		if payer != nil {
			counters = append(counters, *payer)
		}
		counters = uniqueStrings(counters)
		slices.Sort(counters)
		for _, userID := range counters {
			if err := s.lockStorageRowTx(ctx, tx, userID); err != nil {
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
	// Not a class, no way in, or its owner's account is locked: nothing is ticked.
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
	return s.inTx(ctx, func(tx pgx.Tx) error {
		// One that takes files is Hand in and Undo hand in (S3).
		_, uploads, err := lockHandInTx(ctx, tx, id)
		if err != nil {
			return err
		}
		// Closed, by hand or at its due date under NoLate, it takes no change,
		// as a marked one takes no submission.
		var closed bool
		if err := tx.QueryRow(ctx, `SELECT closed_at IS NOT NULL OR (no_late AND due_at <= $2) FROM assignments WHERE id=$1`,
			id, now).Scan(&closed); err != nil {
			return err
		}
		if closed {
			return ErrAssignmentClosed
		}
		if uploads {
			if err := s.setHandedInTx(ctx, tx, id, userID, done); err != nil || !done {
				return err
			}
		} else if !done {
			// Work handed in stays handed in after uploads are turned off.
			var files bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE hand_in_assignment_id=$1 AND user_id=$2)`,
				id, userID).Scan(&files); err != nil {
				return err
			}
			if files {
				return ErrHandInFinal
			}
			_, err = tx.Exec(ctx, `DELETE FROM assignment_done WHERE assignment_id=$1 AND user_id=$2`, id, userID)
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO assignment_done (assignment_id, user_id, done_at) VALUES ($1,$2,$3)
			ON CONFLICT (assignment_id, user_id) DO NOTHING`, id, userID, now)
		return err
	})
}

/* ---------------------------------------------------------------- attempts */

// AssignmentAttempt is a member's try: running, its answer-free questions and
// what they saved, with the server's clock; submitted, its graded copy. A
// member's own results lose the keys when the owner turned Show answers off.
type AssignmentAttempt struct {
	ID           string `json:"id"`
	AssignmentID string `json:"assignmentId"`
	// WorkspaceID: the attempt's page stands outside its workspace
	// (/attempts/{id}, Epo 2026-11-25) and still saves within it.
	WorkspaceID   string     `json:"workspaceId"`
	UserID        string     `json:"userId"`
	UserName      string     `json:"userName"`
	UserAvatarURL string     `json:"userAvatarUrl,omitempty"`
	Title         string     `json:"title"`
	Status        string     `json:"status" enum:"running,submitted"`
	StartedAt     *time.Time `json:"startedAt,omitempty"`
	// DeadlineAt is when the time runs out; Now is the server's clock, which
	// the page's timer counts against.
	DeadlineAt *time.Time `json:"deadlineAt,omitempty"`
	// ClosesAt is a No late submissions due date, which ends it as its time
	// running out does; the page shows it in its last hour (Epo 2026-11-08).
	ClosesAt      *time.Time `json:"closesAt,omitempty"`
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
	ShowAnswers bool `json:"showAnswers"`
	// GradesHidden: the grades wait for release, or (to a member) an answer
	// still waits for the AI or staff (Epo 2026-11-25), so the view holds the
	// answers given and the questions without marks, comments or keys.
	GradesHidden bool `json:"gradesHidden"`
	// DrawingImages: Done sends a drawing's marking image, which manual grading
	// never reads, so the browser makes none then (Q693).
	DrawingImages bool             `json:"drawingImages"`
	Answers       map[string]any   `json:"answers" nullable:"false"`
	Questions     []map[string]any `json:"questions" nullable:"false"`
	// RemovedAssetIDs are the running attempt's images no longer there.
	RemovedAssetIDs []string `json:"removedAssetIds" nullable:"false"`
	// Paper: answered on paper ("upload", "reading" or "read"), with its
	// files in order; "" when answered in the app.
	Paper      string      `json:"paper,omitempty" enum:"upload,reading,read"`
	PaperFiles []PaperFile `json:"paperFiles" nullable:"false"`
	// NeedsMarking: the submit that returned this handed it in with answers
	// for the AI or a paper to read, whatever the member's view shows.
	NeedsMarking bool `json:"-"`
	// Marking: a marking run holds it now, and each part it holds carries
	// "marking" (Q729). The gateway fills both from its runs, in memory; under
	// Show grades Manual they still show, telling nothing of the marks.
	Marking bool `json:"marking,omitempty"`
}

// PaperFile is one file of an attempt's paper: the member's own upload.
type PaperFile struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	SizeBytes int64  `json:"sizeBytes"`
	// Status is its ingest's: marking waits for it to settle.
	Status string `json:"status"`
	// Revision names its bytes for its marks (PDFAnnotationList.SourceIdentity).
	Revision int64 `json:"revision"`
	// Marked: staff marked it (pdf_annotations), Feedback given on it (Epo
	// 2026-11-25, S1). Its member reads it only once they see the grade.
	Marked bool `json:"marked"`
}

// paperFileMarkedSQL is whether staff marked the file f.
const paperFileMarkedSQL = `EXISTS (SELECT 1 FROM pdf_annotations p WHERE p.file_id=f.id)`

// withoutMarked hides that staff marked a member's files until they see the
// grade, as the marks themselves are (submissionMarkAccess).
func withoutMarked(files []PaperFile) {
	for i := range files {
		files[i].Marked = false
	}
}

// paperFiles are an attempt's paper files in order.
func paperFiles(ctx context.Context, q rowsQueryer, attemptID string) ([]PaperFile, error) {
	rows, err := q.Query(ctx, `SELECT f.id, f.name, f.kind, f.size_bytes, f.status, f.revision, `+paperFileMarkedSQL+` FROM files f
		WHERE f.attempt_id=$1 ORDER BY f.submission_position, f.id`, attemptID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PaperFile{}
	for rows.Next() {
		var f PaperFile
		if err := rows.Scan(&f.ID, &f.Name, &f.Kind, &f.SizeBytes, &f.Status, &f.Revision, &f.Marked); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// attemptRow is an assignment attempt with its assignment's rules.
type attemptRow struct {
	id, assignmentID, userID, wsID, sourceID string
	startedAt, deadline, submitted, dueAt    *time.Time
	closedAt, released                       *time.Time
	noLate, auto, shuffle                    bool
	showAnswers, showGrades                  string
	gradesReleased                           *time.Time
	latePenaltyPct                           int
	correct, total, waitingMarks             float64
	waitingAnswers                           int
	answers, graded, frozen                  []byte
	// paper is PaperUpload, PaperReading or PaperRead, or "" in the app.
	paper string
	// marking is the assignment's (MarkingAIApprove, MarkingAI or MarkingManual).
	marking string
}

// quiz is the attempt's quiz for its answer events and ratings, in its class.
func (r attemptRow) quiz() Material {
	return Material{ID: r.sourceID, WorkspaceID: r.wsID}
}

const attemptRowCols = `t.id, t.assignment_id, t.user_id, a.workspace_id, COALESCE(a.source_quiz_id,''),
	t.started_at, t.deadline_at, t.submitted_at, a.due_at, a.closed_at, a.released_at,
	a.no_late, a.late_penalty_pct, t.auto_submitted, a.answers_shown, a.grades_shown, a.grades_released_at, a.shuffle, t.correct::float8, t.total::float8, t.waiting_marks::float8, t.waiting_answers,
	t.answers, t.questions, a.questions, COALESCE(t.paper, ''), a.marking`

func scanAttemptRow(row pgx.Row) (attemptRow, error) {
	var r attemptRow
	err := row.Scan(&r.id, &r.assignmentID, &r.userID, &r.wsID, &r.sourceID,
		&r.startedAt, &r.deadline, &r.submitted, &r.dueAt, &r.closedAt, &r.released,
		&r.noLate, &r.latePenaltyPct, &r.auto, &r.showAnswers, &r.showGrades, &r.gradesReleased, &r.shuffle, &r.correct, &r.total, &r.waitingMarks, &r.waitingAnswers,
		&r.answers, &r.graded, &r.frozen, &r.paper, &r.marking)
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
// time limit starts the clock here, on the server. upload starts one answered
// on paper (Upload file in Before you start), which the assignment must allow;
// storage never refuses it, as submissions are charged to no one.
func (s *Store) StartAssignment(ctx context.Context, userID, id string, upload bool, now time.Time) (AssignmentAttempt, error) {
	var attemptID, handedIn string
	var view AssignmentAttempt
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
	if err != nil {
		return view, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		handedIn = ""
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
		var draft, noLate, allowUploads, uploadOnly bool
		var due, closedAt *time.Time
		var limit, allowed int
		var hasLimit *int
		var total float64
		err := tx.QueryRow(ctx, `SELECT a.kind, a.title, w.name, a.draft, a.no_late, a.due_at, a.closed_at, a.time_limit_min, a.attempts_allowed, a.total_marks::float8, a.allow_uploads, a.upload_only
			FROM assignments a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=$1 FOR SHARE OF a`, id).
			Scan(&kind, &title, &wsName, &draft, &noLate, &due, &closedAt, &hasLimit, &allowed, &total, &allowUploads, &uploadOnly)
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
			if running.paper == PaperUpload {
				handedIn = running.id
			}
		} else if !errors.Is(err, ErrNotFound) {
			return err
		}
		if assignmentClosedAt(noLate, due, closedAt, now) != nil {
			return ErrAssignmentClosed
		}
		var paper *string
		if uploadOnly && !upload {
			return assignmentInput("this assignment takes uploads only")
		}
		if upload && !allowUploads {
			return assignmentInput("this assignment takes answers in the app only")
		}
		// The first start picks the way for good (Epo 2026-11-25): attempts are
		// for answers in the app, and a paper is handed in once whatever they
		// say, charged to no one, so a full account still hands one in.
		var online int
		var papers bool
		if err := tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE paper IS NULL), COALESCE(bool_or(paper IS NOT NULL), false)
				FROM attempts WHERE assignment_id=$1 AND user_id=$2 AND submitted_at IS NOT NULL`, id, userID).Scan(&online, &papers); err != nil {
			return err
		}
		switch {
		case papers:
			return ErrPaperHandedIn
		case upload && online > 0:
			return ErrAnsweredOnline
		case !upload && online >= allowed:
			return ErrAssignmentNoAttempts
		}
		if upload {
			paper = new(string)
			*paper = PaperUpload
		}
		attemptID = uid("at")
		var deadline *time.Time
		if limit > 0 {
			at := now.Add(time.Duration(limit) * time.Minute)
			deadline = &at
		}
		_, err = tx.Exec(ctx, `INSERT INTO attempts (id, user_id, workspace_id, kind, assignment_id, quiz_name, workspace_name,
				total, started_at, taken_at, deadline_at, paper)
			VALUES ($1,$2,$3,'assignment',$4,$5,$6,$7,$8,$8,$9,$10)`,
			attemptID, userID, wsID, id, title, truncateRunes(wsName, 80), total, now, deadline, paper)
		return err
	})
	if err != nil {
		return view, err
	}
	if handedIn != "" {
		s.paperSubmitted(id, handedIn)
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

// An attempt answered on paper (migration 0161): PaperUpload while it runs,
// PaperReading once submitted until its pages are read, then PaperRead.
const (
	PaperUpload  = "upload"
	PaperReading = "reading"
	PaperRead    = "read"
)

// How an assignment's AI-marked parts are marked (migration 0157).
const (
	MarkingAIApprove = "ai_approve"
	MarkingAI        = "ai"
	MarkingManual    = "manual"
)

// When members read an assignment's keys, marking points and solutions on their
// results (migration 0159): marks show on submit whichever it is.
const (
	AnswersAfterClose  = "closed"
	AnswersAfterSubmit = "submitted"
	AnswersNever       = "never"
)

// When members see their grades (migration 0160).
const (
	GradesAutomatic = "automatic"
	GradesManual    = "manual"
)

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
		drawings, err := attemptDrawingsTx(ctx, tx, attemptID)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(withDrawingAnswers(answers, drawings))
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
// NeedsMarking reads the attempt as stored, not the member's view, which
// shows no waiting answers while grades wait for release.
func (s *Store) SubmitAssignmentAttempt(ctx context.Context, userID, attemptID string, answers map[string]any, now time.Time) (AssignmentAttempt, error) {
	if err := checkAssignmentAnswers(answers); err != nil {
		return AssignmentAttempt{}, err
	}
	needsMarking := false
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		needsMarking = false
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
		sent, auto := answers, false
		if r.expired(now) {
			sent, auto = nil, r.timedOut(now)
		}
		if err := s.finishAttemptTx(ctx, tx, r, sent, auto, now); err != nil {
			return err
		}
		// A paper is read under every marking (Q716); typed answers go to the AI
		// unless staff mark by hand.
		return tx.QueryRow(ctx, `SELECT COALESCE(paper, '') = 'reading' OR (waiting_answers > 0 AND $2 <> 'manual')
			FROM attempts WHERE id=$1`, r.id, r.marking).Scan(&needsMarking)
	})
	if err != nil {
		return AssignmentAttempt{}, err
	}
	out, err := s.GetAssignmentAttempt(ctx, userID, attemptID, now)
	out.NeedsMarking = needsMarking
	return out, err
}

// finishAttemptTx grades a running attempt: closed parts here, with today's
// deterministic scoring; an answered open part waits ("Not marked") for the
// owner, and no model is called. answers nil means what was saved. It logs the
// decided parts and, once the assignment is released, rates them.
func (s *Store) finishAttemptTx(ctx context.Context, tx pgx.Tx, r attemptRow, answers map[string]any, auto bool, now time.Time) error {
	if r.paper == PaperUpload {
		return s.handInPaperTx(ctx, tx, r, auto, now)
	}
	if answers == nil {
		answers = map[string]any{}
		if len(r.answers) > 0 {
			if err := json.Unmarshal(r.answers, &answers); err != nil {
				return err
			}
		}
	}
	// A drawing part's answer is the drawing stored for it, whatever was sent.
	drawings, err := attemptDrawingsTx(ctx, tx, r.id)
	if err != nil {
		return err
	}
	answers = withDrawingAnswers(answers, drawings)
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
	mt := r.quiz()
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
			// A canvas part's answer is its stored drawing (withDrawingAnswers).
			if a["type"] == "canvas" && !isDrawingAnswer(value) {
				continue
			}
			given[id] = value
		}
		out, _, _ := questions.Graded(q, given, nil)
		// A part answered in the canvas above waits on its drawing part's drawing.
		owners := questions.DrawingParts(q)
		list, _ := out["parts"].([]any)
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			a, _ := p["answer"].(map[string]any)
			id, _ := p["id"].(string)
			if owner, ok := owners[id]; ok {
				id = owner
			}
			if questions.ModelMarked(a["type"]) && given[id] != nil {
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
// the assignment is released (§11.6: marked-assignment questions join reviews
// once the assignment closes, unless its answers are Do not show). A question
// no longer in the quiz is not rated.
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

// questionAIMarked: every open part waiting in q holds the AI's mark.
func questionAIMarked(q map[string]any) bool {
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		if pending, _ := p["pending"].(bool); pending {
			if _, marked := p["aiAwards"]; !marked {
				return false
			}
		}
	}
	return true
}

// questionAIAwarded is what q's parts hold counting the AI's waiting marks.
func questionAIAwarded(q map[string]any) float64 {
	var total float64
	parts, _ := q["parts"].([]any)
	for _, raw := range parts {
		p, _ := raw.(map[string]any)
		if items, marked := aiAwards(p); marked {
			for _, item := range items {
				total += item
			}
		} else if awarded, ok := p["awarded"].(float64); ok {
			total += awarded
		}
	}
	return total
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
	err := tx.QueryRow(ctx, `SELECT a.workspace_id FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.id=$1`, attemptID).Scan(&wsID)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return lockWorkspaceKeyShareTx(ctx, tx, wsID)
}

// finishAttemptIfRunning submits what was saved, if nothing beat it to it. A
// paper it hands in starts its read (OnPaperHandedIn).
func (s *Store) finishAttemptIfRunning(ctx context.Context, attemptID string, now time.Time) error {
	handedIn := ""
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		handedIn = ""
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
		if r.paper == PaperUpload {
			handedIn = r.assignmentID
		}
		return s.finishAttemptTx(ctx, tx, r, nil, r.timedOut(now), now)
	})
	if err == nil && handedIn != "" {
		s.paperSubmitted(handedIn, attemptID)
	}
	return err
}

// attemptView renders an attempt for its caller.
func (s *Store) attemptView(ctx context.Context, r attemptRow, staff bool, now time.Time) (AssignmentAttempt, error) {
	v := AssignmentAttempt{
		ID: r.id, AssignmentID: r.assignmentID, WorkspaceID: r.wsID, UserID: r.userID, StartedAt: r.startedAt, DeadlineAt: r.deadline, Now: now,
		ClosesAt:    noLateDue(r.noLate, r.dueAt),
		SubmittedAt: r.submitted, AutoSubmitted: r.auto, Correct: r.correct, Total: r.total,
		WaitingMarks: r.waitingMarks, WaitingAnswers: r.waitingAnswers,
		Answers: map[string]any{}, Questions: []map[string]any{}, RemovedAssetIDs: []string{},
		Paper: r.paper, PaperFiles: []PaperFile{},
	}
	if r.paper != "" {
		files, err := paperFiles(ctx, s.pool, r.id)
		if err != nil {
			return v, err
		}
		v.PaperFiles = files
	}
	if err := s.pool.QueryRow(ctx, `SELECT a.title, COALESCE(NULLIF(u.name,''), u.id, ''),
			COALESCE('/icons/' || NULLIF(u.avatar_icon_id,'') || '.svg', u.avatar_url, ''), a.marking <> 'manual'
		FROM assignments a LEFT JOIN users u ON u.id=$2 WHERE a.id=$1`, r.assignmentID, r.userID).
		Scan(&v.Title, &v.UserName, &v.UserAvatarURL, &v.DrawingImages); err != nil {
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
		// Seeded by the attempt, so every load (and its paper) shows a
		// shuffled part's options in one order with the same letters.
		v.Questions = questions.LearnerViewsSeeded(frozen, r.id)
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
	closed := assignmentClosedAt(r.noLate, r.dueAt, r.closedAt, now) != nil
	graded, err := decodeFrozen(r.graded)
	if err != nil {
		return v, err
	}
	// Staff's marks in its files show with the grade (S1).
	if !staff && (gradesHidden(r.showGrades, r.gradesReleased) || r.waitingAnswers > 0) {
		withoutMarked(v.PaperFiles)
	}
	// A member sees no mark so far (Epo 2026-11-25): while any answer waits
	// for the AI or staff the attempt reads as if unreleased.
	if !staff && (gradesHidden(r.showGrades, r.gradesReleased) || r.waitingAnswers > 0) {
		v.GradesHidden = true
		v.Correct, v.Mark, v.Total, v.WaitingMarks, v.WaitingAnswers, v.LatePenaltyPct = 0, 0, 0, 0, 0, 0
		v.Questions = questions.LearnerViewsSeeded(graded, r.id)
		return v, nil
	}
	// Answers never show before grades.
	v.ShowAnswers = staff || r.showAnswers == AnswersAfterSubmit || (r.showAnswers == AnswersAfterClose && closed)
	if err := s.nameCommenters(ctx, graded); err != nil {
		return v, err
	}
	if !staff {
		withoutAIMarks(graded)
	}
	if v.ShowAnswers {
		withShownOrders(graded, r.id)
	} else {
		graded = gradedWithoutKeys(graded, closed, r.id)
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
// the learner's question with each part's marks and the owner's comment. The AI's
// warning could quote the marking scheme, so it waits until the assignment has
// closed (Epo 2026-11-05): nothing can be resubmitted then. Reopening hides it
// again.
func gradedWithoutKeys(graded []map[string]any, closed bool, seed string) []map[string]any {
	out := make([]map[string]any, len(graded))
	views := questions.LearnerViewsSeeded(graded, seed)
	for i, q := range graded {
		view := views[i]
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
			if closed {
				for _, key := range []string{"aiComment", "aiFlag"} {
					if value, ok := source[key]; ok {
						p[key] = value
					}
				}
			}
		}
		out[i] = view
	}
	return out
}

// withShownOrders gives each shuffled mcq in a graded attempt the order its
// member was shown (the attempt's seeded learner view), so a review with the
// answers reads the options and letters as answered.
func withShownOrders(graded []map[string]any, seed string) {
	for i, view := range questions.LearnerViewsSeeded(graded, seed) {
		from, _ := graded[i]["parts"].([]any)
		parts, _ := view["parts"].([]any)
		for j, raw := range parts {
			p, _ := raw.(map[string]any)
			learner, _ := p["answer"].(map[string]any)
			order, ok := learner["order"]
			if !ok || j >= len(from) {
				continue
			}
			if part, _ := from[j].(map[string]any); part != nil {
				if answer, _ := part["answer"].(map[string]any); answer != nil {
					answer["order"] = order
				}
			}
		}
	}
}

/* ------------------------------------------------------------------- marks */

// AssignmentMark changes one question's marks in a member's answers, and its
// comment. Items are an open part's marks per marking point; Mark a closed
// part's. An empty Parts changes only the comment.
type AssignmentMark struct {
	QuestionID string               `json:"questionId"`
	Parts      []AssignmentPartMark `json:"parts" nullable:"false"`
	Comment    string               `json:"comment" maxLength:"2000"`
	// ClearWarning takes the AI's warning off the question; with an empty Parts it
	// changes nothing else.
	ClearWarning bool `json:"clearWarning,omitempty"`
}

type AssignmentPartMark struct {
	PartID string    `json:"partId"`
	Items  []float64 `json:"items,omitempty"`
	Mark   *float64  `json:"mark,omitempty"`
}

// validMark: a mark from 0 to the marks with at most one decimal place
// (Epo 2026-11-18, typed marks).
func validMark(v, marks float64) bool {
	tenths := v * 10
	return v >= 0 && v <= marks && math.Abs(tenths-math.Round(tenths)) < 1e-9
}

// MarkAssignmentAnswer applies an owner's or editor member's marks: a waiting
// open part stops waiting, and any part's mark can change (§7, board G3m). Each
// change is a new answer event; a question that stops waiting after the
// assignment is released is rated.
func (s *Store) MarkAssignmentAnswer(ctx context.Context, actorID, attemptID string, mark AssignmentMark, now time.Time) (AssignmentAttempt, *Notification, error) {
	if len([]rune(mark.Comment)) > assignmentNoteMax {
		return AssignmentAttempt{}, nil, assignmentInput("a comment is too long")
	}
	first, err := s.readAttempt(ctx, attemptID)
	if err != nil {
		return AssignmentAttempt{}, nil, err
	}
	var note *Notification
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
		// A drawing marked by hand has had its marking: its image goes, once
		// no part it answers still waits.
		marked := make([]string, 0, len(mark.Parts))
		for _, part := range mark.Parts {
			marked = append(marked, part.PartID)
		}
		if err := dropDrawingImagesTx(ctx, tx, attemptID, doneDrawings(graded, marked)); err != nil {
			return err
		}
		if mark.ClearWarning {
			clearAIWarning(question)
		}
		if mark.Comment != "" {
			question["comment"], question["commentBy"] = mark.Comment, actorID
		} else if !mark.ClearWarning || len(mark.Parts) > 0 {
			delete(question, "comment")
			delete(question, "commentBy")
		}
		note, err = s.storeQuestionMarksTx(ctx, tx, r, graded, question, given, changed, waited, now)
		return err
	})
	if err != nil {
		return AssignmentAttempt{}, nil, err
	}
	attempt, err := s.GetAssignmentAttempt(ctx, actorID, attemptID, now)
	return attempt, note, err
}

// storeQuestionMarksTx stores a question's changed marks: the attempt's totals,
// its answer log and, once nothing waits, its reviews. Where the member sees
// grades it rings them (Epo 2026-11-25): a regraded question (`regraded`, the
// mark it had) whose new mark is decided and differs (Epo 2026-11-23), the
// attempt's last waiting mark decided (its grade is ready), or a decided mark
// changed by hand once nothing waits. That notification is returned for the
// caller to send.
func (s *Store) storeQuestionMarksTx(ctx context.Context, tx pgx.Tx, r attemptRow, graded []map[string]any, question map[string]any, given map[string]any, changed map[string]bool, waited bool, now time.Time) (*Notification, error) {
	shown := !gradesHidden(r.showGrades, r.gradesReleased)
	code := ""
	before, regraded := question["regraded"].(float64)
	correct, total, waitingMarks, waitingAnswers := attemptTotals(graded)
	if regraded && !questionWaiting(question) {
		delete(question, "regraded")
		if awarded, _ := questionMarks(question); awarded != before && waitingAnswers == 0 {
			code = "mark_changed"
		}
	}
	// This question the last to wait: callers marking several questions share
	// one read row, so its count would be stale.
	if !regraded && waitingAnswers == 0 {
		if waited {
			code = "grade_ready"
		} else if len(changed) > 0 {
			code = "mark_changed"
		}
	}
	var note *Notification
	if code != "" && shown {
		n, err := s.attemptNotificationTx(ctx, tx, r, code, now)
		if err != nil {
			return nil, err
		}
		note = &n
	}
	pct := 0
	if total > 0 {
		pct = int(correct / total * 100)
	}
	raw, err := json.Marshal(graded)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE attempts SET questions=$2, correct=$3, total=$4, pct=$5, waiting_marks=$6, waiting_answers=$7 WHERE id=$1`,
		r.id, raw, correct, total, pct, waitingMarks, waitingAnswers); err != nil {
		return nil, err
	}
	mt := r.quiz()
	if err := logAnswerPartsTx(ctx, tx, r.userID, mt, question, given, answerSourceAssignment, r.id, now, changed); err != nil {
		return nil, err
	}
	if r.released == nil || !waited || questionWaiting(question) {
		return note, nil
	}
	// Reviews rate a member's latest submission (latestAttempts): an earlier one
	// marked now moves its mark alone.
	var latest bool
	if err := tx.QueryRow(ctx, `SELECT NOT EXISTS (SELECT 1 FROM attempts
		WHERE assignment_id=$1 AND user_id=$2 AND submitted_at > $3)`, r.assignmentID, r.userID, r.submitted).Scan(&latest); err != nil || !latest {
		return note, err
	}
	return note, s.rateAttemptTx(ctx, tx, r.userID, r.sourceID, []map[string]any{question}, given, now)
}

// attemptNotificationTx tells the member about their attempt's marks (code
// grade_ready or mark_changed), linking to the attempt's own page.
func (s *Store) attemptNotificationTx(ctx context.Context, tx pgx.Tx, r attemptRow, code string, now time.Time) (Notification, error) {
	var title string
	if err := tx.QueryRow(ctx, `SELECT title FROM assignments WHERE id=$1`, r.assignmentID).Scan(&title); err != nil {
		return Notification{}, err
	}
	data, err := json.Marshal(map[string]string{"code": code, "assignmentId": r.assignmentID, "title": title})
	if err != nil {
		return Notification{}, err
	}
	return CreateNotificationTx(ctx, tx, NotificationParams{
		UserID: r.userID, Kind: NotifSystem, Data: data, WorkspaceID: r.wsID, At: now,
		Href: "/attempts/" + r.id,
	})
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
		if questions.ModelMarked(a["type"]) {
			_, itemMarks := questions.MarkItems(p)
			if len(mark.Items) != len(itemMarks) {
				return nil, assignmentInput("give a mark for every marking point")
			}
			for i, v := range mark.Items {
				if !validMark(v, itemMarks[i]) {
					return nil, assignmentInput("a mark is out of range")
				}
				awarded += v
			}
			// Tenths summed in floats drift (0.1+0.2); a part's mark keeps one place.
			awarded = math.Round(awarded*10) / 10
			if awarded > partMarks {
				awarded = partMarks
			}
			p["itemAwards"] = mark.Items
		} else {
			if mark.Mark == nil || !validMark(*mark.Mark, partMarks) {
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
	// Answers lists, for Grading, each member's counted answer to every
	// question, and any other submission's answer still waiting: once marked it
	// can become the highest.
	Answers []AssignmentAnswerRow `json:"answers" nullable:"false"`
	// PapersToRead counts the submitted papers not read yet (PapersToRead):
	// under manual marking, Read papers again reads them (Q725).
	PapersToRead int `json:"papersToRead"`
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
	// Files: what they handed in, on an unmarked one that takes files (T2).
	Files []PaperFile `json:"files,omitempty"`
	// Marking: a marking run holds an attempt of theirs now (Q729), filled by
	// the gateway.
	Marking bool `json:"marking,omitempty"`
}

// AssignmentQuestionReport is one question of the frozen copy, with its keys,
// and how members did on it.
type AssignmentQuestionReport struct {
	Question map[string]any `json:"question"`
	// Submitted counts the members' answers to the question, blanks included.
	Submitted int                    `json:"submitted"`
	Parts     []AssignmentPartReport `json:"parts" nullable:"false"`
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
	// Average is the part's mean mark over its marked answers, partial marks
	// counted, every type in marks (Epo 2026-11-22). Absent until one is marked.
	Average *float64 `json:"average,omitempty"`
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

// AssignmentAnswerRow is one member's answer to a question, for Grading.
type AssignmentAnswerRow struct {
	QuestionID string `json:"questionId"`
	UserID     string `json:"userId"`
	AttemptID  string `json:"attemptId"`
	// AttemptNumber is which of the member's submissions it is, the first being 1.
	AttemptNumber int `json:"attemptNumber"`
	// Waiting: an open part still waits for the owner. AIMarked: the AI has marked
	// all of them, so Approve all can take it.
	Waiting  bool `json:"waiting"`
	AIMarked bool `json:"aiMarked"`
	// AIAwarded is the question's marks if the AI's are approved as they stand.
	AIAwarded float64 `json:"aiAwarded"`
	// AIWarning is what the row's warning icon shows: "warning", "error" or empty.
	AIWarning string `json:"aiWarning"`
	// HandMarking: a waiting drawing has no marking image (saved under manual
	// grading), so only staff mark it, whatever Mark with AI runs (Q695).
	HandMarking bool `json:"handMarking"`
	// AIError is why the AI left it unmarked: "credits" (the member has none)
	// or "error" (the grade failed), shown as No credits or Grade Error (mock T3).
	AIError string `json:"aiError,omitempty" enum:"credits,error,file"`
	// Marking: a marking run holds a part of this answer now (Q729), filled by
	// the gateway.
	Marking bool    `json:"marking,omitempty"`
	Awarded float64 `json:"awarded"`
	Marks   float64 `json:"marks"`
}

// wrongAnswersShown caps a short part's common wrong answers.
const wrongAnswersShown = 5

// GetAssignmentReport reads the report for a class's owner and editor members.
func (s *Store) GetAssignmentReport(ctx context.Context, userID, id string, now time.Time) (AssignmentReport, error) {
	out := AssignmentReport{Members: []AssignmentMemberRow{}, Questions: []AssignmentQuestionReport{}, Answers: []AssignmentAnswerRow{}}
	wsID, err := assignmentWorkspace(ctx, s.pool, id)
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
	var kind, marking string
	var noLate bool
	var penalty int
	var due *time.Time
	var raw []byte
	var points *int
	if err := s.pool.QueryRow(ctx, `SELECT kind, no_late, late_penalty_pct, due_at, questions, marking, points FROM assignments WHERE id=$1`, id).
		Scan(&kind, &noLate, &penalty, &due, &raw, &marking, &points); err != nil {
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
		return out, s.fillUnmarked(ctx, id, noLate, due, penalty, points, out.Members)
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
	papers, err := s.PapersToRead(ctx, id, "")
	if err != nil {
		return out, err
	}
	out.PapersToRead = len(papers)
	if marking == MarkingManual {
		return out, nil
	}
	// Under manual grading everything waits for staff alike; otherwise a drawing
	// with no marking image is marked out by name (Q695).
	byID := map[string]reportAttempt{}
	var ids []string
	for _, attempt := range append(append([]reportAttempt{}, counted...), waiting...) {
		byID[attempt.id] = attempt
		ids = append(ids, attempt.id)
	}
	kept, err := keptDrawingImageParts(ctx, s.pool, ids)
	if err != nil {
		return out, err
	}
	for i, row := range out.Answers {
		if attempt, ok := byID[row.AttemptID]; ok && row.Waiting && !row.AIMarked {
			out.Answers[i].HandMarking = needsHandMarking(attempt.graded[row.QuestionID], attempt.answers, attempt.id, kept)
		}
	}
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

// fillUnmarked marks an unmarked assignment's ticks Late past its due date,
// as a marked one's submissions, adds each grade on a graded one (points set)
// with the late penalty off it, and what each member handed in when it takes
// files (T2).
func (s *Store) fillUnmarked(ctx context.Context, id string, noLate bool, due *time.Time, penalty int, points *int, members []AssignmentMemberRow) error {
	for i := range members {
		if at := members[i].SubmittedAt; at != nil {
			members[i].Late = assignmentLate(noLate, due, *at)
		}
	}
	if points != nil {
		grades, err := assignmentGrades(ctx, s.pool, id)
		if err != nil {
			return err
		}
		total := float64(*points)
		for i := range members {
			row := &members[i]
			row.LatePenaltyPct = penaltyFor(row.Late, penalty)
			if grade, ok := grades[row.UserID]; ok {
				mark := penalisedMark(grade, row.LatePenaltyPct)
				row.Correct, row.Mark, row.Total = &grade, &mark, &total
			}
		}
	}
	var uploads bool
	if err := s.pool.QueryRow(ctx, `SELECT allow_uploads FROM assignments WHERE id=$1`, id).Scan(&uploads); err != nil || !uploads {
		return err
	}
	var users []string
	for _, row := range members {
		if row.SubmittedAt != nil {
			users = append(users, row.UserID)
		}
	}
	files, err := handInFiles(ctx, s.pool, []string{id}, users)
	if err != nil {
		return err
	}
	for i := range members {
		row := &members[i]
		if row.SubmittedAt != nil {
			row.Files = files[[2]string{id, row.UserID}]
		}
	}
	return nil
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
		for _, raw := range list {
			p, _ := raw.(map[string]any)
			report.Parts = append(report.Parts, partReport(p, attempts))
		}
		for _, attempt := range attempts {
			graded := attempt.graded[id]
			if graded == nil {
				continue
			}
			report.Submitted++
			awarded, marks := questionMarks(graded)
			waiting := questionWaiting(graded)
			// Every answer, so Grading lists every question (Epo 2026-11-19); by
			// their own copy, as a republish may have changed the question since.
			rows = append(rows, AssignmentAnswerRow{QuestionID: id, UserID: attempt.userID, AttemptID: attempt.id, AttemptNumber: attempt.number,
				Waiting: waiting, AIMarked: waiting && questionAIMarked(graded), AIAwarded: questionAIAwarded(graded), AIWarning: questionAIWarning(graded), AIError: questionAIError(graded), Awarded: awarded, Marks: marks})
		}
		for _, attempt := range others {
			graded := attempt.graded[id]
			if graded != nil && questionWaiting(graded) {
				awarded, marks := questionMarks(graded)
				rows = append(rows, AssignmentAnswerRow{QuestionID: id, UserID: attempt.userID, AttemptID: attempt.id, AttemptNumber: attempt.number,
					Waiting: true, AIMarked: questionAIMarked(graded), AIAwarded: questionAIAwarded(graded), AIWarning: questionAIWarning(graded), AIError: questionAIError(graded), Awarded: awarded, Marks: marks})
			}
		}
		reports = append(reports, report)
	}
	return reports, rows
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
	case "open", "canvas":
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
	// The part's mean mark over its marked answers.
	var marked int
	var awardedSum float64
	for _, attempt := range attempts {
		gp := graded(attempt)
		if gp == nil {
			continue
		}
		if pending, _ := gp["pending"].(bool); pending {
			continue
		}
		awarded, _ := gp["awarded"].(float64)
		marked++
		awardedSum += awarded
	}
	if marked > 0 {
		average := awardedSum / float64(marked)
		out.Average = &average
	}
	return out
}

/* ------------------------------------------------------------------- sweep */

// SweepAssignments is the server closing what a closed tab cannot: it submits
// what running attempts saved once their time runs out or the assignment closes,
// by hand or at a No late submissions due date, past the grace, and releases a
// closed assignment once, rating what was submitted unless its answers are Do
// not show (Epo 2026-11-14). A due date alone releases nothing (Epo
// 2026-11-04). One row that fails is logged and passed over; each batch is a random pick, so rows that keep
// failing never fill it every minute and hold up the rest.
// finished names the attempts it submitted, whose To do changed.
func (s *Store) SweepAssignments(ctx context.Context, limit int, now time.Time) (finished []SweptAttempt, released int, err error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id, t.assignment_id, t.user_id FROM attempts t JOIN assignments a ON a.id=t.assignment_id
		WHERE t.assignment_id IS NOT NULL AND t.submitted_at IS NULL
			AND (t.deadline_at <= $1 OR a.closed_at <= $1 OR (a.no_late AND a.due_at <= $1)) ORDER BY random() LIMIT $2`, now.Add(-assignmentGrace), limit)
	if err != nil {
		return nil, 0, err
	}
	due, err := pgx.CollectRows(rows, pgx.RowToStructByPos[SweptAttempt])
	if err != nil {
		return nil, 0, err
	}
	for _, t := range due {
		if err := s.finishAttemptIfRunning(ctx, t.ID, now); err != nil {
			obs.Log(ctx).Warn("assignment attempt not submitted", "attempt_id", t.ID, "error", err)
			continue
		}
		finished = append(finished, t)
	}
	rows, err = s.pool.Query(ctx, `SELECT id FROM assignments
		WHERE released_at IS NULL AND kind='marked' AND NOT draft AND (closed_at IS NOT NULL OR (no_late AND due_at <= $1))
			AND (grades_shown='automatic' OR grades_released_at IS NOT NULL)
			AND answers_shown<>'never'
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

// SweptAttempt is an attempt the sweep submitted for its member.
type SweptAttempt struct {
	ID, AssignmentID, UserID string
}

// releaseAssignment rates what members submitted (§4, §11.6, Epo 2026-11-04).
// Its locks run workspace, quiz, assignment: purging a quiz deletes the
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
		// Its quiz is its own (migration 0174) and stays held: releasing
		// rates what members submitted and shows them nothing new.
		if source == nil {
			return nil
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
