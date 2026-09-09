package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The chat agent can create study materials mid-conversation. It cannot do that
// by streaming a "material" event back through the SSE relay, because that
// channel is one-directional: the model would be told the quiz exists before Go
// had run the owner's storage quota check, and it would have no material id to
// refer to afterwards. The tool calls in here synchronously instead, so a quota
// rejection reaches the model in time for it to say so.
//
// Authentication is a shared secret rather than a user session. The retrieval
// service is trusted infrastructure — it already holds the same Postgres
// credentials as this process — so the secret only keeps the route off the
// public internet. The trusted context (actor, workspace, assistant message,
// tool call) is verified against the conversation the message belongs to, and
// the workspace-editor check constrains what may be written on whose behalf.
//
// Every committed creation leaves an agent_operations receipt in the same
// transaction. The same call replayed returns that receipt; a lost response is
// reconciled through GET /api/internal/agent-operations/{id}.
type internalMaterialReq struct {
	WorkspaceID        string   `json:"workspaceId"`
	UserID             string   `json:"userId"`
	AssistantMessageID string   `json:"assistantMessageId"`
	ToolCallID         string   `json:"toolCallId"`
	Kind               string   `json:"kind"`
	Title              string   `json:"title"`
	ChapterIDs         []string `json:"chapterIds"`
	FileIDs            []string `json:"fileIds"`

	Questions json.RawMessage `json:"questions"`
	Cards     []struct {
		Front string `json:"front"`
		Back  string `json:"back"`
	} `json:"cards"`
	Content      string `json:"content"`
	TimeLimitMin *int   `json:"timeLimitMin"`
}

// hashPayload is the normalized request identity: everything the model chose.
func (r internalMaterialReq) hashPayload() map[string]any {
	return map[string]any{
		"kind": r.Kind, "title": strings.TrimSpace(r.Title), "questions": r.Questions,
		"cards": r.Cards, "content": r.Content, "timeLimitMin": r.TimeLimitMin,
		"fileIds": r.FileIDs, "chapterIds": r.ChapterIDs,
	}
}

func (a *api) internalCreateMaterial(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}

	var req internalMaterialReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if req.WorkspaceID == "" || req.UserID == "" || req.AssistantMessageID == "" || req.ToolCallID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_input", "message": "workspaceId, userId, assistantMessageId and toolCallId are required",
		})
		return
	}
	switch req.Kind {
	case "quiz", "flashcards", "mindmap", "diagram", "note":
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "unsupported material kind " + req.Kind})
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
	// Bind the callback to the real conversation: the actor and workspace it
	// claims must be the ones this assistant message belongs to. A deleted turn
	// is not valid authorization for a late callback.
	convUser, convWS, convID, err := a.s.AssistantMessageContext(ctx, req.AssistantMessageID)
	if err != nil || convUser != req.UserID || convWS != req.WorkspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	if err := a.s.AssertWorkspaceEditor(ctx, req.UserID, req.WorkspaceID); err != nil {
		a.fail(w, err)
		return
	}

	opID := store.ChatOperationID(req.AssistantMessageID, req.ToolCallID)
	hash, err := store.RequestHash(req.hashPayload())
	if err != nil {
		a.fail(w, err)
		return
	}
	// A committed receipt answers a replay without rerunning mutable admission
	// (scope, quota); a different payload under the same id is a conflict.
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		writeJSON(w, http.StatusOK, existing)
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		a.fail(w, err)
		return
	}

	_, fileNames, chapterNames, err := a.resolveScope(ctx, req.WorkspaceID, &generateOpts{FileIds: req.FileIDs, Chapters: req.ChapterIDs})
	if err != nil {
		if errors.Is(err, errScopeNoIndexedContent) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "scope_has_no_indexed_content", "message": errScopeNoIndexedContent.Error(),
			})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "invalid_scope", "message": "The requested scope is invalid or unavailable.",
		})
		return
	}
	// Do not recheck inference credits here. The provider call that emitted this
	// accepted tool may have exhausted them, and the turn contract requires its
	// already-paid tools to finish. The pipeline secret plus the editor check
	// above authorize the write; storage quota is still enforced by the store.

	ws, err := a.s.GetWorkspaceShared(ctx, req.WorkspaceID)
	if err != nil {
		a.fail(w, err)
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = ws.Name + " " + req.Kind
	}
	title, err = a.s.DisambiguateMaterialTitle(ctx, req.WorkspaceID, title)
	if err != nil {
		a.fail(w, err)
		return
	}
	cards := make([][2]string, 0, len(req.Cards))
	for _, c := range req.Cards {
		cards = append(cards, [2]string{c.Front, c.Back})
	}
	op, err := a.s.CreateMaterialOperation(ctx, store.MaterialDraft{
		ID: store.ChatMaterialID(req.AssistantMessageID, req.ToolCallID), ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, WorkspaceName: ws.Name, Kind: store.MaterialKind(req.Kind), Title: title,
		Questions: req.Questions, TimeLimitMin: req.TimeLimitMin, Cards: cards, Content: req.Content,
		ScopeChapters: chapterNames, ScopeFileNames: fileNames,
	}, store.AgentOperation{
		ID: opID, ToolVersion: 1, RequestHash: hash, ActorUserID: req.UserID,
		WorkspaceID: req.WorkspaceID, ConversationID: convID,
		MessageID: req.AssistantMessageID, CallID: req.ToolCallID,
	})
	if err != nil {
		if errors.Is(err, store.ErrEmptyMaterial) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"code": "invalid_input", "message": "The material has no content.",
			})
			return
		}
		if errors.Is(err, materialdoc.ErrInvalid) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": err.Error()})
			return
		}
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

// internalGetAgentOperation is the reconciliation read for a lost response:
// the recorded receipt, only to the actor and workspace it belongs to.
func (a *api) internalGetAgentOperation(w http.ResponseWriter, r *http.Request) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return
	}
	operationID := chi.URLParam(r, "operationId")
	workspaceID := strings.TrimSpace(r.URL.Query().Get("workspaceId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if operationID == "" || workspaceID == "" || userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "operationId, workspaceId and userId are required"})
		return
	}
	actorStatus, err := a.s.AccountAccess(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !actorStatus.CanAuthenticate() {
		a.fail(w, actorStatus.Err())
		return
	}
	op, err := a.s.GetAgentOperation(r.Context(), operationID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if op.ActorUserID != userID || op.WorkspaceID != workspaceID {
		a.fail(w, store.ErrNotFound)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (a *api) pipelineSecretOK(r *http.Request) bool {
	secret := a.cfg.PipelineSecret
	return secret != "" &&
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Pipeline-Secret")), []byte(secret)) == 1
}
