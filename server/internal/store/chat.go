package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/evonotes/server/internal/models"
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
	ID               string     `json:"id"`
	ConversationID   string     `json:"conversationId"`
	Role             string     `json:"role"`
	Content          string     `json:"content"`
	Status           string     `json:"status"`
	Citations        []Citation `json:"citations,omitempty"`
	CreatedAt        time.Time  `json:"createdAt"`
	ModelKey         string     `json:"modelKey,omitempty"`
	ModelVersion     int        `json:"modelVersion,omitempty"`
	ModelDisplayName string     `json:"modelDisplayName,omitempty"`
}

// Citation is one retrieved source behind an assistant message. FileID is a
// real files.id, so the UI can open the source directly.
//
// Page numbers are 1-based and absent for sources with no page model (txt/md,
// and PDFs parsed in 'normal' mode, where the cloud parser returns markdown
// with no layout).
type Citation struct {
	FileID    string   `json:"fileId"`
	FileName  string   `json:"fileName"`
	Snippet   string   `json:"snippet"`
	PageStart *int     `json:"pageStart,omitempty"`
	PageEnd   *int     `json:"pageEnd,omitempty"`
	Regions   []Region `json:"regions,omitempty"`
}

// Region locates one source block inside its page. Stored and shipped ahead of
// the highlight overlay that will consume it; Space names the coordinate
// convention ('mineru-1000-lefttop': origin top-left, both axes scaled to
// 0..1000) so a renderer never has to infer it.
type Region struct {
	Page  int       `json:"page"`
	BBox  []float64 `json:"bbox"`
	Space string    `json:"space"`
}

// msgMetadata is the on-disk (jsonb) shape of a message's metadata column.
type msgMetadata struct {
	Citations        []Citation `json:"citations,omitempty"`
	GenerationID     string     `json:"generationId,omitempty"`
	ModelKey         string     `json:"modelKey,omitempty"`
	ModelVersion     int        `json:"modelVersion,omitempty"`
	ModelDisplayName string     `json:"modelDisplayName,omitempty"`
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
	id := uid("conv")
	var c Conversation
	err := s.pool.QueryRow(ctx,
		`INSERT INTO conversations (id, user_id, workspace_id, title)
		   VALUES ($1,$2,$3,NULLIF($4,''))
		   RETURNING id, workspace_id, COALESCE(title,''), created_at, updated_at`,
		id, userID, wsID, title).
		Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// GetConversation loads one conversation the user owns (used to authorize
// streaming/history requests). Returns ErrNotFound when absent or not owned.
func (s *Store) GetConversation(ctx context.Context, userID, convID string) (Conversation, error) {
	var c Conversation
	err := s.pool.QueryRow(ctx,
		`SELECT id, workspace_id, COALESCE(title,''), created_at, updated_at
		   FROM conversations WHERE id=$1 AND user_id=$2`, convID, userID).
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
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM conversations WHERE id=$1 AND user_id=$2`, convID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RenameConversation sets a conversation's title (e.g. auto-titled from the
// first user message).
func (s *Store) RenameConversation(ctx context.Context, userID, convID, title string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE conversations SET title=$3, updated_at=now() WHERE id=$1 AND user_id=$2`,
		convID, userID, title)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
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
		  ORDER BY created_at`, convID)
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
		m.ModelKey = meta.ModelKey
		m.ModelVersion = meta.ModelVersion
		m.ModelDisplayName = meta.ModelDisplayName
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddUserMessage persists an incoming user message and bumps the conversation's
// updated_at so it sorts to the top of the list.
func (s *Store) AddUserMessage(ctx context.Context, convID, content string) (Message, error) {
	id := uid("m")
	var m Message
	err := s.pool.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, status)
		   VALUES ($1,$2,'user',$3,'complete')
		   RETURNING id, conversation_id, role, content, status, created_at`,
		id, convID, content).
		Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &m.CreatedAt)
	if err != nil {
		return Message{}, err
	}
	_, _ = s.pool.Exec(ctx, `UPDATE conversations SET updated_at=now() WHERE id=$1`, convID)
	return m, nil
}

// StartAssistantMessage reserves an assistant row up front (status='streaming')
// so an aborted or crashed stream is always tracked and the id is stable for the
// SSE 'start' event. The resolved config is written now so the UI can name the
// model even if the stream never reaches done.
func (s *Store) StartAssistantMessage(ctx context.Context, convID string, cfg models.Config) (Message, error) {
	id := uid("m")
	meta, _ := json.Marshal(msgMetadata{
		ModelKey:         cfg.Key,
		ModelVersion:     cfg.Version,
		ModelDisplayName: cfg.DisplayName,
	})
	var m Message
	err := s.pool.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, status, metadata)
		   VALUES ($1,$2,'assistant','','streaming',$3)
		   RETURNING id, conversation_id, role, content, status, created_at`,
		id, convID, meta).
		Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &m.CreatedAt)
	if err != nil {
		return Message{}, err
	}
	m.ModelKey = cfg.Key
	m.ModelVersion = cfg.Version
	m.ModelDisplayName = cfg.DisplayName
	return m, nil
}

// FinalizeAssistantMessage writes the accumulated content, terminal status
// (complete | aborted | error), token count and citations for an assistant row.
// Uses a fresh context so persistence still succeeds when the request context
// was cancelled by a client disconnect.
func (s *Store) FinalizeAssistantMessage(ctx context.Context, msgID, content, status string, tokenCount int, citations []Citation, generationID string) error {
	meta, _ := json.Marshal(msgMetadata{Citations: citations, GenerationID: generationID})
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

// ConversationHistory returns prior completed turns as ordered role/content
// pairs for prompting the LLM (excludes the just-inserted streaming assistant
// row and any orphaned streaming rows).
func (s *Store) ConversationHistory(ctx context.Context, convID string, limit int) ([]Message, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, status, created_at FROM (
		   SELECT id, conversation_id, role, content, status, created_at
		     FROM messages
		    WHERE conversation_id=$1 AND status='complete'
		    ORDER BY created_at DESC LIMIT $2
		 ) t ORDER BY created_at`, convID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Message, 0)
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.Status, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
