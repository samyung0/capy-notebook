package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// A person's canvases (Epo 2026-11-09, todo-workspace-canvas-storage.md):
// their own, and the ones they draw in a workspace (any number, Epo
// 2026-11-12), each private to its creator until they share it with that
// workspace (Epo 2026-11-18). The board is drawn in the canvas's collaboration
// room (POST /api/materials/{id}/collaboration-token); these routes list, make,
// read and share the canvas, and rename and delete are the material's routes.

type canvasBody struct {
	ID               string    `json:"id" doc:"The canvas material"`
	Title            string    `json:"title"`
	Revision         int64     `json:"revision" doc:"The material's revision"`
	Version          int64     `json:"version" doc:"The room's stored version at its last projection; 0 before the first"`
	ImageAssetIDs    []string  `json:"imageAssetIds" nullable:"false" doc:"The images on the board at its last projection, as image editor assets"`
	OwnImageAssetIDs []string  `json:"ownImageAssetIds" nullable:"false" doc:"Every ready image asset of this canvas, one the pruner trashed included"`
	WorkspaceID      string    `json:"workspaceId,omitempty" doc:"The workspace it was drawn in; none for a canvas of one's own"`
	Shared           bool      `json:"shared" doc:"Shared with its workspace: the members hold it by their workspace role"`
	Own              bool      `json:"own" doc:"The caller made it"`
	UpdatedAt        time.Time `json:"updatedAt"`
	// What a note's response says of the caller's editing (editingOf), so the
	// page tells why it is read-only as a note's does.
	Role         *store.WorkspaceRole     `json:"role,omitempty" doc:"The caller's role on the canvas: owner (its creator), or their workspace role on another member's shared one; absent on one opened from the Trash"`
	Capabilities store.AccessCapabilities `json:"capabilities"`
	StorageFull  store.StorageFullBy      `json:"storageFull,omitempty" doc:"The canvas is view-only because its payer (its creator) is at its storage limit; self when that is the caller. Editors only"`
	Trash        *store.Trashed           `json:"trash,omitempty" doc:"The canvas is in the Trash, opened read-only from it with every capability off; its board is GET /api/canvases/{id}/board"`
}

// canvasBoardBody is a trashed canvas's stored board (store.TrashedCanvasBoard).
type canvasBoardBody struct {
	Updates [][]byte `json:"updates" nullable:"false" doc:"The board's stored Yjs state as V1 updates, base64, applied in order: the base state, then each update stored after it; empty for a canvas never opened"`
}

type canvasBoardOutput struct {
	Body canvasBoardBody
}

type canvasOutput struct {
	Body canvasBody
}

func (a *api) registerCanvas(api huma.API) {
	const tag = "materials"
	// The account's Canvas page (Epo 2026-11-10) and a workspace's Canvas tab
	// (Epo 2026-11-12): the caller's canvases, or a workspace's.
	reg(api, http.MethodGet, "/api/canvases", "listCanvases", tag,
		"Canvases a page at a time: the caller's own, latest saved first, then the ones they drew in their workspaces; or, for a workspace, the ones they drew there and the other members' shared ones", http.StatusOK, a.listCanvases)
	reg(api, http.MethodPost, "/api/canvases", "createCanvas", tag,
		"Make a private canvas of the caller's, in a workspace they are a member of or in none", http.StatusCreated, a.createCanvas)
	reg(api, http.MethodGet, "/api/canvases/{id}", "getCanvas", tag,
		"A canvas the caller made, or one shared with a workspace they are a member of; or one in the caller's Trash, read-only", http.StatusOK, a.getCanvas)
	// A trashed canvas opens read-only from the Trash as a note or file does
	// (Epo 2026-11-12): from its stored state, joining no room.
	reg(api, http.MethodGet, "/api/canvases/{id}/board", "getTrashedCanvasBoard", tag,
		"The stored board of a canvas in the caller's Trash, to show it read-only; a live canvas's board is its room's", http.StatusOK, a.getTrashedCanvasBoard)
	reg(api, http.MethodPatch, "/api/canvases/{id}", "updateCanvas", tag,
		"Share a canvas with the workspace it was drawn in, or take it back", http.StatusOK, a.updateCanvas)
}

type canvasListInput struct {
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Cursor      string `query:"cursor" doc:"Opaque cursor from the previous page"`
	WorkspaceID string `query:"workspaceId" maxLength:"64" doc:"This workspace's canvases, latest saved first: the caller's and the other members' shared ones"`
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

// createCanvas makes a canvas of the caller's, private to them: a material
// they pay for, so a frozen account makes none.
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
	return a.canvasResponse(ctx, store.Canvas{Material: mt, Role: store.RoleOwner})
}

