package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Conversation is a chat thread: a workspace's, grounded in WorkspaceID's
// chunks, or with WorkspaceID "" its user's account chat across their own
// files (Epo 2026-10-27). It keeps its scope for life.
type Conversation struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId" doc:"Empty for an account conversation"`
	Title       string    `json:"title"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	// Set while the thread sits at the top of the list.
	PinnedAt *time.Time `json:"pinnedAt,omitempty"`
	// Set while the thread is out of the list, in the archived dialog.
	ArchivedAt *time.Time `json:"archivedAt,omitempty"`
	// A turn of the thread is still streaming (Epo 2026-10-27, T19).
	Running bool `json:"running"`
}

const conversationCols = `id, COALESCE(workspace_id,''), COALESCE(title,''), created_at, updated_at, pinned_at, archived_at,
	EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id AND m.status = 'streaming')`

func scanConversation(row pgx.Row) (Conversation, error) {
	var c Conversation
	err := row.Scan(&c.ID, &c.WorkspaceID, &c.Title, &c.CreatedAt, &c.UpdatedAt, &c.PinnedAt, &c.ArchivedAt, &c.Running)
	return c, err
}

// Message is one turn in a conversation. Status tracks the streaming lifecycle
// (streaming -> complete | aborted | error). Citations are the RAG sources the
// assistant grounded its answer on (persisted in the metadata jsonb column).
type Message struct {
	// Private prompt evidence is not returned by the browser message API.
	ToolEvidence json.RawMessage `json:"-"`
	// WorkspaceOnly is the switch a user message was sent with, replayed as
	// its mode line; nil on messages saved before the switch existed.
	WorkspaceOnly    *bool           `json:"-"`
	ID               string          `json:"id"`
	ConversationID   string          `json:"conversationId"`
	Role             string          `json:"role"`
	Content          string          `json:"content"`
	Status           string          `json:"status"`
	ErrorCode        string          `json:"errorCode,omitempty"`
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
	// Kind is "material" when the passage came from an indexed note; then
	// MaterialID names the note and FileID is empty. It is "web" for a
	// search_web result; then URL, SiteName and Published (YYYY-MM-DD, when
	// known) describe the page and FileID is empty.
	Kind       string `json:"kind,omitempty"`
	MaterialID string `json:"materialId,omitempty"`
	FileID     string `json:"fileId"`
	ChunkID    string `json:"chunkId,omitempty"`
	// N is the passage number the answer program cites; the entry's position
	// in the list is the number the reader sees.
	N         int      `json:"n,omitempty"`
	FileName  string   `json:"fileName"`
	Snippet   string   `json:"snippet"`
	PageStart *int     `json:"pageStart,omitempty"`
	PageEnd   *int     `json:"pageEnd,omitempty"`
	Regions   []Region `json:"regions,omitempty"`
	URL       string   `json:"url,omitempty"`
	SiteName  string   `json:"siteName,omitempty"`
	Published string   `json:"published,omitempty"`
	// WorkspaceID and WorkspaceName say where an account chat's source lives
	// (Epo 2026-10-27). WorkspaceID is absent in workspace chat and "" for a
	// file with no workspace, so it is a pointer to keep that "".
	WorkspaceID   *string `json:"workspaceId,omitempty"`
	WorkspaceName string  `json:"workspaceName,omitempty"`
}

// ActivityBlock is one completed narration or tool-display item persisted on
// the assistant row. It is shown in the UI and never sent back as LLM history.
// Tool blocks carry the shared agent-tool result contract: a terminal outcome,
// a safe typed error and the durable resource effects the call committed.
type ActivityBlock struct {
	ID      string                      `json:"id"`
	Kind    string                      `json:"kind" enum:"narration,tool"`
	Text    string                      `json:"text,omitempty"`
	CallID  string                      `json:"callId,omitempty"`
	Name    string                      `json:"name,omitempty"`
	Detail  string                      `json:"detail,omitempty"`
	Outcome agenttools.Outcome          `json:"outcome,omitempty" enum:"succeeded,refused,failed,cancelled,outcome_unknown"`
	Error   *agenttools.ToolError       `json:"error,omitempty"`
	Effects []agenttools.ResourceEffect `json:"effects,omitempty"`
	Capture *ActivityCapture            `json:"capture,omitempty"`
	// StartedAt and EndedAt bound a tool block's run (the retrieval
	// service's clock), so "Worked for 14s" survives a reload.
	StartedAt *time.Time `json:"startedAt,omitempty"`
	EndedAt   *time.Time `json:"endedAt,omitempty"`
	// Applied of Total commands, only on a call that ended with commands
	// unapplied: an Office edit the engine cut at a per-call limit that the
	// turn's next edit of the file did not follow (Epo 2026-10-23, Q171).
	Applied *int `json:"applied,omitempty"`
	Total   *int `json:"total,omitempty"`
}

// ActivityCapture is what a successful capture_page call rendered: the page,
// the box on it (0-1000 page units) and the JPEG size. The image is not kept.
type ActivityCapture struct {
	Page  int   `json:"page"`
	Bbox  []int `json:"bbox"`
	Bytes int   `json:"bytes"`
}

// UnmarshalJSON maps the pre-contract `status` of a persisted tool block onto
// an outcome, so hydrated history never shows a tool as still running.
func (b *ActivityBlock) UnmarshalJSON(data []byte) error {
	type plain ActivityBlock
	var decoded struct {
		plain
		Status string `json:"status"`
	}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*b = ActivityBlock(decoded.plain)
	if b.Kind == "tool" && b.Outcome == "" {
		switch decoded.Status {
		case "success":
			b.Outcome = agenttools.OutcomeSucceeded
		case "refused":
			b.Outcome = agenttools.OutcomeRefused
		case "error", "failed":
			b.Outcome = agenttools.OutcomeFailed
		default:
			b.Outcome = agenttools.OutcomeUnknown
		}
	}
	return nil
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
// all finalized history after that pin. It never includes the current question.
type ConversationPrompt struct {
	Checkpoint *ConversationCheckpoint `json:"checkpoint,omitempty"`
	History    []Message               `json:"history"`
	// OfficeTools says an earlier turn of the conversation, compacted or not,
	// was offered the Office tools, which then stay offered (Epo 2026-10-15).
	OfficeTools bool `json:"officeTools,omitempty"`
}

// Region locates one source block inside its page. Stored and shipped ahead of
// the highlight overlay that will consume it; Space names the coordinate
// convention ('page-1000-topleft': origin top-left, both axes scaled to
// 0..1000) so a renderer never has to infer it. An audio transcript's region
// ('audio-ms') is one sentence's span in the recording instead, with its
// speaker when the transcript has speaker labels; its page is 0.
type Region struct {
	Page    int       `json:"page"`
	BBox    []float64 `json:"bbox"`
	Space   string    `json:"space"`
	StartMs *int64    `json:"start_ms,omitempty"`
	EndMs   *int64    `json:"end_ms,omitempty"`
	Speaker *int      `json:"speaker,omitempty"`
}

// msgMetadata is the on-disk (jsonb) shape of a message's metadata column.
type msgMetadata struct {
	ErrorCode        string          `json:"errorCode,omitempty"`
	ToolEvidence     json.RawMessage `json:"toolEvidence,omitempty"`
	Citations        []Citation      `json:"citations,omitempty"`
	Activity         []ActivityBlock `json:"activity,omitempty"`
	GenerationID     string          `json:"generationId,omitempty"`
	TraceID          string          `json:"traceId,omitempty"`
	ProviderSlug     string          `json:"providerSlug,omitempty"`
	ModelSlug        string          `json:"modelSlug,omitempty"`
	ModelVersion     int             `json:"modelVersion,omitempty"`
	ModelDisplayName string          `json:"modelDisplayName,omitempty"`
	WorkspaceOnly    *bool           `json:"workspaceOnly,omitempty"`
}

/* --------------------------------------------------------- conversations */

// ListConversations returns a user's conversations in a workspace, or with
// wsID "" their account conversations: the live list (pinned first, then
// newest activity) or, with archived, the archived ones, most recently
// archived first. Ownership is enforced via user_id. Workspace chat is open to
// any effective role (membership raised by link/public privacy), so shared
// viewers get their own private threads.
func (s *Store) ListConversations(ctx context.Context, userID, wsID string, archived bool) ([]Conversation, error) {
	if userID == "" {
		return nil, ErrNotFound
	}
	where, args := `user_id=$1 AND workspace_id IS NULL`, []any{userID}
	if wsID != "" {
		if _, err := s.WorkspaceEffectiveRole(ctx, userID, wsID); err != nil {
			return nil, err
		}
		where, args = `user_id=$1 AND workspace_id=$2`, []any{userID, wsID}
	}
	query := `SELECT ` + conversationCols + ` FROM conversations
		WHERE ` + where + ` AND archived_at IS NULL
		ORDER BY pinned_at DESC NULLS LAST, updated_at DESC`
	if archived {
		query = `SELECT ` + conversationCols + ` FROM conversations
			WHERE ` + where + ` AND archived_at IS NOT NULL
			ORDER BY archived_at DESC`
	}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Conversation, 0)
	for rows.Next() {
		c, err := scanConversation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CreateConversation opens a new thread in a workspace where the user holds
// any effective role, or with wsID "" an account conversation of theirs.
// The model is resolved per assistant turn, not snapshotted here: Settings
// changes apply to the next message in an existing thread.
func (s *Store) CreateConversation(ctx context.Context, userID, wsID, title string) (Conversation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback(ctx)
	if userID == "" {
		return Conversation{}, ErrNotFound
	}
	if wsID != "" {
		if err := s.lockWorkspaceChatTx(ctx, tx, wsID, userID); err != nil {
			return Conversation{}, err
		}
	}
	id := uid("conv")
	c, err := scanConversation(tx.QueryRow(ctx,
		`INSERT INTO conversations (id, user_id, workspace_id, title)
		   VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''))
		   RETURNING `+conversationCols,
		id, userID, wsID, title))
	if err != nil {
		return Conversation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// GetConversation loads one conversation the user owns (used to authorize
// streaming/history requests). Returns ErrNotFound when absent, not owned, or
// when the user no longer holds any effective role in its workspace; an
// account conversation is its owner's alone.
func (s *Store) GetConversation(ctx context.Context, userID, convID string) (Conversation, error) {
	c, err := scanConversation(s.pool.QueryRow(ctx,
		`SELECT `+conversationCols+` FROM conversations WHERE id=$1 AND user_id=$2`, convID, userID))
	if isNoRows(err) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, err
	}
	if c.WorkspaceID == "" {
		return c, nil
	}
	if _, err := s.WorkspaceEffectiveRole(ctx, userID, c.WorkspaceID); err != nil {
		return Conversation{}, err
	}
	return c, nil
}

// lockConversationTx admits a write to one of the user's conversations: a
// workspace one through lockWorkspaceChatTx, an account one by ownership
// alone.
func (s *Store) lockConversationTx(ctx context.Context, tx pgx.Tx, userID, convID string) error {
	var workspaceID *string
	if err := tx.QueryRow(ctx, `SELECT workspace_id FROM conversations
		WHERE id=$1 AND user_id=$2`, convID, userID).Scan(&workspaceID); err != nil {
		if isNoRows(err) {
			return ErrNotFound
		}
		return err
	}
	if workspaceID == nil {
		return nil
	}
	return s.lockWorkspaceChatTx(ctx, tx, *workspaceID, userID)
}

// lockWorkspaceChatTx is the chat counterpart of lockWorkspaceEditorMutationTx:
// same lock order, but admission is any effective role so shared viewers can
// hold their own threads. The workspace row is locked before the role read, so
// a concurrent privacy change or removal is observed.
func (s *Store) lockWorkspaceChatTx(ctx context.Context, tx pgx.Tx, wsID, userID string) error {
	if userID == "" {
		return ErrNotFound
	}
	if _, err := s.lockWorkspaceMutationTx(ctx, tx, wsID, userID); err != nil {
		return err
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT w.user_id=$2
		OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=$2)
		OR (w.privacy IN ('link','public') AND `+linkReachSQL("w", "$2")+`)
		FROM workspaces w JOIN users owner ON owner.id=w.user_id
		WHERE w.id=$1 AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
			AND (owner.suspended_at IS NULL OR owner.id=$2)`,
		wsID, userID).Scan(&allowed)
	if isNoRows(err) || (err == nil && !allowed) {
		return ErrNotFound
	}
	return err
}

