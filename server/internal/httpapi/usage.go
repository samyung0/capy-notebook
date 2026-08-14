package httpapi

import (
	"encoding/json"

	"github.com/evonotes/server/internal/store"
)

// pipeUsage is the token accounting the Python services report back. Every
// model-backed pipeline response carries one, aggregated across all provider
// calls the request made — a chat turn's agent loop is several completions plus
// embeddings, and the browser should be charged for the turn, not the steps.
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
func (u pipeUsage) events(actorUserID, workspaceID, surface string) []store.UsageEvent {
	if u.empty() {
		return nil
	}
	var out []store.UsageEvent
	if u.InputTokens > 0 || u.OutputTokens > 0 {
		out = append(out, store.UsageEvent{
			ActorUserID:  actorUserID,
			WorkspaceID:  workspaceID,
			Kind:         store.KindLLM,
			Surface:      surface,
			Provider:     u.Provider,
			Model:        u.Model,
			InputTokens:  u.InputTokens,
			OutputTokens: u.OutputTokens,
			Unit:         "tokens",
			CreditMicros: store.CreditsForTokens(store.KindLLM, u.InputTokens, u.OutputTokens),
			Metadata:     map[string]any{"calls": u.Calls},
		})
	}
	if u.EmbedTokens > 0 {
		out = append(out, store.UsageEvent{
			ActorUserID:  actorUserID,
			WorkspaceID:  workspaceID,
			Kind:         store.KindEmbedding,
			Surface:      surface,
			Provider:     u.Provider,
			InputTokens:  u.EmbedTokens,
			Unit:         "tokens",
			CreditMicros: store.CreditsForTokens(store.KindEmbedding, u.EmbedTokens, 0),
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
