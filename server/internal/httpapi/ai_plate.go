package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/models"
	"github.com/samyung0/capy-notebook/server/internal/obs"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

const maxAIRequestBytes = 16 << 10

// Ghost text sends at most this much text on each side of the caret; the
// editor cuts the text before at a block start below it (Epo 2026-10-28).
const (
	maxGhostContextBytes = 1500
	maxGhostTitleBytes   = 1 << 10
)

// writeAIError answers in the API's error shape, so the browser's ApiError
// reads the code.
func writeAIError(w http.ResponseWriter, status int, code, message string, retryable bool) {
	writeJSON(w, status, map[string]any{"code": code, "message": message, "retryable": retryable})
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

func decodeBoundedJSON(w http.ResponseWriter, r *http.Request, dst any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
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

// ghostTextReq is the text around the caret. The server owns the prompt.
type ghostTextReq struct {
	Title  string `json:"title"`
	Before string `json:"before"`
	After  string `json:"after"`
}

func (req ghostTextReq) validate() error {
	if strings.TrimSpace(req.Before) == "" {
		return errors.New("before is required")
	}
	if len(req.Before) > maxGhostContextBytes || len(req.After) > maxGhostContextBytes {
		return errors.New("context is too large")
	}
	if len(req.Title) > maxGhostTitleBytes {
		return errors.New("title is too large")
	}
	return nil
}

// aiCopilot returns one ghost-text suggestion. It refuses before any spend
// while the user's note AI switch is off. Cancellation propagates through the
// pipeline client's request context to the provider call.
func (a *api) aiCopilot(w http.ResponseWriter, r *http.Request) {
	wsID := id(r)
	if !a.assertPlateEditor(w, r, wsID) {
		return
	}
	var req ghostTextReq
	if err := decodeBoundedJSON(w, r, &req, maxAIRequestBytes); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", "invalid AI request", false)
		return
	}
	if err := req.validate(); err != nil {
		writeAIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	ctx := r.Context()
	userID := uid(r)
	enabled, err := a.s.NoteAIEnabled(ctx, userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !enabled {
		writeAIError(w, http.StatusForbidden, "note_ai_disabled", "note AI is turned off", false)
		return
	}
	ctx, cancelLiveAuthorization := a.liveWorkspaceContext(ctx, userID, wsID)
	defer cancelLiveAuthorization()
	llm, err := a.resolveLLM(ctx, userID, models.SlotEditor)
	if err != nil {
		writeAIError(w, http.StatusServiceUnavailable, "ai_unavailable", "AI service is unavailable", true)
		return
	}
	charge, err := a.beginProviderSession(ctx, userID, wsID, store.SurfaceEditor, llm.Rates, store.TokenRates{}, llm.Thinking)
	if err != nil {
		a.fail(w, err)
		return
	}
	defer charge.release(ctx)

	if a.pipe == nil {
		writeAIError(w, http.StatusServiceUnavailable, "ai_unavailable", "AI service is unavailable", true)
		return
	}
	body := map[string]any{
		"workspaceId":    wsID,
		"title":          req.Title,
		"before":         req.Before,
		"after":          req.After,
		"spendSessionId": charge.id,
	}
	llm.attach(body)
	raw, err := a.pipe.PostRaw(ctx, "/plate-ai/copilot", body)
	if err != nil {
		obs.RecordHTTPError(ctx, err)
		if ctx.Err() != nil {
			return
		}
		var busy *providerBusyError
		if errors.As(pipelineLLMError(err), &busy) {
			obs.RecordHTTPError(ctx, obs.ExpectedError(err))
			w.Header().Set("Retry-After", strconv.Itoa(busy.retryAfter()))
			writeAIError(w, http.StatusServiceUnavailable, "provider_busy", busy.Error(), true)
			return
		}
		writeAIError(w, http.StatusBadGateway, "ai_unavailable", "AI service is unavailable", true)
		return
	}
	if !json.Valid(raw) {
		writeAIError(w, http.StatusBadGateway, "invalid_upstream_response", "AI service returned invalid JSON", true)
		return
	}
	charge.settle(ctx)
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(raw)
}
