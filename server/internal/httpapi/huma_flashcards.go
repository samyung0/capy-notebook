package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/samyung0/capy-notebook/server/internal/httpapi/apimodel"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

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

type updateFlashcardContentInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateFlashcardContentReq
}
type updateFlashcardSetSharingInput struct {
	ID   string `path:"id"`
	Body apimodel.UpdateStandaloneSharingReq
}
type cardsOutput struct {
	Body []apimodel.Flashcard `nullable:"false"`
}

func (a *api) registerFlashcards(api huma.API) {
	const tag = "Flashcards"
	reg(api, http.MethodPost, "/api/flashcards", "createFlashcardSet", tag, "Create flashcards", http.StatusCreated, a.createFlashcardSet)
	reg(api, http.MethodGet, "/api/flashcards/{id}", "getFlashcardSet", tag, "Get flashcards", http.StatusOK, a.getFlashcardSet)
	reg(api, http.MethodPatch, "/api/flashcards/{id}/metadata", "updateFlashcardSet", tag, "Update flashcard metadata", http.StatusOK, a.updateFlashcardSet)
	regWithMaxBody(api, http.MethodPatch, "/api/flashcards/{id}/content", "updateFlashcardContent", tag, "Update flashcard content", http.StatusOK, materialRequestMaxBytes, a.updateFlashcardContent)
	reg(api, http.MethodPatch, "/api/flashcards/{id}/sharing", "updateFlashcardSetSharing", tag, "Update standalone flashcard sharing", http.StatusOK, a.updateFlashcardSetSharing)
	reg(api, http.MethodGet, "/api/flashcards/{id}/cards", "listCards", tag, "List cards", http.StatusOK, a.listCards)
}

func (a *api) createFlashcardSet(ctx context.Context, in *createFlashcardSetInput) (*flashcardSetOutput, error) {
	if in.Body.WorkspaceID != "" {
		if err := a.s.AssertWorkspaceEditor(ctx, userID(ctx), in.Body.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	res, err := a.s.CreateFlashcardSet(ctx, userID(ctx), string(in.Body.Name), in.Body.Color, in.Body.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	return &flashcardSetOutput{Body: res}, nil
}

func (a *api) getFlashcardSet(ctx context.Context, in *flashcardSetIDInput) (*flashcardSetOutput, error) {
	if _, err := a.materialRead(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetFlashcardSet(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res.IsOwner = role == store.RoleOwner
	if res.CanEdit, res.CanEditContent, err = a.canEditMaterial(ctx, in.ID, role); err != nil {
		return nil, hErr(err)
	}
	author, err := a.s.MaterialAuthorOf(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res.Author = &author
	return &flashcardSetOutput{Body: res}, nil
}

func (a *api) updateFlashcardSet(ctx context.Context, in *updateFlashcardSetInput) (*flashcardSetOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	set, err := a.s.UpdateFlashcardSet(ctx, in.ID, store.FlashcardSetPatch{
		Name: apimodel.Str(in.Body.Name), Color: in.Body.Color, UpdatedBy: userID(ctx),
	})
	if err != nil {
		return nil, hErr(err)
	}
	return a.flashcardSetOutputWithAccess(ctx, in.ID, set)
}

// Narrowing is a recovery action a frozen account keeps; the store refuses
// widening.
func (a *api) updateFlashcardSetSharing(ctx context.Context, in *updateFlashcardSetSharingInput) (*flashcardSetOutput, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
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
	role, err := a.s.MaterialEffectiveRole(ctx, userID(ctx), id)
	if err != nil {
		return nil, hErr(err)
	}
	set.IsOwner = role == store.RoleOwner
	if set.CanEdit, set.CanEditContent, err = a.canEditMaterial(ctx, id, role); err != nil {
		return nil, hErr(err)
	}
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

func (a *api) updateFlashcardContent(ctx context.Context, in *updateFlashcardContentInput) (*cardsOutput, error) {
	if err := a.assertMaterialOwner(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	cards := make([]materialdoc.Card, len(in.Body.Cards))
	for i, card := range in.Body.Cards {
		cards[i] = materialdoc.Card{ID: card.ID, Front: card.Front, Back: card.Back}
		if card.Image != nil {
			cards[i].Image = &materialdoc.CardImage{AssetID: card.Image.AssetID}
		}
	}
	res, err := a.s.UpdateFlashcardContent(ctx, userID(ctx), in.ID, in.Body.ExpectedRevision, cards)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardsOutput{Body: res}, nil
}
