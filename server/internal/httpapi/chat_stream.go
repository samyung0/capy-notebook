package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// chatStreamReq is the browser's request to POST /api/workspaces/{id}/chat/stream.
// There is deliberately no Model field: the pin lives on the conversation row
// and a client-supplied model would override both the user preference and its
// price multiplier.
type chatStreamReq struct {
	ConversationID string `json:"conversationId"`
	Text           string `json:"text"`
	// WorkspaceOnly is the per-message switch: on, only the workspace's files
	// and materials are sources (Epo 2026-10-24).
	WorkspaceOnly bool `json:"workspaceOnly"`
	// OpenResource is the file or material the learner has open, if any.
	OpenResource *chatOpenResource `json:"openResource"`
}

type chatOpenResource struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

const (
	chatQueryMaxEstimatedTokens = 8192
	chatQueryMaxBytes           = 65_536
)

func estimateChatQueryTokens(text string) int {
	cjk, other := 0, 0
	for _, r := range text {
		switch {
		case r >= 0x3040 && r <= 0x30ff,
			r >= 0x3400 && r <= 0x4dbf,
			r >= 0x4e00 && r <= 0x9fff,
			r >= 0xf900 && r <= 0xfaff,
			r >= 0xac00 && r <= 0xd7af:
			cjk++
		default:
			other++
		}
	}
	return cjk + (other+3)/4
}

func chatQueryTooLong(text string) bool {
	return utf8.RuneCountInString(text) > fieldlimits.ChatMessage ||
		len(text) > chatQueryMaxBytes ||
		estimateChatQueryTokens(text) > chatQueryMaxEstimatedTokens ||
		!utf8.ValidString(text)
}

// pipeChatEvent is one event line from the Python retrieval service.
// Type is one of: phase | block_start | block_delta | block_end | tool_start |
// tool_progress | tool_end | citations | checkpoint | turn_checkpoint |
// pending_sources | done | error.
type pipeChatEvent struct {
	Type              string                      `json:"type"`
	SentryEventID     string                      `json:"sentryEventId,omitempty"`
	FileIDs           []string                    `json:"fileIds,omitempty"`
	Omitted           *bool                       `json:"omitted,omitempty"` // pointer so false survives serialization
	Phase             string                      `json:"phase,omitempty"`
	BlockID           string                      `json:"blockId,omitempty"`
	Kind              string                      `json:"kind,omitempty"`
	Text              string                      `json:"text,omitempty"`
	CallID            string                      `json:"callId,omitempty"`
	Name              string                      `json:"name,omitempty"`
	Detail            string                      `json:"detail,omitempty"`
	Outcome           string                      `json:"outcome,omitempty"`
	ToolError         *agenttools.ToolError       `json:"error,omitempty"`
	Effects           []agenttools.ResourceEffect `json:"effects,omitempty"`
	StartedAt         string                      `json:"startedAt,omitempty"` // tool_start
	EndedAt           string                      `json:"endedAt,omitempty"`   // tool_end
	Applied           *int                        `json:"applied,omitempty"`   // tool_progress; tool_end with commands unapplied
	Total             *int                        `json:"total,omitempty"`     // pointers so 0 survives
	Citations         []store.Citation            `json:"citations,omitempty"`
	Version           int                         `json:"version,omitempty"`
	TokenCount        int                         `json:"tokenCount,omitempty"`
	GenerationID      string                      `json:"generationId,omitempty"`
	Message           string                      `json:"message,omitempty"`
	Code              string                      `json:"code,omitempty"`
	RetryAfterSeconds int                         `json:"retryAfterSeconds,omitempty"`
	Usage             pipeUsage                   `json:"usage,omitempty"`
	Activity          []store.ActivityBlock       `json:"activity,omitempty"`
	ToolEvidence      json.RawMessage             `json:"toolEvidence,omitempty"`
	Answer            string                      `json:"answer,omitempty"`
	ThroughMessageID  string                      `json:"throughMessageId,omitempty"`
	Summary           string                      `json:"summary,omitempty"`
	ProviderSlug      string                      `json:"providerSlug,omitempty"`
	ModelSlug         string                      `json:"modelSlug,omitempty"`
	ModelVersion      int                         `json:"modelVersion,omitempty"`
	EstimatedTokens   int                         `json:"estimatedTokens,omitempty"`
}

