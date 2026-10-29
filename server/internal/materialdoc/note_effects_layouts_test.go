package materialdoc

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
)

// The same note edits on the Plate layout and the BlockSuite blocks layout
// (todo-blocksuite-spike.md boundary 2): the collaboration server's
// effects_layouts test runs each edit on both rooms and writes their
// projections to testdata/effects_layouts.json. Both give the same effects
// JSON, naming only the edited blocks, though the blocks projection derives
// other ids for code lines, cells, a cell's paragraph and inline elements.
func TestNoteChangesMatchAcrossLayouts(t *testing.T) {
	raw, err := os.ReadFile("testdata/effects_layouts.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Indexed json.RawMessage            `json:"indexed"`
		Items   map[string]json.RawMessage `json:"items"`
		Cases   []struct {
			Name    string          `json:"name"`
			Changed []string        `json:"changed"`
			Plate   json.RawMessage `json:"plate"`
			Blocks  json.RawMessage `json:"blocks"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	items := map[string]string{}
	for id, content := range fixture.Items {
		items[id] = string(content)
	}
	read := func(value json.RawMessage) []NoteBlock {
		t.Helper()
		blocks, err := ExtractNoteBlocks(`{"schemaVersion":1,"value":`+string(value)+`}`, items)
		if err != nil {
			t.Fatal(err)
		}
		return blocks
	}
	indexed := read(fixture.Indexed)
	if len(fixture.Cases) < 10 {
		t.Fatalf("only %d cases", len(fixture.Cases))
	}
	for _, c := range fixture.Cases {
		plate, plateTokens := NoteChanges(indexed, read(c.Plate))
		blocks, blocksTokens := NoteChanges(indexed, read(c.Blocks))
		plateJSON, _ := json.Marshal(plate)
		blocksJSON, _ := json.Marshal(blocks)
		if string(plateJSON) != string(blocksJSON) || plateTokens != blocksTokens {
			t.Errorf("%s: plate %s (%d tokens), blocks %s (%d tokens)", c.Name, plateJSON, plateTokens, blocksJSON, blocksTokens)
		}
		named := []string{}
		for _, effect := range blocks {
			named = append(named, effect.BlockID)
		}
		sort.Strings(named)
		want := append([]string{}, c.Changed...)
		sort.Strings(want)
		if !reflect.DeepEqual(named, want) {
			t.Errorf("%s: effects name %v, want %v", c.Name, named, want)
		}
	}
}
