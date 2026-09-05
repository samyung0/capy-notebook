package ops

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/evonotes/server/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	topUsersLimit      = 20
	recentUsageLimit   = 50
	userSearchLimit    = 20
	userSearchMaxLen   = 128
	userWorkspaceLimit = 100
	maxCostRows        = 500
	auditPageMax       = 100
)

type ReadStore struct {
	app              *store.Store
	db               *pgxpool.Pool
	ingestSources    []IngestReadSource
	overviewMu       sync.Mutex
	overviewCachedAt time.Time
	overviewCache    Overview
}

type IngestReadSource struct {
	Environment string
	DB          *pgxpool.Pool
}

func (s *ReadStore) ResourceCreditRates(ctx context.Context) ([]ResourceCreditRate, error) {
	out := []ResourceCreditRate{}
	rows, err := s.db.Query(ctx, `
		SELECT resource_key, version, unit, credit_micros_per_unit, active, created_at
		FROM resource_credit_rates WHERE active ORDER BY resource_key`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var rate ResourceCreditRate
		if err := rows.Scan(&rate.ResourceKey, &rate.Version, &rate.Unit,
			&rate.CreditMicrosPerUnit, &rate.Active, &rate.CreatedAt); err != nil {
			return out, err
		}
		out = append(out, rate)
	}
	return out, rows.Err()
}

func (s *ReadStore) AuditEvents(
	ctx context.Context,
	beforeID int64,
	limit int,
) (OperatorAuditPage, error) {
	if beforeID < 0 {
		return OperatorAuditPage{}, validation("beforeId must be positive")
	}
	if limit < 1 || limit > auditPageMax {
		return OperatorAuditPage{}, validation(
			"audit limit must be between 1 and %d", auditPageMax,
		)
	}
	out := OperatorAuditPage{Events: []OperatorAuditEvent{}}
	rows, err := s.db.Query(ctx, `
		SELECT id, occurred_at, actor_user_id, actor_role, action,
		       target_type, target_id, outcome, trace_id, metadata
		  FROM operator_audit_events
		 WHERE $1::bigint = 0 OR id < $1
		 ORDER BY id DESC
		 LIMIT $2`, beforeID, limit+1)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item OperatorAuditEvent
		if err := rows.Scan(
			&item.ID, &item.OccurredAt, &item.ActorUserID, &item.ActorRole,
			&item.Action, &item.TargetType, &item.TargetID, &item.Outcome,
			&item.TraceID, &item.Metadata,
		); err != nil {
			return out, err
		}
		out.Events = append(out.Events, item)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	if len(out.Events) > limit {
		out.Events = out.Events[:limit]
		next := out.Events[len(out.Events)-1].ID
		out.NextBeforeID = &next
	}
	return out, nil
}

func NewReadStore(app *store.Store) *ReadStore {
	return &ReadStore{
		app: app,
		db:  app.Pool(),
		ingestSources: []IngestReadSource{{
			Environment: "production",
			DB:          app.Pool(),
		}},
	}
}

func (s *ReadStore) SetIngestSources(sources []IngestReadSource) {
	s.ingestSources = append([]IngestReadSource(nil), sources...)
}

func (s *ReadStore) Operator(ctx context.Context, userID string) (Session, error) {
	var out Session
	err := s.db.QueryRow(ctx,
		`SELECT o.user_id, COALESCE(u.email, ''), u.name, o.role,
		        COALESCE(
		          (SELECT array_agg(p.permission ORDER BY p.permission)
		             FROM ops_permissions p
		            WHERE p.role = o.role),
		          '{}')
		 FROM operators o JOIN users u ON u.id = o.user_id
		 WHERE o.user_id = $1
		   AND u.deleted_at IS NULL
		   AND u.suspended_at IS NULL
		   AND u.deletion_requested_at IS NULL`, userID).
		Scan(&out.UserID, &out.Email, &out.Name, &out.Role, &out.Permissions)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, store.ErrForbidden
	}
	return out, err
}

func (s *ReadStore) Overview(ctx context.Context) (Overview, error) {
	s.overviewMu.Lock()
	defer s.overviewMu.Unlock()
	if time.Since(s.overviewCachedAt) < 30*time.Second {
		return s.overviewCache, nil
	}
	out, err := s.overview(ctx)
	if err == nil {
		s.overviewCache = out
		s.overviewCachedAt = time.Now()
	}
	return out, err
}

