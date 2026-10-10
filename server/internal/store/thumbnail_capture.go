package store

import (
	"context"
	"errors"
	"time"
)

// ThumbnailCaptureInterval is the least time between two accepted browser
// captures of one file (openwiki/thumbnails.md, phase 2a).
const ThumbnailCaptureInterval = 60 * time.Second

// ErrThumbnailTooSoon refuses a capture within ThumbnailCaptureInterval of the
// file's last accepted one.
var ErrThumbnailTooSoon = errors.New("thumbnail captured too recently")

// ThumbnailTarget is what a browser capture reads of its live file.
type ThumbnailTarget struct {
	Name string
	Kind string
	// Key is the current thumbnail_key, "" without one.
	Key string
}

func (s *Store) ThumbnailTarget(ctx context.Context, fileID string) (ThumbnailTarget, error) {
	var t ThumbnailTarget
	err := s.pool.QueryRow(ctx, `SELECT name, kind, COALESCE(thumbnail_key, '')
		FROM files WHERE id=$1 AND trashed_at IS NULL`, fileID).Scan(&t.Name, &t.Kind, &t.Key)
	if isNoRows(err) {
		return t, ErrNotFound
	}
	return t, err
}

// ClaimThumbnailCapture records a capture of the file as accepted now, or
// refuses it with ErrThumbnailTooSoon. The claim is one conditional update,
// so two captures racing each other cannot both pass.
func (s *Store) ClaimThumbnailCapture(ctx context.Context, fileID string) error {
	tag, err := s.pool.Exec(ctx, `UPDATE files SET thumbnail_captured_at=now()
		WHERE id=$1 AND trashed_at IS NULL
		  AND (thumbnail_captured_at IS NULL
		       OR thumbnail_captured_at <= now() - make_interval(secs => $2))`,
		fileID, ThumbnailCaptureInterval.Seconds())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	if _, err := s.ThumbnailTarget(ctx, fileID); err != nil {
		return err
	}
	return ErrThumbnailTooSoon
}

// SetFileThumbnail points a live file at a captured key, which releases the
// old one through the blob reference triggers. A file trashed or deleted
// since takes nothing and the new key is queued for deletion at once; so is
// the key when the update fails.
func (s *Store) SetFileThumbnail(ctx context.Context, fileID, key string) error {
	err := s.setFileThumbnail(ctx, fileID, key)
	if err == nil {
		return nil
	}
	if enqueueErr := s.EnqueueBlobDeletion(ctx, key); enqueueErr != nil {
		return errors.Join(err, enqueueErr)
	}
	return err
}

// EnqueueBlobDeletion queues an object the bucket may hold with no row naming
// it, for the reaper, now; a path still referenced is skipped. It runs past
// the caller's cancellation (a request that ended), so the object is not left
// to the monthly orphan sweep.
func (s *Store) EnqueueBlobDeletion(ctx context.Context, path string) error {
	_, err := s.pool.Exec(context.WithoutCancel(ctx),
		`SELECT blob_enqueue_deletion($1, make_interval(secs => 0))`, path)
	return err
}

func (s *Store) setFileThumbnail(ctx context.Context, fileID, key string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE files SET thumbnail_key=$2
		WHERE id=$1 AND trashed_at IS NULL`, fileID, key)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if err := s.EnqueueBlobDeletionTx(ctx, tx, 0, key); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
