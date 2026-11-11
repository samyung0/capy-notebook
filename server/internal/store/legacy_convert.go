package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// A legacy Office upload (.doc, .xls, .ppt) is converted on the ingest host
// (Epo 2026-11-11). The parse coordinator puts the converted file in the
// bucket and hands it over here: the converted file replaces the uploaded
// bytes under the new ending, and the file goes on as an ordinary new-format
// upload of its parse mode.

var (
	// ErrConvertClaimLost: the job attempt, or the file revision it converted,
	// is no longer current. The worker stops without writing anything.
	ErrConvertClaimLost = errors.New("legacy conversion claim lost")
	// ErrConvertInvalid: the hand-over does not match its job and file (wrong
	// key, size or hash, no legacy file). Terminal for the file.
	ErrConvertInvalid = errors.New("legacy conversion result is invalid")
)

// LegacyConvert is the worker's hand-over of one converted file. Attempt is
// the job's attempts value the worker claimed with.
type LegacyConvert struct {
	JobID           string
	Attempt         int
	FileID          string
	IncomingKey     string
	ActualSize      int64
	SHA256          string
	RemovedPictures int
}

// LegacyConvertResult is the converted file: its new name and the parse job
// that follows, nil with parsing off.
type LegacyConvertResult struct {
	FileID     string
	Name       string
	ParseJobID *string
}

// LegacyConvertIncomingKey is where the worker puts a job's converted file.
func LegacyConvertIncomingKey(jobID, convertTo string) string {
	return "incoming/legacy-convert/" + jobID + "." + convertTo
}

// legacyConvertedName swaps the legacy ending for the converted format's. The
// new ending is a character longer, so a name at the files.name cap loses the
// end of its stem.
func legacyConvertedName(name, convertTo string) string {
	return fieldlimits.ClampFileName(strings.TrimSuffix(name, filepath.Ext(name)) + "." + convertTo)
}

// legacyConvertFence is what a hand-over's fence read under its locks.
type legacyConvertFence struct {
	// done: the job already finished; its recorded result is answered again.
	done *LegacyConvertResult

	actorID, payerID, workspaceID   string
	kind, parseMode, parser         string
	newName, convertTo, reservation string
	revision                        int64
}

