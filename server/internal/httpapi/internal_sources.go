package httpapi

import (
	"encoding/json"
	"errors"
	"github.com/samyung0/capy-notebook/server/internal/store"
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

func (a *api) internalSourceCaption(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var input store.SourceCaption
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 150<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		http.Error(w, "invalid source caption", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		http.Error(w, "invalid source caption", http.StatusBadRequest)
		return
	}
	if err := a.s.SaveSourceCaption(r.Context(), input); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeJSON(w, http.StatusConflict, map[string]string{"message": "source change no longer matches"})
			return
		}
		a.fail(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
