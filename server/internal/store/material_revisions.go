package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	freeMaterialRevisionLimit    = 7
	premiumMaterialRevisionLimit = 30
)

func utcDate(value time.Time) time.Time {
	year, month, day := value.UTC().Date()
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

// upsertMaterialRevisionTx keeps one full material snapshot per UTC day. The
// material's revision counter still advances on every mutation; the daily row
// is simply moved to the latest revision and content saved during that day.
func upsertMaterialRevisionTx(
	ctx context.Context,
	tx pgx.Tx,
	revision MaterialRevision,
) error {
	if revision.CreatedAt.IsZero() {
		revision.CreatedAt = time.Now().UTC()
	}
	if len(revision.EventMetadata) == 0 {
		revision.EventMetadata = json.RawMessage(`{}`)
	}
	_, err := tx.Exec(ctx, `INSERT INTO material_revisions
		(material_id, version_date, revision, parent_revision, event_type, title,
		 content, event_metadata, created_by, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (material_id, version_date) DO UPDATE SET
			revision=EXCLUDED.revision,
			parent_revision=EXCLUDED.parent_revision,
			event_type=EXCLUDED.event_type,
			title=EXCLUDED.title,
			content=EXCLUDED.content,
			event_metadata=EXCLUDED.event_metadata,
			created_by=EXCLUDED.created_by,
			created_at=EXCLUDED.created_at`,
		revision.MaterialID,
		utcDate(revision.CreatedAt),
		revision.Revision,
		revision.ParentRevision,
		revision.EventType,
		revision.Title,
		json.RawMessage(revision.Content),
		revision.EventMetadata,
		revision.CreatedBy,
		revision.CreatedAt.UTC(),
	)
	if err != nil {
		return err
	}
	return pruneMaterialRevisionsTx(ctx, tx, revision.MaterialID)
}

func pruneMaterialRevisionsTx(ctx context.Context, tx pgx.Tx, materialID string) error {
	_, err := tx.Exec(ctx, `WITH ranked AS (
		SELECT mr.version_date,
			row_number() OVER (ORDER BY mr.version_date DESC) AS position,
			CASE WHEN u.plan_tier IN ('pro','team')
				THEN $2::bigint ELSE $3::bigint
			END AS retention_limit
		FROM material_revisions mr
		JOIN materials m ON m.id=mr.material_id
		JOIN users u ON u.id=m.user_id
		WHERE mr.material_id=$1
	)
	DELETE FROM material_revisions mr
	USING ranked
	WHERE mr.material_id=$1
	  AND mr.version_date=ranked.version_date
	  AND ranked.position>ranked.retention_limit`,
		materialID,
		premiumMaterialRevisionLimit,
		freeMaterialRevisionLimit,
	)
	return err
}

// PruneMaterialRevisions applies the current owner's tier to all materials.
// It covers tier downgrades and data inserted outside the normal save path.
func (s *Store) PruneMaterialRevisions(ctx context.Context) (int64, error) {
	result, err := s.pool.Exec(ctx, `WITH ranked AS (
		SELECT mr.material_id, mr.version_date,
			row_number() OVER (
				PARTITION BY mr.material_id ORDER BY mr.version_date DESC
			) AS position,
			CASE WHEN u.plan_tier IN ('pro','team')
				THEN $1::bigint ELSE $2::bigint
			END AS retention_limit
		FROM material_revisions mr
		JOIN materials m ON m.id=mr.material_id
		JOIN users u ON u.id=m.user_id
	)
	DELETE FROM material_revisions mr
	USING ranked
	WHERE mr.material_id=ranked.material_id
	  AND mr.version_date=ranked.version_date
	  AND ranked.position>ranked.retention_limit`,
		premiumMaterialRevisionLimit,
		freeMaterialRevisionLimit,
	)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}
