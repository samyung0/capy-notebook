package httpapi

import (
	"encoding/json"
	"testing"
)

// replace_block converts its markdown like insert_markdown and keeps the
// block it replaces and the text that block must still read.
func TestReplaceBlockConvertsItsMarkdown(t *testing.T) {
	converted := []any{map[string]any{"id": "n1", "type": "h2", "children": []any{map[string]any{"text": "Mean"}}}}
	commands, err := normalizeMaterialCommands("note", []json.RawMessage{json.RawMessage(
		`{"type":"replace_block","block_id":"b1","expected_text":"Average","markdown":"## Mean"}`,
	)}, func(i int, markdown string) ([]any, error) {
		if i != 0 || markdown != "## Mean" {
			t.Fatalf("converted command %d %q", i, markdown)
		}
		return converted, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var command struct {
		Type         string           `json:"type"`
		BlockID      string           `json:"blockId"`
		ExpectedText string           `json:"expectedText"`
		Blocks       []map[string]any `json:"blocks"`
	}
	if err := json.Unmarshal(commands[0], &command); err != nil {
		t.Fatal(err)
	}
	if command.Type != "replace_block" || command.BlockID != "b1" || command.ExpectedText != "Average" ||
		len(command.Blocks) != 1 || command.Blocks[0]["id"] != "n1" {
		t.Fatalf("normalized = %+v", command)
	}
	if _, err := normalizeMaterialCommands("quiz", []json.RawMessage{json.RawMessage(
		`{"type":"replace_block","block_id":"b1","expected_text":"x","markdown":"y"}`,
	)}, nil); err == nil {
		t.Fatal("replace_block accepted on a quiz")
	}
}
