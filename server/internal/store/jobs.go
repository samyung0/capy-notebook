package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/evonotes/server/internal/obs"
)

// CreateSourceWithJob inserts an uploaded file as 'pending' and enqueues an
// ingest job in the same transaction (Postgres-backed queue; the Python worker
// claims it with SKIP LOCKED). The file stays pending until a worker actually
// starts (or a parser slot is free); then it becomes 'processing'. The
// file's url points at the raw-blob endpoint so the viewer can render it
// immediately. parseMode selects the CPU parser the worker runs:
// 'fast' (Marker + RapidOCR on scans). Unknown names fail validation.
// Text kinds ignore it and are inserted directly. captionImages asks the
// worker to describe the figures that parse extracted.
func (s *Store) CreateSourceWithJob(ctx context.Context, wsID, createdBy, name, kind string, chapterID *string, chapterName string, sizeBytes int64, blobPath, parser, engine, parseMode string, captionImages bool) (File, string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return File{}, "", err
	}
	defer tx.Rollback(ctx)

	chapterID, err = resolveUploadChapterID(ctx, tx, wsID, chapterID, chapterName)
	if err != nil {
		return File{}, "", err
	}
	ownerID, err := s.storageOwnerTx(ctx, tx, wsID)
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
		"sourceRevision": int64(1),
		"reservationId":  reservationID,
	})
	if err != nil {
		return File{}, "", err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO jobs (id, type, payload) VALUES ($1,'ingest',$2)`, jobID, payload); err != nil {
		return File{}, "", err
	}

	if err := tx.Commit(ctx); err != nil {
		return File{}, "", err
	}

	f := File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "pending", Indexed: false, URL: &url, Revision: 1}
	return f, jobID, nil
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

	chapterID, err = resolveUploadChapterID(ctx, tx, wsID, chapterID, chapterName)
	if err != nil {
		return File{}, err
	}
	ownerID, err := s.storageOwnerTx(ctx, tx, wsID)
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
	return File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "ready", Indexed: false, URL: &url, Revision: 1}, nil
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

// ErrIngestUnpinnable means an ingest job could not be given the identity it
// needs to be billed and priced, so the upload it belongs to must be refused.
var ErrIngestUnpinnable = errors.New("ingest cannot be enqueued without an actor and model pins")

// ingestJobPayload is the enqueue-time snapshot for an ingest job: the actor
// who will be billed, plus the ingest and vision pins resolved now. The worker
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
	ingest, vision, err := s.registry.SnapshotIngest(ctx)
	if err != nil {
		obs.CaptureErr(ctx, err, map[string]string{"stage": "ingest_model_pin"})
		return nil, fmt.Errorf("%w: %v", ErrIngestUnpinnable, err)
	}
	base["ingestProviderSlug"] = ingest.ProviderSlug
	base["ingestModelSlug"] = ingest.ModelSlug
	base["ingestModelVersion"] = ingest.Version
	base["visionProviderSlug"] = vision.ProviderSlug
	base["visionModelSlug"] = vision.ModelSlug
	base["visionModelVersion"] = vision.Version
	return json.Marshal(base)
}
