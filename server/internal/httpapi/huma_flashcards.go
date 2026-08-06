package httpapi

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type decksOutput struct {
	Body []apimodel.Deck
}
type deckOutput struct {
	Body apimodel.Deck
}
type deckIDInput struct {
	ID string `path:"id"`
}
type createDeckInput struct {
	Body apimodel.CreateDeckReq
}
type cardsOutput struct {
	Body []apimodel.Flashcard
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

func (a *api) registerFlashcards(api huma.API) {
	const tag = "Flashcards"
	reg(api, http.MethodGet, "/api/decks", "listDecks", tag, "List decks", http.StatusOK, a.listDecks)
	reg(api, http.MethodPost, "/api/decks", "createDeck", tag, "Create a deck", http.StatusCreated, a.createDeck)
	reg(api, http.MethodGet, "/api/decks/{id}", "getDeck", tag, "Get a deck", http.StatusOK, a.getDeck)
	reg(api, http.MethodGet, "/api/decks/{id}/cards", "listCards", tag, "List cards in a deck", http.StatusOK, a.listCards)
	reg(api, http.MethodPost, "/api/decks/{id}/cards", "createCard", tag, "Create a card", http.StatusCreated, a.createCard)
	reg(api, http.MethodPatch, "/api/cards/{id}", "updateCard", tag, "Update a card", http.StatusOK, a.updateCard)
	reg(api, http.MethodDelete, "/api/cards/{id}", "deleteCard", tag, "Delete a card", http.StatusNoContent, a.deleteCard)
}

func (a *api) listDecks(ctx context.Context, _ *struct{}) (*decksOutput, error) {
	res, err := a.s.ListDecks(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	return &decksOutput{Body: res}, nil
}

func (a *api) createDeck(ctx context.Context, in *createDeckInput) (*deckOutput, error) {
	if in.Body.WorkspaceID != "" {
		if err := a.s.AssertWorkspaceEditor(ctx, userID(ctx), in.Body.WorkspaceID); err != nil {
			return nil, hErr(err)
		}
	}
	res, err := a.s.CreateDeck(ctx, userID(ctx), in.Body.Name, in.Body.Color, in.Body.WorkspaceID)
	if err != nil {
		return nil, hErr(err)
	}
	return &deckOutput{Body: res}, nil
}

func (a *api) getDeck(ctx context.Context, in *deckIDInput) (*deckOutput, error) {
	isOwner, err := a.materialRead(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res, err := a.s.GetDeck(ctx, in.ID)
	if err != nil {
		return nil, hErr(err)
	}
	res.IsOwner = isOwner
	return &deckOutput{Body: res}, nil
}

func (a *api) listCards(ctx context.Context, in *deckIDInput) (*cardsOutput, error) {
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
	res, err := a.s.CreateCard(ctx, in.ID, in.Body.Front, in.Body.Back)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardOutput{Body: res}, nil
}

func (a *api) updateCard(ctx context.Context, in *updateCardInput) (*cardOutput, error) {
	if err := a.assertCardEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	p := store.CardPatch{Front: in.Body.Front, Back: in.Body.Back, Known: in.Body.Known}
	if in.Body.Srs != nil {
		raw := apimodel.EncodeRaw(*in.Body.Srs)
		p.Srs = &raw
	}
	res, err := a.s.UpdateCard(ctx, in.ID, p)
	if err != nil {
		return nil, hErr(err)
	}
	return &cardOutput{Body: res}, nil
}

func (a *api) deleteCard(ctx context.Context, in *cardIDInput) (*Empty, error) {
	if err := a.assertCardEditor(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	if err := a.s.DeleteCard(ctx, in.ID); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
