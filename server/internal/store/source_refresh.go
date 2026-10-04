package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

type SourceRefreshCandidate struct {
	FileID     string `json:"fileId"`
	JobID      string `json:"jobId"`
	Epoch      int64  `json:"epoch"`
	Checkpoint int64  `json:"checkpoint"`
	LeaseToken string `json:"leaseToken"`
	// Null when the captured state is seed(base). With StateSeedSHA256 it is
	// the change over seed(base), as in SourceSession.
	State            []byte  `json:"state" nullable:"true"`
	StateSeedSHA256  *string `json:"stateSeedSHA256" nullable:"true"`
	SourceBlobPath   string  `json:"sourceBlobPath"`
	Format           string  `json:"format"`
	BaseSourceURL    string  `json:"baseSourceURL"`
	BaseSourceSHA256 string  `json:"baseSourceSHA256"`
	BaseRevision     int64   `json:"baseRevision"`
	BaseBlobPath     string  `json:"-"`
}

type SourceRefreshFinalize struct {
	JobID        string `json:"jobId"`
	Epoch        int64  `json:"epoch"`
	Checkpoint   int64  `json:"checkpoint"`
	LeaseToken   string `json:"leaseToken"`
	SourceSHA256 string `json:"sourceSHA256"`
	SizeBytes    int64  `json:"sizeBytes"`
	SourceETag   string `json:"sourceETag"`
}

type SourceRefreshPublish struct {
	AttemptID      int64           `json:"attemptId" minimum:"1"`
	JobID          string          `json:"jobId"`
	Epoch          int64           `json:"epoch"`
	Checkpoint     int64           `json:"checkpoint"`
	LeaseToken     string          `json:"leaseToken"`
	SourceETag     string          `json:"sourceETag"`
	ContentID      string          `json:"contentId"`
	ContentHash    string          `json:"contentHash"`
	PendingEffects json.RawMessage `json:"pendingEffects"`
	NetTokens      int64           `json:"netTokens"`
	// Office only, and only when edits saved after the capture were rebased
	// onto the export: the rebased state, stored as its change over
	// seed(export), whose SHA-256 RebasedStateSeedSHA256 is. Without them the
	// state returns to seed(export). The baseline always derives from the export.
	RebasedState             []byte `json:"rebasedState,omitempty"`
	RebasedStateSeedSHA256   string `json:"rebasedStateSeedSHA256,omitempty"`
	ExpectedLatestCheckpoint int64  `json:"expectedLatestCheckpoint"`
	// Office work of the owner or of automatic processing: publish the file
	// and its index while editing stays on its base, with effects measured
	// against the captured state (no rebased state); the collaboration service
	// rebuilds onto the published file once the room is empty (RebuildSource).
	// A maintenance (system) publication never defers.
	Deferred bool `json:"deferred,omitempty"`
}

// refreshJob is a refresh's attribution, read from the immutable job, never
// from the internal caller. system marks a maintenance job (paid_by system);
// exportOnly one that publishes without parsing.
type refreshJob struct {
	actor              string
	system, exportOnly bool
}

func sourceRefreshJob(ctx context.Context, tx pgx.Tx, fileID, jobID string) (refreshJob, error) {
	var job refreshJob
	err := tx.QueryRow(ctx, `SELECT COALESCE(payload->>'actorUserId',''),COALESCE(payload->>'paidBy'='system',false),COALESCE((payload->>'exportOnly')::boolean,false) FROM jobs WHERE id=$1 AND payload->>'fileId'=$2 AND payload->>'sourceRefresh'='true'`, jobID, fileID).Scan(&job.actor, &job.system, &job.exportOnly)
	if isNoRows(err) {
		return job, ErrConflict
	}
	if err != nil {
		return job, err
	}
	if job.actor == "" {
		return job, ErrConflict
	}
	return job, nil
}

// refreshLockTx: a maintenance job skips the owner's account state and the
// trash (maintenanceLockTx); any other job needs current edit access.
func (s *Store) refreshLockTx(ctx context.Context, tx pgx.Tx, fileID string, job refreshJob) (string, string, error) {
	if job.system {
		return s.maintenanceLockTx(ctx, tx, fileID)
	}
	return s.sourceEditLockTx(ctx, tx, fileID, job.actor)
}

