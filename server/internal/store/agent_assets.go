package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// AgentAsset is an image the chat agent put in a note: a library figure the
// retrieval service rendered, already stored at ObjectPath. It becomes a ready
// editor asset of the note, charged to the chatting actor like an upload
// (M16), and from then on follows every editor-asset rule (pruning, trash,
// clone).
type AgentAsset struct {
	ID          string
	Name        string
	ObjectPath  string
	ContentType string
	SizeBytes   int64
}

// ChatAssetID is the deterministic editor asset id of one thing a chat tool
// call stores (a figure it placed), so a retried call finds its asset.
func ChatAssetID(assistantMessageID, key string) string {
	sum := sha256.Sum256([]byte(assistantMessageID + "\n" + key))
	return "asset_" + hex.EncodeToString(sum[:])[:16]
}

// insertAgentAssetsTx admits the assets' bytes against the payer's quota and
// inserts them as ready assets of the material. The caller holds the
// material's scope (workspace editor lock or the standalone owner's) and
// passes the actor as payerID.
func (s *Store) insertAgentAssetsTx(ctx context.Context, tx pgx.Tx, workspaceID, materialID, payerID, actorID string, assets []AgentAsset) error {
	var total int64
	for _, asset := range assets {
		total += asset.SizeBytes
	}
	if err := s.gateStorageTx(ctx, tx, payerID, total); err != nil {
		return err
	}
	for _, asset := range assets {
		if _, err := tx.Exec(ctx, `INSERT INTO editor_assets
			(id, workspace_id, material_id, user_id, created_by, name, purpose, object_path,
			 content_type, size_bytes, status, completed_at)
			VALUES ($1,$2,$3,$4,$5,$6,'image',$7,$8,$9,'ready',now())`,
			asset.ID, nullStr(workspaceID), materialID, payerID, actorID, asset.Name,
			asset.ObjectPath, asset.ContentType, asset.SizeBytes); err != nil {
			return err
		}
	}
	return nil
}

// EnsureAgentAssets adds assets to an existing note for an agent edit, before
// the edit that references them is sent, the order the editor uses for an
// upload. An asset the note already has (a retried edit) is left as it is,
// trashed or not: the save that references it restores it. Returns the ids
// it inserted; the caller deletes the objects of the others.
func (s *Store) EnsureAgentAssets(ctx context.Context, actorID, materialID string, assets []AgentAsset) ([]string, error) {
	var created []string
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var workspaceID string
		err := tx.QueryRow(ctx, `SELECT COALESCE(workspace_id,'') FROM materials
			WHERE id=$1 AND trashed_at IS NULL`, materialID).Scan(&workspaceID)
		if isNoRows(err) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		payerID, err := s.lockEditorAssetScopeTx(ctx, tx, workspaceID, materialID, actorID)
		if err != nil {
			return err
		}
		ids := make([]string, len(assets))
		for i, asset := range assets {
			ids[i] = asset.ID
		}
		rows, err := tx.Query(ctx, `SELECT id FROM editor_assets WHERE id = ANY($1)`, ids)
		if err != nil {
			return err
		}
		existing, err := scanIDs(rows)
		if err != nil {
			return err
		}
		// The ids derive from the tool call, so an existing one is this note's.
		fresh := make([]AgentAsset, 0, len(assets))
		for _, asset := range assets {
			if !slices.Contains(existing, asset.ID) {
				fresh = append(fresh, asset)
				created = append(created, asset.ID)
			}
		}
		if len(fresh) == 0 {
			return nil
		}
		return s.insertAgentAssetsTx(ctx, tx, workspaceID, materialID, payerID, actorID, fresh)
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// DiscardAgentAssets trashes the assets a refused agent edit added to the
// note at once, rather than at its next save. One the note's content already
// references (a retry of an edit that committed) is kept.
func (s *Store) DiscardAgentAssets(ctx context.Context, materialID string, ids []string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var content string
		if err := tx.QueryRow(ctx, `SELECT content FROM materials WHERE id=$1 FOR UPDATE`, materialID).Scan(&content); err != nil {
			return err
		}
		kept, err := materialdoc.EditorAssetIDs(content)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE editor_assets SET trashed_at=now()
			WHERE material_id=$1 AND trashed_at IS NULL AND id = ANY($2::text[]) AND id <> ALL($3::text[])`,
			materialID, ids, kept)
		return err
	})
}
