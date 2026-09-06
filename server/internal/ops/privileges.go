package ops

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DatabaseRole string

const (
	ReadDatabaseRole  DatabaseRole = "read_auth"
	AdminDatabaseRole DatabaseRole = "admin_actions"
)

type columnPrivilege struct {
	table     string
	column    string
	privilege string
}

type tablePrivilege struct {
	table     string
	privilege string
}

var readRequiredPrivileges = []columnPrivilege{
	{"plan_limits", "plan_tier", "SELECT"},
	{"plan_limits", "storage_limit_bytes", "SELECT"},
	{"plan_limits", "credit_limit_micros", "SELECT"},
	{"plan_limits", "source_file_max_bytes", "SELECT"},
	{"plan_limits", "material_revision_limit", "SELECT"},
	{"plan_limits", "owned_workspace_limit", "SELECT"},
	{"plan_limits", "files_per_workspace", "SELECT"},
	{"plan_limits", "files_per_upload", "SELECT"},
	{"resource_credit_rates", "resource_key", "SELECT"},
	{"resource_credit_rates", "version", "SELECT"},
	{"resource_credit_rates", "unit", "SELECT"},
	{"resource_credit_rates", "credit_micros_per_unit", "SELECT"},
	{"resource_credit_rates", "active", "SELECT"},
	{"resource_credit_rates", "created_at", "SELECT"},
	{"user_credits", "user_id", "SELECT"},
	{"user_credits", "period_start", "SELECT"},
	{"user_credits", "used_micros", "SELECT"},
	{"user_credits", "reserved_micros", "SELECT"},
	{"provider_sessions", "id", "SELECT"},
	{"provider_sessions", "actor_user_id", "SELECT"},
	{"provider_sessions", "trace_id", "SELECT"},
	{"provider_sessions", "surface", "SELECT"},
	{"provider_sessions", "paid_by", "SELECT"},
	{"provider_sessions", "status", "SELECT"},
	{"provider_sessions", "created_at", "SELECT"},
	{"provider_sessions", "expires_at", "SELECT"},
	{"provider_sessions", "settled_at", "SELECT"},
	{"provider_calls", "id", "SELECT"},
	{"provider_calls", "reservation_id", "SELECT"},
	{"provider_calls", "actor_user_id", "SELECT"},
	{"provider_calls", "job_attempt_id", "SELECT"},
	{"provider_calls", "job_stage", "SELECT"},
	{"provider_calls", "kind", "SELECT"},
	{"provider_calls", "purpose", "SELECT"},
	{"provider_calls", "status", "SELECT"},
	{"provider_calls", "input_tokens", "SELECT"},
	{"provider_calls", "output_tokens", "SELECT"},
	{"provider_calls", "thinking", "SELECT"},
	{"provider_calls", "cached_read_tokens", "SELECT"},
	{"provider_calls", "cache_write_tokens", "SELECT"},
	{"provider_calls", "reasoning_tokens", "SELECT"},
	{"provider_calls", "cache_anomaly", "SELECT"},
	{"provider_calls", "context_system_tokens", "SELECT"},
	{"provider_calls", "context_tool_tokens", "SELECT"},
	{"provider_calls", "context_conversation_tokens", "SELECT"},
	{"provider_calls", "context_total_tokens", "SELECT"},
	{"provider_calls", "context_window_tokens", "SELECT"},
	{"provider_calls", "context_counting_method", "SELECT"},
	{"provider_calls", "context_counting_version", "SELECT"},
	{"provider_calls", "opened_at", "SELECT"},
	{"provider_calls", "applied_at", "SELECT"},
	{"provider_calls", "abandoned_at", "SELECT"},
	{"provider_calls", "error_category", "SELECT"},
	{"provider_calls", "error_code", "SELECT"},
	{"provider_calls", "provider_status", "SELECT"},
	{"provider_calls", "provider", "SELECT"},
	{"provider_calls", "model", "SELECT"},
	{"provider_calls", "credit_micros", "SELECT"},
	{"reconcile_runs", "id", "SELECT"},
	{"reconcile_runs", "job_type", "SELECT"},
	{"reconcile_runs", "trigger", "SELECT"},
	{"reconcile_runs", "status", "SELECT"},
	{"reconcile_runs", "requested_by_id", "SELECT"},
	{"reconcile_runs", "requested_by_name", "SELECT"},
	{"reconcile_runs", "requested_at", "SELECT"},
	{"reconcile_runs", "started_at", "SELECT"},
	{"reconcile_runs", "finished_at", "SELECT"},
	{"reconcile_runs", "scanned_count", "SELECT"},
	{"reconcile_runs", "repaired_count", "SELECT"},
	{"reconcile_runs", "error_count", "SELECT"},
	{"reconcile_runs", "error", "SELECT"},
	{"reconciliation_report", "id", "SELECT"},
	{"reconciliation_report", "run_id", "SELECT"},
	{"reconciliation_report", "event_type", "SELECT"},
	{"reconciliation_report", "subject_type", "SELECT"},
	{"reconciliation_report", "subject_id", "SELECT"},
	{"reconciliation_report", "actor_user_id", "SELECT"},
	{"reconciliation_report", "metadata", "SELECT"},
	{"reconciliation_report", "created_at", "SELECT"},
	{"operator_audit_events", "id", "SELECT"},
	{"operator_audit_events", "occurred_at", "SELECT"},
	{"operator_audit_events", "actor_user_id", "SELECT"},
	{"operator_audit_events", "actor_role", "SELECT"},
	{"operator_audit_events", "action", "SELECT"},
	{"operator_audit_events", "target_type", "SELECT"},
	{"operator_audit_events", "target_id", "SELECT"},
	{"operator_audit_events", "outcome", "SELECT"},
	{"operator_audit_events", "trace_id", "SELECT"},
	{"operator_audit_events", "metadata", "SELECT"},
	{"user_storage", "user_id", "SELECT"},
	{"user_storage", "used_bytes", "SELECT"},
	{"user_storage", "reserved_bytes", "SELECT"},
	{"user_storage_deltas", "user_id", "SELECT"},
	{"user_storage_deltas", "delta_bytes", "SELECT"},
	{"users", "id", "SELECT"},
	{"users", "name", "SELECT"},
	{"users", "email", "SELECT"},
	{"users", "plan_tier", "SELECT"},
	{"users", "subscription_status", "SELECT"},
	{"users", "deletion_requested_at", "SELECT"},
	{"users", "purge_after", "SELECT"},
	{"users", "deleted_at", "SELECT"},
	{"users", "suspended_at", "SELECT"},
	{"users", "suspended_reason", "SELECT"},
	{"users", "session_revoke_pending", "SELECT"},
	{"users", "session_revoke_attempts", "SELECT"},
	{"users", "session_revoke_not_before", "SELECT"},
	{"users", "session_revoke_last_error", "SELECT"},
	{"users", "created_at", "SELECT"},
	{"operators", "user_id", "SELECT"},
	{"operators", "role", "SELECT"},
	{"ops_permissions", "role", "SELECT"},
	{"ops_permissions", "permission", "SELECT"},
	{"user_subscriptions", "user_id", "SELECT"},
	{"user_subscriptions", "status", "SELECT"},
	{"user_subscriptions", "plan_tier", "SELECT"},
	{"user_subscriptions", "current_period_end", "SELECT"},
	{"user_subscriptions", "ended_at", "SELECT"},
	{"user_subscriptions", "canceled_at", "SELECT"},
	{"user_subscriptions", "stripe_event_created", "SELECT"},
	{"user_subscriptions", "updated_at", "SELECT"},
	{"workspaces", "id", "SELECT"},
	{"workspaces", "user_id", "SELECT"},
	{"workspaces", "name", "SELECT"},
	{"workspaces", "embedding_provider_slug", "SELECT"},
	{"workspaces", "embedding_model_slug", "SELECT"},
	{"workspaces", "embedding_model_version", "SELECT"},
	{"workspaces", "embedding_dim", "SELECT"},
	{"workspaces", "last_accessed_at", "SELECT"},
	{"files", "id", "SELECT"},
	{"files", "workspace_id", "SELECT"},
	{"jobs", "type", "SELECT"},
	{"jobs", "status", "SELECT"},
	{"jobs", "not_before", "SELECT"},
	{"jobs", "locked_at", "SELECT"},
	{"jobs", "lease_expires_at", "SELECT"},
	{"jobs", "queued_at", "SELECT"},
	{"jobs", "updated_at", "SELECT"},
	{"email_outbox", "status", "SELECT"},
	{"email_outbox", "updated_at", "SELECT"},
	{"model_registry_state", "id", "SELECT"},
	{"model_registry_state", "version", "SELECT"},
	{"model_registry_state", "updated_at", "SELECT"},
	{"model_configs", "version", "SELECT"},
	{"model_configs", "provider_name", "SELECT"},
	{"model_configs", "model_name", "SELECT"},
	{"model_configs", "provider_slug", "SELECT"},
	{"model_configs", "model_slug", "SELECT"},
	{"model_configs", "platform_enabled", "SELECT"},
	{"model_configs", "byok_enabled", "SELECT"},
	{"model_configs", "thinking_levels", "SELECT"},
	{"model_configs", "default_thinking", "SELECT"},
	{"model_configs", "context_window_tokens", "SELECT"},
	{"model_configs", "params", "SELECT"},
	{"model_configs", "slots", "SELECT"},
	{"model_configs", "capabilities", "SELECT"},
	{"model_configs", "micros_per_input_token", "SELECT"},
	{"model_configs", "micros_per_cached_input_token", "SELECT"},
	{"model_configs", "micros_per_output_token", "SELECT"},
	{"model_configs", "enabled", "SELECT"},
	{"model_configs", "is_default_for", "SELECT"},
	{"model_configs", "created_at", "SELECT"},
	{"model_configs", "updated_at", "SELECT"},
	{"model_configs", "created_by", "SELECT"},
	{"model_configs", "updated_by", "SELECT"},
	{"usage_events", "id", "SELECT"},
	{"usage_events", "trace_id", "SELECT"},
	{"usage_events", "actor_user_id", "SELECT"},
	{"usage_events", "kind", "SELECT"},
	{"usage_events", "surface", "SELECT"},
	{"usage_events", "provider", "SELECT"},
	{"usage_events", "model", "SELECT"},
	{"usage_events", "thinking", "SELECT"},
	{"usage_events", "catalog_provider_slug", "SELECT"},
	{"usage_events", "catalog_model_slug", "SELECT"},
	{"usage_events", "model_version", "SELECT"},
	{"usage_events", "input_tokens", "SELECT"},
	{"usage_events", "output_tokens", "SELECT"},
	{"usage_events", "units", "SELECT"},
	{"usage_events", "unit", "SELECT"},
	{"usage_events", "parse_pages", "SELECT"},
	{"usage_events", "parse_ocr_pages", "SELECT"},
	{"usage_events", "parse_cpu_milliseconds", "SELECT"},
	{"usage_events", "parse_elapsed_milliseconds", "SELECT"},
	{"usage_events", "parse_queue_milliseconds", "SELECT"},
	{"usage_events", "parse_download_milliseconds", "SELECT"},
	{"usage_events", "parse_upload_milliseconds", "SELECT"},
	{"usage_events", "parse_worker_rss_bytes", "SELECT"},
	{"usage_events", "parse_worker_pss_bytes", "SELECT"},
	{"usage_events", "parse_io_read_bytes", "SELECT"},
	{"usage_events", "parse_io_write_bytes", "SELECT"},
	{"usage_events", "credit_micros", "SELECT"},
	{"usage_events", "reservation_id", "SELECT"},
	{"usage_events", "provider_call_id", "SELECT"},
	{"usage_events", "created_at", "SELECT"},
	{"ingest_host_samples", "sampled_at", "SELECT"},
	{"ingest_host_samples", "environment", "SELECT"},
	{"ingest_host_samples", "host_id", "SELECT"},
	{"ingest_host_samples", "release_sha", "SELECT"},
	{"ingest_host_samples", "host_metrics_available", "SELECT"},
	{"ingest_host_samples", "active_jobs", "SELECT"},
	{"ingest_host_samples", "queued_jobs", "SELECT"},
	{"ingest_host_samples", "active_slices", "SELECT"},
	{"ingest_host_samples", "queued_slices", "SELECT"},
	{"ingest_host_samples", "oldest_active_slice_ms", "SELECT"},
	{"ingest_host_samples", "oldest_queued_slice_ms", "SELECT"},
	{"ingest_host_samples", "last_slice_completed_age_ms", "SELECT"},
	{"ingest_host_samples", "parser_oom_kill_events", "SELECT"},
	{"ingest_host_samples", "cpu_percent", "SELECT"},
	{"ingest_host_samples", "load_1", "SELECT"},
	{"ingest_host_samples", "memory_total_bytes", "SELECT"},
	{"ingest_host_samples", "memory_used_bytes", "SELECT"},
	{"ingest_host_samples", "swap_used_bytes", "SELECT"},
	{"ingest_host_samples", "parser_memory_bytes", "SELECT"},
	{"ingest_host_samples", "parser_pss_bytes", "SELECT"},
	{"ingest_host_samples", "parser_memory_peak_bytes", "SELECT"},
	{"ingest_host_samples", "network_rx_bytes", "SELECT"},
	{"ingest_host_samples", "network_tx_bytes", "SELECT"},
	{"ingest_host_samples", "parse_ready_jobs", "SELECT"},
	{"ingest_host_samples", "parse_delayed_jobs", "SELECT"},
	{"ingest_host_samples", "parse_running_jobs", "SELECT"},
	{"ingest_host_samples", "ingest_ready_jobs", "SELECT"},
	{"ingest_host_samples", "ingest_delayed_jobs", "SELECT"},
	{"ingest_host_samples", "ingest_running_jobs", "SELECT"},
	{"ingest_host_samples", "expired_leases", "SELECT"},
	{"ingest_host_samples", "oldest_queued_job_ms", "SELECT"},
	{"ingest_host_samples", "disk_free_bytes", "SELECT"},
	{"ingest_host_samples", "spool_bytes", "SELECT"},
	{"ingest_host_samples", "spool_files", "SELECT"},
	{"ingest_worker_samples", "sampled_at", "SELECT"},
	{"ingest_worker_samples", "environment", "SELECT"},
	{"ingest_worker_samples", "host_id", "SELECT"},
	{"ingest_worker_samples", "worker_instance_id", "SELECT"},
	{"ingest_worker_samples", "role", "SELECT"},
	{"ingest_worker_samples", "release_sha", "SELECT"},
	{"ingest_worker_samples", "state", "SELECT"},
	{"ingest_worker_samples", "stage", "SELECT"},
	{"ingest_worker_samples", "job_attempt_id", "SELECT"},
	{"ingest_worker_samples", "cpu_cores", "SELECT"},
	{"ingest_worker_samples", "memory_bytes", "SELECT"},
	{"ingest_worker_samples", "memory_limit_bytes", "SELECT"},
	{"ingest_worker_samples", "pids_current", "SELECT"},
	{"ingest_worker_samples", "pids_limit", "SELECT"},
	{"ingest_worker_samples", "oom_events", "SELECT"},
	{"ingest_worker_samples", "oom_kill_events", "SELECT"},
	{"ingest_job_attempts", "id", "SELECT"},
	{"ingest_job_attempts", "job_id", "SELECT"},
	{"ingest_job_attempts", "operation_id", "SELECT"},
	{"ingest_job_attempts", "attempt", "SELECT"},
	{"ingest_job_attempts", "job_type", "SELECT"},
	{"ingest_job_attempts", "environment", "SELECT"},
	{"ingest_job_attempts", "status", "SELECT"},
	{"ingest_job_attempts", "stage", "SELECT"},
	{"ingest_job_attempts", "error_category", "SELECT"},
	{"ingest_job_attempts", "error_code", "SELECT"},
	{"ingest_job_attempts", "retryable", "SELECT"},
	{"ingest_job_attempts", "route", "SELECT"},
	{"ingest_job_attempts", "source_format", "SELECT"},
	{"ingest_job_attempts", "claimed_at", "SELECT"},
	{"ingest_job_attempts", "finished_at", "SELECT"},
	{"ingest_job_attempts", "next_retry_at", "SELECT"},
	{"ingest_job_attempts", "queue_milliseconds", "SELECT"},
	{"ingest_job_attempts", "duration_milliseconds", "SELECT"},
	{"ingest_job_attempts", "stage_timings", "SELECT"},
	{"ingest_job_attempts", "parse_pages", "SELECT"},
	{"ingest_job_attempts", "parse_ocr_pages", "SELECT"},
	{"ingest_job_attempts", "parse_slices", "SELECT"},
	{"ingest_job_attempts", "figures_selected", "SELECT"},
	{"ingest_job_attempts", "figures_cached", "SELECT"},
	{"ingest_job_attempts", "figures_captioned", "SELECT"},
	{"ingest_job_attempts", "figures_failed", "SELECT"},
	{"ingest_job_attempts", "chunks_created", "SELECT"},
}

