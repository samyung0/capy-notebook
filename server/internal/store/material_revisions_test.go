package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/evonotes/server/internal/materialdoc"
	"github.com/evonotes/server/internal/testdb"
)

func openRevisionTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := testdb.URL(t)
	ctx := context.Background()
	store, err := New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(store.Close)
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return store
}

func revisionTestContent(t *testing.T, text string) string {
	t.Helper()
	document := materialdoc.Empty()
	document.Value[0]["children"] = []any{map[string]any{"text": text}}
	content, err := materialdoc.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func createRevisionTestMaterial(
	t *testing.T,
	s *Store,
	tier PlanTier,
) (context.Context, string, Material) {
	t.Helper()
	ctx := context.Background()
	userID := uid("u_revision")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users
		(id, name, email, plan_tier, subscription_status)
		VALUES ($1,$2,$3,$4,'active')`,
		userID,
		"Revision Test",
		fmt.Sprintf("%s@example.test", userID),
		tier,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	})
	material, err := s.CreateMaterial(ctx, Material{
		CreatedBy: userID,
		Kind:      "note",
		Title:     "Revision test",
		Content: revisionTestContent(
			t,
			"initial",
		),
		Privacy: PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, userID, material
}

func replaceRevisionTestHistory(
	t *testing.T,
	s *Store,
	ctx context.Context,
	material Material,
	createdBy string,
	count int,
	lastDay time.Time,
) {
	t.Helper()
	if _, err := s.pool.Exec(ctx, `DELETE FROM material_revisions WHERE material_id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for i := 0; i < count; i++ {
		revision := int64(i + 1)
		var parent *int64
		if revision > 1 {
			value := revision - 1
			parent = &value
		}
		if err := upsertMaterialRevisionTx(ctx, tx, MaterialRevision{
			MaterialID:     material.ID,
			Revision:       revision,
			ParentRevision: parent,
			EventType:      RevisionEdit,
			Title:          material.Title,
			Content:        revisionTestContent(t, fmt.Sprintf("version-%d", revision)),
			EventMetadata:  []byte(`{"changedFields":["content"]}`),
			CreatedBy:      &createdBy,
			CreatedAt:      lastDay.AddDate(0, 0, i-count+1),
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func physicalRevisionCount(t *testing.T, s *Store, ctx context.Context, materialID string) int {
	t.Helper()
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM material_revisions
		WHERE material_id=$1`, materialID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestMaterialSavesOverwriteCurrentUTCDayVersion(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanFree)

	second := revisionTestContent(t, "second")
	expected := int64(1)
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &second, ExpectedRevision: &expected, UpdatedBy: userID,
	}); err != nil {
		t.Fatal(err)
	}
	latest := revisionTestContent(t, "latest")
	expected = 2
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &latest, ExpectedRevision: &expected, UpdatedBy: userID,
	}); err != nil {
		t.Fatal(err)
	}

	revisions, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 1 || revisions[0].Revision != 3 ||
		revisions[0].EventType != RevisionEdit ||
		revisions[0].ParentRevision == nil || *revisions[0].ParentRevision != 2 ||
		!equalJSONDocuments(revisions[0].Content, latest) {
		t.Fatalf("same-day saves did not coalesce to the latest snapshot: %#v", revisions)
	}

	stale := int64(2)
	if _, err := s.UpdateMaterial(ctx, material.ID, MaterialPatch{
		Content: &second, ExpectedRevision: &stale, UpdatedBy: userID,
	}); err != ErrConflict {
		t.Fatalf("stale update error = %v, want conflict", err)
	}
	afterConflict, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterConflict) != 1 || afterConflict[0].Revision != 3 ||
		!equalJSONDocuments(afterConflict[0].Content, latest) {
		t.Fatalf("conflicting save changed daily snapshot: %#v", afterConflict)
	}
}

func TestMaterialVersionsRollOverAtUTCDateBoundary(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanFree)
	if _, err := s.pool.Exec(ctx, `DELETE FROM material_revisions WHERE material_id=$1`, material.ID); err != nil {
		t.Fatal(err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	firstDay := time.Date(2026, 7, 30, 20, 0, 0, 0, time.UTC)
	parent := int64(1)
	nextParent := int64(2)
	firstContent := revisionTestContent(t, "first")
	endOfFirstDayContent := revisionTestContent(t, "end-of-first-day")
	nextDayContent := revisionTestContent(t, "next-day")
	for _, revision := range []MaterialRevision{
		{
			MaterialID: material.ID, Revision: 1, EventType: RevisionCreate,
			Title: material.Title, Content: firstContent,
			CreatedBy: &userID, CreatedAt: firstDay,
		},
		{
			MaterialID: material.ID, Revision: 2, ParentRevision: &parent,
			EventType: RevisionEdit, Title: material.Title,
			Content:   endOfFirstDayContent,
			CreatedBy: &userID, CreatedAt: firstDay.Add(3*time.Hour + 59*time.Minute),
		},
		{
			MaterialID: material.ID, Revision: 3, ParentRevision: &nextParent,
			EventType: RevisionEdit, Title: material.Title,
			Content:   nextDayContent,
			CreatedBy: &userID, CreatedAt: firstDay.Add(4*time.Hour + time.Minute),
		},
	} {
		if err := upsertMaterialRevisionTx(ctx, tx, revision); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	revisions, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(revisions) != 2 ||
		revisions[0].Revision != 3 ||
		!equalJSONDocuments(revisions[0].Content, nextDayContent) ||
		revisions[1].Revision != 2 ||
		!equalJSONDocuments(revisions[1].Content, endOfFirstDayContent) {
		t.Fatalf("UTC date rollover snapshots = %#v", revisions)
	}
}

func TestMaterialVersionRetentionUsesOwnerTier(t *testing.T) {
	s := openRevisionTestStore(t)
	lastDay := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name  string
		tier  PlanTier
		limit int
	}{
		{name: "free", tier: PlanFree, limit: freeMaterialRevisionLimit},
		{name: "pro", tier: PlanPro, limit: premiumMaterialRevisionLimit},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, _, material := createRevisionTestMaterial(t, s, test.tier)
			actorID := uid("u_actor")
			if _, err := s.pool.Exec(ctx, `INSERT INTO users (id,name,email,plan_tier)
				VALUES ($1,'Revision Actor',$2,'pro')`,
				actorID,
				fmt.Sprintf("%s@example.test", actorID),
			); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_, _ = s.pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, actorID)
			})

			replaceRevisionTestHistory(t, s, ctx, material, actorID, test.limit+5, lastDay)
			if got := physicalRevisionCount(t, s, ctx, material.ID); got != test.limit {
				t.Fatalf("%s owner retained %d versions, want %d", test.tier, got, test.limit)
			}
			listed, err := s.ListMaterialRevisions(ctx, material.ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(listed) != test.limit || listed[0].CreatedBy == nil ||
				*listed[0].CreatedBy != actorID {
				t.Fatalf("%s owner listed versions = %#v", test.tier, listed)
			}
		})
	}
}

func TestMaterialVersionDowngradeIsCappedThenPhysicallyPruned(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanPro)
	replaceRevisionTestHistory(
		t,
		s,
		ctx,
		material,
		userID,
		12,
		time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC),
	)
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != 12 {
		t.Fatalf("pro history count = %d, want 12", got)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET plan_tier='free' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	listed, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != freeMaterialRevisionLimit {
		t.Fatalf("downgraded history exposed %d versions, want %d", len(listed), freeMaterialRevisionLimit)
	}
	deleted, err := s.PruneMaterialRevisions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if deleted < 5 || physicalRevisionCount(t, s, ctx, material.ID) != freeMaterialRevisionLimit {
		t.Fatalf("downgrade prune deleted %d rows", deleted)
	}
}
