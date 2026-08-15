package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/evonotes/server/internal/obs"
)

// CreateSourceWithJob inserts an uploaded file as 'processing' and enqueues an
// ingest job in the same transaction (Postgres-backed queue; the Python worker
// claims it with SKIP LOCKED). The file's url points at the raw-blob endpoint
// so the viewer can render it immediately. parseMode selects which MinerU
// backend the worker parses with: 'accurate' (hybrid VLM) or 'fast' (pipeline
// OCR) — text kinds ignore it and are inserted directly. captionImages asks the
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
	fileID := uid("f")
	url := "/api/files/" + fileID + "/raw"
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `INSERT INTO files
		(id, workspace_id, user_id, created_by, chapter_id, name, kind, size_bytes, added_at, status, parser, engine, blob_path, url)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'processing',$10,$11,$12,$13)`,
		fileID, wsID, ownerID, nullStr(createdBy), chapterID, name, kind, sizeBytes, now, parser, engine, blobPath, url); err != nil {
		return File{}, "", err
	}

	jobID := uid("job")
	payload := s.ingestJobPayload(ctx, createdBy, map[string]any{
		"fileId": fileID, "workspaceId": wsID, "blobPath": blobPath, "kind": kind,
		"parser": parser, "engine": engine, "parseMode": parseMode,
		"captionImages": captionImages,
	})
	if _, err := tx.Exec(ctx, `INSERT INTO jobs (id, type, payload) VALUES ($1,'ingest',$2)`, jobID, payload); err != nil {
		return File{}, "", err
	}

	if err := tx.Commit(ctx); err != nil {
		return File{}, "", err
	}

	f := File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "processing", Indexed: false, URL: &url}
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
	return File{ID: fileID, WorkspaceID: wsID, ChapterID: chapterID, Name: name, Kind: FileKind(kind), SizeBytes: sizeBytes, AddedAt: now, Status: "ready", Indexed: false, URL: &url}, nil
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

// ingestJobPayload is the enqueue-time snapshot for an ingest job: the actor
// who initiated the upload, plus the embedding/vision/ingest pins resolved
// now. The worker bills the actor and uses exactly those model versions even
// if the live default is retargeted mid-flight.
func (s *Store) ingestJobPayload(ctx context.Context, actorUserID string, base map[string]any) []byte {
	if actorUserID != "" {
		base["actorUserId"] = actorUserID
	}
	if s.registry != nil {
		ingest, embed, vision, err := s.registry.SnapshotIngest(ctx)
		if err != nil {
			obs.CaptureErr(ctx, err, map[string]string{"stage": "ingest_model_pin"})
		} else {
			base["ingestModelKey"] = ingest.Key
			base["ingestModelVersion"] = ingest.Version
			base["embeddingModelKey"] = embed.Key
			base["embeddingModelVersion"] = embed.Version
			base["visionModelKey"] = vision.Key
			base["visionModelVersion"] = vision.Version
		}
	}
	raw, _ := json.Marshal(base)
	return raw
}
