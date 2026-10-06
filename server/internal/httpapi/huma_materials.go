package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/copytext"
	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
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
type trashMaterialInput struct {
	ID        string `path:"id"`
	RequestID string `query:"requestId" maxLength:"64" doc:"Optional idempotency key for this trash action"`
}
type createMaterialInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateMaterialReq
}
type createStandaloneMaterialInput struct {
	Body apimodel.CreateMaterialReq
}
type materialsListInput struct {
	Kind        string `query:"kind" doc:"Comma-separated kinds: note, quiz, flashcards, mindmap, diagram; empty means note, quiz, flashcards"`
	WorkspaceID string `query:"workspaceId" doc:"Comma-separated workspace ids"`
	Location    string `query:"location" doc:"Comma-separated places the material lives: workspace, embedded, standalone; empty means anywhere"`
	Scope       string `query:"scope" enum:"owned,member" default:"owned" doc:"owned: the caller's workspaces and standalone materials; member: also every workspace they are a member of"`
	Sort        string `query:"sort" enum:"updated,created,title,kind" default:"updated"`
	Dir         string `query:"dir" enum:"asc,desc" default:"desc"`
	Limit       int    `query:"limit" minimum:"1" maximum:"100" default:"40"`
	Cursor      string `query:"cursor" doc:"Opaque cursor from the previous page"`
}
type materialPageOutput struct {
	Body apimodel.MaterialPage
}

// csv splits a comma-separated query value, dropping blanks.
func csv(value string) []string {
	out := []string{}
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

type updateMaterialInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateMaterialReq
}
type createEmbeddedMaterialInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateEmbeddedMaterialReq
}
type adoptEmbeddedMaterialsInput struct {
	ID   string `path:"id"`
	Body apimodel.AdoptEmbeddedMaterialsReq
}
type adoptEmbeddedMaterialsOutput struct {
	Body apimodel.AdoptEmbeddedMaterialsResp
}
type updateMaterialSharingInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateStandaloneSharingReq
}

func (a *api) registerMaterials(api huma.API) {
	const tag = "Materials"
	reg(api, http.MethodGet, "/api/materials", "listOwnedMaterials", tag, "List notes, quizzes and flashcard sets across the caller's owned or member workspaces", http.StatusOK, a.listOwnedMaterials)
	regWithMaxBody(api, http.MethodPost, "/api/materials", "createStandaloneMaterial", tag, "Create a standalone note", http.StatusCreated, materialRequestMaxBytes, a.createStandaloneMaterial)
	reg(api, http.MethodGet, "/api/workspaces/{id}/materials", "listMaterials", tag, "List study materials", http.StatusOK, a.listMaterials)
	regWithMaxBody(api, http.MethodPost, "/api/workspaces/{id}/materials", "createMaterial", tag, "Create a note material", http.StatusCreated, materialRequestMaxBytes, a.createMaterial)
	reg(api, http.MethodGet, "/api/materials/{id}", "getMaterial", tag, "Get a material", http.StatusOK, a.getMaterial)
	regWithMaxBody(api, http.MethodPost, "/api/materials/{id}/embedded", "createEmbeddedMaterial", tag, "Create a quiz or flashcard set embedded in a note", http.StatusCreated, materialRequestMaxBytes, a.createEmbeddedMaterial)
	reg(api, http.MethodPost, "/api/materials/{id}/embedded/adopt", "adoptEmbeddedMaterials", tag, "Make quiz and flashcard blocks pasted into a note the note's own", http.StatusOK, a.adoptEmbeddedMaterials)
	regWithMaxBody(api, http.MethodPatch, "/api/materials/{id}/metadata", "updateMaterial", tag, "Update material metadata", http.StatusOK, materialRequestMaxBytes, a.updateMaterial)
	reg(api, http.MethodPatch, "/api/materials/{id}/sharing", "updateMaterialSharing", tag, "Update standalone material sharing", http.StatusOK, a.updateMaterialSharing)
	reg(api, http.MethodDelete, "/api/materials/{id}", "deleteMaterial", tag, "Move a material to the trash", http.StatusNoContent, a.deleteMaterial)
	a.registerTrash(api)
	a.registerUndo(api)
	a.registerMembership(api)
	a.registerCollaboration(api)
}

