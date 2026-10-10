package materialdoc

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// noteDoc wraps top-level node JSON in a stored note envelope.
func noteDoc(nodes ...string) string {
	return `{"schemaVersion":1,"value":[` + strings.Join(nodes, ",") + `]}`
}

func para(id, text string) string {
	return fmt.Sprintf(`{"type":"p","id":%q,"children":[{"text":%q}]}`, id, text)
}

func previewTable(rows, cols int) string {
	trs := make([]string, rows)
	for r := range trs {
		tds := make([]string, cols)
		for c := range tds {
			tds[c] = fmt.Sprintf(`{"type":"td","children":[{"type":"p","children":[{"text":" r%dc%d "}]}]}`, r, c)
		}
		trs[r] = `{"type":"tr","children":[` + strings.Join(tds, ",") + `]}`
	}
	return `{"type":"table","id":"tbl","children":[` + strings.Join(trs, ",") + `]}`
}

// quizDoc stores the named shared question fixtures as one quiz, renumbered so
// their ids stay unique.
func quizDoc(t *testing.T, names ...string) string {
	t.Helper()
	qs := make([]map[string]any, len(names))
	for i, name := range names {
		raw, err := os.ReadFile("../questions/testdata/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var fixture struct {
			Question map[string]any `json:"question"`
		}
		if err := json.Unmarshal(raw, &fixture); err != nil {
			t.Fatal(err)
		}
		q := fixture.Question
		q["id"] = fmt.Sprintf("q%d", i)
		for j, part := range q["parts"].([]any) {
			part.(map[string]any)["id"] = fmt.Sprintf("q%d:part:%d", i, j)
		}
		qs[i] = q
	}
	encoded, err := json.Marshal(qs)
	if err != nil {
		t.Fatal(err)
	}
	doc, err := QuizDocument(encoded, nil)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func quizOf(t *testing.T, question string) string {
	t.Helper()
	doc, err := QuizDocument(json.RawMessage(`[`+question+`]`), nil)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestPreview(t *testing.T) {
	everyBlock, err := os.ReadFile("testdata/every-block-note.json")
	if err != nil {
		t.Fatal(err)
	}
	longOption := strings.Repeat("o", 70)
	longStem := strings.Repeat("s", 250)
	clippedQuestion := fmt.Sprintf(`{"id":"q1","stem":[{"type":"text","text":"Context"}],"layout":"paper","labels":"letters",
		"parts":[{"id":"q1:part:1","blocks":[{"type":"text","text":%q}],"marks":1,"solution":[],
		"answer":{"type":"mcq","options":["%s","b","c","d","e","f"],"correct":[0]}}]}`, longStem, longOption)
	stemOnlyQuestion := `{"id":"q1","stem":[{"type":"text","text":"Read the table."}],"layout":"paper","labels":"letters",
		"parts":[{"id":"q1:part:1","blocks":[{"type":"table","header":true,"rows":[["x","y"]]}],"marks":1,"solution":[],
		"answer":{"type":"short","accepted":["1"]}}]}`
	cards, err := FlashcardsDocument([]Card{
		{ID: "c1", Front: "  Mitosis  ", Back: "Division", Image: &CardImage{AssetID: "asset_1"}},
		{ID: "c2", Front: "Meiosis", Back: "Halving"},
	})
	if err != nil {
		t.Fatal(err)
	}
	longFront, err := FlashcardsDocument([]Card{{ID: "c1", Front: strings.Repeat("前", 250), Back: "b"}})
	if err != nil {
		t.Fatal(err)
	}
	flow, err := MermaidDocument("flowchart LR\n  A --> B", "")
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for i := range 200 {
		lines = append(lines, fmt.Sprintf("  node_%03d", i))
	}
	tree := "mindmap\n" + strings.Join(lines, "\n")
	mindmap, err := MermaidDocument(tree, "")
	if err != nil {
		t.Fatal(err)
	}
	clipped := tree[:strings.LastIndexByte(tree[:previewSourceBytes+1], '\n')]
	paragraphs := make([]string, 10)
	for i := range paragraphs {
		paragraphs[i] = para(fmt.Sprintf("p%d", i), fmt.Sprintf("p%d", i))
	}
	codeLines := make([]string, 8)
	for i := range codeLines {
		codeLines[i] = fmt.Sprintf(`{"type":"code_line","children":[{"text":"l%d"}]}`, i+1)
	}

	cases := []struct {
		name, kind, content, want string
	}{
		{
			name: "headings, paragraphs and quotes",
			kind: "note",
			content: noteDoc(
				`{"type":"h1","id":"a","children":[{"text":"Tides"}]}`,
				`{"type":"h3","id":"b","children":[{"text":"Why"}]}`,
				para("c", "  Moon pulls.  "),
				para("d", "   "),
				`{"type":"blockquote","id":"e","children":[{"type":"p","children":[{"text":"Quoted"}]}]}`,
			),
			want: `{"kind":"note","blocks":[{"t":"h","text":"Tides","level":1},{"t":"h","text":"Why","level":3},{"t":"p","text":"Moon pulls."},{"t":"quote","text":"Quoted"}]}`,
		},
		{
			name: "lists merge, to-dos keep their state",
			kind: "note",
			content: noteDoc(
				`{"type":"p","id":"a","indent":1,"listStyleType":"disc","children":[{"text":"One"}]}`,
				`{"type":"p","id":"b","indent":1,"listStyleType":"decimal","children":[{"text":"Two"}]}`,
				`{"type":"p","id":"c","indent":1,"listStyleType":"todo","checked":true,"children":[{"text":"Done"}]}`,
				`{"type":"p","id":"d","indent":1,"listStyleType":"todo","children":[{"text":"Open"}]}`,
			),
			want: `{"kind":"note","blocks":[{"t":"ul","items":["One","Two"]},{"t":"todo","items":[{"done":true,"text":"Done"},{"done":false,"text":"Open"}]}]}`,
		},
		{
			name:    "a table keeps four rows of four cells",
			kind:    "note",
			content: noteDoc(previewTable(5, 5)),
			want:    `{"kind":"note","blocks":[{"t":"table","rows":[["r0c0","r0c1","r0c2","r0c3"],["r1c0","r1c1","r1c2","r1c3"],["r2c0","r2c1","r2c2","r2c3"],["r3c0","r3c1","r3c2","r3c3"]]}]}`,
		},
		{
			name: "math, code, image, containers and skipped media",
			kind: "note",
			content: noteDoc(
				`{"type":"equation","id":"a","texExpression":"E=mc^2","children":[{"text":""}]}`,
				`{"type":"code_block","id":"b","lang":"go","children":[`+strings.Join(codeLines, ",")+`]}`,
				`{"type":"img","id":"c","assetId":"asset_1","children":[{"text":""}]}`,
				`{"type":"hr","id":"d","children":[{"text":""}]}`,
				`{"type":"video","id":"e","provider":"youtube","videoId":"dQw4w9WgXcQ","children":[{"text":""}]}`,
				`{"type":"callout","id":"f","children":[{"type":"p","children":[{"text":"Inside"}]}]}`,
			),
			want: `{"kind":"note","blocks":[{"t":"math","tex":"E=mc^2"},{"t":"code","text":"l1\nl2\nl3\nl4\nl5\nl6","lang":"go"},{"t":"image"},{"t":"p","text":"Inside"}]}`,
		},
		{
			name:    "at most eight blocks",
			kind:    "note",
			content: noteDoc(paragraphs...),
			want:    `{"kind":"note","blocks":[{"t":"p","text":"p0"},{"t":"p","text":"p1"},{"t":"p","text":"p2"},{"t":"p","text":"p3"},{"t":"p","text":"p4"},{"t":"p","text":"p5"},{"t":"p","text":"p6"},{"t":"p","text":"p7"}]}`,
		},
		{
			name:    "at most 600 characters, cut on a whole character",
			kind:    "note",
			content: noteDoc(para("a", strings.Repeat("é", 700)), para("b", "dropped")),
			want:    `{"kind":"note","blocks":[{"t":"p","text":"` + strings.Repeat("é", 600) + `"}]}`,
		},
		{
			name:    "an empty note has no blocks",
			kind:    "note",
			content: noteDoc(para("a", "")),
			want:    `{"kind":"note","blocks":[]}`,
		},
		{
			name:    "the every-block fixture stops at eight blocks",
			kind:    "note",
			content: string(everyBlock),
			want:    `{"kind":"note","blocks":[{"t":"h","text":"Every block heading one","level":1},{"t":"h","text":"Every block heading two","level":2},{"t":"h","text":"Every block heading three","level":3},{"t":"h","text":"Every block heading four","level":4},{"t":"h","text":"Every block heading five","level":5},{"t":"h","text":"Every block heading six","level":6},{"t":"p","text":"Marks: bold italic underline strike code x2 H2O highlight Ctrl red shaded large serif"},{"t":"p","text":"Inlines: a link,  and ."}]}`,
		},
		{
			name:    "mcq shows its options without the key",
			kind:    "quiz",
			content: quizDoc(t, "mcq", "boolean", "short"),
			want:    `{"kind":"quiz","questionCount":3,"first":{"type":"mcq","stem":"Answer?","options":["A","B"]}}`,
		},
		{
			name:    "multi",
			kind:    "quiz",
			content: quizDoc(t, "multi"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"multi","stem":"Answer?","options":["A","B"]}}`,
		},
		{
			name:    "boolean",
			kind:    "quiz",
			content: quizDoc(t, "boolean"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"boolean","stem":"Answer?"}}`,
		},
		{
			name:    "short",
			kind:    "quiz",
			content: quizDoc(t, "short"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"short","stem":"Answer?"}}`,
		},
		{
			name:    "matching shows only its prompts",
			kind:    "quiz",
			content: quizDoc(t, "matching"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"matching","stem":"Answer?","prompts":["A","B"]}}`,
		},
		{
			name:    "ordering shows only its item count",
			kind:    "quiz",
			content: quizDoc(t, "ordering"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"ordering","stem":"Answer?","itemCount":2}}`,
		},
		{
			name:    "open",
			kind:    "quiz",
			content: quizDoc(t, "open"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"open","stem":"Answer?"}}`,
		},
		{
			name:    "gaps mark each blank",
			kind:    "quiz",
			content: quizDoc(t, "gaps"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"gaps","stem":"Steel bands use \u0001 drums and \u0001 pans."}}`,
		},
		{
			name:    "a chart or graph in the stem",
			kind:    "quiz",
			content: quizDoc(t, "rich-blocks"),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"short","stem":"Answer?","hasChart":true}}`,
		},
		{
			name:    "stem and options are clipped",
			kind:    "quiz",
			content: quizOf(t, clippedQuestion),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"mcq","stem":"` + longStem[:200] + `","options":["` + longOption[:60] + `","b","c","d"]}}`,
		},
		{
			name:    "a part without text shows the stem",
			kind:    "quiz",
			content: quizOf(t, stemOnlyQuestion),
			want:    `{"kind":"quiz","questionCount":1,"first":{"type":"short","stem":"Read the table."}}`,
		},
		{
			name:    "an empty quiz",
			kind:    "quiz",
			content: quizOf(t, ""),
			want:    `{"kind":"quiz","questionCount":0}`,
		},
		{
			name:    "flashcards count and the first front",
			kind:    "flashcards",
			content: cards,
			want:    `{"kind":"flashcards","cardCount":2,"first":{"front":"Mitosis","hasImage":true}}`,
		},
		{
			name:    "a long front is clipped",
			kind:    "flashcards",
			content: longFront,
			want:    `{"kind":"flashcards","cardCount":1,"first":{"front":"` + strings.Repeat("前", 200) + `","hasImage":false}}`,
		},
		{
			name:    "diagram source",
			kind:    "diagram",
			content: flow,
			want:    `{"kind":"diagram","source":"flowchart LR\n  A --> B"}`,
		},
		{
			name:    "mindmap source is cut on a line boundary",
			kind:    "mindmap",
			content: mindmap,
			want:    `{"kind":"mindmap","source":` + jsonString(clipped) + `}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Preview(tc.kind, tc.content)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Fatalf("preview\n got %s\nwant %s", got, tc.want)
			}
		})
	}

	// A row without cells (not storable, but read leniently) is a list, never
	// null, so a client can map it.
	emptyRow := []map[string]any{{"type": "table", "children": []any{
		map[string]any{"type": "tr", "children": []any{}},
	}}}
	if got, err := preview("note", emptyRow); err != nil ||
		string(got) != `{"kind":"note","blocks":[{"t":"table","rows":[[]]}]}` {
		t.Fatalf("empty row preview = %s, %v", got, err)
	}
	if got, err := Preview("canvas", noteDoc(para("a", "x"))); err != nil || got != nil {
		t.Fatalf("a kind without a preview = %s, %v", got, err)
	}
	if len(clipped) > previewSourceBytes || strings.HasSuffix(clipped, "node_") {
		t.Fatalf("clipped source is %d bytes", len(clipped))
	}
}