var registryRequiredPrivileges = []columnPrivilege{
	{"model_configs", "version", "SELECT"},
	{"model_configs", "provider_name", "SELECT"},
	{"model_configs", "model_name", "SELECT"},
	{"model_configs", "provider_slug", "SELECT"},
	{"model_configs", "model_slug", "SELECT"},
	{"model_configs", "platform_enabled", "SELECT"},
	{"model_configs", "byok_enabled", "SELECT"},
	{"model_configs", "thinking_levels", "SELECT"},
	{"model_configs", "default_thinking", "SELECT"},
	{"model_configs", "context_window_tokens", "SELECT"},
	{"model_configs", "params", "SELECT"},
	{"model_configs", "slots", "SELECT"},
	{"model_configs", "capabilities", "SELECT"},
	{"model_configs", "micros_per_input_token", "SELECT"},
	{"model_configs", "micros_per_cached_input_token", "SELECT"},
	{"model_configs", "micros_per_output_token", "SELECT"},
	{"model_configs", "enabled", "SELECT"},
	{"model_configs", "is_default_for", "SELECT"},
	{"model_configs", "created_at", "SELECT"},
	{"model_configs", "updated_at", "SELECT"},
	{"model_configs", "created_by", "SELECT"},
	{"model_configs", "updated_by", "SELECT"},
	{"model_registry_state", "id", "SELECT"},
	{"model_registry_state", "version", "SELECT"},
	{"model_registry_state", "updated_at", "SELECT"},
	{"workspaces", "id", "SELECT"},
	{"workspaces", "embedding_provider_slug", "SELECT"},
	{"workspaces", "embedding_model_slug", "SELECT"},
	{"workspaces", "embedding_model_version", "SELECT"},
	{"workspaces", "embedding_dim", "SELECT"},
	{"users", "id", "SELECT"},
	{"users", "email", "SELECT"},
	{"users", "locale", "SELECT"},
	{"users", "chat_model_provider_slug", "SELECT"},
	{"users", "chat_model_slug", "SELECT"},
	{"users", "generate_model_provider_slug", "SELECT"},
	{"users", "generate_model_slug", "SELECT"},
	{"users", "editor_model_provider_slug", "SELECT"},
	{"users", "editor_model_slug", "SELECT"},
	{"users", "quiz_model_provider_slug", "SELECT"},
	{"users", "quiz_model_slug", "SELECT"},
	{"user_llm_credentials", "user_id", "SELECT"},
	{"user_llm_credentials", "provider_slug", "SELECT"},
	{"notification_prefs", "user_id", "SELECT"},
	{"notification_prefs", "email_workspace_invite", "SELECT"},
	{"notification_prefs", "email_membership", "SELECT"},
	{"notification_prefs", "email_billing", "SELECT"},
	{"notifications", "id", "SELECT"},
	{"notifications", "user_id", "SELECT"},
	{"notifications", "kind", "SELECT"},
	{"notifications", "data", "SELECT"},
	{"notifications", "href", "SELECT"},
	{"notifications", "workspace_id", "SELECT"},
	{"notifications", "workspace_invite_id", "SELECT"},
	{"notifications", "at", "SELECT"},
	{"notifications", "read_at", "SELECT"},
	{"email_outbox", "idempotency_key", "SELECT"},
	{"model_configs", "version", "INSERT"},
	{"model_configs", "provider_name", "INSERT"},
	{"model_configs", "model_name", "INSERT"},
	{"model_configs", "provider_slug", "INSERT"},
	{"model_configs", "model_slug", "INSERT"},
	{"model_configs", "platform_enabled", "INSERT"},
	{"model_configs", "byok_enabled", "INSERT"},
	{"model_configs", "thinking_levels", "INSERT"},
	{"model_configs", "default_thinking", "INSERT"},
	{"model_configs", "context_window_tokens", "INSERT"},
	{"model_configs", "params", "INSERT"},
	{"model_configs", "slots", "INSERT"},
	{"model_configs", "capabilities", "INSERT"},
	{"model_configs", "micros_per_input_token", "INSERT"},
	{"model_configs", "micros_per_cached_input_token", "INSERT"},
	{"model_configs", "micros_per_output_token", "INSERT"},
	{"model_configs", "enabled", "INSERT"},
	{"model_configs", "is_default_for", "INSERT"},
	{"model_configs", "created_by", "INSERT"},
	{"model_configs", "updated_by", "INSERT"},
	{"model_configs", "enabled", "UPDATE"},
	{"model_configs", "is_default_for", "UPDATE"},
	{"model_configs", "updated_at", "UPDATE"},
	{"model_configs", "updated_by", "UPDATE"},
	{"model_registry_state", "version", "UPDATE"},
	{"model_registry_state", "updated_at", "UPDATE"},
	{"users", "chat_model_provider_slug", "UPDATE"},
	{"users", "chat_model_slug", "UPDATE"},
	{"users", "generate_model_provider_slug", "UPDATE"},
	{"users", "generate_model_slug", "UPDATE"},
	{"users", "editor_model_provider_slug", "UPDATE"},
	{"users", "editor_model_slug", "UPDATE"},
	{"users", "quiz_model_provider_slug", "UPDATE"},
	{"users", "quiz_model_slug", "UPDATE"},
	{"users", "updated_at", "UPDATE"},
	{"notifications", "id", "INSERT"},
	{"notifications", "user_id", "INSERT"},
	{"notifications", "kind", "INSERT"},
	{"notifications", "data", "INSERT"},
	{"notifications", "href", "INSERT"},
	{"notifications", "workspace_id", "INSERT"},
	{"notifications", "workspace_invite_id", "INSERT"},
	{"notifications", "at", "INSERT"},
	{"email_outbox", "id", "INSERT"},
	{"email_outbox", "user_id", "INSERT"},
	{"email_outbox", "to_email", "INSERT"},
	{"email_outbox", "template", "INSERT"},
	{"email_outbox", "locale", "INSERT"},
	{"email_outbox", "payload", "INSERT"},
	{"email_outbox", "idempotency_key", "INSERT"},
}

