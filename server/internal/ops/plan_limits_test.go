package ops

import (
	"context"
	"testing"

	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func newReadStoreForTest(t *testing.T, pool *pgxpool.Pool) *ReadStore {
	t.Helper()
	app := store.NewWithPool(pool)
	if err := app.LoadPlanLimits(context.Background()); err != nil {
		t.Fatal(err)
	}
	return NewReadStore(app)
}
