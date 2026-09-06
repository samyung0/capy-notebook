package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

type SourceRefreshCandidate struct {
	FileID           string `json:"fileId"`
	JobID            string `json:"jobId"`
	Epoch            int64  `json:"epoch"`
	Checkpoint       int64  `json:"checkpoint"`
	LeaseToken       string `json:"leaseToken"`
	State            []byte `json:"state"`
	SourceBlobPath   string `json:"sourceBlobPath"`
	Format           string `json:"format"`
	BaseSourceURL    string `json:"baseSourceURL"`
	BaseSourceSHA256 string `json:"baseSourceSHA256"`
	BaseRevision     int64  `json:"baseRevision"`
	BaseBlobPath     string `json:"-"`
}

type SourceRefreshFinalize struct {
	JobID        string `json:"jobId"`
	Epoch        int64  `json:"epoch"`
	Checkpoint   int64  `json:"checkpoint"`
	LeaseToken   string `json:"leaseToken"`
	SourceSHA256 string `json:"sourceSHA256"`
	SizeBytes    int64  `json:"sizeBytes"`
	SourceETag   string `json:"sourceETag"`
	Seed         []byte `json:"seed"`
}

type SourceRefreshPublish struct {
	AttemptID                int64           `json:"attemptId" minimum:"1"`
	JobID                    string          `json:"jobId"`
	Epoch                    int64           `json:"epoch"`
	Checkpoint               int64           `json:"checkpoint"`
	LeaseToken               string          `json:"leaseToken"`
	SourceETag               string          `json:"sourceETag"`
	ContentID                string          `json:"contentId"`
	ContentHash              string          `json:"contentHash"`
	PreviewBlobPath          string          `json:"previewBlobPath"`
	Seed                     []byte          `json:"seed"`
	PendingEffects           json.RawMessage `json:"pendingEffects"`
	NetTokens                int64           `json:"netTokens"`
	ExpectedLatestCheckpoint int64           `json:"expectedLatestCheckpoint"`
}

// Refresh attribution comes from the immutable job, never the internal caller.
func sourceRefreshActor(ctx context.Context, tx pgx.Tx, fileID, jobID string) (string, error) {
	var actor string
	err := tx.QueryRow(ctx, `SELECT payload->>'actorUserId' FROM jobs WHERE id=$1 AND payload->>'fileId'=$2 AND payload->>'sourceRefresh'='true'`, jobID, fileID).Scan(&actor)
	if isNoRows(err) {
		return "", ErrConflict
	}
	if err != nil {
		return "", err
	}
	if actor == "" {
		return "", ErrConflict
	}
	return actor, nil
}

