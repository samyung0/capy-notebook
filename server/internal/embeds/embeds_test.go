package embeds_test

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/agenttools"
	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

func TestGeneratedFilesAreCurrent(t *testing.T) {
	jsonFile, err := embeds.JSON()
	if err != nil {
		t.Fatal(err)
	}
	ts, err := embeds.TypeScript()
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string][]byte{
		embeds.JSONPath:       jsonFile,
		embeds.TypeScriptPath: ts,
		embeds.RustPath:       embeds.Rust(),
	} {
		got, err := os.ReadFile(filepath.Join("..", "..", "..", filepath.FromSlash(path)))
		if err != nil {
			t.Fatalf("read %s: %v (run pnpm gen:openapi)", path, err)
		}
		if !bytes.Equal(bytes.ReplaceAll(got, []byte("\r\n"), []byte("\n")), want) {
			t.Errorf("%s is stale; run pnpm gen:openapi", path)
		}
	}
}

// Every name the catalog uses points at something it lists.
func TestCatalogIsConsistent(t *testing.T) {
	c := embeds.Get()
	elements := map[string]embeds.Element{}
	for _, e := range c.Elements {
		if _, dup := elements[e.Type]; dup {
			t.Errorf("element %s listed twice", e.Type)
		}
		elements[e.Type] = e
	}
	kinds := map[string]embeds.MaterialKind{}
	for _, k := range c.MaterialKinds {
		kinds[k.Kind] = k
		if _, ok := elements[k.Requires]; k.Requires != "" && !ok {
			t.Errorf("material %s requires unknown element %s", k.Kind, k.Requires)
		}
	}
	for _, e := range c.Elements {
		if !slices.Contains(embeds.IndexRules, e.Index) {
			t.Errorf("%s has index rule %q, not one of %v", e.Type, e.Index, embeds.IndexRules)
		}
		for _, child := range e.Children {
			if _, ok := elements[child]; !ok {
				t.Errorf("%s holds unknown element %s", e.Type, child)
			}
		}
		if len(e.Materials) == 0 {
			t.Errorf("%s fits no material kind", e.Type)
		}
		for _, m := range e.Materials {
			if _, ok := kinds[m]; !ok {
				t.Errorf("%s names unknown material kind %s", e.Type, m)
			}
		}
		for _, key := range e.SharedText {
			if !slices.Contains(e.Required, key) {
				t.Errorf("%s shares %s, which it does not require", e.Type, key)
			}
		}
		if e.Fields != nil {
			for _, key := range e.Required {
				if !slices.Contains(e.Fields, key) {
					t.Errorf("%s requires %s outside its fields", e.Type, key)
				}
			}
		}
	}

	tools := map[string]bool{}
	for _, d := range agenttools.Definitions() {
		tools[d.Name] = true
	}
	seen := map[string]bool{}
	for _, e := range c.Embeds {
		if seen[e.Kind] {
			t.Errorf("embed %s listed twice", e.Kind)
		}
		seen[e.Kind] = true
		if _, ok := elements[e.Element]; !ok {
			t.Errorf("embed %s is held by unknown element %s", e.Kind, e.Element)
		}
		item := e.Class == embeds.ClassItem
		if item != (e.Element == "material_ref") || (!item && e.Element != e.Kind) {
			t.Errorf("embed %s (%s) is held by %s", e.Kind, e.Class, e.Element)
		}
		// The figure rule renders question blocks; the item rule a reference.
		if index := elements[e.Element].Index; (index == embeds.IndexFigure) != e.QuestionBlock ||
			(index == embeds.IndexItem) != item {
			t.Errorf("embed %s is held by %s with index rule %s", e.Kind, e.Element, index)
		}
		if item && !kinds[e.Kind].Item {
			t.Errorf("item embed %s has no item material kind", e.Kind)
		}
		for _, m := range e.Materials {
			want := e.Element
			if item {
				want = e.Kind
			}
			if kinds[m].Requires != want {
				t.Errorf("material %s holding %s requires %s", m, e.Kind, kinds[m].Requires)
			}
		}
		if e.QuestionMedia && (!e.QuestionBlock || e.Schema == nil) {
			t.Errorf("question media %s needs a question block and a schema", e.Kind)
		}
		for _, tool := range e.Edit.Agent {
			if !tools[tool] {
				t.Errorf("embed %s names unknown agent tool %s", e.Kind, tool)
			}
		}
	}
	for _, k := range c.MaterialKinds {
		if k.Item && !seen[k.Kind] {
			t.Errorf("item material %s has no embed", k.Kind)
		}
	}
}
