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
	store, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(store.Close)
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := store.LoadPlanLimits(ctx); err != nil {
		t.Fatalf("plan limits: %v", err)
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
		if err := s.upsertMaterialRevisionTx(ctx, tx, MaterialRevision{
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
		if err := s.upsertMaterialRevisionTx(ctx, tx, revision); err != nil {
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
		{name: "free", tier: PlanFree, limit: mustPlanLimits(t, s, PlanFree).MaterialRevisions},
		{name: "pro", tier: PlanPro, limit: mustPlanLimits(t, s, PlanPro).MaterialRevisions},
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
	periodEnd := time.Now().UTC().Add(24 * time.Hour)
	subscription := Subscription{
		StripeSubscriptionID: uid("sub"), UserID: userID,
		Status: "active", PriceID: "price_pro", PlanTier: PlanPro,
		CurrentPeriodEnd: &periodEnd, StripeEventCreated: 1,
	}
	if err := s.UpsertSubscription(ctx, subscription); err != nil {
		t.Fatal(err)
	}
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
	periodEnd = time.Now().UTC().Add(-time.Hour)
	subscription.Status = "canceled"
	subscription.CurrentPeriodEnd = &periodEnd
	subscription.StripeEventCreated = 2
	if err := s.UpsertSubscription(ctx, subscription); err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).MaterialRevisions
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != freeLimit {
		t.Fatalf("downgrade retained %d physical versions, want %d", got, freeLimit)
	}
	listed, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != freeLimit {
		t.Fatalf("downgraded history exposed %d versions, want %d", len(listed), freeLimit)
	}
}

func TestRevisionRetentionUsesLiveSubscriptionBeforePlanProjection(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanFree)
	periodEnd := time.Now().UTC().Add(24 * time.Hour)
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id, user_id, status, plan_tier,
		 current_period_end, stripe_event_created)
		VALUES ($1,$2,'active','pro',$3,1)`, uid("sub"), userID, periodEnd); err != nil {
		t.Fatal(err)
	}
	const history = 12
	replaceRevisionTestHistory(
		t, s, ctx, material, userID, history,
		time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC),
	)
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("live Pro subscription retained %d revisions, want %d", got, history)
	}
	if _, err := s.PruneMaterialRevisions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("daily prune retained %d live Pro revisions, want %d", got, history)
	}
	listed, err := s.ListMaterialRevisions(ctx, material.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != history {
		t.Fatalf("live Pro listing returned %d revisions, want %d", len(listed), history)
	}
}

func TestClosedLifecycleProviderRefreshPreservesPaidRevisionHistory(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanFree)
	periodEnd := time.Now().UTC().Add(24 * time.Hour)
	subscription := Subscription{
		StripeSubscriptionID: uid("sub"),
		UserID:               userID,
		Status:               "active",
		PriceID:              "price_pro",
		PlanTier:             PlanPro,
		CurrentPeriodEnd:     &periodEnd,
		StripeEventCreated:   1,
	}
	if err := s.UpsertSubscription(ctx, subscription); err != nil {
		t.Fatal(err)
	}
	const history = 12
	replaceRevisionTestHistory(
		t, s, ctx, material, userID, history,
		time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
	)
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}

	subscription.StripeEventCreated = 2
	if err := s.UpsertSubscription(ctx, subscription); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSubscriptionPastDue(ctx, subscription.StripeSubscriptionID, 3); err != nil {
		t.Fatal(err)
	}
	version, err := s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	subscription.Status = "past_due"
	if _, err := s.SyncSubscriptionsFromStripe(
		ctx, userID, []Subscription{subscription}, version, 4, nil,
	); err != nil {
		t.Fatal(err)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("closed provider refresh retained %d revisions, want %d", got, history)
	}
	if _, err := s.PruneMaterialRevisions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("daily prune retained %d closed Pro revisions, want %d", got, history)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("restored account retained %d revisions, want %d", got, history)
	}
}

func TestClosedLifecyclePreservesNoRowStoredProRevisionHistory(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanPro)
	const history = 12
	replaceRevisionTestHistory(
		t, s, ctx, material, userID, history,
		time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
	)
	version, err := s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SyncSubscriptionsFromStripe(ctx, userID, nil, version, 2_000, nil); err != nil {
		t.Fatal(err)
	}
	if tier, _ := projectedPlan(t, s, userID); tier != PlanPro {
		t.Fatalf("closed no-row projection tier=%s, want stored pro", tier)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("closed no-row Pro retained %d revisions, want %d", got, history)
	}
	if _, err := s.PruneMaterialRevisions(ctx); err != nil {
		t.Fatal(err)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("daily prune retained %d closed no-row Pro revisions, want %d", got, history)
	}
	if _, err := s.CancelAccountDeletion(ctx, userID); err != nil {
		t.Fatal(err)
	}
	if tier, status := projectedPlan(t, s, userID); tier != PlanPro || status != "active" {
		t.Fatalf("restored no-row projection=%s/%s, want pro/active", tier, status)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != history {
		t.Fatalf("restored no-row Pro retained %d revisions, want %d", got, history)
	}
	version, err = s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SyncSubscriptionsFromStripe(ctx, userID, nil, version, 3_000, nil); err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).MaterialRevisions
	if tier, status := projectedPlan(t, s, userID); tier != PlanFree || status != SubNone {
		t.Fatalf("empty provider snapshot projected %s/%s, want free/none", tier, status)
	}
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != freeLimit {
		t.Fatalf("empty provider snapshot retained %d revisions, want %d", got, freeLimit)
	}
}

func TestClosedLifecycleLiveFreeDoesNotRetainExpiredProRevisionHistory(t *testing.T) {
	s := openRevisionTestStore(t)
	ctx, userID, material := createRevisionTestMaterial(t, s, PlanPro)
	const history = 12
	replaceRevisionTestHistory(
		t, s, ctx, material, userID, history,
		time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
	)
	now := time.Now().UTC()
	liveFreeID := uid("sub_live_free")
	if _, err := s.pool.Exec(ctx, `INSERT INTO user_subscriptions
		(stripe_subscription_id,user_id,status,plan_tier,current_period_end,stripe_event_created)
		VALUES ($1,$2,'canceled','pro',$3,1),
		       ($4,$2,'active','free',$5,1)`,
		uid("sub_expired_pro"), userID, now.Add(-time.Hour),
		liveFreeID, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	version, err := s.SubscriptionVersion(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestAccountDeletion(ctx, userID, false); err != nil {
		t.Fatal(err)
	}
	periodEnd := now.Add(time.Hour)
	live := []Subscription{{
		StripeSubscriptionID: liveFreeID,
		Status:               "active",
		PlanTier:             PlanFree,
		CurrentPeriodEnd:     &periodEnd,
	}}
	if _, err := s.SyncSubscriptionsFromStripe(ctx, userID, live, version, 2_000, nil); err != nil {
		t.Fatal(err)
	}
	freeLimit := mustPlanLimits(t, s, PlanFree).MaterialRevisions
	if got := physicalRevisionCount(t, s, ctx, material.ID); got != freeLimit {
		t.Fatalf("closed effective Free retained %d revisions, want %d", got, freeLimit)
	}
}
