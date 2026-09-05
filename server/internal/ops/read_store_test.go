package ops

import (
	"context"
	"errors"
	"fmt"
	"slices"
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
	read := newReadStoreForTest(t, pool)
	if _, err := read.Overview(ctx); err != nil {
		t.Fatalf("overview: %v", err)
	}
	if _, err := read.Health(ctx, 30); err != nil {
		t.Fatalf("health: %v", err)
	}
	ingestMetrics, err := read.IngestHostMetrics(ctx, 24)
	if err != nil {
		t.Fatalf("parser metrics: %v", err)
	}
	if len(ingestMetrics.Environments) != 1 ||
		ingestMetrics.Environments[0].Environment != "production" {
		t.Fatalf("ingest environments = %+v", ingestMetrics.Environments)
	}
	if _, err := read.Reconciliation(ctx); err != nil {
		t.Fatalf("reconciliation: %v", err)
	}
	if _, err := read.AuditEvents(ctx, 0, auditPageMax); err != nil {
		t.Fatalf("operator audit: %v", err)
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
		"day",
	); err != nil {
		t.Fatalf("usage explorer: %v", err)
	}
	var healthIndexes int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM pg_indexes
		WHERE schemaname='public'
		  AND indexname IN (
			'usage_events_trace_idx',
			'ingest_host_samples_sampled_brin_idx',
			'messages_ops_assistant_idx',
			'provider_calls_reservation_idx',
			'provider_calls_context_idx',
			'provider_sessions_trace_idx'
		  )`,
	).Scan(&healthIndexes); err != nil {
		t.Fatal(err)
	}
	if healthIndexes != 6 {
		t.Fatalf("usage health indexes = %d, want 6", healthIndexes)
	}
}

func TestHealthClassifiesTurnAndProviderLifecycles(t *testing.T) {
	dsn := integrationDSN(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	read := newReadStoreForTest(t, pool)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "ops_health_user_" + suffix
	workspaceID := "ops_health_ws_" + suffix
	conversationID := "ops_health_conv_" + suffix
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, name, email) VALUES ($1, 'Ops Health', $2)`,
		userID, userID+"@example.test",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO workspaces (id, user_id, name, color)
		VALUES ($1, $2, 'Ops Health Workspace', 'green')`,
		workspaceID, userID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO conversations (id, user_id, workspace_id)
		VALUES ($1, $2, $3)`, conversationID, userID, workspaceID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	})

	type lifecycleFixture struct {
		name              string
		messageStatus     string
		reservationStatus string
		callStatus        string
	}
	fixtures := []lifecycleFixture{
		{name: "active", messageStatus: "streaming", reservationStatus: "open", callStatus: "open"},
		{name: "failed", messageStatus: "error", reservationStatus: "released", callStatus: "abandoned"},
		{name: "recovered", messageStatus: "complete", reservationStatus: "settled", callStatus: "abandoned"},
	}
	for _, fixture := range fixtures {
		messageID := "m_" + fixture.name + "_" + suffix
		traceID := "trace_" + fixture.name + "_" + suffix
		reservationID := "cr_" + fixture.name + "_" + suffix
		callID := "pc_" + fixture.name + "_" + suffix
		if _, err := pool.Exec(ctx, `
			INSERT INTO messages (
			  id, conversation_id, role, status, metadata
			) VALUES ($1, $2, 'assistant', $3,
			          jsonb_build_object('traceId', $4::text))`,
			messageID, conversationID, fixture.messageStatus, traceID,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO provider_sessions (
			  id, actor_user_id, workspace_id, trace_id, surface,
			  reserved_micros, status, expires_at, settled_at
			) VALUES ($1, $2, $3, $4, 'chat', 0, $5,
			          now() + interval '10 minutes',
			          CASE WHEN $5 = 'open' THEN NULL ELSE now() END)`,
			reservationID, userID, workspaceID, traceID, fixture.reservationStatus,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO provider_calls (
			  id, reservation_id, actor_user_id, kind, purpose, status
			) VALUES ($1, $2, $3, 'llm', 'agent', $4)`,
			callID, reservationID, userID, fixture.callStatus,
		); err != nil {
			t.Fatal(err)
		}
		if fixture.name == "recovered" {
			appliedID := "pc_applied_" + suffix
			if _, err := pool.Exec(ctx, `
				INSERT INTO provider_calls (
				  id, reservation_id, actor_user_id, kind, purpose, status,
				  applied_at
				) VALUES ($1, $2, $3, 'llm', 'agent', 'applied', now())`,
				appliedID, reservationID, userID,
			); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `
				INSERT INTO usage_events (
				  trace_id, actor_user_id, workspace_id, kind, surface,
				  reservation_id, provider_call_id
				) VALUES ($1, $2, $3, 'llm', 'chat', $4, $5)`,
				traceID, userID, workspaceID, reservationID, appliedID,
			); err != nil {
				t.Fatal(err)
			}
		}
	}
	staleMessageID := "m_stale_" + suffix
	if _, err := pool.Exec(ctx, `
		INSERT INTO messages (id, conversation_id, role, status, metadata)
		VALUES ($1, $2, 'assistant', 'streaming',
		        jsonb_build_object('traceId', $3::text))`,
		staleMessageID, conversationID, "trace_stale_"+suffix,
	); err != nil {
		t.Fatal(err)
	}

	health, err := read.Health(ctx, 30)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(health.ActiveTurns, func(turn TurnLifecycle) bool {
		return turn.MessageID == "m_active_"+suffix && turn.ReservationStatus == "open"
	}) {
		t.Fatal("active streaming turn was not classified as active")
	}
	if !slices.ContainsFunc(health.StaleTurns, func(turn TurnLifecycle) bool {
		return turn.MessageID == staleMessageID && turn.ReservationStatus == ""
	}) {
		t.Fatal("streaming turn without a reservation was not classified as stale")
	}
	if !slices.ContainsFunc(health.FailedTurns, func(turn TurnLifecycle) bool {
		return turn.MessageID == "m_failed_"+suffix && turn.ReservationStatus == "released"
	}) {
		t.Fatal("terminally failed turn did not retain its reservation outcome")
	}
	if !slices.ContainsFunc(health.AbandonedCalls, func(call ProviderCallDiagnostic) bool {
		return call.CallID == "pc_recovered_"+suffix && call.TurnStatus == "complete"
	}) {
		t.Fatal("recovered retry was not distinguished from a terminal turn failure")
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
	read := newReadStoreForTest(t, pool)
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
			stripe_subscription_id, user_id, status, plan_tier, current_period_end
		) VALUES ($2, $1, 'canceled', 'pro', now() - interval '30 days')`,
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
	session, err := read.Operator(ctx, userID)
	if err != nil {
		t.Fatalf("over-quota operator rejected: %v", err)
	}
	if session.Role != "viewer" || !slices.Contains(session.Permissions, PermReadAll) {
		t.Fatalf("operator session = %+v, want viewer with read_all", session)
	}
	if slices.Contains(session.Permissions, PermWriteRegistry) ||
		slices.Contains(session.Permissions, PermExecuteReconciliation) {
		t.Fatalf("viewer inherited write tokens: %v", session.Permissions)
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
