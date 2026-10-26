package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// The chat's Undo works like the editor's undo (Epo 2026-10-20) and survives
// the room closing (Epo 2026-10-21): an edit's receipt comes with its Undo
// payload, which the browser keeps for a day and sends back; the
// collaboration server writes it as an edit (`/internal/documents/undo`),
// with its receipt in the same transaction, and answers with the receipt and
// the Redo payload. A created file's Undo trashes it and Redo restores it.
// Every step is offered for 24 h from its agent edit or created file (Q385,
// Q162). Nothing is stored for an Undo but receipts: each step's receipt
// names the step it reversed (agent_operations.undo_of), which is what a
// reload follows to show where a chain stands.

// ErrUndoUnavailable means the step has no valid payload (none sent, a
// signature that does not match, another lineage, past its 24 h), the step
// was used, or nothing of the edit is left.
var ErrUndoUnavailable = errors.New("undo is no longer available for this edit")

// undoUnavailableCode is the collaboration service's refusal of a step it no
// longer holds.
const undoUnavailableCode = "undo_unavailable"

// UndoStep is the receipt a chat Undo or Redo reverses, when it carries an
// Undo ref of its own.
func (s *Store) UndoStep(ctx context.Context, operationID string) (AgentOperation, error) {
	op, err := getAgentOperation(ctx, s.pool, operationID)
	if err != nil {
		return AgentOperation{}, err
	}
	if op.Effect == nil || op.Effect.Undo == nil || op.Effect.Undo.OperationID != op.ID {
		return AgentOperation{}, ErrNotFound
	}
	return *op, nil
}

// UndoReceipt is the receipt of the Undo (or Redo) that reversed a step:
// ErrNotFound while the step is unused.
func (s *Store) UndoReceipt(ctx context.Context, stepID string) (AgentOperation, error) {
	op, err := undoReceiptTx(ctx, s.pool, stepID)
	if err != nil {
		return AgentOperation{}, err
	}
	if op == nil {
		return AgentOperation{}, ErrNotFound
	}
	return *op, nil
}

// undoReceiptTx is UndoReceipt under the caller's query handle; nil while the
// step is unused.
func undoReceiptTx(ctx context.Context, q rowQueryer, stepID string) (*AgentOperation, error) {
	var id string
	err := q.QueryRow(ctx, `SELECT id FROM agent_operations WHERE undo_of=$1`, stepID).Scan(&id)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return getAgentOperation(ctx, q, id)
}

// FileStep reports whether a step's Undo trashes or restores a file the chat
// created, as opposed to reverting an edit in its room.
func FileStep(step AgentOperation) bool {
	switch step.Effect.Operation {
	case agenttools.EffectCreated, agenttools.EffectTrashed, agenttools.EffectRestored:
		return true
	}
	return false
}

// markFileUndoTx puts a file step's Undo ref on its receipt (a created file's
// trash, a trashed file's restore), offered until `expires` (Q162: a day from
// the created file, as an edit's): the receipt row must already exist.
func markFileUndoTx(ctx context.Context, tx pgx.Tx, receipt *AgentOperation, expires *time.Time) error {
	receipt.Effect.Undo = &agenttools.UndoRef{OperationID: receipt.ID, Status: agenttools.UndoAvailable, ExpiresAt: expires}
	_, err := tx.Exec(ctx, `UPDATE agent_operations SET effect=$2 WHERE id=$1`, receipt.ID, receipt.Effect)
	return err
}

// linkUndoTx records that `receipt` reversed `step`. A step is reversed once:
// a second receipt naming it is refused by the unique index.
func linkUndoTx(ctx context.Context, tx pgx.Tx, receiptID, step string) error {
	_, err := tx.Exec(ctx, `UPDATE agent_operations SET undo_of=$2 WHERE id=$1`, receiptID, step)
	if isUniqueViolation(err) {
		return ErrUndoUnavailable
	}
	return err
}

