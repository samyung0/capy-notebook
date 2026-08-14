package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

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

// pipeChatEvent is one event line emitted by the Python retrieval service's
// /chat/stream (and re-emitted to the browser). Type is one of:
// token | tool | citations | done | error.
//
// tool events are progress only ("searching…", "created a quiz"): the agent's
// tool calls are executed inside the retrieval service, and anything with a
// side effect goes through /api/internal/* so this gateway still owns authz.
type pipeChatEvent struct {
	Type         string           `json:"type"`
	Text         string           `json:"text,omitempty"`
	Tool         string           `json:"tool,omitempty"`
	Detail       string           `json:"detail,omitempty"`
	Citations    []store.Citation `json:"citations,omitempty"`
	TokenCount   int              `json:"tokenCount,omitempty"`
	GenerationID string           `json:"generationId,omitempty"`
	Message      string           `json:"message,omitempty"`
	// Usage arrives on the done event, aggregated across every provider call
	// the turn made. A stream that is aborted mid-answer never reaches done, so
	// its reservation settles at zero and expires — undercharging a user whose
	// answer they never saw is the right side to err on.
	Usage pipeUsage `json:"usage,omitempty"`
}

// chatStream is the main streaming chat endpoint. It persists the user turn,
// reserves an assistant row, relays the Python token stream to the browser over
// SSE while accumulating the answer, and finalizes the assistant row on
// completion or client abort. See ChatFeature.md for the end-to-end flow.
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

	// Concurrency, not rate, is what bounds a chat abuser: one stream can run
	// for minutes and drive an agent loop the whole time, so a request-per-hour
	// budget alone still allows arbitrary parallel spend.
	slot, release := a.limiter.AcquireStream(ctx, userID)
	if !slot {
		w.Header().Set("Retry-After", "10")
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"code":    "too_many_streams",
			"message": "too many chat streams open",
		})
		return
	}
	defer release()

	// Resolve (or open) the conversation first so the reserve estimate can
	// scale by the pinned model. Pinning happens inside CreateConversation.
	conv, err := a.resolveConversation(ctx, userID, wsID, req.ConversationID)
	if err != nil {
		a.fail(w, err)
		return
	}

	llmRates := a.ratesForPin(ctx, conv.ModelKey, conv.ModelVersion)
	charge, err := a.reserveSpend(ctx, userID, wsID, store.SurfaceChat, store.ScaleEstimate(store.EstimateChatMicros, llmRates))
	if err != nil {
		a.fail(w, err)
		return
	}
	defer charge.release(ctx)

	// Persist the user turn, then auto-title a fresh thread from it.
	if _, err := a.s.AddUserMessage(ctx, conv.ID, req.Text); err != nil {
		a.fail(w, err)
		return
	}
	if conv.Title == "" {
		_ = a.s.RenameConversation(ctx, userID, conv.ID, titleFrom(req.Text))
	}

	// Reserve the assistant row so an aborted stream is always tracked.
	assistant, err := a.s.StartAssistantMessage(ctx, conv.ID)
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

	send(map[string]any{"type": "start", "messageId": assistant.ID, "conversationId": conv.ID})

	var (
		builder   strings.Builder
		citations []store.Citation
		genID     string
		tokens    int
		usage     pipeUsage
	)
	onToken := func(t string) {
		builder.WriteString(t)
		send(pipeChatEvent{Type: "token", Text: t})
	}

	streamErr := a.relayChat(ctx, userID, conv, req.Text, onToken, func(ev pipeChatEvent) {
		switch ev.Type {
		case "citations":
			citations = ev.Citations
			send(pipeChatEvent{Type: "citations", Citations: citations})
		case "tool":
			send(pipeChatEvent{Type: "tool", Tool: ev.Tool, Detail: ev.Detail})
		case "done":
			if ev.TokenCount > 0 {
				tokens = ev.TokenCount
			}
			genID = ev.GenerationID
			usage = ev.Usage
		}
	})

	// Persist with a detached context: the request context is already cancelled
	// on a client disconnect, but we still want the partial answer saved.
	saveCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	status := "complete"
	switch {
	case ctx.Err() != nil:
		status = "aborted"
	case streamErr != nil:
		status = "error"
	}
	if tokens == 0 {
		tokens = int(usage.InputTokens + usage.OutputTokens)
	}
	_ = a.s.FinalizeAssistantMessage(saveCtx, assistant.ID, builder.String(), status, tokens, citations, genID)
	charge.settle(saveCtx, usage.events(userID, conv.WorkspaceID, store.SurfaceChat, llmRates, a.embeddingRates(saveCtx))...)

	// Best-effort final event; the client may already be gone on abort.
	if ctx.Err() == nil {
		if streamErr != nil {
			send(pipeChatEvent{Type: "error", Message: streamErr.Error()})
		}
		send(map[string]any{"type": "done", "status": status, "tokenCount": tokens, "generationId": genID})
	}
}

