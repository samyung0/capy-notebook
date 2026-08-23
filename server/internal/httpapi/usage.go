package httpapi

import (
	"encoding/json"

	"github.com/evonotes/server/internal/models"
	"github.com/evonotes/server/internal/store"
)

const (
	modelsPaidByPlatform = models.PaidByPlatform
	modelsPaidByUser     = models.PaidByUser
)

// pipeUsage is the token accounting the Python services report back. Every
// model-backed pipeline response carries one, aggregated across all provider
// calls the request made. Completions bill the actor. Query embeddings are
// recorded at zero credits.
//
// Absent or zero usage is normal and not an error: a provider may omit it, and
// a streamed response only reports it when the stream is asked to include it.
// Those requests settle at zero rather than being estimated, because a made-up
// charge is worse than an undercharge that reconciliation can find.
type pipeUsage struct {
	Provider     string `json:"provider,omitempty"`
	Model        string `json:"model,omitempty"`
	InputTokens  int64  `json:"inputTokens,omitempty"`
	OutputTokens int64  `json:"outputTokens,omitempty"`
	// EmbedTokens is separated because embeddings are priced an order of
	// magnitude below completions.
	EmbedTokens int64 `json:"embedTokens,omitempty"`
	// Calls is how many provider round trips the request made, kept for
	// diagnosing agent loops that run longer than expected.
	Calls int `json:"calls,omitempty"`
}

func (u pipeUsage) empty() bool {
	return u.InputTokens == 0 && u.OutputTokens == 0 && u.EmbedTokens == 0
}

// events converts reported usage into ledger rows. Completions and embeddings
// become separate rows so a dashboard can show which one is actually driving
// spend, rather than one blended number that hides it.
func (u pipeUsage) events(actorUserID, workspaceID, surface string, llm, embed store.TokenRates, paidBy string) []store.UsageEvent {
	if u.empty() {
		return nil
	}
	if paidBy == "" {
		paidBy = modelsPaidByPlatform
	}
	var out []store.UsageEvent
	if u.InputTokens > 0 || u.OutputTokens > 0 {
		rates := llm
		if rates.MicrosPerOutputToken == 0 && paidBy != modelsPaidByUser {
			rates = store.DefaultLLMRates()
		}
		credits := store.CreditsForTokens(rates, store.KindLLM, u.InputTokens, u.OutputTokens)
		cost := store.CostMicroUSD(rates, u.InputTokens, u.OutputTokens)
		if paidBy == modelsPaidByUser {
			credits = 0
			cost = 0
		}
		out = append(out, store.UsageEvent{
			ActorUserID:  actorUserID,
			WorkspaceID:  workspaceID,
			Kind:         store.KindLLM,
			Surface:      surface,
			Provider:     u.Provider,
			Model:        u.Model,
			ModelKey:     rates.ModelKey,
			ModelVersion: rates.ModelVersion,
			InputTokens:  u.InputTokens,
			OutputTokens: u.OutputTokens,
			Unit:         "tokens",
			CreditMicros: credits,
			CostMicroUSD: cost,
			Metadata:     map[string]any{"calls": u.Calls, "paidBy": paidBy},
		})
	}
	if u.EmbedTokens > 0 {
		// Query embeddings are absorbed: recorded for reconciliation, billed
		// at zero credits. Rates must be the workspace pin, not the live
		// default, or a retarget mislabels old-workspace search. Ingest still
		// charges through the worker.
		rates := embed
		if rates.MicrosPerInputToken == 0 {
			rates = store.DefaultEmbeddingRates()
		}
		out = append(out, store.UsageEvent{
			ActorUserID:  actorUserID,
			WorkspaceID:  workspaceID,
			Kind:         store.KindEmbedding,
			Surface:      surface,
			Provider:     u.Provider,
			ModelKey:     rates.ModelKey,
			ModelVersion: rates.ModelVersion,
			InputTokens:  u.EmbedTokens,
			Unit:         "tokens",
			CreditMicros: 0,
			CostMicroUSD: store.CostMicroUSD(rates, u.EmbedTokens, 0),
		})
	}
	return out
}

// usageFrom pulls the usage envelope out of a pipeline JSON response. A missing
// or malformed field yields zero usage rather than an error: metering must
// never be able to fail a request that already produced a result.
func usageFrom(raw json.RawMessage) pipeUsage {
	var envelope struct {
		Usage pipeUsage `json:"usage"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return pipeUsage{}
	}
	return envelope.Usage
}
