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
	Surface models.UserModelSurface `query:"surface"`
}

type modelsOutput struct {
	Body apimodel.ModelsResponse
}

type modelSurfacesOutput struct {
	Body struct {
		Surfaces []models.Surface `json:"surfaces" nullable:"false"`
	}
}

type setModelsInput struct {
	Body apimodel.SetModelPrefsReq
}

func (a *api) registerModels(api huma.API) {
	const tag = "Account"
	reg(api, http.MethodGet, "/api/model-surfaces", "listModelSurfaces", tag, "Known model surfaces", http.StatusOK, a.listModelSurfaces)
	reg(api, http.MethodGet, "/api/models", "listModels", tag, "Enabled models for a surface", http.StatusOK, a.listModels)
	reg(api, http.MethodPatch, "/api/me/models", "setModelPrefs", tag, "Set chat, generate, editor and quiz model preferences", http.StatusNoContent, a.setModelPrefs)
	reg(api, http.MethodGet, "/api/me/llm-credentials", "listLLMCredentials", tag, "Saved provider keys", http.StatusOK, a.listLLMCredentials)
	reg(api, http.MethodPut, "/api/me/llm-credentials", "upsertLLMCredential", tag, "Save a provider key", http.StatusNoContent, a.upsertLLMCredential)
	reg(api, http.MethodDelete, "/api/me/llm-credentials/{provider}", "deleteLLMCredential", tag, "Remove a provider key", http.StatusNoContent, a.deleteLLMCredential)
}

func (a *api) listModelSurfaces(context.Context, *struct{}) (*modelSurfacesOutput, error) {
	out := &modelSurfacesOutput{}
	out.Body.Surfaces = models.AllSurfaces()
	return out, nil
}

