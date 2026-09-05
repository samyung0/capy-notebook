package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/copytext"
	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/store"
)

type materialRefsOutput struct {
	Body []apimodel.MaterialRef `nullable:"false"`
}
type materialOutput struct {
	Body apimodel.Material
}
type materialUpdateOutput struct {
	Body apimodel.MaterialUpdateResult
}
type materialIDInput struct {
	ID string `path:"id"`
}
type createMaterialInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateMaterialReq
}
type updateMaterialInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateMaterialReq
}
type updateMaterialSharingInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateStandaloneSharingReq
}

func (a *api) registerMaterials(api huma.API) {
	const tag = "Materials"
	reg(api, http.MethodGet, "/api/workspaces/{id}/materials", "listMaterials", tag, "List study materials", http.StatusOK, a.listMaterials)
	regWithMaxBody(api, http.MethodPost, "/api/workspaces/{id}/materials", "createMaterial", tag, "Create a note material", http.StatusCreated, materialRequestMaxBytes, a.createMaterial)
	reg(api, http.MethodGet, "/api/materials/{id}", "getMaterial", tag, "Get a material", http.StatusOK, a.getMaterial)
	regWithMaxBody(api, http.MethodPatch, "/api/materials/{id}/metadata", "updateMaterial", tag, "Update material metadata", http.StatusOK, materialRequestMaxBytes, a.updateMaterial)
	reg(api, http.MethodPatch, "/api/materials/{id}/sharing", "updateMaterialSharing", tag, "Update standalone material sharing", http.StatusOK, a.updateMaterialSharing)
	reg(api, http.MethodDelete, "/api/materials/{id}", "deleteMaterial", tag, "Delete a material", http.StatusNoContent, a.deleteMaterial)
	a.registerMembership(api)
	a.registerCollaboration(api)
}

// assertMaterialOwner checks direct material ownership. This supports both
// workspace-contained and truly standalone quizzes/flashcardSets.
func (a *api) assertMaterialOwner(ctx context.Context, matID string) error {
	err := a.s.AssertMaterialEditor(ctx, userID(ctx), matID)
	if errors.Is(err, store.ErrForbidden) {
		// Existing quiz/flashcardSet handlers map only not-found; keep unauthorized
		// mutation indistinguishable from a missing private resource.
		return store.ErrNotFound
	}
	return err
}

func materialWithAccess(
	material store.Material,
	role store.WorkspaceRole,
) (apimodel.Material, error) {
	material.IsOwner = role == store.RoleOwner
	material.Capabilities = store.CapabilitiesForRole(role, true)
	if role == "" {
		material.Role = nil
	} else {
		material.Role = &role
	}
	return apimodel.FromMaterial(material)
}

func materialResponse(
	material store.Material,
	role store.WorkspaceRole,
) (*materialOutput, error) {
	body, err := materialWithAccess(material, role)
	if err != nil {
		return nil, materialContentError(err)
	}
	return &materialOutput{Body: body}, nil
}

func (a *api) listMaterials(ctx context.Context, in *workspaceIDInput) (*materialRefsOutput, error) {
	if _, err := a.workspaceRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ListMaterialRefs(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &materialRefsOutput{Body: res}, nil
}

func (a *api) createMaterial(ctx context.Context, in *createMaterialInput) (*materialOutput, error) {
	if err := a.s.AssertWorkspaceEditor(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	ws, err := a.s.GetWorkspaceShared(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	kind := in.Body.Kind
	switch kind {
	case "note", "quiz", "flashcards", "mindmap", "diagram":
	default:
		return nil, huma.Error400BadRequest("unsupported material kind")
	}
	title := in.Body.Title
	if title == "" {
		var err error
		title, err = a.s.DisambiguateMaterialTitle(ctx, in.ID, copytext.T(a.userLocale(ctx, userID(ctx)), copytext.UntitledNote))
		if err != nil {
			return nil, hErr(err)
		}
	}
	content := materialdoc.Empty()
	if in.Body.Content != nil {
		content = *in.Body.Content
	}
	raw, err := materialdoc.Marshal(content)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if err := materialdoc.ValidateKind(raw, string(kind)); err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	res, err := a.s.CreateMaterial(ctx, store.Material{
		CreatedBy:      userID(ctx),
		WorkspaceID:    in.ID,
		WorkspaceName:  ws.Name,
		Kind:           kind,
		Title:          title,
		Content:        raw,
		ScopeChapters:  in.Body.ScopeChapters,
		ScopeFileNames: in.Body.ScopeFileNames,
		Privacy:        "private",
	})
	if err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), res.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(res, role)
}

func (a *api) getMaterial(ctx context.Context, in *materialIDInput) (*materialOutput, error) {
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetMaterial(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(res, role)
}

func (a *api) updateMaterial(
	ctx context.Context,
	in *updateMaterialInput,
) (*materialUpdateOutput, error) {
	// Metadata is size-neutral, so an over-quota account keeps it: renaming and
	// filing are part of how such an account finds what to delete. Content goes
	// through collaboration and sharing has its own fully-writable path.
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	access, err := a.s.AssertMaterialContentEditor(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, collaborationError(err)
	}
	// Metadata is workspace structure, so it needs an editing membership rather
	// than the effective role: a link share can raise someone to editing the
	// document body without letting them retitle, refile, or publish it.
	if !store.RoleCanEdit(access.MemberRole) {
		return nil, collaborationError(store.ErrForbidden)
	}
	if in.Body.Title != nil && in.Body.ExpectedRevision == nil {
		return nil, huma.Error400BadRequest("expectedRevision is required when changing title")
	}
	patch := store.MaterialPatch{
		Title:            in.Body.Title,
		ScopeChapters:    in.Body.ScopeChapters,
		ScopeFileNames:   in.Body.ScopeFileNames,
		ExpectedRevision: in.Body.ExpectedRevision,
		UpdatedBy:        userID(ctx),
	}
	// chapterId: "" unfiles (NULL), a real id files it, omitted leaves it.
	if in.Body.ChapterID != nil {
		if *in.Body.ChapterID == "" {
			var none *string
			patch.ChapterID = &none
		} else {
			cid := *in.Body.ChapterID
			p := &cid
			patch.ChapterID = &p
		}
	}
	res, err := a.s.UpdateMaterial(ctx, in.ID, patch)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return nil, huma.Error409Conflict("material revision is stale")
		}
		if errors.Is(err, materialdoc.ErrInvalid) {
			return nil, huma.Error400BadRequest(err.Error())
		}
		return nil, hErr(err)
	}
	return &materialUpdateOutput{Body: apimodel.MaterialUpdateResult{
		ID:           res.ID,
		Revision:     res.Revision,
		ContentBytes: len(res.Content),
		NodeCount:    res.NodeCount,
		MaxDepth:     res.MaxDepth,
		UpdatedAt:    res.UpdatedAt,
	}}, nil
}

func (a *api) updateMaterialSharing(
	ctx context.Context,
	in *updateMaterialSharingInput,
) (*materialOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	material, err := a.s.UpdateStandaloneMaterialPrivacy(
		ctx, userID(ctx), in.ID, "", in.Body.Privacy,
	)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(material, store.RoleOwner)
}

func (a *api) deleteMaterial(ctx context.Context, in *materialIDInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, collaborationError(err)
	}
	if err := a.s.DeleteMaterial(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
