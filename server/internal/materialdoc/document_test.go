package materialdoc

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestQuizRoundTripPreservesEveryQuestionTypeAndGrading(t *testing.T) {
	questions := json.RawMessage(`[
		{"id":"q1","type":"mcq","level":"recall","prompt":"Pick one","options":[{"value":"A","explanation":"yes"},{"value":"B","explanation":"no"}],"correct":[0]},
		{"id":"q2","type":"multi","level":"application","prompt":"Pick many","options":[{"value":"A"},{"value":"B"},{"value":"C"}],"correct":[0,2]},
		{"id":"q3","type":"boolean","level":"recall","prompt":"True?","correct":false,"explanation":"Because."},
		{"id":"q4","type":"fill","level":"application","prompt":"Fill","accepted":[{"value":"alpha"},{"value":"beta"}]},
		{"id":"q5","type":"short","level":"analysis","prompt":"Explain","accepted":[{"value":"answer"}]},
		{"id":"q6","type":"matching","level":"application","prompt":"Match","pairs":[{"left":"A","right":"1"},{"left":"B","right":"2"}]},
		{"id":"q7","type":"ordering","level":"analysis","prompt":"Order","items":[{"value":"First"},{"value":"Second"}]}
	]`)
	limit := 20
	raw, err := QuizDocument("Quiz", questions, &limit)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, `"questions"`) {
		t.Fatalf("opaque questions property was persisted: %s", raw)
	}
	got, gotLimit, err := ExtractQuiz(raw)
	if err != nil {
		t.Fatal(err)
	}
	if gotLimit == nil || *gotLimit != limit {
		t.Fatalf("time limit = %v", gotLimit)
	}
	var wantValue, gotValue any
	if err := json.Unmarshal(questions, &wantValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(wantValue, gotValue) {
		t.Fatalf("question grading payload changed:\nwant %#v\ngot  %#v", wantValue, gotValue)
	}
}

func TestQuizUsesTypedAnnotatableDescendants(t *testing.T) {
	raw, err := QuizDocument("Quiz", json.RawMessage(
		`[{"id":"q1","type":"mcq","level":"recall","prompt":"Prompt","options":[{"value":"A"},{"value":"B"}],"correct":[1],"explanation":"Why"}]`,
	), nil)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	quiz := find(doc.Value, "quiz")
	question := quiz["children"].([]any)[0].(map[string]any)
	if question["type"] != "quiz_question" || question["questionType"] != "mcq" {
		t.Fatalf("unexpected question node: %#v", question)
	}
	if firstChild(question, "quiz_prompt") == nil ||
		len(childrenOfType(question, "quiz_option")) != 2 ||
		firstChild(question, "quiz_explanation") == nil {
		t.Fatalf("question descendants are incomplete: %#v", question["children"])
	}
	if got, _ := stringArray(question["correctOptionIds"]); !reflect.DeepEqual(got, []string{"q1:option:2"}) {
		t.Fatalf("correct option IDs = %#v", got)
	}
}

func TestReplacePreservesRichTextButNotRuntimeCommentMarks(t *testing.T) {
	raw, err := QuizDocument("Quiz", json.RawMessage(
		`[{"id":"q1","type":"mcq","level":"recall","prompt":"Prompt","options":[{"value":"A"},{"value":"B"}],"correct":[0]}]`,
	), nil)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := Parse(raw)
	prompt := firstChild(find(doc.Value, "quiz_question"), "quiz_prompt")
	prompt["children"] = []any{
		map[string]any{"text": "Pro", "bold": true},
		map[string]any{"text": "mpt", "comment": "disc_1"},
	}
	raw, err = Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	questions, _, err := ExtractQuiz(raw)
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := ReplaceQuiz(raw, questions, nil)
	if err != nil {
		t.Fatal(err)
	}
	reparsed, _ := Parse(replaced)
	leaves := firstChild(find(reparsed.Value, "quiz_question"), "quiz_prompt")["children"].([]any)
	if len(leaves) != 2 || leaves[0].(map[string]any)["bold"] != true ||
		leaves[1].(map[string]any)["comment"] != nil {
		t.Fatalf("quiz marks were not normalized correctly: %#v", leaves)
	}
}

