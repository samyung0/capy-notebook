package store

import (
	"encoding/json"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
)

// pipeline/tests/test_agent.py pins the same literal: both services must
// derive one operation identity from (assistant message, tool call).
func TestChatOperationIDMatchesPythonFixture(t *testing.T) {
	if got := ChatOperationID("m_1", "call_1"); got != "op_4bf000a1f98d2dcd046acbf1" {
		t.Fatalf("ChatOperationID = %s", got)
	}
	if got := ChatMaterialID("m_1", "call_1"); got != "mat_4bf000a1f98d2dcd" {
		t.Fatalf("ChatMaterialID = %s", got)
	}
}

func TestRequestHashIgnoresKeyOrder(t *testing.T) {
	a, err := RequestHash(map[string]any{"kind": "note", "content": "x", "cards": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := RequestHash(map[string]any{"cards": []any{}, "content": "x", "kind": "note"})
	if err != nil {
		t.Fatal(err)
	}
	c, err := RequestHash(map[string]any{"cards": []any{}, "content": "y", "kind": "note"})
	if err != nil {
		t.Fatal(err)
	}
	if a != b || a == c {
		t.Fatalf("hashes a=%s b=%s c=%s", a, b, c)
	}
}

func TestMergeOperationEffectsAppendsLostCalls(t *testing.T) {
	effect := agenttools.ResourceEffect{
		Operation: agenttools.EffectCreated,
		Resource:  agenttools.ResourceRef{Kind: agenttools.KindMaterial, ID: "mat_1"},
	}
	activity := []ActivityBlock{
		{ID: "b1", Kind: "narration", Text: "thinking"},
		{ID: "c1", Kind: "tool", CallID: "c1", Name: "create_material", Outcome: agenttools.OutcomeUnknown},
	}
	ops := []AgentOperation{
		{ID: "op_1", Kind: "create_material", CallID: "c1", Outcome: agenttools.OutcomeSucceeded, Effect: &effect},
		{ID: "op_2", Kind: "create_material", CallID: "c2", Outcome: agenttools.OutcomeSucceeded, Effect: &effect},
	}
	merged := mergeOperationEffects(activity, ops)
	if len(merged) != 3 {
		t.Fatalf("blocks = %d", len(merged))
	}
	if merged[1].Outcome != agenttools.OutcomeSucceeded || len(merged[1].Effects) != 1 || merged[1].Effects[0].OperationID != "op_1" {
		t.Fatalf("existing block not reconciled: %+v", merged[1])
	}
	if merged[2].CallID != "c2" || merged[2].Kind != "tool" || merged[2].Effects[0].OperationID != "op_2" {
		t.Fatalf("lost call not appended: %+v", merged[2])
	}
	// Idempotent: merging the same receipts again does not duplicate effects.
	again := mergeOperationEffects(merged, ops)
	if len(again) != 3 || len(again[1].Effects) != 1 || len(again[2].Effects) != 1 {
		t.Fatalf("merge is not idempotent: %+v", again)
	}
}

func TestActivityBlockLegacyStatusMapsToOutcome(t *testing.T) {
	var blocks []ActivityBlock
	raw := `[{"id":"a","kind":"tool","name":"search_workspace","status":"success"},
		{"id":"b","kind":"tool","name":"read_document","status":"refused"},
		{"id":"c","kind":"narration","text":"thinking"},
		{"id":"d","kind":"tool","name":"trash_file","outcome":"failed","status":"success"},
		{"id":"e","kind":"tool","name":"list_sources"}]`
	if err := json.Unmarshal([]byte(raw), &blocks); err != nil {
		t.Fatal(err)
	}
	got := []agenttools.Outcome{blocks[0].Outcome, blocks[1].Outcome, blocks[2].Outcome, blocks[3].Outcome, blocks[4].Outcome}
	want := []agenttools.Outcome{agenttools.OutcomeSucceeded, agenttools.OutcomeRefused, "", agenttools.OutcomeFailed, agenttools.OutcomeUnknown}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("block %d outcome = %q, want %q", i, got[i], want[i])
		}
	}
}