// No right-hand value of a matching question and no item of an ordering
// question ever reaches a preview: readers of a list never get quiz keys, and
// any order of the items could be the answer (security regression: review 1
// M2).
func TestPreviewHidesTheAnswerKey(t *testing.T) {
	question := func(answer string) string {
		return `{"id":"q1","stem":[],"layout":"paper","labels":"letters","parts":[{"id":"q1:part:1",
			"blocks":[{"type":"text","text":"Q"}],"marks":1,"solution":[],"answer":` + answer + `}]}`
	}
	preview := func(answer string) string {
		t.Helper()
		raw, err := Preview("quiz", quizOf(t, question(answer)))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	// Alphabetical prompts and options whose sorted columns are the key.
	matching := preview(`{"type":"matching","options":["Ca","Fe","Na"],
		"pairs":[{"left":"Calcium","right":0},{"left":"Iron","right":1},{"left":"Sodium","right":2}]}`)
	for _, right := range []string{"Ca", "Fe", "Na"} {
		if strings.Contains(matching, `"`+right+`"`) {
			t.Fatalf("matching preview carries the right-hand value %q: %s", right, matching)
		}
	}
	if !strings.Contains(matching, `"prompts":["Calcium","Iron","Sodium"]`) {
		t.Fatalf("matching preview = %s, want its prompts", matching)
	}

	ordering := preview(`{"type":"ordering","items":["Anaphase","Metaphase","Prophase","Telophase"]}`)
	for _, item := range []string{"Anaphase", "Metaphase", "Prophase", "Telophase"} {
		if strings.Contains(ordering, item) {
			t.Fatalf("ordering preview carries the item %q: %s", item, ordering)
		}
	}
	if !strings.Contains(ordering, `"itemCount":4`) {
		t.Fatalf("ordering preview = %s, want its item count", ordering)
	}
}
