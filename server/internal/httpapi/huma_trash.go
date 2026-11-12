package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
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
type trashPreviewInput struct {
	Kind agenttools.ResourceKind `path:"kind" enum:"source_file,material"`
	ID   string                  `path:"id"`
}
type trashPreviewOutput struct {
	Body apimodel.TrashPreview
}
type operationOutput struct {
	Body apimodel.OperationReceipt
}

func (a *api) registerTrash(api huma.API) {
	const tag = "Trash"
	reg(api, http.MethodGet, "/api/trash", "listTrash", tag, "List trashed files and materials the caller pays for, or a workspace's it owns", http.StatusOK, a.listTrash)
	reg(api, http.MethodPost, "/api/trash/{kind}/{id}/restore", "restoreTrashed", tag, "Restore a trashed file or material", http.StatusOK, a.restoreTrashed)
	reg(api, http.MethodDelete, "/api/trash/{kind}/{id}", "purgeTrashed", tag, "Permanently delete a trashed file or material", http.StatusOK, a.purgeTrashed)
	reg(api, http.MethodGet, "/api/trash/{kind}/{id}/preview", "previewTrashed", tag, "Open a trashed file or material read-only", http.StatusOK, a.previewTrashed)
}

// previewTrashed opens a trashed item read-only for whoever sees its preview
// in a Trash list (Epo 2026-11-12): nothing joins a room or edits, and every
// other read still leaves trashed rows out. A note's embedded quizzes and sets
// stay unreadable, as they are trashed with it.
func (a *api) previewTrashed(ctx context.Context, in *trashPreviewInput) (*trashPreviewOutput, error) {
	actor := userID(ctx)
	if in.Kind == agenttools.KindMaterial {
		mt, err := a.s.TrashedMaterial(ctx, actor, in.ID)
		if err != nil {
			return nil, hErr(err)
		}
		// As getMaterial: edits a room still holds are projected first.
		if a.projectLive(ctx, mt.ID) {
			if mt, err = a.s.TrashedMaterial(ctx, actor, in.ID); err != nil {
				return nil, hErr(err)
			}
		}
		// No role: every capability off, so the app shows it read-only.
		out, err := a.materialResponse(ctx, mt, "", true, false)
		if err != nil {
			return nil, err
		}
		if mt.Kind == "quiz" {
			materialdoc.LearnerQuiz(out.Body.Content)
		}
		// The asset resolve refuses a trashed material's images and audio,
		// so they come signed with it.
		assets, err := a.trashedMaterialAssets(ctx, mt.ID)
		if err != nil {
			return nil, err
		}
		return &trashPreviewOutput{Body: apimodel.TrashPreview{Assets: assets, Material: &out.Body}}, nil
	}
	file, blobPath, err := a.s.TrashedFile(ctx, actor, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if blobPath == "" {
		return nil, huma.Error404NotFound("no content")
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	signed, err := a.blob.PresignGetWithExpiry(ctx, blobPath)
	if err != nil {
		return nil, hErr(err)
	}
	links := apimodel.FileLinks{URL: signed.URL, ExpiresAt: signed.ExpiresAt}
	// A ready PDF is its own citation preview (FileBlobPaths); the file's
	// /preview route answers only untrashed files.
	if file.PreviewURL != nil {
		links.PreviewURL = &signed.URL
		file.PreviewURL = nil
	}
	file.IsPayer = file.PayerID == actor
	body := apimodel.TrashPreview{File: &file, Links: &links}
	// Office files are not opened here (the app shows their thumbnail): their
	// viewer reads a live file's session.
	if store.SourceEditFormat(file.Name, string(file.Kind)) == "text" {
		session, err := a.s.TrashedSourceSession(ctx, file.ID)
		if err != nil {
			return nil, hErr(err)
		}
		if err = a.presignSource(ctx, &session); err != nil {
			return nil, err
		}
		body.Source = &session
	}
	return &trashPreviewOutput{Body: body}, nil
}

// trashedMaterialAssets signs the material's own ready images and audio, by
// asset id.
func (a *api) trashedMaterialAssets(ctx context.Context, materialID string) (map[string]string, error) {
	paths, err := a.s.MaterialAssetPaths(ctx, materialID)
	if err != nil || len(paths) == 0 {
		return nil, hErr(err)
	}
	if a.blob == nil {
		return nil, huma.Error503ServiceUnavailable("blob store not configured")
	}
	urls := make(map[string]string, len(paths))
	for id, path := range paths {
		signed, err := a.blob.PresignGetWithExpiry(ctx, path)
		if err != nil {
			return nil, hErr(err)
		}
		urls[id] = signed.URL
	}
	return urls, nil
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
