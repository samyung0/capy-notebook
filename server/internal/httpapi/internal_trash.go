package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Chat trash tools call these wrappers. They bind the callback to the real
// assistant message (see internalCreateMaterial), keep the target inside the
// admitted workspace, and reuse the same store operations as the Files page,
// so an editor may trash but only the current workspace owner lists or
// restores. Permanent deletion is deliberately absent from chat.
type internalTrashReq struct {
	WorkspaceID        string                 `json:"workspaceId"`
	UserID             string                 `json:"userId"`
	AssistantMessageID string                 `json:"assistantMessageId"`
	ToolCallID         string                 `json:"toolCallId"`
	Target             agenttools.ResourceRef `json:"target"`
}

// internalTrashContext performs the shared trusted-context checks and returns
// the conversation id and operation identity, or writes the refusal.
func (a *api) internalTrashContext(w http.ResponseWriter, r *http.Request, req internalTrashReq, action string) (convID, opID, hash string, ok bool) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	if req.WorkspaceID == "" || req.UserID == "" || req.AssistantMessageID == "" || req.ToolCallID == "" ||
		req.Target.ID == "" || (req.Target.Kind != agenttools.KindSourceFile && req.Target.Kind != agenttools.KindMaterial) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "workspaceId, userId, assistantMessageId, toolCallId and a tagged target are required"})
		return
	}
	ctx := r.Context()
	actorStatus, err := a.s.AccountAccess(ctx, req.UserID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !actorStatus.CanAuthenticate() {
		a.fail(w, actorStatus.Err())
		return
	}
	convUser, convWS, conversationID, err := a.s.AssistantMessageContext(ctx, req.AssistantMessageID)
	if err != nil || convUser != req.UserID || convWS != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	hash, err = store.RequestHash(map[string]any{"action": action, "kind": req.Target.Kind, "id": req.Target.ID})
	if err != nil {
		a.fail(w, err)
		return
	}
	return conversationID, store.ChatOperationID(req.AssistantMessageID, req.ToolCallID), hash, true
}

// targetInWorkspace refuses a target that lives outside the admitted workspace
// without disclosing whether it exists. active selects the active or trashed
// view of the row.
func (a *api) targetInWorkspace(r *http.Request, target agenttools.ResourceRef, workspaceID string, active bool) error {
	wsID, err := a.s.ResourceWorkspaceID(r.Context(), target.Kind, target.ID, active)
	if err != nil {
		return err
	}
	if wsID != workspaceID {
		return store.ErrNotFound
	}
	return nil
}

func (a *api) internalTrash(w http.ResponseWriter, r *http.Request) {
	var req internalTrashReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	convID, opID, hash, ok := a.internalTrashContext(w, r, req, "trash")
	if !ok {
		return
	}
	if existing, err := a.s.ReplayAgentOperation(r.Context(), opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return
	}
	if err := a.targetInWorkspace(r, req.Target, req.WorkspaceID, true); err != nil {
		a.fail(w, err)
		return
	}
	op := store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID, WorkspaceID: req.WorkspaceID,
		ConversationID: convID, MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	}
	var result store.AgentOperation
	var err error
	if req.Target.Kind == agenttools.KindSourceFile {
		result, err = a.s.TrashFile(r.Context(), req.UserID, req.Target.ID, op)
	} else {
		result, err = a.s.TrashMaterial(r.Context(), req.UserID, req.Target.ID, "", op)
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *api) internalRestore(w http.ResponseWriter, r *http.Request) {
	var req internalTrashReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	convID, opID, hash, ok := a.internalTrashContext(w, r, req, "restore")
	if !ok {
		return
	}
	ctx := r.Context()
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return
	}
	// Owner-only: the store rechecks current ownership under the workspace
	// lock; this early check keeps the refusal non-disclosing.
	if err := a.s.AssertWorkspaceOwner(ctx, req.UserID, req.WorkspaceID); err != nil {
		a.fail(w, store.ErrNotFound)
		return
	}
	if err := a.targetInWorkspace(r, req.Target, req.WorkspaceID, false); err != nil {
		a.fail(w, err)
		return
	}
	episode, err := a.s.CurrentTrashEpisode(ctx, req.Target.Kind, req.Target.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	result, err := a.s.RestoreTrashed(ctx, req.UserID, req.Target.Kind, req.Target.ID, episode, store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID, WorkspaceID: req.WorkspaceID,
		ConversationID: convID, MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	if err != nil {
		if errors.Is(err, store.ErrTrashExpired) {
			writeJSON(w, http.StatusConflict, map[string]string{"code": "unavailable_target", "message": "This item can no longer be restored."})
			return
		}
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// internalListTrash returns one metadata page of the workspace's trash to its
// current owner. Editors receive the non-disclosing not-found answer.
func (a *api) internalListTrash(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if workspaceID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "workspaceId and userId are required"})
		return
	}
	ctx := r.Context()
	actorStatus, err := a.s.AccountAccess(ctx, userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !actorStatus.CanAuthenticate() {
		a.fail(w, actorStatus.Err())
		return
	}
	if err := a.s.AssertWorkspaceOwner(ctx, userID, workspaceID); err != nil {
		a.fail(w, store.ErrNotFound)
		return
	}
	page, err := a.s.ListTrash(ctx, userID, workspaceID, 100, "")
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}
