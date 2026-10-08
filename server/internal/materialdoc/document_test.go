package materialdoc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestQuestionVoidIdentityAndEmptyQuiz(t *testing.T) {
	empty, err := QuizDocument(json.RawMessage("[]"), nil)
	if err != nil {
		t.Fatal(err)
	}
	got, limit, err := ExtractQuiz(empty)
	if err != nil || string(got) != "[]" || limit != nil {
		t.Fatalf("empty quiz: %s %v", got, err)
	}
	raw, err := os.ReadFile("../questions/testdata/rich-blocks.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	input, err := json.Marshal([]map[string]any{fixture.Question})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := QuizDocument(input, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, _, err = ExtractQuiz(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var wantValue, gotValue any
	if err := json.Unmarshal(input, &wantValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(got, &gotValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(wantValue, gotValue) {
		t.Fatal("rich blocks changed during round trip")
	}
	for _, corrupt := range []func(map[string]any){
		func(node map[string]any) { node["id"] = "different" },
		func(node map[string]any) { node["children"] = []any{textLeaf("editable text")} },
		func(node map[string]any) { node["questionType"] = "short" },
	} {
		doc, err := Parse(encoded)
		if err != nil {
			t.Fatal(err)
		}
		corrupt(find(doc.Value, "quiz_question"))
		if err := Validate(doc); err == nil {
			t.Fatal("invalid question wrapper accepted")
		}
	}
}

func TestQuestionEmbedsValidateAndIndexWithoutSVGText(t *testing.T) {
	raw, err := os.ReadFile("../questions/testdata/rich-blocks.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	stem := fixture.Question["stem"].([]any)
	graph := map[string]any{"type": "graph", "id": "graph1", "block": stem[1], "children": []any{textLeaf("")}}
	chart := map[string]any{"type": "chart", "id": "chart1", "block": stem[2], "children": []any{textLeaf("")}}
	doc := Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{graph, chart}}
	encoded, err := Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(encoded, "note"); err != nil {
		t.Fatal(err)
	}
	text, err := ExtractIndexText(encoded)
	if err != nil || text != "A graph\n\nData" {
		t.Fatalf("index = %q, error = %v", text, err)
	}
	doc.Value = []map[string]any{{"type": "callout", "id": "container", "children": []any{graph}}}
	if err := Validate(doc); err == nil {
		t.Fatal("nested graph accepted")
	}
}

func TestHTMLEmbedCapsSizeAndCountAndSkipsIndexing(t *testing.T) {
	embed := func(id, html string) map[string]any {
		return map[string]any{"type": HTMLEmbedType, "id": id, "caption": "Tangent", "html": html, "children": []any{textLeaf("")}}
	}
	doc := Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{ParagraphNode("intro")}}
	for i := range HTMLEmbedMaxCount {
		doc.Value = append(doc.Value, embed(fmt.Sprintf("e%d", i), strings.Repeat("x", HTMLEmbedMaxBytes)))
	}
	encoded, err := Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if text, err := ExtractIndexText(encoded); err != nil || text != "intro" {
		t.Fatalf("index = %q, error = %v", text, err)
	}
	for name, value := range map[string][]map[string]any{
		"eleventh block": append(doc.Value, embed("e10", "<p>x</p>")),
		"oversized html": {embed("e0", strings.Repeat("x", HTMLEmbedMaxBytes+1))},
		"nested block":   {{"type": "callout", "id": "c", "children": []any{embed("e0", "")}}},
		"extra field":    {{"type": HTMLEmbedType, "id": "e0", "html": "", "src": "https://x", "children": []any{textLeaf("")}}},
	} {
		if err := Validate(Envelope{SchemaVersion: SchemaVersion, Value: value}); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestQuizRoundTripPreservesEveryQuestionTypeAndGrading(t *testing.T) {
	questions := json.RawMessage(`[{"id": "q0", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p0", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "mcq", "options": ["A", "B"], "correct": [0]}, "marks": 1, "solution": []}], "layout": "paper", "labels": "letters"}, {"id": "q1", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p1", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "multi", "options": ["A", "B"], "correct": [0, 1]}, "marks": 1, "solution": []}], "layout": "paper", "labels": "letters"}, {"id": "q2", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p2", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "boolean", "correct": false}, "marks": 1, "solution": []}], "layout": "paper", "labels": "letters"}, {"id": "q3", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p3", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "short", "accepted": ["alpha"]}, "marks": 1, "solution": []}], "layout": "paper", "labels": "letters"}, {"id": "q4", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p4", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "matching", "options": ["unused", "X", "Y"], "pairs": [{"left": "A", "right": 1}, {"left": "B", "right": 1}]}, "marks": 1, "solution": []}], "layout": "paper", "labels": "letters"}, {"id": "q5", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p5", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "ordering", "items": ["A", "B"]}, "marks": 1, "solution": []}], "layout": "paper", "labels": "letters"}, {"id": "q6", "stem": [{"type": "text", "text": "Shared $x$ context."}], "parts": [{"id": "p6", "blocks": [{"type": "text", "text": "Answer?"}], "answer": {"type": "open", "accepted": ["explanation"], "hints": ["reason"]}, "marks": 1, "markscheme": [{"text": "Correct answer", "marks": 1}], "solution": []}], "layout": "paper", "labels": "letters"}]`)
	raw, err := QuizDocument(questions, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, `"questions"`) {
		t.Fatalf("opaque questions property was persisted: %s", raw)
	}
	got, _, err := ExtractQuiz(raw)
	if err != nil {
		t.Fatal(err)
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

func TestStandaloneArtifactDocumentsContainOnlyTheirCustomBlock(t *testing.T) {
	quiz, err := QuizDocument(json.RawMessage(
		`[{"id":"q1","stem":[{"type":"text","text":"Shared $x$ context."}],"parts":[{"id":"part-1","blocks":[{"type":"text","text":"Answer?"}],"answer":{"type":"short","accepted":["alpha"]},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`,
	), nil)
	if err != nil {
		t.Fatal(err)
	}
	flashcards, err := FlashcardsDocument([]Card{{ID: "c_1", Front: "A", Back: "B"}})
	if err != nil {
		t.Fatal(err)
	}
	mermaid, err := MermaidDocument("flowchart LR\nA-->B", "")
	if err != nil {
		t.Fatal(err)
	}

	for kind, raw := range map[string]string{
		"quiz":       quiz,
		"flashcards": flashcards,
		"mermaid":    mermaid,
	} {
		doc, err := Parse(raw)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if len(doc.Value) != 1 || doc.Value[0]["type"] != kind {
			t.Fatalf("%s document retained metadata title content: %#v", kind, doc.Value)
		}
	}
}

func TestFillQuestionTypeIsRejected(t *testing.T) {
	_, err := QuizDocument(json.RawMessage(
		`[{"id":"q1","type":"fill","level":"recall","prompt":"Fill?","accepted":[{"value":"alpha"}]}]`,
	), nil)
	if err == nil {
		t.Fatal("fill type was accepted")
	}
}

func TestFlashcardsReplacePreservesCardIDsAndAnnotations(t *testing.T) {
	raw, err := FlashcardsDocument([]Card{{ID: "c_1", Front: "A", Back: "B"}})
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
	raw, err := FlashcardsDocument([]Card{{ID: "c_old", Front: "Front", Back: "Back"}})
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

func TestMetricsExcludeRuntimeCommentMarks(t *testing.T) {
	clean := `{"schemaVersion":1,"value":[{"children":[{"bold":true,"commentary":"kept","text":"annotated"}],"id":"block_1","type":"p"}]}`
	marked := `{"schemaVersion":1,"value":[{"children":[{"bold":true,"comment":"discussion_1","comment_thread_1":true,"commentary":"kept","text":"annotated"}],"id":"block_1","type":"p"}]}`
	cleanMetrics, err := Metrics(clean)
	if err != nil {
		t.Fatal(err)
	}
	markedMetrics, err := Metrics(marked)
	if err != nil {
		t.Fatal(err)
	}
	if markedMetrics != cleanMetrics {
		t.Fatalf("runtime comment metrics = %+v, want %+v", markedMetrics, cleanMetrics)
	}
}

func TestMetricsMeasureEveryStructurallyValidDeepNode(t *testing.T) {
	node := map[string]any{"text": "bottom"}
	const depth = 300
	for range depth {
		node = map[string]any{
			"type":     "blockquote",
			"children": []any{node},
		}
	}
	doc := Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{node}}
	projection, err := NewProjection(doc)
	if err != nil {
		t.Fatal(err)
	}
	metrics, err := Metrics(projection.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if metrics.MaxDepth != depth || metrics.NodeCount != depth+1 {
		t.Fatalf("deep metrics = %+v, want depth %d and %d nodes", metrics, depth, depth+1)
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
				"type": "flashcards", "id": "flashcardSet_1", "cards": []any{},
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

func TestRewriteClonedEditorAssetIDsDropsUncopiedAssets(t *testing.T) {
	raw, err := Marshal(Envelope{
		SchemaVersion: SchemaVersion,
		Value: []map[string]any{
			{"type": "p", "id": "before", "children": []any{textLeaf("before")}},
			{"type": "img", "id": "ready", "assetId": "asset-ready", "children": []any{textLeaf("")}},
			{"type": "audio", "id": "pending", "assetId": "asset-pending", "children": []any{textLeaf("")}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rewritten, err := RewriteClonedEditorAssetIDs(raw, map[string]string{
		"asset-ready": "asset-clone",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rewritten, "asset-pending") || strings.Contains(rewritten, `"id":"pending"`) {
		t.Fatalf("uncopied asset node survived: %s", rewritten)
	}
	if !strings.Contains(rewritten, `"assetId":"asset-clone"`) {
		t.Fatalf("ready asset was not rewritten: %s", rewritten)
	}
}

func TestEditorAssetIDsFindsNestedUniqueReferences(t *testing.T) {
	raw, err := Marshal(Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{
		{
			"type": "column_group", "children": []any{
				map[string]any{"type": "img", "assetId": "asset-one", "children": []any{textLeaf("")}},
				map[string]any{"type": "audio", "assetId": "asset-two", "children": []any{textLeaf("")}},
			},
		},
		map[string]any{"type": "img", "assetId": "asset-one", "children": []any{textLeaf("")}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	ids, err := EditorAssetIDs(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("asset ids = %#v, want two distinct references", ids)
	}
}

func TestRewriteClonedEditorAssetIDsLeavesValidEmptyDocument(t *testing.T) {
	raw, err := Marshal(Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{{
		"type": "img", "id": "pending", "assetId": "asset-pending", "children": []any{textLeaf("")},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	rewritten, err := RewriteClonedEditorAssetIDs(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(rewritten); err != nil {
		t.Fatalf("empty clone document is invalid: %v", err)
	}
	if strings.Contains(rewritten, "asset-pending") {
		t.Fatalf("uncopied asset survived: %s", rewritten)
	}
}

func TestQuizImageEditorAssetsAreFoundAndRewrittenOnClone(t *testing.T) {
	image := func(assetID string) map[string]any {
		return map[string]any{"type": "image", "image": map[string]any{"assetId": assetID}, "width": 10, "height": 10, "description": "Figure"}
	}
	text := map[string]any{"type": "text", "text": "Answer?"}
	question := func(id string, stem, blocks, solution []any) map[string]any {
		q := map[string]any{
			"id": id, "stem": stem, "layout": "paper", "labels": "letters",
			"parts": []any{map[string]any{
				"id": id + "-part", "blocks": blocks, "solution": solution,
				"answer": map[string]any{"type": "boolean", "correct": true},
				"marks":  1,
			}},
		}
		return map[string]any{"type": "quiz_question", "id": id, "question": q, "children": []any{textLeaf("")}}
	}
	raw, err := Marshal(Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{{
		"type": "quiz", "id": "quiz", "children": []any{
			question("kept", []any{image("asset-ready")}, []any{text}, []any{image("asset-gone")}),
			question("dropped", []any{}, []any{image("asset-gone")}, []any{}),
		},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	ids, err := EditorAssetIDs(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("asset ids = %#v, want the two quiz image assets", ids)
	}
	rewritten, err := RewriteClonedEditorAssetIDs(raw, map[string]string{"asset-ready": "asset-clone"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(rewritten); err != nil {
		t.Fatalf("cloned quiz is invalid: %v", err)
	}
	if !strings.Contains(rewritten, `"assetId":"asset-clone"`) || strings.Contains(rewritten, "asset-gone") || strings.Contains(rewritten, `"dropped"`) {
		t.Fatalf("quiz images were not rewritten: %s", rewritten)
	}
}

func TestFlashcardImagesAreFoundRewrittenAndChecked(t *testing.T) {
	raw, err := FlashcardsDocument([]Card{
		{ID: "kept", Front: "Mitochondria", Back: "ATP", Image: &CardImage{AssetID: "asset-ready"}},
		{ID: "lost", Front: "Nucleus", Back: "DNA", Image: &CardImage{AssetID: "asset-gone"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ids, err := EditorAssetIDs(raw)
	if err != nil || len(ids) != 2 {
		t.Fatalf("asset ids = %#v, %v; want both card images", ids, err)
	}
	rewritten, err := RewriteClonedEditorAssetIDs(raw, map[string]string{"asset-ready": "asset-clone"})
	if err != nil {
		t.Fatal(err)
	}
	cards, err := ExtractFlashcards(rewritten)
	if err != nil {
		t.Fatal(err)
	}
	// An uncopied image leaves its card in place, without the image.
	if len(cards) != 2 || cards[0].Image == nil || cards[0].Image.AssetID != "asset-clone" || cards[1].Image != nil {
		t.Fatalf("cloned cards = %+v", cards)
	}
	if err := ValidateKind(rewritten, "flashcards"); err != nil {
		t.Fatalf("cloned set is invalid: %v", err)
	}

	long := Card{ID: "c", Front: "f", Back: strings.Repeat("é", MaxCardBackRunes+1)}
	if _, err := FlashcardsDocument([]Card{long}); err == nil {
		t.Fatal("a back over the limit was accepted")
	}
	atLimit, err := FlashcardsDocument([]Card{{ID: "c", Front: "f", Back: strings.Repeat("é", MaxCardBackRunes)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(atLimit, "flashcards"); err != nil {
		t.Fatalf("a back at the limit was refused: %v", err)
	}
	badImage := strings.Replace(raw, `"assetId":"asset-ready"`, `"assetId":"asset-ready","url":"https://x"`, 1)
	if err := ValidateKind(badImage, "flashcards"); err == nil {
		t.Fatal("an image with extra keys was accepted")
	}
}

func TestDiagramContract(t *testing.T) {
	raw, err := FromLegacyMarkdown("diagram", "```mermaid\nflowchart LR\nA-->B\n```")
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
	first, err := FromLegacyMarkdown("note", "alpha")
	if err != nil {
		t.Fatal(err)
	}
	second, err := FromLegacyMarkdown("note", "alpha")
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

	diagram, err := FromLegacyMarkdown("diagram", "```mermaid\nflowchart LR\nA-->B\n```")
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
	projected, err := NewProjection(doc)
	if err != nil {
		t.Fatalf("projection serialization rejected valid over-limit content: %v", err)
	}
	if projected.Raw != raw {
		t.Fatal("projection serialization did not preserve canonical over-limit content")
	}
}

func TestProjectionSerializationStillRejectsInvalidStructure(t *testing.T) {
	doc := Empty()
	doc.Value[0]["children"] = []any{map[string]any{
		"text":     "invalid",
		"children": []any{},
	}}
	if _, err := NewProjection(doc); !errors.Is(err, ErrInvalid) {
		t.Fatalf("NewProjection accepted invalid structure: %v", err)
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

func TestNoteKeepsStudyBlocksAsReferences(t *testing.T) {
	quiz, err := QuizDocument(json.RawMessage(`[{"id":"q1","stem":[{"type":"text","text":"Shared $x$ context."}],"parts":[{"id":"part-1","blocks":[{"type":"text","text":"Answer?"}],"answer":{"type":"short","accepted":["alpha"]},"marks":1,"solution":[]}],"layout":"paper","labels":"letters"}]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(quiz, "note"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("note should reject an inline quiz block, got %v", err)
	}
	ref := MaterialRefNode("mat_child", "quiz")
	nested, err := Marshal(Envelope{SchemaVersion: 1, Value: []map[string]any{{
		"type": "callout", "id": "block_1", "children": []any{ref},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(nested, "note"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("note should reject a nested reference, got %v", err)
	}
	withRef, err := Marshal(Envelope{SchemaVersion: 1, Value: []map[string]any{
		ParagraphNode("intro"), ref,
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(withRef, "note"); err != nil {
		t.Fatalf("top-level reference should be valid: %v", err)
	}
	if err := ValidateKind(withRef, "quiz"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a quiz material should reject references, got %v", err)
	}
	refs, err := ExtractMaterialRefs(withRef)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].MaterialID != "mat_child" || refs[0].Kind != "quiz" {
		t.Fatalf("refs = %#v", refs)
	}
	rewritten, err := RewriteMaterialRefIDs(withRef, map[string]string{"mat_child": "mat_clone"})
	if err != nil {
		t.Fatal(err)
	}
	refs, err = ExtractMaterialRefs(rewritten)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].MaterialID != "mat_clone" {
		t.Fatalf("rewritten refs = %#v", refs)
	}
	pending, err := Marshal(Envelope{SchemaVersion: 1, Value: []map[string]any{
		{"type": RefType, "id": "r", "materialId": "", "pending": "questions: []", "refKind": "quiz", "children": []any{textLeaf("")}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateKind(pending, "note"); err != nil {
		t.Fatalf("a pending reference is valid until the editor resolves it: %v", err)
	}
	if refs, err := ExtractMaterialRefs(pending); err != nil || len(refs) != 0 {
		t.Fatalf("pending references carry no material: %v %v", refs, err)
	}
	for _, broken := range []map[string]any{
		{"type": RefType, "id": "r", "materialId": "", "refKind": "quiz", "children": []any{textLeaf("")}},
		{"type": RefType, "id": "r", "materialId": "m", "refKind": "note", "children": []any{textLeaf("")}},
		{"type": RefType, "id": "r", "materialId": "m", "refKind": "quiz", "children": []any{textLeaf("x")}},
	} {
		raw, err := json.Marshal(Envelope{SchemaVersion: 1, Value: []map[string]any{broken}})
		if err != nil {
			t.Fatal(err)
		}
		if err := ValidateKind(string(raw), "note"); !errors.Is(err, ErrInvalid) {
			t.Fatalf("expected %v to be rejected, got %v", broken, err)
		}
	}
}

func TestExtractIndexTextRendersMarkdownLikeBlocks(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[
		{"type":"h2","id":"b1","children":[{"text":"Cells"}]},
		{"type":"p","id":"b2","children":[{"text":"Intro "},{"type":"a","url":"x","children":[{"text":"link"}]}]},
		{"type":"p","id":"b3","listStyleType":"disc","indent":1,"children":[{"text":"first"}]},
		{"type":"p","id":"b4","listStyleType":"decimal","indent":2,"children":[{"text":"nested"}]},
		{"type":"callout","id":"b5","children":[{"type":"p","children":[{"text":"note"}]}]},
		{"type":"table","id":"b6","children":[{"type":"tr","children":[{"type":"th","children":[{"type":"p","children":[{"text":"a"}]}]},{"type":"td","children":[{"type":"p","children":[{"text":"b"}]}]}]}]},
		{"type":"code_block","id":"b7","lang":"go","children":[{"type":"code_line","children":[{"text":"x := 1"}]}]},
		{"type":"material_ref","id":"b8","materialId":"m","refKind":"quiz","children":[{"text":""}]},
		{"type":"mermaid","id":"b9","source":"flowchart","children":[{"type":"mermaid_caption","children":[{"text":"cap"}]}]},
		{"type":"p","id":"b10","children":[{"text":"   "}]}
	]}`
	text, err := ExtractIndexText(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := "## Cells\n\nIntro link\n\n- first\n\n  1. nested\n\nnote\n\n| a | b |\n\n```go\nx := 1\n```"
	if text != want {
		t.Fatalf("index text = %q, want %q", text, want)
	}
}

func TestResolvePendingRefsPointsFencesAtTheirRows(t *testing.T) {
	raw := `{"schemaVersion":1,"value":[` +
		`{"type":"material_ref","id":"r1","materialId":"","refKind":"quiz","pending":"questions: []","children":[{"text":""}]},` +
		`{"type":"p","children":[{"text":"between"}]},` +
		`{"type":"material_ref","id":"r2","materialId":"","refKind":"flashcards","pending":"cards: []","children":[{"text":""}]}]}`
	out, err := ResolvePendingRefs(raw, []string{"mat_q", "mat_f"})
	if err != nil {
		t.Fatal(err)
	}
	refs, err := ExtractMaterialRefs(out)
	if err != nil || len(refs) != 2 || refs[0].MaterialID != "mat_q" || refs[1].MaterialID != "mat_f" {
		t.Fatalf("refs = %+v, err = %v", refs, err)
	}
	if strings.Contains(out, "pending") {
		t.Fatalf("a resolved reference kept its fence body: %s", out)
	}
	if _, err := ResolvePendingRefs(raw, []string{"mat_q"}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("a count mismatch was accepted: %v", err)
	}
}

// The store reads a projection's kind check, references and assets from the
// value it serialized instead of parsing Raw again; both must agree.
func TestProjectionReadsWhatItsJSONHolds(t *testing.T) {
	paragraph := ParagraphNode("")
	paragraph["children"] = []any{map[string]any{"text": "marked", "comment": true, "comment_thread": true}}
	doc := Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{
		paragraph,
		MaterialRefNode("mat_child", "quiz"),
		{"type": "column_group", "id": "block_columns", "children": []any{
			map[string]any{"type": "img", "assetId": "asset-one", "children": []any{textLeaf("")}},
		}},
		{"type": "img", "id": "block_image", "assetId": "asset-two", "children": []any{textLeaf("")}},
	}}
	projection, err := NewProjection(doc)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(projection.Raw, "comment") {
		t.Fatalf("runtime comment marks reached the stored JSON: %s", projection.Raw)
	}
	metrics, err := Metrics(projection.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if projection.Metrics != metrics {
		t.Fatalf("projection metrics = %+v, stored JSON measures %+v", projection.Metrics, metrics)
	}
	for _, kind := range []string{"note", "quiz", "flashcards", "diagram"} {
		parsed := ValidateKind(projection.Raw, kind)
		if got := projection.ValidateKind(kind); (got == nil) != (parsed == nil) {
			t.Fatalf("ValidateKind(%s) = %v, stored JSON gives %v", kind, got, parsed)
		}
	}
	refs, err := ExtractMaterialRefs(projection.Raw)
	if err != nil {
		t.Fatal(err)
	}
	if got := projection.MaterialRefs(); !reflect.DeepEqual(got, refs) || len(refs) != 1 {
		t.Fatalf("refs = %#v, stored JSON gives %#v", got, refs)
	}
	assets, err := EditorAssetIDs(projection.Raw)
	if err != nil {
		t.Fatal(err)
	}
	got := projection.EditorAssetIDs()
	slices.Sort(got)
	slices.Sort(assets)
	if !slices.Equal(got, assets) || len(assets) != 2 {
		t.Fatalf("asset ids = %v, stored JSON gives %v", got, assets)
	}
}

// A resizable block stores exactly what MediaFrame's resize handles write:
// "<n>%" with n a whole number from 20 to 100.
func TestResizableBlocksTakeOnlyTheResizeWidth(t *testing.T) {
	raw, err := os.ReadFile("../questions/testdata/rich-blocks.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Question map[string]any }
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	stem := fixture.Question["stem"].([]any)
	blocks := map[string]func() map[string]any{
		"chart": func() map[string]any {
			return map[string]any{"type": "chart", "id": "b", "block": stem[2], "children": []any{textLeaf("")}}
		},
		"graph": func() map[string]any {
			return map[string]any{"type": "graph", "id": "b", "block": stem[1], "children": []any{textLeaf("")}}
		},
		"image": func() map[string]any {
			return map[string]any{"type": "img", "id": "b", "assetId": "asset", "children": []any{textLeaf("")}}
		},
		"mermaid": func() map[string]any {
			return map[string]any{"type": "mermaid", "id": "b", "source": "flowchart LR", "children": []any{
				map[string]any{"type": "mermaid_caption", "children": []any{textLeaf("")}},
			}}
		},
		"video": func() map[string]any {
			return map[string]any{"type": "video", "id": "b", "provider": "youtube", "videoId": "dQw4w9WgXcQ", "children": []any{textLeaf("")}}
		},
	}
	validate := func(block map[string]any) error {
		return Validate(Envelope{SchemaVersion: SchemaVersion, Value: []map[string]any{block}})
	}
	for kind, block := range blocks {
		if err := validate(block()); err != nil {
			t.Fatalf("%s without width: %v", kind, err)
		}
		for _, width := range []string{"20%", "55%", "100%"} {
			node := block()
			node["width"] = width
			if err := validate(node); err != nil {
				t.Fatalf("%s width %q: %v", kind, width, err)
			}
		}
		for _, width := range []any{"19%", "101%", float64(50), "50px", "50.5%", "050%", nil} {
			node := block()
			node["width"] = width
			if err := validate(node); err == nil || !strings.Contains(err.Error(), "width must be a whole percentage from 20 to 100") {
				t.Fatalf("%s width %#v: %v", kind, width, err)
			}
		}
	}
}
