package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Hand-ins: an unmarked assignment's work handed in as files (Epo 2026-11-08,
// mocks S3 and T2). When the owner allows uploads, a member adds files, as
// their own standalone uploads linked by files.hand_in_assignment_id, and Hand
// in ticks the assignment (assignment_done). Nothing reads or marks them; staff
// open them from the Members tab.

// ErrHandInClosed: the member's hand-in takes no more changes (handed in, or
// the assignment closed or taking no files).
var ErrHandInClosed = errors.New("this assignment no longer takes your files")

// lockHandInTx takes the assignment's workspace first, as submitting does, and
// returns it with whether the assignment takes files.
func lockHandInTx(ctx context.Context, tx pgx.Tx, assignmentID string) (wsID string, uploads bool, err error) {
	err = tx.QueryRow(ctx, `SELECT COALESCE(workspace_id, ''), kind='unmarked' AND allow_uploads FROM assignments WHERE id=$1`, assignmentID).
		Scan(&wsID, &uploads)
	if isNoRows(err) {
		return "", false, ErrNotFound
	}
	if err != nil {
		return "", false, err
	}
	// A task with no workspace has none to hold.
	return wsID, uploads, lockWorkspaceKeyShareTx(ctx, tx, wsID)
}

// openHandInTx checks that userID's hand-in on the assignment takes changes:
// published to them, taking files, not closed, and not handed in. It holds the
// hand-in so uploads and Hand in run one at a time; account locks go before it.
func (s *Store) openHandInTx(ctx context.Context, tx pgx.Tx, assignmentID, userID string) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		"hand-in:"+assignmentID+":"+userID); err != nil {
		return err
	}
	var row taskRow
	var draft, uploads, closed, handedIn bool
	err := tx.QueryRow(ctx, `SELECT COALESCE(workspace_id, ''), own, created_by, draft, kind='unmarked' AND allow_uploads,
			closed_at IS NOT NULL OR (no_late AND due_at <= now()),
			EXISTS (SELECT 1 FROM assignment_done d WHERE d.assignment_id=a.id AND d.user_id=$2)
		FROM assignments a WHERE id=$1`, assignmentID, userID).Scan(&row.wsID, &row.own, &row.maker, &draft, &uploads, &closed, &handedIn)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := s.staffOf(ctx, tx, userID, row); err != nil {
		return err
	}
	assigned, err := assignedTx(ctx, tx, assignmentID, userID)
	if err != nil {
		return err
	}
	if draft || !assigned {
		return ErrNotFound
	}
	// Past its due date it still takes work, shown as Late (T2), unless NoLate
	// closed it there; closing by hand ends it too.
	if !uploads || closed || handedIn {
		return ErrHandInClosed
	}
	return nil
}

// checkHandInUploadTx admits size more bytes into userID's open hand-in, within
// PaperMaxFiles and maxBytes across its files and pending uploads, while their
// storage is not full yet, as a Marked paper's start (Q728 A).
func (s *Store) checkHandInUploadTx(ctx context.Context, tx pgx.Tx, assignmentID, userID string, size, maxBytes int64) error {
	if err := s.openHandInTx(ctx, tx, assignmentID, userID); err != nil {
		return err
	}
	if err := s.storageFullErr(ctx, tx, userID); err != nil {
		return err
	}
	var files int
	var bytes int64
	if err := tx.QueryRow(ctx, `SELECT count(*), COALESCE(sum(b), 0) FROM (
			SELECT size_bytes AS b FROM files WHERE hand_in_assignment_id=$1 AND user_id=$2
			UNION ALL
			SELECT declared_size FROM upload_sessions WHERE hand_in_assignment_id=$1 AND user_id=$2
				AND status='pending' AND expires_at > now()
		) held`, assignmentID, userID).Scan(&files, &bytes); err != nil {
		return err
	}
	if files+1 > PaperMaxFiles || bytes+size > maxBytes {
		return ErrPaperFull
	}
	return nil
}

