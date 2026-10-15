package store

import (
	"context"
	"encoding/json"
	"errors"

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
// the same transaction as the edit; Go serves the Undo request.
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
	InverseBytes int64 `json:"-"`
	// Step is what Undo does: StepEdit applies Inverse under Guards,
	// StepTrash trashes a file the chat created, StepRestore restores it
	// from the trash episode Inverse names.
	Step       string                `json:"step"`
	UndoStatus agenttools.UndoStatus `json:"undoStatus"`
	UndoReason string                `json:"undoReason,omitempty"`
	UndoneBy   string                `json:"undoneBy,omitempty"`
}

// The steps of an Undo chain (agent_edit_inverses.step).
const (
	StepEdit    = "edit"
	StepTrash   = "trash"
	StepRestore = "restore"
)

// ErrUndoUnavailable means the edit's inverse was released or already used.
var ErrUndoUnavailable = errors.New("undo is no longer available for this edit")

func insertEditInverseTx(ctx context.Context, tx pgx.Tx, inv EditInverse) error {
	if inv.Step == "" {
		inv.Step = StepEdit
	}
	if len(inv.Guards) == 0 {
		inv.Guards = json.RawMessage(`[]`)
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_edit_inverses
		(operation_id, resource_kind, resource_id, actor_user_id, owner_user_id, workspace_id,
		 incarnation, revision, inverse, guards, inverse_bytes, step)
		VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
		inv.OperationID, inv.ResourceKind, inv.ResourceID, inv.ActorUserID, inv.OwnerUserID, inv.WorkspaceID,
		inv.Incarnation, inv.Revision, inv.Inverse, inv.Guards, inv.InverseBytes, inv.Step)
	return err
}

// hasInverseCommands reports whether a stored inverse ({"commands": [...]})
// holds anything to apply.
func hasInverseCommands(inverse json.RawMessage) bool {
	var payload struct {
		Commands []json.RawMessage `json:"commands"`
	}
	return json.Unmarshal(inverse, &payload) == nil && len(payload.Commands) > 0
}

// undoneStepEffectTx is the effect of undoing the given edit step: undoing an
// edit (or a Redo) is edit_undone, undoing an Undo is the edit again.
func undoneStepEffectTx(ctx context.Context, tx pgx.Tx, undoOf string) (agenttools.EffectOperation, error) {
	var operation *string
	if err := tx.QueryRow(ctx, `SELECT effect->>'operation' FROM agent_operations WHERE id=$1`, undoOf).Scan(&operation); err != nil && !isNoRows(err) {
		return "", err
	}
	if operation != nil && agenttools.EffectOperation(*operation) == agenttools.EffectEditUndone {
		return agenttools.EffectEdited, nil
	}
	return agenttools.EffectEditUndone, nil
}

// insertFileStepTx records the Undo step of a file the chat created or whose
// creation it undid or redid, and puts its ref on the receipt's effect: step
// trash for a live file, restore (with the trash episode) for a trashed one.
// The receipt row must already exist.
func insertFileStepTx(ctx context.Context, tx pgx.Tx, receipt *AgentOperation, step, owner, episode string) error {
	inverse := json.RawMessage(`{}`)
	if step == StepRestore {
		raw, err := json.Marshal(map[string]string{"episodeId": episode})
		if err != nil {
			return err
		}
		inverse = raw
	}
	effect := receipt.Effect
	if err := insertEditInverseTx(ctx, tx, EditInverse{
		OperationID: receipt.ID, ResourceKind: effect.Resource.Kind, ResourceID: effect.Resource.ID,
		ActorUserID: receipt.ActorUserID, OwnerUserID: owner, WorkspaceID: effect.Resource.WorkspaceID,
		Inverse: inverse, Step: step,
	}); err != nil {
		return err
	}
	effect.Undo = &agenttools.UndoRef{OperationID: receipt.ID, Status: agenttools.UndoAvailable}
	_, err := tx.Exec(ctx, `UPDATE agent_operations SET effect=$2 WHERE id=$1`, receipt.ID, effect)
	return err
}

