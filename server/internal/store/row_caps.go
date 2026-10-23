package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Per-parent row caps (rate-limit audit 2026-10-24). These rows sit outside
// storage, so their counts are bounded instead.
const (
	// CommentsPerNote counts a note's live comments: each comment row of its
	// open discussions, the one that opens a discussion and every reply.
	// Deleted comments and the comments of deleted discussions do not count.
	CommentsPerNote = 500
	// AnnotationsPerFile counts one author's annotations on a file; they are
	// private to their author, so nobody else's count can block them.
	AnnotationsPerFile = 2_000
	// EventsPerUser counts a user's schedule events.
	EventsPerUser = 5_000
)

var (
	ErrTooManyComments    = errors.New("this note holds the most comments it can")
	ErrTooManyAnnotations = errors.New("this file holds the most annotations it can")
	ErrTooManyEvents      = errors.New("the schedule holds the most events it can")
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
		WHERE d.material_id=$1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`, materialID).Scan(&n); err != nil {
		return err
	}
	if n >= CommentsPerNote {
		return ErrTooManyComments
	}
	return nil
}

// assertAnnotationRoomTx refuses a new annotation at AnnotationsPerFile; the
// caller holds the file row's lock.
func assertAnnotationRoomTx(ctx context.Context, tx pgx.Tx, fileID, authorID string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM pdf_annotations WHERE file_id=$1 AND author_id=$2`,
		fileID, authorID).Scan(&n); err != nil {
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
