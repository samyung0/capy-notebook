package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
)

func (s *Store) MaterialRoom(ctx context.Context, materialID string) (string, error) {
	var schema int
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(
		(SELECT room_schema FROM material_yjs_documents WHERE material_id=$1), 1)
		FROM materials WHERE id=$1`, materialID).Scan(&schema)
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

// ProjectMaterialContent advances the validated JSON read model from a Y.Doc
// version that the collaboration service has already durably stored.
func (s *Store) ProjectMaterialContent(
	ctx context.Context,
	materialID, content string,
	yjsVersion int64,
) (Material, error) {
	if yjsVersion < 1 {
		return Material{}, fmt.Errorf("%w: invalid Yjs version", materialdoc.ErrInvalid)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Material{}, err
	}
	defer tx.Rollback(ctx)

	// Serialize persistence, projection and compaction for this material. The
	// collaboration service takes the same transaction-scoped advisory lock
	// before touching the Y.Doc, which also keeps our row-lock order aligned.
	if _, err := tx.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, materialID); err != nil {
		return Material{}, err
	}
	var workspaceID *string
	var ownerID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id, owner_user_id
		FROM materials WHERE id=$1`, materialID).
		Scan(&workspaceID, &ownerID); err != nil {
		if isNoRows(err) {
			return Material{}, ErrNotFound
		}
		return Material{}, err
	}
	if workspaceID != nil {
		ownerID, err = s.storageOwnerTx(ctx, tx, *workspaceID)
		if err != nil {
			return Material{}, err
		}
	}
	// A projection is still a material write even though it is authenticated by
	// the collaboration service rather than a user session. Serialize its final
	// admission with suspension and account deletion so queued projections
	// cannot cross either boundary.
	if err := s.lockAccountSessionsTx(ctx, tx, ownerID); err != nil {
		return Material{}, err
	}

	var storedVersion, projectedVersion int64
	if err := tx.QueryRow(ctx, `SELECT stored_version, projected_version
		FROM material_yjs_documents WHERE material_id=$1 FOR UPDATE`, materialID).
		Scan(&storedVersion, &projectedVersion); err != nil {
		if isNoRows(err) {
			return Material{}, ErrNotFound
		}
		return Material{}, err
	}
	if yjsVersion > storedVersion {
		return Material{}, ErrConflict
	}
	if yjsVersion <= projectedVersion {
		if err := tx.Commit(ctx); err != nil {
			return Material{}, err
		}
		return s.GetMaterial(ctx, materialID)
	}

	var kind, title, lockedOwnerID string
	var revision int64
	var unchanged bool
	if err := tx.QueryRow(ctx, `SELECT kind, title, revision, content = $2::jsonb,
		owner_user_id
		FROM materials WHERE id=$1 FOR UPDATE`, materialID, content).
		Scan(&kind, &title, &revision, &unchanged, &lockedOwnerID); err != nil {
		if isNoRows(err) {
			return Material{}, ErrNotFound
		}
		return Material{}, err
	}
	if lockedOwnerID != ownerID {
		return Material{}, ErrConflict
	}
	// Retries and repeated stores of a settled document project identical JSON.
	// Advance the watermark without inventing a revision nobody authored.
	if unchanged {
		if _, err := tx.Exec(ctx, `UPDATE material_yjs_documents
			SET projected_version=$2, projection_error=NULL, projected_at=now()
			WHERE material_id=$1`, materialID, yjsVersion); err != nil {
			return Material{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Material{}, err
		}
		return s.GetMaterial(ctx, materialID)
	}
	if err := materialdoc.ValidateKind(content, kind); err != nil {
		_, _ = tx.Exec(ctx, `UPDATE material_yjs_documents
			SET projection_error=$2, updated_at=now() WHERE material_id=$1`,
			materialID, err.Error())
		return Material{}, err
	}
	// Deliberately no metrics.LimitError() here. The collaboration service is
	// the write gate for room content and already refused every update that
	// grows an over-limit document; what reaches this projection is either
	// within the caps or a shrink that recovers towards them. Re-rejecting it
	// would strand materials.content behind the authoritative Y.Doc for exactly
	// the documents that are trying to get back under the limit.
	metrics, err := materialdoc.Metrics(content)
	if err != nil {
		_, _ = tx.Exec(ctx, `UPDATE material_yjs_documents
			SET projection_error=$2, updated_at=now() WHERE material_id=$1`,
			materialID, err.Error())
		return Material{}, err
	}
	now := time.Now().UTC()
	nextRevision := revision + 1
	if _, err := tx.Exec(ctx, `UPDATE materials
		SET content=$2, node_count=$3, max_depth=$4, revision=$5, updated_at=$6
		WHERE id=$1`, materialID, json.RawMessage(content), metrics.NodeCount,
		metrics.MaxDepth, nextRevision, now); err != nil {
		return Material{}, err
	}
	parentRevision := revision
	if err := s.upsertMaterialRevisionTx(ctx, tx, MaterialRevision{
		MaterialID:     materialID,
		Revision:       nextRevision,
		ParentRevision: &parentRevision,
		EventType:      RevisionEdit,
		Title:          title,
		Content:        content,
		EventMetadata:  json.RawMessage(`{"source":"yjs"}`),
		CreatedAt:      now,
	}); err != nil {
		return Material{}, err
	}
	if kind == "flashcards" {
		cards, err := materialdoc.ExtractFlashcards(content)
		if err != nil {
			return Material{}, err
		}
		cardIDs := make([]string, len(cards))
		for i, card := range cards {
			cardIDs[i] = card.ID
		}
		if err := syncCardStatsTx(ctx, tx, materialID, cardIDs); err != nil {
			return Material{}, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE material_yjs_documents
		SET projected_version=$2, projection_error=NULL, projected_at=$3
		WHERE material_id=$1`, materialID, yjsVersion, now); err != nil {
		return Material{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Material{}, err
	}
	return s.GetMaterial(ctx, materialID)
}
