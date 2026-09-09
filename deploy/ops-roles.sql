-- Ops database roles and grants for one environment.
--
-- Run as the database owner AFTER migrations have applied, once per
-- environment. Re-running is safe and resets both passwords:
--
--   psql -U capy -d capy -f deploy/ops-roles.sql \
--     -v ops_password="$READ_PASSWORD" -v ops_admin_password="$ADMIN_PASSWORD"
--
-- The passwords must match OPS_DATABASE_URL and OPS_ADMIN_DATABASE_URL, which
-- the ops service uses. The grants name every readable column: neither role can
-- read messages, file content or blob paths, job payloads, email recipients or
-- payloads, or usage_events.metadata. Ops validates its own role at startup and
-- refuses to boot when this file has not been applied, grants too much, or
-- misses a column.
--
-- Column grants do not extend to columns added later. Re-run this file after a
-- migration that adds a table or column ops reads. Setup context and the
-- reasoning behind individual grants live in
-- openwiki/deployment-runbook.md section 8.

\set ON_ERROR_STOP on

-- Fail loudly rather than setting an empty password from an unset variable.
\if :{?ops_password}
\else
\warn 'ops_password is required: -v ops_password=...'
\quit
\endif
\if :{?ops_admin_password}
\else
\warn 'ops_admin_password is required: -v ops_admin_password=...'
\quit
\endif

BEGIN;

-- psql does not substitute variables inside dollar quotes, so the DO block only
-- creates the roles and the ALTER statements below carry the passwords.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops') THEN
    CREATE ROLE capy_ops LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops_admin') THEN
    CREATE ROLE capy_ops_admin LOGIN NOINHERIT;
  END IF;
END
$roles$;
ALTER ROLE capy_ops WITH LOGIN NOINHERIT PASSWORD :'ops_password';
ALTER ROLE capy_ops_admin WITH LOGIN NOINHERIT PASSWORD :'ops_admin_password';

GRANT CONNECT ON DATABASE capy
  TO capy_ops, capy_ops_admin;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public
  TO capy_ops, capy_ops_admin;

GRANT SELECT (
  user_id, period_start, used_micros, reserved_micros
) ON user_credits TO capy_ops;
GRANT SELECT (
  plan_tier, storage_limit_bytes, credit_limit_micros,
  source_file_max_bytes, owned_workspace_limit,
  files_per_workspace, files_per_upload
) ON plan_limits TO capy_ops;
GRANT SELECT (
  id, actor_user_id, trace_id, surface, paid_by, status,
  created_at, expires_at, settled_at
) ON provider_sessions TO capy_ops;
GRANT SELECT (
  id, reservation_id, actor_user_id, job_attempt_id, job_stage,
  kind, purpose, status, thinking, input_tokens, output_tokens,
  cached_read_tokens, cache_write_tokens, reasoning_tokens, cache_anomaly,
  context_system_tokens, context_tool_tokens,
  context_conversation_tokens, context_total_tokens,
  context_window_tokens, context_counting_method,
  context_counting_version, opened_at, applied_at, abandoned_at,
  error_category, error_code, provider_status, provider, model, credit_micros
) ON provider_calls TO capy_ops;
GRANT SELECT (
  id, job_type, trigger, status, requested_by_id, requested_by_name,
  requested_at, started_at, finished_at, scanned_count, repaired_count,
  error_count, error
) ON reconcile_runs TO capy_ops;
GRANT SELECT (
  id, run_id, event_type, subject_type, subject_id, actor_user_id,
  metadata, created_at
) ON reconciliation_report TO capy_ops;
GRANT SELECT (
  id, occurred_at, actor_user_id, actor_role, action,
  target_type, target_id, outcome, trace_id, metadata
) ON operator_audit_events TO capy_ops;
-- Retrieval telemetry: features and ids only, no text columns exist.
GRANT SELECT ON rag_search_events TO capy_ops;
GRANT SELECT (
  user_id, used_bytes, reserved_bytes
) ON user_storage TO capy_ops;
GRANT SELECT (
  user_id, delta_bytes
) ON user_storage_deltas TO capy_ops;
GRANT SELECT (
  id, name, email, plan_tier, subscription_status,
  deletion_requested_at, purge_after,
  deleted_at, suspended_at, suspended_reason,
  session_revoke_pending, session_revoke_attempts,
  session_revoke_not_before, session_revoke_last_error, created_at
) ON users TO capy_ops;
-- AccountAccess computes the active user's lifecycle state on this pool.
GRANT SELECT (
  user_id, status, plan_tier, current_period_end, ended_at,
  canceled_at, stripe_event_created, updated_at
)
  ON user_subscriptions TO capy_ops;
