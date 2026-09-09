package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

type execer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

// EditInverse is the Undo record of one committed direct AI edit: the inverse
// commands and the post-edit guards, bound to the resource incarnation and
// version they were captured against. The collaboration service captures it in
// the same transaction as the edit; Go serves the Undo request and the
// projection-side study-state restoration.
type EditInverse struct {
	OperationID  string                  `json:"operationId"`
	ResourceKind agenttools.ResourceKind `json:"resourceKind"`
	ResourceID   string                  `json:"resourceId"`
	ActorUserID  string                  `json:"actorUserId"`
	OwnerUserID  string                  `json:"ownerUserId"`
	WorkspaceID  string                  `json:"workspaceId,omitempty"`
	Incarnation  int64                   `json:"incarnation"`
	Revision     int64                   `json:"revision"`
	Inverse      json.RawMessage         `json:"inverse"`
	Guards       json.RawMessage         `json:"guards"`
	// InverseBytes is the owner-charged size; the admission gate uses the
	// same number so the ledger and the quota check agree.
	InverseBytes int64                 `json:"-"`
	UndoStatus   agenttools.UndoStatus `json:"undoStatus"`
	UndoReason   string                `json:"undoReason,omitempty"`
	UndoneBy     string                `json:"undoneBy,omitempty"`
}

// CardStateRestore is one flashcard study row retained by a supported removal
// so an Undo can put the exact known/SRS state back through the projection.
type CardStateRestore struct {
	CardID string          `json:"cardId"`
	SRS    json.RawMessage `json:"srs"`
	Known  bool            `json:"known"`
}

// ErrUndoUnavailable means the edit's inverse was released or already used.
var ErrUndoUnavailable = errors.New("undo is no longer available for this edit")

func insertEditInverseTx(ctx context.Context, tx pgx.Tx, inv EditInverse) error {
	_, err := tx.Exec(ctx, `INSERT INTO agent_edit_inverses
		(operation_id, resource_kind, resource_id, actor_user_id, owner_user_id, workspace_id,
		 incarnation, revision, inverse, guards, inverse_bytes)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9::jsonb,$10::jsonb,$11)`,
		inv.OperationID, inv.ResourceKind, inv.ResourceID, inv.ActorUserID, inv.OwnerUserID, inv.WorkspaceID,
		inv.Incarnation, inv.Revision, inv.Inverse, inv.Guards, inv.InverseBytes)
	return err
}

// GetEditInverse loads an Undo record with its receipt context.
func (s *Store) GetEditInverse(ctx context.Context, operationID string) (EditInverse, AgentOperation, error) {
	var inv EditInverse
	var ws, reason, undoneBy *string
	err := s.pool.QueryRow(ctx, `SELECT operation_id, resource_kind, resource_id, actor_user_id, owner_user_id,
		workspace_id, incarnation, revision, inverse, guards, undo_status, undo_reason, undone_by
		FROM agent_edit_inverses WHERE operation_id=$1`, operationID).Scan(
		&inv.OperationID, &inv.ResourceKind, &inv.ResourceID, &inv.ActorUserID, &inv.OwnerUserID, &ws,
		&inv.Incarnation, &inv.Revision, &inv.Inverse, &inv.Guards, &inv.UndoStatus, &reason, &undoneBy)
	if isNoRows(err) {
		return EditInverse{}, AgentOperation{}, ErrNotFound
	}
	if err != nil {
		return EditInverse{}, AgentOperation{}, err
	}
	inv.WorkspaceID, inv.UndoReason, inv.UndoneBy = deref(ws), deref(reason), deref(undoneBy)
	op, err := getAgentOperation(ctx, s.pool, operationID)
	if err != nil {
		return EditInverse{}, AgentOperation{}, err
	}
	return inv, *op, nil
}

// markEditInverseUndoneTx consumes the Undo eligibility of an edit and drops
// its inverse payload; the row stays as the status record for the result card.
// The undo receipt and the reversing state change commit in the same
// transaction as this call.
func markEditInverseUndoneTx(ctx context.Context, tx pgx.Tx, operationID, undoOperationID string) error {
	ct, err := tx.Exec(ctx, `UPDATE agent_edit_inverses
		SET undo_status='undone', undone_by=$2, inverse='[]'::jsonb, guards='[]'::jsonb,
		    inverse_bytes=0, updated_at=now()
		WHERE operation_id=$1 AND undo_status='available'`, operationID, undoOperationID)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return ErrUndoUnavailable
	}
	return nil
}

