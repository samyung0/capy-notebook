package store

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/models"
)

// MoveTarget is where MoveFiles puts files: a workspace and an optional
// chapter, existing or new by name.
type MoveTarget struct {
	WorkspaceID string
	ChapterID   *string
	ChapterName string
}

// ProgressLossError refuses a move that would drop someone's started or
// finished study progress in the workspaces the files leave, until the caller
// confirms it (Epo 2026-10-27). PlanSteps counts the plan steps that go too.
type ProgressLossError struct {
	People    int
	PlanSteps int
}

func (e *ProgressLossError) Error() string {
	return fmt.Sprintf("moving drops study progress of %d people and %d plan steps", e.People, e.PlanSteps)
}

// ErrFileProcessing refuses to move a file whose pipeline job (parse, ingest
// or source refresh) is still writing its index in the scope it leaves.
var ErrFileProcessing = errors.New("file is processing")

type movingFile struct{ id, workspaceID, payerID string }

// MoveFiles puts files into a workspace, never out of one (Epo 2026-10-27):
// a standalone file by its owner, a workspace file by that workspace's owner
// or the file's payer, the actor editing the target. The payer stays. The
// left workspaces' study progress and plan steps for the files go, refused
// with ProgressLossError until confirmLoss when someone's progress would. The
// index follows when the target embeds in the same space, else the file is
// ingested there.
//
// Locks follow every workspace write: workspace rows (by id), then accounts,
// then the file rows, re-read under their locks.
func (s *Store) MoveFiles(ctx context.Context, actorID string, fileIDs []string, target MoveTarget, confirmLoss bool) ([]File, error) {
	if actorID == "" || target.WorkspaceID == "" || len(fileIDs) == 0 {
		return nil, ErrNotFound
	}
	ids := slices.Clone(fileIDs)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	files, err := readMovingFilesTx(ctx, tx, ids, false)
	if err != nil {
		return nil, err
	}
	workspaces := []string{target.WorkspaceID}
	for _, f := range files {
		if f.workspaceID != "" {
			workspaces = append(workspaces, f.workspaceID)
		}
	}
	owners := map[string]string{}
	wsRows, err := tx.Query(ctx, `SELECT id, user_id FROM workspaces WHERE id = ANY($1) ORDER BY id FOR UPDATE`, workspaces)
	if err != nil {
		return nil, err
	}
	for wsRows.Next() {
		var id, owner string
		if err := wsRows.Scan(&id, &owner); err != nil {
			wsRows.Close()
			return nil, err
		}
		owners[id] = owner
	}
	wsRows.Close()
	if err := wsRows.Err(); err != nil {
		return nil, err
	}
	// Who may move comes before anything that tells a file's state.
	for _, f := range files {
		if f.payerID != actorID && (f.workspaceID == "" || owners[f.workspaceID] != actorID) {
			return nil, ErrNotFound
		}
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, target.WorkspaceID, actorID); err != nil {
		return nil, err
	}
	locked, err := readMovingFilesTx(ctx, tx, ids, true)
	if err != nil {
		return nil, err
	}
	if !slices.Equal(locked, files) {
		// Moved, trashed or re-owned since the first read: the caller retries.
		return nil, ErrConflict
	}
	for _, f := range files {
		if f.workspaceID == target.WorkspaceID {
			return nil, ErrConflict
		}
	}
	var busy bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE id = ANY($1) AND status IN ('pending','processing'))
		OR EXISTS (SELECT 1 FROM jobs WHERE payload->>'fileId' = ANY($1)
			AND type IN ('parse','ingest','source_refresh') AND status IN ('pending','running'))`, ids).Scan(&busy); err != nil {
		return nil, err
	}
	if busy {
		return nil, ErrFileProcessing
	}
	if err := s.gateWorkspaceFilesTx(ctx, tx, target.WorkspaceID, len(files)); err != nil {
		return nil, err
	}
	chapterID, err := resolveUploadChapterID(ctx, tx, target.WorkspaceID, target.ChapterID, target.ChapterName)
	if err != nil {
		return nil, err
	}

	// Only progress someone started or finished asks first (Epo 2026-10-27,
	// R10); plan steps and removed progress go with it either way.
	var people, steps int
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT count(DISTINCT user_id) FROM study_progress WHERE file_id = ANY($1) AND state IN ('started','done')),
		(SELECT count(*) FROM study_plan_steps WHERE file_id = ANY($1))`, ids).Scan(&people, &steps); err != nil {
		return nil, err
	}
	if people > 0 && !confirmLoss {
		return nil, &ProgressLossError{People: people, PlanSteps: steps}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM study_progress WHERE file_id = ANY($1)`, ids); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM study_plan_steps WHERE file_id = ANY($1)`, ids); err != nil {
		return nil, err
	}

	for _, f := range files {
		if err := s.moveFileTx(ctx, tx, actorID, f.id, target.WorkspaceID, chapterID); err != nil {
			return nil, err
		}
	}
	// Each open source room drains (Q447): it stores what it admitted,
	// people's typing and agent edits, then closes; its tabs first hear the
	// move with the target workspace (Q454) and reconnect through the access
	// check of the file's new place. The row is
	// enqueue_source_collaboration_eviction's with this type and workspace.
	if _, err := tx.Exec(ctx, `INSERT INTO collaboration_eviction_outbox (id, channel, payload)
		SELECT e.id, 'capy:collaboration:evict', jsonb_build_object(
			'evictionId', e.id, 'fileId', d.file_id,
			'room', 'source:' || d.file_id || ':epoch:' || d.epoch::text,
			'type', 'file-moved', 'mode', 'drain', 'workspaceId', $2::text)
		FROM source_documents d,
			LATERAL (SELECT 'cev_' || substr(md5(random()::text || clock_timestamp()::text || d.file_id), 1, 24) AS id) e
		WHERE d.file_id = ANY($1)`, ids, target.WorkspaceID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	out := make([]File, 0, len(files))
	for _, f := range files {
		file, err := s.GetFile(ctx, f.id)
		if err != nil {
			return nil, err
		}
		out = append(out, file)
	}
	return out, nil
}