// legacyConvertFenceTx locks a hand-over's file and job and checks them, in
// the worker's own order (db.lock_pipeline_claim_boundary in the pipeline):
// workspace, accounts, membership, file, then the job. The job must be this
// running attempt of a conversion with a live lease, and the file the revision
// it was queued for, not trashed and still legacy; the converted size must fit the payer's
// per-file cap and, where it grows the file, its storage.
func (s *Store) legacyConvertFenceTx(ctx context.Context, tx pgx.Tx, in LegacyConvert) (legacyConvertFence, error) {
	var f legacyConvertFence
	if in.Attempt < 1 || in.ActualSize < 0 || in.RemovedPictures < 0 || !sha256Hex(in.SHA256) {
		return f, ErrConvertInvalid
	}
	// A job's identity never changes, so this unlocked read names the locks.
	var fileID string
	err := tx.QueryRow(ctx, `SELECT COALESCE(payload->>'fileId',''), COALESCE(payload->>'actorUserId',''),
			COALESCE(payload->>'workspaceId','')
		FROM jobs WHERE id=$1 AND type='parse'`, in.JobID).Scan(&fileID, &f.actorID, &f.workspaceID)
	if isNoRows(err) {
		return f, ErrConvertClaimLost
	}
	if err != nil {
		return f, err
	}
	if fileID != in.FileID {
		return f, ErrConvertInvalid
	}
	f.payerID, err = filePayer(ctx, tx, in.FileID)
	if errors.Is(err, ErrNotFound) {
		return f, ErrConvertClaimLost
	}
	if err != nil {
		return f, err
	}
	// The worker's boundary cancels a job whose actor lost its account or its
	// edit access; here that reads as a lost claim, and the worker's own
	// check fails the file.
	if f.workspaceID != "" {
		_, err = s.lockWorkspaceEditorRecoveryTx(ctx, tx, f.workspaceID, f.actorID, f.payerID)
	} else if f.actorID != f.payerID {
		err = ErrNotFound
	} else {
		err = s.lockAccountSessionsTx(ctx, tx, f.actorID)
	}
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) || errors.Is(err, ErrAccountLocked) {
		return f, ErrConvertClaimLost
	}
	if err != nil {
		return f, err
	}
	if err := s.lockStorageRowTx(ctx, tx, f.payerID); err != nil {
		return f, err
	}

	var name, etag string
	var size int64
	fileErr := tx.QueryRow(ctx, `SELECT name, kind, parse_mode, COALESCE(parser,''), size_bytes, revision, COALESCE(source_etag,'')
		FROM files WHERE id=$1 AND trashed_at IS NULL AND COALESCE(workspace_id,'')=$2 FOR UPDATE`,
		in.FileID, f.workspaceID).Scan(&name, &f.kind, &f.parseMode, &f.parser, &size, &f.revision, &etag)
	if fileErr != nil && !isNoRows(fileErr) {
		return f, fileErr
	}
	var status string
	var attempts int
	var live bool
	var payload []byte
	if err := tx.QueryRow(ctx, `SELECT status, attempts, COALESCE(lease_expires_at > now(), false), payload
		FROM jobs WHERE id=$1 FOR UPDATE`, in.JobID).Scan(&status, &attempts, &live, &payload); err != nil {
		return f, err
	}
	var job struct {
		ProcessingPlan struct {
			Route string `json:"route"`
		} `json:"processingPlan"`
		ReservationID  string  `json:"reservationId"`
		SourceETag     string  `json:"sourceETag"`
		SourceRevision int64   `json:"sourceRevision"`
		ConvertedName  string  `json:"convertedName"`
		ParseJobID     *string `json:"parseJobId"`
	}
	if err := json.Unmarshal(payload, &job); err != nil {
		return f, err
	}
	if job.ProcessingPlan.Route != sourceupload.RouteLegacyConvert {
		return f, ErrConvertInvalid
	}
	if status == "done" && job.ConvertedName != "" {
		f.done = &LegacyConvertResult{FileID: in.FileID, Name: job.ConvertedName, ParseJobID: job.ParseJobID}
		return f, nil
	}
	if status != "running" || attempts != in.Attempt || !live ||
		isNoRows(fileErr) || job.SourceRevision != f.revision || job.SourceETag != etag {
		return f, ErrConvertClaimLost
	}
	f.reservation = job.ReservationID

	plan, err := sourceupload.BuildProcessingPlan(name, f.kind, f.parseMode)
	if err != nil || plan.Route != sourceupload.RouteLegacyConvert ||
		in.IncomingKey != LegacyConvertIncomingKey(in.JobID, plan.ConvertTo) {
		return f, ErrConvertInvalid
	}
	f.convertTo = plan.ConvertTo
	f.newName = legacyConvertedName(name, plan.ConvertTo)

	tier, err := s.effectivePlanTierForUser(ctx, tx, f.payerID)
	if err != nil {
		return f, err
	}
	limits, err := s.PlanLimits(tier)
	if err != nil {
		return f, err
	}
	if fileCap := limits.FileBytes(f.newName); in.ActualSize > fileCap {
		return f, &FileTooLargeError{LimitBytes: fileCap}
	}
	// The upload's bytes are charged already: only growth takes the gate.
	if growth := in.ActualSize - size; growth > 0 {
		err := s.gateStorageTx(ctx, tx, f.payerID, growth)
		// A frozen payer (over its quota past the grace) is refused as full.
		if errors.Is(err, ErrAccountLocked) {
			return f, fmt.Errorf("%w: %v", ErrStorageQuotaExceeded, err)
		}
		if err != nil {
			return f, err
		}
	}
	return f, nil
}

// LegacyConvertTarget is a fenced hand-over's next step: Done when its job
// already finished, else the fresh key its object is promoted to and the
// format the object must be.
type LegacyConvertTarget struct {
	Done                 *LegacyConvertResult
	FinalPath, ConvertTo string
}

