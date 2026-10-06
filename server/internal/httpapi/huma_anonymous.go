package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/samyung0/capy-notebook/server/internal/questions"
	"github.com/samyung0/capy-notebook/server/internal/store"
)

// Signed-out visitors reach standalone link/public quizzes and flashcard sets
// through signed share tokens. The site Worker verifies the token at the edge
// and caches these responses; Go verifies it again because the API hostname is
// public. Responses are no-store here so only the Worker decides caching.

type shareTokenInput struct {
	Token string `path:"token"`
}
type anonymousAssetInput struct {
	Token   string `path:"token"`
	AssetID string `path:"assetId"`
}

type anonymousQuizOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         store.AnonymousQuiz
}
type anonymousFlashcardsOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         store.AnonymousFlashcards
}

// AnonymousAsset is a short-lived URL the Worker fetches once and caches.
type AnonymousAsset struct {
	URL         string    `json:"url"`
	ContentType string    `json:"contentType"`
	ExpiresAt   time.Time `json:"expiresAt"`
}
type anonymousAssetOutput struct {
	CacheControl string `header:"Cache-Control"`
	Body         AnonymousAsset
}

func (a *api) registerAnonymousMaterials(api huma.API) {
	reg(api, http.MethodGet, "/api/public/quizzes/{token}", "getAnonymousQuiz", "Sharing", "Get a shared quiz for signed-out visitors", http.StatusOK, a.getAnonymousQuiz)
	reg(api, http.MethodGet, "/api/public/quizzes/{token}/assets/{assetId}", "getAnonymousQuizAsset", "Sharing", "Get a shared quiz image URL", http.StatusOK, a.getAnonymousQuizAsset)
	reg(api, http.MethodGet, "/api/public/flashcards/{token}", "getAnonymousFlashcards", "Sharing", "Get a shared flashcard set for signed-out visitors", http.StatusOK, a.getAnonymousFlashcards)
	reg(api, http.MethodGet, "/api/public/flashcards/{token}/assets/{assetId}", "getAnonymousFlashcardAsset", "Sharing", "Get a shared flashcard image URL", http.StatusOK, a.getAnonymousFlashcardAsset)
	a.registerAnonymousGrading(api)
}

// sharedMaterialID returns the id a share token signs; forged tokens are 404.
// The store query then requires a standalone material of the route's kind.
func (a *api) sharedMaterialID(token string) (string, error) {
	id, ok := a.s.VerifyShareToken(token)
	if !ok {
		return "", huma.Error404NotFound("not found")
	}
	return id, nil
}

func (a *api) getAnonymousQuiz(ctx context.Context, in *shareTokenInput) (*anonymousQuizOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	quiz, err := a.s.AnonymousQuiz(ctx, id)
	if err != nil {
		return nil, hErr(err)
	}
	// Visitors take the quiz, so it is answer-free; the image route below
	// still checks against the full content, so solution images resolve once
	// an answer is checked.
	qs, err := decodeStoredQuestions(quiz.Questions)
	if err != nil {
		return nil, hErr(err)
	}
	if quiz.Questions, err = json.Marshal(questions.LearnerViews(qs)); err != nil {
		return nil, hErr(err)
	}
	return &anonymousQuizOutput{CacheControl: "no-store", Body: quiz}, nil
}

func (a *api) getAnonymousFlashcards(ctx context.Context, in *shareTokenInput) (*anonymousFlashcardsOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	set, err := a.s.AnonymousFlashcards(ctx, id)
	if err != nil {
		return nil, hErr(err)
	}
	return &anonymousFlashcardsOutput{CacheControl: "no-store", Body: set}, nil
}

func (a *api) getAnonymousQuizAsset(ctx context.Context, in *anonymousAssetInput) (*anonymousAssetOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	objectPath, contentType, err := a.s.AnonymousQuizAssetPath(ctx, id, in.AssetID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.signedAnonymousAsset(ctx, objectPath, contentType)
}

func (a *api) getAnonymousFlashcardAsset(ctx context.Context, in *anonymousAssetInput) (*anonymousAssetOutput, error) {
	id, err := a.sharedMaterialID(in.Token)
	if err != nil {
		return nil, err
	}
	objectPath, contentType, err := a.s.AnonymousFlashcardAssetPath(ctx, id, in.AssetID)
	if err != nil {
		return nil, hErr(err)
	}
	return a.signedAnonymousAsset(ctx, objectPath, contentType)
}

// signedAnonymousAsset hands the site Worker a short-lived link to the image.
func (a *api) signedAnonymousAsset(ctx context.Context, objectPath, contentType string) (*anonymousAssetOutput, error) {
	if a.blob == nil {
		return nil, hErr(errors.New("blob store not configured"))
	}
	signed, err := a.blob.PresignGetWithExpiry(ctx, objectPath)
	if err != nil {
		return nil, hErr(err)
	}
	return &anonymousAssetOutput{CacheControl: "no-store", Body: AnonymousAsset{
		URL: signed.URL, ContentType: contentType, ExpiresAt: signed.ExpiresAt,
	}}, nil
}
