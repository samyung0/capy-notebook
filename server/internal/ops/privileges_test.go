package ops

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/evonotes/server/internal/models"
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

func TestProductionRoleContractsAndLeastPrivilegeAdminActions(t *testing.T) {
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
	adminRole := "ops_admin_test_" + suffix
	password := "ops-test-password"
	readIdent := pgx.Identifier{readRole}.Sanitize()
	adminIdent := pgx.Identifier{adminRole}.Sanitize()

	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		CREATE ROLE %s LOGIN NOINHERIT PASSWORD '%s';
		CREATE ROLE %s LOGIN NOINHERIT PASSWORD '%s';
		GRANT CONNECT ON DATABASE %s TO %s, %s;
		GRANT USAGE ON SCHEMA public TO %s, %s;

		GRANT SELECT ON ops_assistant_turns TO %s;
		GRANT SELECT (
			user_id, period_start, used_micros, reserved_micros
		) ON user_credits TO %s;
		GRANT SELECT (
			id, actor_user_id, trace_id, surface, paid_by, status,
			created_at, expires_at, settled_at
		)
			ON provider_sessions TO %s;
		GRANT SELECT (
			id, reservation_id, actor_user_id, kind, purpose, status, thinking,
			cached_read_tokens, cache_write_tokens, reasoning_tokens, cache_anomaly,
			context_system_tokens, context_tool_tokens,
			context_conversation_tokens, context_total_tokens,
			context_window_tokens, context_counting_method,
			context_counting_version, opened_at, applied_at
		)
			ON provider_calls TO %s;
		GRANT SELECT (
			id, job_type, trigger, status, requested_by_id, requested_by_name,
			requested_at, started_at, finished_at, scanned_count, repaired_count,
			error_count, error
		) ON reconcile_runs TO %s;
		GRANT SELECT (
			id, run_id, event_type, subject_type, subject_id, actor_user_id,
			metadata, created_at
		) ON reconciliation_report TO %s;
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
			id, user_id, name, embedding_provider_slug, embedding_model_slug, embedding_model_version,
			embedding_dim, last_accessed_at
		) ON workspaces TO %s;
		GRANT SELECT (user_id, role) ON operators TO %s;
		GRANT SELECT (role, permission) ON ops_permissions TO %s;
		GRANT SELECT (
			version, provider_name, model_name, provider_slug, model_slug, platform_enabled, byok_enabled, thinking_levels, default_thinking, context_window_tokens, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for,
			created_at, updated_at, created_by, updated_by
		) ON model_configs TO %s;
		GRANT SELECT (id, version, updated_at)
			ON model_registry_state TO %s;
		GRANT SELECT (
			id, trace_id, actor_user_id, kind, surface, provider, model,
			thinking, catalog_provider_slug, catalog_model_slug, model_version,
			input_tokens, output_tokens, units, unit,
			parse_pages, parse_ocr_pages, parse_cpu_milliseconds,
			parse_elapsed_milliseconds, parse_queue_milliseconds,
			parse_download_milliseconds, parse_upload_milliseconds,
			parse_worker_rss_bytes, parse_worker_pss_bytes,
			parse_io_read_bytes, parse_io_write_bytes, credit_micros,
			reservation_id, provider_call_id, created_at
		) ON usage_events TO %s;
		GRANT SELECT ON ops_assistant_turns TO %s;
		GRANT SELECT (id, workspace_id) ON files TO %s;
		GRANT SELECT (status, locked_at, lease_expires_at, updated_at)
			ON jobs TO %s;
		GRANT SELECT (status, updated_at) ON email_outbox TO %s;
		GRANT SELECT (
			trace_id, actor_user_id, kind, surface, provider, model,
			thinking, catalog_provider_slug, catalog_model_slug, model_version,
			input_tokens, output_tokens, units, unit,
			parse_pages, parse_ocr_pages, parse_cpu_milliseconds,
			parse_elapsed_milliseconds, parse_queue_milliseconds,
			parse_download_milliseconds, parse_upload_milliseconds,
			parse_worker_rss_bytes, parse_worker_pss_bytes,
			parse_io_read_bytes, parse_io_write_bytes, credit_micros,
			reservation_id, provider_call_id, created_at
		) ON usage_events TO %s;

		GRANT EXECUTE ON FUNCTION touch_operator_seen(text) TO %s;

		GRANT SELECT (
			version, provider_name, model_name, provider_slug, model_slug, platform_enabled, byok_enabled, thinking_levels, default_thinking, context_window_tokens, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for,
			created_at, updated_at, created_by, updated_by
		) ON model_configs TO %s;
		GRANT SELECT (id, version, updated_at)
			ON model_registry_state TO %s;
		GRANT SELECT (id, embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim)
			ON workspaces TO %s;
		GRANT SELECT (
			id, email, locale,
			chat_model_provider_slug, chat_model_slug,
			generate_model_provider_slug, generate_model_slug,
			editor_model_provider_slug, editor_model_slug,
			quiz_model_provider_slug, quiz_model_slug
		) ON users TO %s;
		GRANT SELECT (
			user_id, email_workspace_invite, email_membership, email_billing
		) ON notification_prefs TO %s;
		GRANT SELECT (
			id, user_id, kind, data, href, workspace_id, workspace_invite_id,
			at, read_at
		) ON notifications TO %s;
		GRANT SELECT (idempotency_key) ON email_outbox TO %s;
		GRANT SELECT (user_id, provider_slug) ON user_llm_credentials TO %s;
		GRANT INSERT (
			version, provider_name, model_name, provider_slug, model_slug, platform_enabled, byok_enabled, thinking_levels, default_thinking, context_window_tokens, params, surfaces,
			micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for, created_by, updated_by
		) ON model_configs TO %s;
		GRANT UPDATE ON model_configs TO %s;
		GRANT UPDATE (version, updated_at)
			ON model_registry_state TO %s;
		GRANT UPDATE (
			chat_model_provider_slug, chat_model_slug,
			generate_model_provider_slug, generate_model_slug,
			editor_model_provider_slug, editor_model_slug,
			quiz_model_provider_slug, quiz_model_slug,
			updated_at
		) ON users TO %s;
		GRANT INSERT (
			id, user_id, kind, data, href, workspace_id, workspace_invite_id, at
		) ON notifications TO %s;
		GRANT INSERT (
			id, user_id, to_email, template, locale, payload, idempotency_key
		) ON email_outbox TO %s;
		GRANT EXECUTE ON FUNCTION model_configs_thinking_ok(text[], text[], text)
			TO %s;
	`, readIdent, password, adminIdent, password,
		pgx.Identifier{owner.Config().ConnConfig.Database}.Sanitize(),
		readIdent, adminIdent,
		readIdent, adminIdent,
		readIdent, readIdent, readIdent, readIdent, readIdent, readIdent,
		readIdent,
		readIdent, readIdent, readIdent, readIdent, readIdent, readIdent,
		readIdent, readIdent, readIdent, readIdent, readIdent, readIdent,
		readIdent, readIdent,
		readIdent,
		adminIdent, adminIdent, adminIdent, adminIdent,
		adminIdent, adminIdent, adminIdent, adminIdent,
		adminIdent, adminIdent, adminIdent, adminIdent,
		adminIdent, adminIdent, adminIdent,
	)); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		GRANT SELECT (
			resource_key, version, unit, credit_micros_per_unit, active, created_at
		) ON resource_credit_rates TO %s;
		GRANT SELECT (
			sampled_at, host_id, active_jobs, queued_jobs, cpu_percent, load_1,
			memory_total_bytes, memory_used_bytes, swap_used_bytes,
			parser_memory_bytes, parser_pss_bytes,
			network_rx_bytes, network_tx_bytes
		) ON parse_host_samples TO %s;
	`, readIdent, readIdent)); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, fmt.Sprintf(`
		GRANT SELECT (
			id, occurred_at, actor_user_id, actor_role, action,
			target_type, target_id, outcome, trace_id, metadata
		) ON operator_audit_events TO %s;
		GRANT EXECUTE ON FUNCTION request_reconciliation(text, text, text) TO %s;
		GRANT EXECUTE ON FUNCTION record_registry_audit(
			text, bigint, bigint, bigint, bigint, bigint, text
		) TO %s;
		GRANT EXECUTE ON FUNCTION save_resource_credit_rate(
			text, text, bigint, text
		) TO %s;
	`, readIdent, adminIdent, adminIdent, adminIdent)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(ctx, fmt.Sprintf(`
			SELECT pg_terminate_backend(pid) FROM pg_stat_activity
			WHERE usename IN ('%s', '%s');
			DROP OWNED BY %s, %s;
			DROP ROLE IF EXISTS %s, %s`,
			readRole, adminRole,
			readIdent, adminIdent,
			readIdent, adminIdent,
		))
	})

	readPool := rolePool(t, ctx, ownerDSN, readRole, password)
	adminPool := rolePool(t, ctx, ownerDSN, adminRole, password)
	if err := ValidateDatabaseRole(ctx, readPool, ReadDatabaseRole); err != nil {
		t.Fatalf("read role contract: %v", err)
	}
	if err := ValidateDatabaseRole(ctx, adminPool, AdminDatabaseRole); err != nil {
		t.Fatalf("admin role contract: %v", err)
	}

	if _, err := readPool.Exec(ctx,
		`INSERT INTO users (id, name) VALUES ('forbidden', 'forbidden')`,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("read role write error = %v, want insufficient privilege", err)
	}
	if _, err := readPool.Exec(ctx, `SELECT content FROM messages LIMIT 1`); !isInsufficientPrivilege(err) {
		t.Fatalf("read role content error = %v, want insufficient privilege", err)
	}
	if _, err := readPool.Exec(ctx, `UPDATE operators SET last_seen_at=now()`); !isInsufficientPrivilege(err) {
		t.Fatalf("read/auth direct update error = %v, want insufficient privilege", err)
	}

	readStore := NewReadStore(store.NewWithPool(readPool))
	modelRef := models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-pro"}
	userID := "ops_role_user_" + suffix
	if _, err := owner.Exec(ctx, `
		INSERT INTO model_configs (
			version, provider_name, model_name, provider_slug, model_slug,
			platform_enabled, byok_enabled, context_window_tokens,
			thinking_levels, default_thinking, params,
			surfaces, micros_per_input_token, micros_per_cached_input_token,
			micros_per_output_token, enabled, is_default_for
		) VALUES (
			99, 'Ops', 'Role Model', $1, $2,
			true, false, 100000,
			ARRAY['instant','low']::text[], 'instant', '{}'::jsonb,
			ARRAY['chat'], 1, 1, 1, true, '{}'
		)`, modelRef.ProviderSlug, modelRef.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `
		INSERT INTO users (id, name, email, chat_model_provider_slug, chat_model_slug)
		VALUES ($1, 'Ops Role User', $2, $3, $4)`,
		userID, userID+"@example.test", modelRef.ProviderSlug, modelRef.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx,
		`INSERT INTO operators (user_id, role) VALUES ($1, 'admin')`, userID,
	); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = owner.Exec(ctx, `DELETE FROM reconcile_runs WHERE requested_by_id=$1`, userID)
		_, _ = owner.Exec(ctx, `DELETE FROM email_outbox WHERE user_id=$1`, userID)
		_, _ = owner.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
		_, _ = owner.Exec(ctx, `DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2 AND version >= 99`, modelRef.ProviderSlug, modelRef.ModelSlug)
		_, _ = owner.Exec(ctx, `UPDATE model_configs SET enabled=true WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, modelRef.ProviderSlug, modelRef.ModelSlug)
	})
	if _, err := readPool.Exec(ctx, `SELECT touch_operator_seen($1)`, userID); err != nil {
		t.Fatalf("read/auth last-seen touch failed: %v", err)
	}
	var lastSeen *time.Time
	if err := owner.QueryRow(ctx,
		`SELECT last_seen_at FROM operators WHERE user_id=$1`, userID,
	).Scan(&lastSeen); err != nil || lastSeen == nil {
		t.Fatalf("last_seen_at = %v, error = %v", lastSeen, err)
	}
	var reconciliationRunID int64
	if err := adminPool.QueryRow(ctx, `
		SELECT run_id FROM request_reconciliation('storage', $1, 'role-trace')`, userID,
	).Scan(&reconciliationRunID); err != nil {
		t.Fatalf("admin reconciliation request failed: %v", err)
	}
	if reconciliationRunID == 0 {
		t.Fatal("admin reconciliation request returned no run")
	}
	if _, err := adminPool.Exec(ctx, `
		UPDATE operator_audit_events SET outcome='forged'
		WHERE actor_user_id=$1`, userID,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("admin audit update error = %v, want insufficient privilege", err)
	}
	if _, err := adminPool.Exec(ctx, `
		INSERT INTO operator_audit_events (
			actor_user_id, actor_role, action, target_type, outcome
		) VALUES ('forged', 'admin', 'forged', 'forged', 'forged')`,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("admin direct audit insert error = %v, want insufficient privilege", err)
	}
	if _, err := adminPool.Exec(ctx,
		`INSERT INTO reconcile_runs (job_type, trigger) VALUES ('storage', 'scheduled')`,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("admin direct queue write error = %v, want insufficient privilege", err)
	}
	snapshot, err := NewRegistryStore(readPool, adminPool).Snapshot(ctx)
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
	registry := NewRegistryStore(readPool, adminPool)
	current := configByRef(t, snapshot, modelRef)
	draft := draftFromConfig("role-version", current)
	draft.ModelName = "Role Model edited"
	request.Drafts = []gridDraft{draft}
	for index := range request.Cells {
		cell := &request.Cells[index]
		if cell.Row == modelRef {
			cell.Target = CellTarget{Kind: "draft", DraftID: draft.ID}
		}
	}
	result, err := registry.saveGrid(ctx, request)
	if err != nil {
		t.Fatalf("least-privilege registry Save failed: %v", err)
	}
	if result.Version != originalVersion+1 ||
		result.InsertedRows != 1 || result.DisabledRows < 1 {
		t.Fatalf("least-privilege version Save result: %+v", result)
	}
	if _, err := adminPool.Exec(ctx, `
		SELECT record_registry_audit($1, $2, $3, $4, $5, $6, 'registry-trace')`,
		userID, originalVersion, result.Version, result.InsertedRows,
		result.DisabledRows, result.RemappedUsers,
	); err != nil {
		t.Fatalf("least-privilege registry audit failed: %v", err)
	}
	snapshot, err = registry.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	request = gridRequest(snapshot)
	filtered := request.Cells[:0]
	for _, cell := range request.Cells {
		if cell.Row != modelRef {
			filtered = append(filtered, cell)
		}
	}
	request.Cells = filtered
	result, err = registry.saveGrid(ctx, request)
	if err != nil {
		t.Fatalf("least-privilege remap Save failed: %v", err)
	}
	if result.RemappedUsers != 1 || result.DisabledRows != 1 {
		t.Fatalf("least-privilege remap result: %+v", result)
	}
	var preference models.Ref
	if err := owner.QueryRow(ctx, `
		SELECT chat_model_provider_slug, chat_model_slug FROM users WHERE id=$1`, userID,
	).Scan(&preference.ProviderSlug, &preference.ModelSlug); err != nil {
		t.Fatal(err)
	}
	if preference != (models.Ref{ProviderSlug: "deepseek", ModelSlug: "deepseek-v4-flash-vision-exp"}) {
		t.Fatalf("least-privilege remap persisted %q", preference)
	}
	if _, err := adminPool.Exec(ctx,
		`DELETE FROM model_configs WHERE provider_slug='deepseek' AND model_slug='deepseek-v4-flash-vision-exp'`,
	); !isInsufficientPrivilege(err) {
		t.Fatalf("registry delete error = %v, want insufficient privilege", err)
	}
	if _, err := adminPool.Exec(ctx, `SELECT content FROM messages LIMIT 1`); !isInsufficientPrivilege(err) {
		t.Fatalf("registry content error = %v, want insufficient privilege", err)
	}
	if _, err := readStore.Overview(ctx); err != nil {
		t.Fatalf("least-privilege overview failed: %v", err)
	}
	if _, err := readStore.Health(ctx, 30); err != nil {
		t.Fatalf("least-privilege health failed: %v", err)
	}
	audit, err := readStore.AuditEvents(ctx, 0, auditPageMax)
	if err != nil {
		t.Fatalf("least-privilege audit read failed: %v", err)
	}
	if len(audit.Events) < 2 {
		t.Fatalf("audit events = %d, want reconciliation and registry entries", len(audit.Events))
	}
	if _, err := owner.Exec(ctx,
		`DELETE FROM email_outbox WHERE user_id=$1`, userID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx,
		`DELETE FROM reconcile_runs WHERE requested_by_id=$1`, userID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx,
		`DELETE FROM model_configs WHERE provider_slug=$1 AND model_slug=$2 AND version >= 99`, modelRef.ProviderSlug, modelRef.ModelSlug,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx,
		`UPDATE model_configs SET enabled=true WHERE provider_slug=$1 AND model_slug=$2 AND version=1`, modelRef.ProviderSlug, modelRef.ModelSlug,
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
