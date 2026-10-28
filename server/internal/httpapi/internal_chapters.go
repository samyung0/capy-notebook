package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/samyung0/capy-notebook/server/internal/fieldlimits"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// internalChapterReq is chat's create_chapter call (Epo 2026-10-29), in a
// workspace chat's workspace or a workspace an account chat names. The
// pipeline cuts an over-limit name and says so; here the limit is only checked.
type internalChapterReq struct {
	Scope              string `json:"scope"`
	UserID             string `json:"userId"`
	WorkspaceID        string `json:"workspaceId"`
	AssistantMessageID string `json:"assistantMessageId"`
	ToolCallID         string `json:"toolCallId"`
	Name               string `json:"name"`
}

// internalCreateChapter appends a chapter named as asked or "Chapter (n)",
// with its receipt so a replayed call creates nothing twice. It answers the
// receipt with the chapter's id and name.
func (a *api) internalCreateChapter(w http.ResponseWriter, r *http.Request) {
	var req internalChapterReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	account, ok := a.internalScope(w, r, req.Scope)
	if !ok {
		return
	}
	if req.WorkspaceID == "" || req.AssistantMessageID == "" || req.ToolCallID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "workspaceId, assistantMessageId and toolCallId are required",
		})
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if utf8.RuneCountInString(req.Name) > fieldlimits.ChapterName {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "name over its limit"})
		return
	}
	if !a.internalAccountActor(w, r, req.UserID) {
		return
	}
	ctx := r.Context()
	var convID string
	if account {
		if convID, ok = a.accountConversation(w, r, req.UserID, req.AssistantMessageID); !ok ||
			!a.accountDestination(w, r, req.UserID, req.WorkspaceID) {
			return
		}
	} else if convID, ok = a.workspaceConversation(w, r, req.UserID, req.WorkspaceID, req.AssistantMessageID); !ok {
		return
	} else if err := a.s.AssertWorkspaceEditor(ctx, req.UserID, req.WorkspaceID); err != nil {
		if errors.Is(err, store.ErrForbidden) || errors.Is(err, store.ErrNotFound) {
			permissionRefusal(w)
			return
		}
		a.fail(w, err)
		return
	}
	opID := store.ChatOperationID(req.AssistantMessageID, req.ToolCallID)
	hash, err := store.RequestHash(map[string]any{"workspaceId": req.WorkspaceID, "name": req.Name})
	if err != nil {
		a.fail(w, err)
		return
	}
	op, err := a.s.ReplayAgentOperation(ctx, opID, hash)
	if errors.Is(err, store.ErrNotFound) {
		var created store.AgentOperation
		created, err = a.s.CreateChapterOperation(ctx, req.UserID, req.WorkspaceID, req.Name, store.AgentOperation{
			ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID,
			ConversationID: convID, MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
		})
		op = &created
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	chapterID := store.ChatChapterID(req.AssistantMessageID, req.ToolCallID)
	name, err := a.s.ChapterName(ctx, chapterID)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"operationId": op.ID, "kind": op.Kind, "outcome": op.Outcome,
		"workspaceId": op.WorkspaceID, "chapterId": chapterID, "name": name,
	})
}
