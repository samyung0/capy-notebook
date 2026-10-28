package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// A clone's index copies in the background (Epo 2026-10-27/28,
// todo-clone-download.md): the clone request gives the copy its own
// 'processing' content row in the target, claimed by one index_copy job, and
// marks its files processing; the gateway's copy worker (RunIndexCopy) copies
// the passages and vectors indexCopyBatch at a time, so no transaction stays
// open for seconds, then serves the content to the files in one transaction.
// Each vector re-enters the HNSW index, which is most of a clone's cost
// (bench/clone/reports/2026-10-28-index-copy-parts.md).
const (
	indexCopyBatch    = 250
	indexCopyLease    = 2 * time.Minute
	indexCopyAttempts = 3
)

// indexCopyJob is an index_copy job's payload. FileID is the first of FileIDs
// (every copied file holding the content), named like the pipeline jobs'
// fileId so file-scoped job checks find it.
type indexCopyJob struct {
	FileID          string   `json:"fileId"`
	FileIDs         []string `json:"fileIds"`
	WorkspaceID     string   `json:"workspaceId"`
	SourceContentID string   `json:"sourceContentId"`
	ContentID       string   `json:"contentId"`
	ContentHash     string   `json:"contentHash"`
	ActorUserID     string   `json:"actorUserId"`
}

// IndexCopyEvent is one file's progress, published like the pipeline's
// ingest events (pipeline/pipeline/progress.py) on ingest:{WorkspaceID}.
type IndexCopyEvent struct {
	FileID      string `json:"fileId"`
	WorkspaceID string `json:"workspaceId"`
	Stage       string `json:"stage"`
	Pct         int    `json:"pct"`
	Status      string `json:"status"`
	Message     string `json:"message"`
	Indexed     *bool  `json:"indexed,omitempty"`
}

var (
	// The job is no longer this attempt's: cancelled, reaped or done.
	errIndexCopyClaimLost = errors.New("index copy claim lost")
	// The source content was deleted or replaced: the copy is ingested.
	errIndexCopySourceGone = errors.New("index copy source gone")
	// The copy's content row is gone: its workspace was deleted, or its claim
	// was taken; files still there are served or ingested another way.
	errIndexCopyTargetGone = errors.New("index copy target gone")
)

