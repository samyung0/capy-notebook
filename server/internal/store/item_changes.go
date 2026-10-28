package store

import (
	"context"
	"encoding/json"
)

// SourceChangeRow is one file's unindexed state, read by id with no
// workspace filter (Epo 2026-10-28): the caller checked the actor may read
// it. A text file's changes are stored with each save (Changes); an Office
// file's are read from the collaboration service when it has unprocessed
// edits (OfficePending).
type SourceChangeRow struct {
	FileID            string          `json:"fileId"`
	Name              string          `json:"name"`
	WorkspaceID       string          `json:"workspaceId"`
	Format            string          `json:"-"`
	Epoch             int64           `json:"epoch"`
	Checkpoint        int64           `json:"checkpoint"`
	IndexedCheckpoint int64           `json:"indexedCheckpoint"`
	Changes           json.RawMessage `json:"changes"`
	OfficePending     bool            `json:"-"`
}

// SourceChangeRows reads the untrashed files' rows among fileIDs, in id
// order; a file with no source document has none.
func (s *Store) SourceChangeRows(ctx context.Context, fileIDs []string) ([]SourceChangeRow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT f.id, f.name, COALESCE(f.workspace_id, ''), d.format, d.epoch, d.checkpoint,
			d.indexed_checkpoint, d.pending_effects,
			d.format <> 'text' AND (d.checkpoint > d.indexed_checkpoint OR d.net_tokens > 0)
		FROM files f JOIN source_documents d ON d.file_id=f.id
		WHERE f.id = ANY($1) AND f.trashed_at IS NULL
		ORDER BY f.id`, fileIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SourceChangeRow{}
	for rows.Next() {
		var row SourceChangeRow
		if err := rows.Scan(&row.FileID, &row.Name, &row.WorkspaceID, &row.Format, &row.Epoch,
			&row.Checkpoint, &row.IndexedCheckpoint, &row.Changes, &row.OfficePending); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
