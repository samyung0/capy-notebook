package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// Hidden from members (todo-study-tracking.md §7, Epo 2026-11-03): owners and
// editors hide a workspace file or material from the workspace's members, or
// show it again, from the item's menu. The store keeps the rule
// (workspace_item_visible, FileEffectiveRole, materialEffectiveAccess).

type hiddenBody struct {
	Hidden bool `json:"hidden"`
}

type setHiddenInput struct {
	ID   string `path:"id"`
	Body hiddenBody
}

type hiddenOutput struct {
	Body hiddenBody
}

func (a *api) registerHidden(api huma.API) {
	reg(api, http.MethodPut, "/api/files/{id}/hidden", "setFileHidden", "Content",
		"Hide a workspace file from members, or show it again", http.StatusOK, a.setFileHidden)
	reg(api, http.MethodPut, "/api/materials/{id}/hidden", "setMaterialHidden", "Content",
		"Hide a workspace material from members, or show it again", http.StatusOK, a.setMaterialHidden)
}

func (a *api) setFileHidden(ctx context.Context, in *setHiddenInput) (*hiddenOutput, error) {
	return a.setHidden(ctx, agenttools.KindSourceFile, in)
}

func (a *api) setMaterialHidden(ctx context.Context, in *setHiddenInput) (*hiddenOutput, error) {
	return a.setHidden(ctx, agenttools.KindMaterial, in)
}

func (a *api) setHidden(ctx context.Context, kind agenttools.ResourceKind, in *setHiddenInput) (*hiddenOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.s.SetItemHidden(ctx, userID(ctx), kind, in.ID, in.Body.Hidden); err != nil {
		return nil, hErr(err)
	}
	return &hiddenOutput{Body: in.Body}, nil
}
