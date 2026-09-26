package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// The Office maintenance window (engine upgrade): pause editing, publish every
// file with unpublished edits on the old engine, wait for zero, deploy the
// reset. Runbook: openwiki/deployment-runbook.md, "Office maintenance window".

// ErrOfficeEditingPaused refuses Office edit sessions and agent edits while
// the maintenance pause is on.
var ErrOfficeEditingPaused = errors.New("office editing is paused for maintenance")

// ErrOfficeEditingNotPaused refuses publish-all outside the pause: its
// export-only publications evict rooms without a flush.
var ErrOfficeEditingNotPaused = errors.New("office editing is not paused; run office-maintenance pause first")

// SetOfficeEditingPaused sets or clears the pause (office-maintenance
// pause/resume). The collaboration service applies it within 5 seconds.
func (s *Store) SetOfficeEditingPaused(ctx context.Context, paused bool) error {
	q := `DELETE FROM office_editing_pause`
	if paused {
		q = `INSERT INTO office_editing_pause DEFAULT VALUES ON CONFLICT DO NOTHING`
	}
	_, err := s.pool.Exec(ctx, q)
	return err
}

// AssertOfficeEditable refuses an Office file while the pause is on. Text
// sources and missing files pass; the caller's own read answers for those.
func (s *Store) AssertOfficeEditable(ctx context.Context, fileID string) error {
	var name, kind string
	var paused bool
	err := s.pool.QueryRow(ctx, `SELECT name,kind,EXISTS(SELECT 1 FROM office_editing_pause) FROM files WHERE id=$1`, fileID).Scan(&name, &kind, &paused)
	if isNoRows(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if format := editableSourceFormat(name, kind); paused && format != "" && format != "text" {
		return ErrOfficeEditingPaused
	}
	return nil
}

// officeEditRefusal is the agent tool's form of the pause.
func (s *Store) officeEditRefusal(ctx context.Context, fileID string) error {
	err := s.AssertOfficeEditable(ctx, fileID)
	if errors.Is(err, ErrOfficeEditingPaused) {
		return &EditRefusal{Code: agenttools.ErrOfficeEditingPaused, Message: err.Error()}
	}
	return err
}

// maintenanceLockTx takes sourceLockTx's locks for a maintenance (system)
// refresh without its gates: the window also publishes trashed files and files
// of locked owners (export-only), and blocked owners' files at platform cost.
func (s *Store) maintenanceLockTx(ctx context.Context, tx pgx.Tx, fileID string) (string, string, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fileID); err != nil {
		return "", "", err
	}
	var ws string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM files WHERE id=$1`, fileID).Scan(&ws); err != nil {
		if isNoRows(err) {
			err = ErrNotFound
		}
		return "", "", err
	}
	owner, err := s.storageOwnerTx(ctx, tx, ws)
	if err != nil {
		return "", "", err
	}
	// The row lock lockAccountSessionsTx takes, without refusing a locked account.
	if _, err = tx.Exec(ctx, `SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE`, owner); err != nil {
		return "", "", err
	}
	return ws, owner, nil
}

// OfficePublication is one publish-all request: a system-paid republish, or an
// export-only publication.
type OfficePublication struct {
	FileID     string
	ExportOnly bool
	JobID      string
	Err        error
}

// PublishAllOfficeSources requests a maintenance publication of every Office
// source with unpublished edits, clearing a stale refresh_error. Files never
// parsed successfully (store-only uploads and failed first parses: maintenance
// never runs a first parse), trashed files, files of suspended or deletion-pending owners and files whose
// system republish of this checkpoint already failed publish export-only; the
// rest republish at platform cost, without the credit, storage or owner-state
// checks. A file with a refresh in flight waits for the next run.
func (s *Store) PublishAllOfficeSources(ctx context.Context) ([]OfficePublication, error) {
	var paused bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM office_editing_pause)`).Scan(&paused); err != nil {
		return nil, err
	}
	if !paused {
		return nil, ErrOfficeEditingNotPaused
	}
	// ponytail: the failed-republish lookup scans failed jobs per file; index
	// jobs by payload fileId if a window ever holds thousands of files.
	rows, err := s.pool.Query(ctx, `SELECT d.file_id,w.user_id,
		NOT f.ever_parsed_successfully OR f.trashed_at IS NOT NULL
		OR u.suspended_at IS NOT NULL OR u.deletion_requested_at IS NOT NULL OR u.deleted_at IS NOT NULL
		OR EXISTS(SELECT 1 FROM jobs j WHERE j.status='failed' AND j.payload->>'fileId'=d.file_id
			AND j.payload->>'sourceRefresh'='true' AND j.payload->>'paidBy'='system'
			AND NOT COALESCE((j.payload->>'exportOnly')::boolean,false)
			AND j.payload->>'sourceCheckpoint'=d.checkpoint::text)
		FROM source_documents d JOIN files f ON f.id=d.file_id JOIN workspaces w ON w.id=f.workspace_id JOIN users u ON u.id=w.user_id
		WHERE d.format<>'text' AND (d.checkpoint>d.indexed_checkpoint OR d.pending_effects<>'[]'::jsonb) AND d.running_job_id IS NULL
		ORDER BY d.file_id`)
	if err != nil {
		return nil, err
	}
	type due struct {
		file, owner string
		exportOnly  bool
	}
	var files []due
	for rows.Next() {
		var d due
		if err = rows.Scan(&d.file, &d.owner, &d.exportOnly); err != nil {
			rows.Close()
			return nil, err
		}
		files = append(files, d)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := make([]OfficePublication, 0, len(files))
	for _, d := range files {
		result, err := s.requestSourceRefresh(ctx, d.owner, d.file, false, models.PaidBySystem, d.exportOnly)
		out = append(out, OfficePublication{FileID: d.file, ExportOnly: d.exportOnly, JobID: result.JobID, Err: err})
	}
	return out, nil
}