// readMovingFilesTx reads the untrashed files of ids (sorted), with lock
// FOR UPDATE; any id missing or trashed is not found.
func readMovingFilesTx(ctx context.Context, tx pgx.Tx, ids []string, lock bool) ([]movingFile, error) {
	query := `SELECT id, COALESCE(workspace_id, ''), user_id FROM files
		WHERE id = ANY($1) AND trashed_at IS NULL ORDER BY id`
	if lock {
		query += ` FOR UPDATE`
	}
	rows, err := tx.Query(ctx, query, ids)
	if err != nil {
		return nil, err
	}
	files, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (movingFile, error) {
		var f movingFile
		return f, row.Scan(&f.id, &f.workspaceID, &f.payerID)
	})
	if err != nil {
		return nil, err
	}
	if len(files) != len(ids) {
		return nil, ErrNotFound
	}
	return files, nil
}

// moveFileTx puts one file into workspaceID with its served index: onto the
// target's ready copy of the same content, or a copy made in the target, when
// the target embeds in the same space. Otherwise, or while the target is still
// building that content, the file is ingested there, paid by the mover as a
// cross-space clone is. The alias is dropped before the file row changes (its
// composite key names the old workspace) and after the copy read it.
func (s *Store) moveFileTx(ctx context.Context, tx pgx.Tx, actorID, fileID, workspaceID string, chapterID *string) error {
	var contentID, contentHash string
	var src models.Pin
	var srcDim *int
	err := tx.QueryRow(ctx, `SELECT rc.id, rc.content_hash,
			COALESCE(rc.embedding_provider_slug, ''), COALESCE(rc.embedding_model_slug, ''),
			COALESCE(rc.embedding_model_version, 0), rc.embedding_dim
		FROM rag_file_contents fc JOIN rag_contents rc ON rc.id=fc.content_id AND rc.status='ready'
		WHERE fc.file_id=$1`, fileID).
		Scan(&contentID, &contentHash, &src.ProviderSlug, &src.ModelSlug, &src.Version, &srcDim)
	served := err == nil
	if err != nil && !isNoRows(err) {
		return err
	}

	held, reingest := "", false
	var snapshot []workspaceCloneFile
	if served {
		var dst models.Pin
		var dstDim int
		if err := tx.QueryRow(ctx, `SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim
			FROM workspaces WHERE id=$1`, workspaceID).Scan(&dst.ProviderSlug, &dst.ModelSlug, &dst.Version, &dstDim); err != nil {
			return err
		}
		var status string
		err := tx.QueryRow(ctx, `SELECT id, status FROM rag_contents WHERE workspace_id=$1 AND content_hash=$2`,
			workspaceID, contentHash).Scan(&held, &status)
		switch {
		case src != dst || srcDim == nil || *srcDim != dstDim || (err == nil && status != "ready"):
			held, reingest = "", true
		case isNoRows(err):
			held = uid("rgc")
			if err := copyRetrievalContents(ctx, tx, workspaceID, dst, map[string]string{contentID: held}); err != nil {
				return err
			}
		case err != nil:
			return err
		}
		if reingest {
			// Read while the alias still serves, so a partial file counts.
			if snapshot, err = snapshotCloneFilesTx(ctx, tx, `f.id=$1`, fileID); err != nil {
				return err
			}
		}
	}

	// The orphan trigger drops the old content once nothing holds it.
	if _, err := tx.Exec(ctx, `DELETE FROM rag_file_contents WHERE file_id=$1`, fileID); err != nil {
		return err
	}
	position, err := nextContentPosition(ctx, tx, workspaceID, chapterID)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE files SET workspace_id=$2, chapter_id=$3, position=$4 WHERE id=$1`,
		fileID, workspaceID, chapterID, position); err != nil {
		return err
	}
	// A key borrowed from another file names that file's workspace, and a key
	// of this file lent to others would name it in theirs: both go, so a key's
	// path always names a file of its own workspace (thumbnails.md).
	if _, err := tx.Exec(ctx, `UPDATE files SET thumbnail_key=NULL
		WHERE (id=$1 AND NOT starts_with(thumbnail_key, 'thumbs/' || $1 || '/'))
			OR (id<>$1 AND starts_with(thumbnail_key, 'thumbs/' || $1 || '/'))`, fileID); err != nil {
		return err
	}
	switch {
	case held != "":
		_, err = tx.Exec(ctx, `INSERT INTO rag_file_contents (file_id, workspace_id, content_id) VALUES ($1,$2,$3)`,
			fileID, workspaceID, held)
		return err
	case reingest && len(snapshot) > 0:
		return s.queueCloneIngestTx(ctx, tx, actorID, workspaceID, fileID, snapshot[0])
	case served || reingest:
		_, err = tx.Exec(ctx, `UPDATE files SET indexed=false WHERE id=$1`, fileID)
		return err
	}
	return nil
}
