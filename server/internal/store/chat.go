package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Conversation is a workspace-scoped chat thread. Grounding for its messages
// runs against WorkspaceID's chunks in the retrieval store.
type Conversation struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Title       string    `json:"title"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Message is one turn in a conversation. Status tracks the streaming lifecycle
// (streaming -> complete | aborted | error). Citations are the RAG sources the
// assistant grounded its answer on (persisted in the metadata jsonb column).
type Message struct {
	ID               string          `json:"id"`
	ConversationID   string          `json:"conversationId"`
	Role             string          `json:"role"`
	Content          string          `json:"content"`
	Status           string          `json:"status"`
	Citations        []Citation      `json:"citations,omitempty"`
	Activity         []ActivityBlock `json:"activity,omitempty"`
	CreatedAt        time.Time       `json:"createdAt"`
	ProviderSlug     string          `json:"providerSlug,omitempty"`
	ModelSlug        string          `json:"modelSlug,omitempty"`
	ModelVersion     int             `json:"modelVersion,omitempty"`
	ModelDisplayName string          `json:"modelDisplayName,omitempty"`
}

// Citation is one retrieved source behind an assistant message. FileID is a
// real files.id, so the UI can open the source directly.
//
// Page numbers are 1-based and absent for sources with no page model (txt/md,
// and PDFs parsed in 'normal' mode, where the cloud parser returns markdown
// with no layout).
type Citation struct {
	FileID    string   `json:"fileId"`
	ChunkID   string   `json:"chunkId,omitempty"`
	FileName  string   `json:"fileName"`
	Snippet   string   `json:"snippet"`
	PageStart *int     `json:"pageStart,omitempty"`
	PageEnd   *int     `json:"pageEnd,omitempty"`
	Regions   []Region `json:"regions,omitempty"`
}

// ActivityBlock is one completed narration or tool-display item persisted on
// the assistant row. It is shown in the UI and never sent back as LLM history.
type ActivityBlock struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Text   string `json:"text,omitempty"`
	CallID string `json:"callId,omitempty"`
	Name   string `json:"name,omitempty"`
	Detail string `json:"detail,omitempty"`
	Status string `json:"status,omitempty"`
}

// ConversationCheckpoint is the rolling summary pin for one conversation.
type ConversationCheckpoint struct {
	ThroughMessageID string `json:"throughMessageId"`
	Summary          string `json:"summary"`
	ProviderSlug     string `json:"providerSlug"`
	ModelSlug        string `json:"modelSlug"`
	ModelVersion     int    `json:"modelVersion"`
	EstimatedTokens  int    `json:"estimatedTokens"`
}

// ConversationPrompt is prior context for one turn: optional checkpoint plus
// all completed history after that pin. It never includes the current question.
type ConversationPrompt struct {
	Checkpoint *ConversationCheckpoint `json:"checkpoint,omitempty"`
	History    []Message               `json:"history"`
}

// Region locates one source block inside its page. Stored and shipped ahead of
// the highlight overlay that will consume it; Space names the coordinate
// convention ('page-1000-topleft': origin top-left, both axes scaled to
// 0..1000) so a renderer never has to infer it.
type Region struct {
	Page  int       `json:"page"`
	BBox  []float64 `json:"bbox"`
	Space string    `json:"space"`
}

// msgMetadata is the on-disk (jsonb) shape of a message's metadata column.
type msgMetadata struct {
	Citations        []Citation      `json:"citations,omitempty"`
	Activity         []ActivityBlock `json:"activity,omitempty"`
	GenerationID     string          `json:"generationId,omitempty"`
	TraceID          string          `json:"traceId,omitempty"`
	ProviderSlug     string          `json:"providerSlug,omitempty"`
	ModelSlug        string          `json:"modelSlug,omitempty"`
	ModelVersion     int             `json:"modelVersion,omitempty"`
	ModelDisplayName string          `json:"modelDisplayName,omitempty"`
}

/* --------------------------------------------------------- conversations */

// ListConversations returns a workspace's conversations for a user, newest
// activity first. Ownership is enforced via the user_id + workspace_id pair.
func (s *Store) ListConversations(ctx context.Context, userID, wsID string) ([]Conversation, error) {
	if err := s.AssertWorkspaceEditor(ctx, userID, wsID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, workspace_id, COALESCE(title,''), created_at, updated_at
		   FROM conversations WHERE user_id=$1 AND workspace_id=$2
		   ORDER BY updated_at DESC`, userID, wsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Conversation, 0)
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CreateConversation opens a new thread in a workspace the user can edit.
// The model is resolved per assistant turn, not snapshotted here: Settings
// changes apply to the next message in an existing thread.
func (s *Store) CreateConversation(ctx context.Context, userID, wsID, title string) (Conversation, error) {
	if err := s.AssertWorkspaceEditor(ctx, userID, wsID); err != nil {
		return Conversation{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback(ctx)
	_, err = s.lockWorkspaceEditorMutationTx(ctx, tx, wsID, userID)
	if err != nil {
		return Conversation{}, err
	}
	id := uid("conv")
	var c Conversation
	err = tx.QueryRow(ctx,
		`INSERT INTO conversations (id, user_id, workspace_id, title)
		   VALUES ($1,$2,$3,NULLIF($4,''))
		   RETURNING id, workspace_id, COALESCE(title,''), created_at, updated_at`,
		id, userID, wsID, title).
		Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return Conversation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// GetConversation loads one conversation the user owns (used to authorize
// streaming/history requests). Returns ErrNotFound when absent or not owned.
func (s *Store) GetConversation(ctx context.Context, userID, convID string) (Conversation, error) {
	var c Conversation
	err := s.pool.QueryRow(ctx,
		`SELECT c.id, c.workspace_id, COALESCE(c.title,''), c.created_at, c.updated_at
		   FROM conversations c
		   JOIN workspaces w ON w.id=c.workspace_id
		   JOIN users owner ON owner.id=w.user_id
		   LEFT JOIN workspace_members wm
		     ON wm.workspace_id=w.id AND wm.user_id=$2
		  WHERE c.id=$1 AND c.user_id=$2
		    AND owner.deleted_at IS NULL
		    AND owner.deletion_requested_at IS NULL
		    AND (w.user_id=$2 OR wm.role IN ('owner','editor'))`, convID, userID).
		Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.CreatedAt, &c.UpdatedAt)
	if isNoRows(err) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// DeleteConversation removes a conversation (messages cascade).
func (s *Store) DeleteConversation(ctx context.Context, userID, convID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM conversations
		WHERE id=$1 AND user_id=$2`, convID, userID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, userID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM conversations WHERE id=$1 AND user_id=$2`, convID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// RenameConversation sets a conversation's title (e.g. auto-titled from the
// first user message).
func (s *Store) RenameConversation(ctx context.Context, userID, convID, title string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM conversations
		WHERE id=$1 AND user_id=$2`, convID, userID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, userID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`UPDATE conversations SET title=$3, updated_at=now() WHERE id=$1 AND user_id=$2`,
		convID, userID, title)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

/* ---------------------------------------------------------------- messages */

// ListMessages returns a conversation's history in chronological order,
// excluding still-streaming rows (orphans from a crashed stream). Ownership is
// enforced against userID.
func (s *Store) ListMessages(ctx context.Context, userID, convID string) ([]Message, error) {
	if _, err := s.GetConversation(ctx, userID, convID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, status, metadata, created_at
		   FROM messages
		  WHERE conversation_id=$1 AND status <> 'streaming'
		  ORDER BY created_at, id`, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Message, 0)
	for rows.Next() {
		var (
			m   Message
			raw []byte
		)
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &raw, &m.CreatedAt); err != nil {
			return nil, err
		}
		var meta msgMetadata
		_ = json.Unmarshal(raw, &meta)
		m.Citations = meta.Citations
		m.Activity = meta.Activity
		m.ProviderSlug = meta.ProviderSlug
		m.ModelSlug = meta.ModelSlug
		m.ModelVersion = meta.ModelVersion
		m.ModelDisplayName = meta.ModelDisplayName
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddUserMessage persists an incoming user message and bumps the conversation's
// updated_at so it sorts to the top of the list.
func (s *Store) AddUserMessage(ctx context.Context, userID, convID, content string) (Message, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM conversations
		WHERE id=$1 AND user_id=$2`, convID, userID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return Message{}, ErrNotFound
		}
		return Message{}, err
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, userID); err != nil {
		return Message{}, err
	}
	id := uid("m")
	var m Message
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, status)
		   VALUES ($1,$2,'user',$3,'complete')
		   RETURNING id, conversation_id, role, content, status, created_at`,
		id, convID, content).
		Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &m.CreatedAt)
	if err != nil {
		return Message{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE conversations SET updated_at=now()
		WHERE id=$1 AND user_id=$2`, convID, userID); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	return m, nil
}

// StartAssistantMessage reserves an assistant row up front (status='streaming')
// so an aborted or crashed stream is always tracked and the id is stable for the
// SSE 'start' event. The resolved config is written now so the UI can name the
// model even if the stream never reaches done.
func (s *Store) StartAssistantMessage(ctx context.Context, userID, convID string, cfg models.Config) (Message, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	var workspaceID string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM conversations
		WHERE id=$1 AND user_id=$2`, convID, userID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return Message{}, ErrNotFound
		}
		return Message{}, err
	}
	if _, err := s.lockWorkspaceEditorMutationTx(ctx, tx, workspaceID, userID); err != nil {
		return Message{}, err
	}
	id := uid("m")
	meta, _ := json.Marshal(msgMetadata{
		ProviderSlug:     cfg.ProviderSlug,
		ModelSlug:        cfg.ModelSlug,
		ModelVersion:     cfg.Version,
		ModelDisplayName: cfg.DisplayName(),
		TraceID:          obs.TraceID(ctx),
	})
	var m Message
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, status, metadata)
		   VALUES ($1,$2,'assistant','','streaming',$3)
		   RETURNING id, conversation_id, role, content, status, created_at`,
		id, convID, meta).
		Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &m.CreatedAt)
	if err != nil {
		return Message{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, err
	}
	m.ProviderSlug = cfg.ProviderSlug
	m.ModelSlug = cfg.ModelSlug
	m.ModelVersion = cfg.Version
	m.ModelDisplayName = cfg.DisplayName()
	return m, nil
}

// FinalizeAssistantMessage writes the accumulated content, terminal status
// (complete | aborted | error), token count and citations for an assistant row.
// Uses a fresh context so persistence still succeeds when the request context
// was cancelled by a client disconnect.
func (s *Store) FinalizeAssistantMessage(ctx context.Context, msgID, content, status string, tokenCount int, citations []Citation, generationID string, activity []ActivityBlock) error {
	meta, _ := json.Marshal(msgMetadata{Citations: citations, GenerationID: generationID, Activity: activity})
	var tc *int
	if tokenCount > 0 {
		tc = &tokenCount
	}
	_, err := s.pool.Exec(ctx,
		`UPDATE messages SET content=$2, status=$3, token_count=$4,
		        metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
		  WHERE id=$1`,
		msgID, content, status, tc, meta)
	return err
}

// ConversationPrompt loads the rolling checkpoint (if any) and every completed
// historical message after that pin. Call this before inserting the current
// user row so the question is not sent twice.
func (s *Store) ConversationPrompt(ctx context.Context, convID string) (ConversationPrompt, error) {
	var (
		cp        ConversationCheckpoint
		throughID *string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT through_message_id, summary, model_provider_slug, model_slug, model_version, estimated_tokens
		  FROM conversation_compactions WHERE conversation_id=$1`, convID).
		Scan(&cp.ThroughMessageID, &cp.Summary, &cp.ProviderSlug, &cp.ModelSlug, &cp.ModelVersion, &cp.EstimatedTokens)
	switch {
	case err == nil:
		throughID = &cp.ThroughMessageID
	case !isNoRows(err):
		return ConversationPrompt{}, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, conversation_id, role, content, status, metadata, created_at
		  FROM messages
		 WHERE conversation_id=$1 AND status='complete'
		   AND ($2::text IS NULL OR (created_at, id) > (
		        SELECT created_at, id FROM messages WHERE id=$2
		      ))
		 ORDER BY created_at, id`, convID, throughID)
	if err != nil {
		return ConversationPrompt{}, err
	}
	defer rows.Close()
	history := make([]Message, 0)
	for rows.Next() {
		var (
			m   Message
			raw []byte
		)
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &raw, &m.CreatedAt); err != nil {
			return ConversationPrompt{}, err
		}
		var meta msgMetadata
		_ = json.Unmarshal(raw, &meta)
		m.Citations = meta.Citations
		history = append(history, m)
	}
	if err := rows.Err(); err != nil {
		return ConversationPrompt{}, err
	}
	out := ConversationPrompt{History: history}
	if throughID != nil {
		out.Checkpoint = &cp
	}
	return out, nil
}

// PersistCheckpoint writes or advances the rolling pin. A later pin wins; an
// earlier one is ignored so two tabs cannot move the conversation backwards.
func (s *Store) PersistCheckpoint(ctx context.Context, convID string, cp ConversationCheckpoint) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO conversation_compactions (
		  conversation_id, through_message_id, summary,
		  model_provider_slug, model_slug, model_version, estimated_tokens
		) VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (conversation_id) DO UPDATE SET
		  through_message_id = EXCLUDED.through_message_id,
		  summary = EXCLUDED.summary,
		  model_provider_slug = EXCLUDED.model_provider_slug,
		  model_slug = EXCLUDED.model_slug,
		  model_version = EXCLUDED.model_version,
		  estimated_tokens = EXCLUDED.estimated_tokens,
		  updated_at = now()
		WHERE (
		  SELECT (m.created_at, m.id) FROM messages m WHERE m.id = EXCLUDED.through_message_id
		) > (
		  SELECT (m.created_at, m.id) FROM messages m WHERE m.id = conversation_compactions.through_message_id
		)`,
		convID, cp.ThroughMessageID, cp.Summary, cp.ProviderSlug, cp.ModelSlug, cp.ModelVersion, cp.EstimatedTokens)
	return err
}
