package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
)

func (a *api) internalSourceAuthority(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var operation string
	switch r.URL.Path {
	case "/api/internal/source-changes/resolve":
		operation = "/internal/source-changes/resolve"
	case "/api/internal/source-refresh/publish":
		operation = "/internal/source-refresh/publish"
	default:
		http.NotFound(w, r)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 150<<20))
	if err != nil || !json.Valid(body) {
		http.Error(w, "invalid source operation", http.StatusBadRequest)
		return
	}
	raw, status, err := a.s.SourceAuthority(r.Context(), operation, body)
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
