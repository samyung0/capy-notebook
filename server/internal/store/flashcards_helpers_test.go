package store

import (
	"context"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// setCards writes a set's cards as its whole content (live item rooms are the
// only writers of set content); a new card gets an id.
func setCards(t *testing.T, s *Store, actor, setID string, edit func([]materialdoc.Card) []materialdoc.Card) {
	t.Helper()
	ctx := context.Background()
	set, err := s.GetMaterial(ctx, setID)
	if err != nil {
		t.Fatal(err)
	}
	cards, err := materialdoc.ExtractFlashcards(set.Content)
	if err != nil {
		t.Fatal(err)
	}
	cards = edit(cards)
	for i := range cards {
		if cards[i].ID == "" {
			cards[i].ID = uid("c")
		}
	}
	content, err := materialdoc.FlashcardsDocument(cards)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateMaterial(ctx, setID, MaterialPatch{Content: &content, UpdatedBy: actor}); err != nil {
		t.Fatal(err)
	}
}

func appendCard(t *testing.T, s *Store, actor, setID, front, back string) {
	t.Helper()
	setCards(t, s, actor, setID, func(cards []materialdoc.Card) []materialdoc.Card {
		return append(cards, materialdoc.Card{Front: front, Back: back})
	})
}

func editCardFront(t *testing.T, s *Store, actor, setID, cardID, front string) {
	t.Helper()
	setCards(t, s, actor, setID, func(cards []materialdoc.Card) []materialdoc.Card {
		for i := range cards {
			if cards[i].ID == cardID {
				cards[i].Front = front
			}
		}
		return cards
	})
}

func removeCard(t *testing.T, s *Store, actor, setID, cardID string) {
	t.Helper()
	setCards(t, s, actor, setID, func(cards []materialdoc.Card) []materialdoc.Card {
		kept := cards[:0]
		for _, card := range cards {
			if card.ID != cardID {
				kept = append(kept, card)
			}
		}
		return kept
	})
}
