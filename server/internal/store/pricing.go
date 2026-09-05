package store

import (
	"context"
	"fmt"

	"github.com/evonotes/server/internal/models"
)

// Token credit pricing. User charges are expressed in micro-credits, where
// one credit is 1000 output tokens of the 1x chat model (DeepSeek Flash).
//
// Per-model multipliers live on model_configs and are read through the
// registry. Non-token rates live in resource_credit_rates so operators can
// change them without a deployment.
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
)

const (
	ResourceAudioSecond      = "audio_transcription_second"
	ResourceDigitalParsePage = "digital_parse_page"
	ResourceOCRParsePage     = "ocr_parse_page"
	ResourceFigureCaption    = "figure_caption_call"
	ResourceEmailMessage     = "email_message"
)

var ingestResourceKeys = []string{
	ResourceAudioSecond,
	ResourceDigitalParsePage,
	ResourceOCRParsePage,
	ResourceFigureCaption,
}

type ResourceRate struct {
	ResourceKey         string `json:"resourceKey"`
	Version             int    `json:"version"`
	Unit                string `json:"unit"`
	CreditMicrosPerUnit int64  `json:"creditMicrosPerUnit"`
}

func (s *Store) ActiveResourceRates(ctx context.Context, keys []string) (map[string]ResourceRate, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT resource_key, version, unit, credit_micros_per_unit
		FROM resource_credit_rates
		WHERE active AND resource_key = ANY($1)`, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rates := make(map[string]ResourceRate, len(keys))
	for rows.Next() {
		var rate ResourceRate
		if err := rows.Scan(&rate.ResourceKey, &rate.Version, &rate.Unit, &rate.CreditMicrosPerUnit); err != nil {
			return nil, err
		}
		rates[rate.ResourceKey] = rate
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, key := range keys {
		if _, ok := rates[key]; !ok {
			return nil, fmt.Errorf("active resource rate %q is missing", key)
		}
	}
	return rates, nil
}

// TokenRates is the credit multiplier for one resolved model config.
// Zeros stay zeros; they are not filled with the Flash 1x reference.
type TokenRates struct {
	MicrosPerInputToken       int64
	MicrosPerOutputToken      int64
	MicrosPerCachedInputToken int64
	Model                     models.Ref
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
		`SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version FROM workspaces WHERE id=$1`,
		workspaceID,
	).Scan(&pin.ProviderSlug, &pin.ModelSlug, &pin.Version)
	if err != nil {
		return TokenRates{}, fmt.Errorf("%w: workspace embedding pin: %v", ErrModelUnavailable, err)
	}
	if pin.Zero() {
		return TokenRates{}, fmt.Errorf("%w: empty workspace embedding pin", ErrModelUnavailable)
	}
	cfg, err := s.registry.Get(ctx, pin.Ref, pin.Version)
	if err != nil {
		return TokenRates{}, fmt.Errorf("%w: %v", ErrModelUnavailable, err)
	}
	if !cfg.Allows(models.SlotRetrieval) {
		return TokenRates{}, fmt.Errorf("%w: %s v%d is not an embedding model", ErrModelUnavailable, cfg.Ref(), cfg.Version)
	}
	return RatesFromConfig(cfg), nil
}

func RatesFromConfig(cfg models.Config) TokenRates {
	return TokenRates{
		MicrosPerInputToken:       cfg.MicrosPerInputToken,
		MicrosPerOutputToken:      cfg.MicrosPerOutputToken,
		MicrosPerCachedInputToken: cfg.MicrosPerCachedInputToken,
		Model:                     cfg.Ref(),
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

func CreditsForParsePages(pages, ocrPages, digitalRate, ocrRate int64) int64 {
	if pages <= 0 {
		return 0
	}
	if ocrPages < 0 {
		ocrPages = 0
	}
	if ocrPages > pages {
		ocrPages = pages
	}
	return (pages-ocrPages)*digitalRate + ocrPages*ocrRate
}

func CreditsForAudioSeconds(seconds, rate int64) int64 {
	if seconds <= 0 {
		return 0
	}
	return seconds * rate
}