func TestFlashcardsReplacePreservesCardIDsAndAnnotations(t *testing.T) {
	raw, err := FlashcardsDocument("Deck", []Card{{ID: "c_1", Front: "A", Back: "B"}})
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := Parse(raw)
	back := firstChild(find(doc.Value, "flashcard"), "flashcard_back")
	back["children"] = []any{map[string]any{"text": "B", "highlight": true}}
	raw, err = Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = ReplaceFlashcards(raw, []Card{{ID: "c_1", Front: "A2", Back: "B"}})
	if err != nil {
		t.Fatal(err)
	}
	cards, err := ExtractFlashcards(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(cards) != 1 || cards[0].ID != "c_1" || cards[0].Front != "A2" {
		t.Fatalf("unexpected cards: %#v", cards)
	}
	doc, _ = Parse(raw)
	back = firstChild(find(doc.Value, "flashcard"), "flashcard_back")
	leaf := back["children"].([]any)[0].(map[string]any)
	if leaf["highlight"] != true {
		t.Fatalf("unchanged back annotations were lost: %#v", leaf)
	}
}

func TestRewriteFlashcardIDsStripsRuntimeCommentMarks(t *testing.T) {
	raw, err := FlashcardsDocument("Deck", []Card{{ID: "c_old", Front: "Front", Back: "Back"}})
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := Parse(raw)
	front := firstChild(find(doc.Value, "flashcard"), "flashcard_front")
	front["children"] = []any{map[string]any{"text": "Front", "comment": "disc_1"}}
	raw, _ = Marshal(doc)
	idMap := map[string]string{}
	rewritten, ids, err := RewriteFlashcardIDs(raw, idMap, func() string { return "c_new" })
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"c_new"}) || idMap["c_old"] != "c_new" {
		t.Fatalf("unexpected mapping: %#v / %#v", ids, idMap)
	}
	reparsed, _ := Parse(rewritten)
	card := find(reparsed.Value, "flashcard")
	leaf := firstChild(card, "flashcard_front")["children"].([]any)[0].(map[string]any)
	if card["id"] != "c_new" || leaf["comment"] != nil {
		t.Fatalf("rewrite lost ID or retained comment metadata: %#v / %#v", card, leaf)
	}
}

func TestValidationRejectsOpaqueAndVoidCustomElements(t *testing.T) {
	cases := []Envelope{
		{
			SchemaVersion: 1,
			Value: []map[string]any{{
				"type": "quiz", "id": "quiz_1", "questions": []any{},
				"children": []any{textLeaf("")},
			}},
		},
		{
			SchemaVersion: 1,
			Value: []map[string]any{{
				"type": "flashcards", "id": "deck_1", "cards": []any{},
				"children": []any{textLeaf("")},
			}},
		},
		{
			SchemaVersion: 1,
			Value: []map[string]any{{
				"type": "mermaid", "id": "mermaid_1", "code": "A-->B",
				"children": []any{textElement("mermaid_caption", "")},
			}},
		},
		{SchemaVersion: 1, Value: []map[string]any{{"type": "p", "children": []any{}}}},
	}
	for i, doc := range cases {
		if err := Validate(doc); !errors.Is(err, ErrInvalid) {
			t.Fatalf("case %d: expected ErrInvalid, got %v", i, err)
		}
	}
}

func TestValidateKindRequiresTypedElement(t *testing.T) {
	raw, err := Marshal(Empty())
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(raw, "quiz"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expected missing quiz element to fail, got %v", err)
	}
	if err := ValidateKind(raw, "note"); err != nil {
		t.Fatalf("generic note should be valid: %v", err)
	}
}

func TestValidateKindRequiresUniqueTopLevelBlockIDs(t *testing.T) {
	for name, raw := range map[string]string{
		"missing": `{"schemaVersion":1,"value":[{"type":"p","children":[{"text":"body"}]}]}`,
		"duplicate": `{"schemaVersion":1,"value":[
			{"type":"p","id":"same","children":[{"text":"one"}]},
			{"type":"p","id":"same","children":[{"text":"two"}]}
		]}`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateKind(raw, "note"); !errors.Is(err, ErrInvalid) {
				t.Fatalf("expected invalid top-level block IDs, got %v", err)
			}
		})
	}
}

func TestValidationAcceptsJSONDecodedTimeLimit(t *testing.T) {
	var doc Envelope
	if err := json.Unmarshal([]byte(`{"schemaVersion":1,"value":[{"type":"quiz","id":"quiz_1","timeLimitMin":15,"children":[{"type":"quiz_question","id":"q1","questionType":"boolean","level":"recall","correctBoolean":true,"children":[{"type":"quiz_prompt","children":[{"text":"True?"}]}]}]}]}`), &doc); err != nil {
		t.Fatal(err)
	}
	if err := Validate(doc); err != nil {
		t.Fatalf("JSON-decoded Plate document should validate: %v", err)
	}
}

func TestDiagramContract(t *testing.T) {
	raw, err := FromLegacyMarkdown("diagram", "Flow", "```mermaid\nflowchart LR\nA-->B\n```")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	node := find(doc.Value, "mermaid")
	if node == nil || node["source"] != "flowchart LR\nA-->B" ||
		node["id"] == "" || firstChild(node, "mermaid_caption") == nil {
		t.Fatalf("unexpected diagram node: %#v", node)
	}
	if _, hasCode := node["code"]; hasCode {
		t.Fatalf("legacy code property survived: %#v", node)
	}
}

