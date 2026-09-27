package store

import (
	"context"
	"errors"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
)

func TestFlashcardDraftRevisionRejectsStaleMutations(t *testing.T) {
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
	front := "new"
	updated, err := s.UpdateCardContent(ctx, base.ID, CardContentPatch{Front: &front, ExpectedRevision: base.Revision, UpdatedBy: owner})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision <= base.Revision {
		t.Fatal("content revision did not advance")
	}
	for name, mutate := range map[string]func() error{
		"edit": func() error {
			_, err := s.UpdateCardContent(ctx, base.ID, CardContentPatch{Front: &front, ExpectedRevision: base.Revision, UpdatedBy: owner})
			return err
		},
		"create": func() error { _, err := s.CreateCard(ctx, owner, set.ID, "other", "answer", base.Revision); return err },
		"delete": func() error { return s.DeleteCard(ctx, owner, base.ID, base.Revision) },
		"bulk": func() error {
			_, err := s.UpdateFlashcardContent(ctx, owner, set.ID, base.Revision, []materialdoc.Card{{ID: base.ID, Front: "stale", Back: "answer"}})
			return err
		},
		"missing": func() error {
			_, err := s.UpdateCardContent(ctx, base.ID, CardContentPatch{Front: &front, UpdatedBy: owner})
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := mutate(); !errors.Is(err, ErrConflict) {
				t.Fatalf("expected conflict, got %v", err)
			}
		})
	}
	final, err := s.GetCard(ctx, base.ID)
	if err != nil {
		t.Fatal(err)
	}
	if final.Front != "new" || final.Revision != updated.Revision {
		t.Fatalf("stale write changed card: %+v", final)
	}
}
