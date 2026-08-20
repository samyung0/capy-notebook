package store

import "github.com/evonotes/server/internal/models"

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

	// Embeddings are cheap and run in bulk during ingest; pricing them near
	// zero avoids a single large upload consuming a month's allowance.
	baseMicrosPerEmbeddingToken int64 = 50

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

// TokenRates is the credit (and optional USD) multiplier for one resolved
// model config. Zero values mean "use the 1x Flash reference".
type TokenRates struct {
	MicrosPerInputToken     int64
	MicrosPerOutputToken    int64
	USDMicrosPerInputToken  int64
	USDMicrosPerOutputToken int64
	ModelKey                string
	ModelVersion            int
}

func DefaultLLMRates() TokenRates {
	return TokenRates{
		MicrosPerInputToken:  baseMicrosPerInputToken,
		MicrosPerOutputToken: baseMicrosPerOutputToken,
	}
}

func DefaultEmbeddingRates() TokenRates {
	return TokenRates{
		MicrosPerInputToken:  baseMicrosPerEmbeddingToken,
		MicrosPerOutputToken: baseMicrosPerEmbeddingToken,
	}
}

func RatesFromConfig(cfg models.Config) TokenRates {
	rates := TokenRates{
		MicrosPerInputToken:     cfg.MicrosPerInputToken,
		MicrosPerOutputToken:    cfg.MicrosPerOutputToken,
		USDMicrosPerInputToken:  cfg.USDMicrosPerInputToken,
		USDMicrosPerOutputToken: cfg.USDMicrosPerOutputToken,
		ModelKey:                cfg.Key,
		ModelVersion:            cfg.Version,
	}
	if rates.MicrosPerInputToken <= 0 {
		rates.MicrosPerInputToken = baseMicrosPerInputToken
	}
	if rates.MicrosPerOutputToken <= 0 {
		rates.MicrosPerOutputToken = baseMicrosPerOutputToken
	}
	return rates
}

// CreditsForTokens prices a completion from the resolved config. Embeddings
// use the config's input rate for both sides because they have no output.
func CreditsForTokens(rates TokenRates, kind string, inputTokens, outputTokens int64) int64 {
	if rates.MicrosPerInputToken == 0 && rates.MicrosPerOutputToken == 0 {
		rates = DefaultLLMRates()
	}
	if kind == KindEmbedding {
		per := rates.MicrosPerInputToken
		if per == 0 {
			per = baseMicrosPerEmbeddingToken
		}
		return (inputTokens + outputTokens) * per
	}
	return inputTokens*rates.MicrosPerInputToken + outputTokens*rates.MicrosPerOutputToken
}

// CostMicroUSD is reconciliation-only. Unit of the rate fields is micro-USD
// per million tokens, so the result is micro-USD.
func CostMicroUSD(rates TokenRates, inputTokens, outputTokens int64) int64 {
	return (inputTokens*rates.USDMicrosPerInputToken + outputTokens*rates.USDMicrosPerOutputToken) / 1_000_000
}

// CreditsForCaption prices one vision call, with the per-token component on
// top of the fixed floor.
func CreditsForCaption(rates TokenRates, inputTokens, outputTokens int64) int64 {
	return microsPerCaptionCall + CreditsForTokens(rates, KindLLM, inputTokens, outputTokens)
}

func CreditsForGPU(gpuMillis int64) int64 {
	return gpuMillis * microsPerGPUSecond / 1000
}

func CreditsForEmail(count int64) int64 { return count * microsPerEmail }

// ScaleEstimate multiplies a 1x reserve estimate by the pinned model's output
// multiplier so a Pro reservation holds proportionally more.
func ScaleEstimate(baseMicros int64, rates TokenRates) int64 {
	mult := rates.MicrosPerOutputToken
	if mult <= 0 {
		mult = baseMicrosPerOutputToken
	}
	return baseMicros * mult / baseMicrosPerOutputToken
}

// Spend estimates used by the reserve step. They only need to be the right
// order of magnitude: settlement replaces them with measured cost, and their
// job is to stop unbounded concurrent requests from each reading an empty
// ledger. Callers scale them with ScaleEstimate when the pinned model is not 1x.
const (
	// A chat turn runs an agent loop of up to EVO_AGENT_MAX_STEPS (12) model
	// calls plus embeddings. Each round re-sends the transcript, so a 12-step
	// turn is ~8x a 4-step one; under-reserving lets concurrent turns each
	// read a ledger missing the spend they are about to incur.
	EstimateChatMicros = 48 * MicrosPerCredit
	// Generate produces a whole material and may map-reduce across files.
	EstimateGenerateMicros = 12 * MicrosPerCredit
	// Editor commands are single short completions.
	EstimateEditorMicros = 2 * MicrosPerCredit
	// Open-question marking is one short JSON completion.
	EstimateQuizMicros = EstimateEditorMicros
	// Ingest is not reserved (post-hoc), but upload gating uses this as the
	// "is there anything left" threshold via AssertCreditsAvailable.
	EstimateIngestMicros = 4 * MicrosPerCredit
)
