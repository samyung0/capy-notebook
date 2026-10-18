package materialdoc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/embeds"
)

// indexFixture is one golden case in testdata/index_text, read by the
// collaboration server's notes::index_text tests too: a note, the stored
// content of its embedded items by id, and its index text per block.
type indexFixture struct {
	Document json.RawMessage            `json:"document"`
	Items    map[string]json.RawMessage `json:"items"`
	Blocks   []IndexBlock               `json:"blocks"`
}

func readIndexFixtures(t *testing.T) map[string]indexFixture {
	t.Helper()
	paths, err := filepath.Glob("testdata/index_text/*.json")
	if err != nil || len(paths) == 0 {
		t.Fatalf("no index text fixtures: %v", err)
	}
	out := map[string]indexFixture{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var f indexFixture
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		out[filepath.Base(path)] = f
	}
	return out
}

func (f indexFixture) items() map[string]string {
	items := make(map[string]string, len(f.Items))
	for id, raw := range f.Items {
		items[id] = string(raw)
	}
	return items
}

// The golden index text per block, and the note's text as their join.
func TestExtractIndexBlocksMatchesTheGoldenFixtures(t *testing.T) {
	for name, f := range readIndexFixtures(t) {
		blocks, err := ExtractIndexBlocks(string(f.Document), f.items())
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if !reflect.DeepEqual(blocks, f.Blocks) {
			got, _ := json.MarshalIndent(blocks, "", "  ")
			t.Errorf("%s: blocks =\n%s", name, got)
		}
		text, err := ExtractIndexText(string(f.Document), f.items())
		if err != nil || text != JoinIndexBlocks(f.Blocks) {
			t.Errorf("%s: text is not the blocks' join (%v)", name, err)
		}
	}
}

// A list indent past the catalog's maximum, which validation refuses, still
// reads as the deepest one instead of reaching strings.Repeat.
func TestIndexTextBoundsAListIndent(t *testing.T) {
	node := map[string]any{"type": "p", "id": "l1", "indent": 1e30, "listStyleType": "disc", "children": []any{textLeaf("deep")}}
	want := strings.Repeat("  ", embeds.ListIndentMax-1) + "- deep"
	if got := indexPieces([]map[string]any{node}, nil); !reflect.DeepEqual(got, []string{want}) {
		t.Fatalf("index = %q", got)
	}
}
