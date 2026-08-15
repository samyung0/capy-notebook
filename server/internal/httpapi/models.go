package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

type modelsInput struct {
	Surface string `query:"surface" enum:"chat,generate,editor" default:"chat"`
}

type modelsOutput struct {
	Body apimodel.ModelsResponse
}

type setModelsInput struct {
	Body apimodel.SetModelPrefsReq
}

func (a *api) registerModels(api huma.API) {
	const tag = "Account"
	reg(api, http.MethodGet, "/api/models", "listModels", tag, "Enabled models for a surface", http.StatusOK, a.listModels)
	reg(api, http.MethodPatch, "/api/me/models", "setModelPrefs", tag, "Set chat and generate model preferences", http.StatusNoContent, a.setModelPrefs)
}

func (a *api) listModels(ctx context.Context, in *modelsInput) (*modelsOutput, error) {
	surface := in.Surface
	if surface == "" {
		surface = models.SurfaceChat
	}
	out := apimodel.ModelsResponse{Models: []apimodel.ModelOption{}}
	if a.modelReg == nil {
		return &modelsOutput{Body: out}, nil
	}
	pref := ""
	if me, err := a.s.Me(ctx, userID(ctx)); err == nil {
		switch surface {
		case models.SurfaceGenerate:
			pref = me.GenerateModelKey
		case models.SurfaceChat:
			pref = me.ChatModelKey
		}
	}
	def, err := a.modelReg.DefaultPin(surface)
	if err == nil {
		out.DefaultKey = def.Key
	}
	if pref != "" {
		out.SelectedKey = pref
	} else {
		out.SelectedKey = out.DefaultKey
	}
	for _, cfg := range a.modelReg.ListEnabled(surface) {
		out.Models = append(out.Models, apimodel.ModelOption{
			Key:         cfg.Key,
			DisplayName: cfg.DisplayName,
			IsDefault:   cfg.Key == out.DefaultKey,
		})
	}
	return &modelsOutput{Body: out}, nil
}

func (a *api) setModelPrefs(ctx context.Context, in *setModelsInput) (*Empty, error) {
	if err := a.s.SetModelPrefs(ctx, userID(ctx), in.Body.ChatModelKey, in.Body.GenerateModelKey); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

func (a *api) ratesForSurface(ctx context.Context, userID, surface string) (cfg models.Config, rates store.TokenRates, err error) {
	if a.modelReg == nil {
		return models.Config{}, store.TokenRates{}, fmt.Errorf("%w: registry not configured", store.ErrModelUnavailable)
	}
	switch surface {
	case models.SurfaceChat, models.SurfaceGenerate:
		if userID == "" {
			return models.Config{}, store.TokenRates{}, fmt.Errorf("%w: missing user for %s", store.ErrModelUnavailable, surface)
		}
		me, meErr := a.s.Me(ctx, userID)
		if meErr != nil {
			return models.Config{}, store.TokenRates{}, meErr
		}
		pref := me.ChatModelKey
		if surface == models.SurfaceGenerate {
			pref = me.GenerateModelKey
		}
		if pref == "" {
			return models.Config{}, store.TokenRates{}, fmt.Errorf("%w: empty %s preference", store.ErrModelUnavailable, surface)
		}
		cfg, err = a.modelReg.ResolveUser(ctx, pref, surface)
	default:
		cfg, err = a.modelReg.Default(ctx, surface)
	}
	if err != nil {
		return models.Config{}, store.TokenRates{}, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
	}
	return cfg, store.RatesFromConfig(cfg), nil
}

func (a *api) embeddingRates(ctx context.Context) store.TokenRates {
	if a.modelReg == nil {
		return store.DefaultEmbeddingRates()
	}
	cfg, err := a.modelReg.Default(ctx, models.SurfaceEmbedding)
	if err != nil {
		return store.DefaultEmbeddingRates()
	}
	return store.RatesFromConfig(cfg)
}
