package ops

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func rolePool(
	t *testing.T,
	ctx context.Context,
	ownerDSN, role, password string,
) *pgxpool.Pool {
	t.Helper()
	config, err := pgxpool.ParseConfig(ownerDSN)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.User = role
	config.ConnConfig.Password = password
	config.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestProductionRoleContractsAndLeastPrivilegeRegistrySave(t *testing.T) {
	ownerDSN := integrationDSN(t)
	ctx := context.Background()
	owner, err := pgxpool.New(ctx, ownerDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	if err := ValidateDatabaseRole(ctx, owner, ReadDatabaseRole); err == nil {
		t.Fatal("database owner was accepted as the ops read role")
	}
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	readRole := "ops_read_test_" + suffix
	authRole := "ops_auth_test_" + suffix
	registryRole := "ops_registry_test_" + suffix
	password := "ops-test-password"
	readIdent := pgx.Identifier{readRole}.Sanitize()
	authIdent := pgx.Identifier{authRole}.Sanitize()
	registryIdent := pgx.Identifier{registryRole}.Sanitize()

	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		CREATE ROLE %s LOGIN NOINHERIT PASSWORD '%s';
		CREATE ROLE %s LOGIN NOINHERIT PASSWORD '%s';
		CREATE ROLE %s LOGIN NOINHERIT PASSWORD '%s';
		GRANT CONNECT ON DATABASE %s TO %s, %s, %s;
		GRANT USAGE ON SCHEMA public TO %s, %s, %s;

		GRANT SELECT (
			day, actor_user_id, kind, surface, provider, model,
			events, input_tokens, output_tokens, units, credit_micros
		) ON usage_daily TO %s;
		GRANT SELECT (
			user_id, period_start, used_micros, reserved_micros
		) ON user_credits TO %s;
		GRANT SELECT (status, expires_at, settled_at)
			ON credit_reservations TO %s;
		GRANT SELECT (user_id, used_bytes, reserved_bytes)
			ON user_storage TO %s;
		GRANT SELECT (user_id, delta_bytes)
			ON user_storage_deltas TO %s;
		GRANT SELECT (
			id, name, email, plan_tier, deletion_requested_at, purge_after,
			deleted_at, suspended_at, suspended_reason, created_at
		) ON users TO %s;
		GRANT SELECT (user_id, current_period_end)
			ON user_subscriptions TO %s;
		GRANT SELECT (
			id, user_id, name, embedding_model_key, embedding_model_version,
			embedding_dim, last_accessed_at
		) ON workspaces TO %s;
		GRANT SELECT (user_id, role) ON operators TO %s;
		GRANT SELECT (
			model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, context_window_tokens, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for, created_at
		) ON model_configs TO %s;
		GRANT SELECT (id, version, updated_at)
			ON model_registry_state TO %s;
		GRANT SELECT (id, last_run_at) ON usage_rollup_state TO %s;
		GRANT SELECT ON ops_completed_assistant_messages TO %s;
		GRANT SELECT (id, workspace_id) ON files TO %s;
		GRANT SELECT (status, locked_at, lease_expires_at, updated_at)
			ON jobs TO %s;
		GRANT SELECT (status, updated_at) ON email_outbox TO %s;
		GRANT SELECT (
			trace_id, actor_user_id, kind, surface, provider, model,
			model_key, model_version, input_tokens, output_tokens, units, unit,
			credit_micros, created_at
		) ON usage_events TO %s;

		GRANT EXECUTE ON FUNCTION touch_operator_seen(text) TO %s;

		GRANT SELECT (
			model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, context_window_tokens, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for, created_at
		) ON model_configs TO %s;
		GRANT SELECT (id, version, updated_at)
			ON model_registry_state TO %s;
		GRANT SELECT (id, embedding_model_key, embedding_model_version, embedding_dim)
			ON workspaces TO %s;
		GRANT SELECT (
			id, email, locale, chat_model_key, generate_model_key,
			editor_model_key, quiz_model_key
		) ON users TO %s;
		GRANT SELECT (
			user_id, email_workspace_invite, email_membership, email_billing
		) ON notification_prefs TO %s;
		GRANT SELECT (
			id, user_id, kind, data, href, workspace_id, workspace_invite_id,
			at, read_at
		) ON notifications TO %s;
		GRANT SELECT (idempotency_key) ON email_outbox TO %s;
		GRANT INSERT (
			model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, context_window_tokens, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) ON model_configs TO %s;
		GRANT UPDATE ON model_configs TO %s;
		GRANT UPDATE (version, updated_at)
			ON model_registry_state TO %s;
		GRANT UPDATE (
			chat_model_key, generate_model_key, editor_model_key, quiz_model_key,
			updated_at
		) ON users TO %s;
		GRANT INSERT (
			id, user_id, kind, data, href, workspace_id, workspace_invite_id, at
		) ON notifications TO %s;
		GRANT INSERT (
			id, user_id, to_email, template, locale, payload, idempotency_key
		) ON email_outbox TO %s;
	`, readIdent, password, authIdent, password, registryIdent, password,
		pgx.Identifier{owner.Config().ConnConfig.Database}.Sanitize(),
		readIdent, authIdent, registryIdent,
		readIdent, authIdent, registryIdent,
		readIdent, readIdent, readIdent, readIdent, readIdent, readIdent,
		readIdent, readIdent, readIdent, readIdent, readIdent, readIdent,
		readIdent, readIdent, readIdent, readIdent, readIdent,
		authIdent,
		registryIdent, registryIdent, registryIdent, registryIdent,
		registryIdent, registryIdent, registryIdent, registryIdent,
		registryIdent, registryIdent, registryIdent, registryIdent,
		registryIdent,
	)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(ctx, fmt.Sprintf(`
			SELECT pg_terminate_backend(pid) FROM pg_stat_activity
			WHERE usename IN ('%s', '%s', '%s');
			DROP OWNED BY %s, %s, %s;
			DROP ROLE IF EXISTS %s, %s, %s`,
			readRole, authRole, registryRole,
			readIdent, authIdent, registryIdent,
			readIdent, authIdent, registryIdent,
		))
	})

	readPool := rolePool(t, ctx, ownerDSN, readRole, password)
	authPool := rolePool(t, ctx, ownerDSN, authRole, password)
	registryPool := rolePool(t, ctx, ownerDSN, registryRole, password)
	if err := ValidateDatabaseRole(ctx, readPool, ReadDatabaseRole); err != nil {
		t.Fatalf("read role contract: %v", err)
	}
	if err := ValidateDatabaseRole(ctx, authPool, AuthDatabaseRole); err != nil {
		t.Fatalf("auth role contract: %v", err)
	}
	if err := ValidateDatabaseRole(ctx, registryPool, RegistryDatabaseRole); err != nil {
		t.Fatalf("registry role contract: %v", err)
	}

	if _, err := readPool.Exec(ctx,
		`INSERT INTO users (id, name) VALUES ('forbidden', 'forbidden')`,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("read role write error = %v, want insufficient privilege", err)
	}
	if _, err := readPool.Exec(ctx, `SELECT content FROM messages LIMIT 1`); !isInsufficientPrivilege(err) {
		t.Fatalf("read role content error = %v, want insufficient privilege", err)
	}
	if _, err := authPool.Exec(ctx, `UPDATE operators SET last_seen_at=now()`); !isInsufficientPrivilege(err) {
		t.Fatalf("auth direct update error = %v, want insufficient privilege", err)
	}
	if _, err := authPool.Exec(ctx, `SELECT user_id FROM operators LIMIT 1`); !isInsufficientPrivilege(err) {
		t.Fatalf("auth table read error = %v, want insufficient privilege", err)
	}

	readStore := NewReadStore(store.NewWithPool(readPool))
	modelKey := "ops-role-model-" + suffix
	userID := "ops_role_user_" + suffix
	if _, err := owner.Exec(ctx, `
		INSERT INTO model_configs (
			model_key, version, display_name, provider_slug, base_url,
			provider_model_id, auth_mode, context_window_tokens, params,
			surfaces, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			$1, 1, 'Ops Role Model', 'deepseek', 'https://example.test',
			'ops-role-model', 'platform', 100000,
			'{"reasoning":{"canDisable":true,"efforts":["low"],"defaultMode":"off","defaultEffort":"low"}}',
			ARRAY['chat'], 1, 1, 1, true, '{}'
		)`, modelKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO users (id, name, email, chat_model_key)
		VALUES ($1, 'Ops Role User', $2, $3)`,
		userID, userID+"@example.test", modelKey,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID)
		_, _ = owner.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
		_, _ = owner.Exec(ctx, `DELETE FROM model_configs WHERE model_key=$1`, modelKey)
	})
	snapshot, err := NewRegistryStore(readPool, registryPool).Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	originalVersion := snapshot.Version
	t.Cleanup(func() {
		_, _ = owner.Exec(ctx,
			`UPDATE model_registry_state SET version=$1 WHERE id=true`,
			originalVersion,
		)
	})
	request := gridRequest(snapshot)
	registry := NewRegistryStore(readPool, registryPool)
	current := configByKey(t, snapshot, modelKey)
	draft := draftFromConfig("role-version", current)
	draft.BaseURL = "https://versioned.example.test"
	request.Drafts = []gridDraft{draft}
	for index := range request.Cells {
		cell := &request.Cells[index]
		if cell.RowKey == modelKey {
			cell.Target = CellTarget{Kind: "draft", DraftID: draft.ID}
		}
	}
	result, err := registry.saveGrid(ctx, request)
	if err != nil {
		t.Fatalf("least-privilege registry Save failed: %v", err)
	}
	if result.Version != originalVersion+1 ||
		result.InsertedRows != 1 || result.DisabledRows != 1 {
		t.Fatalf("least-privilege version Save result: %+v", result)
	}
	snapshot, err = registry.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	request = gridRequest(snapshot)
	filtered := request.Cells[:0]
	for _, cell := range request.Cells {
		if cell.RowKey != modelKey {
			filtered = append(filtered, cell)
		}
	}
	request.Cells = filtered
	request.Deprecations = []DeprecationFallback{{
		ModelKey: modelKey, Surface: "chat", FallbackKey: "deepseek-flash",
	}}
	result, err = registry.saveGrid(ctx, request)
	if err != nil {
		t.Fatalf("least-privilege deprecation Save failed: %v", err)
	}
	if result.RemappedUsers != 1 || result.Notifications != 1 ||
		result.DisabledRows != 1 {
		t.Fatalf("least-privilege deprecation result: %+v", result)
	}
	var preference, idempotencyKey string
	if err := owner.QueryRow(ctx, `
		SELECT u.chat_model_key, e.idempotency_key
		FROM users u JOIN email_outbox e ON e.user_id=u.id
		WHERE u.id=$1`, userID,
	).Scan(&preference, &idempotencyKey); err != nil {
		t.Fatal(err)
	}
	if preference != "deepseek-flash" ||
		idempotencyKey != fmt.Sprintf(
			"model-deprecated:%s:deepseek-flash:%s", modelKey, userID,
		) {
		t.Fatalf("least-privilege deprecation persisted %q, %q",
			preference, idempotencyKey)
	}
	if _, err := registryPool.Exec(ctx,
		`DELETE FROM model_configs WHERE model_key='deepseek-flash'`,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("registry delete error = %v, want insufficient privilege", err)
	}
	if _, err := registryPool.Exec(ctx, `SELECT content FROM messages LIMIT 1`); !isInsufficientPrivilege(err) {
		t.Fatalf("registry content error = %v, want insufficient privilege", err)
	}
	if _, err := readStore.Overview(ctx); err != nil {
		t.Fatalf("least-privilege overview failed: %v", err)
	}
	if _, err := readStore.Health(ctx, 30); err != nil {
		t.Fatalf("least-privilege health failed: %v", err)
	}
	if _, err := owner.Exec(ctx,
		`DELETE FROM email_outbox WHERE user_id=$1`, userID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx,
		`DELETE FROM model_configs WHERE model_key=$1`, modelKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx,
		`UPDATE model_registry_state SET version=$1 WHERE id=true`, originalVersion,
	); err != nil {
		t.Fatal(err)
	}
}

func isInsufficientPrivilege(err error) bool {
	var postgresError *pgconn.PgError
	return err != nil &&
		errors.As(err, &postgresError) &&
		postgresError.Code == "42501"
}
