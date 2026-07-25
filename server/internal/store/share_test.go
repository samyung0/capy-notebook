package store

import (
	"strings"
	"testing"

	"github.com/evonotes/server/internal/materialdoc"
)

func TestRewriteCardIDs(t *testing.T) {
	source, err := materialdoc.FlashcardsDocument("Deck", []materialdoc.Card{
		{ID: "c_old_1", Front: "A", Back: "B"},
		{ID: "c_old_2", Front: "C", Back: "D"},
	})
	if err != nil {
		t.Fatal(err)
	}
	doc, err := materialdoc.Parse(source)
	if err != nil {
		t.Fatal(err)
	}
	flashcards := doc.Value[1]
	card := flashcards["children"].([]any)[0].(map[string]any)
	front := card["children"].([]any)[0].(map[string]any)
	front["children"] = []any{map[string]any{"text": "A", "comment": "disc_1"}}
	source, err = materialdoc.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	cloned, ids, err := rewriteCardIDs("Deck", source)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] == "c_old_1" || ids[1] == "c_old_2" || ids[0] == ids[1] {
		t.Fatalf("expected two fresh unique ids, got %#v", ids)
	}
	cards, err := materialdoc.ExtractFlashcards(cloned)
	if err != nil {
		t.Fatal(err)
	}
	if cards[0].ID != ids[0] || cards[0].Front != "A" || cards[0].Back != "B" {
		t.Fatalf("cloned card content changed: %#v", cards[0])
	}
	if strings.Contains(cloned, `"comment":"disc_1"`) {
		t.Fatalf("cloning persisted a runtime comment decoration: %s", cloned)
	}
}