// UnpublishedSource is an Office source whose saved edits are not yet the
// file's bytes.
type UnpublishedSource struct {
	FileID, Format, RunningJobID, RefreshError string
	Checkpoint, IndexedCheckpoint              int64
}

// InFlightJob is publication or reprocess work on an Office file not yet
// finished: a source_refresh job, the parse or ingest job it became, or a
// system-paid reprocess.
type InFlightJob struct {
	ID, Type, Status, FileID string
}

// OfficeReadiness is what the window's deploy waits on (Ready).
type OfficeReadiness struct {
	Paused      bool
	Unpublished []UnpublishedSource
	InFlight    []InFlightJob
}

// Ready: the pause is on and no Office publication or reprocess is left.
func (r OfficeReadiness) Ready() bool {
	return r.Paused && len(r.Unpublished) == 0 && len(r.InFlight) == 0
}

// OfficeReadiness reads the pause, the Office sources with unpublished edits
// and the Office publication and reprocess work in flight. Other uploads and
// text refreshes do not touch what the reset drops, so they are not counted.
func (s *Store) OfficeReadiness(ctx context.Context) (OfficeReadiness, error) {
	var out OfficeReadiness
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM office_editing_pause)`).Scan(&out.Paused); err != nil {
		return out, err
	}
	rows, err := s.pool.Query(ctx, `SELECT file_id,format,COALESCE(running_job_id,''),COALESCE(refresh_error,''),checkpoint,indexed_checkpoint FROM source_documents WHERE format<>'text' AND (checkpoint>indexed_checkpoint OR pending_effects<>'[]'::jsonb) ORDER BY file_id`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var u UnpublishedSource
		if err = rows.Scan(&u.FileID, &u.Format, &u.RunningJobID, &u.RefreshError, &u.Checkpoint, &u.IndexedCheckpoint); err != nil {
			rows.Close()
			return out, err
		}
		out.Unpublished = append(out.Unpublished, u)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return out, err
	}
	rows, err = s.pool.Query(ctx, `SELECT j.id,j.type,j.status,COALESCE(j.payload->>'fileId','') FROM jobs j WHERE j.type IN ('source_refresh','parse','ingest') AND j.status IN ('pending','running') AND (j.payload->>'sourceRefresh'='true' OR j.payload->>'paidBy'='system') AND EXISTS(SELECT 1 FROM source_documents d WHERE d.file_id=j.payload->>'fileId' AND d.format<>'text') ORDER BY j.created_at`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var j InFlightJob
		if err = rows.Scan(&j.ID, &j.Type, &j.Status, &j.FileID); err != nil {
			return out, err
		}
		out.InFlight = append(out.InFlight, j)
	}
	return out, rows.Err()
}

// exportPublication is what an export-only publication writes: the export as
// the file's bytes, with the state, baseline and effects that go with it (nil
// state and baseline: seed(export) and its derived baseline).
type exportPublication struct {
	jobID, sourcePath, sha, etag           string
	size, checkpoint, attemptID, netTokens int64
	state, baseline                        []byte
	effects                                json.RawMessage
}

// publishExportTx is a maintenance export-only publication (system payer,
// editing paused, so no writer to flush): finalize publishes the captured
// checkpoint in its own transaction and evicts the old room. A save after the
// capture (a failed-store retry) supersedes the job and the next publish-all
// exports again; it reports false then.
func (s *Store) publishExportTx(ctx context.Context, tx pgx.Tx, fileID, sourcePath string, in SourceRefreshFinalize) (bool, error) {
	var checkpoint int64
	if err := tx.QueryRow(ctx, `SELECT checkpoint FROM source_documents WHERE file_id=$1`, fileID).Scan(&checkpoint); err != nil {
		return false, err
	}
	if checkpoint != in.Checkpoint {
		_, err := tx.Exec(ctx, `SELECT cancel_pipeline_jobs(ARRAY[$1::text],'superseded','superseded','source_superseded','Saved edits arrived after the export')`, in.JobID)
		return false, err
	}
	// The outbox names the room of the current epoch, so this goes first.
	if _, err := tx.Exec(ctx, `SELECT enqueue_source_collaboration_eviction($1,'discard')`, fileID); err != nil {
		return false, err
	}
	// No edits after the capture: the state is seed(export) (NULL) and the
	// baseline is derived from the export.
	err := applyExportTx(ctx, tx, fileID, exportPublication{jobID: in.JobID, sourcePath: sourcePath, sha: in.SourceSHA256, etag: in.SourceETag, size: in.SizeBytes, checkpoint: in.Checkpoint, effects: json.RawMessage(`[]`)})
	return err == nil, err
}

// applyExportTx makes the export the file's bytes with no parser or provider
// call: the index is dropped (captions stay only for images the remaining
// effects add) and, unless it never parsed successfully (its owner's Process,
// charged as the first parse, stays the way in), it is marked for reprocessing
// at platform cost. The job is done; nothing else finishes it.
func applyExportTx(ctx context.Context, tx pgx.Tx, fileID string, p exportPublication) error {
	var oldSHA string
	if err := tx.QueryRow(ctx, `SELECT base_source_sha256 FROM source_documents WHERE file_id=$1`, fileID).Scan(&oldSHA); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM rag_file_contents WHERE file_id=$1`, fileID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE image_caption_associations SET published=false WHERE file_id=$1`, fileID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM image_caption_associations a WHERE file_id=$1 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) e WHERE e->>'imageSHA256'=a.image_sha256 AND e->>'operation'<>'remove')`, fileID, p.effects); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET blob_path=$2,source_sha256=$3,size_bytes=$4,source_etag=$5,content_hash=NULL,indexed=false,status='ready',revision=revision+1,parsed_blob_path=NULL,parsed_fingerprint=NULL,parsed_parser_version=NULL,caption_blob_path=NULL WHERE id=$1`, fileID, p.sourcePath, p.sha, p.size, p.etag); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE source_documents d SET epoch=d.epoch+1,indexed_checkpoint=$2,state=$3,seed_bytes=`+rebasedSeedBytes+`,indexed_baseline=$4,base_revision=d.base_revision+1,base_blob_path=$5,base_source_sha256=$6,pending_effects=$7,net_tokens=$8,running_job_id=NULL,desired_checkpoint=CASE WHEN $7::jsonb='[]'::jsonb THEN NULL ELSE d.checkpoint END,desired_manual=d.desired_manual AND $7::jsonb<>'[]'::jsonb,refresh_error=NULL,reprocess_at=CASE WHEN f.ever_parsed_successfully THEN now() END,updated_at=now() FROM files f WHERE d.file_id=$1 AND f.id=d.file_id`, fileID, p.checkpoint, p.state, p.baseline, p.sourcePath, p.sha, p.effects, p.netTokens); err != nil {
		return err
	}
	if err := invalidateEditInversesTx(ctx, tx, agenttools.KindSourceFile, fileID, "source_rebased"); err != nil {
		return err
	}
	if err := releaseArtifactCacheTx(ctx, tx, oldSHA, p.sha); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM source_refresh_candidates WHERE file_id=$1`, fileID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE jobs SET status='done',locked_at=NULL,lease_expires_at=NULL,updated_at=now(),payload=payload||jsonb_build_object('sourcePublishedCheckpoint',$2::bigint,'sourcePublishedAttemptId',$3::bigint) WHERE id=$1`, p.jobID, p.checkpoint, p.attemptID)
	return err
}