// InvalidateEditInverses releases every available Undo of a resource, for
// example when an Office source is rebased, a material is compacted, or the
// resource is trashed. The result cards then show Undo as unavailable.
func (s *Store) InvalidateEditInverses(ctx context.Context, kind agenttools.ResourceKind, resourceID, reason string) error {
	return invalidateEditInversesTx(ctx, s.pool, kind, resourceID, reason)
}

func invalidateEditInversesTx(ctx context.Context, q execer, kind agenttools.ResourceKind, resourceID, reason string) error {
	_, err := q.Exec(ctx, `UPDATE agent_edit_inverses
		SET undo_status='unavailable', undo_reason=$3, inverse='[]'::jsonb, guards='[]'::jsonb,
		    inverse_bytes=0, updated_at=now()
		WHERE resource_kind=$1 AND resource_id=$2 AND undo_status='available'`, kind, resourceID, reason)
	return err
}

// UndoStatuses returns the current Undo status of the given edit operations,
// so hydrated result cards reflect releases that happened after the message
// was finalized.
func (s *Store) UndoStatuses(ctx context.Context, operationIDs []string) (map[string]agenttools.UndoRef, error) {
	out := map[string]agenttools.UndoRef{}
	if len(operationIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT operation_id, undo_status, COALESCE(undo_reason,'')
		FROM agent_edit_inverses WHERE operation_id = ANY($1)`, operationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, status, reason string
		if err := rows.Scan(&id, &status, &reason); err != nil {
			return nil, err
		}
		out[id] = agenttools.UndoRef{OperationID: id, Status: agenttools.UndoStatus(status), Reason: reason}
	}
	return out, rows.Err()
}

// cardStateRestoresTx records the study rows an Undo re-inserts, to be applied
// by the projection once it reaches restoreAtVersion.
func cardStateRestoresTx(ctx context.Context, tx pgx.Tx, operationID, materialID string, restoreAtVersion int64, restores []CardStateRestore) error {
	for _, r := range restores {
		if _, err := tx.Exec(ctx, `INSERT INTO agent_card_state_restores
			(operation_id, material_id, card_id, srs, known, restore_at_version)
			VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (operation_id, card_id) DO NOTHING`,
			operationID, materialID, r.CardID, r.SRS, r.Known, restoreAtVersion); err != nil {
			return err
		}
	}
	return nil
}

// applyCardStateRestoresTx runs inside ProjectMaterialContent after the card
// sync: every pending restoration whose version has been reached overwrites
// the fresh default row with the retained state, exactly once. A card that has
// since disappeared again keeps its restoration pending for the next reappear
// projection, so a skipped or repeated projection cannot restore twice or lose
// the retained state.
func applyCardStateRestoresTx(ctx context.Context, tx pgx.Tx, materialID string, projectedVersion int64, presentCardIDs []string, now time.Time) error {
	present := make(map[string]bool, len(presentCardIDs))
	for _, id := range presentCardIDs {
		present[id] = true
	}
	rows, err := tx.Query(ctx, `SELECT operation_id, card_id, srs, known FROM agent_card_state_restores
		WHERE material_id=$1 AND applied_at IS NULL AND restore_at_version <= $2
		ORDER BY restore_at_version, operation_id FOR UPDATE`, materialID, projectedVersion)
	if err != nil {
		return err
	}
	type pending struct {
		op, card string
		srs      json.RawMessage
		known    bool
	}
	var due []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.op, &p.card, &p.srs, &p.known); err != nil {
			rows.Close()
			return err
		}
		due = append(due, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, p := range due {
		if !present[p.card] {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO card_stats (card_id, material_id, srs, known) VALUES ($1,$2,$3,$4)
			ON CONFLICT (card_id) DO UPDATE SET srs=EXCLUDED.srs, known=EXCLUDED.known`,
			p.card, materialID, p.srs, p.known); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE agent_card_state_restores SET applied_at=$3
			WHERE operation_id=$1 AND card_id=$2`, p.op, p.card, now); err != nil {
			return err
		}
	}
	return nil
}
