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

// A person's canvases (Epo 2026-11-09, todo-workspace-canvas-storage.md):
// their own, and the ones they draw in a workspace (any number, Epo
// 2026-11-12), each seen by its owner alone. The browser uploads a saved board
// as the material's `board` editor asset and sends the asset's id here.

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

func (a *api) registerCanvas(api huma.API) {
	const tag = "materials"
	// The account's Canvas page (Epo 2026-11-10) and a workspace's Canvas tab
	// (Epo 2026-11-12): the caller's canvases, a workspace's or all of them.
	reg(api, http.MethodGet, "/api/canvases", "listCanvases", tag,
		"The caller's canvases a page at a time: their own, latest saved first, then their workspaces'; or the ones drawn in a workspace", http.StatusOK, a.listCanvases)
	reg(api, http.MethodPost, "/api/canvases", "createCanvas", tag,
		"Make a canvas of the caller's, in a workspace they are a member of or in none", http.StatusCreated, a.createCanvas)
	reg(api, http.MethodGet, "/api/canvases/{id}", "getCanvas", tag,
		"One of the caller's canvases", http.StatusOK, a.getCanvas)
	reg(api, http.MethodPut, "/api/canvases/{id}", "saveCanvas", tag,
		"Record a save of one of the caller's canvases: its new board asset and images; the server counts the version", http.StatusOK, a.saveCanvas)
}

type canvasListInput struct {
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Cursor      string `query:"cursor" doc:"Opaque cursor from the previous page"`
	WorkspaceID string `query:"workspaceId" maxLength:"64" doc:"Only the canvases drawn in this workspace, latest saved first"`
}

type canvasListOutput struct {
	Body store.CanvasPage
}

func (a *api) listCanvases(ctx context.Context, in *canvasListInput) (*canvasListOutput, error) {
	if in.WorkspaceID != "" {
		if err := a.requireWorkspaceMember(ctx, in.WorkspaceID); err != nil {
			return nil, err
		}
	}
	page, err := a.s.ListCanvases(ctx, userID(ctx), in.WorkspaceID, in.Limit, in.Cursor)
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
		Title       apimodel.MaterialTitle `json:"title" minLength:"1"`
		WorkspaceID string                 `json:"workspaceId,omitempty" maxLength:"64" doc:"The workspace it is drawn in, the caller a member; none for a canvas of their own"`
	}
}

// createCanvas makes a canvas of the caller's: a material they pay for, so a
// frozen account makes none.
func (a *api) createCanvas(ctx context.Context, in *createCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(string(in.Body.Title))
	if title == "" {
		return nil, huma.Error422UnprocessableEntity("a canvas needs a name")
	}
	if in.Body.WorkspaceID != "" {
		if err := a.requireWorkspaceMember(ctx, in.Body.WorkspaceID); err != nil {
			return nil, err
		}
	}
	mt, err := a.s.CreateCanvas(ctx, userID(ctx), title, in.Body.WorkspaceID)
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

// ownCanvas is one of the caller's canvases; one drawn in a workspace while
// they are still a member of it.
func (a *api) ownCanvas(ctx context.Context, id string) (store.Material, error) {
	mt, err := a.s.OwnCanvas(ctx, userID(ctx), id)
	if err != nil {
		return store.Material{}, hErr(err)
	}
	if mt.CanvasWorkspaceID != "" {
		if err := a.requireWorkspaceMember(ctx, mt.CanvasWorkspaceID); err != nil {
			return store.Material{}, err
		}
	}
	return mt, nil
}

func (a *api) getCanvas(ctx context.Context, in *canvasIDInput) (*canvasOutput, error) {
	mt, err := a.ownCanvas(ctx, in.ID)
	if err != nil {
		return nil, err
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
	if _, err := a.ownCanvas(ctx, in.ID); err != nil {
		return nil, err
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

// requireWorkspaceMember: a workspace's canvases are a member's (Epo 2026-11-09); a link or public
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