// queueIndexCopiesTx gives copied files (old id -> new id) the source
// workspace's ready index in dstID: files whose content dstID already holds
// ready are aliased at once (indexed); content dstID lacks is queued for the
// copy worker when both workspaces embed in one space (queued), the files
// marked processing. Any other file (another space, or the target still
// building the same content) is left for the caller to ingest.
func queueIndexCopiesTx(ctx context.Context, tx pgx.Tx, actorID, srcID, dstID string, fileMap map[string]string) (indexed, queued map[string]bool, err error) {
	indexed, queued = map[string]bool{}, map[string]bool{}
	oldFiles, _ := unzipIDs(fileMap)
	if len(oldFiles) == 0 {
		return indexed, queued, nil
	}
	var samePin bool
	if err := tx.QueryRow(ctx, `SELECT (a.embedding_provider_slug, a.embedding_model_slug, a.embedding_model_version, a.embedding_dim)
			IS NOT DISTINCT FROM (b.embedding_provider_slug, b.embedding_model_slug, b.embedding_model_version, b.embedding_dim)
		FROM workspaces a, workspaces b WHERE a.id=$1 AND b.id=$2`, srcID, dstID).Scan(&samePin); err != nil {
		return nil, nil, err
	}
	type content struct {
		hash             string
		held, heldStatus *string
		files            []string
	}
	contents := map[string]*content{}
	rows, err := tx.Query(ctx, `SELECT fc.file_id, rc.id, rc.content_hash, dst.id, dst.status
		FROM rag_file_contents fc
		JOIN rag_contents rc ON rc.id=fc.content_id AND rc.status='ready' AND rc.workspace_id=$2
		LEFT JOIN rag_contents dst ON dst.workspace_id=$3 AND dst.content_hash=rc.content_hash
		WHERE fc.file_id = ANY($1::text[])`, oldFiles, srcID, dstID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var fileID, sourceID, hash string
		var held, heldStatus *string
		if err := rows.Scan(&fileID, &sourceID, &hash, &held, &heldStatus); err != nil {
			rows.Close()
			return nil, nil, err
		}
		c := contents[sourceID]
		if c == nil {
			c = &content{hash: hash, held: held, heldStatus: heldStatus}
			contents[sourceID] = c
		}
		c.files = append(c.files, fileMap[fileID])
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	for sourceID, c := range contents {
		switch {
		case c.held != nil && *c.heldStatus == "ready":
			if _, err := tx.Exec(ctx, `INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
				SELECT f, $2, $3 FROM unnest($1::text[]) f`, c.files, dstID, *c.held); err != nil {
				return nil, nil, err
			}
			for _, id := range c.files {
				indexed[id] = true
			}
		case c.held == nil && samePin:
			jobID, contentID := uid("job"), uid("rgc")
			// rag_contents is unique per workspace and content hash: an ingest
			// that added this content to the target after the snapshot is a
			// serialization failure, so the clone retries on a snapshot that
			// holds it (as copyRetrievalContents does).
			if _, err := tx.Exec(ctx, `INSERT INTO rag_contents (id, workspace_id, content_hash, status,
					embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim,
					source_sha256, pipeline_identity, claim_job_id)
				SELECT $1, $2, content_hash, 'processing',
					embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim,
					source_sha256, pipeline_identity, $3
				FROM rag_contents WHERE id=$4`, contentID, dstID, jobID, sourceID); isUniqueViolation(err) {
				return nil, nil, &pgconn.PgError{Code: "40001", Message: "clone index raced an ingest of the same content"}
			} else if err != nil {
				return nil, nil, err
			}
			payload, err := json.Marshal(indexCopyJob{
				FileID: c.files[0], FileIDs: c.files, WorkspaceID: dstID,
				SourceContentID: sourceID, ContentID: contentID, ContentHash: c.hash, ActorUserID: actorID,
			})
			if err != nil {
				return nil, nil, err
			}
			if _, err := tx.Exec(ctx, `INSERT INTO jobs (id, type, payload) VALUES ($1, 'index_copy', $2)`, jobID, payload); err != nil {
				return nil, nil, err
			}
			// A ready copy shows processing until its index arrives; a partial
			// one keeps failed (its parts are its owner's to retry).
			if _, err := tx.Exec(ctx, `UPDATE files SET indexed=false,
				status=CASE WHEN status='ready' THEN 'processing' ELSE status END
				WHERE id = ANY($1::text[])`, c.files); err != nil {
				return nil, nil, err
			}
			for _, id := range c.files {
				queued[id] = true
			}
		}
	}
	return indexed, queued, nil
}

// RunIndexCopy reaps index_copy jobs whose worker died, claims one due job
// and runs it to its end, reporting each file's progress to publish. It
// answers false when no job was due.
func (s *Store) RunIndexCopy(ctx context.Context, publish func(IndexCopyEvent)) (bool, error) {
	if _, err := s.pool.Exec(ctx, `UPDATE jobs SET status='pending', locked_at=NULL, lease_expires_at=NULL,
			queued_at=now(), updated_at=now()
		WHERE type='index_copy' AND status='running' AND lease_expires_at < now()`); err != nil {
		return false, err
	}
	var jobID string
	var raw []byte
	var attempt int
	err := s.pool.QueryRow(ctx, `UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1,
			lease_expires_at=now() + make_interval(secs => $1), updated_at=now()
		WHERE id = (SELECT id FROM jobs WHERE type='index_copy' AND status='pending'
			AND (not_before IS NULL OR not_before <= now())
			ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
		RETURNING id, payload, attempts`, indexCopyLease.Seconds()).Scan(&jobID, &raw, &attempt)
	if isNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var job indexCopyJob
	if err := json.Unmarshal(raw, &job); err != nil {
		return true, err
	}
	if err := s.copyIndex(ctx, jobID, attempt, job, publish); err != nil {
		return true, s.failIndexCopy(ctx, jobID, attempt, job, err, publish)
	}
	return true, nil
}

// fenceIndexCopyTx locks the job while this attempt still owns it and
// renews its lease.
func fenceIndexCopyTx(ctx context.Context, tx pgx.Tx, jobID string, attempt int) error {
	tag, err := tx.Exec(ctx, `UPDATE jobs SET lease_expires_at=now() + make_interval(secs => $3), updated_at=now()
		WHERE id=$1 AND attempts=$2 AND status='running'`, jobID, attempt, indexCopyLease.Seconds())
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errIndexCopyClaimLost
	}
	return nil
}