// assertMaterialOwner checks material edit authority: the owner of a
// standalone material, or an effective editor of the containing workspace.
func (a *api) assertMaterialOwner(ctx context.Context, matID string) error {
	err := a.s.AssertMaterialEditor(ctx, userID(ctx), matID)
	if errors.Is(err, store.ErrForbidden) {
		// Existing quiz/flashcardSet handlers map only not-found; keep unauthorized
		// mutation indistinguishable from a missing private resource.
		return store.ErrNotFound
	}
	return err
}

// materialResponse renders material for a caller holding role. readOnly (see
// api.readOnly) strips editing where a frozen account makes it read-only, and
// full (see api.ownerFull) strips content editing while the storage owner is
// at its limit.
func materialResponse(
	material store.Material,
	role store.WorkspaceRole,
	readOnly, full bool,
) (*materialOutput, error) {
	material.IsOwner = role == store.RoleOwner
	material.Capabilities = store.CapabilitiesForRole(role, true)
	material.Capabilities.CanEdit = material.Capabilities.CanEdit && !readOnly
	material.Capabilities.CanEditContent = material.Capabilities.CanEdit && !full
	if role == "" {
		material.Role = nil
	} else {
		material.Role = &role
	}
	body, err := apimodel.FromMaterial(material)
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

func (a *api) listOwnedMaterials(ctx context.Context, in *materialsListInput) (*materialPageOutput, error) {
	for _, kind := range csv(in.Kind) {
		switch kind {
		case "note", "quiz", "flashcards", "mindmap", "diagram":
		default:
			return nil, huma.Error400BadRequest("unsupported material kind")
		}
	}
	for _, location := range csv(in.Location) {
		switch location {
		case "workspace", "embedded", "standalone":
		default:
			return nil, huma.Error400BadRequest("unsupported material location")
		}
	}
	page, err := a.s.ListOwnedMaterials(ctx, userID(ctx), store.MaterialListFilter{
		Kinds: csv(in.Kind), WorkspaceIDs: csv(in.WorkspaceID), Locations: csv(in.Location), Member: in.Scope == "member",
		Sort: in.Sort, Ascending: in.Dir == "asc", Limit: in.Limit, Cursor: in.Cursor,
	})
	if err != nil {
		return nil, hErr(err)
	}
	return &materialPageOutput{Body: page}, nil
}

// createStandaloneMaterial creates a note outside any workspace. Standalone
// quizzes and flashcard sets keep their typed creation routes.
func (a *api) createStandaloneMaterial(ctx context.Context, in *createStandaloneMaterialInput) (*materialOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if in.Body.Kind != "note" {
		return nil, huma.Error400BadRequest("unsupported material kind")
	}
	title := string(in.Body.Title)
	if title == "" {
		title = copytext.T(a.userLocale(ctx, userID(ctx)), copytext.UntitledNote)
	}
	content := materialdoc.Empty()
	if in.Body.Content != nil {
		content = *in.Body.Content
	}
	raw, err := materialdoc.Marshal(content)
	if err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	if err := materialdoc.ValidateKind(raw, "note"); err != nil {
		return nil, huma.Error400BadRequest(err.Error())
	}
	res, err := a.s.CreateMaterial(ctx, store.Material{
		CreatedBy: userID(ctx), Kind: "note", Title: title, Content: raw, Privacy: "private",
	})
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(res, store.RoleOwner, false, false)
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
	title := string(in.Body.Title)
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
	return materialResponse(res, role, false, false)
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
	readOnly, err := a.readOnly(ctx, res.OwnerUserID)
	if err != nil {
		return nil, hErr(err)
	}
	full, err := a.ownerFull(ctx, res.OwnerUserID)
	if err != nil {
		return nil, hErr(err)
	}
	out, err := materialResponse(res, role, readOnly, full)
	// The workspace reads a quiz to view it; editing loads GET /api/quizzes/{id}/edit.
	if err == nil && res.Kind == "quiz" {
		materialdoc.LearnerQuiz(out.Body.Content)
	}
	return out, err
}

func (a *api) updateMaterial(
	ctx context.Context,
	in *updateMaterialInput,
) (*materialUpdateOutput, error) {
	// Metadata is an edit, refused for a frozen actor here and for a frozen
	// owner by the store. Content goes through collaboration and sharing has
	// its own path.
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	if err := a.s.AssertMaterialEditor(ctx, userID(ctx), in.ID); err != nil {
		return nil, collaborationError(err)
	}
	patch := store.MaterialPatch{
		Title:          apimodel.Str(in.Body.Title),
		ScopeChapters:  in.Body.ScopeChapters,
		ScopeFileNames: in.Body.ScopeFileNames,
		UpdatedBy:      userID(ctx),
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

// updateMaterialSharing: narrowing is a recovery action a frozen account
// keeps; the store refuses widening.
func (a *api) updateMaterialSharing(
	ctx context.Context,
	in *updateMaterialSharingInput,
) (*materialOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	material, err := a.s.UpdateStandaloneMaterialPrivacy(
		ctx, userID(ctx), in.ID, "", in.Body.Privacy,
	)
	if err != nil {
		return nil, hErr(err)
	}
	readOnly, err := a.readOnly(ctx, material.OwnerUserID)
	if err != nil {
		return nil, hErr(err)
	}
	full, err := a.ownerFull(ctx, material.OwnerUserID)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(material, store.RoleOwner, readOnly, full)
}

// deleteMaterial moves the material into the trash (see deleteFile).
func (a *api) createEmbeddedMaterial(ctx context.Context, in *createEmbeddedMaterialInput) (*materialOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, collaborationError(err)
	}
	if in.Body.Kind != "quiz" && in.Body.Kind != "flashcards" {
		return nil, huma.Error400BadRequest("unsupported embedded material kind")
	}
	cards := make([][2]string, len(in.Body.Cards))
	for i, card := range in.Body.Cards {
		cards[i] = [2]string{card.Front, card.Back}
	}
	mt, err := a.s.CreateEmbeddedMaterial(ctx, userID(ctx), in.ID, store.EmbeddedDraft{
		Kind: in.Body.Kind, Questions: apimodel.EncodeQuestions(in.Body.Questions),
		Cards: cards,
	})
	if err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), mt.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(mt, role, false, false)
}

// adoptEmbeddedMaterials makes the note its own copy of each pasted quiz or
// flashcard block (store.AdoptEmbeddedMaterials). materialId is omitted for a
// source the caller cannot read, so the editor removes that block.
func (a *api) adoptEmbeddedMaterials(ctx context.Context, in *adoptEmbeddedMaterialsInput) (*adoptEmbeddedMaterialsOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, collaborationError(err)
	}
	adopted, err := a.s.AdoptEmbeddedMaterials(ctx, userID(ctx), in.ID, in.Body.MaterialIDs)
	if err != nil {
		return nil, hErr(err)
	}
	out := make([]apimodel.AdoptedEmbeddedMaterial, len(in.Body.MaterialIDs))
	for i, sourceID := range in.Body.MaterialIDs {
		out[i] = apimodel.AdoptedEmbeddedMaterial{SourceID: sourceID, MaterialID: adopted[sourceID]}
	}
	return &adoptEmbeddedMaterialsOutput{Body: apimodel.AdoptEmbeddedMaterialsResp{Materials: out}}, nil
}

func (a *api) deleteMaterial(ctx context.Context, in *trashMaterialInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, collaborationError(err)
	}
	op, err := trashOperation(ctx, in.RequestID, agenttools.KindMaterial, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	if _, err := a.s.TrashMaterial(ctx, userID(ctx), in.ID, "", op); err != nil {
		return nil, trashError(err)
	}
	return &Empty{}, nil
}
