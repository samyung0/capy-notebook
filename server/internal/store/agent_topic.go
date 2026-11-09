package store

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Chat's create_topic (Epo 2026-10-29): an optional name, else "Topic (n)"
// with the lowest n none of the workspace's topics is named with, and an
// optional one-line description; appended last; a receipt and no Undo, as
// create_workspace.

var newTopicNameRE = regexp.MustCompile(`^Topic \(([1-9][0-9]*)\)$`)

// ChatTopicID is the topic id of a chat create_topic call: its operation
// id under the topic prefix, so a replay or a recovered receipt (the
// pipeline's tools.topic_id) finds the topic it made.
func ChatTopicID(assistantMessageID, toolCallID string) string {
	return "tp_" + strings.TrimPrefix(ChatOperationID(assistantMessageID, toolCallID), "op_")
}

// nextTopicNameTx is the default name; the caller holds the workspace's
// editor lock, so two creates cannot take the same n.
func nextTopicNameTx(ctx context.Context, tx pgx.Tx, wsID string) (string, error) {
	rows, err := tx.Query(ctx, `SELECT name FROM topics WHERE workspace_id=$1 AND name LIKE 'Topic (%)'`, wsID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	taken := map[int]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return "", err
		}
		if m := newTopicNameRE.FindStringSubmatch(name); m != nil {
			n, _ := strconv.Atoi(m[1])
			taken[n] = true
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	n := 1
	for taken[n] {
		n++
	}
	return fmt.Sprintf("Topic (%d)", n), nil
}

// CreateTopicOperation adds a chat's topic to wsID and records its receipt
// in one transaction; a replay of the same call returns the receipt. The
// receipt carries no effect, so the chat offers no Undo.
func (s *Store) CreateTopicOperation(ctx context.Context, actorID, wsID, name, description string, op AgentOperation) (AgentOperation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentOperation{}, err
	}
	defer tx.Rollback(ctx)
	existing, err := lockAgentOperationTx(ctx, tx, op.ID, op.RequestHash)
	if err != nil {
		return AgentOperation{}, err
	}
	if existing != nil {
		return *existing, nil
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, actorID); err != nil {
		return AgentOperation{}, err
	}
	if name == "" {
		if name, err = nextTopicNameTx(ctx, tx, wsID); err != nil {
			return AgentOperation{}, err
		}
	}
	if _, err := s.addTopicTx(ctx, tx, wsID, ChatTopicID(op.MessageID, op.CallID), name, description); err != nil {
		return AgentOperation{}, err
	}
	op.Kind = "create_topic"
	op.WorkspaceID = wsID
	op.Outcome = agenttools.OutcomeSucceeded
	op.Effect, op.Error = nil, nil
	if err := insertAgentOperationTx(ctx, tx, op); err != nil {
		return AgentOperation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentOperation{}, err
	}
	return op, nil
}

// TopicName is a topic's name, "" once it is gone.
func (s *Store) TopicName(ctx context.Context, id string) (string, error) {
	var name string
	err := s.pool.QueryRow(ctx, `SELECT name FROM topics WHERE id=$1`, id).Scan(&name)
	if isNoRows(err) {
		return "", nil
	}
	return name, err
}
