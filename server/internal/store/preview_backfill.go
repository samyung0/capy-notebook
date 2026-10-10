package store

import (
	"context"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// BackfillMaterialPreviews fills materials.preview where it is still NULL,
// batch rows at a time in id order, for materials written before migration
// 0073 (cmd/previewbackfill). It is idempotent: the update only lands on a row
// still without a preview, so a content write meanwhile wins, and a rerun
// touches only what is left. A row whose content does not parse is counted as
// skipped and left NULL.
func (s *Store) BackfillMaterialPreviews(ctx context.Context, batch int) (filled, skipped int, err error) {
	after := ""
	for {
		rows, err := s.pool.Query(ctx, `SELECT id, kind, content::text FROM materials
			WHERE preview IS NULL AND id > $1 ORDER BY id LIMIT $2`, after, batch)
		if err != nil {
			return filled, skipped, err
		}
		type row struct{ id, kind, content string }
		var page []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.id, &r.kind, &r.content); err != nil {
				rows.Close()
				return filled, skipped, err
			}
			page = append(page, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return filled, skipped, err
		}
		if len(page) == 0 {
			return filled, skipped, nil
		}
		for _, r := range page {
			after = r.id
			preview, err := materialdoc.Preview(r.kind, r.content)
			if err != nil || preview == nil {
				skipped++
				continue
			}
			tag, err := s.pool.Exec(ctx, `UPDATE materials SET preview=$2
				WHERE id=$1 AND preview IS NULL`, r.id, preview)
			if err != nil {
				return filled, skipped, err
			}
			filled += int(tag.RowsAffected())
		}
	}
}
