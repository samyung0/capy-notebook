package httpapi

import (
	"context"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/store"
)

type llmCredentialsOutput struct {
	Body apimodel.LLMCredentialsResponse
}

type upsertLLMCredentialInput struct {
	Body apimodel.UpsertLLMCredentialReq
}

type deleteLLMCredentialInput struct {
	Provider string `path:"provider"`
}

func (a *api) listLLMCredentials(ctx context.Context, _ *struct{}) (*llmCredentialsOutput, error) {
	list, err := a.s.ListLLMCredentials(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	providers, err := a.s.ListLLMCredentialProviders(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	out := apimodel.LLMCredentialsResponse{
		Credentials: []apimodel.LLMCredential{},
		Providers:   []apimodel.LLMCredentialProvider{},
	}
	for _, c := range list {
		out.Credentials = append(out.Credentials, apimodel.LLMCredential{
			ProviderSlug: c.ProviderSlug,
			Last4:        c.Last4,
		})
	}
	for _, p := range providers {
		out.Providers = append(out.Providers, apimodel.LLMCredentialProvider{
			ProviderSlug: p.ProviderSlug,
			Eligible:     p.Eligible,
			Reason:       p.Reason,
			Unlocks:      p.Unlocks,
			Last4:        p.Last4,
		})
	}
	return &llmCredentialsOutput{Body: out}, nil
}

func (a *api) upsertLLMCredential(ctx context.Context, in *upsertLLMCredentialInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	slug := strings.TrimSpace(in.Body.ProviderSlug)
	key := strings.TrimSpace(in.Body.APIKey)
	if !store.ValidLLMProviderSlug(slug) {
		return nil, huma.Error400BadRequest("unsupported provider")
	}
	if key == "" {
		return nil, huma.Error400BadRequest("api key is required")
	}
	if err := a.s.UpsertLLMCredential(ctx, userID(ctx), slug, key); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) deleteLLMCredential(ctx context.Context, in *deleteLLMCredentialInput) (*Empty, error) {
	if err := a.requireAccountMutate(ctx); err != nil {
		return nil, err
	}
	slug := strings.TrimSpace(in.Provider)
	if !store.ValidLLMProviderSlug(slug) {
		return nil, huma.Error400BadRequest("unsupported provider")
	}
	if err := a.s.DeleteLLMCredential(ctx, userID(ctx), slug); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}
