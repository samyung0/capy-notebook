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

// Chat's create_chapter (Epo 2026-10-29): an optional name, else "Chapter (n)"
// with the lowest n none of the workspace's chapters is named with; appended
// last; a receipt and no Undo, as create_workspace.

var newChapterNameRE = regexp.MustCompile(`^Chapter \(([1-9][0-9]*)\)$`)

// ChatChapterID is the chapter id of a chat create_chapter call: its operation
// id under the chapter prefix, so a replay or a recovered receipt (the
// pipeline's tools.chapter_id) finds the chapter it made.
func ChatChapterID(assistantMessageID, toolCallID string) string {
	return "ch_" + strings.TrimPrefix(ChatOperationID(assistantMessageID, toolCallID), "op_")
}

// nextChapterNameTx is the default name; the caller holds the workspace's
// editor lock, so two creates cannot take the same n.
func nextChapterNameTx(ctx context.Context, tx pgx.Tx, wsID string) (string, error) {
	rows, err := tx.Query(ctx, `SELECT name FROM chapters WHERE workspace_id=$1 AND name LIKE 'Chapter (%)'`, wsID)
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
		if m := newChapterNameRE.FindStringSubmatch(name); m != nil {
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
	return fmt.Sprintf("Chapter (%d)", n), nil
}

// CreateChapterOperation adds a chat's chapter to wsID and records its receipt
// in one transaction; a replay of the same call returns the receipt. The
// receipt carries no effect, so the chat offers no Undo.
func (s *Store) CreateChapterOperation(ctx context.Context, actorID, wsID, name string, op AgentOperation) (AgentOperation, error) {
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
		if name, err = nextChapterNameTx(ctx, tx, wsID); err != nil {
			return AgentOperation{}, err
		}
	}
	if _, err := addChapterTx(ctx, tx, wsID, ChatChapterID(op.MessageID, op.CallID), name); err != nil {
		return AgentOperation{}, err
	}
	op.Kind = "create_chapter"
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

// ChapterName is a chapter's name, "" once it is gone.
func (s *Store) ChapterName(ctx context.Context, id string) (string, error) {
	var name string
	err := s.pool.QueryRow(ctx, `SELECT name FROM chapters WHERE id=$1`, id).Scan(&name)
	if isNoRows(err) {
		return "", nil
	}
	return name, err
}
