package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/store"
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

// A mindmap's or diagram's Mermaid block changes through replace_block, as a
// note's does; set_mermaid is gone and nothing else edits them (Epo
// 2026-10-21).
func TestADiagramTakesReplaceBlockOnly(t *testing.T) {
	fence := func(int, string) ([]any, error) {
		return []any{map[string]any{"id": "m2", "type": "mermaid"}}, nil
	}
	for _, kind := range []string{"mindmap", "diagram"} {
		if _, err := normalizeMaterialCommands(kind, []json.RawMessage{json.RawMessage(
			`{"type":"replace_block","block_id":"m1","expected_text":"","markdown":"` + "```mermaid\\nflowchart LR\\n  A --> B\\n```" + `"}`,
		)}, fence); err != nil {
			t.Fatalf("%s replace_block: %v", kind, err)
		}
		for _, command := range []string{
			`{"type":"set_mermaid","expected_source":"a","source":"b"}`,
			`{"type":"insert_markdown","after_block_id":null,"markdown":"x"}`,
			`{"type":"remove_block","block_id":"m1","expected_text":""}`,
		} {
			_, err := normalizeMaterialCommands(kind, []json.RawMessage{json.RawMessage(command)}, fence)
			var refused *store.EditRefusal
			if !errors.As(err, &refused) || refused.Code != agenttools.ErrUnsupportedOperation {
				t.Fatalf("%s %.30s: %v", kind, command, err)
			}
		}
	}
	if got := materialOperations("diagram"); len(got) != 1 || got[0] != "replace_block" {
		t.Fatalf("diagram operations = %v", got)
	}
}

// The agent's card commands refuse an over-long front or back with a clear
// message before any document is built (security regression: a stored set
// Go cannot project breaks the material for everyone).
func TestCardCommandsRefuseOverLongText(t *testing.T) {
	long := func(n int) string { return strings.Repeat("é", n+1) }
	cases := []struct{ command, message string }{
		{`{"type":"add_card","front":"` + long(materialdoc.MaxCardFrontRunes) + `","back":"b"}`, "add_card: a flashcard front holds at most 200 characters"},
		{`{"type":"add_card","front":"f","back":"` + long(materialdoc.MaxCardBackRunes) + `"}`, "add_card: a flashcard back holds at most 1000 characters"},
		{`{"type":"replace_card","card_id":"c1","back":"` + long(materialdoc.MaxCardBackRunes) + `","expected_back":"b"}`, "replace_card: a flashcard back holds at most 1000 characters"},
	}
	for _, tc := range cases {
		_, err := normalizeMaterialCommands("flashcards", []json.RawMessage{json.RawMessage(tc.command)}, nil)
		var refused *store.EditRefusal
		if !errors.As(err, &refused) || refused.Code != agenttools.ErrInvalidInput || refused.Message != tc.message {
			t.Fatalf("%.40s: %v", tc.command, err)
		}
	}
	if _, err := normalizeMaterialCommands("flashcards", []json.RawMessage{json.RawMessage(
		`{"type":"add_card","front":"` + strings.Repeat("é", materialdoc.MaxCardFrontRunes) + `","back":"` + strings.Repeat("é", materialdoc.MaxCardBackRunes) + `"}`,
	)}, nil); err != nil {
		t.Fatalf("a card at the caps: %v", err)
	}
}

// replace_card sends only the sides it replaces, each with what it expects
// there, so the collaboration server keeps the other side and the image as
// the live set holds them (Epo 2026-10-21: the stored set may lag typing);
// a side sent without its expectation is refused.
func TestReplaceCardSendsOnlyItsSidesWithTheirExpectations(t *testing.T) {
	commands, err := normalizeMaterialCommands("flashcards", []json.RawMessage{json.RawMessage(
		`{"type":"replace_card","card_id":"c1","back":"Water moves to the higher solute side","expected_back":"old"}`,
	)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var command map[string]any
	if err := json.Unmarshal(commands[0], &command); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"type": "replace_card", "cardId": "c1", "front": nil, "expectedFront": nil,
		"back": "Water moves to the higher solute side", "expectedBack": "old",
	}
	if fmt.Sprint(command) != fmt.Sprint(want) {
		t.Fatalf("normalized = %v, want %v", command, want)
	}
	for side, raw := range map[string]string{
		"front": `{"type":"replace_card","card_id":"c1","front":"f"}`,
		"back":  `{"type":"replace_card","card_id":"c1","back":"b","expected_front":"f"}`,
	} {
		_, err := normalizeMaterialCommands("flashcards", []json.RawMessage{json.RawMessage(raw)}, nil)
		var refused *store.EditRefusal
		if !errors.As(err, &refused) || refused.Code != agenttools.ErrInvalidInput ||
			refused.Message != "replace_card: send expected_"+side+" with "+side {
			t.Fatalf("%s without its expectation: %v", side, err)
		}
	}
}

// Converted note blocks the document check refuses reach the model as an
// invalid_input refusal naming the rule, not an unmapped 500 it reads as an
// unknown outcome; a refusal already typed passes through.
func TestNoteEditDocumentErrorsAreRefusals(t *testing.T) {
	var typed *store.EditRefusal
	err := documentRefusal(fmt.Errorf("%w: a note cannot hold a slide block", materialdoc.ErrInvalid))
	if !errors.As(err, &typed) || typed.Code != agenttools.ErrInvalidInput ||
		typed.Message != "invalid material document: a note cannot hold a slide block" {
		t.Fatalf("err = %#v", err)
	}
	stale := refusal(agenttools.ErrStaleTarget, "changed")
	if got := documentRefusal(stale); got != stale {
		t.Fatalf("a typed refusal was rewrapped: %v", got)
	}
}
