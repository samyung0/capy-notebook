package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/sourceupload"
)

// createSourceWithJobTx inserts a source as 'pending' and enqueues its first
// pipeline stage in the caller's transaction. Document routes start as parse
// jobs; direct routes start as ingest jobs. The file stays pending until a
// worker starts it. Agent-created files land through here.
// A file the chat agent made carries the library provenance it was written
// from; the quota gate counts that record with the bytes, as for a material.
func (s *Store) createSourceWithJobTx(ctx context.Context, tx pgx.Tx, wsID, createdBy, name, kind string, chapterID *string, chapterName string, sizeBytes int64, blobPath, parser, parseMode string, provenance *Provenance) (File, string, error) {
	processingPlan, err := sourceupload.BuildProcessingPlan(name, kind, parseMode)
	if err != nil || processingPlan.Route == sourceupload.RouteStoreOnly {
		if err == nil {
			err = fmt.Errorf("file %q does not have an ingest route", name)
		}
		return File{}, "", err
	}
	var provenanceJSON []byte
	if provenance != nil {
		if provenanceJSON, err = json.Marshal(provenance); err != nil {
			return File{}, "", err
		}
	}

	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, createdBy)
	if err != nil {
		return File{}, "", err
	}
	chapterID, err = resolveUploadChapterID(ctx, tx, wsID, chapterID, chapterName)
	if err != nil {
		return File{}, "", err
	}
	if err := s.gateStorageTx(ctx, tx, ownerID, sizeBytes+int64(len(provenanceJSON))); err != nil {
		return File{}, "", err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, wsID, 1); err != nil {
		return File{}, "", err
	}
	reservationID, err := s.beginIngestSpendTx(ctx, tx, createdBy, wsID)
	if err != nil {
		return File{}, "", err
	}
	fileID := uid("f")
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, blob_path, parse_mode, provenance)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13)`,
		fileID, wsID, ownerID, nullStr(createdBy), chapterID, name, kind, sizeBytes, now, parser, blobPath, parseMode, provenanceJSON); err != nil {
		return File{}, "", err
	}

	jobID := uid("job")
	payload, err := s.ingestJobPayload(ctx, tx, createdBy, map[string]any{
		"fileId": fileID, "workspaceId": wsID, "blobPath": blobPath, "kind": kind,
		"parser": parser, "parseMode": parseMode,
		"processingPlan": processingPlan,
		"sourceETag":     "",
		"sourceRevision": int64(1),
		"reservationId":  reservationID,
	})
	if err != nil {
		return File{}, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO jobs (id, type, payload) VALUES ($1,$2,$3)`, jobID, initialPipelineJobType(processingPlan), payload); err != nil {
		return File{}, "", err
	}

	f := File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "pending", Indexed: false, HasBytes: blobPath != "", Revision: 1, Provenance: provenance}
	return f, jobID, nil
}

// AgentFileDraft is a file the chat agent made, a deck's PPTX, already in the
// blob store at BlobPath.
type AgentFileDraft struct {
	WorkspaceID, ActorUserID, Name, Kind string
	ChapterID                            *string
	SizeBytes                            int64
	BlobPath, Parser, ParseMode          string
	Provenance                           *Provenance
}

// CreateAgentFileOperation lands an agent's file the way an upload does (the
// editor check, the owner's quota, the files row and its ingest job) together
// with its durable receipt. created is false when the receipt already existed,
// so the caller removes the blob it put for nothing.
func (s *Store) CreateAgentFileOperation(ctx context.Context, draft AgentFileDraft, op AgentOperation) (AgentOperation, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, false, err
	}
	defer tx.Rollback(ctx)
	existing, err := lockAgentOperationTx(ctx, tx, op.ID, op.RequestHash)
	if err != nil {
		return AgentOperation{}, false, err
	}
	if existing != nil {
		return *existing, false, nil
	}
	f, _, err := s.createSourceWithJobTx(ctx, tx, draft.WorkspaceID, draft.ActorUserID, draft.Name, draft.Kind,
		draft.ChapterID, "", draft.SizeBytes, draft.BlobPath, draft.Parser, draft.ParseMode, draft.Provenance)
	if err != nil {
		return AgentOperation{}, false, err
	}
	// agent_operations.kind has no file kind; a deck is the agent's study
	// material, stored as a file.
	op.Kind = "create_material"
	op.Outcome = agenttools.OutcomeSucceeded
	op.Error = nil
	op.Effect = &agenttools.ResourceEffect{
		Operation:   agenttools.EffectCreated,
		OperationID: op.ID,
		Resource: agenttools.ResourceRef{
			Kind: agenttools.KindSourceFile, ID: f.ID, Title: f.Name, WorkspaceID: f.WorkspaceID,
		},
	}
	if err := insertAgentOperationTx(ctx, tx, op); err != nil {
		return AgentOperation{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentOperation{}, false, err
	}
	return op, true, nil
}

func initialPipelineJobType(plan sourceupload.ProcessingPlan) string {
	if plan.Route == sourceupload.RouteDocumentParse {
		return "parse"
	}
	return "ingest"
}

// FileBlobPaths returns the source and the same object as a preview for PDFs.
// Office sources have no retained PDF. Either path is empty without stored bytes.
func (s *Store) FileBlobPaths(ctx context.Context, id string) (source, preview string, err error) {
	var sourcePath, previewPath *string
	err = s.pool.QueryRow(ctx, `SELECT blob_path,
		CASE WHEN status='ready' THEN
			CASE WHEN kind='pdf' THEN blob_path END
		END
	FROM files WHERE id=$1 AND trashed_at IS NULL`, id).Scan(&sourcePath, &previewPath)
	if isNoRows(err) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if sourcePath != nil {
		source = *sourcePath
	}
	if previewPath != nil {
		preview = *previewPath
	}
	return source, preview, nil
}

