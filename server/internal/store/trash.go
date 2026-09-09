package store

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Trash lifecycle for source files and Plate materials.
//
// A manual or agent delete first moves the row into the trash: trashed_at,
// trash_episode_id and purge_after are set together, editing and background
// work are fenced (triggers cancel jobs and evict rooms), and every
// active-resource query filters the row out. Bytes, blobs, index rows and
// storage charges stay. Only the current workspace owner (or the standalone
// material owner) lists, restores or permanently deletes trash; permanent
// deletion is the existing SQL DELETE with its cascades, refcounts and
// accounting triggers. The maintenance sweep purges due episodes.

// ErrTrashExpired means restore was requested at or after purge_after; the
// sweep may not have run yet but the item is no longer restorable.
var ErrTrashExpired = errors.New("trash retention has expired")

// TrashItem is trash-listing metadata only: no content, no download URL.
type TrashItem struct {
	Kind          agenttools.ResourceKind `json:"kind" enum:"source_file,material"`
	ID            string                  `json:"id"`
	Title         string                  `json:"title"`
	MaterialKind  string                  `json:"materialKind,omitempty"`
	FileKind      string                  `json:"fileKind,omitempty"`
	WorkspaceID   string                  `json:"workspaceId,omitempty"`
	WorkspaceName string                  `json:"workspaceName,omitempty"`
	SizeBytes     int64                   `json:"sizeBytes"`
	TrashedAt     time.Time               `json:"trashedAt"`
	PurgeAfter    time.Time               `json:"purgeAfter"`
	EpisodeID     string                  `json:"episodeId"`
}

type TrashPage struct {
	Items      []TrashItem `json:"items" nullable:"false"`
	NextCursor string      `json:"nextCursor,omitempty"`
}

const trashPageMax = 100

// withReceipt runs mutate inside tx once per operation id. A committed receipt
// with the same request returns as-is; a different request under the same id
// conflicts; an empty id skips receipts (a plain browser DELETE).
func withReceipt(ctx context.Context, tx pgx.Tx, op AgentOperation, mutate func() (*agenttools.ResourceEffect, error)) (AgentOperation, error) {
	if op.ID != "" {
		existing, err := lockAgentOperationTx(ctx, tx, op.ID, op.RequestHash)
		if err != nil {
			return AgentOperation{}, err
		}
		if existing != nil {
			return *existing, nil
		}
	}
	effect, err := mutate()
	if err != nil {
		return AgentOperation{}, err
	}
	if effect != nil && effect.OperationID == "" {
		effect.OperationID = op.ID
	}
	op.Outcome = agenttools.OutcomeSucceeded
	op.Effect = effect
	if op.ID != "" {
		if err := insertAgentOperationTx(ctx, tx, op); err != nil {
			return AgentOperation{}, err
		}
	}
	return op, nil
}

