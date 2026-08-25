package materialdoc

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestQuizRoundTripPreservesEveryQuestionTypeAndGrading(t *testing.T) {
	questions := json.RawMessage(`[
		{"id":"q1","type":"mcq","level":"recall","prompt":"Pick one","options":[{"value":"A","explanation":"yes"},{"value":"B","explanation":"no"}],"correct":[0]},
		{"id":"q2","type":"multi","level":"application","prompt":"Pick many","options":[{"value":"A"},{"value":"B"},{"value":"C"}],"correct":[0,2]},
		{"id":"q3","type":"boolean","level":"recall","prompt":"True?","correct":false,"explanation":"Because."},
		{"id":"q4","type":"short","level":"application","prompt":"Answer","accepted":[{"value":"alpha"},{"value":"beta"}]},
		{"id":"q5","type":"matching","level":"application","prompt":"Match","pairs":[{"left":"A","right":"1"},{"left":"B","right":"2"}]},
		{"id":"q6","type":"ordering","level":"analysis","prompt":"Order","items":[{"value":"First"},{"value":"Second"}]},
		{"id":"q7","type":"open","level":"application","prompt":"Explain","accepted":[{"value":"cristae"}],"hints":[{"value":"ATP"}],"rubrics":[{"value":"Mentions folds"}],"points":1}
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

func TestFillQuestionTypeIsRejected(t *testing.T) {
	_, err := QuizDocument("Quiz", json.RawMessage(
		`[{"id":"q1","type":"fill","level":"recall","prompt":"Fill?","accepted":[{"value":"alpha"}]}]`,
	), nil)
	if err == nil {
		t.Fatal("fill type was accepted")
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

func TestMarshalUsesJavaScriptCompatibleUTF8Escaping(t *testing.T) {
	raw, err := Marshal(Envelope{
		SchemaVersion: SchemaVersion,
		Value: []map[string]any{{
			"type":     "p",
			"children": []any{textLeaf("<>&\u2028\u2029")},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "<>&\u2028\u2029") ||
		strings.Contains(raw, `\u003c`) ||
		strings.Contains(raw, `\u2028`) ||
		strings.Contains(raw, `\u2029`) {
		t.Fatalf("JSON escaping does not match JSON.stringify: %q", raw)
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

func TestValidationAcceptsYouTubeEmbedAndRejectsUploadedVideo(t *testing.T) {
	valid := Envelope{
		SchemaVersion: 1,
		Value: []map[string]any{{
			"type": "video", "provider": "youtube", "videoId": "dQw4w9WgXcQ",
			"children": []any{textLeaf("")},
		}},
	}
	if err := Validate(valid); err != nil {
		t.Fatalf("YouTube embed should validate: %v", err)
	}
	for _, node := range []map[string]any{
		{
			"type": "video", "provider": "youtube", "videoId": "short",
			"children": []any{textLeaf("")},
		},
		{
			"type": "video", "provider": "upload", "videoId": "dQw4w9WgXcQ",
			"children": []any{textLeaf("")},
		},
		{
			"type": "video", "provider": "youtube", "videoId": "dQw4w9WgXcQ",
			"assetId": "asset-1", "children": []any{textLeaf("")},
		},
	} {
		if err := Validate(Envelope{SchemaVersion: 1, Value: []map[string]any{node}}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid video node accepted: %v", err)
		}
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

func TestGeneratorReplayIgnoresMintedIDs(t *testing.T) {
	first, err := FromLegacyMarkdown("note", "Replay", "alpha")
	if err != nil {
		t.Fatal(err)
	}
	second, err := FromLegacyMarkdown("note", "Replay", "alpha")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("wrapping the same markdown twice should mint different block ids")
	}
	got, err := ExtractNoteText(first)
	if err != nil {
		t.Fatal(err)
	}
	if got != IncomingNoteText("alpha") || got != IncomingNoteText(second) {
		t.Fatalf("note replay text = %q", got)
	}
	if IncomingNoteText("beta") == got {
		t.Fatal("note mismatch should not compare equal")
	}

	diagram, err := FromLegacyMarkdown("diagram", "Flow", "```mermaid\nflowchart LR\nA-->B\n```")
	if err != nil {
		t.Fatal(err)
	}
	source, err := ExtractMermaidSource(diagram)
	if err != nil {
		t.Fatal(err)
	}
	if source != IncomingMermaidSource("```mermaid\nflowchart LR\nA-->B\n```") {
		t.Fatalf("mermaid replay source = %q", source)
	}
	if IncomingMermaidSource("```mermaid\nflowchart LR\nA-->C\n```") == source {
		t.Fatal("mermaid mismatch should not compare equal")
	}
}

// overLimitEnvelope builds a document whose node count is past MaxNodes.
func overLimitEnvelope() Envelope {
	value := make([]map[string]any, 0, MaxNodes)
	for i := range MaxNodes {
		value = append(value, map[string]any{
			"type":     "p",
			"id":       fmt.Sprintf("block_%d", i),
			"children": []any{textLeaf("x")},
		})
	}
	return Envelope{SchemaVersion: SchemaVersion, Value: value}
}

func TestLimitsGateWritesButNotReads(t *testing.T) {
	doc := overLimitEnvelope()
	// Encode without Marshal so the fixture bypasses the write gate the way a
	// bypassed user, an operator import or a lowered limit would.
	encoded, err := marshalCanonicalJSON(doc)
	if err != nil {
		t.Fatal(err)
	}
	raw := string(encoded)

	parsed, err := Parse(raw)
	if err != nil {
		t.Fatalf("read of an over-limit document failed: %v", err)
	}
	if len(parsed.Value) != len(doc.Value) {
		t.Fatalf("read returned %d nodes, want %d", len(parsed.Value), len(doc.Value))
	}

	metrics, err := Metrics(raw)
	if err != nil {
		t.Fatalf("metrics of an over-limit document failed: %v", err)
	}
	if metrics.NodeCount <= MaxNodes {
		t.Fatalf("fixture is not over the node limit: %d", metrics.NodeCount)
	}
	if err := metrics.LimitError(); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("metrics.LimitError() = %v, want ErrLimitExceeded", err)
	}

	if _, err := Marshal(doc); !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("Marshal accepted an over-limit document: %v", err)
	}
}

// A limit breach still reads as invalid so the handlers that already answer 400
// for rejected writes keep doing so.
func TestLimitExceededIsAnInvalidDocument(t *testing.T) {
	if !errors.Is(ErrLimitExceeded, ErrInvalid) {
		t.Fatal("ErrLimitExceeded no longer satisfies errors.Is(err, ErrInvalid)")
	}
}

func TestParseRejectsNestingBeyondTheRecursionCeiling(t *testing.T) {
	var builder strings.Builder
	builder.WriteString(`{"schemaVersion":1,"value":[`)
	depth := depthCeiling + 2
	for range depth {
		builder.WriteString(`{"type":"p","id":"b","children":[`)
	}
	builder.WriteString(`{"text":"x"}`)
	for range depth {
		builder.WriteString(`]}`)
	}
	builder.WriteString(`]}`)
	if _, err := Parse(builder.String()); !errors.Is(err, ErrInvalid) {
		t.Fatalf("pathological nesting error = %v, want invalid", err)
	}
}

func TestSuggestionPropertiesAreRejected(t *testing.T) {
	for _, raw := range []string{
		`{"schemaVersion":1,"value":[{"type":"p","id":"block","children":[{"text":"x","suggestion":true}]}]}`,
		`{"schemaVersion":1,"value":[{"type":"p","id":"block","children":[{"text":"x","suggestion_insert":{"id":"old"}}]}]}`,
		`{"schemaVersion":1,"value":[{"type":"p","id":"block","suggestion":{"id":"old"},"children":[{"text":"x"}]}]}`,
	} {
		if _, err := Parse(raw); !errors.Is(err, ErrInvalid) {
			t.Fatalf("obsolete suggestion metadata error = %v, want invalid", err)
		}
	}
}
