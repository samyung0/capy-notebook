package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/danielgtaylor/huma/v2"

	"github.com/evonotes/server/internal/httpapi/apimodel"
	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/pipeline"
	"github.com/evonotes/server/internal/store"
)

type modelsInput struct {
	Surface string `query:"surface" enum:"chat,generate,editor,quiz" default:"chat"`
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
	reg(api, http.MethodPatch, "/api/me/models", "setModelPrefs", tag, "Set chat, generate, editor and quiz model preferences", http.StatusNoContent, a.setModelPrefs)
	reg(api, http.MethodGet, "/api/me/llm-credentials", "listLLMCredentials", tag, "Saved provider keys", http.StatusOK, a.listLLMCredentials)
	reg(api, http.MethodPut, "/api/me/llm-credentials", "upsertLLMCredential", tag, "Save a provider key", http.StatusNoContent, a.upsertLLMCredential)
	reg(api, http.MethodDelete, "/api/me/llm-credentials/{provider}", "deleteLLMCredential", tag, "Remove a provider key", http.StatusNoContent, a.deleteLLMCredential)
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
	prefs, prefErr := a.s.UserLLMPrefs(ctx, userID(ctx))
	credSlugs, credErr := a.s.LLMCredentialSlugs(ctx, userID(ctx))
	if credErr != nil {
		return nil, hErr(credErr)
	}
	pref := ""
	if prefErr == nil {
		pref = prefs.ModelKey(surface)
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

	var items []listedModel
	for _, cfg := range a.modelReg.ListEnabled(surface) {
		hasCred := credSlugs[cfg.ProviderSlug]
		opt := apimodel.ModelOption{
			Key:          cfg.Key,
			DisplayName:  cfg.DisplayName,
			IsDefault:    cfg.Key == out.DefaultKey,
			Available:    cfg.Available(hasCred),
			UsesUserKey:  cfg.UsesUserKey(hasCred),
			ProviderSlug: cfg.ProviderSlug,
		}
		if spec := cfg.Reasoning(); len(spec.Efforts) > 0 || spec.CanDisable || spec.DefaultMode == "on" {
			opt.Reasoning = &apimodel.ModelReasoning{
				CanDisable:    spec.CanDisable,
				Efforts:       spec.Efforts,
				DefaultMode:   spec.DefaultMode,
				DefaultEffort: spec.DefaultEffort,
			}
			if opt.Reasoning.Efforts == nil {
				opt.Reasoning.Efforts = []string{}
			}
		}
		items = append(items, listedModel{opt: opt, cfg: cfg})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].opt.Available != items[j].opt.Available {
			return items[i].opt.Available
		}
		if items[i].opt.UsesUserKey != items[j].opt.UsesUserKey {
			return !items[i].opt.UsesUserKey
		}
		return items[i].opt.DisplayName < items[j].opt.DisplayName
	})
	for _, item := range items {
		out.Models = append(out.Models, item.opt)
	}
	if prefErr == nil {
		if selected, ok := findListed(items, out.SelectedKey); ok && selected.Reasoning != nil {
			mode, effort := prefs.Reasoning(surface)
			out.SelectedReasoningMode, out.SelectedReasoningEffort = listedCfg(items, out.SelectedKey).ResolveReasoning(mode, effort)
		}
	}
	return &modelsOutput{Body: out}, nil
}

type listedModel struct {
	opt apimodel.ModelOption
	cfg models.Config
}

func findListed(items []listedModel, key string) (apimodel.ModelOption, bool) {
	for _, item := range items {
		if item.opt.Key == key {
			return item.opt, true
		}
	}
	return apimodel.ModelOption{}, false
}

func listedCfg(items []listedModel, key string) models.Config {
	for _, item := range items {
		if item.opt.Key == key {
			return item.cfg
		}
	}
	return models.Config{}
}