// TrashFile moves an active source file into the trash. Editors of the
// workspace may trash; the row keeps its bytes and charges.
func (s *Store) TrashFile(ctx context.Context, actorID, fileID string, op AgentOperation) (AgentOperation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	var wsID, name, kind string
	var trashedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT workspace_id, name, kind, trashed_at FROM files WHERE id=$1`, fileID).
		Scan(&wsID, &name, &kind, &trashedAt); err != nil {
		if isNoRows(err) {
			return AgentOperation{}, ErrNotFound
		}
		return AgentOperation{}, err
	}
	ownerID, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, actorID)
	if err != nil {
		return AgentOperation{}, err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return AgentOperation{}, err
	}
	op.Kind, op.ActorUserID, op.WorkspaceID = "trash", actorID, wsID
	result, err := withReceipt(ctx, tx, op, func() (*agenttools.ResourceEffect, error) {
		if trashedAt != nil {
			// Already trashed by another action: active-content authority ends
			// at the trash boundary, so this reads like a missing file.
			return nil, ErrNotFound
		}
		episode := uid("trash")
		var purgeAfter time.Time
		err := tx.QueryRow(ctx, `UPDATE files SET trashed_at=now(), trashed_by=$3, trash_episode_id=$4,
			purge_after=now() + interval '30 days'
			WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL RETURNING purge_after`,
			fileID, wsID, actorID, episode).Scan(&purgeAfter)
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if err := invalidateEditInversesTx(ctx, tx, agenttools.KindSourceFile, fileID, "trashed"); err != nil {
			return nil, err
		}
		return &agenttools.ResourceEffect{
			Operation:      agenttools.EffectTrashed,
			Resource:       agenttools.ResourceRef{Kind: agenttools.KindSourceFile, ID: fileID, Title: name, WorkspaceID: wsID},
			TrashEpisodeID: episode,
			PurgeAfter:     &purgeAfter,
		}, nil
	})
	if err != nil {
		return AgentOperation{}, err
	}
	return result, tx.Commit(ctx)
}

// TrashMaterial moves an active material into the trash. expectedKind lets the
// quiz/flashcard wrappers refuse another kind, matching their delete routes.
func (s *Store) TrashMaterial(ctx context.Context, actorID, materialID, expectedKind string, op AgentOperation) (AgentOperation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	var ownerID, kind, title string
	var workspaceID *string
	var trashedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT owner_user_id, workspace_id, kind, title, trashed_at
		FROM materials WHERE id=$1`, materialID).Scan(&ownerID, &workspaceID, &kind, &title, &trashedAt); err != nil {
		if isNoRows(err) {
			return AgentOperation{}, ErrNotFound
		}
		return AgentOperation{}, err
	}
	if expectedKind != "" && kind != expectedKind {
		return AgentOperation{}, ErrNotFound
	}
	if workspaceID != nil {
		ownerID, err = s.lockWorkspaceEditorMutationTx(ctx, tx, *workspaceID, actorID)
		if err != nil {
			return AgentOperation{}, err
		}
	} else {
		if ownerID != actorID {
			return AgentOperation{}, ErrNotFound
		}
		if err := s.lockAccountSessionsTx(ctx, tx, ownerID, actorID); err != nil {
			return AgentOperation{}, err
		}
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return AgentOperation{}, err
	}
	op.Kind, op.ActorUserID, op.WorkspaceID = "trash", actorID, deref(workspaceID)
	result, err := withReceipt(ctx, tx, op, func() (*agenttools.ResourceEffect, error) {
		if trashedAt != nil {
			return nil, ErrNotFound
		}
		episode := uid("trash")
		var purgeAfter time.Time
		err := tx.QueryRow(ctx, `UPDATE materials SET trashed_at=now(), trashed_by=$2, trash_episode_id=$3,
			purge_after=now() + interval '30 days'
			WHERE id=$1 AND owner_user_id=$4 AND trashed_at IS NULL RETURNING purge_after`,
			materialID, actorID, episode, ownerID).Scan(&purgeAfter)
		if isNoRows(err) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if err := invalidateEditInversesTx(ctx, tx, agenttools.KindMaterial, materialID, "trashed"); err != nil {
			return nil, err
		}
		return &agenttools.ResourceEffect{
			Operation: agenttools.EffectTrashed,
			Resource: agenttools.ResourceRef{
				Kind: agenttools.KindMaterial, ID: materialID, Title: title, MaterialKind: kind, WorkspaceID: deref(workspaceID),
			},
			TrashEpisodeID: episode,
			PurgeAfter:     &purgeAfter,
		}, nil
	})
	if err != nil {
		return AgentOperation{}, err
	}
	return result, tx.Commit(ctx)
}

func encodeTrashCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
}

func decodeTrashCursor(cursor string) (*time.Time, string, error) {
	if cursor == "" {
		return nil, "", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return nil, "", fmt.Errorf("%w: invalid cursor", ErrNotFound)
	}
	at, id, ok := strings.Cut(string(raw), "|")
	if !ok {
		return nil, "", fmt.Errorf("%w: invalid cursor", ErrNotFound)
	}
	parsed, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return nil, "", fmt.Errorf("%w: invalid cursor", ErrNotFound)
	}
	return &parsed, id, nil
}

