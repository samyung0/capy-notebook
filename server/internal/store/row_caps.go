package store

import (
	"context"
	"errors"

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
	// CanvasesPerUser counts a user's thinking canvases.
	CanvasesPerUser = 100
)

var (
	ErrTooManyComments    = errors.New("this note holds the most comments it can")
	ErrTooManyAnnotations = errors.New("this file holds the most annotations it can")
	ErrTooManyEvents      = errors.New("the schedule holds the most events it can")
	ErrTooManyCanvases    = errors.New("the account holds the most canvases it can")
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

// assertCanvasRoomTx refuses a new canvas at CanvasesPerUser; the caller
// holds the user's account lock.
func assertCanvasRoomTx(ctx context.Context, tx pgx.Tx, userID string) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM canvases WHERE user_id=$1`, userID).Scan(&n); err != nil {
		return err
	}
	if n >= CanvasesPerUser {
		return ErrTooManyCanvases
	}
	return nil
}
