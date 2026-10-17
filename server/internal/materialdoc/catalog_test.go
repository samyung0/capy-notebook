package materialdoc

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// A sample is one element of a valid document of a material kind, found by
// its index path from the top level.
type sample struct {
	kind  string
	nodes []map[string]any
	path  []int
}

func reparse(t *testing.T, value any) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var nodes []map[string]any
	if err := dec.Decode(&nodes); err != nil {
		t.Fatal(err)
	}
	return nodes
}

func nodeAt(nodes []map[string]any, path []int) map[string]any {
	node := nodes[path[0]]
	for _, i := range path[1:] {
		node = node["children"].([]any)[i].(map[string]any)
	}
	return node
}

func validateAs(kind string, nodes []map[string]any) error {
	raw, err := json.Marshal(Envelope{SchemaVersion: SchemaVersion, Value: nodes})
	if err != nil {
		return err
	}
	return ValidateKind(string(raw), kind)
}

// catalogDocuments are valid documents of every material kind that together
// hold every element type: the every-block note (shared with the
// collaboration server and the UAT journey) plus the transient and newer
// elements it does not carry, a quiz, a card set and a mindmap.
func catalogDocuments(t *testing.T) map[string][]map[string]any {
	t.Helper()
	raw, err := os.ReadFile("testdata/every-block-note.json")
	if err != nil {
		t.Fatal(err)
	}
	stored, err := ResolvePendingRefs(string(raw), []string{"mat_quiz", "mat_cards"})
	if err != nil {
		t.Fatal(err)
	}
	var note Envelope
	if err := json.Unmarshal([]byte(stored), &note); err != nil {
		t.Fatal(err)
	}
	fixture := func(name string) map[string]any {
		raw, err := os.ReadFile("../questions/testdata/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var f struct {
			Question map[string]any `json:"question"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		return f.Question
	}
	plot := fixture("plot")["stem"].([]any)[1]
	leaf := []any{textLeaf("")}
	extra := []map[string]any{
		{"type": "plot", "id": "cat_plot", "block": plot, "children": leaf},
		{"type": "placeholder", "id": "cat_upload", "mediaType": "img", "children": leaf},
		{"type": "p", "id": "cat_inputs", "children": []any{
			textLeaf("Ask "),
			map[string]any{"type": "mention_input", "trigger": "@", "children": leaf},
			textLeaf(" or "),
			map[string]any{"type": "slash_input", "trigger": "/", "children": leaf},
			textLeaf(""),
		}},
	}
	question, err := json.Marshal([]any{fixture("rich-blocks")})
	if err != nil {
		t.Fatal(err)
	}
	quiz, err := QuizDocument(question, nil)
	if err != nil {
		t.Fatal(err)
	}
	cards, err := FlashcardsDocument([]Card{
		{ID: "c1", Front: "Osmosis", Back: "Water across a membrane", Image: &CardImage{AssetID: "asset_1"}},
		{ID: "c2", Front: "Diffusion", Back: "Down a gradient"},
	})
	if err != nil {
		t.Fatal(err)
	}
	mindmap, err := MermaidDocument("mindmap\n  root((Cells))\n    Membrane", "Cells")
	if err != nil {
		t.Fatal(err)
	}
	docs := map[string][]map[string]any{embeds.Note: reparse(t, append(note.Value, extra...))}
	for kind, raw := range map[string]string{
		embeds.Quiz: quiz, embeds.Flashcards: cards, embeds.Mindmap: mindmap, embeds.Diagram: mindmap,
	} {
		var doc Envelope
		if err := json.Unmarshal([]byte(raw), &doc); err != nil {
			t.Fatal(err)
		}
		docs[kind] = reparse(t, doc.Value)
	}
	return docs
}

// Every element type the embed catalog lists appears in a fixture, and Go
// applies the catalog's rules to each: required keys, keys it never carries,
// a closed field set, top-level placement and the material kinds that may
// hold it. A type the catalog does not list is refused.
func TestValidatorFollowsTheCatalog(t *testing.T) {
	docs := catalogDocuments(t)
	samples := map[string]sample{}
	for _, k := range embeds.MaterialKinds() {
		nodes := docs[k.Kind]
		if err := validateAs(k.Kind, nodes); err != nil {
			t.Fatalf("%s fixture: %v", k.Kind, err)
		}
		var walk func(node map[string]any, path []int)
		walk = func(node map[string]any, path []int) {
			if typ, _ := node["type"].(string); typ != "" {
				if _, seen := samples[typ]; !seen {
					samples[typ] = sample{k.Kind, nodes, slices.Clone(path)}
				}
			}
			for i, child := range children(node) {
				walk(child, append(path, i))
			}
		}
		for i, node := range nodes {
			walk(node, []int{i})
		}
	}

	for _, e := range embeds.Elements() {
		s, ok := samples[e.Type]
		if !ok {
			t.Errorf("no fixture holds a %s", e.Type)
			continue
		}
		with := func(mutate func(nodes []map[string]any)) error {
			nodes := reparse(t, s.nodes)
			mutate(nodes)
			return validateAs(s.kind, nodes)
		}
		for _, key := range e.Required {
			if err := with(func(n []map[string]any) { delete(nodeAt(n, s.path), key) }); err == nil {
				t.Errorf("a %s without %s is accepted", e.Type, key)
			}
		}
		for _, key := range e.Forbidden {
			if err := with(func(n []map[string]any) { nodeAt(n, s.path)[key] = "x" }); err == nil {
				t.Errorf("a %s carrying %s is accepted", e.Type, key)
			}
		}
		if e.Fields != nil {
			if err := with(func(n []map[string]any) { nodeAt(n, s.path)["extra"] = "x" }); err == nil {
				t.Errorf("a %s with an unknown field is accepted", e.Type)
			}
		}
		if e.TopLevel {
			nested := func(n []map[string]any) {
				n[s.path[0]] = map[string]any{"type": "callout", "id": "wrap", "children": []any{n[s.path[0]]}}
			}
			if err := with(nested); err == nil {
				t.Errorf("a nested %s is accepted", e.Type)
			}
		}
		top := reparse(t, []map[string]any{s.nodes[s.path[0]]})[0]
		for _, k := range embeds.MaterialKinds() {
			if slices.Contains(e.Materials, k.Kind) {
				continue
			}
			if err := validateAs(k.Kind, append(reparse(t, docs[k.Kind]), top)); err == nil {
				t.Errorf("a %s holding a %s is accepted", k.Kind, e.Type)
			}
		}
	}

	// A type the catalog does not list is refused on every write, and a
	// stored document holding one stays readable (Epo 2026-10-13).
	unknown := []map[string]any{{"type": "toggle", "id": "t", "children": []any{textLeaf("")}}}
	if err := validateAs(embeds.Note, unknown); err == nil {
		t.Error("an element type the catalog does not list is accepted")
	}
	raw, err := json.Marshal(Envelope{SchemaVersion: SchemaVersion, Value: unknown})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(string(raw)); err != nil {
		t.Errorf("a stored document with an unknown type does not read: %v", err)
	}
}

// What every catalog element gives the index text is its catalog rule
// (notes::index_text tests the same in the collaboration server): a probe
// carrying a marker wherever a rule reads (its children, a figure's block,
// the Mermaid source, a question, a referenced item) shows it unless the
// rule is none. A type the catalog does not list gives its text, as the
// View shows an unsupported block's.
func TestIndexTextFollowsTheCatalog(t *testing.T) {
	probe := func(typ string) string {
		node := map[string]any{
			"type": typ, "id": "probe", "materialId": "m", "source": "marker",
			"block":    map[string]any{"type": typ, "title": "marker", "description": "marker"},
			"question": map[string]any{"stem": []any{map[string]any{"type": "text", "text": "marker"}}},
			"children": []any{map[string]any{"type": "p", "children": []any{textLeaf("marker")}}},
		}
		return strings.Join(indexPieces([]map[string]any{node}, map[string]string{"m": "marker"}), "\n\n")
	}
	for _, e := range embeds.Elements() {
		if text := probe(e.Type); strings.Contains(text, "marker") != (e.Index != embeds.IndexNone) {
			t.Errorf("a %s (%s) gives %q", e.Type, e.Index, text)
		}
	}
	if text := probe("toggle"); text != "marker" {
		t.Errorf("an unlisted type gives %q", text)
	}
}