func (s *Store) copyIndex(ctx context.Context, jobID string, attempt int, job indexCopyJob, publish func(IndexCopyEvent)) error {
	var pin models.Pin
	var total int
	// The target's pin names the vector table on both sides: the clone
	// queued the copy only within one space (queueIndexCopiesTx).
	err := s.pool.QueryRow(ctx, `SELECT w.embedding_provider_slug, w.embedding_model_slug, w.embedding_model_version,
			(SELECT count(*) FROM rag_chunks WHERE content_id=rc.id)
		FROM rag_contents rc, workspaces w WHERE rc.id=$1 AND rc.status='ready' AND w.id=$2`, job.SourceContentID, job.WorkspaceID).
		Scan(&pin.ProviderSlug, &pin.ModelSlug, &pin.Version, &total)
	if isNoRows(err) {
		return errIndexCopySourceGone
	}
	if err != nil {
		return err
	}
	if total == 0 {
		return s.finishIndexCopy(ctx, jobID, attempt, job, publish)
	}
	vectors, err := vectorTable(pin)
	if err != nil {
		return err
	}
	// Dest chunk ids derive from the copy's content id, as in
	// copyRetrievalContents, so a batch repeated after a crash is a no-op.
	const newChunkID = `'rc_' || substr(md5($2 || c.id), 1, 12)`
	for {
		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return err
		}
		copied, done, err := func() (int, bool, error) {
			defer tx.Rollback(ctx)
			if err := fenceIndexCopyTx(ctx, tx, jobID, attempt); err != nil {
				return 0, false, err
			}
			var sourceReady, targetClaimed bool
			var after int
			if err := tx.QueryRow(ctx, `SELECT
					EXISTS (SELECT 1 FROM rag_contents WHERE id=$1 AND status='ready'),
					EXISTS (SELECT 1 FROM rag_contents WHERE id=$2 AND status='processing' AND claim_job_id=$3),
					(SELECT COALESCE(max(chunk_idx), -1) FROM rag_chunks WHERE content_id=$2)`,
				job.SourceContentID, job.ContentID, jobID).Scan(&sourceReady, &targetClaimed, &after); err != nil {
				return 0, false, err
			}
			if !targetClaimed {
				return 0, false, errIndexCopyTargetGone
			}
			if !sourceReady {
				return 0, false, errIndexCopySourceGone
			}
			tag, err := tx.Exec(ctx, `INSERT INTO rag_chunks
				(id, content_id, chunk_idx, section_path, text, indexed_text, token_count, page_start, page_end,
				 regions, lang, search, confidence, confidence_reasons)
				SELECT `+newChunkID+`, $2, c.chunk_idx, c.section_path, c.text, c.indexed_text, c.token_count,
					c.page_start, c.page_end, c.regions, c.lang, c.search, c.confidence, c.confidence_reasons
				FROM rag_chunks c WHERE c.content_id=$1 AND c.chunk_idx > $3
				ORDER BY c.chunk_idx LIMIT $4
				ON CONFLICT (id) DO NOTHING`, job.SourceContentID, job.ContentID, after, indexCopyBatch)
			if err != nil {
				return 0, false, err
			}
			n := int(tag.RowsAffected())
			if n > 0 {
				if _, err := tx.Exec(ctx, `INSERT INTO `+vectors+` (chunk_id, content_id, embedding)
					SELECT `+newChunkID+`, $2, v.embedding
					FROM rag_chunks c JOIN `+vectors+` v ON v.chunk_id=c.id
					WHERE c.content_id=$1 AND c.chunk_idx > $3
						AND c.chunk_idx <= (SELECT max(chunk_idx) FROM rag_chunks WHERE content_id=$2)
					ON CONFLICT (chunk_id) DO NOTHING`, job.SourceContentID, job.ContentID, after); err != nil {
					return 0, false, err
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return 0, false, err
			}
			return after + 1 + n, n < indexCopyBatch, nil
		}()
		if err != nil {
			return err
		}
		if done {
			break
		}
		pct := 99
		if total > 0 {
			pct = min(99, copied*100/total)
		}
		for _, fileID := range job.FileIDs {
			publish(IndexCopyEvent{FileID: fileID, WorkspaceID: job.WorkspaceID, Stage: "copy_index", Pct: pct, Status: "processing"})
		}
	}
	return s.finishIndexCopy(ctx, jobID, attempt, job, publish)
}

