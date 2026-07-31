package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

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

func TestCloneMaterialUsesTargetTierForDailyVersionRetention(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx := context.Background()
	sourceUserID := uid("u_clone_source")
	targetUserID := uid("u_clone_target")
	for _, user := range []struct {
		id   string
		tier PlanTier
	}{
		{id: sourceUserID, tier: PlanPro},
		{id: targetUserID, tier: PlanFree},
	} {
		if _, err := s.pool.Exec(ctx, `INSERT INTO users
			(id,name,email,plan_tier,subscription_status)
			VALUES ($1,'Clone Revision Test',$2,$3,'active')`,
			user.id,
			fmt.Sprintf("%s@example.test", user.id),
			user.tier,
		); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`,
			[]string{sourceUserID, targetUserID})
	})

	content, err := materialdoc.FlashcardsDocument("Clone retention", []materialdoc.Card{{
		ID: "source-card", Front: "front", Back: "back",
	}})
	if err != nil {
		t.Fatal(err)
	}
	source, err := s.CreateMaterial(ctx, Material{
		UserID: sourceUserID, Kind: "flashcards", Title: "Clone retention",
		Content: content, Privacy: PrivacyPublic,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM material_revisions WHERE material_id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	lastDay := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	for i := 0; i < 10; i++ {
		revision := int64(i + 1)
		var parent *int64
		if revision > 1 {
			value := revision - 1
			parent = &value
		}
		if err := upsertMaterialRevisionTx(ctx, tx, MaterialRevision{
			MaterialID: source.ID, Revision: revision, ParentRevision: parent,
			EventType: RevisionEdit, Title: source.Title, Content: content,
			EventMetadata: []byte(`{"changedFields":["content"]}`),
			CreatedBy:     &sourceUserID,
			CreatedAt:     lastDay.AddDate(0, 0, i-9),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE materials SET revision=10 WHERE id=$1`, source.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	cloned, err := s.CloneMaterial(ctx, targetUserID, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	versions, err := s.ListMaterialRevisions(ctx, cloned.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(versions) != freeMaterialRevisionLimit {
		t.Fatalf("free clone retained %d versions, want %d", len(versions), freeMaterialRevisionLimit)
	}
	clonedCards, err := materialdoc.ExtractFlashcards(cloned.Content)
	if err != nil {
		t.Fatal(err)
	}
	if len(clonedCards) != 1 || clonedCards[0].ID == "source-card" {
		t.Fatalf("clone current content card IDs were not rewritten: %#v", clonedCards)
	}
	for _, version := range versions {
		cards, err := materialdoc.ExtractFlashcards(version.Content)
		if err != nil {
			t.Fatal(err)
		}
		if len(cards) != 1 || cards[0].ID != clonedCards[0].ID {
			t.Fatalf("clone version card IDs diverged from current content: %#v", cards)
		}
	}
}
