package httpapi

import (
	"net/http"
	"time"
)

// internalStudyProgress serves the chat agent's read_study_progress tool: the
// requester's own progress in the workspace, read-only.
func (a *api) internalStudyProgress(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WorkspaceID string `json:"workspaceId"`
		UserID      string `json:"userId"`
	}
	if err := decodeBoundedJSON(w, r, &req, 4<<10); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "malformed request"})
		return
	}
	if !a.internalDocumentsActor(w, r, req.UserID, req.WorkspaceID, false) {
		return
	}
	// The tool is offered only with progress on; the route holds the same line.
	on, err := a.s.StudyEnabled(r.Context(), req.UserID, req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !on {
		writeJSON(w, http.StatusForbidden, map[string]string{"code": "lifecycle_rejected", "message": "Study progress is off for this user in this workspace."})
		return
	}
	progress, err := a.s.AgentStudyProgress(r.Context(), req.UserID, req.WorkspaceID, time.Now())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, progress)
}
