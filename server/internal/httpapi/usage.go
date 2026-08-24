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
	Calls            int    `json:"calls,omitempty"`
	CachedReadTokens int64  `json:"cachedReadTokens,omitempty"`
	CacheWriteTokens int64  `json:"cacheWriteTokens,omitempty"`
	ReasoningTokens  int64  `json:"reasoningTokens,omitempty"`
	CacheAnomaly     string `json:"cacheAnomaly,omitempty"`
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
	var out []store.UsageEvent
	if u.InputTokens > 0 || u.OutputTokens > 0 {
		credits := store.CreditsForTokens(llm, store.KindLLM, u.InputTokens, u.OutputTokens, u.CachedReadTokens)
		if paidBy == modelsPaidByUser {
			credits = 0
		}
		meta := map[string]any{"calls": u.Calls, "paidBy": paidBy}
		if u.CachedReadTokens > 0 {
			meta["cachedReadTokens"] = u.CachedReadTokens
		}
		if u.CacheWriteTokens > 0 {
			meta["cacheWriteTokens"] = u.CacheWriteTokens
		}
		if u.ReasoningTokens > 0 {
			meta["reasoningTokens"] = u.ReasoningTokens
		}
		if u.CacheAnomaly != "" {
			meta["cacheAnomaly"] = u.CacheAnomaly
		}
		out = append(out, store.UsageEvent{
			ActorUserID:  actorUserID,
			WorkspaceID:  workspaceID,
			Kind:         store.KindLLM,
			Surface:      surface,
			Provider:     u.Provider,
			Model:        u.Model,
			ModelKey:     llm.ModelKey,
			ModelVersion: llm.ModelVersion,
			InputTokens:  u.InputTokens,
			OutputTokens: u.OutputTokens,
			Unit:         "tokens",
			CreditMicros: credits,
			Metadata:     meta,
		})
	}
	if u.EmbedTokens > 0 {
		// Query embeddings are absorbed: recorded at zero credits. Rates must
		// already be the workspace pin resolved before beginSpend. A missing
		// pin should have failed the request. Ingest still charges through
		// the worker.
		out = append(out, store.UsageEvent{
			ActorUserID:  actorUserID,
			WorkspaceID:  workspaceID,
			Kind:         store.KindEmbedding,
			Surface:      surface,
			Provider:     u.Provider,
			ModelKey:     embed.ModelKey,
			ModelVersion: embed.ModelVersion,
			InputTokens:  u.EmbedTokens,
			Unit:         "tokens",
			CreditMicros: 0,
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
