package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func (s *Store) MaterialRoom(ctx context.Context, materialID string) (string, error) {
	var schema int
	// A never-bootstrapped material lives at schema 1 + its restore count, so a
	// token minted before a trash cannot reconnect after the restore through
	// the implicit schema-1 room. The eviction trigger names rooms the same way.
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(
		(SELECT room_schema FROM material_yjs_documents WHERE material_id=$1), 1 + trash_restores)
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, materialID).Scan(&schema)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("material:%s:schema:%d", materialID, schema), nil
}

// WorkspaceMaterialIDs returns room identities that must be evicted when
// workspace membership or workspace lifecycle permissions change.
func (s *Store) WorkspaceMaterialIDs(ctx context.Context, workspaceID string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT id FROM materials WHERE workspace_id=$1`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ProjectedMaterial is a material row's numbers after a projection.
type ProjectedMaterial struct {
	ID        string
	Revision  int64
	SizeBytes int64
	NodeCount int
	MaxDepth  int
	UpdatedAt time.Time
}

// ProjectMaterialContent advances the validated JSON read model from a Y.Doc
// version that the collaboration service has already durably stored. The
// caller parsed the content once into the projection; everything here reads
// it, and nothing reads the stored content back.
func (s *Store) ProjectMaterialContent(
	ctx context.Context,
	materialID string,
	projection materialdoc.Projection,
	yjsVersion int64,
) (ProjectedMaterial, error) {
	if yjsVersion < 1 {
		return ProjectedMaterial{}, fmt.Errorf("%w: invalid Yjs version", materialdoc.ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProjectedMaterial{}, err
	}
	defer tx.Rollback(ctx)

	// Serialize persistence, projection and compaction for this material. The
	// collaboration service takes the same transaction-scoped advisory lock
	// before touching the Y.Doc, which also keeps our row-lock order aligned.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, materialID); err != nil {
		return ProjectedMaterial{}, err
	}
	var workspaceID *string
	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id, owner_user_id
		FROM materials WHERE id=$1 AND trashed_at IS NULL`, materialID).
		Scan(&workspaceID, &ownerID); err != nil {
		if isNoRows(err) {
			return ProjectedMaterial{}, ErrNotFound
		}
		return ProjectedMaterial{}, err
	}
	if workspaceID != nil {
		ownerID, err = s.storageOwnerTx(ctx, tx, *workspaceID)
		if err != nil {
			return ProjectedMaterial{}, err
		}
	}
	// A projection is still a material write even though it is authenticated by
	// the collaboration service rather than a user session. Serialize its final
	// admission with suspension and account deletion so queued projections
	// cannot cross either boundary.
	if err := s.lockAccountSessionsTx(ctx, tx, ownerID); err != nil {
		return ProjectedMaterial{}, err
	}

	var storedVersion, projectedVersion int64
	var projectedSHA256 []byte
	if err := tx.QueryRow(ctx, `SELECT stored_version, projected_version, projected_sha256
		FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`, materialID).
		Scan(&storedVersion, &projectedVersion, &projectedSHA256); err != nil {
		if isNoRows(err) {
			return ProjectedMaterial{}, ErrNotFound
		}
		return ProjectedMaterial{}, err
	}
	if yjsVersion > storedVersion {
		return ProjectedMaterial{}, ErrConflict
	}
	if yjsVersion <= projectedVersion {
		return commitProjected(ctx, tx, materialID)
	}

	var kind, lockedOwnerID string
	var revision int64
	if err := tx.QueryRow(ctx, `SELECT kind, revision, owner_user_id
		FROM materials WHERE id=$1 AND trashed_at IS NULL FOR UPDATE`, materialID).
		Scan(&kind, &revision, &lockedOwnerID); err != nil {
		if isNoRows(err) {
			return ProjectedMaterial{}, ErrNotFound
		}
		return ProjectedMaterial{}, err
	}
	if lockedOwnerID != ownerID {
		return ProjectedMaterial{}, ErrConflict
	}
	// Once a material has a Yjs document only this projection writes
	// materials.content (UpdateMaterial writes it only while there is none), so
	// the hash of what the last projection wrote or found stands for the stored
	// content. The row's first projection compares the jsonb instead.
	digest := sha256.Sum256([]byte(projection.Raw))
	unchanged := bytes.Equal(projectedSHA256, digest[:])
	if projectedSHA256 == nil {
		if err := tx.QueryRow(ctx, `SELECT content = $2::jsonb FROM materials WHERE id=$1`,
			materialID, projection.Raw).Scan(&unchanged); err != nil {
			return ProjectedMaterial{}, err
		}
	}
	// Retries and repeated stores of a settled document project identical JSON.
	// Advance the watermark without inventing a revision nobody authored.
	if unchanged {
		if _, err := tx.Exec(ctx, `UPDATE material_yjs_documents
			SET projected_version=$2, projected_sha256=$3, projection_error=NULL, projected_at=now()
			WHERE material_id=$1`, materialID, yjsVersion, digest[:]); err != nil {
			return ProjectedMaterial{}, err
		}
		return commitProjected(ctx, tx, materialID)
	}
	if err := projection.ValidateKind(kind); err != nil {
		_, _ = tx.Exec(ctx, `UPDATE material_yjs_documents
			SET projection_error=$2, updated_at=now() WHERE material_id=$1`,
			materialID, err.Error())
		return ProjectedMaterial{}, err
	}
	// Deliberately no metrics.LimitError() here. The collaboration service is
	// the write gate for room content and already refused every update that
	// grows an over-limit document; what reaches this projection is either
	// within the caps or a shrink that recovers towards them. Re-rejecting it
	// would strand materials.content behind the authoritative Y.Doc for exactly
	// the documents that are trying to get back under the limit.
	projected := ProjectedMaterial{
		ID:        materialID,
		Revision:  revision + 1,
		NodeCount: projection.Metrics.NodeCount,
		MaxDepth:  projection.Metrics.MaxDepth,
		UpdatedAt: time.Now().UTC(),
	}
	if err := tx.QueryRow(ctx, `UPDATE materials
		SET content=$2, node_count=$3, max_depth=$4, revision=$5, updated_at=$6, `+noteIndexDirtySQL+`
		WHERE id=$1 AND trashed_at IS NULL RETURNING size_bytes, updated_at`, materialID,
		json.RawMessage(projection.Raw), projected.NodeCount, projected.MaxDepth,
		projected.Revision, projected.UpdatedAt).Scan(&projected.SizeBytes, &projected.UpdatedAt); err != nil {
		return ProjectedMaterial{}, err
	}
	if kind == "flashcards" {
		cards, err := materialdoc.ExtractFlashcards(projection.Raw)
		if err != nil {
			return ProjectedMaterial{}, err
		}
		cardIDs := make([]string, len(cards))
		for i, card := range cards {
			cardIDs[i] = card.ID
		}
		if err := syncFlashcardCardsTx(ctx, tx, materialID, cardIDs); err != nil {
			return ProjectedMaterial{}, err
		}
	}
	if kind == "note" {
		if err := reconcileEmbeddedTx(ctx, tx, materialID, projection.MaterialRefs(), ""); err != nil {
			return ProjectedMaterial{}, err
		}
	}
	if err := pruneMaterialAssetsTx(ctx, tx, materialID, projection.EditorAssetIDs()); err != nil {
		return ProjectedMaterial{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE material_yjs_documents
		SET projected_version=$2, projected_sha256=$3, projection_error=NULL, projected_at=$4
		WHERE material_id=$1`, materialID, yjsVersion, digest[:], projected.UpdatedAt); err != nil {
		return ProjectedMaterial{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProjectedMaterial{}, err
	}
	return projected, nil
}

// commitProjected commits a projection that left the material row as it was
// and answers the row's numbers, without its content.
func commitProjected(ctx context.Context, tx pgx.Tx, materialID string) (ProjectedMaterial, error) {
	projected := ProjectedMaterial{ID: materialID}
	if err := tx.QueryRow(ctx, `SELECT revision, size_bytes, node_count, max_depth, updated_at
		FROM materials WHERE id=$1`, materialID).Scan(&projected.Revision, &projected.SizeBytes,
		&projected.NodeCount, &projected.MaxDepth, &projected.UpdatedAt); err != nil {
		return ProjectedMaterial{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ProjectedMaterial{}, err
	}
	return projected, nil
}