// chatStream persists the user turn, reserves an assistant row, relays the
// Python activity stream, and finalizes one assistant row. messages.content
// is the final answer only.
func (a *api) chatStream(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	access, ok := a.assertWSChat(w, r, wsID)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeUnexpected(w, http.StatusInternalServerError)
		return
	}

	var req chatStreamReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if chatQueryTooLong(req.Text) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "query_too_long", "message": "The message is too long. Shorten it and try again.",
		})
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "text is required"})
		return
	}
	// A turn outlives its browser connection, and runs no periodic check:
	// only a stop request or the pipeline's own bounds end it early, and lost
	// permission surfaces through each tool call's own check (Epo 2026-10-21).
	ctx := context.WithoutCancel(r.Context())
	userID := uid(r)

	llm, err := a.resolveLLM(ctx, userID, models.SlotChat)
	if err != nil {
		a.fail(w, err)
		return
	}
	cfg := llm.Cfg

	conv, err := a.resolveConversation(ctx, userID, wsID, req.ConversationID)
	if err != nil {
		a.fail(w, err)
		return
	}
	turn, err := a.chatTurnContext(ctx, userID, conv.WorkspaceID, req)
	if err != nil {
		a.fail(w, err)
		return
	}

	embed, err := a.resolveEmbedding(ctx, conv.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}

	charge, err := a.beginProviderSession(
		ctx,
		userID,
		wsID,
		store.SurfaceChat,
		llm.PaidBy,
		llm.Rates,
		embed.Rates,
		llm.Thinking,
	)
	if err != nil {
		a.fail(w, err)
		return
	}
	defer charge.release(ctx)

	// History must be loaded before the current user row so Python sees the
	// question once, as `query`.
	prompt, err := a.s.ConversationPrompt(ctx, conv.ID)
	if err != nil {
		a.fail(w, err)
		return
	}

	if _, err := a.s.AddUserMessage(ctx, userID, conv.ID, req.Text, req.WorkspaceOnly); err != nil {
		a.fail(w, err)
		return
	}
	if conv.Title == "" {
		_ = a.s.RenameConversation(ctx, userID, conv.ID, titleFrom(req.Text))
	}

	assistant, err := a.s.StartAssistantMessage(ctx, userID, conv.ID, cfg)
	if err != nil {
		a.fail(w, err)
		return
	}

	// The stop request finds the turn here (chat_stop.go) from before the
	// browser learns its id. The pipeline request has its own cancel: a stop
	// that cannot reach the pipeline hangs up on it.
	pipeCtx, cancelPipe := context.WithCancel(ctx)
	defer cancelPipe()
	run := &runningTurn{convID: conv.ID, cancelPipe: cancelPipe}
	a.turns.Store(assistant.ID, run)
	defer a.turns.Delete(assistant.ID)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// The browser reads the events on its own writer: the relay never waits
	// for it, and a browser that left misses the rest of the turn, which goes
	// on. The response closes after the last event is written.
	browser := newBrowserWriter(w, flusher.Flush)
	defer browser.finish()
	send := browser.send

	send(map[string]any{
		"type":             "start",
		"messageId":        assistant.ID,
		"conversationId":   conv.ID,
		"providerSlug":     cfg.ProviderSlug,
		"modelSlug":        cfg.ModelSlug,
		"modelVersion":     cfg.Version,
		"modelDisplayName": cfg.DisplayName(),
	})

	// library.read is granted to any role that can chat, whatever the
	// Workspace only switch says: the pipeline answers the library tools as
	// unavailable while it is on, so the offered tools never change with it.
	// Writing from the library still needs the role's write operations.
	operations := agenttools.OperationsForRole(string(access.role))
	turn.role = string(access.role)
	if access.readOnly || access.full {
		// A frozen actor or owner keeps reading and deleting, not creating,
		// editing or restoring. An owner at its storage limit loses creating
		// and editing; restoring grows nothing.
		operations = slices.DeleteFunc(operations, func(op agenttools.Operation) bool {
			return op == agenttools.OpMaterialCreate || op == agenttools.OpDocumentEdit ||
				(access.readOnly && op == agenttools.OpTrashRestore)
		})
	}
	operations = append(operations, agenttools.OpLibraryRead)

	streamErr := a.relayChat(pipeCtx, userID, operations, conv, turn, llm, charge.id, req.Text, assistant.ID, prompt, func(ev pipeChatEvent) {
		run.mu.Lock()
		forward := run.state.hear(ev)
		activity, toolEvidence := run.state.activity, run.state.toolEvidence
		run.mu.Unlock()
		switch ev.Type {
		case "checkpoint":
			cpCtx, cpCancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := a.s.PersistCheckpoint(cpCtx, conv.ID, store.ConversationCheckpoint{
				ThroughMessageID: ev.ThroughMessageID,
				Summary:          ev.Summary,
				ProviderSlug:     ev.ProviderSlug,
				ModelSlug:        ev.ModelSlug,
				ModelVersion:     ev.ModelVersion,
				EstimatedTokens:  ev.EstimatedTokens,
			}); err != nil {
				log.Printf("persist checkpoint conv=%s: %v", conv.ID, err)
			}
			cpCancel()
		case "turn_checkpoint":
			// Saved on the streaming row so a crash of this process keeps the
			// turn so far too (Epo 2026-10-21).
			cpCtx, cpCancel := obs.Detach(ctx, 5*time.Second)
			if err := a.s.CheckpointAssistantMessage(cpCtx, assistant.ID, activity, toolEvidence); err != nil {
				log.Printf("persist turn checkpoint msg=%s: %v", assistant.ID, err)
			}
			cpCancel()
		case "pending_sources":
			// Viewers never learn that sources have pending edits.
			forward = access.canEdit
			if ev.Omitted != nil && *ev.Omitted {
				a.notifyPendingOverflow(ctx, wsID, ev.FileIDs)
			}
		}
		if forward {
			send(ev)
		}
	})

	saveCtx, cancel := obs.Detach(ctx, 10*time.Second)
	defer cancel()

	status := "complete"
	if streamErr != nil {
		status = "error"
	}
	run.mu.Lock()
	run.finished = true
	stopped := run.stopped
	if stopped {
		status = "aborted"
	}
	saved := run.state.save(status)
	run.mu.Unlock()
	if stopped {
		// The row was saved aborted at the stop; what the calls still running
		// then did is added now (Epo 2026-10-21). A row the stop could not
		// save is still streaming: it is saved aborted now.
		added, err := a.s.AddStoppedTurnCalls(saveCtx, assistant.ID, saved.activity, saved.toolEvidence, saved.citations, saved.genID, saved.tokens)
		switch {
		case err != nil:
			obs.CaptureErr(saveCtx, err, map[string]string{"stage": "chat_stopped_calls"})
		case !added:
			a.finalizeTurn(saveCtx, assistant.ID, status, saved)
		}
	} else {
		a.finalizeTurn(saveCtx, assistant.ID, status, saved)
	}
	charge.settle(saveCtx)

	if stopped {
		return
	}
	if streamErr != nil {
		obs.CaptureErr(ctx, unexpectedChatError(streamErr), map[string]string{"stage": "chat_stream"})
		var eventErr *chatEventError
		if code, msg, ok := llmKeyPayload(streamErr); ok {
			send(pipeChatEvent{Type: "error", Code: code, Message: msg})
		} else if errors.As(streamErr, &eventErr) {
			send(pipeChatEvent{
				Type: "error", Code: eventErr.Code, Message: eventErr.Message,
				RetryAfterSeconds: eventErr.RetryAfterSeconds,
			})
		} else if errors.Is(streamErr, errAIUnavailable) {
			send(pipeChatEvent{Type: "error", Code: "ai_unavailable", Message: errAIUnavailable.Error()})
		} else {
			send(pipeChatEvent{Type: "error", Code: "agent_failed", Message: errAgentFailed.Error()})
		}
	}
	send(map[string]any{"type": "done", "status": status, "tokenCount": saved.tokens, "generationId": saved.genID})
}