GRANT SELECT (
  id, user_id, name, embedding_provider_slug, embedding_model_slug,
  embedding_model_version,
  embedding_dim, last_accessed_at
) ON workspaces TO capy_ops;
GRANT SELECT (user_id, role) ON operators TO capy_ops;
GRANT SELECT (role, permission) ON ops_permissions TO capy_ops;
GRANT SELECT (
  version, provider_name, model_name, provider_slug, model_slug,
  platform_enabled, byok_enabled, thinking_levels, default_thinking,
  context_window_tokens, params, slots, capabilities, micros_per_input_token,
  micros_per_cached_input_token, micros_per_output_token, enabled,
  is_default_for, created_at, updated_at, created_by, updated_by
) ON model_configs TO capy_ops;
GRANT SELECT (provider, model, concurrency_total, interactive_reserve)
  ON model_capacities TO capy_ops;
GRANT SELECT (
  resource_key, version, unit, credit_micros_per_unit, active, created_at
) ON resource_credit_rates TO capy_ops;
GRANT SELECT (id, version, updated_at) ON model_registry_state TO capy_ops;
GRANT SELECT ON ops_assistant_turns TO capy_ops;
GRANT SELECT (id, workspace_id, trashed_at)
  ON files TO capy_ops;
GRANT SELECT (
  type, status, not_before, locked_at, lease_expires_at, queued_at, updated_at
) ON jobs TO capy_ops;
GRANT SELECT (
  status, updated_at
) ON email_outbox TO capy_ops;
GRANT SELECT (
  id, trace_id, actor_user_id, kind, surface, provider, model,
  thinking, catalog_provider_slug, catalog_model_slug, model_version,
  input_tokens, output_tokens, units, unit,
  parse_pages, parse_ocr_pages, parse_cpu_milliseconds,
  parse_elapsed_milliseconds, parse_queue_milliseconds,
  parse_download_milliseconds, parse_upload_milliseconds,
  parse_worker_rss_bytes, parse_worker_pss_bytes,
  parse_io_read_bytes, parse_io_write_bytes,
  credit_micros, reservation_id, provider_call_id, created_at
) ON usage_events TO capy_ops;
GRANT SELECT (
  sampled_at, environment, host_id, release_sha, host_metrics_available,
  active_jobs, queued_jobs,
  active_slices, queued_slices, oldest_active_slice_ms,
  oldest_queued_slice_ms, last_slice_completed_age_ms,
  parser_oom_kill_events, cpu_percent, load_1,
  memory_total_bytes, memory_used_bytes, swap_used_bytes,
  parser_memory_bytes, parser_pss_bytes, parser_memory_peak_bytes,
  network_rx_bytes, network_tx_bytes, parse_ready_jobs,
  parse_delayed_jobs, parse_running_jobs, ingest_ready_jobs,
  ingest_delayed_jobs, ingest_running_jobs, expired_leases,
  oldest_queued_job_ms, disk_free_bytes, spool_bytes, spool_files
) ON ingest_host_samples TO capy_ops;
GRANT SELECT (
  sampled_at, environment, host_id, worker_instance_id, role, release_sha,
  state, stage, job_attempt_id, cpu_cores, memory_bytes, memory_limit_bytes,
  pids_current, pids_limit, oom_events, oom_kill_events
) ON ingest_worker_samples TO capy_ops;
GRANT SELECT (
  id, job_id, operation_id, attempt, job_type, environment, status, stage,
  error_category, error_code, retryable, route, source_format, claimed_at,
  finished_at, next_retry_at, queue_milliseconds, duration_milliseconds,
  stage_timings,
  parse_pages, parse_ocr_pages, parse_slices, figures_selected, figures_cached,
  figures_captioned, figures_failed, chunks_created
) ON ingest_job_attempts TO capy_ops;

