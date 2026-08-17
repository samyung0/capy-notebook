package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// The bucket is reconciled with the database by a durable outbox rather than by
// delete handlers. Refcount triggers on files, editor_assets and upload_sessions
// move paths into pending_blob_deletions; the reaper below drains it. Nothing in
// the request path deletes an object, because the interesting deletions happen
// through FK cascades where no handler runs at all.

// blobDeletionMaxAttempts is where the reaper gives up on a path. A key that
// fails this often is either malformed or the bucket is rejecting it, and
// retrying forever would starve the queue behind it.
const blobDeletionMaxAttempts = 8

// EnqueueBlobDeletionTx queues object paths for the reaper inside the caller's
// transaction, so a state change and its cleanup commit together. Paths still
// referenced by a live row are skipped by the SQL function.
func (s *Store) EnqueueBlobDeletionTx(
	ctx context.Context,
	tx pgx.Tx,
	delay time.Duration,
	paths ...string,
) error {
	for _, path := range paths {
		if path == "" {
			continue
		}
		if _, err := tx.Exec(ctx,
			`SELECT blob_enqueue_deletion($1, make_interval(secs => $2))`,
			path, delay.Seconds()); err != nil {
			return err
		}
	}
	return nil
}

// ClaimBlobDeletions takes a due batch off the queue. It re-checks blobs rather
// than trusting the enqueue-time check: a path can be re-referenced after being
// queued (a workspace clone copies blob_path), and deleting a live object would
// be unrecoverable.
//
// Rows are claimed by pushing not_before forward, which doubles as the retry
// backoff and keeps concurrent reapers off the same batch without a lock column.
func (s *Store) ClaimBlobDeletions(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `UPDATE pending_blob_deletions p
		SET attempts = p.attempts + 1,
		    not_before = now() + (interval '5 minutes' * (p.attempts + 1))
		WHERE p.object_path IN (
			SELECT d.object_path FROM pending_blob_deletions d
			WHERE d.not_before <= now() AND d.attempts < $2
			  AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.object_path = d.object_path)
			ORDER BY d.not_before
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING p.object_path`, limit, blobDeletionMaxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, rows.Err()
}

// FinishBlobDeletions drops successfully deleted paths from the queue.
func (s *Store) FinishBlobDeletions(ctx context.Context, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx,
		`DELETE FROM pending_blob_deletions WHERE object_path = ANY($1)`, paths)
	return err
}

// FailBlobDeletions records why a batch could not be deleted. The attempt
// counter and backoff were already advanced by the claim, so this only preserves
// the reason for the eventual give-up.
func (s *Store) FailBlobDeletions(ctx context.Context, paths []string, reason string) error {
	if len(paths) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE pending_blob_deletions
		SET last_error = $2 WHERE object_path = ANY($1)`, paths, reason)
	return err
}

// BlobDeletionBacklog counts what the reaper has given up on. Surfaced so a
// systematically failing key shape is visible instead of quietly accumulating
// billed bytes.
func (s *Store) BlobDeletionBacklog(ctx context.Context) (stuck int, err error) {
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM pending_blob_deletions
		WHERE attempts >= $1`, blobDeletionMaxAttempts).Scan(&stuck)
	return stuck, err
}

// KnownObjectPaths filters a page of bucket keys down to the ones the database
// still accounts for. Used by the listing sweep, which is the backstop for
// objects that were written but never recorded — a crashed request between the
// PUT and the row insert leaves no reference for the trigger layer to notice.
func (s *Store) KnownObjectPaths(ctx context.Context, paths []string) (map[string]bool, error) {
	known := make(map[string]bool, len(paths))
	if len(paths) == 0 {
		return known, nil
	}
	// The in-flight upload paths matter as much as the blobs table: a session
	// that has not completed yet holds no blob reference, but its object is
	// legitimately in the bucket and must not be reported as an orphan.
	rows, err := s.pool.Query(ctx, `
		SELECT object_path FROM blobs WHERE object_path = ANY($1)
		UNION
		SELECT object_path FROM upload_sessions WHERE object_path = ANY($1)
		UNION
		SELECT final_path FROM upload_sessions WHERE final_path = ANY($1)`, paths)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		known[path] = true
	}
	return known, rows.Err()
}

// SweepArtifactCache drops cold parse-zip and caption objects that no in-flight
// ingest still needs. The artifact_cache trigger queues B2 deletion through the
// existing outbox. Parse zips are also dropped on ingest success; this pass is
// the orphan reaper for a worker that died between success and that drop.
func (s *Store) SweepArtifactCache(ctx context.Context, captionTTLDays, parseZipTTLHours int) (int64, error) {
	if captionTTLDays < 1 {
		captionTTLDays = 90
	}
	if parseZipTTLHours < 1 {
		parseZipTTLHours = 6
	}
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM artifact_cache a
		WHERE (
		        (a.kind = 'captions'
		         AND a.last_used_at < now() - make_interval(days => $1))
		     OR (a.kind = 'parse_zip'
		         AND a.last_used_at < now() - make_interval(hours => $2))
		    )
		  AND NOT EXISTS (
		      SELECT 1
		      FROM jobs j
		      JOIN files f ON f.id = j.payload->>'fileId'
		      WHERE j.status IN ('pending', 'running')
		        AND f.source_sha256 = a.source_sha256
		  )`, captionTTLDays, parseZipTTLHours)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
