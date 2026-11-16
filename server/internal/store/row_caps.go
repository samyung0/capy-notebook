package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Per-parent row caps (rate-limit audit 2026-10-24). These rows sit outside
// storage, so their counts are bounded instead.
const (
	// CommentsPerNote counts the comment rows of a note's open discussions,
	// the one that opens a discussion and every reply. A deleted comment keeps
	// its row in its discussion, so deleting one frees no place; the comments
	// of deleted discussions do not count.
	CommentsPerNote = 500
	// AnnotationsPerFile counts every author's annotations on a file.
	AnnotationsPerFile = 2_000
	// EventsPerUser counts a user's schedule events.
	EventsPerUser = 5_000
	// AssignmentsPerClass counts every assignment a class holds, drafts and
	// closed ones included: its Assignments page reads them all in one request
	// (Epo 2026-11-10).
	AssignmentsPerClass = 500
	// OpenAssignmentsPerClass counts the published ones that have not closed,
	// which each member's To do reads across their classes in one request.
	OpenAssignmentsPerClass = 100
	// OwnTasksPerMember counts the tasks one member set themself in one
	// workspace, done or not, apart from the class's own caps: their To do
	// reads them in the same request.
	OwnTasksPerMember = 100
)

var (
	ErrTooManyComments    = errors.New("this note holds the most comments it can")
	ErrTooManyAnnotations = errors.New("this file holds the most annotations it can")
	ErrTooManyEvents      = errors.New("the schedule holds the most events it can")
	// Deleting one makes room under both; closing one, under the open cap.
	ErrTooManyAssignments     = errors.New("this class holds the most assignments it can")
	ErrTooManyOpenAssignments = errors.New("this class has the most open assignments it can")
	ErrTooManyOwnTasks        = errors.New("this workspace holds the most of your tasks it can")
)

// assertCommentRoomTx refuses a new comment on a note at CommentsPerNote. The
// lock serializes the count per note.
func assertCommentRoomTx(ctx context.Context, tx pgx.Tx, materialID string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('material-comments:' || $1))`, materialID); err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM material_comments c
		JOIN material_discussions d ON d.id=c.discussion_id
		WHERE d.material_id=$1 AND d.deleted_at IS NULL`, materialID).Scan(&n); err != nil {
		return err
	}
	if n >= CommentsPerNote {
		return ErrTooManyComments
	}
	return nil
}

// assertAnnotationRoomTx refuses a new annotation at AnnotationsPerFile; the
// caller holds the file row's lock.
func assertAnnotationRoomTx(ctx context.Context, tx pgx.Tx, fileID string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM pdf_annotations WHERE file_id=$1`,
		fileID).Scan(&n); err != nil {
		return err
	}
	if n >= AnnotationsPerFile {
		return ErrTooManyAnnotations
	}
	return nil
}

// assertEventRoomTx refuses a new event at EventsPerUser; the caller holds
// the user's account lock.
func assertEventRoomTx(ctx context.Context, tx pgx.Tx, userID string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM events WHERE user_id=$1`, userID).Scan(&n); err != nil {
		return err
	}
	if n >= EventsPerUser {
		return ErrTooManyEvents
	}
	return nil
}

// assertAssignmentRoomTx refuses one more assignment in a class at
// AssignmentsPerClass (adding), and one more open one at
// OpenAssignmentsPerClass (opening: made published, a draft published, a closed
// one reopened). An assignment that closed itself at its due date is not open.
// The lock serializes the counts per class.
func assertAssignmentRoomTx(ctx context.Context, tx pgx.Tx, wsID string, adding, opening bool, now time.Time) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('class-assignments:' || $1))`, wsID); err != nil {
		return err
	}
	var all, open int
	if err := tx.QueryRow(ctx, `SELECT count(*),
			count(*) FILTER (WHERE NOT draft AND closed_at IS NULL AND NOT (no_late AND due_at IS NOT NULL AND due_at <= $2))
		FROM assignments WHERE workspace_id=$1 AND NOT own`, wsID, now).Scan(&all, &open); err != nil {
		return err
	}
	if adding && all >= AssignmentsPerClass {
		return ErrTooManyAssignments
	}
	if opening && open >= OpenAssignmentsPerClass {
		return ErrTooManyOpenAssignments
	}
	return nil
}

// assertOwnTaskRoomTx refuses a member one more task of their own in a
// workspace, or with none (wsID empty), at OwnTasksPerMember; deleting one
// makes room. The lock serializes the count per member and workspace.
func assertOwnTaskRoomTx(ctx context.Context, tx pgx.Tx, wsID, userID string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('own-tasks:' || $1 || ':' || $2))`, wsID, userID); err != nil {
		return err
	}
	var held int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM assignments WHERE workspace_id IS NOT DISTINCT FROM NULLIF($1::text, '') AND own AND created_by=$2`,
		wsID, userID).Scan(&held); err != nil {
		return err
	}
	if held >= OwnTasksPerMember {
		return ErrTooManyOwnTasks
	}
	return nil
}