// ErrIngestUnpinnable means an ingest job could not be given the identity it
// needs to be billed and priced, so the upload it belongs to must be refused.
var ErrIngestUnpinnable = errors.New("ingest cannot be enqueued without an actor and model pins")

// ingestJobPayload is the enqueue-time snapshot for an ingest job: the actor
// who will be billed, plus the ingest and captioning pins resolved now. The worker
// uses exactly those versions even if the live default is retargeted while the
// job sits in the queue.
//
// It returns an error rather than a best-effort payload, and every caller aborts
// its transaction on one. Both fields it guards are the difference between paid
// and free work: without actorUserId the worker has nobody to charge and settles
// nothing, and without the pins it would run on its own current defaults and
// settle at those rates. Enqueueing anyway meant the most expensive path in the
// product — document parsing, captions, embeddings, summaries — could run for free, and
// the more the registry was reconfigured the likelier that became. Refusing the
// upload is visible, retryable, and cheap by comparison.
//
// The embedding model is not snapshotted here: it belongs to the workspace
// (the workspace embedding provider/model/version pin), which the worker reads directly. A per-job
// copy could only ever agree with it or corrupt the workspace's vector space.
//
// Callers enqueue under workspace and account locks, so the rates are read on
// their transaction (q): a second pool connection could wait behind requests
// that are themselves waiting on those locks, and starve the pool.
func (s *Store) ingestJobPayload(ctx context.Context, q rowsQueryer, actorUserID string, base map[string]any) ([]byte, error) {
	if actorUserID == "" {
		return nil, fmt.Errorf("%w: no actor", ErrIngestUnpinnable)
	}
	base["actorUserId"] = actorUserID
	if s.registry == nil {
		return nil, fmt.Errorf("%w: no model registry", ErrIngestUnpinnable)
	}
	ingest, captioning, err := s.registry.SnapshotIngest(ctx)
	if err != nil {
		eventID := obs.CaptureErr(ctx, err, map[string]string{"stage": "ingest_model_pin"})
		return nil, obs.WithEventID(fmt.Errorf("%w: %v", ErrIngestUnpinnable, err), eventID)
	}
	base["ingestProviderSlug"] = ingest.ProviderSlug
	base["ingestModelSlug"] = ingest.ModelSlug
	base["ingestModelVersion"] = ingest.Version
	base["captioningProviderSlug"] = captioning.ProviderSlug
	base["captioningModelSlug"] = captioning.ModelSlug
	base["captioningModelVersion"] = captioning.Version
	rates, err := activeResourceRates(ctx, q, ingestResourceKeys)
	if err != nil {
		eventID := obs.CaptureErr(ctx, err, map[string]string{"stage": "ingest_resource_rates"})
		return nil, obs.WithEventID(fmt.Errorf("%w: %v", ErrIngestUnpinnable, err), eventID)
	}
	base["resourceRates"] = rates
	return json.Marshal(base)
}

// RetryFileProcessing runs a failed file's processing again on its stored
// bytes, in the parse mode the owner picked ('none' just stores it). Only the
// owner retries and pays, as automatic reprocessing charges the owner; the
// automatic scheduler never retries a failed file. A file that is not failed,
// has no bytes or already has a parse or ingest job queued answers
// ErrConflict.
func (s *Store) RetryFileProcessing(ctx context.Context, actorID, fileID, parseMode, parser string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var wsID, name, kind, status, blobPath, etag string
	var revision int64
	err = tx.QueryRow(ctx, `SELECT workspace_id,name,kind,status,COALESCE(blob_path,''),COALESCE(source_etag,''),revision
		FROM files WHERE id=$1 AND trashed_at IS NULL`, fileID).Scan(&wsID, &name, &kind, &status, &blobPath, &etag, &revision)
	if isNoRows(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, actorID)
	if err != nil {
		return err
	}
	if actorID != ownerID {
		return ErrForbidden
	}
	var queued bool
	err = tx.QueryRow(ctx, `SELECT status,EXISTS(SELECT 1 FROM jobs WHERE payload->>'fileId'=$1 AND type IN ('parse','ingest') AND status IN ('pending','running'))
		FROM files WHERE id=$1 FOR UPDATE`, fileID).Scan(&status, &queued)
	if err != nil {
		return err
	}
	if status != string(FileFailed) || blobPath == "" || queued {
		return ErrConflict
	}
	plan, err := sourceupload.BuildProcessingPlan(name, kind, parseMode)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrParseModeUnsupported, err)
	}
	if plan.Route == sourceupload.RouteStoreOnly {
		_, err = tx.Exec(ctx, `UPDATE files SET status='ready',indexed=false,parse_mode=$2 WHERE id=$1`, fileID, parseMode)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	reservation, err := s.beginIngestSpendTx(ctx, tx, ownerID, wsID)
	if err != nil {
		return err
	}
	payload, err := s.ingestJobPayload(ctx, tx, ownerID, map[string]any{
		"fileId": fileID, "workspaceId": wsID, "blobPath": blobPath, "kind": kind,
		"parser": parser, "parseMode": parseMode, "processingPlan": plan,
		"sourceETag": etag, "sourceRevision": revision, "reservationId": reservation,
	})
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,$2,$3)`, uid("job"), initialPipelineJobType(plan), payload); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE files SET status='pending',indexed=false,parse_mode=$2 WHERE id=$1`, fileID, parseMode); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
