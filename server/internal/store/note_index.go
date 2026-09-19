package store

import (
	"context"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// Workspace notes are indexed for retrieval like files. Projection marks a
// note dirty when its content changes (see ProjectMaterialContent and
// UpdateMaterial); the collaboration scheduler calls RequestMaterialIndex for
// dirty notes that have been idle; the ingest worker fetches the note's text
// through MaterialIndexText, writes rag_material_contents and clears
// index_job_id when it is done. Standalone notes have no workspace and are
// never indexed.

// noteIndexDirtySQL is the SET fragment a content write appends: a workspace
// note becomes dirty (keeping an earlier dirty mark) and forgets its last
// index failure, so the next scheduler pass retries.
const noteIndexDirtySQL = `index_dirty_at=CASE WHEN kind='note' AND workspace_id IS NOT NULL
	THEN COALESCE(index_dirty_at, now()) END, index_error=NULL`

// MaterialIndexText is what the ingest worker chunks for a note.
type MaterialIndexText struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Revision int64  `json:"revision"`
	Text     string `json:"text"`
}

// MaterialIndexText renders an active workspace note for indexing.
func (s *Store) MaterialIndexText(ctx context.Context, materialID string) (MaterialIndexText, error) {
	var out MaterialIndexText
	var content string
	err := s.pool.QueryRow(ctx, `SELECT id, title, revision, content FROM materials
		WHERE id=$1 AND kind='note' AND workspace_id IS NOT NULL AND trashed_at IS NULL`, materialID).
		Scan(&out.ID, &out.Title, &out.Revision, &content)
	if isNoRows(err) {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.Text, err = materialdoc.ExtractIndexText(content)
	return out, err
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
	var workspaceID, ownerID string
	var autoReindex bool
	var dirtyAt *time.Time
	var runningJob, indexError *string
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT m.workspace_id, w.user_id, w.auto_reindex, m.index_dirty_at,
			m.index_job_id, m.index_error, m.revision
		FROM materials m JOIN workspaces w ON w.id=m.workspace_id
		WHERE m.id=$1 AND m.kind='note' AND m.trashed_at IS NULL FOR UPDATE OF m`, materialID).
		Scan(&workspaceID, &ownerID, &autoReindex, &dirtyAt, &runningJob, &indexError, &revision); err != nil {
		if isNoRows(err) {
			return "", ErrNotFound
		}
		return "", err
	}
	if !autoReindex || dirtyAt == nil || runningJob != nil || indexError != nil {
		return "", ErrConflict
	}
	reservation, err := s.beginIngestSpendTx(ctx, tx, ownerID, workspaceID)
	if err != nil {
		return "", err
	}
	payload, err := s.ingestJobPayload(ctx, ownerID, map[string]any{
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
