package models

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

//go:embed elitellm_providers.json
var elitellmProvidersJSON []byte

//go:embed agentic_loop_certs.json
var agenticLoopCertsJSON []byte

type agenticLoopCertsFile struct {
	SchemaVersion int                        `json:"schemaVersion"`
	Certified     map[string]map[string]bool `json:"certified"`
}

var (
	loadAgenticLoopCertsOnce sync.Once
	loadedAgenticLoopCerts   map[string]map[string]bool
	agenticLoopCertsLoadErr  error
)

func AgenticLoopCertified(providerSlug, modelSlug string) bool {
	loadAgenticLoopCertsOnce.Do(func() {
		var file agenticLoopCertsFile
		if err := json.Unmarshal(agenticLoopCertsJSON, &file); err != nil {
			agenticLoopCertsLoadErr = err
			return
		}
		loadedAgenticLoopCerts = file.Certified
	})
	if agenticLoopCertsLoadErr != nil || loadedAgenticLoopCerts == nil {
		return false
	}
	provider := loadedAgenticLoopCerts[strings.TrimSpace(providerSlug)]
	if provider == nil {
		return false
	}
	_, certified := provider[strings.TrimSpace(modelSlug)]
	return certified
}

const (
	EliteLLMProvidersSchemaVersion = 1
	SeededHopEmbedSlug             = "qwen/qwen3-embedding-4b"
	ProviderOpenRouter             = "openrouter"
	ProviderAnthropic              = "anthropic"
	EliteLLMModeChat               = "chat"
	EliteLLMModeVision             = "vision"
	EliteLLMModeEmbedding          = "embedding"
)

type EliteLLMProvidersFile struct {
	SchemaVersion int                             `json:"schemaVersion"`
	Providers     map[string]EliteLLMProviderSpec `json:"providers"`
}

type EliteLLMProviderSpec struct {
	Name              string   `json:"name"`
	Modes             []string `json:"modes"`
	BYOK              bool     `json:"byok"`
	PlatformEnv       string   `json:"platformEnv"`
	Thinking          []string `json:"thinking"`
	AllowedModelSlugs []string `json:"allowedModelSlugs,omitempty"`
}

type EliteLLMProviders struct {
	SchemaVersion int
	bySlug        map[string]EliteLLMProviderSpec
	all           []EliteLLMProvider
}

type EliteLLMProvider struct {
	Slug string
	EliteLLMProviderSpec
}

var (
	loadProvidersOnce sync.Once
	loadedProviders   *EliteLLMProviders
	providersLoadErr  error
)

func LoadEliteLLMProviders() (*EliteLLMProviders, error) {
	loadProvidersOnce.Do(func() {
		loadedProviders, providersLoadErr = parseEliteLLMProviders(elitellmProvidersJSON)
	})
	return loadedProviders, providersLoadErr
}

func MustEliteLLMProviders() *EliteLLMProviders {
	catalog, err := LoadEliteLLMProviders()
	if err != nil {
		panic(err)
	}
	return catalog
}

func parseEliteLLMProviders(raw []byte) (*EliteLLMProviders, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var file EliteLLMProvidersFile
	if err := decoder.Decode(&file); err != nil {
		return nil, fmt.Errorf("elitellm providers: %w", err)
	}
	if file.SchemaVersion != EliteLLMProvidersSchemaVersion {
		return nil, fmt.Errorf("elitellm providers schema %d is unsupported", file.SchemaVersion)
	}
	if len(file.Providers) == 0 {
		return nil, fmt.Errorf("elitellm providers file is empty")
	}
	bySlug := make(map[string]EliteLLMProviderSpec, len(file.Providers))
	all := make([]EliteLLMProvider, 0, len(file.Providers))
	for slug, spec := range file.Providers {
		if strings.TrimSpace(slug) == "" {
			return nil, fmt.Errorf("elitellm providers contains an empty slug")
		}
		if strings.TrimSpace(spec.Name) == "" || strings.TrimSpace(spec.PlatformEnv) == "" {
			return nil, fmt.Errorf("elitellm provider %q is missing name or platformEnv", slug)
		}
		if len(spec.Modes) == 0 {
			return nil, fmt.Errorf("elitellm provider %q has no modes", slug)
		}
		seenModes := make(map[string]bool, len(spec.Modes))
		for _, mode := range spec.Modes {
			if mode != EliteLLMModeChat && mode != EliteLLMModeVision && mode != EliteLLMModeEmbedding {
				return nil, fmt.Errorf("elitellm provider %q has unknown mode %q", slug, mode)
			}
			if seenModes[mode] {
				return nil, fmt.Errorf("elitellm provider %q repeats mode %q", slug, mode)
			}
			seenModes[mode] = true
		}
		bySlug[slug] = spec
		all = append(all, EliteLLMProvider{Slug: slug, EliteLLMProviderSpec: spec})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Slug < all[j].Slug })
	return &EliteLLMProviders{
		SchemaVersion: file.SchemaVersion,
		bySlug:        bySlug,
		all:           all,
	}, nil
}