GRANT EXECUTE ON FUNCTION touch_operator_seen(text) TO capy_ops;
GRANT EXECUTE ON FUNCTION request_reconciliation(text, text, text)
  TO capy_ops_admin;
GRANT EXECUTE ON FUNCTION record_registry_audit(
  text, bigint, bigint, bigint, bigint, bigint, text
)
  TO capy_ops_admin;
GRANT EXECUTE ON FUNCTION save_resource_credit_rate(
  text, text, bigint, text
) TO capy_ops_admin;

GRANT SELECT (
  version, provider_name, model_name, provider_slug, model_slug,
  platform_enabled, byok_enabled, thinking_levels, default_thinking,
  context_window_tokens, params, slots, capabilities, micros_per_input_token,
  micros_per_cached_input_token, micros_per_output_token, enabled,
  is_default_for, created_at, updated_at, created_by, updated_by
) ON model_configs TO capy_ops_admin;
GRANT SELECT (provider, model, concurrency_total, interactive_reserve)
  ON model_capacities TO capy_ops_admin;
GRANT SELECT (id, version, updated_at)
  ON model_registry_state TO capy_ops_admin;
GRANT SELECT (
  id, embedding_provider_slug, embedding_model_slug,
  embedding_model_version, embedding_dim
) ON workspaces TO capy_ops_admin;
GRANT SELECT (
  id, email, locale,
  chat_model_provider_slug, chat_model_slug,
  generate_model_provider_slug, generate_model_slug,
  editor_model_provider_slug, editor_model_slug,
  quiz_model_provider_slug, quiz_model_slug
) ON users TO capy_ops_admin;
GRANT SELECT (
  user_id, email_workspace_invite, email_membership, email_billing
) ON notification_prefs TO capy_ops_admin;
GRANT SELECT (
  id, user_id, kind, data, href, workspace_id, workspace_invite_id,
  at, read_at
) ON notifications TO capy_ops_admin;
GRANT SELECT (idempotency_key) ON email_outbox TO capy_ops_admin;
GRANT SELECT (user_id, provider_slug)
  ON user_llm_credentials TO capy_ops_admin;

GRANT INSERT (
  version, provider_name, model_name, provider_slug, model_slug,
  platform_enabled, byok_enabled, thinking_levels, default_thinking,
  context_window_tokens, params, slots, capabilities, micros_per_input_token,
  micros_per_cached_input_token, micros_per_output_token, enabled,
  is_default_for, created_by, updated_by
) ON model_configs TO capy_ops_admin;
GRANT INSERT (provider, model, concurrency_total, interactive_reserve)
  ON model_capacities TO capy_ops_admin;
GRANT UPDATE (concurrency_total, interactive_reserve)
  ON model_capacities TO capy_ops_admin;
GRANT UPDATE (enabled, is_default_for, updated_at, updated_by)
  ON model_configs TO capy_ops_admin;
GRANT EXECUTE ON FUNCTION model_configs_thinking_ok(text[], text[], text)
  TO capy_ops_admin;
GRANT UPDATE (version, updated_at)
  ON model_registry_state TO capy_ops_admin;
GRANT UPDATE (
  chat_model_provider_slug, chat_model_slug,
  generate_model_provider_slug, generate_model_slug,
  editor_model_provider_slug, editor_model_slug,
  quiz_model_provider_slug, quiz_model_slug,
  updated_at
) ON users TO capy_ops_admin;
GRANT INSERT (
  id, user_id, kind, data, href, workspace_id, workspace_invite_id, at
) ON notifications TO capy_ops_admin;
GRANT INSERT (
  id, user_id, to_email, template, locale, payload, idempotency_key
) ON email_outbox TO capy_ops_admin;

COMMIT;