// resolveConversation returns the target conversation, creating one when no id
// was supplied. An explicit id must belong to the user and the same workspace.
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

// relayChat streams the grounded answer from the Python retrieval service,
// invoking onToken for each text chunk and onEvent for citations/done. When the
// pipeline is unavailable it falls back to a streamed placeholder so the UI
// still works end-to-end.
func (a *api) relayChat(ctx context.Context, userID string, conv store.Conversation, query string, onToken func(string), onEvent func(pipeChatEvent)) error {
	if a.pipe == nil {
		a.streamFallback(ctx, query, onToken)
		return nil
	}

	history := a.historyForPrompt(ctx, conv.ID)
	// userId travels with the request so tools with side effects can name the
	// actor when they call back into /api/internal/*; the gateway re-checks the
	// workspace role there rather than trusting the agent.
	body := map[string]any{
		"query": query, "workspaceId": conv.WorkspaceID, "userId": userID,
		"modelKey": conv.ModelKey, "configVersion": conv.ModelVersion,
		"history": history,
		"locale":  a.userLocale(ctx, userID),
	}
	rc, err := a.pipe.PostStream(ctx, "/chat/stream", body)
	if err != nil {
		// Pipeline unreachable: degrade to a placeholder rather than erroring.
		a.streamFallback(ctx, query, onToken)
		return nil
	}
	defer rc.Close()

	reader := bufio.NewReader(rc)
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
				switch ev.Type {
				case "token":
					onToken(ev.Text)
				case "error":
					return errors.New(ev.Message)
				default:
					onEvent(ev)
				}
			}
		}
		if err != nil {
			if err == io.EOF || ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

// historyForPrompt returns prior turns as OpenAI-style role/content pairs.
func (a *api) historyForPrompt(ctx context.Context, convID string) []map[string]string {
	msgs, err := a.s.ConversationHistory(ctx, convID, 20)
	if err != nil {
		return nil
	}
	out := make([]map[string]string, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, map[string]string{"role": m.Role, "content": m.Content})
	}
	return out
}

// streamFallback emits a short placeholder answer word-by-word so the streaming
// UX is exercised even with the pipeline offline.
func (a *api) streamFallback(ctx context.Context, query string, onToken func(string)) {
	text := fmt.Sprintf("Based on your sources, %s relates to the key ideas in your materials. (Pipeline offline — showing a placeholder.)", strings.TrimRight(query, "?"))
	for _, word := range strings.Fields(text) {
		if ctx.Err() != nil {
			return
		}
		onToken(word + " ")
		time.Sleep(35 * time.Millisecond)
	}
}

// titleFrom derives a short conversation title from the first user message.
func titleFrom(text string) string {
	text = strings.TrimSpace(strings.ReplaceAll(text, "\n", " "))
	const max = 60
	if len(text) <= max {
		return text
	}
	return strings.TrimSpace(text[:max]) + "…"
}