// chatTurn is the trusted per-turn context the pipeline receives beside the
// query: the Workspace only switch, the open item as stored (never the browser's
// title), whether study progress is on for the requester here, and their
// study preferences.
type chatTurn struct {
	workspaceOnly bool
	// The requester's workspace role, said on the turn context's open line.
	role             string
	openResource     map[string]string
	studyProgress    bool
	studyPreferences store.StudyPreferences
}

func (a *api) chatTurnContext(ctx context.Context, userID, wsID string, req chatStreamReq) (chatTurn, error) {
	turn := chatTurn{workspaceOnly: req.WorkspaceOnly}
	if o := req.OpenResource; o != nil && o.ID != "" {
		title, found, err := a.s.ChatOpenResource(ctx, wsID, o.Kind, o.ID)
		if err != nil {
			return turn, err
		}
		if found {
			turn.openResource = map[string]string{"id": o.ID, "kind": o.Kind, "title": title}
		}
	}
	on, err := a.s.StudyEnabled(ctx, userID, wsID)
	if err != nil {
		return turn, err
	}
	turn.studyProgress = on
	turn.studyPreferences, err = a.s.StudyPreferencesOf(ctx, userID)
	return turn, err
}

func (a *api) resolveConversation(ctx context.Context, userID, wsID, convID string) (store.Conversation, error) {
	if convID == "" {
		return a.s.CreateConversation(ctx, userID, wsID, "")
	}
	conv, err := a.s.GetConversation(ctx, userID, convID)
	if err != nil {
		return store.Conversation{}, err
	}
	if conv.WorkspaceID != wsID {
		return store.Conversation{}, store.ErrNotFound
	}
	return conv, nil
}

