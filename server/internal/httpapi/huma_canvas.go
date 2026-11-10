package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
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
	ID            string   `json:"id" doc:"The canvas material"`
	Title         string   `json:"title"`
	Revision      int64    `json:"revision" doc:"The material's revision; a save sends the one it read"`
	BoardAssetID  string   `json:"boardAssetId" doc:"The saved board's editor asset (gzipped Yjs update); empty before the first save"`
	Version       int64    `json:"version" doc:"Counts the saves"`
	ImageAssetIDs []string `json:"imageAssetIds" nullable:"false" doc:"The canvas's images, as image editor assets"`
	// OwnImageAssetIDs is what the browser names from, so its save is never
	// refused for an image deleted elsewhere.
	OwnImageAssetIDs []string  `json:"ownImageAssetIds" nullable:"false" doc:"Every ready image asset of this canvas, one the pruner trashed included: the ids a save may name"`
	UpdatedAt        time.Time `json:"updatedAt"`
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
	// The account's Canvas page (Epo 2026-11-10): every canvas the caller has,
	// and canvases of their own in no workspace, saved as a workspace's is.
	reg(api, http.MethodGet, "/api/canvases", "listCanvases", tag,
		"The caller's canvases a page at a time: their own, latest saved first, then their workspaces'", http.StatusOK, a.listCanvases)
	reg(api, http.MethodPost, "/api/canvases", "createCanvas", tag,
		"Make a canvas of the caller's own, in no workspace", http.StatusCreated, a.createCanvas)
	reg(api, http.MethodGet, "/api/canvases/{id}", "getCanvas", tag,
		"One of the caller's canvases", http.StatusOK, a.getCanvas)
	reg(api, http.MethodPut, "/api/canvases/{id}", "saveCanvas", tag,
		"Record a save of one of the caller's canvases, as a workspace canvas's", http.StatusOK, a.saveCanvas)
}

type canvasListInput struct {
	Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Cursor string `query:"cursor" doc:"Opaque cursor from the previous page"`
}

type canvasListOutput struct {
	Body store.CanvasPage
}

func (a *api) listCanvases(ctx context.Context, in *canvasListInput) (*canvasListOutput, error) {
	page, err := a.s.ListCanvases(ctx, userID(ctx), in.Limit, in.Cursor)
	if err != nil {
		return nil, hErr(err)
	}
	if page.Items == nil {
		page.Items = []store.CanvasListItem{}
	}
	return &canvasListOutput{Body: page}, nil
}

type createCanvasInput struct {
	Body struct {
		Title apimodel.MaterialTitle `json:"title" minLength:"1"`
	}
}

// createCanvas makes a canvas of the caller's own: a material they pay for, so
// a frozen account makes none.
func (a *api) createCanvas(ctx context.Context, in *createCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(string(in.Body.Title))
	if title == "" {
		return nil, huma.Error422UnprocessableEntity("a canvas needs a name")
	}
	mt, err := a.s.CreateCanvas(ctx, userID(ctx), title)
	if err != nil {
		return nil, hErr(err)
	}
	out, err := a.canvasResponse(ctx, mt)
	if err != nil {
		return nil, hErr(err)
	}
	return out, nil
}

type canvasIDInput struct {
	ID string `path:"id" maxLength:"64" doc:"Canvas material id"`
}

func (a *api) getCanvas(ctx context.Context, in *canvasIDInput) (*canvasOutput, error) {
	mt, err := a.s.OwnCanvas(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	out, err := a.canvasResponse(ctx, mt)
	if err != nil {
		return nil, hErr(err)
	}
	return out, nil
}

type saveOwnCanvasInput struct {
	ID   string `path:"id" maxLength:"64" doc:"Canvas material id"`
	Body struct {
		Revision      int64    `json:"revision" minimum:"1" doc:"The revision the browser read; another tab's save since is refused (409)"`
		BoardAssetID  string   `json:"boardAssetId" minLength:"1" maxLength:"64" doc:"The new board asset, uploaded first: a ready board asset of this canvas"`
		ImageAssetIDs []string `json:"imageAssetIds" maxItems:"1000" doc:"The canvas's images now: ready image assets of this canvas"`
	}
}

func (a *api) saveCanvas(ctx context.Context, in *saveOwnCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	// One of the caller's own: a workspace's canvas saves through its workspace.
	if _, err := a.s.OwnCanvas(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return a.recordCanvasSave(ctx, in.ID, in.Body.BoardAssetID, in.Body.ImageAssetIDs, in.Body.Revision)
}

// recordCanvasSave is a save of one of the caller's canvases by its material.
func (a *api) recordCanvasSave(ctx context.Context, materialID, boardAssetID string, images []string, revision int64) (*canvasOutput, error) {
	if images == nil {
		images = []string{}
	}
	saved, err := a.s.SaveWorkspaceCanvas(ctx, userID(ctx), materialID, boardAssetID, images, revision)
	if errors.Is(err, store.ErrConflict) {
		return nil, huma.Error409Conflict("this canvas was saved from another tab; reload to keep drawing")
	}
	if errors.Is(err, materialdoc.ErrInvalid) {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if err != nil {
		return nil, hErr(err)
	}
	out, err := a.canvasResponse(ctx, saved)
	if err != nil {
		return nil, hErr(err)
	}
	return out, nil
}

// requireWorkspaceMember: a canvas is a member's (Epo 2026-11-09); a link or public
// visitor, who has a workspace id but no membership, finds none.
func (a *api) requireWorkspaceMember(ctx context.Context, wsID string) error {
	role, err := a.s.WorkspaceRole(ctx, userID(ctx), wsID)
	if err != nil {
		return hErr(err)
	}
	if role == "" {
		return huma.Error404NotFound("not found")
	}
	return nil
}

func (a *api) canvasResponse(ctx context.Context, mt store.Material) (*canvasOutput, error) {
	board, err := materialdoc.ReadCanvasBoard(mt.Content)
	if err != nil {
		return nil, err
	}
	own, err := a.s.CanvasImageAssets(ctx, mt.ID)
	if err != nil {
		return nil, err
	}
	if own == nil {
		own = []string{}
	}
	return &canvasOutput{Body: canvasBody{
		ID: mt.ID, Title: mt.Title, Revision: mt.Revision, BoardAssetID: board.BoardAssetID, Version: board.Version,
		ImageAssetIDs: board.ImageAssetIDs, OwnImageAssetIDs: own, UpdatedAt: mt.UpdatedAt,
	}}, nil
}

// workspaceCanvas opens the caller's canvas in the workspace, making it on the
// first open. Any member has one; a frozen account opens an existing one but
// makes none (a material it would pay for).
func (a *api) workspaceCanvas(ctx context.Context, in *canvasInput) (*canvasOutput, error) {
	if err := a.requireWorkspaceMember(ctx, in.ID); err != nil {
		return nil, err
	}
	mt, err := a.s.WorkspaceCanvas(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	out, err := a.canvasResponse(ctx, mt)
	if err != nil {
		return nil, hErr(err)
	}
	return out, nil
}

func (a *api) saveWorkspaceCanvas(ctx context.Context, in *saveCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.requireWorkspaceMember(ctx, in.ID); err != nil {
		return nil, err
	}
	mt, err := a.s.WorkspaceCanvas(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.recordCanvasSave(ctx, mt.ID, in.Body.BoardAssetID, in.Body.ImageAssetIDs, in.Body.Revision)
}