// AssertHandInUpload is an upload ticket's check of checkHandInUploadTx, with
// the account's lifecycle. An account already full adds no file, as a Marked
// paper starts no upload then; a file added while there was room saves past
// the limit (reservePaperStorageTx), and Hand in and Undo still work when full.
func (s *Store) AssertHandInUpload(ctx context.Context, assignmentID, userID string, size, maxBytes int64) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, _, err := lockHandInTx(ctx, tx, assignmentID); err != nil {
			return err
		}
		if err := s.admitAccountTx(ctx, tx, userID); err != nil {
			return err
		}
		return s.checkHandInUploadTx(ctx, tx, assignmentID, userID, size, maxBytes)
	})
}

// RemoveHandInFile deletes a file from the member's open hand-in. Its bytes
// and blob go as any deleted file's do (the files triggers).
func (s *Store) RemoveHandInFile(ctx context.Context, userID, assignmentID, fileID string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, _, err := lockHandInTx(ctx, tx, assignmentID); err != nil {
			return err
		}
		if err := s.openHandInTx(ctx, tx, assignmentID, userID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM files WHERE id=$1 AND hand_in_assignment_id=$2 AND user_id=$3`,
			fileID, assignmentID, userID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// setHandedInTx is Hand in and Undo hand in on an assignment that takes
// files: only while it is open, and Hand in only with a file.
func (s *Store) setHandedInTx(ctx context.Context, tx pgx.Tx, assignmentID, userID string, done bool) error {
	if !done {
		// Undo reopens the hand-in: it must be handed in and open otherwise.
		if _, err := tx.Exec(ctx, `DELETE FROM assignment_done WHERE assignment_id=$1 AND user_id=$2`, assignmentID, userID); err != nil {
			return err
		}
		return s.openHandInTx(ctx, tx, assignmentID, userID)
	}
	if err := s.openHandInTx(ctx, tx, assignmentID, userID); err != nil {
		return err
	}
	var files int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM files WHERE hand_in_assignment_id=$1 AND user_id=$2`,
		assignmentID, userID).Scan(&files); err != nil {
		return err
	}
	if files == 0 {
		return assignmentInput("add your work before handing it in")
	}
	return nil
}

// handInFiles are the hand-in files of userIDs on an assignment, in order, by
// member.
func handInFiles(ctx context.Context, q rowsQueryer, assignmentIDs, userIDs []string) (map[[2]string][]PaperFile, error) {
	rows, err := q.Query(ctx, `SELECT hand_in_assignment_id, user_id, id, name, kind, size_bytes, status FROM files
		WHERE hand_in_assignment_id = ANY($1) AND user_id = ANY($2)
		ORDER BY submission_position, id`, assignmentIDs, userIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[[2]string][]PaperFile{}
	for rows.Next() {
		var assignment, user string
		var f PaperFile
		if err := rows.Scan(&assignment, &user, &f.ID, &f.Name, &f.Kind, &f.SizeBytes, &f.Status); err != nil {
			return nil, err
		}
		key := [2]string{assignment, user}
		out[key] = append(out[key], f)
	}
	return out, rows.Err()
}

// HandInFileBlob is a hand-in file's stored object for its member, or for
// staff of the class once it is handed in; anyone else gets ErrNotFound.
func (s *Store) HandInFileBlob(ctx context.Context, userID, assignmentID, fileID string) (blobPath, kind string, err error) {
	var owner string
	var row taskRow
	var handedIn bool
	err = s.pool.QueryRow(ctx, `SELECT f.user_id, COALESCE(a.workspace_id, ''), a.own, a.created_by, COALESCE(f.blob_path, ''), f.kind,
			EXISTS (SELECT 1 FROM assignment_done d WHERE d.assignment_id=a.id AND d.user_id=f.user_id)
		FROM files f JOIN assignments a ON a.id=f.hand_in_assignment_id
		WHERE f.id=$1 AND f.hand_in_assignment_id=$2`, fileID, assignmentID).Scan(&owner, &row.wsID, &row.own, &row.maker, &blobPath, &kind, &handedIn)
	if isNoRows(err) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if owner == userID {
		return blobPath, kind, nil
	}
	staff, err := s.staffOf(ctx, s.pool, userID, row)
	if err != nil || !staff || !handedIn {
		return "", "", ErrNotFound
	}
	return blobPath, kind, nil
}