func (s *ReadStore) overview(ctx context.Context) (Overview, error) {
	out := Overview{
		ByKind:     []UsagePoint{},
		BySurface:  []UsagePoint{},
		TopUsers:   []RankedUser{},
		TopStorage: []StorageUser{},
		DataAsOf:   time.Now().UTC(),
	}
	err := s.db.QueryRow(ctx, `
		SELECT
			COALESCE(sum(credit_micros) FILTER (
				WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
			), 0),
			COALESCE(sum(credit_micros) FILTER (
				WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
			), 0)
		FROM usage_events
		WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
	`).Scan(&out.TodayCredits, &out.MonthCredits)
	if err != nil {
		return out, err
	}
	err = s.db.QueryRow(ctx, `
		SELECT COALESCE(sum(
			st.used_bytes + COALESCE((
				SELECT sum(d.delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = st.user_id
			), 0)
		), 0)
		FROM user_storage st`).
		Scan(&out.StorageTotal)
	if err != nil {
		return out, err
	}
	if out.ByKind, err = s.usageSeries(ctx, "kind"); err != nil {
		return out, err
	}
	if out.BySurface, err = s.usageSeries(ctx, "surface"); err != nil {
		return out, err
	}
	rows, err := s.db.Query(ctx, `
		SELECT d.actor_user_id, COALESCE(u.email, ''), u.name, u.plan_tier,
			sum(d.credit_micros)::bigint
		FROM usage_events d JOIN users u ON u.id = d.actor_user_id
		WHERE d.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
		GROUP BY d.actor_user_id, u.email, u.name, u.plan_tier
		ORDER BY sum(d.credit_micros) DESC LIMIT $1`, topUsersLimit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item RankedUser
		if err := rows.Scan(&item.UserID, &item.Email, &item.Name,
			&item.PlanTier, &item.CreditMicros); err != nil {
			rows.Close()
			return out, err
		}
		out.TopUsers = append(out.TopUsers, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT u.id, COALESCE(u.email, ''), u.name,
			COALESCE(st.used_bytes, 0) + COALESCE((
				SELECT sum(d.delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = u.id
			), 0)
		FROM users u LEFT JOIN user_storage st ON st.user_id = u.id
		ORDER BY 4 DESC, u.id LIMIT $1`, topUsersLimit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item StorageUser
		if err := rows.Scan(&item.UserID, &item.Email, &item.Name,
			&item.UsedBytes); err != nil {
			rows.Close()
			return out, err
		}
		out.TopStorage = append(out.TopStorage, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	err = s.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM users
			 WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
			(SELECT count(*) FROM workspaces
			 WHERE last_accessed_at >= now() - interval '7 days'),
			(SELECT count(*) FROM jobs WHERE status = 'pending'),
			(SELECT count(*) FROM jobs WHERE status = 'running'),
			(SELECT count(*) FROM jobs
			 WHERE status = 'failed' AND updated_at >= now() - interval '24 hours')
	`).Scan(&out.SignupsToday, &out.ActiveWorkspaces7d,
		&out.Jobs.Queued, &out.Jobs.Running, &out.Jobs.Failed24h)
	return out, err
}

func (s *ReadStore) IngestHostMetrics(ctx context.Context, hours int) (IngestHostMetrics, error) {
	out := IngestHostMetrics{
		Hours:        hours,
		Environments: []IngestEnvironmentMetrics{},
		DataAsOf:     time.Now().UTC(),
	}
	if hours < 1 || hours > 24*7 {
		return out, validation("ingest host metrics range must be between 1 and 168 hours")
	}
	for _, source := range s.ingestSources {
		environment, err := ingestEnvironmentMetrics(
			ctx, source.DB, strings.TrimSpace(source.Environment), hours,
		)
		if err != nil {
			return out, fmt.Errorf("ingest telemetry %s: %w", source.Environment, err)
		}
		out.Environments = append(out.Environments, environment)
	}
	return out, nil
}

func ingestEnvironmentMetrics(
	ctx context.Context,
	db *pgxpool.Pool,
	environment string,
	hours int,
) (IngestEnvironmentMetrics, error) {
	out := IngestEnvironmentMetrics{
		Environment:    environment,
		Samples:        []IngestHostSample{},
		WorkerSamples:  []IngestWorkerSample{},
		Workers:        []IngestWorkerCurrent{},
		Errors:         []IngestErrorCount{},
		RecentAttempts: []IngestRecentAttempt{},
		DataAsOf:       time.Now().UTC(),
	}
	err := db.QueryRow(ctx, `
		SELECT count(*)::bigint,
		       count(*) FILTER (WHERE status = 'succeeded')::bigint,
		       count(*) FILTER (WHERE status = 'retrying')::bigint,
		       count(*) FILTER (WHERE status = 'failed')::bigint,
		       count(*) FILTER (WHERE status = 'capacity_wait')::bigint,
		       count(*) FILTER (WHERE status = 'lease_expired')::bigint,
		       COALESCE(sum(parse_pages), 0)::bigint,
		       COALESCE(sum(parse_ocr_pages), 0)::bigint,
		       COALESCE(sum(parse_slices), 0)::bigint,
		       COALESCE(sum(figures_selected), 0)::bigint,
		       COALESCE(sum(figures_cached), 0)::bigint,
		       COALESCE(sum(figures_captioned), 0)::bigint,
		       COALESCE(sum(figures_failed), 0)::bigint,
		       COALESCE(sum(chunks_created), 0)::bigint,
		       COALESCE(round(avg(queue_milliseconds)), 0)::bigint,
		       COALESCE(round(percentile_cont(0.95) WITHIN GROUP (
		         ORDER BY queue_milliseconds)), 0)::bigint,
		       COALESCE(round(avg(duration_milliseconds) FILTER (
		         WHERE finished_at IS NOT NULL)), 0)::bigint,
		       COALESCE(round(percentile_cont(0.95) WITHIN GROUP (
		         ORDER BY duration_milliseconds) FILTER (
		           WHERE finished_at IS NOT NULL)), 0)::bigint
		  FROM ingest_job_attempts
		 WHERE environment = $2
		   AND claimed_at >= now() - make_interval(hours => $1)
	`, hours, environment).Scan(
		&out.Attempts.Attempts, &out.Attempts.Succeeded, &out.Attempts.Retrying,
		&out.Attempts.Failed, &out.Attempts.CapacityWaits,
		&out.Attempts.LeaseExpired, &out.Attempts.Pages, &out.Attempts.OCRPages,
		&out.Attempts.Slices, &out.Attempts.FiguresSelected,
		&out.Attempts.FiguresCached, &out.Attempts.FiguresCaptioned,
		&out.Attempts.FiguresFailed,
		&out.Attempts.ChunksCreated,
		&out.Attempts.AverageQueueMilliseconds, &out.Attempts.P95QueueMilliseconds,
		&out.Attempts.AverageDurationMilliseconds, &out.Attempts.P95DurationMilliseconds,
	)
	if err != nil {
		return out, err
	}
	err = db.QueryRow(ctx, `
		SELECT count(*)::bigint,
		       count(*) FILTER (WHERE p.status = 'abandoned')::bigint,
		       COALESCE(sum(input_tokens), 0)::bigint,
		       COALESCE(sum(output_tokens), 0)::bigint
		  FROM provider_calls p
		  JOIN ingest_job_attempts a ON a.id = p.job_attempt_id
		 WHERE a.environment = $2
		   AND p.opened_at >= now() - make_interval(hours => $1)
	`, hours, environment).Scan(
		&out.Attempts.ProviderCalls, &out.Attempts.AbandonedProviderCalls,
		&out.Attempts.InputTokens, &out.Attempts.OutputTokens,
	)
	if err != nil {
		return out, err
	}
	err = db.QueryRow(ctx, `
		SELECT count(*) FILTER (
		         WHERE type = 'import' AND status = 'pending'
		           AND COALESCE(not_before, now()) <= now())::bigint,
		       count(*) FILTER (
		         WHERE type = 'import' AND status = 'pending'
		           AND not_before > now())::bigint,
		       count(*) FILTER (WHERE type = 'import' AND status = 'running')::bigint,
		       count(*) FILTER (
		         WHERE type = 'parse' AND status = 'pending'
		           AND COALESCE(not_before, now()) <= now())::bigint,
		       count(*) FILTER (
		         WHERE type = 'parse' AND status = 'pending'
		           AND not_before > now())::bigint,
		       count(*) FILTER (WHERE type = 'parse' AND status = 'running')::bigint,
		       count(*) FILTER (
		         WHERE type = 'ingest' AND status = 'pending'
		           AND COALESCE(not_before, now()) <= now())::bigint,
		       count(*) FILTER (
		         WHERE type = 'ingest' AND status = 'pending'
		           AND not_before > now())::bigint,
		       count(*) FILTER (WHERE type = 'ingest' AND status = 'running')::bigint,
		       count(*) FILTER (
		         WHERE status = 'running' AND lease_expires_at < now())::bigint,
		       COALESCE(extract(epoch FROM now() - min(queued_at) FILTER (
		         WHERE status = 'pending')) * 1000, 0)::bigint
		  FROM jobs
		 WHERE type IN ('import', 'parse', 'ingest')
	`).Scan(
		&out.Queue.ImportReady, &out.Queue.ImportDelayed, &out.Queue.ImportRunning,
		&out.Queue.ParseReady, &out.Queue.ParseDelayed, &out.Queue.ParseRunning,
		&out.Queue.IngestReady, &out.Queue.IngestDelayed, &out.Queue.IngestRunning,
		&out.Queue.ExpiredLeases, &out.Queue.OldestQueuedMS,
	)
	if err != nil {
		return out, err
	}
	rows, err := db.Query(ctx, `
		SELECT date_bin('1 minute', sampled_at, timestamptz '1970-01-01') AS bucket,
		       host_id, max(release_sha), bool_or(host_metrics_available),
		       max(active_jobs)::bigint, max(queued_jobs)::bigint,
		       max(active_slices)::bigint, max(queued_slices)::bigint,
		       max(oldest_active_slice_ms)::bigint,
		       max(oldest_queued_slice_ms)::bigint,
		       max(last_slice_completed_age_ms)::bigint,
		       max(parser_oom_kill_events)::bigint,
		       avg(cpu_percent)::float8, avg(load_1)::float8,
		       avg(memory_used_bytes)::bigint, max(memory_total_bytes)::bigint,
		       max(swap_used_bytes)::bigint, max(parser_memory_bytes)::bigint,
		       max(parser_pss_bytes)::bigint, max(parser_memory_peak_bytes)::bigint,
		       max(network_rx_bytes)::bigint, max(network_tx_bytes)::bigint,
		       max(parse_ready_jobs)::bigint, max(parse_delayed_jobs)::bigint,
		       max(parse_running_jobs)::bigint, max(ingest_ready_jobs)::bigint,
		       max(ingest_delayed_jobs)::bigint, max(ingest_running_jobs)::bigint,
		       max(expired_leases)::bigint, max(oldest_queued_job_ms)::bigint,
		       min(disk_free_bytes)::bigint, max(spool_bytes)::bigint,
		       max(spool_files)::bigint
		FROM ingest_host_samples
		WHERE sampled_at >= now() - make_interval(hours => $1)
		  AND environment = $2
		GROUP BY bucket, host_id
		ORDER BY bucket, host_id
	`, hours, environment)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var sample IngestHostSample
		if err := rows.Scan(
			&sample.SampledAt, &sample.HostID, &sample.ReleaseSHA,
			&sample.HostMetricsAvailable, &sample.ActiveJobs,
			&sample.QueuedJobs, &sample.ActiveSlices, &sample.QueuedSlices,
			&sample.OldestActiveSliceMilliseconds,
			&sample.OldestQueuedSliceMilliseconds,
			&sample.LastSliceCompletedAgeMilliseconds,
			&sample.ParserOOMKillEvents, &sample.CPUPercent, &sample.Load1,
			&sample.MemoryUsedBytes, &sample.MemoryTotalBytes,
			&sample.SwapUsedBytes, &sample.ParserMemoryBytes,
			&sample.ParserPSSBytes, &sample.ParserMemoryPeakBytes,
			&sample.NetworkRXBytes, &sample.NetworkTXBytes,
			&sample.ParseReadyJobs, &sample.ParseDelayedJobs,
			&sample.ParseRunningJobs, &sample.IngestReadyJobs,
			&sample.IngestDelayedJobs, &sample.IngestRunningJobs,
			&sample.ExpiredLeases, &sample.OldestQueuedJobMilliseconds,
			&sample.DiskFreeBytes, &sample.SpoolBytes, &sample.SpoolFiles,
		); err != nil {
			rows.Close()
			return out, err
		}
		out.Samples = append(out.Samples, sample)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = db.Query(ctx, `
		WITH latest AS (
		  SELECT worker_instance_id, max(sampled_at) AS sampled_at
		    FROM ingest_worker_samples
		   WHERE environment = $1
		   GROUP BY worker_instance_id
		)
		SELECT DISTINCT ON (s.worker_instance_id)
		       s.sampled_at, s.host_id, s.worker_instance_id, s.role, s.release_sha,
		       state, stage, job_attempt_id, cpu_cores::float8,
		       memory_bytes, memory_limit_bytes, pids_current, pids_limit,
		       oom_events, oom_kill_events,
		       s.sampled_at < now() - interval '2 minutes'
		  FROM ingest_worker_samples s
		  JOIN latest l USING (worker_instance_id)
		 WHERE s.environment = $1
		   AND s.sampled_at >= l.sampled_at - interval '15 seconds'
		 ORDER BY s.worker_instance_id, (state = 'busy') DESC, s.sampled_at DESC
	`, environment)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item IngestWorkerCurrent
		if err := rows.Scan(
			&item.SampledAt, &item.HostID, &item.WorkerInstanceID, &item.Role,
			&item.ReleaseSHA, &item.State, &item.Stage, &item.JobAttemptID,
			&item.CPUCores, &item.MemoryBytes, &item.MemoryLimitBytes,
			&item.PIDsCurrent, &item.PIDsLimit, &item.OOMEvents,
			&item.OOMKillEvents, &item.Stale,
		); err != nil {
			rows.Close()
			return out, err
		}
		out.Workers = append(out.Workers, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = db.Query(ctx, `
		WITH workers AS (
		  SELECT date_bin('1 minute', sampled_at, timestamptz '1970-01-01') AS bucket,
		         role, worker_instance_id,
		         bool_or(state = 'busy') AS busy,
		         avg(cpu_cores)::float8 AS cpu_cores,
		         avg(memory_bytes)::bigint AS memory_bytes,
		         max(memory_limit_bytes)::bigint AS memory_limit_bytes,
		         max(oom_kill_events)::bigint AS oom_kill_events
		    FROM ingest_worker_samples
		   WHERE sampled_at >= now() - make_interval(hours => $1)
		     AND environment = $2
		   GROUP BY bucket, role, worker_instance_id
		)
		SELECT bucket, role, count(*)::bigint,
		       count(*) FILTER (WHERE busy)::bigint,
		       COALESCE(sum(cpu_cores), 0)::float8,
		       COALESCE(sum(memory_bytes), 0)::bigint,
		       COALESCE(sum(memory_limit_bytes), 0)::bigint,
		       COALESCE(sum(oom_kill_events), 0)::bigint
		  FROM workers
		 GROUP BY bucket, role
		 ORDER BY bucket, role
	`, hours, environment)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var sample IngestWorkerSample
		if err := rows.Scan(
			&sample.SampledAt, &sample.Role, &sample.WorkerCount,
			&sample.BusyWorkers, &sample.CPUCores, &sample.MemoryBytes,
			&sample.MemoryLimitBytes, &sample.OOMKillEvents,
		); err != nil {
			rows.Close()
			return out, err
		}
		out.WorkerSamples = append(out.WorkerSamples, sample)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = db.Query(ctx, `
		WITH failures AS (
		  SELECT error_category, error_code, stage
		    FROM ingest_job_attempts
		   WHERE environment = $2
		     AND claimed_at >= now() - make_interval(hours => $1)
		     AND status IN ('retrying', 'failed', 'lease_expired')
		  UNION ALL
		  SELECT COALESCE(NULLIF(p.error_category, ''), 'provider'),
		         COALESCE(NULLIF(p.error_code, ''), 'provider_abandoned'),
		         p.job_stage
		    FROM provider_calls p
		    JOIN ingest_job_attempts a ON a.id = p.job_attempt_id
		   WHERE a.environment = $2
		     AND p.opened_at >= now() - make_interval(hours => $1)
		     AND p.status = 'abandoned'
		)
		SELECT error_category, error_code, stage, count(*)::bigint
		  FROM failures
		 GROUP BY error_category, error_code, stage
		 ORDER BY count(*) DESC, error_category, error_code, stage
		 LIMIT 25
	`, hours, environment)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item IngestErrorCount
		if err := rows.Scan(&item.Category, &item.Code, &item.Stage, &item.Count); err != nil {
			rows.Close()
			return out, err
		}
		out.Errors = append(out.Errors, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = db.Query(ctx, `
		SELECT a.id, a.job_id, a.operation_id, a.attempt, a.job_type,
		       a.status, a.stage, a.error_category, a.error_code, a.retryable,
		       a.route, a.source_format, a.claimed_at, a.finished_at,
		       a.next_retry_at, a.queue_milliseconds,
		       CASE WHEN a.finished_at IS NULL THEN GREATEST(
		         0, round(extract(epoch FROM (now() - a.claimed_at)) * 1000)
		       )::bigint ELSE a.duration_milliseconds END, a.stage_timings,
		       a.parse_pages, a.parse_ocr_pages, a.parse_slices,
		       a.figures_captioned, a.figures_failed, a.chunks_created,
		       COALESCE(p.calls, 0)::bigint, COALESCE(p.abandoned, 0)::bigint
		  FROM ingest_job_attempts a
		  LEFT JOIN LATERAL (
		    SELECT count(*) AS calls,
		           count(*) FILTER (WHERE status = 'abandoned') AS abandoned
		      FROM provider_calls
		     WHERE job_attempt_id = a.id
		  ) p ON true
		 WHERE a.environment = $1
		 ORDER BY a.claimed_at DESC
		 LIMIT 50
	`, environment)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item IngestRecentAttempt
		if err := rows.Scan(
			&item.ID, &item.JobID, &item.OperationID, &item.Attempt,
			&item.JobType, &item.Status, &item.Stage, &item.ErrorCategory,
			&item.ErrorCode, &item.Retryable, &item.Route, &item.SourceFormat,
			&item.ClaimedAt, &item.FinishedAt, &item.NextRetryAt,
			&item.QueueMilliseconds, &item.DurationMilliseconds,
			&item.StageTimings, &item.Pages, &item.OCRPages, &item.Slices,
			&item.FiguresCaptioned,
			&item.FiguresFailed, &item.ChunksCreated, &item.ProviderCalls,
			&item.AbandonedProviderCalls,
		); err != nil {
			rows.Close()
			return out, err
		}
		out.RecentAttempts = append(out.RecentAttempts, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	err = db.QueryRow(ctx, `
		SELECT max(activity_at) FROM (
		  SELECT max(claimed_at) AS activity_at
		    FROM ingest_job_attempts WHERE environment=$1
		  UNION ALL
		  SELECT max(updated_at)
		    FROM jobs WHERE type IN ('import', 'parse', 'ingest')
		) activity
	`, environment).Scan(&out.LastJobActivityAt)
	if err != nil {
		return out, err
	}
	return out, nil
}

func (s *ReadStore) usageSeries(
	ctx context.Context,
	dimension string,
) ([]UsagePoint, error) {
	if dimension != "kind" && dimension != "surface" {
		return nil, fmt.Errorf("unsupported usage dimension")
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
		       %s, sum(credit_micros)::bigint
		FROM usage_events
		WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
		GROUP BY 1, %s ORDER BY 1, %s`, dimension, dimension, dimension))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UsagePoint, 0)
	for rows.Next() {
		var item UsagePoint
		var day time.Time
		if err := rows.Scan(&day, &item.Key, &item.CreditMicros); err != nil {
			return nil, err
		}
		item.Day = day.Format("2006-01-02")
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) Health(ctx context.Context, stuckMinutes int) (Health, error) {
	out := Health{
		ActiveTurns:    []TurnLifecycle{},
		StaleTurns:     []TurnLifecycle{},
		FailedTurns:    []TurnLifecycle{},
		AbandonedCalls: []ProviderCallDiagnostic{},
		DataAsOf:       time.Now().UTC(),
	}
	if stuckMinutes < 1 || stuckMinutes > 24*60 {
		return out, validation("stuck job threshold must be between 1 and 1440 minutes")
	}
	var settled, released int64
	err := s.db.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM provider_sessions
			 WHERE status = 'open' AND expires_at < now()),
			(SELECT count(*) FROM jobs
			 WHERE status = 'running'
			   AND COALESCE(lease_expires_at, locked_at, updated_at)
			       < now() - make_interval(mins => $1)),
			(SELECT count(*) FROM email_outbox
			 WHERE status = 'failed' AND updated_at >= now() - interval '24 hours'),
			(SELECT count(*) FROM ops_assistant_turns t
			 WHERE t.status = 'complete'
			   AND t.created_at >= now() - interval '24 hours'
			   AND t.trace_id IS NOT NULL
			   AND NOT EXISTS (
				 SELECT 1
				 FROM provider_sessions cr
				 JOIN provider_calls pc ON pc.reservation_id = cr.id
				 WHERE cr.trace_id = t.trace_id
				   AND pc.kind = 'llm' AND pc.status = 'applied'
			   )),
			(SELECT count(*) FROM provider_calls pc
			 WHERE pc.status = 'applied'
			   AND pc.applied_at >= now() - interval '24 hours'
			   AND NOT EXISTS (
				 SELECT 1 FROM usage_events ue
				 WHERE ue.reservation_id = pc.reservation_id
				   AND ue.provider_call_id = pc.id
			   )),
			(SELECT count(*) FROM usage_events ue
			 WHERE ue.kind IN ('llm', 'embedding')
			   AND ue.created_at >= now() - interval '24 hours'
			   AND (ue.provider_call_id IS NULL OR NOT EXISTS (
				 SELECT 1 FROM provider_calls pc
				 WHERE pc.id = ue.provider_call_id
				   AND pc.reservation_id = ue.reservation_id
			   ))),
			(SELECT count(*) FROM provider_sessions
			 WHERE status = 'settled' AND settled_at >= now() - interval '24 hours'),
			(SELECT count(*) FROM provider_sessions
			 WHERE status = 'released' AND settled_at >= now() - interval '24 hours'),
			(SELECT count(*) FROM provider_calls
			 WHERE status = 'open' AND opened_at < now() - interval '2 minutes')
	`, stuckMinutes).Scan(
		&out.ExpiredReservations, &out.StuckJobs,
		&out.EmailFailures24h, &out.TurnsMissingApplied24h,
		&out.AppliedWithoutUsage24h, &out.ProviderUsageWithoutCall24h,
		&settled, &released,
		&out.StaleOpenCalls,
	)
	if err != nil {
		return out, err
	}
	out.ReservationRatio24h.Settled = settled
	out.ReservationRatio24h.Released = released
	if total := settled + released; total > 0 {
		out.ReservationRatio24h.ReleaseRate = float64(released) / float64(total)
	}
	if out.ActiveTurns, err = s.turnLifecycles(ctx, "active"); err != nil {
		return out, err
	}
	if out.StaleTurns, err = s.turnLifecycles(ctx, "stale"); err != nil {
		return out, err
	}
	if out.FailedTurns, err = s.turnLifecycles(ctx, "failed"); err != nil {
		return out, err
	}
	if out.AbandonedCalls, err = s.abandonedCalls(ctx); err != nil {
		return out, err
	}
	return out, nil
}

func (s *ReadStore) Reconciliation(ctx context.Context) (ReconciliationStatus, error) {
	out := ReconciliationStatus{
		Runs:     []ReconciliationRun{},
		Reports:  []ReconciliationReport{},
		DataAsOf: time.Now().UTC(),
	}
	runRows, err := s.db.Query(ctx, `
		SELECT id, job_type, trigger, status,
		       COALESCE(requested_by_id, ''), requested_by_name,
		       requested_at, started_at, finished_at,
		       scanned_count, repaired_count, error_count, error
		  FROM reconcile_runs
		 ORDER BY requested_at DESC, id DESC
		 LIMIT 20`)
	if err != nil {
		return out, err
	}
	defer runRows.Close()
	for runRows.Next() {
		var item ReconciliationRun
		if err := runRows.Scan(
			&item.ID, &item.JobType, &item.Trigger, &item.Status,
			&item.RequestedByID, &item.RequestedByName,
			&item.RequestedAt, &item.StartedAt, &item.FinishedAt,
			&item.ScannedCount, &item.RepairedCount, &item.ErrorCount, &item.Error,
		); err != nil {
			return out, err
		}
		out.Runs = append(out.Runs, item)
	}
	if err := runRows.Err(); err != nil {
		return out, err
	}

	rows, err := s.db.Query(ctx, `
		SELECT id, run_id, event_type, subject_type, subject_id,
		       COALESCE(actor_user_id, ''), metadata, created_at
		  FROM reconciliation_report
		 ORDER BY created_at DESC, id DESC
		 LIMIT 50`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item ReconciliationReport
		if err := rows.Scan(
			&item.ID, &item.RunID, &item.EventType, &item.SubjectType,
			&item.SubjectID, &item.ActorUserID, &item.Metadata, &item.CreatedAt,
		); err != nil {
			return out, err
		}
		out.Reports = append(out.Reports, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) turnLifecycles(
	ctx context.Context,
	category string,
) ([]TurnLifecycle, error) {
	conditions := map[string]string{
		"active": `t.status = 'streaming'
			AND cr.status = 'open' AND cr.expires_at >= now()`,
		"stale": `t.status = 'streaming' AND NOT COALESCE((
			cr.status = 'open' AND cr.expires_at >= now()
		), false)`,
		"failed": `t.status IN ('error', 'aborted')
			AND t.created_at >= now() - interval '24 hours'`,
	}
	condition, ok := conditions[category]
	if !ok {
		return nil, fmt.Errorf("unsupported turn lifecycle category")
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT t.id, t.user_id, t.status, COALESCE(t.trace_id, ''), t.created_at,
		       COALESCE(cr.id, ''), COALESCE(cr.status, ''), COALESCE(cr.surface, ''),
		       cr.expires_at,
		       COALESCE(calls.applied, 0), COALESCE(calls.open, 0),
		       COALESCE(calls.abandoned, 0), COALESCE(calls.latest_purpose, ''),
		       COALESCE(calls.latest_status, ''), calls.latest_opened_at
		FROM ops_assistant_turns t
		LEFT JOIN LATERAL (
			SELECT r.id, r.status, r.surface, r.expires_at
			FROM provider_sessions r
			WHERE r.trace_id = t.trace_id
			ORDER BY r.created_at DESC LIMIT 1
		) cr ON true
		LEFT JOIN LATERAL (
			SELECT count(*) FILTER (WHERE p.status = 'applied') AS applied,
			       count(*) FILTER (WHERE p.status = 'open') AS open,
			       count(*) FILTER (WHERE p.status = 'abandoned') AS abandoned,
			       (array_agg(p.purpose ORDER BY p.opened_at DESC))[1] AS latest_purpose,
			       (array_agg(p.status ORDER BY p.opened_at DESC))[1] AS latest_status,
			       max(p.opened_at) AS latest_opened_at
			FROM provider_calls p WHERE p.reservation_id = cr.id
		) calls ON true
		WHERE %s
		ORDER BY t.created_at DESC LIMIT 50`, condition))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TurnLifecycle{}
	for rows.Next() {
		var item TurnLifecycle
		if err := rows.Scan(
			&item.MessageID, &item.UserID, &item.Status, &item.TraceID,
			&item.StartedAt, &item.ReservationID, &item.ReservationStatus,
			&item.Surface, &item.ReservationExpiresAt, &item.AppliedCalls,
			&item.OpenCalls, &item.AbandonedCalls, &item.LatestCallPurpose,
			&item.LatestCallStatus, &item.LatestCallOpenedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) abandonedCalls(ctx context.Context) ([]ProviderCallDiagnostic, error) {
	rows, err := s.db.Query(ctx, `
		SELECT pc.id, pc.reservation_id, pc.actor_user_id,
		       COALESCE(cr.trace_id, ''), COALESCE(turn.status, ''), cr.status,
		       cr.surface, pc.purpose, pc.thinking,
		       pc.context_system_tokens, pc.context_tool_tokens,
		       pc.context_conversation_tokens, pc.context_total_tokens,
		       pc.context_window_tokens, pc.context_counting_method,
		       pc.context_counting_version, pc.opened_at
		FROM provider_calls pc
		JOIN provider_sessions cr ON cr.id = pc.reservation_id
		LEFT JOIN LATERAL (
			SELECT t.status FROM ops_assistant_turns t
			WHERE t.trace_id = cr.trace_id
			ORDER BY t.created_at DESC LIMIT 1
		) turn ON true
		WHERE pc.status = 'abandoned'
		  AND pc.opened_at >= now() - interval '24 hours'
		ORDER BY pc.opened_at DESC LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProviderCallDiagnostic{}
	for rows.Next() {
		var item ProviderCallDiagnostic
		if err := rows.Scan(
			&item.CallID, &item.ReservationID, &item.UserID, &item.TraceID,
			&item.TurnStatus, &item.ReservationStatus, &item.Surface,
			&item.Purpose, &item.Thinking, &item.ContextSystemTokens,
			&item.ContextToolTokens, &item.ContextConversationTokens,
			&item.ContextTotalTokens, &item.ContextWindowTokens,
			&item.ContextCountingMethod, &item.ContextCountingVersion,
			&item.OpenedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) SearchUsers(ctx context.Context, query string) ([]UserSearchResult, error) {
	query = strings.TrimSpace(query)
	if len(query) < 2 {
		return []UserSearchResult{}, nil
	}
	if len(query) > userSearchMaxLen {
		return nil, validation("user search must be at most %d characters", userSearchMaxLen)
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, name, COALESCE(email, ''), plan_tier
		FROM users
		WHERE id = $1 OR email ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
		ORDER BY (id = $1) DESC, (lower(email) = lower($1)) DESC, email
		LIMIT $2`, query, userSearchLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]UserSearchResult, 0)
	for rows.Next() {
		var item UserSearchResult
		if err := rows.Scan(&item.UserID, &item.Name, &item.Email, &item.PlanTier); err != nil {
			return nil, err
		}
		status, err := s.app.AccountAccess(ctx, item.UserID)
		if err != nil {
			return nil, err
		}
		item.AccountState = string(status.State)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *ReadStore) User(ctx context.Context, userID string) (UserDetail, error) {
	out := UserDetail{
		UsageByKind: []UsagePoint{},
		Workspaces:  []UserWorkspace{},
		RecentUsage: []UsageEvent{},
		DataAsOf:    time.Now().UTC(),
	}
	err := s.db.QueryRow(ctx, `
		SELECT id, name, COALESCE(email, ''), plan_tier,
		       session_revoke_pending, session_revoke_attempts,
		       session_revoke_not_before, session_revoke_last_error
		FROM users WHERE id = $1`, userID).
		Scan(&out.UserID, &out.Name, &out.Email, &out.PlanTier,
			&out.SessionRevocationPending, &out.SessionRevocationAttempts,
			&out.SessionRevocationDueAt, &out.SessionRevocationError)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, store.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	status, err := s.app.AccountAccess(ctx, userID)
	if err != nil {
		return out, err
	}
	out.AccountState = string(status.State)
	credits, err := s.app.CreditBalance(ctx, userID)
	if err != nil {
		return out, err
	}
	out.Credits = CreditBalance{
		PeriodStart:    credits.PeriodStart.Format("2006-01-02"),
		UsedMicros:     credits.UsedMicros,
		ReservedMicros: credits.ReservedMicros,
		LimitMicros:    credits.LimitMicros,
	}
	err = s.db.QueryRow(ctx, `
		SELECT COALESCE(st.used_bytes, 0) + COALESCE((
				SELECT sum(d.delta_bytes) FROM user_storage_deltas d
				WHERE d.user_id = $1
			), 0),
			COALESCE(st.reserved_bytes, 0)
		FROM users u LEFT JOIN user_storage st ON st.user_id = u.id
		WHERE u.id = $1`, userID).Scan(
		&out.Storage.UsedBytes, &out.Storage.ReservedBytes,
	)
	if err != nil {
		return out, err
	}
	limits, err := s.app.PlanLimits(store.PlanTier(out.PlanTier))
	if err != nil {
		return out, err
	}
	out.Storage.LimitBytes = limits.StorageBytes
	rows, err := s.db.Query(ctx, `
		SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
		       kind, sum(credit_micros)::bigint
		FROM usage_events
		WHERE actor_user_id = $1
		  AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
		GROUP BY 1, kind ORDER BY 1, kind`, userID)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item UsagePoint
		var day time.Time
		if err := rows.Scan(&day, &item.Key, &item.CreditMicros); err != nil {
			rows.Close()
			return out, err
		}
		item.Day = day.Format("2006-01-02")
		out.UsageByKind = append(out.UsageByKind, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT w.id, w.name, count(f.id), w.last_accessed_at
		FROM workspaces w LEFT JOIN files f ON f.workspace_id = w.id
		WHERE w.user_id = $1
		GROUP BY w.id ORDER BY w.last_accessed_at DESC
		LIMIT $2`, userID, userWorkspaceLimit)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var item UserWorkspace
		if err := rows.Scan(&item.ID, &item.Name, &item.FileCount, &item.LastActivityAt); err != nil {
			rows.Close()
			return out, err
		}
		out.Workspaces = append(out.Workspaces, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return out, err
	}
	rows.Close()
	rows, err = s.db.Query(ctx, `
		SELECT COALESCE(ue.trace_id, ''), ue.kind, ue.surface,
			ue.provider, ue.model, ue.thinking, ue.catalog_provider_slug,
			ue.catalog_model_slug, ue.model_version, ue.input_tokens,
			COALESCE(pc.cached_read_tokens, 0), COALESCE(pc.cache_write_tokens, 0),
			ue.output_tokens, COALESCE(pc.reasoning_tokens, 0),
			ue.parse_pages, ue.parse_ocr_pages, ue.parse_cpu_milliseconds,
			ue.parse_elapsed_milliseconds,
			ue.credit_micros, ue.created_at, COALESCE(pc.id, ''),
			COALESCE(pc.status, ''), COALESCE(pc.purpose, ''),
			COALESCE(cr.paid_by, ''), COALESCE(pc.cache_anomaly, ''),
			COALESCE(pc.context_system_tokens, 0),
			COALESCE(pc.context_tool_tokens, 0),
			COALESCE(pc.context_conversation_tokens, 0),
			COALESCE(pc.context_total_tokens, 0),
			COALESCE(pc.context_window_tokens, 0),
			COALESCE(pc.context_counting_method, ''),
			COALESCE(pc.context_counting_version, 0)
		FROM usage_events ue
		LEFT JOIN provider_calls pc
		  ON pc.reservation_id = ue.reservation_id AND pc.id = ue.provider_call_id
		LEFT JOIN provider_sessions cr ON cr.id = ue.reservation_id
		WHERE ue.actor_user_id = $1
		ORDER BY ue.created_at DESC, ue.id DESC LIMIT $2`, userID, recentUsageLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item UsageEvent
		if err := rows.Scan(&item.TraceID, &item.Kind, &item.Surface,
			&item.Provider, &item.Model, &item.Thinking,
			&item.CatalogProviderSlug, &item.CatalogModelSlug, &item.ModelVersion,
			&item.InputTokens, &item.CachedReadTokens, &item.CacheWriteTokens,
			&item.OutputTokens, &item.ReasoningTokens, &item.ParsePages,
			&item.ParseOCRPages, &item.ParseCPUMilliseconds,
			&item.ParseElapsedMilliseconds,
			&item.CreditMicros, &item.CreatedAt, &item.ProviderCallID,
			&item.ProviderCallStatus, &item.Purpose, &item.PaidBy,
			&item.CacheAnomaly, &item.ContextSystemTokens, &item.ContextToolTokens,
			&item.ContextConversationTokens, &item.ContextTotalTokens,
			&item.ContextWindowTokens, &item.ContextCountingMethod,
			&item.ContextCountingVersion); err != nil {
			return out, err
		}
		out.RecentUsage = append(out.RecentUsage, item)
	}
	return out, rows.Err()
}

var costDimensions = map[string]string{
	"user":     "ue.actor_user_id",
	"kind":     "ue.kind",
	"surface":  "ue.surface",
	"provider": "COALESCE(NULLIF(ue.catalog_provider_slug, ''), ue.provider)",
	"model": `concat_ws(' ',
		COALESCE(NULLIF(ue.catalog_provider_slug, ''), ue.provider), '/',
		COALESCE(NULLIF(ue.catalog_model_slug, ''), ue.model),
		CASE WHEN ue.model_version > 0 THEN 'v' || ue.model_version::text ELSE '' END)`,
	"thinking": "ue.thinking",
}

var costBuckets = map[string]string{
	"day":   "to_char((ue.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')",
	"month": "to_char(date_trunc('month', ue.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-01')",
}

func (s *ReadStore) Costs(
	ctx context.Context,
	from, to time.Time,
	groupBy, bucket string,
) (CostReport, error) {
	out := CostReport{
		From: from.Format("2006-01-02"), To: to.Format("2006-01-02"),
		Bucket: bucket, DataAsOf: time.Now().UTC(), Rows: []CostRow{},
	}
	if from.After(to) || to.Sub(from) > 365*24*time.Hour {
		return out, validation("usage range must be ordered and at most 366 days")
	}
	if groupBy == "" {
		groupBy = "day"
	}
	if bucket == "" {
		bucket = "day"
		out.Bucket = bucket
	}
	column := costDimensions[groupBy]
	if groupBy == "day" {
		column = costBuckets[bucket]
	}
	if column == "" {
		return out, validation("unsupported usage group %q", groupBy)
	}
	if costBuckets[bucket] == "" {
		return out, validation("unsupported usage bucket %q", bucket)
	}
	observedColumn := "''"
	if groupBy == "provider" || groupBy == "model" {
		observedColumn = `COALESCE(string_agg(DISTINCT NULLIF(concat_ws('/',
			NULLIF(ue.provider, ''), NULLIF(ue.model, '')), ''), ', '), '')`
	}
	rows, err := s.db.Query(ctx, fmt.Sprintf(`
		SELECT %s AS key,
			%s AS observed,
			count(*)::bigint, sum(ue.input_tokens)::bigint,
			sum(COALESCE(pc.cached_read_tokens, 0))::bigint,
			sum(COALESCE(pc.cache_write_tokens, 0))::bigint,
			sum(ue.output_tokens)::bigint,
			sum(COALESCE(pc.reasoning_tokens, 0))::bigint,
			sum(ue.parse_pages)::bigint,
			sum(ue.parse_ocr_pages)::bigint,
			sum(ue.parse_cpu_milliseconds)::bigint,
			sum(ue.parse_elapsed_milliseconds)::bigint,
			sum(ue.credit_micros)::bigint,
			sum(COALESCE(pc.context_system_tokens, 0))::bigint,
			sum(COALESCE(pc.context_tool_tokens, 0))::bigint,
			sum(COALESCE(pc.context_conversation_tokens, 0))::bigint,
			sum(COALESCE(pc.context_total_tokens, 0))::bigint
		FROM usage_events ue
		LEFT JOIN provider_calls pc
		  ON pc.reservation_id = ue.reservation_id AND pc.id = ue.provider_call_id
		WHERE ue.created_at >= $1 AND ue.created_at < $2
		GROUP BY %s
		ORDER BY sum(ue.credit_micros) DESC LIMIT %d`,
		column, observedColumn, column, maxCostRows), from, to.Add(24*time.Hour))
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var item CostRow
		if err := rows.Scan(
			&item.Key, &item.Observed, &item.Events, &item.InputTokens,
			&item.CachedReadTokens,
			&item.CacheWriteTokens, &item.OutputTokens, &item.ReasoningTokens,
			&item.ParsePages, &item.ParseOCRPages, &item.ParseCPUMilliseconds,
			&item.ParseElapsedMilliseconds, &item.CreditMicros,
			&item.ContextSystemTokens,
			&item.ContextToolTokens, &item.ContextConversationTokens,
			&item.ContextTotalTokens,
		); err != nil {
			return out, err
		}
		out.Rows = append(out.Rows, item)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows.Close()
	err = s.db.QueryRow(ctx, `
		SELECT count(*)::bigint,
		       COALESCE(sum(context_system_tokens), 0)::bigint,
		       COALESCE(sum(context_tool_tokens), 0)::bigint,
		       COALESCE(sum(context_conversation_tokens), 0)::bigint,
		       COALESCE(sum(context_total_tokens), 0)::bigint,
		       COALESCE(sum(context_window_tokens), 0)::bigint,
		       COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY
		         context_total_tokens::double precision / context_window_tokens), 0),
		       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY
		         context_total_tokens::double precision / context_window_tokens), 0),
		       COALESCE(max(
		         context_total_tokens::double precision / context_window_tokens), 0),
		       count(*) FILTER (
		         WHERE context_total_tokens * 100 >= context_window_tokens * 80),
		       count(*) FILTER (
		         WHERE context_total_tokens * 100 >= context_window_tokens * 90),
		       count(*) FILTER (
		         WHERE context_total_tokens * 100 >= context_window_tokens * 95)
		FROM provider_calls
		WHERE kind = 'llm' AND context_window_tokens > 0
		  AND opened_at >= $1 AND opened_at < $2`, from, to.Add(24*time.Hour)).Scan(
		&out.ContextSummary.Calls, &out.ContextSummary.SystemTokens,
		&out.ContextSummary.ToolTokens, &out.ContextSummary.ConversationTokens,
		&out.ContextSummary.TotalTokens, &out.ContextSummary.WindowTokens,
		&out.ContextSummary.P50WindowUtilization,
		&out.ContextSummary.P95WindowUtilization,
		&out.ContextSummary.MaxWindowUtilization,
		&out.ContextSummary.CallsAtLeast80Percent,
		&out.ContextSummary.CallsAtLeast90Percent,
		&out.ContextSummary.CallsAtLeast95Percent,
	)
	return out, err
}
