package httpapi

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Account chat's tool calls (Epo 2026-10-27, todo-account-chat.md): a request
// with scope "account" carries no turn workspace. Each target is checked on
// its own (store.AccountDocumentAccess: a workspace role among the caller's
// owned and member workspaces, or owner of a standalone item; edit needs an
// editor's), and what it creates lands in No workspace unless it names a
// workspace the caller edits there.

// internalScope checks the pipeline secret and reads a tool call's scope:
// "account", or a workspace call ("" from a pipeline before account chat, or
// "workspace"); anything else is refused. ok is false once a response has
// been written.
func (a *api) internalScope(w http.ResponseWriter, r *http.Request, scope string) (account, ok bool) {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return false, false
	}
	switch scope {
	case "", string(agenttools.ScopeWorkspace):
		return false, true
	case string(agenttools.ScopeAccount):
		return true, true
	}
	writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "scope is workspace or account"})
	return false, false
}

// internalAccountActor checks the pipeline secret and that the actor may
// still sign in.
func (a *api) internalAccountActor(w http.ResponseWriter, r *http.Request, userID string) bool {
	if !a.pipelineSecretOK(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"message": "unauthorized"})
		return false
	}
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "userId is required"})
		return false
	}
	status, err := a.s.AccountAccess(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return false
	}
	if !status.CanAuthenticate() {
		a.fail(w, status.Err())
		return false
	}
	return true
}

// accountEditRefusal answers an account chat write to an item the actor may
// read but not edit (or no longer edit).
func accountEditRefusal(w http.ResponseWriter) {
	writeJSON(w, http.StatusForbidden, map[string]string{
		"code": "permission_denied", "message": "You do not have permission to edit this, so nothing was changed.",
	})
}

// accountTarget checks an account-scope call's target and returns its
// workspace ("" for a standalone item). A target the actor cannot read is not
// found; with edit, one they cannot edit is refused. ok is false once a
// response has been written.
func (a *api) accountTarget(w http.ResponseWriter, r *http.Request, userID string, target agenttools.ResourceRef, edit bool) (string, bool) {
	if target.Kind != agenttools.KindSourceFile && target.Kind != agenttools.KindMaterial {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "unsupported target kind"})
		return "", false
	}
	rows, err := a.s.AccountDocumentAccess(r.Context(), userID, []agenttools.ResourceRef{target})
	if err != nil {
		a.fail(w, err)
		return "", false
	}
	switch {
	case !rows[0].CanRead:
		a.fail(w, store.ErrNotFound)
		return "", false
	case edit && !rows[0].CanEdit:
		accountEditRefusal(w)
		return "", false
	}
	return rows[0].WorkspaceID, true
}

// accountConversation binds an account-scope write to its assistant message:
// the actor's own account conversation. It returns the conversation id; ok is
// false once a response has been written.
func (a *api) accountConversation(w http.ResponseWriter, r *http.Request, userID, messageID string) (string, bool) {
	convUser, convWS, convID, err := a.s.AssistantMessageContext(r.Context(), messageID)
	if err != nil || convUser != userID || convWS != "" {
		a.fail(w, store.ErrNotFound)
		return "", false
	}
	return convID, true
}

// workspaceConversation binds a workspace-scope write to its assistant
// message: the actor's conversation in that workspace.
func (a *api) workspaceConversation(w http.ResponseWriter, r *http.Request, userID, workspaceID, messageID string) (string, bool) {
	convUser, convWS, convID, err := a.s.AssistantMessageContext(r.Context(), messageID)
	if err != nil || convUser != userID || workspaceID == "" || convWS != workspaceID {
		a.fail(w, store.ErrNotFound)
		return "", false
	}
	return convID, true
}

