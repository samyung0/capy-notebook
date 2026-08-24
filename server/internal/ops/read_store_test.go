package ops

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestReadStoreQueriesMatchTheProductionSchema(t *testing.T) {
	dsn := integrationDSN(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	read := NewReadStore(store.NewWithPool(pool))
	if _, err := read.Overview(ctx); err != nil {
		t.Fatalf("overview: %v", err)
	}
	if _, err := read.Health(ctx, 30); err != nil {
		t.Fatalf("health: %v", err)
	}
	users, err := read.SearchUsers(ctx, "kate")
	if err != nil {
		t.Fatalf("search users: %v", err)
	}
	if len(users) == 0 {
		t.Fatal("seeded user search returned no rows")
	}
	if _, err := read.User(ctx, "u_1"); err != nil {
		t.Fatalf("user detail: %v", err)
	}
	if _, err := read.Costs(
		ctx,
		time.Now().UTC().AddDate(0, 0, -30),
		time.Now().UTC(),
		"surface",
	); err != nil {
		t.Fatalf("cost explorer: %v", err)
	}
	var healthIndexes int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM pg_indexes
		WHERE schemaname='public'
		  AND indexname IN (
			'usage_events_trace_idx',
			'messages_completed_assistant_idx'
		  )`,
	).Scan(&healthIndexes); err != nil {
		t.Fatal(err)
	}
	if healthIndexes != 2 {
		t.Fatalf("usage health indexes = %d, want 2", healthIndexes)
	}
}

func TestOperatorRejectsProductAccountLocksButAllowsOverQuota(t *testing.T) {
	dsn := integrationDSN(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	read := NewReadStore(store.NewWithPool(pool))
	userID := fmt.Sprintf("ops_lifecycle_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, name, email)
		VALUES ($1, 'Ops Lifecycle', $2)`,
		userID, userID+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO operators (user_id, role) VALUES ($1, 'viewer')`, userID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_storage (user_id, used_bytes)
		VALUES ($1, 200000000)
		ON CONFLICT (user_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes`,
		userID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_subscriptions (
			stripe_subscription_id, user_id, status, current_period_end
		) VALUES ($2, $1, 'canceled', now() - interval '30 days')`,
		userID, "sub_"+userID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	status, err := read.app.AccountAccess(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != store.AccountOverQuotaFrozen {
		t.Fatalf("account state = %q, want over_quota_frozen", status.State)
	}
	if _, err := read.Operator(ctx, userID); err != nil {
		t.Fatalf("over-quota operator rejected: %v", err)
	}

	for _, testCase := range []struct {
		name  string
		query string
	}{
		{
			name: "deleted",
			query: `UPDATE users SET deletion_requested_at=now(),
				deleted_at=now() WHERE id=$1`,
		},
		{
			name: "suspended",
			query: `UPDATE users SET suspended_at=now(),
				suspended_reason='ops test' WHERE id=$1`,
		},
		{
			name:  "deletion_requested",
			query: `UPDATE users SET deletion_requested_at=now() WHERE id=$1`,
		},
	} {
		if _, err := pool.Exec(ctx,
			`UPDATE users SET deleted_at=NULL, suspended_at=NULL,
				suspended_reason=NULL, deletion_requested_at=NULL,
				purge_after=NULL WHERE id=$1`, userID,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, testCase.query, userID); err != nil {
			t.Fatal(err)
		}
		if _, err := read.Operator(ctx, userID); !errors.Is(err, store.ErrForbidden) {
			t.Fatalf("%s operator result = %v, want forbidden", testCase.name, err)
		}
	}
}

func TestSearchUsersRejectsOversizedQuery(t *testing.T) {
	read := &ReadStore{}
	if _, err := read.SearchUsers(
		context.Background(), string(make([]byte, userSearchMaxLen+1)),
	); !IsValidation(err) {
		t.Fatalf("oversized search error = %v, want validation", err)
	}
}
