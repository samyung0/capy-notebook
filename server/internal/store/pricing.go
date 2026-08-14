package store

// Credit pricing. These are the rates we charge users, expressed in
// micro-credits, where one credit is nominally 1000 output tokens of the
// standard chat model.
//
// They are intentionally not derived from provider invoices. Provider prices
// move, are quoted in different currencies and units, and some (cached input,
// reasoning tokens) are not visible at the call site at all. Deriving user
// charges from them would make a supplier price change silently reprice the
// product. Instead these are fixed policy, and drift against real spend is
// found by comparing this ledger to provider dashboards during reconciliation.
const (
	// Output dominates cost for chat models, so input is discounted rather
	// than free — free input invites prompt-stuffing.
	microsPerOutputToken = 1_000 // 1 credit per 1k output tokens
	microsPerInputToken  = 250   // 0.25 credits per 1k input tokens

	// Embeddings are cheap and run in bulk during ingest; pricing them near
	// zero avoids a single large upload consuming a month's allowance.
	microsPerEmbeddingToken = 50 // 0.05 credits per 1k tokens

	// Vision calls carry a fixed floor because image tokens are reported
	// inconsistently across providers.
	microsPerCaptionCall = 2_000 // 2 credits per figure caption

	// Speech is billed on audio duration, which is what providers charge for.
	microsPerTranscribeSecond = 100_000 / 60 // ~0.1 credits per minute

	// L4 GPU time on Modal. Parsing a large PDF is the single most expensive
	// thing an upload triggers, so it is priced to be visible.
	microsPerGPUSecond = 500_000 // 0.5 credits per GPU-second

	// Mail is nearly free per message but is the easiest thing to abuse via
	// invite spam, so it is metered.
	microsPerEmail = 100_000 // 0.1 credits per message
)

// CreditsForTokens prices a completion. Embeddings use their own rate because
// they are an order of magnitude cheaper and run unattended.
func CreditsForTokens(kind string, inputTokens, outputTokens int64) int64 {
	if kind == KindEmbedding {
		return (inputTokens + outputTokens) * microsPerEmbeddingToken
	}
	return inputTokens*microsPerInputToken + outputTokens*microsPerOutputToken
}

// CreditsForCaption prices one vision call, with the per-token component on top
// of the fixed floor.
func CreditsForCaption(inputTokens, outputTokens int64) int64 {
	return microsPerCaptionCall + CreditsForTokens(KindLLM, inputTokens, outputTokens)
}

func CreditsForTranscribe(durationMillis int64) int64 {
	return durationMillis * microsPerTranscribeSecond / 1000
}

func CreditsForGPU(gpuMillis int64) int64 {
	return gpuMillis * microsPerGPUSecond / 1000
}

func CreditsForEmail(count int64) int64 { return count * microsPerEmail }

// Spend estimates used by the reserve step. They only need to be the right
// order of magnitude: settlement replaces them with measured cost, and their
// job is to stop unbounded concurrent requests from each reading an empty
// ledger.
const (
	// A chat turn runs an agent loop of up to EVO_AGENT_MAX_STEPS model calls
	// plus embeddings, so it is estimated well above a single completion.
	EstimateChatMicros = 6 * MicrosPerCredit
	// Generate produces a whole material and may map-reduce across files.
	EstimateGenerateMicros = 12 * MicrosPerCredit
	// Editor commands are single short completions.
	EstimateEditorMicros = 2 * MicrosPerCredit
	// Transcription is bounded by the upload size cap rather than by tokens.
	EstimateTranscribeMicros = 3 * MicrosPerCredit
)