// ListTrash returns the owner's trashed files and materials, newest first.
// Ownership is the storage owner column (workspace owner for workspace rows,
// creator for standalone materials), which transfer rewrites, so an editor who
// trashed an item never sees it here. workspaceID narrows to one owned
// workspace; empty spans every owned workspace plus standalone materials.
func (s *Store) ListTrash(ctx context.Context, ownerID, workspaceID string, limit int, cursor string) (TrashPage, error) {
	if limit <= 0 || limit > trashPageMax {
		limit = trashPageMax
	}
	cursorAt, cursorID, err := decodeTrashCursor(cursor)
	if err != nil {
		return TrashPage{}, err
	}
	rows, err := s.pool.Query(ctx, `SELECT kind, id, title, sub_kind, workspace_id, workspace_name, size_bytes,
			trashed_at, purge_after, trash_episode_id
		FROM (
			SELECT 'source_file' AS kind, f.id, f.name AS title, f.kind AS sub_kind, f.workspace_id,
				w.name AS workspace_name, f.size_bytes, f.trashed_at, f.purge_after, f.trash_episode_id
			FROM files f JOIN workspaces w ON w.id=f.workspace_id
			WHERE f.trashed_at IS NOT NULL AND f.user_id=$1 AND ($2='' OR f.workspace_id=$2)
			UNION ALL
			SELECT 'material', m.id, m.title, m.kind, COALESCE(m.workspace_id,''), m.workspace_name,
				m.size_bytes, m.trashed_at, m.purge_after, m.trash_episode_id
			FROM materials m
			WHERE m.trashed_at IS NOT NULL AND m.owner_user_id=$1 AND ($2='' OR m.workspace_id=$2)
		) t
		WHERE $3::timestamptz IS NULL OR (t.trashed_at, t.id) < ($3::timestamptz, $4::text)
		ORDER BY t.trashed_at DESC, t.id DESC
		LIMIT $5`, ownerID, workspaceID, cursorAt, cursorID, limit+1)
	if err != nil {
		return TrashPage{}, err
	}
	defer rows.Close()
	page := TrashPage{Items: []TrashItem{}}
	for rows.Next() {
		var item TrashItem
		var subKind string
		if err := rows.Scan(&item.Kind, &item.ID, &item.Title, &subKind, &item.WorkspaceID, &item.WorkspaceName,
			&item.SizeBytes, &item.TrashedAt, &item.PurgeAfter, &item.EpisodeID); err != nil {
			return TrashPage{}, err
		}
		if item.Kind == agenttools.KindMaterial {
			item.MaterialKind = subKind
		} else {
			item.FileKind = subKind
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return TrashPage{}, err
	}
	if len(page.Items) > limit {
		last := page.Items[limit-1]
		page.Items = page.Items[:limit]
		page.NextCursor = encodeTrashCursor(last.TrashedAt, last.ID)
	}
	return page, nil
}

// lockTrashOwnerTx verifies ownerID controls the trashed resource and takes the
// same lock order as deletion: workspace (when present), then accounts, then
// the storage row. It returns the workspace id ("" for standalone).
func (s *Store) lockTrashOwnerTx(ctx context.Context, tx pgx.Tx, ownerID string, kind agenttools.ResourceKind, id string) (string, error) {
	var wsID *string
	var rowOwner string
	switch kind {
	case agenttools.KindSourceFile:
		if err := tx.QueryRow(ctx, `SELECT workspace_id, user_id FROM files WHERE id=$1 AND trashed_at IS NOT NULL`, id).
			Scan(&wsID, &rowOwner); err != nil {
			if isNoRows(err) {
				return "", ErrNotFound
			}
			return "", err
		}
	case agenttools.KindMaterial:
		if err := tx.QueryRow(ctx, `SELECT workspace_id, owner_user_id FROM materials WHERE id=$1 AND trashed_at IS NOT NULL`, id).
			Scan(&wsID, &rowOwner); err != nil {
			if isNoRows(err) {
				return "", ErrNotFound
			}
			return "", err
		}
	default:
		return "", ErrNotFound
	}
	if rowOwner != ownerID {
		return "", ErrNotFound
	}
	if wsID != nil {
		// Current owner only: the lock re-reads ownership under the workspace row.
		currentOwner, err := s.lockWorkspaceMutationTx(ctx, tx, *wsID, ownerID)
		if err != nil {
			return "", err
		}
		if currentOwner != ownerID {
			return "", ErrNotFound
		}
	} else if err := s.lockAccountSessionsTx(ctx, tx, ownerID); err != nil {
		return "", err
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return "", err
	}
	return deref(wsID), nil
}

// RestoreTrashed clears the trash fields of the matching episode before its
// expiry and reopens the resource under a fresh collaboration incarnation.
// Bytes stay charged; there is no second storage reservation.
func (s *Store) RestoreTrashed(ctx context.Context, ownerID string, kind agenttools.ResourceKind, id, episodeID string, op AgentOperation) (AgentOperation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	wsID, err := s.lockTrashOwnerTx(ctx, tx, ownerID, kind, id)
	if err != nil {
		return AgentOperation{}, err
	}
	if err := s.assertOwnerCanRestoreTx(ctx, tx, ownerID); err != nil {
		return AgentOperation{}, err
	}
	op.Kind, op.ActorUserID, op.WorkspaceID = "restore", ownerID, wsID
	result, err := withReceipt(ctx, tx, op, func() (*agenttools.ResourceEffect, error) {
		var expired bool
		var title, subKind string
		var query string
		if kind == agenttools.KindSourceFile {
			query = `UPDATE files SET trashed_at=NULL, trashed_by=NULL, trash_episode_id=NULL, purge_after=NULL
				WHERE id=$1 AND trash_episode_id=$2 AND trashed_at IS NOT NULL AND purge_after > now()
				RETURNING name, kind`
		} else {
			query = `UPDATE materials SET trashed_at=NULL, trashed_by=NULL, trash_episode_id=NULL, purge_after=NULL,
				trash_restores=trash_restores+1
				WHERE id=$1 AND trash_episode_id=$2 AND trashed_at IS NOT NULL AND purge_after > now()
				RETURNING title, kind`
		}
		if err := tx.QueryRow(ctx, query, id, episodeID).Scan(&title, &subKind); err != nil {
			if !isNoRows(err) {
				return nil, err
			}
			table := "files"
			if kind == agenttools.KindMaterial {
				table = "materials"
			}
			if err := tx.QueryRow(ctx, `SELECT purge_after <= now() FROM `+table+`
				WHERE id=$1 AND trash_episode_id=$2 AND trashed_at IS NOT NULL`, id, episodeID).Scan(&expired); err != nil {
				if isNoRows(err) {
					return nil, ErrNotFound
				}
				return nil, err
			}
			if expired {
				return nil, ErrTrashExpired
			}
			return nil, ErrNotFound
		}
		// Fresh incarnation: buffered old-epoch or old-schema edits cannot merge
		// into the restored resource. The trash transition already evicted rooms.
		if kind == agenttools.KindSourceFile {
			if _, err := tx.Exec(ctx, `UPDATE source_documents SET epoch=epoch+1, updated_at=now() WHERE file_id=$1`, id); err != nil {
				return nil, err
			}
		} else if _, err := tx.Exec(ctx, `UPDATE material_yjs_documents SET room_schema=room_schema+1, updated_at=now()
			WHERE material_id=$1`, id); err != nil {
			return nil, err
		}
		ref := agenttools.ResourceRef{Kind: kind, ID: id, Title: title, WorkspaceID: wsID}
		if kind == agenttools.KindMaterial {
			ref.MaterialKind = subKind
		}
		return &agenttools.ResourceEffect{Operation: agenttools.EffectRestored, Resource: ref}, nil
	})
	if err != nil {
		return AgentOperation{}, err
	}
	return result, tx.Commit(ctx)
}

// assertOwnerCanRestoreTx applies the account gates a restore shares with any
// other mutation by that owner: suspended, deletion-pending and deleted
// accounts cannot restore. Over-quota owners may, because the bytes are
// already charged and restore changes visibility only.
func (s *Store) assertOwnerCanRestoreTx(ctx context.Context, tx pgx.Tx, ownerID string) error {
	status, err := s.accountAccess(ctx, tx, ownerID)
	if err != nil {
		return err
	}
	return status.Err()
}

// PurgeTrashed permanently deletes a trashed resource (owner action). The SQL
// DELETE runs the existing cascades, blob refcount and storage triggers.
// Available over quota: it is storage recovery.
func (s *Store) PurgeTrashed(ctx context.Context, ownerID string, kind agenttools.ResourceKind, id, episodeID string, op AgentOperation) (AgentOperation, error) {
	var conn interface {
		Begin(context.Context) (pgx.Tx, error)
	} = s.pool
	if kind == agenttools.KindMaterial {
		locked, unlock, err := s.lockMaterialCloneSource(ctx, id, false)
		if err != nil {
			return AgentOperation{}, err
		}
		defer unlock()
		conn = locked
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	wsID, err := s.lockTrashOwnerTx(ctx, tx, ownerID, kind, id)
	if err != nil {
		return AgentOperation{}, err
	}
	op.Kind, op.ActorUserID, op.WorkspaceID = "purge", ownerID, wsID
	result, err := withReceipt(ctx, tx, op, func() (*agenttools.ResourceEffect, error) {
		if err := purgeTrashedRowTx(ctx, tx, kind, id, episodeID); err != nil {
			return nil, err
		}
		return nil, nil
	})
	if err != nil {
		return AgentOperation{}, err
	}
	return result, tx.Commit(ctx)
}

// purgeTrashedRowTx deletes exactly the still-trashed matching episode.
func purgeTrashedRowTx(ctx context.Context, tx pgx.Tx, kind agenttools.ResourceKind, id, episodeID string) error {
	table := "files"
	if kind == agenttools.KindMaterial {
		table = "materials"
	}
	ct, err := tx.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1 AND trash_episode_id=$2 AND trashed_at IS NOT NULL`, id, episodeID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SweepDueTrash purges episodes whose retention has passed, one resource per
// transaction under the same locks as an owner purge. Failures are logged and
// left for the next sweep. Returns the number purged.
func (s *Store) SweepDueTrash(ctx context.Context, limit int) (int, error) {
	type due struct {
		kind    agenttools.ResourceKind
		id      string
		episode string
	}
	rows, err := s.pool.Query(ctx, `SELECT kind, id, episode FROM (
			SELECT 'source_file' AS kind, id, trash_episode_id AS episode, purge_after FROM files
			WHERE trashed_at IS NOT NULL AND purge_after <= now()
			UNION ALL
			SELECT 'material', id, trash_episode_id, purge_after FROM materials
			WHERE trashed_at IS NOT NULL AND purge_after <= now()
		) d ORDER BY purge_after LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	var items []due
	for rows.Next() {
		var d due
		if err := rows.Scan(&d.kind, &d.id, &d.episode); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	purged := 0
	for _, d := range items {
		if err := s.sweepOne(ctx, d.kind, d.id, d.episode); err != nil {
			if ctx.Err() != nil {
				return purged, ctx.Err()
			}
			if !errors.Is(err, ErrNotFound) {
				log.Printf("trash sweep %s %s: %v", d.kind, d.id, err)
			}
			continue
		}
		purged++
	}
	return purged, nil
}

func (s *Store) sweepOne(ctx context.Context, kind agenttools.ResourceKind, id, episode string) error {
	var conn interface {
		Begin(context.Context) (pgx.Tx, error)
	} = s.pool
	if kind == agenttools.KindMaterial {
		locked, unlock, err := s.lockMaterialCloneSource(ctx, id, false)
		if err != nil {
			return err
		}
		defer unlock()
		conn = locked
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Same order as an owner purge: workspace, accounts, storage row, then the
	// resource row. A restore or re-trash that committed meanwhile changes the
	// episode, so the DELETE below deletes only what is still due.
	var wsID *string
	var ownerID string
	table := "files"
	ownerCol := "user_id"
	if kind == agenttools.KindMaterial {
		table, ownerCol = "materials", "owner_user_id"
	}
	if err := tx.QueryRow(ctx, `SELECT workspace_id, `+ownerCol+` FROM `+table+`
		WHERE id=$1 AND trash_episode_id=$2 AND trashed_at IS NOT NULL AND purge_after <= now()`, id, episode).
		Scan(&wsID, &ownerID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if wsID != nil {
		if _, err := tx.Exec(ctx, `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE`, *wsID); err != nil {
			return err
		}
	}
	if err := s.lockAccountSessionsTx(ctx, tx, ownerID); err != nil {
		var locked *AccountLockedError
		if !errors.As(err, &locked) {
			return err
		}
		// A locked owner's trash still expires; deletion is not a user action.
	}
	if err := s.lockStorageRowTx(ctx, tx, ownerID); err != nil {
		return err
	}
	if err := purgeTrashedRowTx(ctx, tx, kind, id, episode); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ResourceWorkspaceID resolves the workspace of a file or material. active
// reads the active view; false reads only trashed rows. Standalone materials
// resolve to "".
func (s *Store) ResourceWorkspaceID(ctx context.Context, kind agenttools.ResourceKind, id string, active bool) (string, error) {
	table := "files"
	if kind == agenttools.KindMaterial {
		table = "materials"
	}
	state := "IS NULL"
	if !active {
		state = "IS NOT NULL"
	}
	var wsID *string
	err := s.pool.QueryRow(ctx, `SELECT workspace_id FROM `+table+` WHERE id=$1 AND trashed_at `+state, id).Scan(&wsID)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return deref(wsID), err
}

// CurrentTrashEpisode returns the episode id of a trashed resource so a chat
// restore by resource id targets exactly the episode the listing showed.
func (s *Store) CurrentTrashEpisode(ctx context.Context, kind agenttools.ResourceKind, id string) (string, error) {
	table := "files"
	if kind == agenttools.KindMaterial {
		table = "materials"
	}
	var episode string
	err := s.pool.QueryRow(ctx, `SELECT trash_episode_id FROM `+table+` WHERE id=$1 AND trashed_at IS NOT NULL`, id).Scan(&episode)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return episode, err
}