func TestSuggestionTreeScansInlineAndBlockMetadata(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[
		{"type":"p","id":"block-a","children":[
			{"text":"old","suggestion":true,"suggestion_remove":{"id":"remove","type":"remove","userId":"u"}},
			{"text":"new","suggestion":true,"suggestion_insert":{"id":"insert","type":"insert","userId":"u"}}
		]},
		{"type":"p","id":"block-b","suggestion":{"id":"whole","type":"insert","userId":"u"},"children":[{"text":"block"}]},
		{"type":"p","id":"block-c","suggestion":{"id":"line","type":"insert","isLineBreak":true},"children":[{"text":""}]}
	]}`
	changes, err := ScanSuggestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 4 {
		t.Fatalf("changes = %#v", changes)
	}
	if changes[0].BlockID != "block-a" || changes[0].PlateSuggestionID != "insert" ||
		changes[1].BlockID != "block-a" || changes[1].PlateSuggestionID != "remove" {
		t.Fatalf("inline insertion was not projected: %#v", changes[0])
	}
	if changes[2].BlockID != "block-b" || changes[2].PlateSuggestionID != "whole" {
		t.Fatalf("block suggestion was not projected: %#v", changes[2])
	}
	if changes[3].BlockID != "block-c" || changes[3].PlateSuggestionID != "line" {
		t.Fatalf("line-break suggestion was not projected: %#v", changes[3])
	}
}

func TestSuggestionTreeDeduplicatesPairedReplacement(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[{"type":"p","id":"block-a","children":[
		{"text":"old","suggestion":true,"suggestion_replace":{"id":"replace","type":"remove"}},
		{"text":"new","suggestion":true,"suggestion_replace":{"id":"replace","type":"insert"}}
	]}]}`
	changes, err := ScanSuggestions(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || changes[0].BlockID != "block-a" ||
		changes[0].PlateSuggestionID != "replace" {
		t.Fatalf("paired replacement was not deduplicated correctly: %#v", changes)
	}
}

func TestSuggestionTreeRequiresStableTopLevelBlockID(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[{"type":"p","children":[
		{"text":"new","suggestion":true,"suggestion_insert":{"id":"insert","type":"insert"}}
	]}]}`
	if _, err := ScanSuggestions(raw); !errors.Is(err, ErrInvalid) {
		t.Fatalf("missing top-level block id error = %v, want invalid", err)
	}
}

func TestSuggestionProjectionSupportsTargetedReviewAndUpdates(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[{"type":"p","id":"block","children":[
		{"text":"old","bold":true,"suggestion":true,
		 "suggestion_style":{"id":"style","type":"update","properties":{"bold":true},"newProperties":{"italic":true}}},
		{"text":" remove","suggestion":true,"suggestion_remove":{"id":"remove","type":"remove"}},
		{"text":" insert","suggestion":true,"suggestion_insert":{"id":"insert","type":"insert"}}
	]}]}`

	accepted, resolved, pending, err := ResolveSuggestions(raw, []string{"style"}, AcceptSuggestions)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(resolved, []string{"style"}) || !pending {
		t.Fatalf("resolved=%v pending=%v", resolved, pending)
	}
	doc, _ := Parse(accepted)
	leaf := doc.Value[0]["children"].([]any)[0].(map[string]any)
	if leaf["italic"] != true || leaf["bold"] != nil || leaf["suggestion_style"] != nil {
		t.Fatalf("update acceptance was not applied cleanly: %#v", leaf)
	}

	rejected, err := RejectProjection(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc, _ = Parse(rejected)
	children := doc.Value[0]["children"].([]any)
	if len(children) != 2 || children[0].(map[string]any)["bold"] != true ||
		children[1].(map[string]any)["text"] != " remove" {
		t.Fatalf("reject projection is wrong: %#v", children)
	}
	if has, err := HasPendingSuggestions(rejected); err != nil || has {
		t.Fatalf("reject projection remains pending: has=%v err=%v", has, err)
	}
}

func TestSuggestionProjectionPreservesNonEmptySlateStructure(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[{"type":"p","id":"only",
		"suggestion":{"id":"inserted-block","type":"insert"},
		"children":[{"text":""}]}]}`
	rejected, _, pending, err := ResolveSuggestions(raw, nil, RejectSuggestions)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Parse(rejected)
	if err != nil {
		t.Fatal(err)
	}
	if pending || len(doc.Value) != 1 || doc.Value[0]["type"] != "p" {
		t.Fatalf("invalid fallback document: %#v pending=%v", doc, pending)
	}
}

func TestRejectProjectionCoalescesEquivalentSplitTextLeaves(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[{"type":"p","id":"split","children":[
		{"text":"before "},
		{"text":"old","suggestion":true,"suggestion_replace":{"id":"replace","type":"remove"}},
		{"text":"new","suggestion":true,"suggestion_replace":{"id":"replace","type":"insert"}},
		{"text":" after"}
	]}]}`
	rejected, err := RejectProjection(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := Parse(rejected)
	if err != nil {
		t.Fatal(err)
	}
	children := doc.Value[0]["children"].([]any)
	if len(children) != 1 || children[0].(map[string]any)["text"] != "before old after" {
		t.Fatalf("split leaves were not canonicalized: %#v", children)
	}
}
