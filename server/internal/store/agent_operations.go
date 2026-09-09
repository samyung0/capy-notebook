package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// ErrOperationConflict means an operation id was reused with a different
// normalized request. The recorded outcome is not returned in that case.
var ErrOperationConflict = errors.New("operation id already used with a different request")

// AgentOperation is one durable mutation receipt. Effect is the display
// receipt shown in chat; it never carries document content.
type AgentOperation struct {
	ID             string                     `json:"operationId"`
	Kind           string                     `json:"kind"`
	ToolVersion    int                        `json:"toolVersion"`
	RequestHash    string                     `json:"-"`
	ActorUserID    string                     `json:"-"`
	WorkspaceID    string                     `json:"workspaceId,omitempty"`
	ConversationID string                     `json:"-"`
	MessageID      string                     `json:"-"`
	CallID         string                     `json:"callId,omitempty"`
	Outcome        agenttools.Outcome         `json:"outcome"`
	Effect         *agenttools.ResourceEffect `json:"effect,omitempty"`
	Error          *agenttools.ToolError      `json:"error,omitempty"`
}

// ChatOperationID derives the operation identity of one chat tool call. The
// Python service derives the same value (retrieval/tools.py operation_id) so a
// lost response can be reconciled through the receipt read; both sides are
// pinned by a shared fixture test.
func ChatOperationID(assistantMessageID, toolCallID string) string {
	sum := sha256.Sum256([]byte(assistantMessageID + "\n" + toolCallID))
	return "op_" + hex.EncodeToString(sum[:])[:24]
}

// ChatMaterialID is the deterministic material id for a chat create call,
// unchanged from the previous generate_material derivation.
func ChatMaterialID(assistantMessageID, toolCallID string) string {
	sum := sha256.Sum256([]byte(assistantMessageID + "\n" + toolCallID))
	return "mat_" + hex.EncodeToString(sum[:])[:16]
}

// RequestHash normalizes a request payload (sorted keys, compact JSON) so a
// replay can be compared without trusting field order.
func RequestHash(payload any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return "", err
	}
	// encoding/json emits map keys sorted, so the round trip canonicalizes.
	canonical, err := json.Marshal(generic)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

// lockAgentOperationTx serializes admission of one operation id across
// replicas and returns the committed receipt when one exists. A different
// request under the same id is ErrOperationConflict.
func lockAgentOperationTx(ctx context.Context, tx pgx.Tx, id, requestHash string) (*AgentOperation, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "agent-operation:"+id); err != nil {
		return nil, err
	}
	op, err := getAgentOperation(ctx, tx, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	if op.RequestHash != requestHash {
		return nil, ErrOperationConflict
	}
	return op, nil
}

func getAgentOperation(ctx context.Context, q rowQueryer, id string) (*AgentOperation, error) {
	var (
		op            AgentOperation
		effect, error []byte
		ws, conv, msg *string
		actor, call   *string
	)
	err := q.QueryRow(ctx, `SELECT id, kind, tool_version, request_hash, actor_user_id, workspace_id,
		conversation_id, message_id, call_id, outcome, effect, error
		FROM agent_operations WHERE id=$1`, id).Scan(
		&op.ID, &op.Kind, &op.ToolVersion, &op.RequestHash, &actor, &ws, &conv, &msg, &call,
		&op.Outcome, &effect, &error)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	op.ActorUserID = deref(actor)
	op.WorkspaceID = deref(ws)
	op.ConversationID = deref(conv)
	op.MessageID = deref(msg)
	op.CallID = deref(call)
	if len(effect) > 0 {
		var e agenttools.ResourceEffect
		if err := json.Unmarshal(effect, &e); err != nil {
			return nil, err
		}
		op.Effect = &e
	}
	if len(error) > 0 {
		var e agenttools.ToolError
		if err := json.Unmarshal(error, &e); err != nil {
			return nil, err
		}
		op.Error = &e
	}
	return &op, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// insertAgentOperationTx records the receipt in the caller's transaction so it
// commits together with the state change it describes.
func insertAgentOperationTx(ctx context.Context, tx pgx.Tx, op AgentOperation) error {
	var effect, errBody any
	if op.Effect != nil {
		effect = op.Effect
	}
	if op.Error != nil {
		errBody = op.Error
	}
	if op.ToolVersion == 0 {
		op.ToolVersion = 1
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_operations
		(id, kind, tool_version, request_hash, actor_user_id, workspace_id, conversation_id,
		 message_id, call_id, outcome, effect, error)
		VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),$10,$11,$12)`,
		op.ID, op.Kind, op.ToolVersion, op.RequestHash, op.ActorUserID, op.WorkspaceID,
		op.ConversationID, op.MessageID, op.CallID, string(op.Outcome), effect, errBody)
	return err
}

// GetAgentOperation reads a receipt for an authorized reconciliation read.
// The caller has already verified the actor and workspace it belongs to.
func (s *Store) GetAgentOperation(ctx context.Context, id string) (*AgentOperation, error) {
	return getAgentOperation(ctx, s.pool, id)
}

// messageOperationsTx returns the committed receipts of one assistant message
// in creation order.
func messageOperationsTx(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, messageID string) ([]AgentOperation, error) {
	rows, err := q.Query(ctx, `SELECT id, kind, call_id, outcome, effect, error
		FROM agent_operations WHERE message_id=$1 ORDER BY created_at, id`, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentOperation{}
	for rows.Next() {
		var (
			op            AgentOperation
			call          *string
			effect, error []byte
		)
		if err := rows.Scan(&op.ID, &op.Kind, &call, &op.Outcome, &effect, &error); err != nil {
			return nil, err
		}
		op.CallID = deref(call)
		if len(effect) > 0 {
			var e agenttools.ResourceEffect
			if err := json.Unmarshal(effect, &e); err != nil {
				return nil, err
			}
			op.Effect = &e
		}
		if len(error) > 0 {
			var e agenttools.ToolError
			if err := json.Unmarshal(error, &e); err != nil {
				return nil, err
			}
			op.Error = &e
		}
		out = append(out, op)
	}
	return out, rows.Err()
}

// mergeOperationEffects reconciles the activity Python reported with the
// receipts Go committed, keyed by tool call. A receipt whose call never
// reached the activity array (lost SSE, crashed stream) is appended so history
// cannot hide a committed mutation.
func mergeOperationEffects(activity []ActivityBlock, ops []AgentOperation) []ActivityBlock {
	if len(ops) == 0 {
		return activity
	}
	out := append([]ActivityBlock(nil), activity...)
	index := map[string]int{}
	for i, block := range out {
		if block.Kind == "tool" && block.CallID != "" {
			index[block.CallID] = i
		}
	}
	for _, op := range ops {
		if op.Effect == nil {
			continue
		}
		effect := *op.Effect
		if effect.OperationID == "" {
			effect.OperationID = op.ID
		}
		if i, ok := index[op.CallID]; ok {
			block := &out[i]
			block.Outcome = op.Outcome
			block.Error = op.Error
			replaced := false
			for j, existing := range block.Effects {
				if existing.OperationID == effect.OperationID {
					block.Effects[j] = effect
					replaced = true
				}
			}
			if !replaced {
				block.Effects = append(block.Effects, effect)
			}
			continue
		}
		out = append(out, ActivityBlock{
			ID:      op.CallID,
			Kind:    "tool",
			CallID:  op.CallID,
			Name:    op.Kind,
			Outcome: op.Outcome,
			Error:   op.Error,
			Effects: []agenttools.ResourceEffect{effect},
		})
		index[op.CallID] = len(out) - 1
	}
	return out
}
