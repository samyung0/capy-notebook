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

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

// completeReq is the browser's request to POST
// /api/workspaces/{id}/complete/stream — a stateless AI completion for the note
// editor (AI menu + Copilot-style continue). Unlike chat it is not persisted.
type completeReq struct {
	Mode    string `json:"mode"` // command | continue
	Prompt  string `json:"prompt,omitempty"`
	Context string `json:"context,omitempty"`
}

// completeStream relays a plain token stream from the Python pipeline's
// /complete/stream to the browser over SSE (data: {type,text}). No DB writes.
func (a *api) completeStream(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertWS(w, r, wsID) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	var req completeReq
	if err := decodeBoundedJSON(w, r, &req); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", "invalid completion request", false)
		return
	}
	if req.Mode != "continue" {
		req.Mode = "command"
	}
	if len(req.Prompt) > maxAIMessageText || len(req.Context) > maxAIContextBytes {
		writeAIError(w, http.StatusBadRequest, "invalid_request", "completion context is too large", false)
		return
	}

	ctx := r.Context()
	userID := uid(r)
	_, rates, err := a.ratesForSurface(ctx, userID, models.SurfaceEditor)
	if err != nil {
		writeAIError(w, http.StatusServiceUnavailable, "ai_unavailable", "AI service is unavailable", true)
		return
	}
	charge, err := a.reserveSpend(ctx, userID, wsID, store.SurfaceEditor, store.ScaleEstimate(store.EstimateEditorMicros, rates))
	if err != nil {
		a.fail(w, err)
		return
	}
	defer charge.release(ctx)

	if a.pipe == nil {
		writeAIError(w, http.StatusServiceUnavailable, "ai_unavailable", "AI service is unavailable", true)
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

	onToken := func(t string) { send(map[string]any{"type": "token", "text": t}) }

	usage, streamErr := a.relayComplete(ctx, userID, wsID, req, rates, onToken)
	if ctx.Err() != nil {
		return
	}
	if streamErr != nil {
		send(map[string]any{
			"type": "error", "code": "ai_unavailable",
			"message": "AI service is unavailable", "retryable": true,
		})
		return
	}
	charge.settle(ctx, usage.events(userID, wsID, store.SurfaceEditor, rates, store.DefaultEmbeddingRates())...)
	send(map[string]any{"type": "done"})
}

// relayComplete streams the completion from the Python service. Provider/model
// configuration is server-owned; browser model fields are intentionally ignored.
func (a *api) relayComplete(ctx context.Context, userID, wsID string, req completeReq, rates store.TokenRates, onToken func(string)) (pipeUsage, error) {
	var usage pipeUsage
	if a.pipe == nil {
		return usage, errors.New("AI service is unavailable")
	}
	body := map[string]any{
		"workspaceId":   wsID,
		"mode":          req.Mode,
		"prompt":        req.Prompt,
		"context":       req.Context,
		"locale":        a.userLocale(ctx, userID),
		"modelKey":      rates.ModelKey,
		"configVersion": rates.ModelVersion,
	}
	rc, err := a.pipe.PostStream(ctx, "/complete/stream", body)
	if err != nil {
		return usage, fmt.Errorf("completion service unavailable: %w", err)
	}
	defer rc.Close()

	reader := bufio.NewReader(rc)
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			if payload, ok := strings.CutPrefix(strings.TrimRight(line, "\r\n"), "data:"); ok {
				payload = strings.TrimSpace(payload)
				if payload != "" {
					var ev pipeChatEvent
					if json.Unmarshal([]byte(payload), &ev) == nil {
						switch ev.Type {
						case "token":
							onToken(ev.Text)
						case "done":
							usage = ev.Usage
						case "error":
							return usage, errors.New(ev.Message)
						}
					}
				}
			}
		}
		if err != nil {
			if err == io.EOF || ctx.Err() != nil {
				return usage, nil
			}
			return usage, err
		}
	}
}
