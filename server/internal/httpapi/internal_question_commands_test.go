package httpapi

import (
	"encoding/json"
	"testing"
)

func TestQuizQuestionCommandPreservesTargetIdentity(t *testing.T) {
	for _, kind := range []string{"replace_question", "remove_question"} {
		_, err := normalizeMaterialCommands("quiz", []json.RawMessage{json.RawMessage(`{"type":"` + kind + `","question_id":""}`)})
		if err == nil {
			t.Fatalf("%s accepted missing target", kind)
		}
	}
	commands, err := normalizeMaterialCommands("quiz", []json.RawMessage{json.RawMessage(`{"type":"replace_question","question_id":"existing","question":{"id":"model-id","stem":[],"parts":[{"id":"part1","blocks":[{"type":"text","text":"True?"}],"answer":{"type":"boolean","correct":true},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}}`)})
	if err != nil {
		t.Fatal(err)
	}
	var command struct {
		NodeID string         `json:"nodeId"`
		Node   map[string]any `json:"node"`
	}
	if err := json.Unmarshal(commands[0], &command); err != nil {
		t.Fatal(err)
	}
	if command.NodeID != "existing" || command.Node["id"] != "existing" || command.Node["question"].(map[string]any)["id"] != "existing" {
		t.Fatalf("question identity changed: %#v", command)
	}
}

// A curate turn writes a material in several edits, so the second edit's books
// are appended to the record the creation stored rather than replacing it. The
// gateway merges and revalidates, then hands the authority the record it
// commits with the content.
