package models

import (
	"os"
	"testing"
)

func TestEliteLLMProvidersLoad(t *testing.T) {
	catalog, err := LoadEliteLLMProviders()
	if err != nil {
		t.Fatal(err)
	}
	if catalog.SchemaVersion != EliteLLMProvidersSchemaVersion {
		t.Fatalf("schema %d", catalog.SchemaVersion)
	}
	for _, slug := range []string{"anthropic", "openai", "deepseek", "gemini", "openrouter"} {
		if !catalog.Known(slug) {
			t.Fatalf("missing provider %s", slug)
		}
	}
	if spec, ok := catalog.Lookup("anthropic"); !ok || spec.PlatformEnv != "ANTHROPIC_API_KEY" {
		t.Fatalf("anthropic platform env: %#v", spec)
	}
}

func TestEliteLLMProvidersRejectUnknownAndHops(t *testing.T) {
	catalog := MustEliteLLMProviders()
	if ok, _ := catalog.AllowsModel("novita", "anything"); ok {
		t.Fatal("novita hop must be rejected")
	}
	if ok, _ := catalog.AllowsModel("openrouter", "deepseek/deepseek-v4-flash"); ok {
		t.Fatal("openrouter chat hop must be rejected")
	}
	if ok, reason := catalog.AllowsModel("openrouter", SeededHopEmbedSlug); !ok {
		t.Fatalf("seeded qwen embed: %s", reason)
	}
	if !IsSeededHopException("openrouter", SeededHopEmbedSlug) {
		t.Fatal("seeded hop exception")
	}
	if IsSeededHopException("openrouter", "other") {
		t.Fatal("other openrouter models are not the exception")
	}
}

func TestEliteLLMProvidersThinking(t *testing.T) {
	catalog := MustEliteLLMProviders()
	if ok, _ := catalog.AllowsThinking("deepseek", []string{"instant", "mid"}); !ok {
		t.Fatal("deepseek thinking")
	}
	if ok, _ := catalog.AllowsThinking("deepseek", []string{"medium"}); ok {
		t.Fatal("product mid is not wire medium")
	}
	if ok, _ := catalog.AllowsThinking("openrouter", []string{"instant"}); ok {
		t.Fatal("embed provider has no thinking")
	}
}

func TestEliteLLMProvidersEnforceImplementedModesPerSurface(t *testing.T) {
	catalog := MustEliteLLMProviders()
	for _, surface := range []string{SurfaceChat, SurfaceGenerate, SurfaceEditor, SurfaceQuiz, SurfaceIngest} {
		if ok, reason := catalog.AllowsSurface("deepseek", surface); !ok {
			t.Fatalf("deepseek %s: %s", surface, reason)
		}
	}
	if ok, _ := catalog.AllowsSurface("gemini", SurfaceChat); ok {
		t.Fatal("gemini chat must stay unavailable until elitellm implements streaming")
	}
	if ok, reason := catalog.AllowsSurface("gemini", SurfaceVision); !ok {
		t.Fatalf("gemini vision: %s", reason)
	}
	if ok, reason := catalog.AllowsSurface("openrouter", SurfaceEmbedding); !ok {
		t.Fatalf("openrouter embedding: %s", reason)
	}
}

func TestEliteLLMProvidersPlatformEnv(t *testing.T) {
	catalog := MustEliteLLMProviders()
	t.Setenv("ANTHROPIC_API_KEY", "")
	if ok, reason := catalog.PlatformEnvConfigured("anthropic"); ok {
		t.Fatalf("empty anthropic key should fail: %s", reason)
	}
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	if ok, reason := catalog.PlatformEnvConfigured("anthropic"); !ok {
		t.Fatal(reason)
	}
	if catalog.CredentialEnv("anthropic") != "ANTHROPIC_API_KEY" {
		t.Fatal(catalog.CredentialEnv("anthropic"))
	}
}

func TestAgenticLoopCertificationIsProviderAndSlugKeyed(t *testing.T) {
	if !AgenticLoopCertified("deepseek", "deepseek-v4-flash") ||
		!AgenticLoopCertified("deepseek", "deepseek-v4-pro") ||
		!AgenticLoopCertified("deepseek", "deepseek-v4-flash-vision-exp") {
		t.Fatal("seeded deepseek slugs must be certified")
	}
	if AgenticLoopCertified("deepseek", "deepseek/deepseek-v4-flash") {
		t.Fatal("liteLLM ids are not cert keys")
	}
	if AgenticLoopCertified("anthropic", "claude-not-certified") {
		t.Fatal("unknown slug must not inherit a cert")
	}
	if AgenticLoopCertified("other-provider", "deepseek-v4-flash") {
		t.Fatal("a certified slug must not transfer across providers")
	}
}

func TestParseEliteLLMProvidersRejectsDuplicatesAndEmpty(t *testing.T) {
	_, err := parseEliteLLMProviders([]byte(`{"schemaVersion":1,"providers":{}}`))
	if err == nil {
		t.Fatal("empty providers")
	}
	_, err = parseEliteLLMProviders([]byte(`{
		"schemaVersion": 1,
		"providers": {
			"openai": {"name":"OpenAI","modes":["chat"],"byok":true,"platformEnv":"OPENAI_API_KEY","thinking":["instant"]}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = parseEliteLLMProviders([]byte(`{
		"schemaVersion": 1,
		"providers": {
			"openai": {"name":"OpenAI","modes":["chat","chat"],"byok":true,"platformEnv":"OPENAI_API_KEY","thinking":["instant"]}
		}
	}`))
	if err == nil {
		t.Fatal("duplicate provider mode")
	}
}

func TestUsesResponses(t *testing.T) {
	if !UsesResponses("openai", "mid", true) {
		t.Fatal("openai tools+thinking uses responses")
	}
	if UsesResponses("openai", ThinkingInstant, true) {
		t.Fatal("instant stays on chat completions")
	}
	if UsesResponses("openai", "high", false) {
		t.Fatal("no tools stays on chat completions")
	}
	if UsesResponses("deepseek", "high", true) {
		t.Fatal("deepseek never uses responses")
	}
}

func TestCredentialEnvFallback(t *testing.T) {
	catalog := MustEliteLLMProviders()
	if catalog.CredentialEnv("not-a-provider") != "NOT_A_PROVIDER_API_KEY" {
		t.Fatal(catalog.CredentialEnv("not-a-provider"))
	}
	_ = os.Getenv
}