// PrepareLegacyConvert fences a hand-over before the gateway touches the
// bucket. A job that already finished answers its recorded result. Otherwise
// it names the fresh key the converted object is promoted to, queued for the
// reaper first: taking it as the file's blob cancels that, and a hand-over
// that fails after the promotion leaves nothing behind.
func (s *Store) PrepareLegacyConvert(ctx context.Context, in LegacyConvert) (LegacyConvertTarget, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LegacyConvertTarget{}, err
	}
	defer tx.Rollback(ctx)
	f, err := s.legacyConvertFenceTx(ctx, tx, in)
	if err != nil || f.done != nil {
		return LegacyConvertTarget{Done: f.done}, err
	}
	target := LegacyConvertTarget{FinalPath: "sources/" + ObjectKeyID("blob") + "." + f.convertTo, ConvertTo: f.convertTo}
	if err := s.EnqueueBlobDeletionTx(ctx, tx, uploadPresignGrace, target.FinalPath); err != nil {
		return LegacyConvertTarget{}, err
	}
	return target, tx.Commit(ctx)
}

// CompleteLegacyConvert makes the converted object at finalPath (promoted and
// checked by the gateway; in.ActualSize and in.SHA256 are that object's) the
// file's bytes, in one transaction with the
// fence: the file takes its new name, blob, size, hash, ETag and revision,
// and the files triggers charge the size change, release the uploaded blob
// and send the tree event. The file then continues as the plan of its new
// name and stored parse mode says: a parse job on the conversion's session,
// or, with parsing off, ready and the session closed as a finished job closes
// it. The conversion job is done; nothing else finishes it.
func (s *Store) CompleteLegacyConvert(ctx context.Context, in LegacyConvert, finalPath, sourceETag string) (LegacyConvertResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LegacyConvertResult{}, err
	}
	defer tx.Rollback(ctx)
	f, err := s.legacyConvertFenceTx(ctx, tx, in)
	if err != nil {
		return LegacyConvertResult{}, err
	}
	if f.done != nil {
		return *f.done, nil
	}
	next, err := sourceupload.BuildProcessingPlan(f.newName, f.kind, f.parseMode)
	if err != nil {
		return LegacyConvertResult{}, err
	}
	// As a new-format upload starts: pending with a job, ready without one.
	status := "pending"
	if next.Route == sourceupload.RouteStoreOnly {
		status = "ready"
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET name=$2, blob_path=$3, size_bytes=$4, source_sha256=$5,
			source_etag=$6, revision=revision+1, status=$7 WHERE id=$1`,
		in.FileID, f.newName, finalPath, in.ActualSize, in.SHA256, sourceETag, status); err != nil {
		return LegacyConvertResult{}, err
	}
	result := LegacyConvertResult{FileID: in.FileID, Name: f.newName}
	if status == "pending" {
		jobID, err := s.enqueueFileJobTx(ctx, tx, fileJob{
			actorID: f.actorID, payerID: f.payerID, workspaceID: f.workspaceID, fileID: in.FileID,
			blobPath: finalPath, kind: f.kind, parser: f.parser, parseMode: f.parseMode,
			sourceETag: sourceETag, reservationID: f.reservation, sourceRevision: f.revision + 1,
		}, next)
		if err != nil {
			return LegacyConvertResult{}, err
		}
		result.ParseJobID = &jobID
	} else if err := settleCreditsTx(ctx, tx, f.reservation); err != nil {
		return LegacyConvertResult{}, err
	}
	// The result stays on the job for a repeated hand-over; the pictures the
	// worker removed are recorded with it.
	if _, err := tx.Exec(ctx, `UPDATE jobs SET status='done', locked_at=NULL, lease_expires_at=NULL, updated_at=now(),
			payload=payload||jsonb_build_object('convertedName',$2::text,'parseJobId',$3::text,'removedPictures',$4::int)
		WHERE id=$1`, in.JobID, f.newName, result.ParseJobID, in.RemovedPictures); err != nil {
		return LegacyConvertResult{}, err
	}
	return result, tx.Commit(ctx)
}