// UndoFileStep runs a trash or restore step of a created file's chain: the
// ordinary trash or restore under the Undo's operation id, the step consumed
// and the reversing step stored, in one transaction. A restore is the owner's
// (the trash rule), so a trashed file gets its Redo only when the actor owns
// it.
func (s *Store) UndoFileStep(ctx context.Context, actorID string, inv EditInverse, op AgentOperation) (AgentOperation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	op.ActorUserID = actorID
	var receipt AgentOperation
	next := StepTrash
	switch inv.Step {
	case StepTrash:
		next = StepRestore
		if inv.ResourceKind == agenttools.KindMaterial {
			receipt, err = s.trashMaterialTx(ctx, tx, actorID, inv.ResourceID, "", op)
		} else {
			receipt, err = s.trashFileTx(ctx, tx, actorID, inv.ResourceID, op)
		}
	case StepRestore:
		var payload struct {
			EpisodeID string `json:"episodeId"`
		}
		if err := json.Unmarshal(inv.Inverse, &payload); err != nil || payload.EpisodeID == "" {
			return AgentOperation{}, ErrUndoUnavailable
		}
		receipt, err = s.restoreTrashedTx(ctx, tx, actorID, inv.ResourceKind, inv.ResourceID, payload.EpisodeID, op)
	default:
		return AgentOperation{}, ErrUndoUnavailable
	}
	if err != nil {
		return AgentOperation{}, err
	}
	// The trash above released this step with every other one of the file;
	// it is consumed instead. The trash or restore itself is the guard
	// against a concurrent second Undo.
	ct, err := tx.Exec(ctx, `UPDATE agent_edit_inverses
		SET undo_status='undone', undone_by=$2, undo_reason=NULL, updated_at=now()
		WHERE operation_id=$1 AND undone_by IS NULL`, inv.OperationID, receipt.ID)
	if err != nil {
		return AgentOperation{}, err
	}
	if ct.RowsAffected() == 0 {
		return AgentOperation{}, ErrUndoUnavailable
	}
	if receipt.Effect != nil && (next == StepTrash || inv.OwnerUserID == actorID) {
		if err := insertFileStepTx(ctx, tx, &receipt, next, inv.OwnerUserID, receipt.Effect.TrashEpisodeID); err != nil {
			return AgentOperation{}, err
		}
	}
	return receipt, tx.Commit(ctx)
}

// GetEditInverse loads an Undo record with its receipt context.
func (s *Store) GetEditInverse(ctx context.Context, operationID string) (EditInverse, AgentOperation, error) {
	var inv EditInverse
	var ws, reason, undoneBy *string
	err := s.pool.QueryRow(ctx, `SELECT operation_id, resource_kind, resource_id, actor_user_id, owner_user_id,
		workspace_id, incarnation, revision, inverse, guards, undo_status, undo_reason, undone_by, step
		FROM agent_edit_inverses WHERE operation_id=$1`, operationID).Scan(
		&inv.OperationID, &inv.ResourceKind, &inv.ResourceID, &inv.ActorUserID, &inv.OwnerUserID, &ws,
		&inv.Incarnation, &inv.Revision, &inv.Inverse, &inv.Guards, &inv.UndoStatus, &reason, &undoneBy, &inv.Step)
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
// resource is trashed. The result cards then show Undo as unavailable. A
// rebase or compaction releases edit steps only: trashing or restoring a
// created file does not depend on its content; a trash or purge releases
// every step.
func (s *Store) InvalidateEditInverses(ctx context.Context, kind agenttools.ResourceKind, resourceID, reason string) error {
	return invalidateEditInversesTx(ctx, s.pool, kind, resourceID, reason)
}

func invalidateEditInversesTx(ctx context.Context, q execer, kind agenttools.ResourceKind, resourceID, reason string) error {
	_, err := q.Exec(ctx, `UPDATE agent_edit_inverses
		SET undo_status='unavailable', undo_reason=$3, inverse='[]'::jsonb, guards='[]'::jsonb,
		    inverse_bytes=0, updated_at=now()
		WHERE resource_kind=$1 AND resource_id=$2 AND undo_status='available'
		  AND (step='edit' OR $3 IN ('trashed','purged'))`, kind, resourceID, reason)
	return err
}

// ChainStep is where an Undo chain stands now: its latest step's effect (nil
// while the chain's first step is still the latest) and that step's Undo ref
// (nil when the latest step cannot be reversed).
type ChainStep struct {
	Effect *agenttools.ResourceEffect
	Undo   *agenttools.UndoRef
}

// LatestSteps follows each given step's chain (undone_by) to its latest step,
// so a hydrated result card shows the effect and Undo or Redo the live view
// last showed, including releases after the message was finalized.
func (s *Store) LatestSteps(ctx context.Context, operationIDs []string) (map[string]ChainStep, error) {
	out := map[string]ChainStep{}
	if len(operationIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `WITH RECURSIVE chain AS (
			SELECT operation_id AS root, operation_id, undone_by, 0 AS depth
			FROM agent_edit_inverses WHERE operation_id = ANY($1)
			UNION ALL
			SELECT c.root, n.operation_id, n.undone_by, c.depth + 1
			FROM chain c JOIN agent_edit_inverses n ON n.operation_id = c.undone_by
		), latest AS (
			SELECT DISTINCT ON (root) root, COALESCE(undone_by, operation_id) AS id
			FROM chain ORDER BY root, depth DESC
		)
		SELECT l.root, l.id, i.undo_status, COALESCE(i.undo_reason,''), o.effect
		FROM latest l
		LEFT JOIN agent_edit_inverses i ON i.operation_id = l.id
		LEFT JOIN agent_operations o ON o.id = l.id`, operationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var root, id, reason string
		var status *string
		var effect []byte
		if err := rows.Scan(&root, &id, &status, &reason, &effect); err != nil {
			return nil, err
		}
		var step ChainStep
		if status != nil {
			step.Undo = &agenttools.UndoRef{OperationID: id, Status: agenttools.UndoStatus(*status), Reason: reason}
		}
		if id != root && len(effect) > 0 {
			var e agenttools.ResourceEffect
			if err := json.Unmarshal(effect, &e); err != nil {
				return nil, err
			}
			e.Undo = step.Undo
			step.Effect = &e
		}
		out[root] = step
	}
	return out, rows.Err()
}
