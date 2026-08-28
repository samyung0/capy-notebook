package httpapi

import (
	"errors"
	"net/http"

	"github.com/evonotes/server/internal/store"
)

type providerCallReq struct {
	SessionID        string `json:"sessionId"`
	CallID           string `json:"callId"`
	Kind             string `json:"kind"`
	Purpose          string `json:"purpose"`
	Thinking         string `json:"thinking"`
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	InputTokens      int64  `json:"inputTokens"`
	OutputTokens     int64  `json:"outputTokens"`
	CachedReadTokens int64  `json:"cachedReadTokens"`
	CacheWriteTokens int64  `json:"cacheWriteTokens"`
	ReasoningTokens  int64  `json:"reasoningTokens"`
	CacheAnomaly     string `json:"cacheAnomaly"`
}

func (a *api) internalSettleProviderCall(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req providerCallReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	settlement, err := a.s.SettleProviderCall(r.Context(), req.SessionID, store.ProviderCallUsage{
		CallID:           req.CallID,
		Kind:             req.Kind,
		Purpose:          req.Purpose,
		Thinking:         req.Thinking,
		Provider:         req.Provider,
		Model:            req.Model,
		InputTokens:      req.InputTokens,
		OutputTokens:     req.OutputTokens,
		CachedReadTokens: req.CachedReadTokens,
		CacheWriteTokens: req.CacheWriteTokens,
		ReasoningTokens:  req.ReasoningTokens,
		CacheAnomaly:     req.CacheAnomaly,
	})
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"message": "spend session not found"})
		return
	}
	if errors.Is(err, store.ErrProviderSessionClosed) ||
		errors.Is(err, store.ErrProviderCallConflict) ||
		errors.Is(err, store.ErrTerminalCallNotAllowed) {
		writeJSON(w, http.StatusConflict, map[string]string{"message": err.Error()})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"creditsExhausted":    settlement.CreditsExhausted,
		"terminalCallAllowed": settlement.TerminalCallAllowed,
		"duplicate":           settlement.Duplicate,
	})
}