// accountDestination checks where an account chat creates: No workspace
// (""), or a workspace of the actor's scope they edit. ok is false once a
// response has been written.
func (a *api) accountDestination(w http.ResponseWriter, r *http.Request, userID, workspaceID string) bool {
	if workspaceID == "" {
		return true
	}
	editable, err := a.s.AccountScopeEditable(r.Context(), userID, workspaceID)
	if err != nil {
		a.fail(w, err)
		return false
	}
	if !editable {
		accountEditRefusal(w)
		return false
	}
	return true
}

// resolveAccountSources is resolveSources across the actor's account scope:
// the id of a file or top-level material they can read becomes its name.
func (a *api) resolveAccountSources(ctx context.Context, userID string, sources []string) ([]string, error) {
	names := []string{}
	refs := make([]agenttools.ResourceRef, 0, 2*len(sources))
	for _, source := range sources {
		if source = strings.TrimSpace(source); source != "" {
			refs = append(refs,
				agenttools.ResourceRef{Kind: agenttools.KindSourceFile, ID: source},
				agenttools.ResourceRef{Kind: agenttools.KindMaterial, ID: source})
		}
	}
	rows, err := a.s.AccountDocumentAccess(ctx, userID, refs)
	if err != nil {
		return nil, err
	}
	for i := 0; i < len(rows); i += 2 {
		name := rows[i].ID
		for _, row := range rows[i : i+2] {
			if row.CanRead {
				name = row.Title
			}
		}
		if !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	return names, nil
}

type internalDocumentAccessReq struct {
	ActorUserID string                   `json:"actorUserId"`
	Items       []agenttools.ResourceRef `json:"items"`
}

// internalDocumentAccessMax bounds one access check: a turn's reads and a
// search's results, with room to spare.
const internalDocumentAccessMax = 200

// internalDocumentAccess answers an account chat's access to items before it
// reads them and to label its results: each item's workspace and whether the
// actor may read and edit it, in the order asked.
func (a *api) internalDocumentAccess(w http.ResponseWriter, r *http.Request) {
	var req internalDocumentAccessReq
	if err := decode(r, &req); err != nil {
		a.fail(w, err)
		return
	}
	if !a.internalAccountActor(w, r, req.ActorUserID) {
		return
	}
	if len(req.Items) > internalDocumentAccessMax {
		writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "at most 200 items a call"})
		return
	}
	for _, item := range req.Items {
		if item.Kind != agenttools.KindSourceFile && item.Kind != agenttools.KindMaterial {
			writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "an item is a source_file or a material"})
			return
		}
	}
	rows, err := a.s.AccountDocumentAccess(r.Context(), req.ActorUserID, req.Items)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rows})
}

// accountDocumentItem is a documents/list row of an account chat: the
// workspace row plus where the item lives ("" for No workspace).
type accountDocumentItem struct {
	documentListItem
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName"`
}

// viewOnlyReason is why an account listing's item the actor only views is
// not editable.
const viewOnlyReason = "You can view this but not edit it."

// listAccountDocuments is documents/list for an account chat: the files and
// materials of the actor's workspaces and their own with no workspace.
func (a *api) listAccountDocuments(w http.ResponseWriter, r *http.Request, userID string) {
	docs, err := a.s.AccountDocuments(r.Context(), userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	items := make([]accountDocumentItem, 0, len(docs))
	for _, d := range docs {
		item := documentListItem{Kind: d.Kind, ID: d.ID, Title: d.Title, ChapterID: d.ChapterID}
		if d.Kind == agenttools.KindMaterial {
			item.Format, item.MaterialKind, item.Editable = "plate", d.MaterialKind, true
		} else {
			item = fileListItem(item, d.Title, d.FileKind)
		}
		if item.Editable && !d.CanEdit {
			item.Editable, item.Reason = false, viewOnlyReason
		}
		items = append(items, accountDocumentItem{documentListItem: item, WorkspaceID: d.WorkspaceID, WorkspaceName: d.WorkspaceName})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// refuseAccountWorkspace answers a workspace id on an account call that
// reads or edits: its target names its own place.
func refuseAccountWorkspace(w http.ResponseWriter) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"code": "invalid_input", "message": "an account call names no workspaceId"})
}
