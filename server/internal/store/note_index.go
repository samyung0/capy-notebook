package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// Workspace notes are indexed for retrieval like files. Projection marks a
// note dirty when its content changes, or an embedded item's does (see
// ProjectMaterialContent and UpdateMaterial); the collaboration scheduler calls RequestMaterialIndex for
// dirty notes that have been idle; the ingest worker fetches the note's text
// through MaterialIndexText and writes rag_material_contents. When the job
// ends, the trigger on jobs (migrations 0082, 0083) clears index_job_id: a job
// that failed with no edit since admission parks the note (dirty, index_error)
// until its next edit, and an edit made while the job ran keeps it due.
// Standalone notes have no workspace and are never indexed.

// noteIndexDirtySQL is the SET fragment a content write appends: a workspace
// note becomes dirty (keeping an earlier dirty mark) and forgets its last
// index failure, so the next scheduler pass retries.
const noteIndexDirtySQL = `index_dirty_at=CASE WHEN kind='note' AND workspace_id IS NOT NULL
	THEN COALESCE(index_dirty_at, now()) END, index_error=NULL`

// MaterialIndexText is what the ingest worker chunks for a note: its text
// and the same text per top-level block (Text joins Blocks).
type MaterialIndexText struct {
	ID       string                   `json:"id"`
	Title    string                   `json:"title"`
	Revision int64                    `json:"revision"`
	Text     string                   `json:"text"`
	Blocks   []materialdoc.IndexBlock `json:"blocks"`
}

// MaterialIndexText renders an active note of the given workspace for
// indexing, with its embedded quizzes and flashcard sets at their
// references; the workspace binds the internal caller to its own scope.
func (s *Store) MaterialIndexText(ctx context.Context, materialID, workspaceID string) (MaterialIndexText, error) {
	var out MaterialIndexText
	var content string
	err := s.pool.QueryRow(ctx, `SELECT id, title, revision, content FROM materials
		WHERE id=$1 AND workspace_id=$2 AND kind='note' AND trashed_at IS NULL`, materialID, workspaceID).
		Scan(&out.ID, &out.Title, &out.Revision, &content)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	items, err := s.noteItemContents(ctx, materialID, workspaceID)
	if err != nil {
		return out, err
	}
	if out.Blocks, err = materialdoc.ExtractIndexBlocks(content, items); err != nil {
		return out, err
	}
	out.Text = materialdoc.JoinIndexBlocks(out.Blocks)
	return out, nil
}

// noteItemContents are the stored contents of a note's active embedded
// items by id; the extraction reads those the note references.
func (s *Store) noteItemContents(ctx context.Context, noteID, workspaceID string) (map[string]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, content FROM materials
		WHERE parent_material_id=$1 AND workspace_id=$2 AND trashed_at IS NULL`, noteID, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := map[string]string{}
	for rows.Next() {
		var id, content string
		if err := rows.Scan(&id, &content); err != nil {
			return nil, err
		}
		items[id] = content
	}
	return items, rows.Err()
}

// markParentNoteDirtyTx marks the note an item is embedded in dirty, with
// the rule its own content writes use: the item's text is part of the
// note's index text. A note's projection takes the workspace (or account)
// lock before its children's rows, as an item's write does, so the two
// never wait on each other's rows.
func markParentNoteDirtyTx(ctx context.Context, tx pgx.Tx, itemID string) error {
	_, err := tx.Exec(ctx, `UPDATE materials SET `+noteIndexDirtySQL+`
		WHERE id=(SELECT parent_material_id FROM materials WHERE id=$1) AND trashed_at IS NULL`, itemID)
	return err
}

// RequestMaterialIndex turns a dirty, idle, not yet queued workspace note into
// one ingest job paid by the workspace owner. ErrConflict means the note is
// not due: the scheduler treats it as a skip, not a failure.
func (s *Store) RequestMaterialIndex(ctx context.Context, materialID string) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	// Workspace, owner account, then material: the order every workspace write
	// and projection takes. Locking the material (or the account) first
	// deadlocked against them.
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM materials
		WHERE id=$1 AND kind='note' AND workspace_id IS NOT NULL AND trashed_at IS NULL`, materialID).
		Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	ownerID, err := s.lockWorkspaceMutationTx(ctx, tx, workspaceID, "")
	if err != nil {
		return "", err
	}
	var autoProcess bool
	var dirtyAt *time.Time
	var runningJob, indexError *string
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT w.auto_process, m.index_dirty_at,
			m.index_job_id, m.index_error, m.revision
		FROM materials m JOIN workspaces w ON w.id=m.workspace_id
		WHERE m.id=$1 AND m.workspace_id=$2 AND m.kind='note' AND m.trashed_at IS NULL FOR UPDATE OF m`,
		materialID, workspaceID).
		Scan(&autoProcess, &dirtyAt, &runningJob, &indexError, &revision); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	if !autoProcess || dirtyAt == nil || runningJob != nil || indexError != nil {
		return "", ErrConflict
	}
	reservation, err := s.beginIngestSpendTx(ctx, tx, ownerID, workspaceID)
	if err != nil {
		return "", err
	}
	payload, err := s.ingestJobPayload(ctx, tx, ownerID, map[string]any{
		"materialId": materialID, "workspaceId": workspaceID, "revision": revision,
		"reservationId": reservation, "automatic": true,
	})
	if err != nil {
		return "", err
	}
	jobID := uid("job")
	if _, err := tx.Exec(ctx, `INSERT INTO jobs(id,type,payload) VALUES($1,'ingest',$2)`, jobID, payload); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `UPDATE materials SET index_job_id=$2, index_dirty_at=NULL WHERE id=$1`,
		materialID, jobID); err != nil {
		return "", err
	}
	return jobID, tx.Commit(ctx)
}
