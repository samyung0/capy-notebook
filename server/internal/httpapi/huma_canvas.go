package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A member's personal workspace canvas (Epo 2026-11-09,
// todo-workspace-canvas-storage.md): one per member per workspace, seen by
// its owner alone. The route finds or makes it; the browser uploads its saved
// board as the material's `board` editor asset and sends the asset's id here.

type canvasInput struct {
	ID string `path:"id" doc:"Workspace id"`
}

type canvasBody struct {
	ID            string    `json:"id" doc:"The canvas material"`
	Revision      int64     `json:"revision" doc:"The material's revision; a save sends the one it read"`
	BoardAssetID  string    `json:"boardAssetId" doc:"The saved board's editor asset (gzipped Yjs update); empty before the first save"`
	Version       int64     `json:"version" doc:"Counts the saves"`
	ImageAssetIDs []string  `json:"imageAssetIds" nullable:"false" doc:"The canvas's images, as image editor assets"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type canvasOutput struct {
	Body canvasBody
}

type saveCanvasInput struct {
	ID   string `path:"id" doc:"Workspace id"`
	Body struct {
		Revision      int64    `json:"revision" minimum:"1" doc:"The revision the browser read; another tab's save since is refused (409)"`
		BoardAssetID  string   `json:"boardAssetId" minLength:"1" maxLength:"64" doc:"The new board asset, uploaded first: a ready board asset of this canvas"`
		ImageAssetIDs []string `json:"imageAssetIds" maxItems:"1000" doc:"The canvas's images now: ready image assets of this canvas"`
	}
}

func (a *api) registerCanvas(api huma.API) {
	const tag = "materials"
	reg(api, http.MethodGet, "/api/workspaces/{id}/canvas", "workspaceCanvas", tag,
		"The caller's own canvas in the workspace, made on first open", http.StatusOK, a.workspaceCanvas)
	reg(api, http.MethodPut, "/api/workspaces/{id}/canvas", "saveWorkspaceCanvas", tag,
		"Record a save of the caller's canvas: its new board asset and images; the server counts the version", http.StatusOK, a.saveWorkspaceCanvas)
}

func canvasResponse(mt store.Material) (*canvasOutput, error) {
	board, err := materialdoc.ReadCanvasBoard(mt.Content)
	if err != nil {
		return nil, err
	}
	return &canvasOutput{Body: canvasBody{
		ID: mt.ID, Revision: mt.Revision, BoardAssetID: board.BoardAssetID, Version: board.Version,
		ImageAssetIDs: board.ImageAssetIDs, UpdatedAt: mt.UpdatedAt,
	}}, nil
}

// workspaceCanvas opens the caller's canvas in the workspace, making it on the
// first open. Any member has one; a frozen account opens an existing one but
// makes none (a material it would pay for).
func (a *api) workspaceCanvas(ctx context.Context, in *canvasInput) (*canvasOutput, error) {
	if _, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	mt, err := a.s.WorkspaceCanvas(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	out, err := canvasResponse(mt)
	if err != nil {
		return nil, hErr(err)
	}
	return out, nil
}

func (a *api) saveWorkspaceCanvas(ctx context.Context, in *saveCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if _, err := a.s.WorkspaceRole(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	mt, err := a.s.WorkspaceCanvas(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	images := in.Body.ImageAssetIDs
	if images == nil {
		images = []string{}
	}
	saved, err := a.s.SaveWorkspaceCanvas(ctx, userID(ctx), mt.ID, in.Body.BoardAssetID, images, in.Body.Revision)
	if errors.Is(err, store.ErrConflict) {
		return nil, huma.Error409Conflict("this canvas was saved from another tab; reload to keep drawing")
	}
	if err != nil {
		return nil, hErr(err)
	}
	out, err := canvasResponse(saved)
	if err != nil {
		return nil, hErr(err)
	}
	return out, nil
}