var customerContentColumns = []columnPrivilege{
	{"messages", "content", "SELECT"},
	{"messages", "metadata", "SELECT"},
	{"materials", "content", "SELECT"},
	{"material_yjs_documents", "state", "SELECT"},
	{"conversation_compactions", "summary", "SELECT"},
	{"rag_chunks", "text", "SELECT"},
	{"rag_chunks", "indexed_text", "SELECT"},
	{"rag_chunks", "regions", "SELECT"},
	{"rag_content_summaries", "descriptor", "SELECT"},
	{"rag_content_summaries", "summary", "SELECT"},
	{"files", "name", "SELECT"},
	{"files", "blob_path", "SELECT"},
	{"files", "url", "SELECT"},
	{"jobs", "payload", "SELECT"},
	{"webhook_events", "payload", "SELECT"},
	{"user_llm_credentials", "key_ciphertext", "SELECT"},
	{"user_llm_credentials", "key_nonce", "SELECT"},
	{"email_outbox", "to_email", "SELECT"},
	{"email_outbox", "payload", "SELECT"},
	{"usage_events", "metadata", "SELECT"},
	{"usage_events", "workspace_id", "SELECT"},
}

func ProbeDatabaseRole(
	ctx context.Context,
	dsn string,
	role DatabaseRole,
) error {
	if strings.TrimSpace(dsn) == "" {
		return fmt.Errorf("%s database URL is required", role)
	}
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return fmt.Errorf("%s database URL: %w", role, err)
	}
	config.MaxConns = 1
	config.MinConns = 0
	config.MaxConnLifetime = 30 * time.Minute
	config.ConnConfig.RuntimeParams["statement_timeout"] = "15000"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return fmt.Errorf("open %s database: %w", role, err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		return fmt.Errorf("%s database ping: %w", role, err)
	}
	return ValidateDatabaseRole(ctx, pool, role)
}

