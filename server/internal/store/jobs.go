package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/evonotes/server/internal/obs"
	"github.com/evonotes/server/internal/sourceupload"
)

// CreateSourceWithJob inserts an uploaded file as 'pending' and enqueues its
// first pipeline stage in the same transaction. Document routes start as parse
// jobs; direct routes start as ingest jobs. The file stays pending until a
// coordinator/worker actually starts (and, for documents, gets a parser slot);
// then it becomes 'processing'. The
// file's url points at the raw-blob endpoint so the viewer can render it
// immediately. parseMode selects the CPU parser the coordinator runs:
// 'fast' (MinerU pipeline with automatic OCR selection). Unknown names fail validation.
// Text kinds ignore it and are inserted directly. captionImages asks the
// worker to describe the figures that parse extracted.
func (s *Store) CreateSourceWithJob(ctx context.Context, wsID, createdBy, name, kind string, chapterID *string, chapterName string, sizeBytes int64, blobPath, parser, engine, parseMode string, captionImages bool) (File, string, error) {
	processingPlan, err := sourceupload.BuildProcessingPlan(name, kind, parseMode, captionImages)
	if err != nil || processingPlan.Route == sourceupload.RouteStoreOnly {
		if err == nil {
			err = fmt.Errorf("file %q does not have an ingest route", name)
		}
		return File{}, "", err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, "", err
	}
	defer tx.Rollback(ctx)

	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, createdBy)
	if err != nil {
		return File{}, "", err
	}
	chapterID, err = resolveUploadChapterID(ctx, tx, wsID, chapterID, chapterName)
	if err != nil {
		return File{}, "", err
	}
	if err := s.gateStorageTx(ctx, tx, ownerID, sizeBytes); err != nil {
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
	url := "/api/files/" + fileID + "/raw"
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, engine, blob_path, url, parse_mode, caption_images)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,$15)`,
		fileID, wsID, ownerID, nullStr(createdBy), chapterID, name, kind, sizeBytes, now, parser, engine, blobPath, url, parseMode, captionImages); err != nil {
		return File{}, "", err
	}

	jobID := uid("job")
	payload, err := s.ingestJobPayload(ctx, createdBy, map[string]any{
		"fileId": fileID, "workspaceId": wsID, "blobPath": blobPath, "kind": kind,
		"parser": parser, "engine": engine, "parseMode": parseMode,
		"captionImages":  captionImages,
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

	if err := tx.Commit(ctx); err != nil {
		return File{}, "", err
	}

	f := File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "pending", Indexed: false, URL: &url, Revision: 1}
	return f, jobID, nil
}

func initialPipelineJobType(plan sourceupload.ProcessingPlan) string {
	if plan.Route == sourceupload.RouteDocumentParse {
		return "parse"
	}
	return "ingest"
}

// CreateSourceReady inserts an uploaded file that skips parsing entirely
// (parse mode 'none' / formats no parser supports). The blob is stored for
// viewing but no ingest job is enqueued, so the file is 'ready' at once.
func (s *Store) CreateSourceReady(ctx context.Context, wsID, createdBy, name, kind string, chapterID *string, chapterName string, sizeBytes int64, blobPath string) (File, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback(ctx)

	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, createdBy)
	if err != nil {
		return File{}, err
	}
	chapterID, err = resolveUploadChapterID(ctx, tx, wsID, chapterID, chapterName)
	if err != nil {
		return File{}, err
	}
	if err := s.gateStorageTx(ctx, tx, ownerID, sizeBytes); err != nil {
		return File{}, err
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, wsID, 1); err != nil {
		return File{}, err
	}
	fileID := uid("f")
	url := "/api/files/" + fileID + "/raw"
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, blob_path, url)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11)`,
		fileID, wsID, ownerID, nullStr(createdBy), chapterID, name, kind, sizeBytes, now, blobPath, url); err != nil {
		return File{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return File{}, err
	}
	file := File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "ready", Indexed: false, URL: &url, Revision: 1}
	if FileKind(kind) == FilePDF && blobPath != "" {
		previewURL := "/api/files/" + fileID + "/preview"
		file.PreviewURL = &previewURL
	}
	return file, nil
}

// FileBlob returns the B2 object key and kind for a raw file.
func (s *Store) FileBlob(ctx context.Context, id string) (blobPath string, kind string, content *string, url *string, err error) {
	var bp *string
	err = s.pool.QueryRow(ctx, `SELECT blob_path, kind, content, url FROM files WHERE id=$1`, id).Scan(&bp, &kind, &content, &url)
	if isNoRows(err) {
		return "", "", nil, nil, ErrNotFound
	}
	if bp != nil {
		blobPath = *bp
	}
	return blobPath, kind, content, url, err
}

// FilePreviewBlob returns the PDF bytes whose page coordinates match citation
// regions. Native PDFs use their source object. Office files use the exact PDF
// emitted by LibreOffice before Marker parsed it.
func (s *Store) FilePreviewBlob(ctx context.Context, id string) (string, error) {
	var path *string
	err := s.pool.QueryRow(ctx, `SELECT CASE
		WHEN kind='pdf' THEN blob_path
		ELSE preview_blob_path
	END FROM files WHERE id=$1 AND status='ready'`, id).Scan(&path)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if path == nil || *path == "" {
		return "", ErrNotFound
	}
	return *path, nil
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
func (s *Store) ingestJobPayload(ctx context.Context, actorUserID string, base map[string]any) ([]byte, error) {
	if actorUserID == "" {
		return nil, fmt.Errorf("%w: no actor", ErrIngestUnpinnable)
	}
	base["actorUserId"] = actorUserID
	if s.registry == nil {
		return nil, fmt.Errorf("%w: no model registry", ErrIngestUnpinnable)
	}
	ingest, captioning, err := s.registry.SnapshotIngest(ctx)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "ingest_model_pin"})
		return nil, fmt.Errorf("%w: %v", ErrIngestUnpinnable, err)
	}
	base["ingestProviderSlug"] = ingest.ProviderSlug
	base["ingestModelSlug"] = ingest.ModelSlug
	base["ingestModelVersion"] = ingest.Version
	base["captioningProviderSlug"] = captioning.ProviderSlug
	base["captioningModelSlug"] = captioning.ModelSlug
	base["captioningModelVersion"] = captioning.Version
	rates, err := s.ActiveResourceRates(ctx, ingestResourceKeys)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "ingest_resource_rates"})
		return nil, fmt.Errorf("%w: %v", ErrIngestUnpinnable, err)
	}
	base["resourceRates"] = rates
	return json.Marshal(base)
}
