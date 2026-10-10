package store

import (
	"context"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

// Flashcard content writes carry no revision check since live editing (Epo,
// 2026-10-10, D7): a write from an older read still applies. An id the set
// never had is still refused.
func TestFlashcardSaveTakesNoRevisionButRefusesUnknownCards(t *testing.T) {
	s := openMaterialTestStore(t)
	ctx := context.Background()
	owner := newBlobTestUser(t, s, "u_card_revision")
	set, err := s.CreateFlashcardSetWithCards(ctx, owner, "Revision", "blue", "", [][2]string{{"old", "answer"}}, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	cards, err := s.ListCards(ctx, set.ID)
	if err != nil {
		t.Fatal(err)
	}
	base := cards[0]
	updated, err := s.UpdateFlashcardContent(ctx, owner, set.ID, []materialdoc.Card{{ID: base.ID, Front: "new", Back: "answer"}})
	if err != nil {
		t.Fatal(err)
	}
	if updated[0].Revision <= base.Revision {
		t.Fatal("content revision did not advance")
	}
	again, err := s.UpdateFlashcardContent(ctx, owner, set.ID, []materialdoc.Card{{ID: base.ID, Front: "later", Back: "answer"}})
	if err != nil || again[0].Front != "later" {
		t.Fatalf("a write after another applies: %+v %v", again, err)
	}
	if _, err := s.UpdateFlashcardContent(ctx, owner, set.ID, []materialdoc.Card{{ID: "c_elsewhere", Front: "x", Back: "y"}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("unknown card: expected conflict, got %v", err)
	}
}
