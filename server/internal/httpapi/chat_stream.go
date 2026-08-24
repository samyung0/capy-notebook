package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

// chatStreamReq is the browser's request to POST /api/workspaces/{id}/chat/stream.
// There is deliberately no Model field: the pin lives on the conversation row
// and a client-supplied model would override both the user preference and its
// price multiplier.
type chatStreamReq struct {
	ConversationID string `json:"conversationId"`
	Text           string `json:"text"`
}

// pipeChatEvent is one event line from the Python retrieval service.
// Type is one of: phase | block_start | block_delta | block_end | tool_start |
// tool_end | citations | checkpoint | done | error.
type pipeChatEvent struct {
	Type             string                `json:"type"`
	Phase            string                `json:"phase,omitempty"`
	BlockID          string                `json:"blockId,omitempty"`
	Kind             string                `json:"kind,omitempty"`
	Text             string                `json:"text,omitempty"`
	CallID           string                `json:"callId,omitempty"`
	Name             string                `json:"name,omitempty"`
	Detail           string                `json:"detail,omitempty"`
	Status           string                `json:"status,omitempty"`
	Citations        []store.Citation      `json:"citations,omitempty"`
	Version          int                   `json:"version,omitempty"`
	TokenCount       int                   `json:"tokenCount,omitempty"`
	GenerationID     string                `json:"generationId,omitempty"`
	Message          string                `json:"message,omitempty"`
	Code             string                `json:"code,omitempty"`
	Usage            pipeUsage             `json:"usage,omitempty"`
	Activity         []store.ActivityBlock `json:"activity,omitempty"`
	Answer           string                `json:"answer,omitempty"`
	ThroughMessageID string                `json:"throughMessageId,omitempty"`
	Summary          string                `json:"summary,omitempty"`
	SourceRefs       json.RawMessage       `json:"sourceRefs,omitempty"`
	ModelKey         string                `json:"modelKey,omitempty"`
	ModelVersion     int                   `json:"modelVersion,omitempty"`
	EstimatedTokens  int                   `json:"estimatedTokens,omitempty"`
}

// chatStream persists the user turn, reserves an assistant row, relays the
// Python activity stream, and finalizes one assistant row. messages.content
// is the final answer only.
func (a *api) chatStream(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertWS(w, r, wsID) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	var req chatStreamReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.Text == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "text is required"})
		return
	}
	if len(req.Text) > 8000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "text is too long"})
		return
	}

	ctx := r.Context()
	userID := uid(r)

	llm, err := a.resolveLLM(ctx, userID, models.SurfaceChat)
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

	if _, err := a.s.AddUserMessage(ctx, conv.ID, req.Text); err != nil {
		a.fail(w, err)
		return
	}
	if conv.Title == "" {
		_ = a.s.RenameConversation(ctx, userID, conv.ID, titleFrom(req.Text))
	}

	assistant, err := a.s.StartAssistantMessage(ctx, conv.ID, cfg)
	if err != nil {
		a.fail(w, err)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	send := func(v any) {
		b, _ := json.Marshal(v)
		fmt.Fprintf(w, "data: %s\n\n", b)
		flusher.Flush()
	}

	send(map[string]any{
		"type":             "start",
		"messageId":        assistant.ID,
		"conversationId":   conv.ID,
		"modelKey":         cfg.Key,
		"modelVersion":     cfg.Version,
		"modelDisplayName": cfg.DisplayName,
	})

	var (
		currentText strings.Builder
		answer      strings.Builder
		citations   []store.Citation
		activity    []store.ActivityBlock
		genID       string
		tokens      int
		usage       pipeUsage
	)

	streamErr := a.relayChat(ctx, userID, conv, llm, charge.id, req.Text, assistant.ID, prompt, func(ev pipeChatEvent) {
		switch ev.Type {
		case "checkpoint":
			cpCtx, cpCancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := a.s.PersistCheckpoint(cpCtx, conv.ID, store.ConversationCheckpoint{
				ThroughMessageID: ev.ThroughMessageID,
				Summary:          ev.Summary,
				SourceRefs:       ev.SourceRefs,
				ModelKey:         ev.ModelKey,
				ModelVersion:     ev.ModelVersion,
				EstimatedTokens:  ev.EstimatedTokens,
			}); err != nil {
				log.Printf("persist checkpoint conv=%s: %v", conv.ID, err)
			}
			cpCancel()
		case "block_start":
			currentText.Reset()
			send(ev)
		case "block_delta":
			currentText.WriteString(ev.Text)
			send(ev)
		case "block_end":
			if ev.Kind == "answer" {
				answer.Reset()
				answer.WriteString(currentText.String())
			}
			send(ev)
		case "citations":
			citations = ev.Citations
			send(ev)
		case "phase", "tool_start", "tool_end":
			send(ev)
		case "done", "error":
			if !ev.Usage.empty() {
				usage = ev.Usage
			}
			if ev.TokenCount > 0 {
				tokens = ev.TokenCount
			}
			if ev.Type != "done" {
				break
			}
			if ev.Answer != "" {
				answer.Reset()
				answer.WriteString(ev.Answer)
			}
			if len(ev.Activity) > 0 {
				activity = ev.Activity
			}
			genID = ev.GenerationID
		}
	})

	saveCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	status := "complete"
	switch {
	case ctx.Err() != nil:
		status = "aborted"
	case streamErr != nil:
		status = "error"
	}
	if status == "aborted" && answer.Len() == 0 && currentText.Len() > 0 {
		answer.WriteString(currentText.String())
	}
	if tokens == 0 {
		tokens = int(usage.InputTokens + usage.OutputTokens)
	}
	_ = a.s.FinalizeAssistantMessage(saveCtx, assistant.ID, answer.String(), status, tokens, citations, genID, activity)
	charge.settle(saveCtx)

	if ctx.Err() == nil {
		if streamErr != nil {
			if code, msg, ok := llmKeyPayload(streamErr); ok {
				send(pipeChatEvent{Type: "error", Code: code, Message: msg})
			} else if errors.Is(streamErr, errAIUnavailable) {
				send(pipeChatEvent{Type: "error", Code: "ai_unavailable", Message: errAIUnavailable.Error()})
			} else {
				send(pipeChatEvent{Type: "error", Code: "agent_failed", Message: errAgentFailed.Error()})
			}
		}
		send(map[string]any{"type": "done", "status": status, "tokenCount": tokens, "generationId": genID})
	}
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

func (a *api) relayChat(
	ctx context.Context,
	userID string,
	conv store.Conversation,
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
		}
		if len(m.Citations) > 0 {
			row["citations"] = m.Citations
		}
		history = append(history, row)
	}
	body := map[string]any{
		"query":              query,
		"workspaceId":        conv.WorkspaceID,
		"userId":             userID,
		"history":            history,
		"assistantMessageId": assistantID,
		"spendSessionId":     spendSessionID,
		"locale":             a.userLocale(ctx, userID),
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
		return fmt.Errorf("%w: %v", errAIUnavailable, err)
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
					if mapped := keyErrorFromEvent(ev.Code, ev.Message); mapped != nil {
						return mapped
					}
					return errAgentFailed
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
	const max = 60
	if len(text) <= max {
		return text
	}
	return strings.TrimSpace(text[:max]) + "…"
}
