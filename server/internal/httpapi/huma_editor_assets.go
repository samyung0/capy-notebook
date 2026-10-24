package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Images and audio a caller pays for in other accounts' materials (M16):
// those in materials it can no longer open are listed on its Files page, and
// it deletes them there. Uploads and resolve stay on raw chi
// (editor_assets.go).

type lostEditorAssetsInput struct {
	Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"40"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}
type lostEditorAssetsOutput struct {
	Body store.LostEditorAssetPage
}
type editorAssetIDInput struct {
	AssetID string `path:"assetId"`
}

func (a *api) registerEditorAssets(api huma.API) {
	const tag = "Content"
	reg(api, http.MethodGet, "/api/editor-assets/lost", "listLostEditorAssets", tag, "List the images and audio the caller pays for in materials it can no longer open", http.StatusOK, a.listLostEditorAssets)
	reg(api, http.MethodDelete, "/api/editor-assets/{assetId}", "deleteEditorAsset", tag, "Delete an image or audio clip the caller pays for in another account's material", http.StatusNoContent, a.deleteEditorAsset)
}

func (a *api) listLostEditorAssets(ctx context.Context, in *lostEditorAssetsInput) (*lostEditorAssetsOutput, error) {
	page, err := a.s.ListLostEditorAssets(ctx, userID(ctx), in.Limit, in.Cursor)
	if err != nil {
		return nil, hErr(err)
	}
	return &lostEditorAssetsOutput{Body: page}, nil
}

func (a *api) deleteEditorAsset(ctx context.Context, in *editorAssetIDInput) (*Empty, error) {
	if err := a.s.DeleteEditorAsset(ctx, userID(ctx), in.AssetID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
