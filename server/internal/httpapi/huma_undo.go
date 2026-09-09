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

// undoEditOperation reverses exactly one committed direct AI edit. Only the
// original chat actor with current edit access may invoke it; the server
// loads the stored inverse and guards (never a client-authored inverse) and
// the authority refuses the whole Undo when any affected target changed.
func (a *api) undoEditOperation(ctx context.Context, in *undoEditInput) (*operationOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	actor := userID(ctx)
	inv, original, err := a.s.GetEditInverse(ctx, in.OperationID)
	if err != nil {
		return nil, hErr(err)
	}
	if inv.ActorUserID != actor || original.ActorUserID != actor {
		return nil, hErr(store.ErrNotFound)
	}
	if inv.UndoStatus != agenttools.UndoAvailable {
		return nil, undoUnavailable(inv)
	}
	// Current edit access on the active resource, not the access the actor
	// held when the edit was made.
	switch inv.ResourceKind {
	case agenttools.KindMaterial:
		if err := a.s.AssertMaterialEditor(ctx, actor, inv.ResourceID); err != nil {
			return nil, hErr(store.ErrNotFound)
		}
	case agenttools.KindSourceFile:
		wsID, err := a.s.FileWorkspaceID(ctx, inv.ResourceID)
		if err != nil {
			return nil, hErr(store.ErrNotFound)
		}
		if err := a.s.AssertWorkspaceEditor(ctx, actor, wsID); err != nil {
			return nil, hErr(store.ErrNotFound)
		}
	}
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
	receipt, err := a.s.UndoDocumentEdit(ctx, actor, inv, store.DocumentOperation{
		ID: opID, RequestHash: hash, ToolVersion: 1,
		ConversationID: original.ConversationID, MessageID: original.MessageID,
	})
	if err != nil {
		var refusal *store.EditRefusal
		if errors.As(err, &refusal) {
			return nil, &huma.ErrorModel{
				Status: http.StatusConflict,
				Title:  http.StatusText(http.StatusConflict),
				Detail: refusal.Message,
				Errors: []*huma.ErrorDetail{{Message: string(refusal.Code)}},
			}
		}
		if errors.Is(err, store.ErrUndoUnavailable) {
			return nil, undoUnavailable(inv)
		}
		if errors.Is(err, store.ErrAuthorityUnavailable) {
			return nil, huma.Error503ServiceUnavailable("the document authority is unavailable")
		}
		return nil, hErr(err)
	}
	return &operationOutput{Body: receipt}, nil
}

func undoUnavailable(inv store.EditInverse) error {
	detail := "this edit can no longer be undone"
	if inv.UndoStatus == agenttools.UndoUndone {
		detail = "this edit was already undone"
	}
	return &huma.ErrorModel{
		Status: http.StatusConflict,
		Title:  http.StatusText(http.StatusConflict),
		Detail: detail,
		Errors: []*huma.ErrorDetail{{Message: "undo_unavailable"}},
	}
}