// reprocessTx indexes the bytes an export-only publication left: a plain
// system-paid parse of the current file (no page fee, provider calls at zero
// credits). The next attempt waits a day. A parse that timed out or ran out of
// memory is not rerun meanwhile: the pipeline refuses a quarantined
// fingerprint (bytes and parser version) before calling the parser. A parse or
// ingest job already queued for the file answers 409, so a stale selection
// never queues a second one.
func (s *Store) reprocessTx(ctx context.Context, tx pgx.Tx, result SourceProcessResult, ws, owner, name, kind, mode string) (SourceProcessResult, error) {
	var blobPath, etag string
	var revision int64
	var queued bool
	if err := tx.QueryRow(ctx, `SELECT COALESCE(blob_path,''),source_etag,revision,EXISTS(SELECT 1 FROM jobs WHERE payload->>'fileId'=$1 AND type IN ('parse','ingest') AND status IN ('pending','running')) FROM files WHERE id=$1`, result.FileID).Scan(&blobPath, &etag, &revision, &queued); err != nil {
		return result, err
	}
	if queued {
		return result, ErrConflict
	}
	if mode == "none" {
		mode = "fast" // a processed store-only upload keeps parse_mode 'none'
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, mode)
	if err != nil {
		return result, err
	}
	reservation, err := beginSystemIngestSessionTx(ctx, tx, owner, ws)
	if err != nil {
		return result, err
	}
	payload, err := s.ingestJobPayload(ctx, owner, map[string]any{"fileId": result.FileID, "workspaceId": ws, "blobPath": blobPath, "kind": kind, "parseMode": mode, "processingPlan": plan, "sourceETag": etag, "sourceRevision": revision, "reservationId": reservation, "paidBy": models.PaidBySystem})
	if err != nil {
		return result, err
	}
	result.JobID = uid("job")
	if _, err = tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,$2,$3)`, result.JobID, initialPipelineJobType(plan), payload); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE files SET status='pending' WHERE id=$1`, result.FileID); err != nil {
		return result, err
	}
	if _, err = tx.Exec(ctx, `UPDATE source_documents SET reprocess_at=now()+interval '1 day' WHERE file_id=$1`, result.FileID); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

