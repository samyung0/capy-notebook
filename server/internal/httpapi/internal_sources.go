package httpapi

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/store"
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
	if operation == "/internal/source-changes/resolve" && !a.sourceChangeReader(w, r, body) {
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

// sourceChangeReader checks a resolve in Go before it is forwarded: the actor
// may read the workspace and the file is in it. The collaboration authority
// checks both again, with the checkpoint.
func (a *api) sourceChangeReader(w http.ResponseWriter, r *http.Request, body []byte) bool {
	var req struct {
		WorkspaceID string `json:"workspaceId"`
		UserID      string `json:"userId"`
		FileID      string `json:"fileId"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid source operation", http.StatusBadRequest)
		return false
	}
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, false) {
		return false
	}
	ws, err := a.s.ResourceWorkspaceID(r.Context(), agenttools.KindSourceFile, req.FileID, true)
	if err == nil && ws != req.WorkspaceID {
		err = store.ErrNotFound
	}
	if err != nil {
		a.fail(w, err)
		return false
	}
	return true
}