// relayChat forwards one turn to the retrieval service. The trusted context
// (actor, workspace, assistant message, granted resource operations, contract
// version) travels outside model arguments; Python filters the offered tools
// by these operations and every Go mutation rechecks them independently.
func (a *api) relayChat(
	ctx context.Context,
	userID string,
	operations []agenttools.Operation,
	conv store.Conversation,
	turn chatTurn,
	llm resolvedLLM,
	spendSessionID string,
	query, assistantID string,
	prompt store.ConversationPrompt,
	onEvent func(pipeChatEvent),
) error {
	if a.pipe == nil {
		return errAIUnavailable
	}

	history := make([]map[string]any, 0, len(prompt.History))
	for _, m := range prompt.History {
		row := map[string]any{
			"id":      m.ID,
			"role":    m.Role,
			"content": m.Content,
			// aborted and error turns replay marked unfinished (Epo 2026-10-21).
			"status": m.Status,
		}
		if len(m.Citations) > 0 {
			row["citations"] = m.Citations
		}
		if len(m.ToolEvidence) > 0 {
			row["toolEvidence"] = m.ToolEvidence
		}
		if m.WorkspaceOnly != nil {
			row["workspaceOnly"] = *m.WorkspaceOnly
		}
		history = append(history, row)
	}
	body := map[string]any{
		"query":              query,
		"workspaceId":        conv.WorkspaceID,
		"userId":             userID,
		"contractVersion":    agenttools.ContractVersion,
		"operations":         operations,
		"history":            history,
		"assistantMessageId": assistantID,
		"spendSessionId":     spendSessionID,
		"locale":             a.userLocale(ctx, userID),
		"workspaceOnly":      turn.workspaceOnly,
		"openResource":       turn.openResource,
		"role":               turn.role,
		"studyProgress":      turn.studyProgress,
		"studyPreferences":   turn.studyPreferences,
		"officeTools":        prompt.OfficeTools,
	}
	if prompt.Checkpoint != nil {
		body["checkpoint"] = prompt.Checkpoint
	}
	llm.attach(body)
	rc, err := a.pipe.PostStream(ctx, "/chat/stream", body)
	if err != nil {
		if mapped := pipelineLLMError(err); mapped != nil {
			return mapped
		}
		return &aiServiceError{cause: err}
	}
	defer rc.Close()

	reader := bufio.NewReader(rc)
	sawDone := false
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			if payload, ok := strings.CutPrefix(strings.TrimRight(line, "\r\n"), "data:"); ok {
				payload = strings.TrimSpace(payload)
				if payload == "" {
					continue
				}
				var ev pipeChatEvent
				if json.Unmarshal([]byte(payload), &ev) != nil {
					continue
				}
				if ev.Type == "error" {
					onEvent(ev)
					if ev.Code == "provider_busy" || ev.Code == "response_flagged" {
						return &chatEventError{
							Code: ev.Code, Message: ev.Message,
							RetryAfterSeconds: ev.RetryAfterSeconds,
						}
					}
					if mapped := keyErrorFromEvent(ev.Code, ev.Message); mapped != nil {
						return obs.WithEventID(mapped, ev.SentryEventID)
					}
					return obs.WithEventID(errAgentFailed, ev.SentryEventID)
				}
				if ev.Type == "done" {
					sawDone = true
				}
				onEvent(ev)
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if err == io.EOF && sawDone {
				return nil
			}
			if err == io.EOF {
				return io.ErrUnexpectedEOF
			}
			return err
		}
	}
}

func titleFrom(text string) string {
	text = strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	if utf8.RuneCountInString(text) <= fieldlimits.ConversationTitle {
		return text
	}
	return fieldlimits.Clamp(text, fieldlimits.ConversationTitle-1) + "…"
}

// Validation and provider admission failures have a client action, not an incident.
func unexpectedChatError(err error) error {
	if _, _, ok := llmKeyPayload(err); ok {
		return obs.ExpectedError(err)
	}
	var busy *providerBusyError
	var event *chatEventError
	if errors.As(err, &busy) {
		return obs.ExpectedError(err)
	}
	if errors.As(err, &event) && event.Code != "compaction_failed" {
		return obs.ExpectedError(err)
	}
	return err
}