// ClaimSourceRefresh serializes export across collaboration instances. The
// candidate token is rotated on each claim; an expired exporter cannot finalize.
func (s *Store) ClaimSourceRefresh(ctx context.Context, fileID, jobID string) (SourceRefreshCandidate, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceRefreshCandidate{}, err
	}
	defer tx.Rollback(ctx)
	actor, err := sourceRefreshActor(ctx, tx, fileID, jobID)
	if err != nil {
		return SourceRefreshCandidate{}, err
	}
	if _, _, err = s.sourceLockTx(ctx, tx, fileID, []string{actor}, true); err != nil {
		var locked *AccountLockedError
		if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) || errors.As(err, &locked) {
			if _, cancelErr := tx.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'failed','authorization','source_access_revoked','Source export access is no longer available')`, jobID); cancelErr != nil {
				return SourceRefreshCandidate{}, cancelErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return SourceRefreshCandidate{}, commitErr
			}
		}
		return SourceRefreshCandidate{}, err
	}
	out := SourceRefreshCandidate{FileID: fileID, JobID: jobID}
	var attempts int
	err = tx.QueryRow(ctx, `SELECT c.epoch,c.checkpoint,c.state,d.format,d.base_blob_path,d.base_source_sha256,d.base_revision,j.attempts FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id JOIN jobs j ON j.id=c.job_id WHERE c.file_id=$1 AND c.job_id=$2 AND d.running_job_id=j.id AND d.epoch=c.epoch AND j.type='source_refresh' AND(j.status='pending' OR(j.status='running' AND j.lease_expires_at<now())) FOR UPDATE OF c,d,j`, fileID, jobID).Scan(&out.Epoch, &out.Checkpoint, &out.State, &out.Format, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.BaseRevision, &attempts)
	if err != nil {
		if isNoRows(err) {
			err = ErrConflict
		}
		return out, err
	}
	if attempts >= 2 {
		const detail = "Source export exceeded its two-attempt limit"
		if _, err = tx.Exec(ctx, `UPDATE source_documents SET running_job_id=NULL,refresh_error=$2 WHERE file_id=$1`, fileID, detail); err != nil {
			return out, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM source_refresh_candidates WHERE file_id=$1`, fileID); err != nil {
			return out, err
		}
		if _, err = tx.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'failed','source_refresh','source_refresh_failed',$2)`, jobID, detail); err != nil {
			return out, err
		}
		if err = tx.Commit(ctx); err != nil {
			return out, err
		}
		return out, ErrConflict
	}
	out.LeaseToken = uid("srclease")
	out.SourceBlobPath = "sources/" + uid("source")
	if _, err = tx.Exec(ctx, `UPDATE source_refresh_candidates SET lease_token=$3,source_blob_path=$4 WHERE file_id=$1 AND job_id=$2`, fileID, jobID, out.LeaseToken, out.SourceBlobPath); err != nil {
		return out, err
	}
	if _, err = tx.Exec(ctx, `UPDATE jobs SET status='running',locked_at=now(),lease_expires_at=now()+interval '5 minutes',attempts=attempts+1,updated_at=now(),payload=jsonb_set(payload,'{sourceLeaseToken}',to_jsonb($2::text)) WHERE id=$1`, jobID, out.LeaseToken); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

// SourceCandidateBlob resolves only the trusted candidate key, never a supplied
// upload destination, before the HTTP layer checks the B2 object's size and ETag.
func (s *Store) SourceCandidateBlob(ctx context.Context, fileID, jobID, lease string) (string, error) {
	var path string
	err := s.pool.QueryRow(ctx, `SELECT c.source_blob_path FROM source_refresh_candidates c JOIN jobs j ON j.id=c.job_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.lease_token=$3 AND j.status='running' AND j.lease_expires_at>now()`, fileID, jobID, lease).Scan(&path)
	if isNoRows(err) {
		err = ErrConflict
	}
	return path, err
}

func (s *Store) FinalizeSourceRefresh(ctx context.Context, fileID string, in SourceRefreshFinalize) error {
	if in.SizeBytes < 0 || len(in.SourceSHA256) != 64 || in.SourceETag == "" {
		return ErrConflict
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	actor, err := sourceRefreshActor(ctx, tx, fileID, in.JobID)
	if err != nil {
		return err
	}
	_, owner, err := s.sourceLockTx(ctx, tx, fileID, []string{actor}, true)
	if err != nil {
		return err
	}
	var format, mode, name, kind string
	var caption bool
	var oldSize int64
	err = tx.QueryRow(ctx, `SELECT d.format,f.parse_mode,f.name,f.kind,f.caption_images,c.size_bytes FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id JOIN files f ON f.id=d.file_id JOIN jobs j ON j.id=c.job_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.epoch=$3 AND c.checkpoint=$4 AND c.lease_token=$5 AND d.epoch=c.epoch AND d.running_job_id=j.id AND f.revision=d.base_revision AND j.status='running' AND j.type='source_refresh' AND j.lease_expires_at>now() FOR UPDATE OF c,d,f,j`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken).Scan(&format, &mode, &name, &kind, &caption, &oldSize)
	if err != nil {
		if isNoRows(err) {
			err = ErrConflict
		}
		return err
	}
	maxBytes, err := s.MaxSourceFileBytes()
	if err != nil {
		return err
	}
	if in.SizeBytes > maxBytes {
		return ErrConflict
	}
	growth := in.SizeBytes - oldSize + int64(len(in.Seed))
	if growth > 0 {
		if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
			return err
		}
	}
	if format != "text" && len(in.Seed) == 0 {
		return ErrConflict
	}
	if mode == "none" {
		mode = "fast"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, mode, caption)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_refresh_candidates SET source_sha256=$6,size_bytes=$7,seed=$8 WHERE file_id=$1 AND job_id=$2 AND epoch=$3 AND checkpoint=$4 AND lease_token=$5`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken, in.SourceSHA256, in.SizeBytes, in.Seed); err != nil {
		return err
	}
	planBytes, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE jobs j SET type=$2,status='pending',attempts=0,locked_at=NULL,lease_expires_at=NULL,queued_at=now(),not_before=NULL,updated_at=now(),payload=payload||jsonb_build_object('blobPath',c.source_blob_path,'sourceETag',$3::text,'sourceSHA256',$4::text,'processingPlan',$5::jsonb) FROM source_refresh_candidates c WHERE j.id=$1 AND c.job_id=j.id`, in.JobID, initialPipelineJobType(plan), in.SourceETag, in.SourceSHA256, planBytes)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PublishSourceRefresh is the only place that replaces a live source and its
// searchable alias. The collaboration room must flush its clients before an
// Office handoff; this transaction rejects any checkpoint accepted meanwhile.
func (s *Store) PublishSourceRefresh(ctx context.Context, fileID string, in SourceRefreshPublish) (SourceSession, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceSession{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return SourceSession{}, err
	}
	// Receipt replay acknowledges committed work even after account or ACL changes.
	var published bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND payload->>'fileId'=$2 AND payload->>'sourceEpoch'=$3 AND payload->>'sourceCheckpoint'=$4 AND payload->>'sourceLeaseToken'=$5 AND payload->>'sourcePublishedCheckpoint'=$4 AND payload->>'sourcePublishedAttemptId'=$6)`, in.JobID, fileID, fmt.Sprint(in.Epoch), fmt.Sprint(in.Checkpoint), in.LeaseToken, fmt.Sprint(in.AttemptID)).Scan(&published); err != nil {
		return SourceSession{}, err
	}
	if published {
		var ws string
		if err = tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, fileID).Scan(&ws); err != nil {
			return SourceSession{}, err
		}
		doc, err := readSourceSession(ctx, tx, fileID, ws)
		if err != nil {
			return doc, err
		}
		return doc, tx.Commit(ctx)
	}
	actor, err := sourceRefreshActor(ctx, tx, fileID, in.JobID)
	if err != nil {
		return SourceSession{}, err
	}
	ws, owner, err := s.sourceLockTx(ctx, tx, fileID, []string{actor}, true)
	if err != nil {
		return SourceSession{}, err
	}
	doc, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return doc, err
	}
	var source, sha string
	var parseKey, parseFingerprint, parseVersion *string
	var size int64
	var candidateState, seed []byte
	err = tx.QueryRow(ctx, `SELECT c.source_blob_path,c.source_sha256,c.size_bytes,c.state,c.seed,c.parse_artifact_key,c.parse_artifact_fingerprint,c.parse_artifact_version FROM source_refresh_candidates c JOIN jobs j ON j.id=c.job_id JOIN files f ON f.id=c.file_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.epoch=$3 AND c.checkpoint=$4 AND c.lease_token=$5 AND f.revision=$6 AND j.status='running' AND j.lease_expires_at>now() AND j.payload->>'sourceETag'=$7 AND c.content_id=$9 AND c.content_hash=$10 AND COALESCE(c.preview_blob_path,'')=$11 AND EXISTS(SELECT 1 FROM ingest_job_attempts a WHERE a.id=$8 AND a.job_id=j.id AND a.status='running' AND a.attempt=j.attempts AND a.id=(SELECT max(latest.id) FROM ingest_job_attempts latest WHERE latest.job_id=j.id)) FOR UPDATE OF c,j,f`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken, doc.BaseRevision, in.SourceETag, in.AttemptID, in.ContentID, in.ContentHash, in.PreviewBlobPath).Scan(&source, &sha, &size, &candidateState, &seed, &parseKey, &parseFingerprint, &parseVersion)
	if err != nil {
		if isNoRows(err) {
			err = ErrConflict
		}
		return doc, err
	}
	if doc.Epoch != in.Epoch || in.Checkpoint > doc.Checkpoint || in.Checkpoint < doc.IndexedCheckpoint || doc.Checkpoint != in.ExpectedLatestCheckpoint {
		return doc, ErrConflict
	}
	effects := in.PendingEffects
	netTokens := in.NetTokens
	if doc.Format != "text" {
		if doc.Checkpoint != in.Checkpoint || len(seed) == 0 {
			return doc, ErrConflict
		}
		effects = json.RawMessage(`[]`)
		netTokens = 0
	} else {
		var parsed []json.RawMessage
		if json.Unmarshal(effects, &parsed) != nil || parsed == nil || netTokens < 0 {
			return doc, ErrConflict
		}
	}
	var contentHash string
	err = tx.QueryRow(ctx, `SELECT content_hash FROM rag_contents WHERE id=$1 AND workspace_id=$2 AND status='ready'`, in.ContentID, ws).Scan(&contentHash)
	if err != nil {
		if isNoRows(err) {
			err = ErrConflict
		}
		return doc, err
	}
	if contentHash != in.ContentHash {
		return doc, ErrConflict
	}
	if doc.Format != "text" && in.PreviewBlobPath == "" {
		return doc, ErrConflict
	}
	var growth int64
	if err = tx.QueryRow(ctx, `SELECT ($2::bigint-f.size_bytes) + CASE WHEN d.format='text' THEN octet_length(d.state)::bigint+octet_length(c.state)+octet_length($3::jsonb::text) ELSE 2*octet_length(c.seed)::bigint+2 END-d.storage_bytes-c.storage_bytes FROM files f JOIN source_documents d ON d.file_id=f.id JOIN source_refresh_candidates c ON c.file_id=f.id WHERE f.id=$1`, fileID, size, effects).Scan(&growth); err != nil {
		return doc, err
	}
	if growth > 0 {
		if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
			return doc, err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES($1,$2,$3) ON CONFLICT(file_id) DO UPDATE SET content_id=EXCLUDED.content_id`, fileID, ws, in.ContentID); err != nil {
		return doc, err
	}
	_, err = tx.Exec(ctx, `UPDATE files SET blob_path=$2,source_sha256=$3,size_bytes=$4,source_etag=$5,preview_blob_path=NULLIF($6,''),content_hash=$7,indexed=true,status='ready',revision=revision+1,ever_parsed_successfully=ever_parsed_successfully OR $8,parsed_blob_path=$9,parsed_fingerprint=$10,parsed_parser_version=$11,caption_blob_path=NULL WHERE id=$1`, fileID, source, sha, size, in.SourceETag, in.PreviewBlobPath, in.ContentHash, doc.Format != "text", parseKey, parseFingerprint, parseVersion)
	if err != nil {
		return doc, err
	}
	if doc.Format != "text" {
		if _, err = tx.Exec(ctx, `UPDATE image_caption_associations a SET published=(a.image_sha256=ANY(c.image_sha256s)) FROM source_refresh_candidates c WHERE c.file_id=$1 AND a.file_id=c.file_id`, fileID); err != nil {
			return doc, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM image_caption_associations WHERE file_id=$1 AND NOT published`, fileID); err != nil {
			return doc, err
		}
	}
	if doc.Format == "text" {
		_, err = tx.Exec(ctx, `UPDATE source_documents SET indexed_checkpoint=$2,indexed_state=$3,base_revision=base_revision+1,base_blob_path=$4,base_source_sha256=$5,pending_effects=$6,net_tokens=$7,desired_manual=desired_manual AND $6::jsonb<>'[]'::jsonb,desired_checkpoint=CASE WHEN $6::jsonb='[]'::jsonb THEN NULL ELSE desired_checkpoint END,running_job_id=NULL,refresh_error=NULL,updated_at=now() WHERE file_id=$1`, fileID, in.Checkpoint, candidateState, source, sha, effects, netTokens)
	} else {
		_, err = tx.Exec(ctx, `UPDATE source_documents SET epoch=epoch+1,indexed_checkpoint=$2,checkpoint=$2,indexed_state=$3,state=$3,base_revision=base_revision+1,base_blob_path=$4,base_source_sha256=$5,pending_effects='[]',net_tokens=0,running_job_id=NULL,desired_checkpoint=NULL,desired_manual=false,refresh_error=NULL,updated_at=now() WHERE file_id=$1`, fileID, in.Checkpoint, seed, source, sha)
	}
	if err != nil {
		return doc, err
	}
	if doc.BaseSourceSHA256 != "" && doc.BaseSourceSHA256 != sha {
		if _, err = tx.Exec(ctx, `DELETE FROM artifact_cache a WHERE a.source_sha256=$1 AND NOT EXISTS(SELECT 1 FROM files f WHERE f.source_sha256=$1) AND NOT EXISTS(SELECT 1 FROM source_documents d WHERE d.base_source_sha256=$1) AND NOT EXISTS(SELECT 1 FROM source_refresh_candidates c WHERE c.source_sha256=$1)`, doc.BaseSourceSHA256); err != nil {
			return doc, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM source_refresh_candidates WHERE file_id=$1`, fileID); err != nil {
		return doc, err
	}
	if _, err = tx.Exec(ctx, `UPDATE jobs SET payload=payload||jsonb_build_object('sourcePublishedCheckpoint',$2::bigint,'sourcePublishedAttemptId',$3::bigint),updated_at=now() WHERE id=$1`, in.JobID, in.Checkpoint, in.AttemptID); err != nil {
		return doc, err
	}
	out, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (s *Store) FailSourceRefresh(ctx context.Context, fileID, jobID, lease, detail string, stale bool) error {
	if len(detail) > 2000 {
		detail = detail[:2000]
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return err
	}
	actor, err := sourceRefreshActor(ctx, tx, fileID, jobID)
	if err != nil {
		return err
	}
	var workspaceID string
	if err = tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, fileID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return ErrConflict
		}
		return err
	}
	owner, err := s.storageOwnerTx(ctx, tx, workspaceID)
	if err != nil {
		return err
	}
	// Cleanup follows source lock order without requiring continued access.
	// SHARE also permits another actor's cancellation to append owner storage deltas.
	if _, err = tx.Exec(ctx, `SELECT id FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`, []string{owner, actor}); err != nil {
		return err
	}
	var locked string
	err = tx.QueryRow(ctx, `SELECT c.file_id FROM source_refresh_candidates c JOIN jobs j ON j.id=c.job_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.lease_token=$3 AND j.type='source_refresh' AND j.status='running' AND j.lease_expires_at>now() FOR UPDATE OF c,j`, fileID, jobID, lease).Scan(&locked)
	if err != nil {
		if isNoRows(err) {
			err = ErrConflict
		}
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET running_job_id=NULL,refresh_error=CASE WHEN $3 THEN NULL ELSE $2 END,desired_checkpoint=CASE WHEN $3 THEN checkpoint ELSE desired_checkpoint END WHERE file_id=$1`, fileID, detail, stale); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM source_refresh_candidates WHERE file_id=$1`, fileID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'failed','source_refresh','source_refresh_failed',$2)`, jobID, detail); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// WorkspaceIndexCounts partitions logical files by their current searchable
// alias and the canonical upload route, independent of a transient job status.
func (s *Store) workspaceIndexCounts(ctx context.Context, ws string, stats *WorkspaceStats) error {
	rows, err := s.pool.Query(ctx, `SELECT f.name,f.kind,EXISTS(SELECT 1 FROM rag_file_contents a JOIN rag_contents c ON c.id=a.content_id WHERE a.file_id=f.id AND c.status='ready'),COALESCE(d.net_tokens>0 OR d.pending_effects<>'[]'::jsonb,false),COALESCE(d.format,'') FROM files f LEFT JOIN source_documents d ON d.file_id=f.id WHERE f.workspace_id=$1`, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name, kind, format string
		var indexed, pending bool
		if err = rows.Scan(&name, &kind, &indexed, &pending, &format); err != nil {
			return err
		}
		plan, e := sourceupload.BuildProcessingPlan(name, kind, "fast", false)
		switch {
		case indexed:
			stats.Indexed++
		case e == nil && plan.Route != sourceupload.RouteStoreOnly:
			stats.NotIndexed++
		default:
			stats.NotIndexable++
		}
		if pending {
			if format == "text" {
				stats.PendingReindex++
			} else {
				stats.PendingReparse++
			}
		}
	}
	return rows.Err()
}