type canvasIDInput struct {
	ID string `path:"id" maxLength:"64" doc:"Canvas material id"`
}

// getCanvas reads a canvas the caller holds, or else one they may open from
// the Trash (getTrashedMaterial's rule): no role, so every capability is off.
// A trashed one they held otherwise, a member's shared canvas its maker
// trashed, answers 410 `item_deleted` as a trashed material does (Q41), never
// the 404 a lost one answers.
func (a *api) getCanvas(ctx context.Context, in *canvasIDInput) (*canvasOutput, error) {
	canvas, err := a.s.GetCanvas(ctx, userID(ctx), in.ID)
	if errors.Is(err, store.ErrNotFound) {
		trashed, trashErr := a.s.TrashedCanvas(ctx, userID(ctx), in.ID)
		if !errors.Is(trashErr, store.ErrNotFound) {
			canvas, err = trashed, trashErr
		}
	}
	if err != nil {
		live := func() error { _, err := a.s.GetCanvas(ctx, userID(ctx), in.ID); return err }
		if gone := a.deletedError(ctx, agenttools.KindMaterial, in.ID, err, live); gone != nil {
			return nil, gone
		}
		return nil, hErr(err)
	}
	return a.canvasResponse(ctx, canvas)
}

func (a *api) getTrashedCanvasBoard(ctx context.Context, in *canvasIDInput) (*canvasBoardOutput, error) {
	updates, err := a.s.TrashedCanvasBoard(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &canvasBoardOutput{Body: canvasBoardBody{Updates: updates}}, nil
}

type updateCanvasInput struct {
	ID   string `path:"id" maxLength:"64" doc:"Canvas material id"`
	Body struct {
		Shared bool `json:"shared" doc:"Shared with the workspace it was drawn in: the members hold it by their workspace role"`
	}
}

// updateCanvas shares a canvas with its workspace or takes it back. Sharing is
// an edit, so a frozen account does neither; who may is the store's
// (store.SetCanvasShared).
func (a *api) updateCanvas(ctx context.Context, in *updateCanvasInput) (*canvasOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	canvas, err := a.s.SetCanvasShared(ctx, userID(ctx), in.ID, in.Body.Shared)
	if errors.Is(err, materialdoc.ErrInvalid) {
		return nil, huma.Error422UnprocessableEntity(err.Error())
	}
	// The caller holds the canvas, so the refusal says so (hErr would hide it
	// as not found).
	if errors.Is(err, store.ErrForbidden) {
		return nil, huma.Error403Forbidden("not allowed to share this canvas")
	}
	if err != nil {
		return nil, hErr(err)
	}
	return a.canvasResponse(ctx, canvas)
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

func (a *api) canvasResponse(ctx context.Context, canvas store.Canvas) (*canvasOutput, error) {
	board, err := materialdoc.ReadCanvasBoard(canvas.Content)
	if err != nil {
		return nil, hErr(err)
	}
	own, err := a.s.CanvasImageAssets(ctx, canvas.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if own == nil {
		own = []string{}
	}
	// As a note's response (materialResponse, getTrashedMaterial): one opened
	// from the Trash reads as made read-only by its account.
	readOnly, full := true, false
	if canvas.Trash == nil {
		if readOnly, err = a.readOnly(ctx, canvas.OwnerUserID); err != nil {
			return nil, hErr(err)
		}
		if full, err = a.ownerFull(ctx, canvas.OwnerUserID); err != nil {
			return nil, hErr(err)
		}
	}
	capabilities, storageFull := editingOf(canvas.Role, readOnly, full, canvas.OwnerUserID, userID(ctx))
	// A canvas has no members of its own: who holds it is the workspace's.
	capabilities.CanManageMembers = false
	body := canvasBody{
		ID: canvas.ID, Title: canvas.Title, Revision: canvas.Revision, Version: board.Version,
		ImageAssetIDs: board.ImageAssetIDs, OwnImageAssetIDs: own, WorkspaceID: canvas.CanvasWorkspaceID,
		Shared: canvas.Shared, Own: canvas.OwnerUserID == userID(ctx), UpdatedAt: canvas.UpdatedAt,
		Capabilities: capabilities, StorageFull: storageFull, Trash: canvas.Trash,
	}
	if canvas.Role != "" {
		body.Role = &canvas.Role
	}
	return &canvasOutput{Body: body}, nil
}