func ValidateDatabaseRole(
	ctx context.Context,
	pool *pgxpool.Pool,
	role DatabaseRole,
) error {
	var user string
	var elevated, memberOfOtherRole, schemaCreate bool
	if err := pool.QueryRow(ctx, `
		SELECT current_user,
			r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR
				r.rolreplication OR r.rolbypassrls,
			EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid),
			has_schema_privilege(current_user, 'public', 'CREATE')
		FROM pg_roles r WHERE r.rolname = current_user
	`).Scan(&user, &elevated, &memberOfOtherRole, &schemaCreate); err != nil {
		return fmt.Errorf("inspect %s database role: %w", role, err)
	}
	var problems []string
	if elevated {
		problems = append(problems, "has elevated cluster privileges")
	}
	if memberOfOtherRole {
		problems = append(problems, "is a member of another database role")
	}
	if schemaCreate {
		problems = append(problems, "can create objects in schema public")
	}

	switch role {
	case ReadDatabaseRole:
		problems = append(problems, validateRequiredColumns(ctx, pool, readRequiredPrivileges)...)
		problems = append(problems, validateRequiredTables(ctx, pool, []tablePrivilege{
			{"ops_assistant_turns", "SELECT"},
		})...)
		problems = append(problems, validateNoBroadWrites(ctx, pool)...)
		problems = append(problems, validateForbiddenColumns(ctx, pool, customerContentColumns)...)
		problems = append(problems, validateOnlyFunctionExecutes(
			ctx, pool, "touch_operator_seen(text)",
		)...)
		var execute bool
		if err := pool.QueryRow(ctx,
			`SELECT has_function_privilege(current_user, 'touch_operator_seen(text)', 'EXECUTE')`,
		).Scan(&execute); err != nil {
			return fmt.Errorf("inspect read/auth function privilege: %w", err)
		}
		if !execute {
			problems = append(problems, "cannot execute touch_operator_seen(text)")
		}
	case AdminDatabaseRole:
		problems = append(problems, validateRequiredColumns(ctx, pool, registryRequiredPrivileges)...)
		problems = append(problems, validateForbiddenColumns(ctx, pool, customerContentColumns)...)
		problems = append(problems, validateRegistryTableWrites(ctx, pool)...)
		problems = append(problems, validateOnlyFunctionExecutes(
			ctx, pool,
			"model_configs_thinking_ok(text[],text[],text)",
			"request_reconciliation(text,text,text)",
			"record_registry_audit(text,bigint,bigint,bigint,bigint,bigint,text)",
			"save_resource_credit_rate(text,text,bigint,text)",
		)...)
		var canExecuteThinking, canRequestReconciliation, canRecordRegistryAudit, canSaveResourceRate bool
		if err := pool.QueryRow(ctx,
			`SELECT
				has_function_privilege(
					current_user,
					'model_configs_thinking_ok(text[],text[],text)',
					'EXECUTE'
				),
				has_function_privilege(
					current_user,
					'request_reconciliation(text,text,text)',
					'EXECUTE'
				),
				has_function_privilege(
					current_user,
					'record_registry_audit(text,bigint,bigint,bigint,bigint,bigint,text)',
					'EXECUTE'
				),
				has_function_privilege(
					current_user,
					'save_resource_credit_rate(text,text,bigint,text)',
					'EXECUTE'
				)`,
		).Scan(
			&canExecuteThinking,
			&canRequestReconciliation,
			&canRecordRegistryAudit,
			&canSaveResourceRate,
		); err != nil {
			return fmt.Errorf("inspect admin function privileges: %w", err)
		}
		if !canExecuteThinking {
			problems = append(
				problems,
				"cannot execute model_configs_thinking_ok(text[],text[],text)",
			)
		}
		if !canRequestReconciliation {
			problems = append(
				problems,
				"cannot execute request_reconciliation(text,text,text)",
			)
		}
		if !canRecordRegistryAudit {
			problems = append(
				problems,
				"cannot execute record_registry_audit(text,bigint,bigint,bigint,bigint,bigint,text)",
			)
		}
		if !canSaveResourceRate {
			problems = append(
				problems,
				"cannot execute save_resource_credit_rate(text,text,bigint,text)",
			)
		}
		var canDelete bool
		if err := pool.QueryRow(ctx,
			`SELECT has_table_privilege(current_user, 'model_configs', 'DELETE')`,
		).Scan(&canDelete); err != nil {
			return fmt.Errorf("inspect registry delete privilege: %w", err)
		}
		if canDelete {
			problems = append(problems, "can delete model_configs")
		}
	default:
		return fmt.Errorf("unknown database role contract %q", role)
	}
	if len(problems) > 0 {
		return fmt.Errorf("database user %s violates %s role contract: %s",
			user, role, strings.Join(problems, "; "))
	}
	return nil
}

