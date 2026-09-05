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
type publicFlashcardSetsOutput struct {
	Body []apimodel.PublicFlashcardSet `nullable:"false"`
}

func (a *api) registerShare(api huma.API) {
	const tag = "Sharing"
	reg(api, http.MethodPost, "/api/workspaces/{id}/clone", "cloneWorkspace", tag, "Clone a shared workspace", http.StatusCreated, a.cloneWorkspace)
	reg(api, http.MethodPost, "/api/quizzes/{id}/clone", "cloneQuiz", tag, "Clone a shared quiz", http.StatusCreated, a.cloneQuiz)
	reg(api, http.MethodPost, "/api/flashcards/{id}/clone", "cloneFlashcardSet", tag, "Clone shared flashcards", http.StatusCreated, a.cloneFlashcardSet)
	reg(api, http.MethodPost, "/api/materials/{id}/clone", "cloneMaterial", tag, "Clone a shared material", http.StatusCreated, a.cloneMaterial)
	reg(api, http.MethodGet, "/api/explore/flashcards", "exploreFlashcardSets", "Explore", "Public flashcards", http.StatusOK, a.exploreFlashcardSets)
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
	mt, err := a.s.CloneMaterialKind(ctx, userID(ctx), in.ID, "quiz")
	if err != nil {
		return nil, hErr(err)
	}
	q, err := a.s.GetQuiz(ctx, mt.ID)
	if err != nil {
		return nil, hErr(err)
	}
	q.IsOwner = true
	q.CanEdit = true
	return &quizOutput{Body: apimodel.FromQuiz(q)}, nil
}

func (a *api) cloneFlashcardSet(ctx context.Context, in *flashcardSetIDInput) (*flashcardSetOutput, error) {
	mt, err := a.s.CloneMaterialKind(ctx, userID(ctx), in.ID, "flashcards")
	if err != nil {
		return nil, hErr(err)
	}
	d, err := a.s.GetFlashcardSet(ctx, mt.ID)
	if err != nil {
		return nil, hErr(err)
	}
	d.IsOwner = true
	d.CanEdit = true
	return &flashcardSetOutput{Body: d}, nil
}

func (a *api) cloneMaterial(ctx context.Context, in *materialIDInput) (*materialOutput, error) {
	mt, err := a.s.CloneMaterial(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return materialResponse(mt, store.RoleOwner)
}

/* ------------------------------------------------------------------ explore */

func (a *api) exploreFlashcardSets(ctx context.Context, _ *struct{}) (*publicFlashcardSetsOutput, error) {
	res, err := a.s.ListPublicFlashcardSets(ctx)
	if err != nil {
		return nil, hErr(err)
	}
	return &publicFlashcardSetsOutput{Body: apimodel.FromPublicFlashcardSets(res)}, nil
}
