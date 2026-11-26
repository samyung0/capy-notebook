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
	Kind        string `query:"kind" doc:"Comma-separated kinds: file kinds and block kinds (note, quiz, flashcards, mindmap, diagram, canvas)"`
	Workspaces  string `query:"workspaces" doc:"Comma-separated workspace ids the rows sit in (the Files page's Workspace filter)"`
	Location    string `query:"location" doc:"Comma-separated locations: workspace, standalone"`
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
	reg(api, http.MethodGet, "/api/trash", "listTrash", tag, "List trashed files and materials the caller pays for, or a workspace's it owns", http.StatusOK, a.listTrash)
	reg(api, http.MethodPost, "/api/trash/{kind}/{id}/restore", "restoreTrashed", tag, "Restore a trashed file or material", http.StatusOK, a.restoreTrashed)
	reg(api, http.MethodDelete, "/api/trash/{kind}/{id}", "purgeTrashed", tag, "Permanently delete a trashed file or material", http.StatusOK, a.purgeTrashed)
}

// trashedFile serves a trashed file to its trash readers (TrashedFile) when
// the live read did not find it (denied): the file page opens it read-only
// from the Trash (Epo 2026-11-12). Anyone else still gets denied.
func (a *api) trashedFile(ctx context.Context, id string, denied error) (store.File, string, error) {
	if !errors.Is(denied, store.ErrNotFound) {
		return store.File{}, "", denied
	}
	file, blobPath, err := a.s.TrashedFile(ctx, userID(ctx), id)
	if errors.Is(err, store.ErrNotFound) {
		return store.File{}, "", denied
	}
	file.IsPayer = file.PayerID == userID(ctx)
	return file, blobPath, err
}

// deletedError answers a trashed item to a caller who could read it were it
// not trashed (Epo 2026-11-20, Q41): 410 `item_deleted` with its name and
// kind, so their unsent edits to it are offered for download while edits to
// an item whose access went are dropped. Nil for anyone else and for an item
// already purged, who keep the refusal they had (denied, the non-disclosing
// 404). Asked by the room tokens, which the drafts check reads, and by the
// material and file reads an open page makes after a room refusal.
//
// `live` is the handler's own check again: an item restored between it and
// the deleted check answers 409 to ask again, never the 404 that would drop
// the caller's edits to a live item.
func (a *api) deletedError(ctx context.Context, kind agenttools.ResourceKind, id string, denied error, live func() error) error {
	if !errors.Is(denied, store.ErrNotFound) {
		return nil
	}
	deleted := a.s.DeletedMaterial
	if kind == agenttools.KindSourceFile {
		deleted = a.s.DeletedFile
	}
	item, err := deleted(ctx, userID(ctx), id)
	if errors.Is(err, store.ErrNotFound) {
		if live() == nil {
			return huma.Error409Conflict("the item was restored meanwhile; ask again")
		}
		return nil
	}
	if err != nil {
		return hErr(err)
	}
	return &huma.ErrorModel{
		Status: http.StatusGone,
		Title:  http.StatusText(http.StatusGone),
		Detail: "the item was deleted",
		Errors: []*huma.ErrorDetail{{
			Message: "item_deleted",
			Value:   map[string]any{"kind": item.Kind, "name": item.Name},
		}},
	}
}

// checked is the moment after a handler's access check (accessChecked).
func (a *api) checked(id string) {
	if a.accessChecked != nil {
		a.accessChecked(id)
	}
}

// trashedMaterial is trashedFile for a material, with the edits a room still
// held projected first, as getMaterial does.
func (a *api) trashedMaterial(ctx context.Context, id string, project bool, denied error) (store.Material, error) {
	if !errors.Is(denied, store.ErrNotFound) {
		return store.Material{}, denied
	}
	mt, err := a.s.TrashedMaterial(ctx, userID(ctx), id)
	if errors.Is(err, store.ErrNotFound) {
		return store.Material{}, denied
	}
	if err == nil && project && a.projectLive(ctx, id) {
		mt, err = a.s.TrashedMaterial(ctx, userID(ctx), id)
	}
	return mt, err
}

func (a *api) listTrash(ctx context.Context, in *trashListInput) (*trashPageOutput, error) {
	if in.WorkspaceID != "" {
		if err := a.s.AssertWorkspaceOwner(ctx, userID(ctx), in.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	filter, err := listFilter(in.Kind, in.Workspaces, in.Location)
	if err != nil {
		return nil, err
	}
	page, err := a.s.ListTrash(ctx, userID(ctx), in.WorkspaceID, filter, in.Limit, in.Cursor)
	if err != nil {
		return nil, hErr(err)
	}
	// The listing holds only the caller's own trash; see signFileThumbnails.
	for i := range page.Items {
		if page.Items[i].ThumbnailURL, err = a.thumbnailURL(ctx, page.Items[i].ThumbnailKey); err != nil {
			return nil, hErr(err)
		}
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
