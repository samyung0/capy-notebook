package store

import (
	"testing"

	"github.com/evonotes/server/internal/models"
)

func TestCreditsForTokensDifferByModel(t *testing.T) {
	flash := TokenRates{MicrosPerInputToken: 250, MicrosPerOutputToken: 1000, Model: models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}, ModelVersion: 1}
	pro := TokenRates{MicrosPerInputToken: 775, MicrosPerOutputToken: 3100, Model: models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-pro"}, ModelVersion: 1}
	in, out := int64(1_000), int64(1_000)
	flashC := CreditsForTokens(flash, KindLLM, in, out, 0)
	proC := CreditsForTokens(pro, KindLLM, in, out, 0)
	if flashC != 1_250_000 {
		t.Fatalf("flash credits = %d", flashC)
	}
	if proC <= flashC {
		t.Fatalf("pro (%d) must cost more than flash (%d)", proC, flashC)
	}
}

func TestRatesFromConfigKeepsZeros(t *testing.T) {
	got := RatesFromConfig(models.Config{ProviderSlug: "openai", ModelSlug: "gpt-5.6-sol", Version: 1})
	if got.MicrosPerInputToken != 0 || got.MicrosPerOutputToken != 0 {
		t.Fatalf("zeros were filled: %#v", got)
	}
	if got.Model != (models.Ref{ProviderSlug: "openai", ModelSlug: "gpt-5.6-sol"}) || got.ModelVersion != 1 {
		t.Fatalf("pin: %#v", got)
	}
}

func TestCreditsForTokensKeepsZeros(t *testing.T) {
	if n := CreditsForTokens(TokenRates{}, KindLLM, 1000, 1000, 0); n != 0 {
		t.Fatalf("llm zeros filled: %d", n)
	}
	if n := CreditsForTokens(TokenRates{}, KindEmbedding, 1000, 0, 0); n != 0 {
		t.Fatalf("embed zeros filled: %d", n)
	}
}

func TestCreditsForTokensDiscountsProvenCacheReads(t *testing.T) {
	rates := TokenRates{MicrosPerInputToken: 250, MicrosPerOutputToken: 1000, MicrosPerCachedInputToken: 25}
	// 800 uncached * 250 + 200 cached * 25 + 100 output * 1000
	got := CreditsForTokens(rates, KindLLM, 1000, 100, 200)
	if got != 800*250+200*25+100*1000 {
		t.Fatalf("cached credits = %d", got)
	}
	if invalid := CreditsForTokens(rates, KindLLM, 1000, 0, 2000); invalid != 1000*250 {
		t.Fatalf("invalid cache must charge full input: %d", invalid)
	}
}

func TestEmbeddingRatesFailsWithoutRegistry(t *testing.T) {
	s := &Store{}
	if _, err := s.EmbeddingRates(t.Context(), "ws_1"); err == nil {
		t.Fatal("nil registry must fail")
	}
}

func TestCreditsForParsePagesUsesOCRRateInsteadOfAddingBoth(t *testing.T) {
	if got := CreditsForParsePages(3, 1, 31_000_000, 52_000_000); got != 114_000_000 {
		t.Fatalf("CreditsForParsePages(3, 1) = %d, want 114000000", got)
	}
	if got := CreditsForParsePages(1, 9, 31_000_000, 52_000_000); got != 52_000_000 {
		t.Fatalf("CreditsForParsePages clamps OCR pages: %d", got)
	}
}

func TestCreditsForAudioSecondsUsesRoundedProviderUnit(t *testing.T) {
	if got := CreditsForAudioSeconds(61, 250_000); got != 15_250_000 {
		t.Fatalf("61 audio seconds = %d, want 15250000", got)
	}
	if got := CreditsForAudioSeconds(-1, 250_000); got != 0 {
		t.Fatalf("negative audio seconds = %d, want 0", got)
	}
}
