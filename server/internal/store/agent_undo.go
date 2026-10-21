package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// The chat's Undo works like the editor's undo and lasts only while the edit
// is live (Epo 2026-10-20). An edit's Undo and Redo revert its Yjs items in
// the collaboration room that holds them (`/internal/documents/undo`), which
// keeps nothing once it unloads; a created file's Undo trashes it and Redo
// restores it. Nothing is stored for an Undo but receipts: each step's
// receipt names the step it reversed (agent_operations.undo_of), which is
// what a reload follows to show where a chain stands.

// ErrUndoUnavailable means the step's room no longer holds it, the step was
// used, or nothing of the edit is left.
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
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id FROM agent_operations WHERE undo_of=$1`, stepID).Scan(&id)
	if isNoRows(err) {
		return AgentOperation{}, ErrNotFound
	}
	if err != nil {
		return AgentOperation{}, err
	}
	op, err := getAgentOperation(ctx, s.pool, id)
	if err != nil {
		return AgentOperation{}, err
	}
	return *op, nil
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
// trash, a trashed file's restore): the receipt row must already exist.
func markFileUndoTx(ctx context.Context, tx pgx.Tx, receipt *AgentOperation) error {
	receipt.Effect.Undo = &agenttools.UndoRef{OperationID: receipt.ID, Status: agenttools.UndoAvailable}
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
// Undo's operation id. A restore is the owner's (the trash rule), so a
// trashed file gets its Redo ref only when the actor owns it.
func (s *Store) UndoFileStep(ctx context.Context, actorID string, step AgentOperation, op AgentOperation) (AgentOperation, error) {
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
		if err := markFileUndoTx(ctx, tx, &receipt); err != nil {
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

// UndoDocumentEdit reverts an edit step in the collaboration room holding it
// (an Undo, or the Undo of an Undo: Redo), then records the receipt, whose
// own Undo ref names the step the room now holds; none when the room keeps
// no such step (its revert would be too large to send, Epo 2026-10-21). The
// room answers with the id it keeps that step under: this request's, or an
// earlier request's whose answer was lost, and the receipt takes that id, so
// a reversed step always ends with one receipt. It carries no provenance: an
// undo restores the text only, because provenance only grows — over-crediting
// a source is harmless and under-crediting one is the licence risk.
func (s *Store) UndoDocumentEdit(ctx context.Context, actorID string, step AgentOperation, op DocumentOperation) (AgentOperation, error) {
	resource := step.Effect.Resource
	if resource.Kind == agenttools.KindSourceFile {
		// The maintenance pause refuses an Office Undo as it refuses the edit.
		if err := s.officeEditRefusal(ctx, resource.ID); err != nil {
			return AgentOperation{}, err
		}
	}
	var answer struct {
		OperationID string `json:"operationId"`
		Reversible  bool   `json:"reversible"`
	}
	err := s.postDocumentAuthority(ctx, "/internal/documents/undo", map[string]any{
		"actorUserId": actorID, "operation": op, "undoOf": step.ID,
		"target": DocumentTarget{Kind: resource.Kind, ID: resource.ID},
	}, &answer)
	var refusal *EditRefusal
	if errors.As(err, &refusal) && refusal.Code == undoUnavailableCode {
		return AgentOperation{}, ErrUndoUnavailable
	}
	if err != nil {
		return AgentOperation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	id := op.ID
	if answer.OperationID != "" {
		id = answer.OperationID
	}
	operation := agenttools.EffectEditUndone
	if step.Effect.Operation == agenttools.EffectEditUndone {
		operation = agenttools.EffectEdited
	}
	receipt := AgentOperation{
		ID: id, Kind: "undo_edit", ToolVersion: 1, RequestHash: op.RequestHash, ActorUserID: actorID,
		WorkspaceID: step.WorkspaceID, ConversationID: op.ConversationID, MessageID: op.MessageID,
		Outcome: agenttools.OutcomeSucceeded,
		Effect: &agenttools.ResourceEffect{
			Operation: operation, Resource: resource, OperationID: id,
		},
	}
	if answer.Reversible {
		receipt.Effect.Undo = &agenttools.UndoRef{OperationID: id, Status: agenttools.UndoAvailable}
	}
	if err := insertAgentOperationTx(ctx, tx, receipt); err != nil {
		return AgentOperation{}, err
	}
	if err := linkUndoTx(ctx, tx, receipt.ID, step.ID); err != nil {
		return AgentOperation{}, err
	}
	return receipt, tx.Commit(ctx)
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

// undoStatusWait bounds the undo-status ask a conversation load waits on, so
// a hung collaboration server shows no Undo instead of holding the load.
const undoStatusWait = 2 * time.Second

// LiveUndoSteps asks the collaboration service which of the given edit
// steps a loaded room still holds; only those keep their Undo after a reload.
func (s *Store) LiveUndoSteps(ctx context.Context, operationIDs []string) (map[string]bool, error) {
	live := map[string]bool{}
	if len(operationIDs) == 0 {
		return live, nil
	}
	ctx, cancel := context.WithTimeout(ctx, undoStatusWait)
	defer cancel()
	var out struct {
		Live []string `json:"live"`
	}
	if err := s.postDocumentAuthority(ctx, "/internal/documents/undo-status",
		map[string]any{"operationIds": operationIDs}, &out); err != nil {
		return nil, err
	}
	for _, id := range out.Live {
		live[id] = true
	}
	return live, nil
}

// refreshUndoStatuses shows each receipt with an Undo ref where its chain
// stands now (after an Undo, the edit_undone or trashed effect) and keeps the
// ref only on an edit step a loaded room still holds: a conversation opened
// later shows created files and closed rooms without Undo or Redo (Epo
// 2026-10-20). When the collaboration service cannot say within
// undoStatusWait, no ref stays.
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
	var edits []string
	for _, step := range steps {
		if step.Effect != nil && !FileStep(step) {
			edits = append(edits, step.ID)
		}
	}
	live, err := s.LiveUndoSteps(ctx, edits)
	if err != nil {
		obs.Log(ctx).Warn("undo status unavailable; chat history shows no Undo", "error", err)
		live = map[string]bool{}
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
				if !ok || step.Effect == nil || !live[step.ID] {
					effect.Undo = nil
				}
			}
		}
	}
	return nil
}