func (c *EliteLLMProviders) Lookup(slug string) (EliteLLMProviderSpec, bool) {
	if c == nil {
		return EliteLLMProviderSpec{}, false
	}
	spec, ok := c.bySlug[strings.TrimSpace(slug)]
	return spec, ok
}

func (c *EliteLLMProviders) Known(slug string) bool {
	_, ok := c.Lookup(slug)
	return ok
}

func (c *EliteLLMProviders) All() []EliteLLMProvider {
	if c == nil {
		return nil
	}
	return append([]EliteLLMProvider(nil), c.all...)
}

func (c *EliteLLMProviders) AllowsModel(slug, modelSlug string) (bool, string) {
	spec, ok := c.Lookup(slug)
	if !ok {
		return false, "provider is not handled by elitellm"
	}
	if slug == ProviderOpenRouter {
		if !containsString(spec.AllowedModelSlugs, modelSlug) {
			return false, "openrouter is only allowed for the seeded qwen embed hop"
		}
		return true, ""
	}
	if len(spec.AllowedModelSlugs) > 0 && !containsString(spec.AllowedModelSlugs, modelSlug) {
		return false, "model slug is not in the elitellm allowlist"
	}
	return true, ""
}

func (c *EliteLLMProviders) AllowsThinking(slug string, levels []string) (bool, string) {
	spec, ok := c.Lookup(slug)
	if !ok {
		return false, "provider is not handled by elitellm"
	}
	allowed := spec.Thinking
	for _, level := range levels {
		if !containsString(allowed, level) {
			return false, fmt.Sprintf("thinking %q is not valid for %s", level, slug)
		}
	}
	return true, ""
}

func (c *EliteLLMProviders) AllowsSurface(slug, surface string) (bool, string) {
	spec, ok := c.Lookup(slug)
	if !ok {
		return false, "provider is not handled by elitellm"
	}
	mode := EliteLLMModeChat
	switch surface {
	case SurfaceVision:
		mode = EliteLLMModeVision
	case SurfaceEmbedding:
		mode = EliteLLMModeEmbedding
	case SurfaceChat, SurfaceGenerate, SurfaceEditor, SurfaceQuiz, SurfaceIngest:
	default:
		return false, fmt.Sprintf("surface %q is unknown", surface)
	}
	if !containsString(spec.Modes, mode) {
		return false, fmt.Sprintf("%s does not implement %s mode for surface %s", slug, mode, surface)
	}
	return true, ""
}

func (c *EliteLLMProviders) PlatformEnvConfigured(slug string) (bool, string) {
	spec, ok := c.Lookup(slug)
	if !ok {
		return false, "provider is not handled by elitellm"
	}
	if strings.TrimSpace(os.Getenv(spec.PlatformEnv)) == "" {
		return false, fmt.Sprintf("%s is not set", spec.PlatformEnv)
	}
	return true, ""
}

func (c *EliteLLMProviders) CredentialEnv(slug string) string {
	spec, ok := c.Lookup(slug)
	if !ok {
		return strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(slug)) + "_API_KEY"
	}
	return spec.PlatformEnv
}

func IsFirstPartyProvider(slug string) bool {
	return slug == "anthropic" || slug == "openai" || slug == "deepseek" || slug == "gemini"
}

func IsSeededHopException(providerSlug, modelSlug string) bool {
	return providerSlug == ProviderOpenRouter && modelSlug == SeededHopEmbedSlug
}

func JoinModelLabel(providerName, modelName string) string {
	providerName = strings.TrimSpace(providerName)
	modelName = strings.TrimSpace(modelName)
	switch {
	case providerName == "":
		return modelName
	case modelName == "":
		return providerName
	default:
		return providerName + " " + modelName
	}
}

func ProviderModelID(providerSlug, modelSlug string) string {
	return strings.TrimSpace(providerSlug) + "-" + strings.TrimSpace(modelSlug)
}
