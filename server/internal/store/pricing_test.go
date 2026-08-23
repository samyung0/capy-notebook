package store

import "testing"

func TestCreditsForTokensDifferByModel(t *testing.T) {
	flash := TokenRates{MicrosPerInputToken: 250, MicrosPerOutputToken: 1000, ModelKey: "deepseek-flash", ModelVersion: 1}
	pro := TokenRates{MicrosPerInputToken: 775, MicrosPerOutputToken: 3100, ModelKey: "deepseek-pro", ModelVersion: 1}
	in, out := int64(1_000), int64(1_000)
	flashC := CreditsForTokens(flash, KindLLM, in, out)
	proC := CreditsForTokens(pro, KindLLM, in, out)
	if flashC != 1_250_000 {
		t.Fatalf("flash credits = %d", flashC)
	}
	if proC <= flashC {
		t.Fatalf("pro (%d) must cost more than flash (%d)", proC, flashC)
	}
}