// upgradeExportTx keeps the owner's Process that arrives while an export-only
// publication runs: the job becomes an owner-paid refresh of the same capture
// (charged as the first parse when the file never parsed). Before finalize,
// finalize then continues it as a parse; after finalize, it becomes that parse
// here, and the export's own publication, if already on its way, is refused.
// It reports false for any other running job.
func (s *Store) upgradeExportTx(ctx context.Context, tx pgx.Tx, jobID, actor, ws, name, kind, mode string, ever bool) (bool, error) {
	var exportOnly, finalized bool
	err := tx.QueryRow(ctx, `SELECT COALESCE((j.payload->>'exportOnly')::boolean,false),c.seed_bytes IS NOT NULL FROM jobs j JOIN source_refresh_candidates c ON c.job_id=j.id WHERE j.id=$1 AND j.type='source_refresh' AND j.status IN ('pending','running') FOR UPDATE OF j,c`, jobID).Scan(&exportOnly, &finalized)
	if isNoRows(err) || (err == nil && !exportOnly) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	reservation, err := s.beginIngestSpendTx(ctx, tx, actor, ws)
	if err != nil {
		return false, err
	}
	if mode == "none" {
		mode = "fast"
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, mode)
	if err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `UPDATE jobs SET type=CASE WHEN $6 THEN $7 ELSE type END,status=CASE WHEN $6 THEN 'pending' ELSE status END,attempts=CASE WHEN $6 THEN 0 ELSE attempts END,locked_at=CASE WHEN $6 THEN NULL ELSE locked_at END,lease_expires_at=CASE WHEN $6 THEN NULL ELSE lease_expires_at END,queued_at=CASE WHEN $6 THEN now() ELSE queued_at END,updated_at=now(),payload=payload||jsonb_build_object('exportOnly',false,'paidBy',$2::text,'reservationId',$3::text,'parseFee',$4::boolean,'requestedBy',$5::text,'automatic',false) WHERE id=$1`, jobID, models.PaidByPlatform, reservation, !ever, actor, finalized, initialPipelineJobType(plan))
	return err == nil, err
}
