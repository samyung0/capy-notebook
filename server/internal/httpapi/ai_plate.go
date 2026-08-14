package httpapi

import (
	"bufio"
	"bytes"
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

const (
	maxAIRequestBytes = 1 << 20
	maxAIContextBytes = 256 << 10
	maxAIMessageText  = 16 << 10
	maxAIStreamEvent  = 256 << 10
)

type aiError struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"error"`
}

func writeAIError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	var payload aiError
	payload.Error.Code = code
	payload.Error.Message = message
	payload.Error.Retryable = retryable
	writeJSON(w, status, payload)
}

func (a *api) assertPlateEditor(w http.ResponseWriter, r *http.Request, workspaceID string) bool {
	err := a.s.AssertWorkspaceEditor(r.Context(), uid(r), workspaceID)
	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrForbidden):
		writeAIError(w, http.StatusForbidden, "forbidden", "workspace editor access is required", false)
	case errors.Is(err, store.ErrNotFound):
		writeAIError(w, http.StatusNotFound, "not_found", "workspace not found", false)
	default:
		writeAIError(w, http.StatusInternalServerError, "internal_error", "failed to authorize workspace", true)
	}
	return false
}

type platePart struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type plateMessage struct {
	Role  string      `json:"role"`
	Parts []platePart `json:"parts"`
}

type plateContext struct {
	Children  json.RawMessage `json:"children"`
	Selection json.RawMessage `json:"selection,omitempty"`
	ToolName  string          `json:"toolName,omitempty"`
}

type plateCommandReq struct {
	Messages []plateMessage `json:"messages"`
	Context  plateContext   `json:"ctx"`
}

func (req plateCommandReq) validate() error {
	if len(req.Messages) == 0 {
		return errors.New("messages are required")
	}
	if len(req.Messages) > 20 {
		return errors.New("at most 20 messages are allowed")
	}
	if len(req.Context.Children)+len(req.Context.Selection) > maxAIContextBytes {
		return errors.New("editor context is too large")
	}
	if len(req.Context.Children) == 0 || !json.Valid(req.Context.Children) {
		return errors.New("ctx.children must be valid JSON")
	}
	switch req.Context.ToolName {
	case "", "generate", "edit", "comment":
	default:
		return errors.New("ctx.toolName is invalid")
	}
	hasUserText := false
	for _, message := range req.Messages {
		switch message.Role {
		case "user", "assistant", "system":
		default:
			return errors.New("message role is invalid")
		}
		if len(message.Parts) > 32 {
			return errors.New("message has too many parts")
		}
		for _, part := range message.Parts {
			if len(part.Text) > maxAIMessageText {
				return errors.New("message text is too large")
			}
			if message.Role == "user" && part.Type == "text" && strings.TrimSpace(part.Text) != "" {
				hasUserText = true
			}
		}
	}
	if !hasUserText {
		return errors.New("a user text instruction is required")
	}
	return nil
}

func decodeBoundedJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxAIRequestBytes)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain one JSON value")
		}
		return err
	}
	return nil
}

// aiCommand is the Plate/@ai-sdk UI-message stream endpoint. The gateway
// authenticates and scopes the workspace, strips all provider/model choices,
// then relays the internal Python adapter's protocol without buffering.
func (a *api) aiCommand(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertPlateEditor(w, r, wsID) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAIError(w, http.StatusInternalServerError, "streaming_unsupported", "streaming is unsupported", false)
		return
	}

	var req plateCommandReq
	if err := decodeBoundedJSON(w, r, &req); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", "invalid AI request", false)
		return
	}
	if err := req.validate(); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
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
	// apiKey/model/provider fields are never accepted across this trust boundary.
	body := map[string]any{
		"workspaceId":   wsID,
		"messages":      req.Messages,
		"ctx":           req.Context,
		"locale":        a.userLocale(ctx, userID),
		"modelKey":      rates.ModelKey,
		"configVersion": rates.ModelVersion,
	}
	rc, err := a.pipe.PostStream(ctx, "/plate-ai/command", body)
	if err != nil {
		writeAIError(w, http.StatusBadGateway, "ai_unavailable", "AI service is unavailable", true)
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("x-vercel-ai-ui-message-stream", "v1")

	send := func(payload []byte) {
		_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
		flusher.Flush()
	}
	usage, copyErr := copyAIDataStream(ctx, rc, send)
	if copyErr != nil && ctx.Err() == nil {
		event, _ := json.Marshal(map[string]any{
			"type":      "error",
			"errorText": "AI stream failed",
			"data": map[string]any{
				"code":      "upstream_stream_error",
				"retryable": true,
			},
		})
		send(event)
		send([]byte("[DONE]"))
		return
	}
	charge.settle(ctx, usage.events(userID, wsID, store.SurfaceEditor, rates, store.DefaultEmbeddingRates())...)
}

// copyAIDataStream copies only valid data-stream payloads. It drops comments
// and unknown SSE fields, and rejects oversized/malformed events so an internal
// upstream cannot inject arbitrary response framing.
func copyAIDataStream(ctx context.Context, src io.Reader, send func([]byte)) (pipeUsage, error) {
	var usage pipeUsage
	scanner := bufio.NewScanner(src)
	scanner.Buffer(make([]byte, 16<<10), maxAIStreamEvent)
	sawDone := false
	for scanner.Scan() {
		if ctx.Err() != nil {
			return usage, ctx.Err()
		}
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] == ':' || !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		payload := bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
		if bytes.Equal(payload, []byte("[DONE]")) {
			send([]byte("[DONE]"))
			sawDone = true
			continue
		}
		if len(payload) == 0 || !json.Valid(payload) {
			return usage, errors.New("invalid AI stream event")
		}
		var ev struct {
			Type  string    `json:"type"`
			Usage pipeUsage `json:"usage"`
			Data  pipeUsage `json:"data"`
		}
		if json.Unmarshal(payload, &ev) == nil && (ev.Type == "data-usage" || ev.Type == "usage") {
			if !ev.Usage.empty() {
				usage = ev.Usage
			} else if !ev.Data.empty() {
				usage = ev.Data
			}
			continue
		}
		send(bytes.Clone(payload))
	}
	if err := scanner.Err(); err != nil {
		return usage, err
	}
	if ctx.Err() == nil && !sawDone {
		return usage, io.ErrUnexpectedEOF
	}
	return usage, ctx.Err()
}

type plateCopilotReq struct {
	Prompt       string `json:"prompt"`
	Instructions string `json:"instructions,omitempty"`
	System       string `json:"system,omitempty"`
}

func (req plateCopilotReq) validate() error {
	if strings.TrimSpace(req.Prompt) == "" {
		return errors.New("prompt is required")
	}
	if len(req.Prompt) > maxAIMessageText {
		return errors.New("prompt is too large")
	}
	if len(req.Instructions) > 8<<10 || len(req.System) > 8<<10 {
		return errors.New("instructions are too large")
	}
	return nil
}

// aiCopilot implements Plate's short inline completion contract. Cancellation
// propagates through the pipeline client's request context to the provider call.
func (a *api) aiCopilot(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertPlateEditor(w, r, wsID) {
		return
	}
	var req plateCopilotReq
	if err := decodeBoundedJSON(w, r, &req); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", "invalid AI request", false)
		return
	}
	if err := req.validate(); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
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
	raw, err := a.pipe.PostRaw(ctx, "/plate-ai/copilot", map[string]any{
		"workspaceId":   wsID,
		"prompt":        req.Prompt,
		"instructions":  req.Instructions,
		"system":        req.System,
		"modelKey":      rates.ModelKey,
		"configVersion": rates.ModelVersion,
	})
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		writeAIError(w, http.StatusBadGateway, "ai_unavailable", "AI service is unavailable", true)
		return
	}
	if !json.Valid(raw) {
		writeAIError(w, http.StatusBadGateway, "invalid_upstream_response", "AI service returned invalid JSON", true)
		return
	}
	charge.settle(ctx, usageFrom(raw).events(userID, wsID, store.SurfaceEditor, rates, store.DefaultEmbeddingRates())...)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(raw)
}
