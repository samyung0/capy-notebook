package store

import (
	"context"
	"fmt"

	"github.com/evonotes/server/internal/models"
)

// Credit pricing. User charges are policy, expressed in micro-credits, where
// one credit is 1000 output tokens of the 1x chat model (DeepSeek Flash).
//
// Per-model multipliers live on model_configs and are read through the
// registry. The constants below are the 1x reference and the non-token rates
// (GPU, mail, the caption floor) that are not model-specific.
//
// They are intentionally not derived from provider invoices. Provider prices
// move, are quoted in different currencies and units, and some (cached input,
// reasoning tokens) are not visible at the call site at all. Deriving user
// charges from them would make a supplier price change silently reprice the
// product. Drift against real spend is found by comparing this ledger to
// provider dashboards during reconciliation.

const (
	// 1x reference: 1 credit per 1k output tokens of the standard chat model.
	baseMicrosPerOutputToken int64 = 1_000
	baseMicrosPerInputToken  int64 = 250

	// Vision calls carry a fixed floor because image tokens are reported
	// inconsistently across providers.
	microsPerCaptionCall = 2_000 // 2 credits per figure caption

	// Modal parse wall time (CPU Marker + RapidOCR). Parsing a large PDF is
	// the single most expensive thing an upload triggers, so it is priced
	// to be visible. Ledger kind stays parse_gpu.
	microsPerGPUSecond = 500_000 // 0.5 credits per parse-second

	// Mail is nearly free per message but is the easiest thing to abuse via
	// invite spam, so it is metered.
	microsPerEmail = 100_000 // 0.1 credits per message
)

// TokenRates is the credit multiplier for one resolved model config.
// Zeros stay zeros; they are not filled with the Flash 1x reference.
type TokenRates struct {
	MicrosPerInputToken       int64
	MicrosPerOutputToken      int64
	MicrosPerCachedInputToken int64
	ModelKey                  string
	ModelVersion              int
}

// EmbeddingRates is the catalog row the workspace is pinned to. Query
// embeddings are recorded at zero credits; these rates only label the
// usage_event. The live registry default is the wrong answer after a
// retarget: old workspaces still run the old model.
//
// A missing workspace, empty pin, catalog miss, or non-embedding row is an
// error. Callers must fail the request rather than substituting a default.
func (s *Store) EmbeddingRates(ctx context.Context, workspaceID string) (TokenRates, error) {
	if s.registry == nil {
		return TokenRates{}, fmt.Errorf("%w: registry not configured", ErrModelUnavailable)
	}
	if workspaceID == "" {
		return TokenRates{}, fmt.Errorf("%w: missing workspace for embedding", ErrModelUnavailable)
	}
	var pin models.Pin
	err := s.pool.QueryRow(ctx,
		`SELECT embedding_model_key, embedding_model_version FROM workspaces WHERE id=$1`,
		workspaceID,
	).Scan(&pin.Key, &pin.Version)
	if err != nil {
		return TokenRates{}, fmt.Errorf("%w: workspace embedding pin: %v", ErrModelUnavailable, err)
	}
	if pin.Zero() {
		return TokenRates{}, fmt.Errorf("%w: empty workspace embedding pin", ErrModelUnavailable)
	}
	cfg, err := s.registry.Get(ctx, pin.Key, pin.Version)
	if err != nil {
		return TokenRates{}, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
	}
	if !cfg.Allows(models.SurfaceEmbedding) {
		return TokenRates{}, fmt.Errorf("%w: %s v%d is not an embedding model", ErrModelUnavailable, cfg.Key, cfg.Version)
	}
	return RatesFromConfig(cfg), nil
}

func RatesFromConfig(cfg models.Config) TokenRates {
	return TokenRates{
		MicrosPerInputToken:       cfg.MicrosPerInputToken,
		MicrosPerOutputToken:      cfg.MicrosPerOutputToken,
		MicrosPerCachedInputToken: cfg.MicrosPerCachedInputToken,
		ModelKey:                  cfg.Key,
		ModelVersion:              cfg.Version,
	}
}

// CreditsForTokens prices a completion from the given rates:
// (input-cached)*input + cached*cache + output*output.
// Invalid cached counts (negative or greater than input) are charged as
// ordinary input. Embeddings use the input rate for leftover output tokens.
// Zero rates stay zero; this does not invent Flash or embedding fills.
func CreditsForTokens(rates TokenRates, kind string, inputTokens, outputTokens, cachedRead int64) int64 {
	cached := cachedRead
	if cached < 0 || cached > inputTokens {
		cached = 0
	}
	uncached := inputTokens - cached
	if kind == KindEmbedding {
		return uncached*rates.MicrosPerInputToken + cached*rates.MicrosPerCachedInputToken + outputTokens*rates.MicrosPerInputToken
	}
	return uncached*rates.MicrosPerInputToken + cached*rates.MicrosPerCachedInputToken + outputTokens*rates.MicrosPerOutputToken
}

// CreditsForCaption prices one vision call, with the per-token component on
// top of the fixed floor.
func CreditsForCaption(rates TokenRates, inputTokens, outputTokens int64) int64 {
	return microsPerCaptionCall + CreditsForTokens(rates, KindLLM, inputTokens, outputTokens, 0)
}

func CreditsForGPU(gpuMillis int64) int64 {
	return gpuMillis * microsPerGPUSecond / 1000
}

func CreditsForEmail(count int64) int64 { return count * microsPerEmail }
