package httpapi

import (
	"encoding/json"
)

// pipeUsage is the token accounting the Python services report back. Completions
// and embeddings are settled per provider call, not from this envelope.
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