func validateRequiredTables(
	ctx context.Context,
	pool *pgxpool.Pool,
	requirements []tablePrivilege,
) []string {
	var problems []string
	for _, requirement := range requirements {
		var allowed bool
		if err := pool.QueryRow(ctx,
			`SELECT has_table_privilege(current_user, $1, $2)`,
			requirement.table, requirement.privilege,
		).Scan(&allowed); err != nil || !allowed {
			problems = append(problems, fmt.Sprintf(
				"missing %s on %s", requirement.privilege, requirement.table,
			))
		}
	}
	return problems
}

func validateRequiredColumns(
	ctx context.Context,
	pool *pgxpool.Pool,
	requirements []columnPrivilege,
) []string {
	var problems []string
	for _, requirement := range requirements {
		var allowed bool
		if err := pool.QueryRow(ctx,
			`SELECT has_column_privilege(current_user, $1, $2, $3)`,
			requirement.table, requirement.column, requirement.privilege,
		).Scan(&allowed); err != nil {
			problems = append(problems, fmt.Sprintf(
				"cannot inspect %s.%s %s", requirement.table,
				requirement.column, requirement.privilege,
			))
			continue
		}
		if !allowed {
			problems = append(problems, fmt.Sprintf(
				"missing %s on %s.%s", requirement.privilege,
				requirement.table, requirement.column,
			))
		}
	}
	return problems
}

