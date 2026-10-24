package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// The images and audio a caller pays for (M16), listed on its Files page's
// Embeds tab; those in notes it can no longer open it deletes there. Uploads
// and resolve stay on raw chi (editor_assets.go).

type editorAssetsInput struct {
	Access string `query:"access" enum:"open,lost" doc:"Only media in notes the caller can open, or only those it cannot"`
	Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"40"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}
type editorAssetsOutput struct {
	Body store.EditorAssetPage
}
type editorAssetIDInput struct {
	AssetID string `path:"assetId"`
}

func (a *api) registerEditorAssets(api huma.API) {
	const tag = "Content"
	reg(api, http.MethodGet, "/api/editor-assets", "listEditorAssets", tag, "List the images and audio the caller pays for, each marked when its note can no longer be opened", http.StatusOK, a.listEditorAssets)
	reg(api, http.MethodDelete, "/api/editor-assets/{assetId}", "deleteEditorAsset", tag, "Delete an image or audio clip the caller pays for in a note it can no longer open", http.StatusNoContent, a.deleteEditorAsset)
}

func (a *api) listEditorAssets(ctx context.Context, in *editorAssetsInput) (*editorAssetsOutput, error) {
	page, err := a.s.ListEditorAssets(ctx, userID(ctx), store.EditorAssetAccess(in.Access), in.Limit, in.Cursor)
	if err != nil {
		return nil, hErr(err)
	}
	return &editorAssetsOutput{Body: page}, nil
}

func (a *api) deleteEditorAsset(ctx context.Context, in *editorAssetIDInput) (*Empty, error) {
	if err := a.s.DeleteEditorAsset(ctx, userID(ctx), in.AssetID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
