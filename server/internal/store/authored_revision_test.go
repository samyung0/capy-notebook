package store

import (
	"context"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func TestFlashcardSaveRejectsStaleRevisions(t *testing.T) {
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
	updated, err := s.UpdateFlashcardContent(ctx, owner, set.ID, base.Revision, []materialdoc.Card{{ID: base.ID, Front: "new", Back: "answer"}})
	if err != nil {
		t.Fatal(err)
	}
	if updated[0].Revision <= base.Revision {
		t.Fatal("content revision did not advance")
	}
	for name, save := range map[string]func() error{
		"stale": func() error {
			_, err := s.UpdateFlashcardContent(ctx, owner, set.ID, base.Revision, []materialdoc.Card{{ID: base.ID, Front: "stale", Back: "answer"}})
			return err
		},
		"unknown card": func() error {
			_, err := s.UpdateFlashcardContent(ctx, owner, set.ID, updated[0].Revision, []materialdoc.Card{{ID: "c_elsewhere", Front: "x", Back: "y"}})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := save(); !errors.Is(err, ErrConflict) {
				t.Fatalf("expected conflict, got %v", err)
			}
		})
	}
	final, err := s.ListCards(ctx, set.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(final) != 1 || final[0].Front != "new" || final[0].Revision != updated[0].Revision {
		t.Fatalf("a refused save changed the set: %+v", final)
	}
}