func (a *api) setModelPrefs(ctx context.Context, in *setModelsInput) (*Empty, error) {
	if err := a.s.SetModelPrefs(ctx, userID(ctx), store.ModelPrefsPatch{
		ChatModelKey:            in.Body.ChatModelKey,
		GenerateModelKey:        in.Body.GenerateModelKey,
		EditorModelKey:          in.Body.EditorModelKey,
		QuizModelKey:            in.Body.QuizModelKey,
		ChatReasoningMode:       in.Body.ChatReasoningMode,
		ChatReasoningEffort:     in.Body.ChatReasoningEffort,
		GenerateReasoningMode:   in.Body.GenerateReasoningMode,
		GenerateReasoningEffort: in.Body.GenerateReasoningEffort,
		QuizReasoningMode:       in.Body.QuizReasoningMode,
		QuizReasoningEffort:     in.Body.QuizReasoningEffort,
	}); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

type resolvedLLM struct {
	Cfg             models.Config
	Rates           store.TokenRates
	PaidBy          string
	UserID          string
	ReasoningMode   string
	ReasoningEffort string
}

func (r resolvedLLM) attach(body map[string]any) {
	body["modelKey"] = r.Cfg.Key
	body["configVersion"] = r.Cfg.Version
	if r.UserID != "" {
		body["userId"] = r.UserID
	}
	if r.PaidBy != "" {
		body["paidBy"] = r.PaidBy
	}
	if r.ReasoningMode != "" {
		body["reasoningMode"] = r.ReasoningMode
	}
	if r.ReasoningEffort != "" {
		body["reasoningEffort"] = r.ReasoningEffort
	}
}

func (a *api) resolveLLM(ctx context.Context, userID, surface string) (resolvedLLM, error) {
	var out resolvedLLM
	if a.modelReg == nil {
		return out, fmt.Errorf("%w: registry not configured", store.ErrModelUnavailable)
	}
	switch surface {
	case models.SurfaceChat, models.SurfaceGenerate, models.SurfaceEditor, models.SurfaceQuiz:
		if userID == "" {
			return out, fmt.Errorf("%w: missing user for %s", store.ErrModelUnavailable, surface)
		}
		prefs, err := a.s.UserLLMPrefs(ctx, userID)
		if err != nil {
			return out, err
		}
		pref := prefs.ModelKey(surface)
		if pref == "" {
			return out, fmt.Errorf("%w: empty %s preference", store.ErrModelUnavailable, surface)
		}
		if store.IsBrowserQuizKey(pref) {
			return out, fmt.Errorf("%w: browser quiz model", store.ErrModelUnavailable)
		}
		cfg, err := a.modelReg.ResolveUser(ctx, pref, surface)
		if err != nil {
			return out, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
		}
		hasCred, err := a.s.HasLLMCredential(ctx, userID, cfg.ProviderSlug)
		if err != nil {
			return out, err
		}
		if !cfg.Available(hasCred) {
			return out, fmt.Errorf("%w: no credential for %s", store.ErrModelUnavailable, cfg.ProviderSlug)
		}
		out.Cfg = cfg
		out.Rates = store.RatesFromConfig(cfg)
		out.UserID = userID
		if cfg.UsesUserKey(hasCred) {
			out.PaidBy = models.PaidByUser
		} else {
			out.PaidBy = models.PaidByPlatform
		}
		mode, effort := prefs.Reasoning(surface)
		out.ReasoningMode, out.ReasoningEffort = cfg.ResolveReasoning(mode, effort)
		return out, nil
	default:
		cfg, err := a.modelReg.Default(ctx, surface)
		if err != nil {
			return out, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
		}
		out.Cfg = cfg
		out.Rates = store.RatesFromConfig(cfg)
		out.PaidBy = models.PaidByPlatform
		return out, nil
	}
}

func (a *api) ratesForSurface(ctx context.Context, userID, surface string) (cfg models.Config, rates store.TokenRates, err error) {
	resolved, err := a.resolveLLM(ctx, userID, surface)
	if err != nil {
		return models.Config{}, store.TokenRates{}, err
	}
	return resolved.Cfg, resolved.Rates, nil
}

func pipelineLLMError(err error) error {
	var pe *pipeline.Error
	if !errors.As(err, &pe) {
		return nil
	}
	switch pe.Decode().Code {
	case "invalid_key":
		return store.ErrInvalidLLMKey
	case "key_failed":
		return store.ErrLLMKeyFailed
	default:
		return nil
	}
}

func keyErrorFromEvent(code, message string) error {
	switch code {
	case "invalid_key":
		return store.ErrInvalidLLMKey
	case "key_failed":
		return store.ErrLLMKeyFailed
	default:
		if message == "" {
			return nil
		}
		return errors.New(message)
	}
}

func llmKeyPayload(err error) (code, message string, ok bool) {
	if mapped := pipelineLLMError(err); mapped != nil {
		err = mapped
	}
	switch {
	case errors.Is(err, store.ErrInvalidLLMKey):
		return "invalid_key", "The provider rejected this key.", true
	case errors.Is(err, store.ErrLLMKeyFailed):
		return "key_failed", "Something went wrong, please double check if the key is valid", true
	default:
		return "", "", false
	}
}

func (a *api) embeddingRates(ctx context.Context, workspaceID string) store.TokenRates {
	if a.s == nil {
		return store.DefaultEmbeddingRates()
	}
	return a.s.EmbeddingRates(ctx, workspaceID)
}