// finishIndexCopy serves the copy to the files still in its workspace, in
// one transaction; with none left it drops the copy.
func (s *Store) finishIndexCopy(ctx context.Context, jobID string, attempt int, job indexCopyJob, publish func(IndexCopyEvent)) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fenceIndexCopyTx(ctx, tx, jobID, attempt); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO rag_content_summaries (content_id, fingerprint, descriptor, change_share, updated_at)
		SELECT $2, fingerprint, descriptor, change_share, updated_at FROM rag_content_summaries WHERE content_id=$1
		ON CONFLICT (content_id) DO NOTHING`, job.SourceContentID, job.ContentID); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
		SELECT f.id, f.workspace_id, $3 FROM files f WHERE f.id = ANY($1::text[]) AND f.workspace_id=$2
		ON CONFLICT (file_id) DO NOTHING RETURNING file_id`, job.FileIDs, job.WorkspaceID, job.ContentID)
	if err != nil {
		return err
	}
	served, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(served) == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM rag_contents WHERE id=$1`, job.ContentID); err != nil {
			return err
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE rag_contents SET status='ready', claim_job_id=NULL, updated_at=now() WHERE id=$1`, job.ContentID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE files SET indexed=true,
			status=CASE WHEN status='processing' THEN 'ready' ELSE status END
			WHERE id = ANY($1::text[])`, served); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET status='done', locked_at=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1`, jobID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	ready := true
	for _, fileID := range served {
		publish(IndexCopyEvent{FileID: fileID, WorkspaceID: job.WorkspaceID, Stage: "copy_index", Pct: 100, Status: "ready", Indexed: &ready})
	}
	return nil
}

