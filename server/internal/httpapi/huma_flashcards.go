package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type flashcardSetsOutput struct {
	Body []apimodel.FlashcardSet `nullable:"false"`
}
type flashcardSetOutput struct {
	Body apimodel.FlashcardSet
}
type flashcardSetIDInput struct {
	ID string `path:"id"`
}
type createFlashcardSetInput struct {
	Body apimodel.CreateFlashcardSetReq
}
type updateFlashcardSetInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateFlashcardSetReq
}
type updateFlashcardSetSharingInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateStandaloneSharingReq
}
type cardsOutput struct {
	Body []apimodel.Flashcard `nullable:"false"`
}
type cardOutput struct {
	Body apimodel.Flashcard
}
type cardIDInput struct {
	ID string `path:"id"`
}
type createCardInput struct {
	ID   string `path:"id"`
	Body apimodel.CreateCardReq
}
type updateCardInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateCardReq
}
type updateCardStudyStateInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateCardStudyStateReq
}

func (a *api) registerFlashcards(api huma.API) {
	const tag = "Flashcards"
	reg(api, http.MethodGet, "/api/flashcards", "listFlashcardSets", tag, "List flashcard sets", http.StatusOK, a.listFlashcardSets)
	reg(api, http.MethodPost, "/api/flashcards", "createFlashcardSet", tag, "Create flashcards", http.StatusCreated, a.createFlashcardSet)
	reg(api, http.MethodGet, "/api/flashcards/{id}", "getFlashcardSet", tag, "Get flashcards", http.StatusOK, a.getFlashcardSet)
	reg(api, http.MethodPatch, "/api/flashcards/{id}/metadata", "updateFlashcardSet", tag, "Update flashcard metadata", http.StatusOK, a.updateFlashcardSet)
	reg(api, http.MethodPatch, "/api/flashcards/{id}/sharing", "updateFlashcardSetSharing", tag, "Update standalone flashcard sharing", http.StatusOK, a.updateFlashcardSetSharing)
	reg(api, http.MethodGet, "/api/flashcards/{id}/cards", "listCards", tag, "List cards", http.StatusOK, a.listCards)
	reg(api, http.MethodPost, "/api/flashcards/{id}/cards", "createCard", tag, "Create a card", http.StatusCreated, a.createCard)
	reg(api, http.MethodPatch, "/api/flashcards/cards/{id}/content", "updateCard", tag, "Update card content", http.StatusOK, a.updateCard)
	reg(api, http.MethodPatch, "/api/flashcards/cards/{id}/study-state", "updateCardStudyState", tag, "Update card study state", http.StatusOK, a.updateCardStudyState)
	reg(api, http.MethodDelete, "/api/flashcards/cards/{id}", "deleteCard", tag, "Delete a card", http.StatusNoContent, a.deleteCard)
}

func (a *api) listFlashcardSets(ctx context.Context, _ *struct{}) (*flashcardSetsOutput, error) {
	res, err := a.s.ListFlashcardSets(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &flashcardSetsOutput{Body: res}, nil
}

func (a *api) createFlashcardSet(ctx context.Context, in *createFlashcardSetInput) (*flashcardSetOutput, error) {
	if in.Body.WorkspaceID != "" {
		if err := a.s.AssertWorkspaceEditor(ctx, userID(ctx), in.Body.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	res, err := a.s.CreateFlashcardSet(ctx, userID(ctx), in.Body.Name, in.Body.Color, in.Body.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	return &flashcardSetOutput{Body: res}, nil
}

func (a *api) getFlashcardSet(ctx context.Context, in *flashcardSetIDInput) (*flashcardSetOutput, error) {
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	access, err := a.s.MaterialEffectiveAccess(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetFlashcardSet(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res.IsOwner = access.Role == store.RoleOwner
	res.CanEdit = store.RoleCanEdit(access.MemberRole)
	return &flashcardSetOutput{Body: res}, nil
}

func (a *api) updateFlashcardSet(ctx context.Context, in *updateFlashcardSetInput) (*flashcardSetOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	set, err := a.s.UpdateFlashcardSet(ctx, in.ID, store.FlashcardSetPatch{
		Name: in.Body.Name, Color: in.Body.Color, UpdatedBy: userID(ctx),
	})
	if err != nil {
		return nil, hErr(err)
	}
	return a.flashcardSetOutputWithAccess(ctx, in.ID, set)
}

func (a *api) updateFlashcardSetSharing(ctx context.Context, in *updateFlashcardSetSharingInput) (*flashcardSetOutput, error) {
	if err := a.requireAccountEdit(ctx); err != nil {
		return nil, err
	}
	material, err := a.s.UpdateStandaloneMaterialPrivacy(
		ctx, userID(ctx), in.ID, "flashcards", in.Body.Privacy,
	)
	if err != nil {
		return nil, hErr(err)
	}
	set, err := a.s.GetFlashcardSet(ctx, material.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.flashcardSetOutputWithAccess(ctx, in.ID, set)
}

func (a *api) flashcardSetOutputWithAccess(ctx context.Context, id string, set store.FlashcardSet) (*flashcardSetOutput, error) {
	access, err := a.s.MaterialEffectiveAccess(ctx, userID(ctx), id)
	if err != nil {
		return nil, hErr(err)
	}
	set.IsOwner = access.Role == store.RoleOwner
	set.CanEdit = store.RoleCanEdit(access.MemberRole)
	return &flashcardSetOutput{Body: set}, nil
}

func (a *api) listCards(ctx context.Context, in *flashcardSetIDInput) (*cardsOutput, error) {
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.ListCards(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardsOutput{Body: res}, nil
}

func (a *api) createCard(ctx context.Context, in *createCardInput) (*cardOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.CreateCard(ctx, userID(ctx), in.ID, in.Body.Front, in.Body.Back)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardOutput{Body: res}, nil
}

func (a *api) updateCard(ctx context.Context, in *updateCardInput) (*cardOutput, error) {
	if err := a.assertCardEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	p := store.CardContentPatch{Front: in.Body.Front, Back: in.Body.Back, UpdatedBy: userID(ctx)}
	res, err := a.s.UpdateCardContent(ctx, in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardOutput{Body: res}, nil
}

func (a *api) updateCardStudyState(ctx context.Context, in *updateCardStudyStateInput) (*cardOutput, error) {
	if err := a.assertCardEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	p := store.CardStudyStatePatch{Known: in.Body.Known, UpdatedBy: userID(ctx)}
	if in.Body.Srs != nil {
		raw := apimodel.EncodeRaw(*in.Body.Srs)
		p.Srs = &raw
	}
	res, err := a.s.UpdateCardStudyState(ctx, in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardOutput{Body: res}, nil
}

func (a *api) deleteCard(ctx context.Context, in *cardIDInput) (*Empty, error) {
	if err := a.assertCardEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.DeleteCard(ctx, userID(ctx), in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