// DeleteConversation removes a conversation (messages cascade).
func (s *Store) DeleteConversation(ctx context.Context, userID, convID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := s.lockConversationTx(ctx, tx, userID, convID); err != nil {
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
	if err := s.lockConversationTx(ctx, tx, userID, convID); err != nil {
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

// ConversationUpdate is the user's edit of one thread; nil fields stay. None
// of them counts as activity, so the list order by updated_at holds.
type ConversationUpdate struct {
	Title    *string
	Pinned   *bool
	Archived *bool
}

// UpdateConversation renames, pins or archives a thread the user owns.
// Archiving clears the pin; unarchiving puts the thread back unpinned.
func (s *Store) UpdateConversation(ctx context.Context, userID, convID string, u ConversationUpdate) (Conversation, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback(ctx)
	if err := s.lockConversationTx(ctx, tx, userID, convID); err != nil {
		return Conversation{}, err
	}
	c, err := scanConversation(tx.QueryRow(ctx,
		`UPDATE conversations SET
		   title = COALESCE($3, title),
		   pinned_at = CASE WHEN $5::boolean THEN NULL
		                    WHEN $4::boolean IS NULL THEN pinned_at
		                    WHEN $4 THEN COALESCE(pinned_at, now()) ELSE NULL END,
		   archived_at = CASE WHEN $5::boolean IS NULL THEN archived_at
		                      WHEN $5 THEN COALESCE(archived_at, now()) ELSE NULL END
		 WHERE id=$1 AND user_id=$2
		 RETURNING `+conversationCols,
		convID, userID, u.Title, u.Pinned, u.Archived))
	if isNoRows(err) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, err
	}
	return c, tx.Commit(ctx)
}

// UnarchiveConversations puts every archived thread of the user's in a
// workspace back in the list.
func (s *Store) UnarchiveConversations(ctx context.Context, userID, wsID string) error {
	return s.archivedConversationsTx(ctx, userID, wsID,
		`UPDATE conversations SET archived_at=NULL
		  WHERE user_id=$1 AND workspace_id IS NOT DISTINCT FROM NULLIF($2,'') AND archived_at IS NOT NULL`)
}

// DeleteArchivedConversations deletes every archived thread of the user's in a
// workspace (messages cascade).
func (s *Store) DeleteArchivedConversations(ctx context.Context, userID, wsID string) error {
	return s.archivedConversationsTx(ctx, userID, wsID,
		`DELETE FROM conversations
		  WHERE user_id=$1 AND workspace_id IS NOT DISTINCT FROM NULLIF($2,'') AND archived_at IS NOT NULL`)
}

func (s *Store) archivedConversationsTx(ctx context.Context, userID, wsID, stmt string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// No workspace: the caller's own account chat, which needs no lock.
	if wsID != "" {
		if err := s.lockWorkspaceChatTx(ctx, tx, wsID, userID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, stmt, userID, wsID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

/* ---------------------------------------------------------------- messages */

// ListMessages returns a conversation's history in chronological order. A
// still-streaming row is a running turn (a crash's are aborted at boot), which
// the browser follows (Epo 2026-10-27, T19). Ownership is enforced against
// userID.
func (s *Store) ListMessages(ctx context.Context, userID, convID string) ([]Message, error) {
	if _, err := s.GetConversation(ctx, userID, convID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, conversation_id, role, content, status, metadata - 'toolEvidence', created_at
		   FROM messages
		  WHERE conversation_id=$1
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
		m.ErrorCode = meta.ErrorCode
		m.ProviderSlug = meta.ProviderSlug
		m.ModelSlug = meta.ModelSlug
		m.ModelVersion = meta.ModelVersion
		m.ModelDisplayName = meta.ModelDisplayName
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, s.refreshUndoStatuses(ctx, out)
}

// AddUserMessage persists an incoming user message and bumps the conversation's
// updated_at so it sorts to the top of the list.
func (s *Store) AddUserMessage(ctx context.Context, userID, convID, content string, workspaceOnly bool) (Message, error) {
	meta, err := json.Marshal(msgMetadata{WorkspaceOnly: &workspaceOnly})
	if err != nil {
		return Message{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	if err := s.lockConversationTx(ctx, tx, userID, convID); err != nil {
		return Message{}, err
	}
	id := uid("m")
	var m Message
	err = tx.QueryRow(ctx,
		`INSERT INTO messages (id, conversation_id, role, content, status, metadata)
		   VALUES ($1,$2,'user',$3,'complete',$4)
		   RETURNING id, conversation_id, role, content, status, created_at`,
		id, convID, content, meta).
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
	if err := s.lockConversationTx(ctx, tx, userID, convID); err != nil {
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
func (s *Store) FinalizeAssistantMessage(ctx context.Context, msgID, content, status string, tokenCount int, citations []Citation, generationID string, activity []ActivityBlock, toolEvidence json.RawMessage, errorCode string) error {
	// Committed mutation receipts are the authority for effects: a lost SSE
	// frame or an early disconnect must not erase a material the turn created.
	ops, err := messageOperationsTx(ctx, s.pool, msgID)
	if err != nil {
		return err
	}
	activity = mergeOperationEffects(activity, ops)
	meta, err := json.Marshal(msgMetadata{Citations: citations, GenerationID: generationID, Activity: activity, ToolEvidence: toolEvidence, ErrorCode: errorCode})
	if err != nil {
		return err
	}
	var tc *int
	if tokenCount > 0 {
		tc = &tokenCount
	}
	_, err = s.pool.Exec(ctx,
		`UPDATE messages SET content=$2, status=$3, token_count=$4,
		        metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
		  WHERE id=$1`,
		msgID, content, status, tc, meta)
	return err
}

// CheckpointAssistantMessage saves a streaming turn's activity and evidence so
// far, so a crash keeps them for AbortOrphanedStreams. A finalized row is left
// alone.
func (s *Store) CheckpointAssistantMessage(ctx context.Context, msgID string, activity []ActivityBlock, toolEvidence json.RawMessage) error {
	meta, err := json.Marshal(msgMetadata{Activity: activity, ToolEvidence: toolEvidence})
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx,
		`UPDATE messages SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
		  WHERE id=$1 AND status='streaming'`,
		msgID, meta)
	return err
}

// AddStoppedTurnCalls adds to a stopped turn's aborted row what came after the
// stop (Epo 2026-10-21): the calls that were still running, as the turn's
// latest activity and evidence merged with the receipts by call id, the
// citations and generation id of a turn that finished as it stopped, and its
// token count. Only an aborted row changes; saved is false when there is none.
func (s *Store) AddStoppedTurnCalls(ctx context.Context, msgID string, activity []ActivityBlock, toolEvidence json.RawMessage, citations []Citation, generationID string, tokenCount int) (saved bool, err error) {
	ops, err := messageOperationsTx(ctx, s.pool, msgID)
	if err != nil {
		return false, err
	}
	meta, err := json.Marshal(msgMetadata{
		Activity: mergeOperationEffects(activity, ops), ToolEvidence: toolEvidence,
		Citations: citations, GenerationID: generationID,
	})
	if err != nil {
		return false, err
	}
	var tc *int
	if tokenCount > 0 {
		tc = &tokenCount
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE messages SET token_count = COALESCE($3, token_count),
		        metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
		  WHERE id=$1 AND status='aborted'`,
		msgID, meta, tc)
	return err == nil && tag.RowsAffected() > 0, err
}

// IsAssistantMessageOf says whether msgID is an assistant row of convID.
func (s *Store) IsAssistantMessageOf(ctx context.Context, convID, msgID string) (bool, error) {
	var found bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages
		WHERE id=$1 AND conversation_id=$2 AND role='assistant')`, msgID, convID).Scan(&found)
	return found, err
}

// ConversationPrompt loads the rolling checkpoint (if any) and every finalized
// historical message after that pin: stopped and failed turns replay like
// finished ones (Epo 2026-10-21), each row with its status. Call this before
// inserting the current user row so the question is not sent twice.
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
		 WHERE conversation_id=$1 AND status <> 'streaming'
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
		m.ToolEvidence = meta.ToolEvidence
		m.WorkspaceOnly = meta.WorkspaceOnly
		history = append(history, m)
	}
	if err := rows.Err(); err != nil {
		return ConversationPrompt{}, err
	}
	out := ConversationPrompt{History: history}
	if throughID != nil {
		out.Checkpoint = &cp
	}
	// The retrieval service marks a turn's evidence officeTools once it read
	// the office_building skill; a checkpoint drops that turn from History.
	err = s.pool.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM messages
		 WHERE conversation_id=$1 AND status <> 'streaming'
		   AND metadata->'toolEvidence'->>'officeTools' = 'true')`, convID).Scan(&out.OfficeTools)
	return out, err
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

// ChatOpenResource is the title of the file or material the learner has open,
// when it is a live item of this workspace. found is false for anything else:
// the open item is context for the turn, and a stale one is simply not sent.
func (s *Store) ChatOpenResource(ctx context.Context, wsID, kind, id string) (title string, found bool, err error) {
	var q string
	switch kind {
	case "file":
		q = `SELECT name FROM files WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL`
	case "material":
		q = `SELECT title FROM materials WHERE id=$1 AND workspace_id=$2 AND trashed_at IS NULL`
	default:
		return "", false, nil
	}
	err = s.pool.QueryRow(ctx, q, id, wsID).Scan(&title)
	if isNoRows(err) {
		return "", false, nil
	}
	return title, err == nil, err
}

// VoiceContext is what voice input sends ahead of a recording so course
// vocabulary comes out right: the workspace's title and its newest sources'
// names, at most limit of them.
func (s *Store) VoiceContext(ctx context.Context, userID, wsID string, limit int) (title string, sources []string, err error) {
	// Account chat has no workspace to name: its context is the caller's own
	// newest files with no workspace or in a workspace they still reach (a
	// workspace they left keeps their uploads, review r1 F4).
	if wsID == "" {
		err = s.pool.QueryRow(ctx, `SELECT ARRAY(
			SELECT f.name FROM files f WHERE f.user_id = $1 AND f.trashed_at IS NULL
			  AND (f.workspace_id IS NULL OR f.workspace_id IN (`+memberWorkspacesSQL("$1")+`))
			ORDER BY f.added_at DESC LIMIT $2)`, userID, limit).Scan(&sources)
		return "", sources, err
	}
	err = s.pool.QueryRow(ctx, `
		SELECT w.name, ARRAY(
		  SELECT f.name FROM files f
		   WHERE f.workspace_id = w.id AND f.trashed_at IS NULL
		   ORDER BY f.added_at DESC LIMIT $2)
		  FROM workspaces w WHERE w.id = $1`, wsID, limit).Scan(&title, &sources)
	if isNoRows(err) {
		return "", nil, ErrNotFound
	}
	return title, sources, err
}