func validateForbiddenColumns(
	ctx context.Context,
	pool *pgxpool.Pool,
	forbidden []columnPrivilege,
) []string {
	var problems []string
	for _, privilege := range forbidden {
		var allowed bool
		if err := pool.QueryRow(ctx,
			`SELECT has_column_privilege(current_user, $1, $2, $3)`,
			privilege.table, privilege.column, privilege.privilege,
		).Scan(&allowed); err != nil {
			problems = append(problems, fmt.Sprintf(
				"cannot inspect forbidden %s.%s", privilege.table, privilege.column,
			))
			continue
		}
		if allowed {
			problems = append(problems, fmt.Sprintf(
				"can %s %s.%s", privilege.privilege,
				privilege.table, privilege.column,
			))
		}
	}
	return problems
}

func validateNoBroadWrites(ctx context.Context, pool *pgxpool.Pool) []string {
	var table string
	err := pool.QueryRow(ctx, `
		SELECT format('%I.%I', n.nspname, c.relname)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
		  AND (
			has_table_privilege(current_user, c.oid, 'INSERT') OR
			has_table_privilege(current_user, c.oid, 'UPDATE') OR
			has_table_privilege(current_user, c.oid, 'DELETE') OR
			has_table_privilege(current_user, c.oid, 'TRUNCATE') OR
			has_table_privilege(current_user, c.oid, 'TRIGGER') OR
			has_any_column_privilege(
			  current_user, c.oid, 'INSERT,UPDATE,REFERENCES'
			)
		  )
		ORDER BY c.relname LIMIT 1
	`).Scan(&table)
	if err == nil {
		return []string{"has write-capable privilege on " + table}
	}
	if err != pgx.ErrNoRows {
		return []string{"could not inspect write-capable privileges"}
	}
	return nil
}

