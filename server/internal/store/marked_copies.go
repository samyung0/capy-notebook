package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// A Word submission's PDF copy (Epo 2026-11-25, mock B6H1Z7o4byVFBVyCRSUK3B
// C1): staff mark a .docx hand-in or graded-quiz upload on a PDF the first
// staff browser to open it draws with the Office viewer. It is stored once at
// files.marked_copy_path, a counted blob reference that goes with the file and
// that no storage trigger charges, and its marks are the file's
// (submissionMarkAccess). The member's links show it in place of the .docx.

// ErrMarkedCopyTaken: the file has its copy; another staff browser stored it.
var ErrMarkedCopyTaken = errors.New("this file already has its copy")

// markedCopyOrphanDelay is how long an uploaded copy waits for SetMarkedCopy
// before the blob reaper deletes it: a gateway that died between the upload
// and the row's update leaves nothing behind for long.
const markedCopyOrphanDelay = "1 hour"

// AssertMarkedCopy says whether actor may store file's copy at path now: staff
// who mark it (a graded assignment's handed-in .docx) while it has none, with
// an account that may edit content. It queues path for deletion after
// markedCopyOrphanDelay; SetMarkedCopy's reference cancels that.
func (s *Store) AssertMarkedCopy(ctx context.Context, actor, file, path string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.markedCopyLock(ctx, tx, actor, file); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `SELECT blob_enqueue_deletion($1, $2::interval)`, path, markedCopyOrphanDelay); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SetMarkedCopy points file at its stored copy; ErrMarkedCopyTaken when
// another browser's landed first, whose object the caller then deletes.
func (s *Store) SetMarkedCopy(ctx context.Context, actor, file, path string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.markedCopyLock(ctx, tx, actor, file); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET marked_copy_path=$2 WHERE id=$1`, file, path); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) markedCopyLock(ctx context.Context, tx pgx.Tx, actor, file string) error {
	scope, submission, err := s.submissionMarkAccess(ctx, tx, actor, file)
	switch {
	case err != nil:
		return err
	case !submission:
		return ErrNotFound
	case scope.readOnly || !scope.word:
		return ErrForbidden
	case scope.copied:
		return ErrMarkedCopyTaken
	}
	// As a mark's save: only the marking staff member's own account decides.
	return s.assertContentEditableTx(ctx, tx, actor, actor)
}
