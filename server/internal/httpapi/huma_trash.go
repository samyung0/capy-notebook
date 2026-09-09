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

// Trash routes. Trashing happens through the existing delete routes (files,
// materials, quizzes, flashcards); these routes are the owner-only bin:
// listing, restore and permanent deletion. Ownership and episode checks live
// in the store so the chat wrappers share them.

type trashListInput struct {
	WorkspaceID string `query:"workspaceId" doc:"Limit to one owned workspace; empty spans every owned workspace and standalone materials"`
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Cursor      string `query:"cursor" doc:"Opaque cursor from the previous page"`
}
type trashPageOutput struct {
	Body apimodel.TrashPage
}
type trashTargetInput struct {
	Kind agenttools.ResourceKind `path:"kind" enum:"source_file,material"`
	ID   string                  `path:"id"`
	Body apimodel.TrashActionReq
}
type trashPurgeInput struct {
	Kind      agenttools.ResourceKind `path:"kind" enum:"source_file,material"`
	ID        string                  `path:"id"`
	EpisodeID string                  `query:"episodeId" minLength:"1"`
	RequestID string                  `query:"requestId" minLength:"1" maxLength:"64"`
}
type operationOutput struct {
	Body apimodel.OperationReceipt
}

func (a *api) registerTrash(api huma.API) {
	const tag = "Trash"
	reg(api, http.MethodGet, "/api/trash", "listTrash", tag, "List trashed files and materials the caller owns", http.StatusOK, a.listTrash)
	reg(api, http.MethodPost, "/api/trash/{kind}/{id}/restore", "restoreTrashed", tag, "Restore a trashed file or material", http.StatusOK, a.restoreTrashed)
	reg(api, http.MethodDelete, "/api/trash/{kind}/{id}", "purgeTrashed", tag, "Permanently delete a trashed file or material", http.StatusOK, a.purgeTrashed)
}

func (a *api) listTrash(ctx context.Context, in *trashListInput) (*trashPageOutput, error) {
	if in.WorkspaceID != "" {
		if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	page, err := a.s.ListTrash(ctx, userID(ctx), in.WorkspaceID, in.Limit, in.Cursor)
	if err != nil {
		return nil, hErr(err)
	}
	return &trashPageOutput{Body: page}, nil
}

func trashRequestHash(action string, kind agenttools.ResourceKind, id, episode string) (string, error) {
	return store.RequestHash(map[string]any{"action": action, "kind": kind, "id": id, "episode": episode})
}

func (a *api) restoreTrashed(ctx context.Context, in *trashTargetInput) (*operationOutput, error) {
	hash, err := trashRequestHash("restore", in.Kind, in.ID, in.Body.EpisodeID)
	if err != nil {
		return nil, hErr(err)
	}
	op, err := a.s.RestoreTrashed(ctx, userID(ctx), in.Kind, in.ID, in.Body.EpisodeID, store.AgentOperation{
		ID: clientOperationID(ctx, in.Body.RequestID), RequestHash: hash,
	})
	if err != nil {
		return nil, trashError(err)
	}
	return &operationOutput{Body: op}, nil
}

func (a *api) purgeTrashed(ctx context.Context, in *trashPurgeInput) (*operationOutput, error) {
	hash, err := trashRequestHash("purge", in.Kind, in.ID, in.EpisodeID)
	if err != nil {
		return nil, hErr(err)
	}
	op, err := a.s.PurgeTrashed(ctx, userID(ctx), in.Kind, in.ID, in.EpisodeID, store.AgentOperation{
		ID: clientOperationID(ctx, in.RequestID), RequestHash: hash,
	})
	if err != nil {
		return nil, trashError(err)
	}
	return &operationOutput{Body: op}, nil
}

func trashError(err error) error {
	if errors.Is(err, store.ErrTrashExpired) {
		return &huma.ErrorModel{
			Status: http.StatusConflict,
			Title:  http.StatusText(http.StatusConflict),
			Detail: "this item can no longer be restored",
			Errors: []*huma.ErrorDetail{{Message: "trash_expired"}},
		}
	}
	if errors.Is(err, store.ErrOperationConflict) {
		return &huma.ErrorModel{
			Status: http.StatusConflict,
			Title:  http.StatusText(http.StatusConflict),
			Detail: "this request id was already used with a different request",
			Errors: []*huma.ErrorDetail{{Message: "operation_conflict"}},
		}
	}
	return hErr(err)
}

// trashOperation builds the receipt identity of a browser delete. An absent
// request id means no receipt: a repeated plain DELETE answers 404 because the
// item is already out of the active set.
func trashOperation(ctx context.Context, requestID string, kind agenttools.ResourceKind, id string) (store.AgentOperation, error) {
	if requestID == "" {
		return store.AgentOperation{}, nil
	}
	hash, err := trashRequestHash("trash", kind, id, "")
	if err != nil {
		return store.AgentOperation{}, err
	}
	return store.AgentOperation{ID: clientOperationID(ctx, requestID), RequestHash: hash}, nil
}

// clientOperationID scopes a browser-chosen idempotency key to the acting
// user, so one user's key can never collide with or replay another's. An
// omitted key keeps meaning "no receipt".
func clientOperationID(ctx context.Context, requestID string) string {
	if requestID == "" {
		return ""
	}
	return "req_" + userID(ctx) + ":" + requestID
}
