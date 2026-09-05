package store

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

const blobDeletionLease = 5 * time.Minute

// BlobDeletionClaim fences the irreversible bucket delete from a concurrent
// database re-reference. The token is required for completion/failure so a
// stale worker cannot mutate a newer lease.
type BlobDeletionClaim struct {
	ObjectPath string
	Token      string
	guard      *blobDeletionGuard
}

type blobDeletionGuard struct {
	conn  *pgxpool.Conn
	paths []string
	once  sync.Once
}

func (g *blobDeletionGuard) release() {
	if g == nil || g.conn == nil {
		return
	}
	g.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for i := len(g.paths) - 1; i >= 0; i-- {
			if _, err := g.conn.Exec(ctx,
				`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, g.paths[i]); err != nil {
				conn := g.conn.Hijack()
				_ = conn.Close(ctx)
				return
			}
		}
		g.conn.Release()
	})
}

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
// Expired claims are deliberately reclaimable: an earlier worker may have
// deleted the bucket object and lost the acknowledgement, so retrying DELETE is
// safer than allowing a new database reference to bytes that may be gone.

func (s *Store) ClaimBlobDeletions(ctx context.Context, limit int) ([]BlobDeletionClaim, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT d.object_path
		FROM pending_blob_deletions d
		WHERE d.not_before <= now() AND d.attempts < $2
		  AND (d.claim_expires_at IS NULL OR d.claim_expires_at <= now())
		  AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.object_path = d.object_path)
		ORDER BY d.not_before, d.object_path
		LIMIT $1`, limit, blobDeletionMaxAttempts)
	if err != nil {
		return nil, err
	}
	var candidates []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, path)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(candidates) == 0 {
		return nil, nil
	}

	// The trigger functions take the same locks before inspecting either the
	// refcount or deletion queue. Keep them until the remote result is durably
	// settled so a reference cannot enter after the final database check but
	// before B2 receives the delete.
	sort.Strings(candidates)
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	guard := &blobDeletionGuard{conn: conn}
	for _, path := range candidates {
		var locked bool
		if err := conn.QueryRow(ctx,
			`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, path).Scan(&locked); err != nil {
			guard.release()
			return nil, err
		}
		if locked {
			guard.paths = append(guard.paths, path)
		}
	}
	if len(guard.paths) == 0 {
		guard.release()
		return nil, nil
	}

	token := uid("blobclaim")
	rows, err = conn.Query(ctx, `UPDATE pending_blob_deletions p
		SET attempts = p.attempts + 1,
		    not_before = now() + (interval '5 minutes' * (p.attempts + 1)),
		    claim_token = $3,
		    claim_expires_at = now() + make_interval(secs => $4)
		WHERE p.object_path = ANY($1)
		  AND p.not_before <= now() AND p.attempts < $2
		  AND (p.claim_expires_at IS NULL OR p.claim_expires_at <= now())
		  AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.object_path = p.object_path)
		RETURNING p.object_path, p.claim_token`, guard.paths, blobDeletionMaxAttempts,
		token, int(blobDeletionLease.Seconds()))
	if err != nil {
		guard.release()
		return nil, err
	}
	defer rows.Close()
	var claims []BlobDeletionClaim
	for rows.Next() {
		var claim BlobDeletionClaim
		if err := rows.Scan(&claim.ObjectPath, &claim.Token); err != nil {
			guard.release()
			return nil, err
		}
		claim.guard = guard
		claims = append(claims, claim)
	}
	if err := rows.Err(); err != nil {
		guard.release()
		return nil, err
	}
	if len(claims) == 0 {
		guard.release()
		return nil, nil
	}
	return claims, nil
}

func blobDeletionClaimsGuard(claims []BlobDeletionClaim) (*blobDeletionGuard, error) {
	if len(claims) == 0 {
		return nil, nil
	}
	guard := claims[0].guard
	if guard == nil {
		return nil, fmt.Errorf("blob deletion claims have no path lock")
	}
	for _, claim := range claims[1:] {
		if claim.guard != guard {
			return nil, fmt.Errorf("blob deletion claims belong to different batches")
		}
	}
	return guard, nil
}

// ReleaseBlobDeletionClaims drops the in-process path locks without changing
// the durable claim token. Production deletion paths settle a claim instead;
// this is for callers that inspect a batch but intentionally do no remote work.
func (s *Store) ReleaseBlobDeletionClaims(claims []BlobDeletionClaim) {
	if len(claims) > 0 {
		claims[0].guard.release()
	}
}

// FinishBlobDeletions drops successfully deleted paths from the queue.
func (s *Store) FinishBlobDeletions(ctx context.Context, claims []BlobDeletionClaim) error {
	if len(claims) == 0 {
		return nil
	}
	guard, err := blobDeletionClaimsGuard(claims)
	if err != nil {
		return err
	}
	defer guard.release()
	for _, claim := range claims {
		if _, err := guard.conn.Exec(ctx, `DELETE FROM pending_blob_deletions
			WHERE object_path=$1 AND claim_token=$2`, claim.ObjectPath, claim.Token); err != nil {
			return err
		}
	}
	return nil
}

// FailBlobDeletions records why a batch could not be deleted. The attempt
// counter and backoff were already advanced by the claim, so this only preserves
// the reason for the eventual give-up.
func (s *Store) FailBlobDeletions(ctx context.Context, claims []BlobDeletionClaim, reason string) error {
	if len(claims) == 0 {
		return nil
	}
	guard, err := blobDeletionClaimsGuard(claims)
	if err != nil {
		return err
	}
	defer guard.release()
	for _, claim := range claims {
		if _, err := guard.conn.Exec(ctx, `UPDATE pending_blob_deletions
			SET last_error=$3, claim_token=NULL, claim_expires_at=NULL
			WHERE object_path=$1 AND claim_token=$2`, claim.ObjectPath, claim.Token, reason); err != nil {
			return err
		}
	}
	return nil
}

// RecordBlobDeletionUncertain preserves the claim fence when the bucket may
// have committed a batch deletion before the client lost its response. The
// same token remains non-null through lease expiry, so no database reference
// can revive the path before an idempotent retry establishes its outcome.
func (s *Store) RecordBlobDeletionUncertain(ctx context.Context, claims []BlobDeletionClaim, reason string) error {
	if len(claims) == 0 {
		return nil
	}
	guard, err := blobDeletionClaimsGuard(claims)
	if err != nil {
		return err
	}
	defer guard.release()
	for _, claim := range claims {
		if _, err := guard.conn.Exec(ctx, `UPDATE pending_blob_deletions
			SET last_error=$3
			WHERE object_path=$1 AND claim_token=$2`, claim.ObjectPath, claim.Token, reason); err != nil {
			return err
		}
	}
	return nil
}

// ResolveBlobDeletions settles one claimed batch without releasing its path
// locks between rejected keys and successful keys.
func (s *Store) ResolveBlobDeletions(
	ctx context.Context,
	claims, deleted, failed []BlobDeletionClaim,
	failureReason string,
) error {
	if len(claims) == 0 {
		return nil
	}
	guard, err := blobDeletionClaimsGuard(claims)
	if err != nil {
		return err
	}
	defer guard.release()

	settled := make(map[string]bool, len(claims))
	for _, claim := range deleted {
		if claim.guard != guard || settled[claim.ObjectPath] {
			return fmt.Errorf("invalid successful blob deletion claim %q", claim.ObjectPath)
		}
		settled[claim.ObjectPath] = true
		if _, err := guard.conn.Exec(ctx, `DELETE FROM pending_blob_deletions
			WHERE object_path=$1 AND claim_token=$2`, claim.ObjectPath, claim.Token); err != nil {
			return err
		}
	}
	for _, claim := range failed {
		if claim.guard != guard || settled[claim.ObjectPath] {
			return fmt.Errorf("invalid failed blob deletion claim %q", claim.ObjectPath)
		}
		settled[claim.ObjectPath] = true
		if _, err := guard.conn.Exec(ctx, `UPDATE pending_blob_deletions
			SET last_error=$3, claim_token=NULL, claim_expires_at=NULL
			WHERE object_path=$1 AND claim_token=$2`, claim.ObjectPath, claim.Token,
			failureReason); err != nil {
			return err
		}
	}
	if len(settled) != len(claims) {
		return fmt.Errorf("settled %d of %d blob deletion claims", len(settled), len(claims))
	}
	return nil
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

// SweepArtifactCache drops cold durable cache objects that no in-flight ingest
// still needs. The required parse handoff remains local; only its B2 reuse copy
// enters artifact_cache.
func (s *Store) SweepArtifactCache(ctx context.Context, captionTTLDays int) (int64, error) {
	if captionTTLDays < 1 {
		captionTTLDays = 90
	}
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM artifact_cache a
		WHERE (
		        (a.kind = 'captions'
		         AND a.last_used_at < now() - make_interval(days => $1))
		     OR (a.kind = 'office_preview'
		         AND a.last_used_at < now() - make_interval(days => $1))
		     OR (a.kind = 'derived_text'
		         AND a.last_used_at < now() - make_interval(days => $1))
		     OR (a.kind = 'parse_bundle'
		         AND a.last_used_at < now() - make_interval(days => $1))
		    )
		  AND NOT EXISTS (
		      SELECT 1
		      FROM jobs j
		      JOIN files f ON f.id = j.payload->>'fileId'
		      WHERE j.status IN ('pending', 'running')
		        AND f.source_sha256 = a.source_sha256
		  )`, captionTTLDays)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
