package httpapi

import (
	"errors"
	"net/http"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/obs"
)

// Chat and generation read their notes' changes since the last index once
// per turn, and chat resolves a data placeholder to its block's text (Epo
// 2026-10-17). The read is bound to the workspace like index-text: its
// callers authorized the turn. The resolve acts as the turn's user, who must
// be able to read the workspace.

type internalNoteChangesReq struct {
	WorkspaceID string   `json:"workspaceId"`
	MaterialIDs []string `json:"materialIds"`
}

func (a *api) internalNoteChanges(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	var req internalNoteChangesReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if req.WorkspaceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "workspaceId is required"})
		return
	}
	notes, err := a.s.NotePendingChanges(r.Context(), req.WorkspaceID, req.MaterialIDs)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

type internalNoteChangeResolveReq struct {
	WorkspaceID string `json:"workspaceId"`
	UserID      string `json:"userId"`
	MaterialID  string `json:"materialId"`
	BlockID     string `json:"blockId"`
}

func (a *api) internalResolveNoteChange(w http.ResponseWriter, r *http.Request) {
	var req internalNoteChangeResolveReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, false) {
		return
	}
	text, err := a.s.ResolveNoteChange(r.Context(), req.WorkspaceID, req.MaterialID, req.BlockID)
	if errors.Is(err, materialdoc.ErrInvalid) {
		obs.ResponseError(w, err)
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{
			"code": "material_content_unreadable", "message": "material content could not be decoded",
		})
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, text)
}
