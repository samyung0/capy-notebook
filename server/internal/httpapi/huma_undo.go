package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

type undoEditInput struct {
	OperationID string `path:"operationId"`
	Body        apimodel.UndoEditReq
}

func (a *api) registerUndo(api huma.API) {
	reg(api, http.MethodPost, "/api/chat/edit-operations/{operationId}/undo", "undoEditOperation", "Chat",
		"Reverse one direct AI edit", http.StatusOK, a.undoEditOperation)
}

// undoEditOperation reverses one chat step: a direct AI edit (in the
// collaboration room that holds it, while it is live), a file the chat
// created (trash), or an earlier Undo (which makes it Redo). Only the
// original chat actor with current edit access may invoke it. The receipt's
// effect carries the next step's ref.
//
// The requests for one step run one at a time, and the work runs to its end
// once started, so a reversed step always gets its receipt: a request whose
// client went away still records it, and any later request for the step (a
// retry, a second click) answers with it.
func (a *api) undoEditOperation(ctx context.Context, in *undoEditInput) (*operationOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	actor := userID(ctx)
	step, err := a.s.UndoStep(ctx, in.OperationID)
	if err != nil {
		return nil, hErr(err)
	}
	if step.ActorUserID != actor {
		return nil, hErr(store.ErrNotFound)
	}
	unlock, err := a.undos.lock(ctx, step.ID)
	if err != nil {
		return nil, hErr(err)
	}
	defer unlock()
	ctx = context.WithoutCancel(ctx)
	// A retried request answers with its receipt, also once the step is used.
	hash, err := store.RequestHash(map[string]any{"action": "undo", "undoOf": in.OperationID})
	if err != nil {
		return nil, hErr(err)
	}
	opID := clientOperationID(ctx, in.Body.RequestID)
	if existing, err := a.s.ReplayAgentOperation(ctx, opID, hash); err == nil {
		return &operationOutput{Body: *existing}, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, trashError(err)
	}
	// A step already reversed answers with that receipt (another request's).
	if existing, err := a.s.UndoReceipt(ctx, step.ID); err == nil {
		return &operationOutput{Body: existing}, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, hErr(err)
	}
	if store.FileStep(step) {
		// A created file's step: the trash and restore paths check access
		// themselves (an editor trashes, the owner restores).
		receipt, err := a.s.UndoFileStep(ctx, actor, step, store.AgentOperation{
			ID: opID, RequestHash: hash, ToolVersion: 1,
			ConversationID: step.ConversationID, MessageID: step.MessageID,
		})
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrTrashExpired) || errors.Is(err, store.ErrUndoUnavailable) {
			return nil, undoUnavailable()
		}
		if err != nil {
			return nil, trashError(err)
		}
		return &operationOutput{Body: receipt}, nil
	}
	// Current edit access on the active resource, not the access the actor
	// held when the edit was made.
	resource := step.Effect.Resource
	switch resource.Kind {
	case agenttools.KindMaterial:
		if err := a.s.AssertMaterialEditor(ctx, actor, resource.ID); err != nil {
			return nil, hErr(store.ErrNotFound)
		}
	case agenttools.KindSourceFile:
		wsID, err := a.s.FileWorkspaceID(ctx, resource.ID)
		if err != nil {
			return nil, hErr(store.ErrNotFound)
		}
		if err := a.s.AssertWorkspaceEditor(ctx, actor, wsID); err != nil {
			return nil, hErr(store.ErrNotFound)
		}
	}
	receipt, err := a.s.UndoDocumentEdit(ctx, actor, step, store.DocumentOperation{
		ID: opID, RequestHash: hash, ToolVersion: 1,
		ConversationID: step.ConversationID, MessageID: step.MessageID,
	})
	if errors.Is(err, store.ErrUndoUnavailable) {
		return nil, undoUnavailable()
	}
	if err != nil {
		return nil, documentHTTPError(err)
	}
	return &operationOutput{Body: receipt}, nil
}

func undoUnavailable() error {
	return &huma.ErrorModel{
		Status: http.StatusConflict,
		Title:  http.StatusText(http.StatusConflict),
		Detail: "this edit can no longer be undone",
		Errors: []*huma.ErrorDetail{{Message: "undo_unavailable"}},
	}
}