// failIndexCopy retries a failed attempt later, up to indexCopyAttempts; past
// them, or once the source is gone, the copy is dropped and its files are
// ingested as a cross-space clone is, paid by the cloner (a refusal, such as
// no credits, fails the file, which its owner can retry).
func (s *Store) failIndexCopy(ctx context.Context, jobID string, attempt int, job indexCopyJob, cause error, publish func(IndexCopyEvent)) error {
	if errors.Is(cause, errIndexCopyClaimLost) {
		return nil
	}
	if !errors.Is(cause, errIndexCopySourceGone) && !errors.Is(cause, errIndexCopyTargetGone) && attempt < indexCopyAttempts {
		_, err := s.pool.Exec(ctx, `UPDATE jobs SET status='pending', error=$3, locked_at=NULL, lease_expires_at=NULL,
				not_before=now() + make_interval(secs => $4), queued_at=now(), updated_at=now()
			WHERE id=$1 AND attempts=$2 AND status='running'`, jobID, attempt, cause.Error(), 30*attempt)
		return errors.Join(cause, err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fenceIndexCopyTx(ctx, tx, jobID, attempt); err != nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM rag_contents WHERE id=$1 AND claim_job_id=$2`, job.ContentID, jobID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET status='failed', error=$2, locked_at=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1`,
		jobID, cause.Error()); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if errors.Is(cause, errIndexCopyTargetGone) {
		// A same-content ingest took the claim: its ready content serves the
		// files at once; else they are ingested and wait on it.
		served, err := s.aliasCopiedFiles(ctx, job)
		if err != nil {
			return err
		}
		ready := true
		for _, fileID := range served {
			publish(IndexCopyEvent{FileID: fileID, WorkspaceID: job.WorkspaceID, Stage: "copy_index", Pct: 100, Status: "ready", Indexed: &ready})
		}
		job.FileIDs = slices.DeleteFunc(job.FileIDs, func(id string) bool { return slices.Contains(served, id) })
	}
	for _, fileID := range job.FileIDs {
		status, err := s.ingestCopiedFile(ctx, job.ActorUserID, job.WorkspaceID, fileID)
		if err != nil {
			return fmt.Errorf("ingest copied file %s: %w", fileID, err)
		}
		if status != "" {
			publish(IndexCopyEvent{FileID: fileID, WorkspaceID: job.WorkspaceID, Stage: "copy_index", Status: status})
		}
	}
	return nil
}

// aliasCopiedFiles serves a copy's files still in its workspace from the
// workspace's ready content with the same hash, when there is one.
func (s *Store) aliasCopiedFiles(ctx context.Context, job indexCopyJob) ([]string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
		SELECT f.id, f.workspace_id, rc.id FROM files f
		JOIN rag_contents rc ON rc.workspace_id=f.workspace_id AND rc.content_hash=$3 AND rc.status='ready'
		WHERE f.id = ANY($1::text[]) AND f.workspace_id=$2 AND f.status IN ('processing','failed')
		ON CONFLICT (file_id) DO NOTHING RETURNING file_id`, job.FileIDs, job.WorkspaceID, job.ContentHash)
	if err != nil {
		return nil, err
	}
	served, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET indexed=true,
		status=CASE WHEN status='processing' THEN 'ready' ELSE status END
		WHERE id = ANY($1::text[])`, served); err != nil {
		return nil, err
	}
	return served, tx.Commit(ctx)
}

// ingestCopiedFile queues the ingest of a copy whose index could not be
// copied; refused (no credits, the job cap), the file fails. It answers the
// file's new status, or "" when the file left its workspace meanwhile.
func (s *Store) ingestCopiedFile(ctx context.Context, actorID, workspaceID, fileID string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var f workspaceCloneFile
	err = tx.QueryRow(ctx, `SELECT f.id, f.name, f.kind, f.parser, f.blob_path, f.source_etag, f.parse_mode,
			f.ever_parsed_successfully, f.revision
		FROM files f WHERE f.id=$1 AND f.workspace_id=$2 AND f.status IN ('processing','failed') FOR UPDATE`, fileID, workspaceID).
		Scan(&f.id, &f.name, &f.kind, &f.parser, &f.blobPath, &f.sourceETag, &f.parseMode, &f.everParsed, &f.revision)
	if isNoRows(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if err := s.queueCloneIngestTx(ctx, tx, actorID, workspaceID, fileID, f); err == nil {
		return "pending", tx.Commit(ctx)
	}
	tx.Rollback(ctx)
	if _, err := s.pool.Exec(ctx, `UPDATE files SET status='failed', indexed=false WHERE id=$1 AND status IN ('processing','failed')`, fileID); err != nil {
		return "", err
	}
	return "failed", nil
}