// ClaimSourceRefresh serializes export across collaboration instances. The
// candidate token is rotated on each claim; an expired exporter cannot finalize.
func (s *Store) ClaimSourceRefresh(ctx context.Context, fileID, jobID string) (SourceRefreshCandidate, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SourceRefreshCandidate{}, err
	}
	defer tx.Rollback(ctx)
	job, err := sourceRefreshJob(ctx, tx, fileID, jobID)
	if err != nil {
		return SourceRefreshCandidate{}, err
	}
	if _, _, err = s.refreshLockTx(ctx, tx, fileID, job); err != nil {
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
	// Copy-on-write: while no save has landed since the capture, the captured
	// state is the row's own (NULL for both: seed(base)).
	err = tx.QueryRow(ctx, `SELECT c.epoch,c.checkpoint,CASE WHEN c.checkpoint=d.checkpoint THEN d.state ELSE c.state END,CASE WHEN c.checkpoint=d.checkpoint THEN d.state_seed_sha256 ELSE c.state_seed_sha256 END,d.format,d.base_blob_path,d.base_source_sha256,d.base_revision,j.attempts FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id JOIN jobs j ON j.id=c.job_id WHERE c.file_id=$1 AND c.job_id=$2 AND d.running_job_id=j.id AND d.epoch=c.epoch AND j.type='source_refresh' AND(j.status='pending' OR(j.status='running' AND j.lease_expires_at<now())) FOR UPDATE OF c,d,j`, fileID, jobID).Scan(&out.Epoch, &out.Checkpoint, &out.State, &out.StateSeedSHA256, &out.Format, &out.BaseBlobPath, &out.BaseSourceSHA256, &out.BaseRevision, &attempts)
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
	job, err := sourceRefreshJob(ctx, tx, fileID, in.JobID)
	if err != nil {
		return err
	}
	_, owner, err := s.refreshLockTx(ctx, tx, fileID, job)
	if err != nil {
		return err
	}
	var format, mode, name, kind, sourcePath string
	err = tx.QueryRow(ctx, `SELECT d.format,f.parse_mode,f.name,f.kind,COALESCE(c.source_blob_path,'') FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id JOIN files f ON f.id=d.file_id JOIN jobs j ON j.id=c.job_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.epoch=$3 AND c.checkpoint=$4 AND c.lease_token=$5 AND d.epoch=c.epoch AND d.running_job_id=j.id AND f.revision=d.base_revision AND (f.trashed_at IS NULL OR $6) AND j.status='running' AND j.type='source_refresh' AND j.lease_expires_at>now() FOR UPDATE OF c,d,f,j`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken, job.system).Scan(&format, &mode, &name, &kind, &sourcePath)
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
	// The candidate is uncharged while transient, and publication gates the
	// net growth. Before paying for a parse, refuse what publication would
	// certainly refuse: it charges at least the new bytes and a source row
	// with no state or effects (0 bytes) in place of the current row; later
	// saves are charged when they land.
	if !job.system {
		var growth int64
		if err = tx.QueryRow(ctx, `SELECT $2::bigint-f.size_bytes-d.storage_bytes FROM files f JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1`, fileID, in.SizeBytes).Scan(&growth); err != nil {
			return err
		}
		if growth > 0 {
			if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
				return err
			}
		}
	}
	if job.exportOnly && job.system {
		// Maintenance, with editing paused: publish in this transaction.
		published, err := s.publishExportTx(ctx, tx, fileID, sourcePath, in)
		if err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil || published {
			return err
		}
		return ErrConflict
	}
	if mode == "none" {
		mode = "fast"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, mode)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_refresh_candidates SET source_sha256=$6,size_bytes=$7 WHERE file_id=$1 AND job_id=$2 AND epoch=$3 AND checkpoint=$4 AND lease_token=$5`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken, in.SourceSHA256, in.SizeBytes); err != nil {
		return err
	}
	planBytes, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	// An owner's export-only candidate stays a running source_refresh job: the
	// collaboration service publishes it next through the handoff
	// (PublishSourceRefresh), under a lease renewed here for that handoff. Any
	// other job continues as its parse.
	jobType, requeue := initialPipelineJobType(plan), true
	if job.exportOnly {
		jobType, requeue = "source_refresh", false
	}
	_, err = tx.Exec(ctx, `UPDATE jobs j SET type=$2,status=CASE WHEN $6 THEN 'pending' ELSE j.status END,attempts=CASE WHEN $6 THEN 0 ELSE j.attempts END,locked_at=CASE WHEN $6 THEN NULL ELSE j.locked_at END,lease_expires_at=CASE WHEN $6 THEN NULL ELSE now()+interval '5 minutes' END,queued_at=CASE WHEN $6 THEN now() ELSE j.queued_at END,not_before=NULL,updated_at=now(),payload=payload||jsonb_build_object('blobPath',c.source_blob_path,'sourceETag',$3::text,'sourceSHA256',$4::text,'processingPlan',$5::jsonb) FROM source_refresh_candidates c WHERE j.id=$1 AND c.job_id=j.id`, in.JobID, jobType, in.SourceETag, in.SourceSHA256, planBytes, requeue)
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
		if err = tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1 AND trashed_at IS NULL`, fileID).Scan(&ws); err != nil {
			return SourceSession{}, err
		}
		doc, err := readSourceSession(ctx, tx, fileID, ws)
		if err != nil {
			return doc, err
		}
		return doc, tx.Commit(ctx)
	}
	job, err := sourceRefreshJob(ctx, tx, fileID, in.JobID)
	if err != nil {
		return SourceSession{}, err
	}
	ws, owner, err := s.refreshLockTx(ctx, tx, fileID, job)
	if err != nil {
		return SourceSession{}, err
	}
	doc, err := readSourceSession(ctx, tx, fileID, ws)
	if err != nil {
		return doc, err
	}
	var source, sha string
	var size int64
	if job.exportOnly {
		// An export-only publication through the handoff: no parse, index or
		// ingest attempt, only the finalized export.
		err = tx.QueryRow(ctx, `SELECT c.source_blob_path,c.source_sha256,c.size_bytes FROM source_refresh_candidates c JOIN jobs j ON j.id=c.job_id JOIN files f ON f.id=c.file_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.epoch=$3 AND c.checkpoint=$4 AND c.lease_token=$5 AND f.revision=$6 AND f.trashed_at IS NULL AND j.type='source_refresh' AND j.status='running' AND j.lease_expires_at>now() AND j.payload->>'sourceETag'=$7 AND c.source_sha256 IS NOT NULL FOR UPDATE OF c,j,f`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken, doc.BaseRevision, in.SourceETag).Scan(&source, &sha, &size)
	} else {
		err = tx.QueryRow(ctx, `SELECT c.source_blob_path,c.source_sha256,c.size_bytes FROM source_refresh_candidates c JOIN jobs j ON j.id=c.job_id JOIN files f ON f.id=c.file_id WHERE c.file_id=$1 AND c.job_id=$2 AND c.epoch=$3 AND c.checkpoint=$4 AND c.lease_token=$5 AND f.revision=$6 AND f.trashed_at IS NULL AND j.status='running' AND j.lease_expires_at>now() AND j.payload->>'sourceETag'=$7 AND c.content_id=$9 AND c.content_hash=$10 AND EXISTS(SELECT 1 FROM ingest_job_attempts a WHERE a.id=$8 AND a.job_id=j.id AND a.status='running' AND a.attempt=j.attempts AND a.id=(SELECT max(latest.id) FROM ingest_job_attempts latest WHERE latest.job_id=j.id)) FOR UPDATE OF c,j,f`, fileID, in.JobID, in.Epoch, in.Checkpoint, in.LeaseToken, doc.BaseRevision, in.SourceETag, in.AttemptID, in.ContentID, in.ContentHash).Scan(&source, &sha, &size)
	}
	if err != nil {
		if isNoRows(err) {
			err = ErrConflict
		}
		return doc, err
	}
	if doc.Epoch != in.Epoch || in.Checkpoint > doc.Checkpoint || in.Checkpoint < doc.IndexedCheckpoint || doc.Checkpoint != in.ExpectedLatestCheckpoint {
		return doc, ErrConflict
	}
	if in.Deferred != (doc.Format != "text" && !job.system) {
		return doc, ErrConflict
	}
	effects := in.PendingEffects
	netTokens := in.NetTokens
	var parsed []json.RawMessage
	if json.Unmarshal(effects, &parsed) != nil || parsed == nil || netTokens < 0 {
		return doc, ErrConflict
	}
	// A NULL state: with no edits after the capture it returns to
	// seed(export). Only a rebase of later edits stores one, as its change
	// over seed(export) with that seed's SHA-256. Text never stores either.
	var state []byte
	if len(in.RebasedState) > 0 {
		state = in.RebasedState
	}
	stateSeed := in.RebasedStateSeedSHA256
	switch {
	case doc.Format == "text" || in.Deferred:
		if state != nil || stateSeed != "" {
			return doc, ErrConflict
		}
	case state == nil:
		if stateSeed != "" || doc.Checkpoint != in.Checkpoint || len(parsed) != 0 {
			return doc, ErrConflict
		}
	case len(state) > 100<<20 || doc.Checkpoint == in.Checkpoint || !sha256Hex(stateSeed):
		return doc, ErrConflict
	}
	if !job.exportOnly {
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
	}
	// A deferred publication keeps the captured state on the old base: pending
	// effects are measured against it until the rebuild. The candidate row
	// goes below, so it is copied first. It is what the export was built from.
	var captured []byte
	var capturedSeed *string
	var replacedSHA string
	if err = tx.QueryRow(ctx, `SELECT CASE WHEN c.checkpoint=d.checkpoint THEN d.state ELSE c.state END,CASE WHEN c.checkpoint=d.checkpoint THEN d.state_seed_sha256 ELSE c.state_seed_sha256 END,COALESCE(f.source_sha256,'') FROM source_refresh_candidates c JOIN source_documents d ON d.file_id=c.file_id JOIN files f ON f.id=c.file_id WHERE c.file_id=$1 AND c.job_id=$2`, fileID, in.JobID).Scan(&captured, &capturedSeed, &replacedSHA); err != nil {
		return doc, err
	}
	// The file's new bytes plus its storage_bytes afterwards (migration 0054's
	// rule) minus before. A text state's seed size moves with the file's size,
	// and a deferred Office state is charged beyond the capture the file now
	// holds; any other Office state as stored.
	if in.Deferred {
		state = doc.State
	}
	var growth, resized int64
	if err = tx.QueryRow(ctx, `SELECT ($2::bigint-f.size_bytes)+COALESCE(octet_length(NULLIF($3::jsonb,'[]'::jsonb)::text),0)+CASE WHEN d.format='text' THEN GREATEST(0,COALESCE(octet_length(d.state),0)-(d.seed_bytes+$2::bigint-f.size_bytes)) WHEN $5 THEN GREATEST(0,COALESCE(octet_length($4::bytea),0)-COALESCE(octet_length($6::bytea),0)) ELSE COALESCE(octet_length($4::bytea),0) END-d.storage_bytes,$2::bigint-f.size_bytes FROM files f JOIN source_documents d ON d.file_id=f.id WHERE f.id=$1`, fileID, size, effects, state, in.Deferred, captured).Scan(&growth, &resized); err != nil {
		return doc, err
	}
	if growth > 0 && !job.system {
		if err = s.gateStorageTx(ctx, tx, owner, growth); err != nil {
			return doc, err
		}
	}
	if job.exportOnly {
		if err = applyExportTx(ctx, tx, fileID, exportPublication{jobID: in.JobID, sourcePath: source, sha: sha, etag: in.SourceETag, size: size, checkpoint: in.Checkpoint, attemptID: in.AttemptID, state: state, stateSeed: stateSeed, effects: effects, netTokens: netTokens, deferred: in.Deferred, captured: captured, capturedSeed: capturedSeed}); err != nil {
			return doc, err
		}
		out, err := readSourceSession(ctx, tx, fileID, ws)
		if err != nil {
			return out, err
		}
		return out, tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES($1,$2,$3) ON CONFLICT(file_id) DO UPDATE SET content_id=EXCLUDED.content_id`, fileID, ws, in.ContentID); err != nil {
		return doc, err
	}
	publishedRow, err := tx.Exec(ctx, `UPDATE files SET blob_path=$2,source_sha256=$3,size_bytes=$4,source_etag=$5,content_hash=$6,indexed=true,status='ready',revision=revision+1,ever_parsed_successfully=ever_parsed_successfully OR $7,caption_blob_path=NULL WHERE id=$1 AND trashed_at IS NULL`, fileID, source, sha, size, in.SourceETag, in.ContentHash, doc.Format != "text")
	if err != nil {
		return doc, err
	}
	if publishedRow.RowsAffected() == 0 {
		// The file was trashed after the candidate was admitted: never report
		// a publication that changed nothing.
		return doc, ErrConflict
	}
	if doc.Format != "text" {
		if _, err = tx.Exec(ctx, `UPDATE image_caption_associations a SET published=(a.image_sha256=ANY(c.image_sha256s)) FROM source_refresh_candidates c WHERE c.file_id=$1 AND a.file_id=c.file_id`, fileID); err != nil {
			return doc, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM image_caption_associations a WHERE file_id=$1 AND NOT published AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) e WHERE e->>'imageSHA256'=a.image_sha256 AND e->>'operation'<>'remove')`, fileID, effects); err != nil {
			return doc, err
		}
	}
	switch {
	case in.Deferred:
		// Editing stays on its base and epoch (no reload for open editors);
		// base_revision follows the file's so the next capture is current.
		_, err = tx.Exec(ctx, `UPDATE source_documents SET indexed_checkpoint=$2,base_revision=base_revision+1,pending_effects=$3,net_tokens=$4,rebuild_pending=true,rebuild_refusal=NULL,published_state=$5,published_state_seed_sha256=$6,reprocess_at=NULL,running_job_id=NULL,desired_checkpoint=CASE WHEN $3::jsonb='[]'::jsonb THEN NULL ELSE checkpoint END,desired_manual=desired_manual AND $3::jsonb<>'[]'::jsonb,refresh_error=NULL,updated_at=now() WHERE file_id=$1`, fileID, in.Checkpoint, effects, netTokens, captured, capturedSeed)
		if err == nil {
			err = releaseArtifactCacheTx(ctx, tx, replacedSHA, sha)
		}
	case doc.Format == "text":
		// Text keeps its lineage; its baseline is the exported blob decoded.
		// The published text is the file's bytes now, so the seed size takes
		// the change in its size (Yjs stores the text as its UTF-8 bytes).
		_, err = tx.Exec(ctx, `UPDATE source_documents SET indexed_checkpoint=$2,base_revision=base_revision+1,base_blob_path=$3,base_source_sha256=$4,pending_effects=$5,net_tokens=$6,seed_bytes=seed_bytes+$7,desired_manual=desired_manual AND $5::jsonb<>'[]'::jsonb,desired_checkpoint=CASE WHEN $5::jsonb='[]'::jsonb THEN NULL ELSE desired_checkpoint END,running_job_id=NULL,refresh_error=NULL,updated_at=now() WHERE file_id=$1`, fileID, in.Checkpoint, source, sha, effects, netTokens, resized)
	default:
		// Indexed now, so an export-only publication's reprocess mark is done.
		_, err = tx.Exec(ctx, `UPDATE source_documents d SET epoch=d.epoch+1,indexed_checkpoint=$2,state=$3,state_seed_sha256=NULLIF($8,''),reprocess_at=NULL,rebuild_pending=false,rebuild_refusal=NULL,published_state=NULL,published_state_seed_sha256=NULL,base_revision=d.base_revision+1,base_blob_path=$4,base_source_sha256=$5,pending_effects=$6,net_tokens=$7,running_job_id=NULL,desired_checkpoint=CASE WHEN $6::jsonb='[]'::jsonb THEN NULL ELSE d.checkpoint END,desired_manual=d.desired_manual AND $6::jsonb<>'[]'::jsonb,refresh_error=NULL,updated_at=now() WHERE d.file_id=$1`, fileID, in.Checkpoint, state, source, sha, effects, netTokens, stateSeed)
		if err == nil {
			// Rebase can change native identities. Release AI edit guards and
			// their Undo with the old editing epoch.
			err = invalidateEditInversesTx(ctx, tx, agenttools.KindSourceFile, fileID, "source_rebased")
		}
	}
	if err != nil {
		return doc, err
	}
	if !in.Deferred {
		// The old base, and the file's bytes a pending rebuild had published.
		for _, old := range []string{doc.BaseSourceSHA256, replacedSHA} {
			if err = releaseArtifactCacheTx(ctx, tx, old, sha); err != nil {
				return doc, err
			}
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

// releaseArtifactCacheTx drops cached artifacts of a replaced base once nothing
// names its bytes.
func releaseArtifactCacheTx(ctx context.Context, tx pgx.Tx, oldSHA, newSHA string) error {
	if oldSHA == "" || oldSHA == newSHA {
		return nil
	}
	_, err := tx.Exec(ctx, `DELETE FROM artifact_cache a WHERE a.source_sha256=$1 AND NOT EXISTS(SELECT 1 FROM files f WHERE f.source_sha256=$1) AND NOT EXISTS(SELECT 1 FROM source_documents d WHERE d.base_source_sha256=$1) AND NOT EXISTS(SELECT 1 FROM source_refresh_candidates c WHERE c.source_sha256=$1)`, oldSHA)
	return err
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
	job, err := sourceRefreshJob(ctx, tx, fileID, jobID)
	if err != nil {
		return err
	}
	actor := job.actor
	// Trashed files too: the maintenance window exports them (a trash
	// transition already cancelled every other refresh).
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
	rows, err := s.pool.Query(ctx, `SELECT f.name,f.kind,EXISTS(SELECT 1 FROM rag_file_contents a JOIN rag_contents c ON c.id=a.content_id WHERE a.file_id=f.id AND c.status='ready') FROM files f WHERE f.workspace_id=$1 AND f.trashed_at IS NULL`, ws)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name, kind string
		var indexed bool
		if err = rows.Scan(&name, &kind, &indexed); err != nil {
			return err
		}
		plan, e := sourceupload.BuildProcessingPlan(name, kind, "fast")
		switch {
		case indexed:
			stats.Indexed++
		case e == nil && plan.Route != sourceupload.RouteStoreOnly:
			stats.NotIndexed++
		default:
			stats.NotIndexable++
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if stats.FileChanges, err = s.workspaceFileChanges(ctx, ws); err != nil {
		return err
	}
	return s.pool.QueryRow(ctx, `SELECT count(*) FROM materials
		WHERE workspace_id=$1 AND kind='note' AND trashed_at IS NULL
		  AND (index_dirty_at IS NOT NULL OR index_job_id IS NOT NULL)`, ws).Scan(&stats.PendingNotes)
}

// workspaceFileChanges lists files with unprocessed saved edits (the
// scheduler's predicate in collaboration/src/sourceDocuments.ts) or a refresh
// in flight. A refresh stays queued until its first claim; a maintenance
// republish is the system's own and is left out.
func (s *Store) workspaceFileChanges(ctx context.Context, ws string) ([]FileChange, error) {
	rows, err := s.pool.Query(ctx, `SELECT f.id,f.name,f.kind,d.last_edited_at,
		CASE WHEN j.id IS NOT NULL THEN CASE WHEN j.type='source_refresh' AND j.status='pending' AND j.attempts=0 THEN 'queued' ELSE 'processing' END
		  WHEN d.refresh_error IS NOT NULL THEN 'failed' ELSE 'waiting' END
		FROM source_documents d JOIN files f ON f.id=d.file_id LEFT JOIN jobs j ON j.id=d.running_job_id
		WHERE f.workspace_id=$1 AND f.trashed_at IS NULL AND COALESCE(j.payload->>'paidBy','')<>'system'
		  AND (j.id IS NOT NULL OR d.net_tokens>0 OR (d.format<>'text' AND d.pending_effects<>'[]'::jsonb))
		ORDER BY d.last_edited_at,f.id`, ws)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (FileChange, error) {
		var change FileChange
		err := row.Scan(&change.FileID, &change.Name, &change.Kind, &change.LastEditedAt, &change.State)
		return change, err
	})
}

// CancelSourceRefresh takes a queued refresh back out of the queue; once it
// has been claimed it runs to the end. The saved edits stay, and automatic
// processing may queue them again. Owner-only, like requesting one.
func (s *Store) CancelSourceRefresh(ctx context.Context, actor, fileID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	_, owner, err := s.sourceEditLockTx(ctx, tx, fileID, actor)
	if err != nil {
		return err
	}
	if actor != owner {
		return ErrForbidden
	}
	var jobID string
	var queued bool
	err = tx.QueryRow(ctx, `SELECT j.id,j.type='source_refresh' AND j.status='pending' AND j.attempts=0 FROM source_documents d JOIN jobs j ON j.id=d.running_job_id WHERE d.file_id=$1 AND COALESCE(j.payload->>'paidBy','')<>'system' FOR UPDATE OF d,j`, fileID).Scan(&jobID, &queued)
	if isNoRows(err) {
		return ErrNothingToProcess
	}
	if err != nil {
		return err
	}
	if !queued {
		return ErrProcessingStarted
	}
	// Superseded: no refresh_error, so the file is waiting again rather than
	// failed. Dropping desired_manual keeps the scheduler from re-admitting it
	// as a manual request at once.
	if _, err = tx.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'superseded','source_refresh','source_refresh_cancelled','Cancelled by the owner')`, jobID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET desired_manual=false WHERE file_id=$1`, fileID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SourceRebuild moves editing onto the published file after a deferred
// publication (SourceRefreshPublish.Deferred), sent by the collaboration
// service once the room is empty.
type SourceRebuild struct {
	Epoch int64 `json:"epoch" minimum:"1"`
	// The latest checkpoint the rebase started from: a later save refuses it.
	ExpectedCheckpoint    int64  `json:"expectedCheckpoint" minimum:"0"`
	PublishedSourceSHA256 string `json:"publishedSourceSHA256"`
	// The edits saved after the published capture, landed on seed(published)
	// and stored as their change over it with that seed's SHA-256; absent when
	// nothing was saved after the capture (the state is seed(published)).
	State           []byte          `json:"state,omitempty"`
	StateSeedSHA256 string          `json:"stateSeedSHA256,omitempty"`
	PendingEffects  json.RawMessage `json:"pendingEffects"`
	NetTokens       int64           `json:"netTokens" minimum:"0"`
}

// RebuildSource swaps the editing base for the published file: a new epoch
// whose state is the rebased change, the old base released. It refuses (409)
// a stale rebase (a save, a publication or a refresh in flight since) so the
// caller retries later; no account, storage or trash check applies, since the
// file's bytes and index are already published.
func (s *Store) RebuildSource(ctx context.Context, fileID string, in SourceRebuild) error {
	var parsed []json.RawMessage
	if json.Unmarshal(in.PendingEffects, &parsed) != nil || parsed == nil || in.NetTokens < 0 || len(in.State) > 100<<20 {
		return ErrConflict
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return err
	}
	var pending bool
	var epoch, checkpoint, indexed int64
	var running *string
	var published, oldSHA string
	err = tx.QueryRow(ctx, `SELECT d.rebuild_pending,d.epoch,d.checkpoint,d.indexed_checkpoint,d.running_job_id,COALESCE(f.source_sha256,''),d.base_source_sha256 FROM source_documents d JOIN files f ON f.id=d.file_id WHERE d.file_id=$1 FOR UPDATE OF d`, fileID).Scan(&pending, &epoch, &checkpoint, &indexed, &running, &published, &oldSHA)
	if isNoRows(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	if !pending || running != nil || epoch != in.Epoch || checkpoint != in.ExpectedCheckpoint || published == "" || published != in.PublishedSourceSHA256 {
		return ErrConflict
	}
	// Nothing saved after the capture: the state is seed(published), with no
	// effects. Otherwise the rebased change and the seed it is over.
	if (checkpoint == indexed) != (len(in.State) == 0) || (len(in.State) == 0 && (in.StateSeedSHA256 != "" || len(parsed) != 0)) || (len(in.State) > 0 && !sha256Hex(in.StateSeedSHA256)) {
		return ErrConflict
	}
	var state []byte
	if len(in.State) > 0 {
		state = in.State
	}
	// The outbox names the room of the current epoch, so this goes first.
	if _, err = tx.Exec(ctx, `SELECT enqueue_source_collaboration_eviction($1,'discard')`, fileID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents d SET epoch=d.epoch+1,base_blob_path=f.blob_path,base_source_sha256=f.source_sha256,state=$2,state_seed_sha256=NULLIF($3,''),pending_effects=$4,net_tokens=$5,rebuild_pending=false,rebuild_refusal=NULL,published_state=NULL,published_state_seed_sha256=NULL,updated_at=now() FROM files f WHERE d.file_id=$1 AND f.id=d.file_id`, fileID, state, in.StateSeedSHA256, in.PendingEffects, in.NetTokens); err != nil {
		return err
	}
	// Rebase can change native identities. Release AI edit guards and their
	// Undo with the old editing epoch.
	if err = invalidateEditInversesTx(ctx, tx, agenttools.KindSourceFile, fileID, "source_rebased"); err != nil {
		return err
	}
	if err = releaseArtifactCacheTx(ctx, tx, oldSHA, published); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SourceEpochReset names the editing epoch whose room the collaboration
// service discarded with unsaved state in it.
type SourceEpochReset struct {
	Epoch int64 `json:"epoch" minimum:"1"`
}

// ResetSourceEpoch moves editing to the next epoch on the same base and saved
// state, after the collaboration service threw away unsaved room state (a save
// refused for good, an access discard). The room name carries the epoch, so a
// client still holding the thrown-away state cannot resync it: it sees a new
// epoch and opens its edits read-only instead. An epoch that already moved on
// is left alone. A refresh captured under the old epoch is superseded, as
// after any epoch change.
func (s *Store) ResetSourceEpoch(ctx context.Context, fileID string, in SourceEpochReset) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET epoch=epoch+1,updated_at=now() WHERE file_id=$1 AND epoch=$2`, fileID, in.Epoch); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// SourceRebuildRefusal reports that the engine refused the rebase of a
// deferred publication's rebuild (RebaseError, "Office rebase:"), sent by the
// collaboration service.
type SourceRebuildRefusal struct {
	Epoch                 int64  `json:"epoch" minimum:"1"`
	PublishedSourceSHA256 string `json:"publishedSourceSHA256"`
	Error                 string `json:"error"`
}

// RefuseSourceRebuild leaves the file due again, as a refused publication
// does: the collaboration service stops retrying that rebuild, and the refresh
// scheduler admits the file whatever its tokens, so the next automatic
// publication captures the room's latest state; that publication clears the
// refusal and its own rebuild follows. It refuses (409) a refusal of an older
// epoch or publication.
func (s *Store) RefuseSourceRebuild(ctx context.Context, fileID string, in SourceRebuildRefusal) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `UPDATE source_documents d SET rebuild_refusal=left($4,2000) FROM files f WHERE d.file_id=$1 AND f.id=d.file_id AND d.rebuild_pending AND d.epoch=$2 AND f.source_sha256=$3`, fileID, in.Epoch, in.PublishedSourceSHA256, in.Error)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return tx.Commit(ctx)
}