func validateNoTablePrivileges(ctx context.Context, pool *pgxpool.Pool) []string {
	var table string
	err := pool.QueryRow(ctx, `
		SELECT format('%I.%I', n.nspname, c.relname)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
		  AND (
			has_table_privilege(current_user, c.oid, 'SELECT') OR
			has_table_privilege(current_user, c.oid, 'INSERT') OR
			has_table_privilege(current_user, c.oid, 'UPDATE') OR
			has_table_privilege(current_user, c.oid, 'DELETE') OR
			has_table_privilege(current_user, c.oid, 'TRUNCATE') OR
			has_table_privilege(current_user, c.oid, 'REFERENCES') OR
			has_table_privilege(current_user, c.oid, 'TRIGGER') OR
			has_any_column_privilege(
			  current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'
			)
		  )
		ORDER BY c.relname LIMIT 1
	`).Scan(&table)
	if err == nil {
		return []string{"has table privilege on " + table}
	}
	if err != pgx.ErrNoRows {
		return []string{"could not inspect table privileges"}
	}
	return nil
}

func validateOnlyFunctionExecutes(
	ctx context.Context,
	pool *pgxpool.Pool,
	allowed ...string,
) []string {
	var routine string
	err := pool.QueryRow(ctx, `
		SELECT format(
		  '%I.%I(%s)',
		  n.nspname,
		  p.proname,
		  pg_get_function_identity_arguments(p.oid)
		)
		FROM pg_proc p
		JOIN pg_namespace n ON n.oid=p.pronamespace
		WHERE n.nspname='public'
		  AND p.oid NOT IN (
		    SELECT name::regprocedure::oid FROM unnest($1::text[]) name
		  )
		  AND has_function_privilege(current_user, p.oid, 'EXECUTE')
		ORDER BY p.proname
		LIMIT 1`, allowed).Scan(&routine)
	if err == nil {
		return []string{"can execute unexpected function " + routine}
	}
	if err != pgx.ErrNoRows {
		return []string{"could not inspect function privileges"}
	}
	return nil
}