func (a *api) listModels(ctx context.Context, in *modelsInput) (*modelsOutput, error) {
	out := apimodel.ModelsResponse{Models: []apimodel.ModelOption{}}
	if in.Surface == "" {
		return &modelsOutput{Body: out}, nil
	}
	surface := string(in.Surface)
	if a.modelReg == nil {
		return &modelsOutput{Body: out}, nil
	}
	prefs, err := a.s.UserLLMPrefs(ctx, userID(ctx))
	if err != nil {
		return nil, hErr(err)
	}
	credSlugs, credErr := a.s.LLMCredentialSlugs(ctx, userID(ctx))
	if credErr != nil {
		return nil, hErr(credErr)
	}
	pref := prefs.Model(surface)
	def, err := a.modelReg.DefaultPin(surface)
	if err == nil {
		out.DefaultModel = def.Ref
	}
	if !pref.Zero() {
		out.SelectedModel = pref
	} else {
		out.SelectedModel = out.DefaultModel
	}

	var items []listedModel
	for _, cfg := range a.modelReg.ListEnabled(surface) {
		hasCred := credSlugs[cfg.ProviderSlug]
		opt := apimodel.ModelOption{
			ProviderName: cfg.ProviderName,
			ModelName:    cfg.ModelName,
			ModelSlug:    cfg.ModelSlug,
			IsDefault:    cfg.Ref() == out.DefaultModel,
			Available:    cfg.Available(hasCred),
			UsesUserKey:  cfg.UsesUserKey(hasCred),
			ProviderSlug: cfg.ProviderSlug,
		}
		if len(cfg.ThinkingLevels) > 0 {
			opt.Thinking = &apimodel.ModelThinking{
				Levels:  append([]string(nil), cfg.ThinkingLevels...),
				Default: cfg.DefaultThinking,
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
		return models.JoinModelLabel(items[i].opt.ProviderName, items[i].opt.ModelName) <
			models.JoinModelLabel(items[j].opt.ProviderName, items[j].opt.ModelName)
	})
	for _, item := range items {
		out.Models = append(out.Models, item.opt)
	}
	if selected, ok := findListed(items, out.SelectedModel); ok && selected.Thinking != nil {
		resolved, err := listedCfg(items, out.SelectedModel).ResolveThinking(prefs.Thinking(surface))
		if err != nil {
			return nil, hErr(fmt.Errorf("%w: %v", store.ErrModelUnavailable, err))
		}
		out.SelectedThinking = resolved
	}
	return &modelsOutput{Body: out}, nil
}

type listedModel struct {
	opt apimodel.ModelOption
	cfg models.Config
}

func findListed(items []listedModel, ref models.Ref) (apimodel.ModelOption, bool) {
	for _, item := range items {
		if item.cfg.Ref() == ref {
			return item.opt, true
		}
	}
	return apimodel.ModelOption{}, false
}

func listedCfg(items []listedModel, ref models.Ref) models.Config {
	for _, item := range items {
		if item.cfg.Ref() == ref {
			return item.cfg
		}
	}
	return models.Config{}
}

func (a *api) setModelPrefs(ctx context.Context, in *setModelsInput) (*Empty, error) {
	if err := a.s.SetModelPrefs(ctx, userID(ctx), store.ModelPrefsPatch{
		ChatModel:        in.Body.ChatModel,
		GenerateModel:    in.Body.GenerateModel,
		EditorModel:      in.Body.EditorModel,
		QuizModel:        in.Body.QuizModel,
		ChatThinking:     in.Body.ChatThinking,
		GenerateThinking: in.Body.GenerateThinking,
		QuizThinking:     in.Body.QuizThinking,
	}); err != nil {
		return nil, hErr(err)
	}
	return &Empty{}, nil
}

type resolvedLLM struct {
	Cfg      models.Config
	Rates    store.TokenRates
	PaidBy   string
	UserID   string
	Thinking string
}

func (r resolvedLLM) attach(body map[string]any) {
	body["configVersion"] = r.Cfg.Version
	body["providerSlug"] = r.Cfg.ProviderSlug
	body["modelSlug"] = r.Cfg.ModelSlug
	if r.UserID != "" {
		body["userId"] = r.UserID
	}
	if r.PaidBy != "" {
		body["paidBy"] = r.PaidBy
	}
	if r.Thinking != "" {
		body["thinking"] = r.Thinking
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
		pref := prefs.Model(surface)
		if pref.Zero() {
			return out, fmt.Errorf("%w: empty %s preference", store.ErrModelUnavailable, surface)
		}
		if store.IsBrowserQuizModel(pref) {
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
		stored := prefs.Thinking(surface)
		if surface == models.SurfaceEditor {
			stored = models.ThinkingInstant
		}
		out.Thinking, err = cfg.ResolveThinking(stored)
		if err != nil {
			return resolvedLLM{}, fmt.Errorf("%w: %v", store.ErrModelUnavailable, err)
		}
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

func pipelineGenerateError(err error) error {
	var pe *pipeline.Error
	if !errors.As(err, &pe) {
		return nil
	}
	switch pe.Decode().Code {
	case "generate_empty":
		return errGenerateEmpty
	case "scope_has_no_indexed_content":
		return errScopeNoIndexedContent
	}
	return nil
}

func keyErrorFromEvent(code, message string) error {
	switch code {
	case "invalid_key":
		return store.ErrInvalidLLMKey
	case "key_failed":
		return store.ErrLLMKeyFailed
	case "context_too_large", "compaction_failed", "query_too_long", "invalid_scope":
		return &chatEventError{Code: code, Message: message}
	default:
		return nil
	}
}

type chatEventError struct {
	Code    string
	Message string
}

func (e *chatEventError) Error() string {
	return e.Message
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

type resolvedEmbedding struct {
	Rates store.TokenRates
}

// resolveEmbedding loads the workspace's embedding pin before a spend starts.
// Chat and generate settle with these rates so a missing catalog row fails the
// request instead of labeling usage after the fact.
func (a *api) resolveEmbedding(ctx context.Context, workspaceID string) (resolvedEmbedding, error) {
	var out resolvedEmbedding
	if a.s == nil {
		return out, fmt.Errorf("%w: store not configured", store.ErrModelUnavailable)
	}
	rates, err := a.s.EmbeddingRates(ctx, workspaceID)
	if err != nil {
		return out, err
	}
	out.Rates = rates
	return out, nil
}