// UndoFileStep runs a created file's Undo (the ordinary trash) or Redo (the
// ordinary restore of the trash episode its Undo receipt names) under the
// Undo's operation id, within the created file's day (Q162). A restore is the
// owner's (the trash rule), so a trashed file gets its Redo ref only when the
// actor owns it; the Redo keeps the created file's day.
func (s *Store) UndoFileStep(ctx context.Context, actorID string, step AgentOperation, op AgentOperation) (AgentOperation, error) {
	expires := step.Effect.Undo.ExpiresAt
	if expires != nil && !time.Now().Before(*expires) {
		return AgentOperation{}, ErrUndoUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	op.ActorUserID = actorID
	resource := step.Effect.Resource
	var receipt AgentOperation
	if step.Effect.Operation == agenttools.EffectTrashed {
		if step.Effect.TrashEpisodeID == "" {
			return AgentOperation{}, ErrUndoUnavailable
		}
		receipt, err = s.restoreTrashedTx(ctx, tx, actorID, resource.Kind, resource.ID, step.Effect.TrashEpisodeID, op)
	} else if resource.Kind == agenttools.KindMaterial {
		receipt, err = s.trashMaterialTx(ctx, tx, actorID, resource.ID, "", op)
	} else {
		receipt, err = s.trashFileTx(ctx, tx, actorID, resource.ID, op)
	}
	if err != nil {
		return AgentOperation{}, err
	}
	if receipt.Effect == nil {
		return AgentOperation{}, ErrUndoUnavailable
	}
	if err := linkUndoTx(ctx, tx, receipt.ID, step.ID); err != nil {
		return AgentOperation{}, err
	}
	owner, err := resourceOwnerTx(ctx, tx, resource.Kind, resource.ID)
	if err != nil {
		return AgentOperation{}, err
	}
	if receipt.Effect.Operation != agenttools.EffectTrashed || owner == actorID {
		if err := markFileUndoTx(ctx, tx, &receipt, expires); err != nil {
			return AgentOperation{}, err
		}
	}
	return receipt, tx.Commit(ctx)
}

// resourceOwnerTx is the account a file or material is charged to, the one
// who restores it from the trash.
func resourceOwnerTx(ctx context.Context, tx pgx.Tx, kind agenttools.ResourceKind, id string) (string, error) {
	query := `SELECT owner_user_id FROM materials WHERE id=$1`
	if kind == agenttools.KindSourceFile {
		query = `SELECT user_id FROM files WHERE id=$1`
	}
	var owner string
	err := tx.QueryRow(ctx, query, id).Scan(&owner)
	if isNoRows(err) {
		return "", ErrNotFound
	}
	return owner, err
}

// UndoDocumentEdit writes an edit step's Undo payload, sent back by the
// browser, through the collaboration server (an Undo, or the Undo of an Undo:
// Redo). The payload must carry this server's signature for this step and
// document, within its 24 h. The collaboration server commits the receipt
// (`undo_edit`, naming the step) with the write (r1 M2), so a lost answer
// still ends with exactly one receipt, which a retry is answered with. The
// receipt's own Undo ref and payload come with the Redo payload; none when
// the server builds none (too large, Epo 2026-10-21). It carries no
// provenance: an undo restores the text only, because provenance only grows
// — over-crediting a source is harmless and under-crediting one is the
// licence risk.
func (s *Store) UndoDocumentEdit(ctx context.Context, actorID string, step AgentOperation, payload *UndoPayload, op DocumentOperation) (AgentOperation, error) {
	resource := step.Effect.Resource
	if resource.Kind == agenttools.KindSourceFile {
		// The maintenance pause refuses an Office Undo as it refuses the edit,
		// for a moment: the chat keeps the step.
		if err := s.officeEditRefusal(ctx, resource.ID); err != nil {
			return AgentOperation{}, err
		}
	}
	if !s.verifyUndoPayload(step.ID, resource, payload) {
		return AgentOperation{}, ErrUndoUnavailable
	}
	target := DocumentTarget{Kind: resource.Kind, ID: resource.ID}
	req := documentRequest{
		Target: target, ActorUserID: actorID, Operation: &op, UndoOf: step.ID,
		Undo: &UndoPayload{Epoch: payload.Epoch, IssuedAt: payload.IssuedAt, Updates: payload.Updates},
	}
	if resource.Kind == agenttools.KindMaterial {
		room, err := s.MaterialRoom(ctx, resource.ID)
		if err != nil {
			return AgentOperation{}, err
		}
		req.Room = room
	}
	var out DocumentEdit
	err := s.postDocumentAuthority(ctx, "/internal/documents/undo", req, &out)
	var refusal *EditRefusal
	if errors.As(err, &refusal) && refusal.Code == undoUnavailableCode {
		// The step's receipt may have committed under a request whose answer
		// was lost while this one waited: that receipt answers.
		if existing, err := s.UndoReceipt(ctx, step.ID); err == nil {
			return existing, nil
		}
		return AgentOperation{}, ErrUndoUnavailable
	}
	if err != nil {
		return AgentOperation{}, err
	}
	receipt := out.AgentOperation
	receipt.UndoPayload = s.signUndoPayload(receipt.ID, target, receipt.UndoPayload)
	return receipt, nil
}

// LatestSteps follows each given receipt's chain (undo_of) to its latest
// step, so a reloaded conversation shows what the live view last showed.
func (s *Store) LatestSteps(ctx context.Context, operationIDs []string) (map[string]AgentOperation, error) {
	out := map[string]AgentOperation{}
	if len(operationIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `WITH RECURSIVE chain AS (
			SELECT id AS root, id, 0 AS depth FROM agent_operations WHERE id = ANY($1)
			UNION ALL
			SELECT c.root, n.id, c.depth + 1
			FROM chain c JOIN agent_operations n ON n.undo_of = c.id
		)
		SELECT DISTINCT ON (root) root, id FROM chain ORDER BY root, depth DESC`, operationIDs)
	if err != nil {
		return nil, err
	}
	latest := map[string]string{}
	for rows.Next() {
		var root, id string
		if err := rows.Scan(&root, &id); err != nil {
			rows.Close()
			return nil, err
		}
		latest[root] = id
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for root, id := range latest {
		op, err := getAgentOperation(ctx, s.pool, id)
		if err != nil {
			return nil, err
		}
		out[root] = *op
	}
	return out, nil
}

// refreshUndoStatuses shows each receipt with an Undo ref where its chain
// stands now (after an Undo, the edit_undone or trashed effect). Every step
// keeps its ref with its 24 h (Q385, Q162): the browser offers an edit's Undo
// while it holds the step's payload (Epo 2026-10-21), a created file's until
// its day ends.
func (s *Store) refreshUndoStatuses(ctx context.Context, messages []Message) error {
	var ids []string
	for _, m := range messages {
		for _, block := range m.Activity {
			for _, effect := range block.Effects {
				if effect.Undo != nil && effect.Undo.OperationID != "" {
					ids = append(ids, effect.Undo.OperationID)
				}
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	steps, err := s.LatestSteps(ctx, ids)
	if err != nil {
		return err
	}
	for mi := range messages {
		for bi := range messages[mi].Activity {
			for ei := range messages[mi].Activity[bi].Effects {
				effect := &messages[mi].Activity[bi].Effects[ei]
				if effect.Undo == nil {
					continue
				}
				step, ok := steps[effect.Undo.OperationID]
				if ok && step.Effect != nil {
					*effect = *step.Effect
				}
				if !ok || step.Effect == nil {
					effect.Undo = nil
				}
			}
		}
	}
	return nil
}
