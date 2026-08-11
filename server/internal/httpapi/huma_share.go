package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

/* Sharing & cloning.

Read access follows the privacy model in store/share.go: owners get full
access, link/public resources are readable (and clonable) by any signed-in
user. Clone endpoints deep-copy into the caller's account; a workspace clone
copies the retrieval index in the same transaction as the content, so the copy
is queryable the moment it exists. */

type cloneWorkspaceOutput struct {
	Body apimodel.CloneWorkspaceResp
}
type publicDecksOutput struct {
	Body []apimodel.PublicDeck `nullable:"false"`
}
type updateDeckInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateDeckReq
}

func (a *api) registerShare(api huma.API) {
	const tag = "Sharing"
	reg(api, http.MethodPost, "/api/workspaces/{id}/clone", "cloneWorkspace", tag, "Clone a shared workspace", http.StatusCreated, a.cloneWorkspace)
	reg(api, http.MethodPost, "/api/quizzes/{id}/clone", "cloneQuiz", tag, "Clone a shared quiz", http.StatusCreated, a.cloneQuiz)
	reg(api, http.MethodPost, "/api/decks/{id}/clone", "cloneDeck", tag, "Clone a shared deck", http.StatusCreated, a.cloneDeck)
	reg(api, http.MethodPost, "/api/materials/{id}/clone", "cloneMaterial", tag, "Clone a shared material", http.StatusCreated, a.cloneMaterial)
	reg(api, http.MethodPatch, "/api/decks/{id}", "updateDeck", tag, "Update a deck (rename / recolor / share)", http.StatusOK, a.updateDeck)
	reg(api, http.MethodGet, "/api/explore/decks", "exploreDecks", "Explore", "Public flashcard decks", http.StatusOK, a.exploreDecks)
}

/* ----------------------------------------------------------- access helpers */

// workspaceRead allows owners and link/public viewers; returns isOwner.
func (a *api) workspaceRead(ctx context.Context, wsID string) (bool, error) {
	return a.s.WorkspaceAccess(ctx, userID(ctx), wsID)
}

// materialRead allows owners and viewers of shared materials (or materials in
// shared workspaces); returns isOwner.
func (a *api) materialRead(ctx context.Context, matID string) (bool, error) {
	return a.s.MaterialAccess(ctx, userID(ctx), matID)
}

// fileRead resolves a file's workspace and applies workspaceRead.
func (a *api) fileRead(ctx context.Context, fileID string) (bool, error) {
	wsID, err := a.s.FileWorkspaceID(ctx, fileID)
	if err != nil {
		return false, err
	}
	return a.workspaceRead(ctx, wsID)
}

// Resource-editor helpers gate writes addressed by a child id.
func (a *api) assertChapterEditor(ctx context.Context, chapterID string) error {
	wsID, err := a.s.ChapterWorkspaceID(ctx, chapterID)
	if err != nil {
		return err
	}
	return a.assertWorkspaceEditor(ctx, wsID)
}

func (a *api) assertFileEditor(ctx context.Context, fileID string) error {
	wsID, err := a.s.FileWorkspaceID(ctx, fileID)
	if err != nil {
		return err
	}
	return a.assertWorkspaceEditor(ctx, wsID)
}

func (a *api) assertCardEditor(ctx context.Context, cardID string) error {
	matID, err := a.s.CardMaterialID(ctx, cardID)
	if err != nil {
		return err
	}
	return a.assertMaterialOwner(ctx, matID)
}

/* ------------------------------------------------------------------ cloning */

func (a *api) cloneWorkspace(ctx context.Context, in *workspaceIDInput) (*cloneWorkspaceOutput, error) {
	ws, err := a.s.CloneWorkspace(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	ownerState, err := a.workspaceOwnerState(ctx, ws)
	if err != nil {
		return nil, err
	}
	return &cloneWorkspaceOutput{Body: apimodel.CloneWorkspaceResp{
		Workspace: apimodel.FromWorkspace(ws, ownerState),
	}}, nil
}

func (a *api) cloneQuiz(ctx context.Context, in *quizIDInput) (*quizOutput, error) {
	mt, err := a.s.CloneMaterial(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	q, err := a.s.GetQuiz(ctx, mt.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &quizOutput{Body: apimodel.FromQuiz(q)}, nil
}

func (a *api) cloneDeck(ctx context.Context, in *deckIDInput) (*deckOutput, error) {
	mt, err := a.s.CloneMaterial(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	d, err := a.s.GetDeck(ctx, mt.ID)
	if err != nil {
		return nil, hErr(err)
	}
	d.IsOwner = true
	return &deckOutput{Body: d}, nil
}

func (a *api) cloneMaterial(ctx context.Context, in *materialIDInput) (*materialOutput, error) {
	mt, err := a.s.CloneMaterial(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(mt, store.RoleOwner)
}

/* -------------------------------------------------------------------- decks */

func (a *api) updateDeck(ctx context.Context, in *updateDeckInput) (*deckOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	d, err := a.s.UpdateDeck(ctx, in.ID, store.DeckPatch{Name: in.Body.Name, Color: in.Body.Color, Privacy: in.Body.Privacy})
	if err != nil {
		return nil, hErr(err)
	}
	d.IsOwner = true
	return &deckOutput{Body: d}, nil
}

/* ------------------------------------------------------------------ explore */

func (a *api) exploreDecks(ctx context.Context, _ *struct{}) (*publicDecksOutput, error) {
	res, err := a.s.ListPublicDecks(ctx)
	if err != nil {
		return nil, hErr(err)
	}
	return &publicDecksOutput{Body: apimodel.FromPublicDecks(res)}, nil
}