func validateRegistryTableWrites(
	ctx context.Context,
	pool *pgxpool.Pool,
) []string {
	var problems []string
	var table, privilege string
	err := pool.QueryRow(ctx, `
		SELECT format('%I.%I', n.nspname, c.relname), privilege
		FROM pg_class c
		JOIN pg_namespace n ON n.oid=c.relnamespace
		CROSS JOIN unnest(ARRAY[
		  'INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
		]) privilege
		WHERE n.nspname='public' AND c.relkind IN ('r','p','v')
		  AND has_table_privilege(current_user, c.oid, privilege)
		ORDER BY c.relname, privilege
		LIMIT 1`).Scan(&table, &privilege)
	if err == nil {
		problems = append(problems, fmt.Sprintf(
			"has table-level %s on %s", privilege, table,
		))
	} else if err != pgx.ErrNoRows {
		problems = append(problems, "cannot inspect admin table writes")
	}

	allowed := make(map[string]struct{})
	for _, grant := range registryRequiredPrivileges {
		if grant.privilege != "SELECT" {
			allowed[grant.table+"\x00"+grant.column+"\x00"+grant.privilege] = struct{}{}
		}
	}
	rows, err := pool.Query(ctx, `
		SELECT c.relname, a.attname, privilege
		FROM pg_class c
		JOIN pg_namespace n ON n.oid=c.relnamespace
		JOIN pg_attribute a ON a.attrelid=c.oid
		CROSS JOIN unnest(ARRAY['INSERT','UPDATE','REFERENCES']) privilege
		WHERE n.nspname='public' AND c.relkind IN ('r','p','v')
		  AND a.attnum > 0 AND NOT a.attisdropped
		  AND has_column_privilege(
		    current_user, c.oid, a.attname, privilege
		  )
		ORDER BY c.relname, a.attnum, privilege`)
	if err != nil {
		return append(problems, "cannot inspect admin column writes")
	}
	defer rows.Close()
	for rows.Next() {
		var column string
		if err := rows.Scan(&table, &column, &privilege); err != nil {
			return append(problems, "cannot inspect admin column writes")
		}
		if _, ok := allowed[table+"\x00"+column+"\x00"+privilege]; !ok {
			problems = append(problems, fmt.Sprintf(
				"can %s %s.%s", privilege, table, column,
			))
			break
		}
	}
	if err := rows.Err(); err != nil {
		problems = append(problems, "cannot inspect admin column writes")
	}
	return problems
}
