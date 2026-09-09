package store

import (
	"context"
	"fmt"
	"testing"

	"github.com/samyung0/capy-notebook/server/internal/materialdoc"
	"github.com/samyung0/capy-notebook/server/internal/testdb"
)

// openMaterialTestStore returns a migrated store with the plan-limit catalog
// loaded, which material tests need before any quota-gated write.
func openMaterialTestStore(t *testing.T) *Store {
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

func materialTestContent(t *testing.T, text string) string {
	t.Helper()
	document := materialdoc.Empty()
	document.Value[0]["children"] = []any{map[string]any{"text": text}}
	content, err := materialdoc.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func createTestMaterial(t *testing.T, s *Store, tier PlanTier) (context.Context, string, Material) {
	t.Helper()
	ctx := context.Background()
	userID := uid("u_material")
	if _, err := s.pool.Exec(ctx, `INSERT INTO users
		(id, name, email, plan_tier, subscription_status)
		VALUES ($1,$2,$3,$4,'active')`,
		userID,
		"Material Test",
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
		Title:     "Material test",
		Content:   materialTestContent(t, "initial"),
		Privacy:   PrivacyPrivate,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, userID, material
}
