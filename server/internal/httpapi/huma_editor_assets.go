package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
)

// The images and audio a caller pays for (M16) list on its Files page
// (listItems), where it may delete any. Uploads and resolve stay on raw chi
// (editor_assets.go).

type editorAssetIDInput struct {
	AssetID string `path:"assetId"`
}

func (a *api) registerEditorAssets(api huma.API) {
	const tag = "Content"
	reg(api, http.MethodDelete, "/api/editor-assets/{assetId}", "deleteEditorAsset", tag, "Delete an image or audio clip the caller pays for in a note it can no longer open", http.StatusNoContent, a.deleteEditorAsset)
}

func (a *api) deleteEditorAsset(ctx context.Context, in *editorAssetIDInput) (*Empty, error) {
	if err := a.s.DeleteEditorAsset(ctx, userID(ctx), in.AssetID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
