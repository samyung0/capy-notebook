"""Thin psycopg helpers over the shared Postgres job queue.

Only queue/file/notification plumbing lives here. The retrieval index has its
own async access layer in ``pipeline.retrieval.store``; these stay synchronous
because they run inside short transactions the worker commits explicitly, and
are called via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import secrets
import threading
import time
from typing import Any

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .. import plan_limits
from ..config import cfg
from ..jobs import TerminalError

_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()
_telemetry_maintenance_lock = threading.Lock()
_telemetry_maintenance_at = 0.0
log = logging.getLogger(__name__)


# The worker binds one source candidate for its task. asyncio.to_thread copies
# this context, while heartbeats pass their durable job payload explicitly.
_source_refresh: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "source_refresh", default=None
)


def bind_source_refresh(job: dict[str, Any]):
    payload = job.get("payload") or {}
    value = {
        **payload,
        "_jobId": str(job["id"]),
        "_attempt": int(job.get("attempts") or 1),
    }
    return _source_refresh.set(value)


def reset_source_refresh(token) -> None:
    _source_refresh.reset(token)


def pipeline_source_for(file_id: str) -> dict[str, Any] | None:
    value = _source_refresh.get()
    return value if value is not None and value.get("fileId") == file_id else None


def source_refresh_for(file_id: str) -> dict[str, Any] | None:
    value = pipeline_source_for(file_id)
    return value if value is not None and value.get("sourceRefresh") is True else None


def source_refresh_for_job(job_id: str) -> dict[str, Any] | None:
    value = _source_refresh.get()
    return (
        value
        if value is not None
        and value.get("sourceRefresh") is True
        and value.get("_jobId") == job_id
        else None
    )


def source_boundary_payload(payload: dict[str, Any]) -> dict[str, Any]:
    active = source_refresh_for(str(payload.get("fileId") or ""))
    return {**active, **payload} if active is not None else payload


def stage_source_candidate(cur, file_id: str, fields: dict[str, Any]) -> bool:
    active = source_refresh_for(file_id)
    if active is None:
        return False
    allowed = {
        "parse_artifact_key",
        "parse_artifact_fingerprint",
        "parse_artifact_version",
        "preview_blob_path",
        "source_sha256",
        "content_hash",
    }
    if not fields or not set(fields).issubset(allowed):
        raise ValueError("invalid candidate fields")
    # Every caller first takes the source/attempt fence in this transaction.
    assignments = ",".join(f"{column}=%s" for column in fields)
    cur.execute(
        f"UPDATE source_refresh_candidates SET {assignments} WHERE file_id=%s AND job_id=%s AND lease_token=%s",
        (*fields.values(), file_id, active["_jobId"], active["sourceLeaseToken"]),
    )
    if not cur.rowcount:
        raise SourceSupersededError("source candidate was superseded")
    return True


def transfer_source_candidate(
    cur, payload: dict[str, Any], previous: str, following: str
) -> None:
    if payload.get("sourceRefresh") is not True:
        return
    cur.execute(
        """UPDATE source_refresh_candidates SET job_id=%s
        WHERE file_id=%s AND job_id=%s AND lease_token=%s""",
        (following, payload["fileId"], previous, payload["sourceLeaseToken"]),
    )
    if not cur.rowcount:
        raise SourceSupersededError("source candidate was superseded")
    cur.execute(
        "UPDATE source_documents SET running_job_id=%s WHERE file_id=%s AND running_job_id=%s",
        (following, payload["fileId"], previous),
    )


def discard_source_candidate(
    cur, payload: dict[str, Any], job_id: str, error: str, *, stale: bool
) -> None:
    if payload.get("sourceRefresh") is not True:
        return
    cur.execute(
        """UPDATE source_documents d SET running_job_id=NULL,
            desired_checkpoint=CASE WHEN %s THEN checkpoint ELSE desired_checkpoint END,
            refresh_error=CASE WHEN %s THEN NULL ELSE %s END
        WHERE d.file_id=%s AND d.running_job_id=%s AND EXISTS(
            SELECT 1 FROM source_refresh_candidates c WHERE c.file_id=d.file_id
            AND c.job_id=%s AND c.lease_token=%s)""",
        (
            stale,
            stale,
            error[:2000],
            payload["fileId"],
            job_id,
            job_id,
            payload["sourceLeaseToken"],
        ),
    )
    cur.execute(
        "DELETE FROM source_refresh_candidates WHERE file_id=%s AND job_id=%s AND lease_token=%s",
        (payload["fileId"], job_id, payload["sourceLeaseToken"]),
    )


class SourceSupersededError(TerminalError):
    """The job's source revision is no longer the file's current source."""


class ProviderReceiptExpired(RuntimeError):
    """The exact provider receipt arrived after its stored deadline."""


class ProviderSettlementRejected(RuntimeError):
    """The receipt cannot match the immutable local accounting state."""


def pool() -> ConnectionPool:
    """Lazy singleton so tests can rewrite ``cfg.dsn`` before the first borrow."""
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ConnectionPool(
                    cfg.dsn,
                    min_size=1,
                    max_size=cfg.db_sync_pool_max_size,
                    kwargs={
                        "connect_timeout": 5,
                        "options": "-c statement_timeout=30000",
                    },
                )
    return _pool


def connect():
    """Borrow a pooled connection. Always use as ``with db.connect() as conn``."""
    return pool().connection()


def close_pool() -> None:
    global _pool
    with _pool_lock:
        pool = _pool
        _pool = None
    if pool is not None:
        pool.close()


def record_worker_sample(
    *,
    environment: str,
    host_id: str,
    worker_instance_id: str,
    role: str,
    release_sha: str,
    state: str,
    stage: str,
    job_attempt_id: int | None,
    values: dict[str, int | float],
) -> None:
    """Insert one worker cgroup sample and refresh its current minute rollup."""
    global _telemetry_maintenance_at
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ingest_worker_samples
              (environment, host_id, worker_instance_id, role, release_sha,
               state, stage, job_attempt_id, cpu_cores, cpu_usage_usec,
               memory_bytes, memory_peak_bytes, memory_limit_bytes,
               io_read_bytes, io_write_bytes, pids_current, pids_limit,
               oom_events, oom_kill_events)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (
                environment,
                host_id,
                worker_instance_id,
                role,
                release_sha,
                state,
                stage[:80],
                job_attempt_id,
                max(0.0, float(values.get("cpu_cores") or 0)),
                max(0, int(values.get("cpu_usage_usec") or 0)),
                max(0, int(values.get("memory_bytes") or 0)),
                max(0, int(values.get("memory_peak_bytes") or 0)),
                max(0, int(values.get("memory_limit_bytes") or 0)),
                max(0, int(values.get("io_read_bytes") or 0)),
                max(0, int(values.get("io_write_bytes") or 0)),
                max(0, int(values.get("pids_current") or 0)),
                max(0, int(values.get("pids_limit") or 0)),
                max(0, int(values.get("oom_events") or 0)),
                max(0, int(values.get("oom_kill_events") or 0)),
            ),
        )
        cur.execute(
            """
            INSERT INTO ingest_worker_sample_rollups
              (bucket, environment, host_id, worker_instance_id, role,
               release_sha, samples, busy_samples, cpu_cores_avg,
               cpu_cores_max, memory_bytes_avg, memory_bytes_max,
               memory_peak_bytes_max, memory_limit_bytes_max,
               io_read_bytes_max, io_write_bytes_max, pids_current_max,
               pids_limit_max, oom_events_max, oom_kill_events_max)
            SELECT date_bin('1 minute', sampled_at, timestamptz '1970-01-01'),
                   environment, max(host_id), worker_instance_id, max(role),
                   max(release_sha), count(*)::int,
                   count(*) FILTER (WHERE state='busy')::int,
                   avg(cpu_cores)::real, max(cpu_cores)::real,
                   avg(memory_bytes)::bigint, max(memory_bytes)::bigint,
                   max(memory_peak_bytes)::bigint,
                   max(memory_limit_bytes)::bigint,
                   max(io_read_bytes)::bigint, max(io_write_bytes)::bigint,
                   max(pids_current)::int, max(pids_limit)::int,
                   max(oom_events)::bigint, max(oom_kill_events)::bigint
            FROM ingest_worker_samples
            WHERE environment=%s AND worker_instance_id=%s
              AND sampled_at >= date_bin(
                '1 minute', now(), timestamptz '1970-01-01'
              )
            GROUP BY 1, environment, worker_instance_id
            ON CONFLICT (bucket, environment, worker_instance_id) DO UPDATE SET
              host_id=EXCLUDED.host_id, role=EXCLUDED.role,
              release_sha=EXCLUDED.release_sha, samples=EXCLUDED.samples,
              busy_samples=EXCLUDED.busy_samples,
              cpu_cores_avg=EXCLUDED.cpu_cores_avg,
              cpu_cores_max=EXCLUDED.cpu_cores_max,
              memory_bytes_avg=EXCLUDED.memory_bytes_avg,
              memory_bytes_max=EXCLUDED.memory_bytes_max,
              memory_peak_bytes_max=EXCLUDED.memory_peak_bytes_max,
              memory_limit_bytes_max=EXCLUDED.memory_limit_bytes_max,
              io_read_bytes_max=EXCLUDED.io_read_bytes_max,
              io_write_bytes_max=EXCLUDED.io_write_bytes_max,
              pids_current_max=EXCLUDED.pids_current_max,
              pids_limit_max=EXCLUDED.pids_limit_max,
              oom_events_max=EXCLUDED.oom_events_max,
              oom_kill_events_max=EXCLUDED.oom_kill_events_max
            """,
            (environment, worker_instance_id),
        )
        now = time.monotonic()
        maintain = False
        with _telemetry_maintenance_lock:
            if now - _telemetry_maintenance_at >= 3600:
                _telemetry_maintenance_at = now
                maintain = True
        if maintain:
            cur.execute(
                "DELETE FROM ingest_worker_samples WHERE sampled_at < now() - interval '30 days'"
            )
            cur.execute(
                "DELETE FROM ingest_worker_sample_rollups WHERE bucket < now() - interval '1 year'"
            )
        conn.commit()


def try_source_artifact_lock(identity: str):
    """Return a pooled connection holding one session advisory lock.

    Derived source text is expensive and globally reusable. Two identical
    uploads may reach different workers before either has written its cache
    object; this lock makes one producer win while the other waits and then
    reads the finished artifact. The caller must pass the returned connection
    to :func:`release_source_artifact_lock`.
    """
    conn = pool().getconn()
    try:
        row = conn.execute(
            "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))", (identity,)
        ).fetchone()
        conn.commit()
        if row and bool(row[0]):
            return conn
    except BaseException:
        pool().putconn(conn)
        raise
    pool().putconn(conn)
    return None


async def try_source_artifact_lock_async(identity: str):
    """Acquire in a thread and return any late lock before cancellation exits."""
    operation = asyncio.create_task(
        asyncio.to_thread(try_source_artifact_lock, identity)
    )
    try:
        return await asyncio.shield(operation)
    except asyncio.CancelledError:
        while not operation.done():
            try:
                await asyncio.shield(operation)
            except asyncio.CancelledError:
                continue
        connection = operation.result()
        if connection is not None:
            release = asyncio.create_task(
                asyncio.to_thread(release_source_artifact_lock, connection, identity)
            )
            while not release.done():
                try:
                    await asyncio.shield(release)
                except asyncio.CancelledError:
                    continue
            try:
                release.result()
            except Exception:
                log.exception(
                    "could not release source artifact lock after cancellation"
                )
        raise


def release_source_artifact_lock(conn, identity: str) -> None:
    """Release a lock acquired by :func:`try_source_artifact_lock`."""
    try:
        conn.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (identity,))
        conn.commit()
    finally:
        pool().putconn(conn)


def uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


# ---------------------------------------------------------------- job queue


def claim_job(cur, job_type: str, lease_s: int) -> dict[str, Any] | None:
    """Claim one due pending job of exactly ``job_type`` atomically."""
    cur.execute(
        """
        UPDATE jobs SET
            status='running',
            locked_at=now(),
            updated_at=now(),
            attempts=attempts+1,
            lease_expires_at = now() + make_interval(secs => %s)
        WHERE id = (
            SELECT id FROM jobs
            WHERE status='pending'
              AND type=%s
              AND (not_before IS NULL OR not_before <= now())
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, type, payload, attempts, queued_at, provider_waits
        """,
        (lease_s, job_type),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "type": row[1],
        "payload": row[2],
        "attempts": row[3],
        "queued_at": row[4],
        "provider_waits": row[5],
    }


def start_job_attempt(
    cur,
    *,
    job: dict[str, Any],
    trace_id: str,
    environment: str,
    host_id: str,
    worker_instance_id: str,
    release_sha: str,
) -> int:
    payload = job.get("payload") or {}
    plan = payload.get("processingPlan") or {}
    queued_at = job.get("queued_at")
    cur.execute(
        """
        INSERT INTO ingest_job_attempts
          (job_id, operation_id, attempt, job_type, environment, host_id,
           worker_instance_id, release_sha, trace_id, route, source_format,
           queued_at, queue_milliseconds)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                GREATEST(0, round(extract(epoch FROM (now() - %s)) * 1000)))
        RETURNING id
        """,
        (
            job["id"],
            str(payload.get("reservationId") or job["id"]),
            int(job.get("attempts") or 1),
            str(job.get("type") or ""),
            environment,
            host_id,
            worker_instance_id,
            release_sha,
            trace_id,
            str(plan.get("route") or ""),
            str(plan.get("format") or ""),
            queued_at,
            queued_at,
        ),
    )
    row = cur.fetchone()
    if row is None:
        raise RuntimeError("job attempt could not be created")
    return int(row[0])


def enqueue_job(cur, job_id: str, job_type: str, payload: dict[str, Any]) -> None:
    cur.execute(
        "INSERT INTO jobs (id, type, payload) VALUES (%s, %s, %s)",
        (job_id, job_type, Jsonb(payload)),
    )


def set_job(cur, job_id: str, status: str, error: str | None = None) -> None:
    cur.execute(
        "UPDATE jobs SET status=%s, error=%s, updated_at=now(), lease_expires_at=NULL WHERE id=%s",
        (status, error, job_id),
    )


def finish_job_attempt(
    cur,
    *,
    attempt_id: int | None,
    outcome: str,
    snapshot: dict[str, Any] | None = None,
    error_category: str = "",
    error_code: str = "",
    error_detail: str = "",
    retryable: bool = False,
    next_retry_at: Any = None,
) -> None:
    if not attempt_id:
        return
    values = snapshot or {}
    stats = values.get("stats") if isinstance(values.get("stats"), dict) else {}
    timings = (
        values.get("stage_timings")
        if isinstance(values.get("stage_timings"), dict)
        else {}
    )
    typed = {
        "source_bytes": max(0, int(stats.get("source_bytes") or 0)),
        "artifact_bytes": max(0, int(stats.get("artifact_bytes") or 0)),
        "figures_selected": max(0, int(stats.get("figures_selected") or 0)),
        "figures_cached": max(0, int(stats.get("figures_cached") or 0)),
        "figures_captioned": max(0, int(stats.get("figures_captioned") or 0)),
        "figures_decorative": max(0, int(stats.get("figures_decorative") or 0)),
        "figures_applied": max(0, int(stats.get("figures_applied") or 0)),
        "figures_failed": max(0, int(stats.get("figures_failed") or 0)),
        "chunks_created": max(0, int(stats.get("chunks_created") or 0)),
        "donor_reused": bool(stats.get("donor_reused") or False),
    }
    details = {
        key: value
        for key, value in stats.items()
        if key not in typed and isinstance(value, (bool, int, str))
    }
    cur.execute(
        """
        UPDATE ingest_job_attempts SET
          status=%s, stage=%s, error_category=%s, error_code=%s,
          error_detail=%s, retryable=%s, next_retry_at=%s,
          finished_at=now(),
          duration_milliseconds=GREATEST(
            0, round(extract(epoch FROM (now() - claimed_at)) * 1000)
          ),
          source_bytes=%s, artifact_bytes=%s,
          figures_selected=%s, figures_cached=%s, figures_captioned=%s,
          figures_decorative=%s, figures_applied=%s, figures_failed=%s,
          chunks_created=%s, donor_reused=%s,
          stage_timings=%s, details=%s
        WHERE id=%s AND status='running'
        """,
        (
            outcome,
            str(values.get("stage") or "")[:80],
            error_category[:80],
            error_code[:80],
            error_detail[:160],
            retryable,
            next_retry_at,
            typed["source_bytes"],
            typed["artifact_bytes"],
            typed["figures_selected"],
            typed["figures_cached"],
            typed["figures_captioned"],
            typed["figures_decorative"],
            typed["figures_applied"],
            typed["figures_failed"],
            typed["chunks_created"],
            typed["donor_reused"],
            Jsonb(timings),
            Jsonb(details),
            attempt_id,
        ),
    )


def record_job_parse_metrics(
    cur,
    *,
    attempt_id: int | None,
    pages: int,
    ocr_pages: int,
    slices: int,
    queue_milliseconds: int,
    execution_milliseconds: int,
) -> None:
    if not attempt_id:
        return
    cur.execute(
        """
        UPDATE ingest_job_attempts SET
          parse_pages=%s, parse_ocr_pages=%s, parse_slices=%s,
          parser_queue_milliseconds=%s,
          parser_execution_milliseconds=%s
        WHERE id=%s
        """,
        (
            max(0, pages),
            min(max(0, pages), max(0, ocr_pages)),
            max(0, slices),
            max(0, queue_milliseconds),
            max(0, execution_milliseconds),
            attempt_id,
        ),
    )


def claim_is_current(cur, job_id: str, attempt: int) -> bool:
    """True while the caller still holds the claim it took.

    ``asyncio.wait_for`` is cooperative and a heartbeat can fail on a database
    blip, so a worker whose lease expired may still be running: the reaper has
    already re-pended the row and another worker may hold it. Writing the
    outcome of an abandoned run would then overwrite the successor's state.

    ``attempts`` is the fencing token because ``claim_job`` is the only writer
    of it — neither ``requeue_job`` nor the reaper touches it — so the value
    returned by a claim names that attempt for as long as it is live. The row
    is locked so the reaper (``FOR UPDATE SKIP LOCKED``) leaves it alone while
    the caller finishes writing.
    """
    cur.execute(
        """
        SELECT 1 FROM jobs
        WHERE id=%s AND status='running' AND attempts=%s
          AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
        FOR UPDATE
        """,
        (job_id, attempt),
    )
    return cur.fetchone() is not None


def _pipeline_source_cancellation(
    cur,
    payload: dict[str, Any],
    *,
    file_lock: str,
) -> tuple[str, str, str, str] | None:
    """Lock and recheck one pipeline source without opposing Go's lock order.

    Go workspace mutations lock workspace, ordered account rows, membership,
    then file. Pipeline heartbeats, provider admission, and final writes use the
    same order. The job row comes afterward; provider admission then locks its
    exact attempt. This prevents lifecycle deletion/replacement from forming a
    file-to-user or job-to-workspace cycle with a worker.
    """
    payload = source_boundary_payload(payload)
    if payload.get("sourceRefresh") is True:
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
            (str(payload.get("fileId") or ""),),
        )
    if file_lock not in {"SHARE", "UPDATE"}:
        raise ValueError("invalid pipeline file lock")
    file_id = str(payload.get("fileId") or "")
    workspace_id = str(payload.get("workspaceId") or "")
    try:
        source_revision = int(payload["sourceRevision"])
    except (KeyError, TypeError, ValueError):
        return (
            "superseded",
            "superseded",
            "source_superseded",
            "ingest source identity is invalid",
        )
    source_etag = str(payload.get("sourceETag") or "")
    if not file_id or not workspace_id:
        return (
            "failed",
            "lifecycle",
            "source_deleted",
            "ingest source identity is invalid",
        )

    # The workspace row is the common first lock for Go and Python. It also
    # freezes ownership while we derive the storage owner and actor checks.
    cur.execute(
        """
        SELECT user_id FROM workspaces WHERE id=%s
        FOR SHARE
        """,
        (workspace_id,),
    )
    workspace = cur.fetchone()
    if workspace is None:
        return ("failed", "lifecycle", "source_deleted", "source deleted")
    owner_user_id = str(workspace[0] or "")
    actor_user_id = str(payload.get("actorUserId") or "")
    expected_user_ids = {str(owner_user_id or ""), actor_user_id}
    if "" in expected_user_ids:
        return (
            "failed",
            "lifecycle",
            "account_deletion",
            "ingest account no longer exists",
        )
    cur.execute(
        """
        SELECT id, deleted_at, suspended_at, deletion_requested_at
        FROM users
        WHERE id = ANY(%s)
        ORDER BY id
        FOR SHARE
        """,
        (list(expected_user_ids),),
    )
    accounts = cur.fetchall()
    if {str(row[0]) for row in accounts} != expected_user_ids:
        return (
            "failed",
            "lifecycle",
            "account_deletion",
            "ingest account no longer exists",
        )
    if any(row[1] is not None or row[3] is not None for row in accounts):
        return (
            "failed",
            "lifecycle",
            "account_deletion",
            "account deletion requested",
        )
    if any(row[2] is not None for row in accounts):
        return (
            "failed",
            "lifecycle",
            "account_suspended",
            "account suspended",
        )

    if actor_user_id != owner_user_id:
        cur.execute(
            """
            SELECT role FROM workspace_members
            WHERE workspace_id=%s AND user_id=%s
            FOR SHARE
            """,
            (workspace_id, actor_user_id),
        )
        membership = cur.fetchone()
        shared_editor = False
        if payload.get("sourceRefresh") is True:
            cur.execute(
                "SELECT privacy IN ('link','public') AND share_role='editor' FROM workspaces WHERE id=%s",
                (workspace_id,),
            )
            shared_editor = bool(cur.fetchone()[0])
        if not shared_editor and (membership is None or str(membership[0]) != "editor"):
            return (
                "failed",
                "authorization",
                "workspace_access_revoked",
                "workspace editor access was revoked",
            )

    cur.execute(
        f"""
        SELECT workspace_id, user_id, revision, COALESCE(source_etag, '')
        FROM files WHERE id=%s
        FOR {file_lock}
        """,
        (file_id,),
    )
    source = cur.fetchone()
    if source is None:
        return ("failed", "lifecycle", "source_deleted", "source deleted")
    source_workspace, source_owner, current_revision, current_etag = source
    if (
        str(source_workspace or "") != workspace_id
        or str(source_owner or "") != owner_user_id
    ):
        return ("failed", "lifecycle", "source_deleted", "source moved")
    if payload.get("sourceRefresh") is True:
        if payload.get("sourcePublishedCheckpoint") == payload.get("sourceCheckpoint"):
            return None
        cur.execute(
            """SELECT 1 FROM source_refresh_candidates c
            JOIN source_documents d ON d.file_id=c.file_id JOIN jobs j ON j.id=c.job_id
            WHERE c.file_id=%s AND c.epoch=%s AND c.checkpoint=%s AND c.lease_token=%s
              AND d.epoch=c.epoch AND d.base_revision=%s AND d.running_job_id=c.job_id
              AND j.payload->>'sourceETag'=%s
              AND (d.format='text' OR d.checkpoint=c.checkpoint)
            FOR UPDATE OF c,d""",
            (
                file_id,
                payload.get("sourceEpoch"),
                payload.get("sourceCheckpoint"),
                payload.get("sourceLeaseToken"),
                source_revision,
                source_etag,
            ),
        )
        if int(current_revision) == source_revision and cur.fetchone() is not None:
            return None
        return (
            "superseded",
            "superseded",
            "source_superseded",
            "source checkpoint was superseded",
        )
    if int(current_revision) != source_revision or str(current_etag) != source_etag:
        return (
            "superseded",
            "superseded",
            "source_superseded",
            "superseded by file replacement",
        )
    return None


def _cancel_pipeline_heartbeat_claim(
    cur,
    job_id: str,
    payload: dict[str, Any],
    cancellation: tuple[str, str, str, str],
) -> None:
    outcome, category, code, detail = cancellation
    cur.execute(
        "SELECT cancel_pipeline_jobs(ARRAY[%s]::text[], %s, %s, %s, %s)",
        (job_id, outcome, category, code, detail),
    )
    cur.fetchone()
    # Account deletion normally removes these rows in cancel_user_async_work.
    # A lifecycle transaction that skipped this locked job could not do so.
    cur.execute(
        "DELETE FROM rag_contents WHERE claim_job_id=%s AND status='processing'",
        (job_id,),
    )
    fail_pipeline_file_if_current(cur, payload)


def fail_pipeline_file_if_current(cur, payload: dict[str, Any]) -> bool:
    """Fail only the file revision named by a cancelled pipeline claim."""
    if payload.get("sourceRefresh") is True:
        return False
    file_id = str(payload.get("fileId") or "")
    source_etag = str(payload.get("sourceETag") or "")
    try:
        source_revision = int(payload.get("sourceRevision"))
    except (TypeError, ValueError):
        return False
    if not file_id:
        return False
    cur.execute(
        """
        UPDATE files
        SET status='failed', indexed=false, preview_blob_path=NULL
        WHERE id=%s AND revision=%s AND COALESCE(source_etag, '')=%s
          AND status IN ('pending','processing')
        """,
        (file_id, source_revision, source_etag),
    )
    return bool(cur.rowcount)


def heartbeat_job(cur, job_id: str, lease_s: int, attempt: int) -> bool:
    """Renew a claim only while its exact source and accounts remain current."""
    cur.execute(
        """
        SELECT type, payload FROM jobs
        WHERE id=%s AND status='running' AND attempts=%s
          AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
        """,
        (job_id, attempt),
    )
    claim = cur.fetchone()
    if claim is None:
        return False
    job_type, payload = claim
    cancellation = None
    if job_type in {"parse", "ingest"}:
        cancellation = _pipeline_source_cancellation(
            cur,
            payload if isinstance(payload, dict) else {},
            file_lock="UPDATE",
        )

    # Job comes last. Re-read the claim under its lock because the lease reaper
    # may have moved it while we waited at a workspace or file boundary.
    cur.execute(
        """
        SELECT type, payload FROM jobs
        WHERE id=%s AND status='running' AND attempts=%s
          AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
        FOR UPDATE
        """,
        (job_id, attempt),
    )
    locked_claim = cur.fetchone()
    if locked_claim is None:
        return False
    locked_type, locked_payload = locked_claim
    if locked_type != job_type or locked_payload != payload:
        return False
    if cancellation is not None:
        _cancel_pipeline_heartbeat_claim(cur, job_id, payload, cancellation)
        return False

    cur.execute(
        """
        UPDATE jobs
        SET locked_at=now(),
            lease_expires_at=now() + make_interval(secs => %s),
            updated_at=now()
        WHERE id=%s AND status='running' AND attempts=%s
          AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
        """,
        (lease_s, job_id, attempt),
    )
    if not cur.rowcount:
        return False
    # Keep this job's own processing claim fresh so a waiter does not steal a
    # live ingest. Only the creator may refresh it: a waiter attaches its file
    # to the creator's content row, so refreshing by file would let a waiter
    # keep a dead creator's claim alive and defeat the steal below.
    cur.execute(
        """
        UPDATE rag_contents
        SET updated_at = now()
        WHERE claim_job_id = %s AND status = 'processing'
        """,
        (job_id,),
    )
    return True


def lock_pipeline_claim_boundary(
    cur,
    *,
    job_id: str,
    attempt: int,
    payload: dict[str, Any],
    file_lock: str = "UPDATE",
) -> str:
    """Lock source access first, then fence the exact job attempt.

    Returns ``current``, ``lost``, or ``cancelled``. The caller must commit a
    cancelled result so the terminal job/session transition remains durable.
    """
    payload = source_boundary_payload(payload)
    cancellation = _pipeline_source_cancellation(cur, payload, file_lock=file_lock)
    cur.execute(
        """
        SELECT type, payload FROM jobs
        WHERE id=%s AND status='running' AND attempts=%s
          AND lease_expires_at IS NOT NULL AND lease_expires_at > now()
        FOR UPDATE
        """,
        (job_id, attempt),
    )
    claim = cur.fetchone()
    if claim is None:
        return "lost"
    job_type, locked_payload = claim
    locked_payload = locked_payload if isinstance(locked_payload, dict) else {}
    identity_keys = (
        "actorUserId",
        "fileId",
        "reservationId",
        "sourceETag",
        "sourceRevision",
        "workspaceId",
        "sourceRefresh",
        "sourceEpoch",
        "sourceCheckpoint",
        "sourceLeaseToken",
    )
    identity_changed = any(
        str(locked_payload.get(key) or "") != str(payload.get(key) or "")
        for key in identity_keys
    )
    if job_type not in {"parse", "ingest"} or identity_changed:
        return "lost"
    if cancellation is not None:
        _cancel_pipeline_heartbeat_claim(cur, job_id, locked_payload, cancellation)
        return "cancelled"
    return "current"


def requeue_job(
    cur,
    *,
    job_id: str,
    job_type: str,
    workspace_id: str | None,
    error: str,
    backoff_s: int,
) -> str:
    """Return 'pending' after a retryable error. ``job_type`` and
    ``workspace_id`` are kept so callers do not have to special-case ingest."""
    del job_type, workspace_id
    cur.execute(
        """
        UPDATE jobs SET
            status='pending',
            error=%s,
            not_before=now() + make_interval(secs => %s),
            lease_expires_at=NULL,
            queued_at=now(),
            updated_at=now()
        WHERE id=%s
        """,
        (error[:500], backoff_s, job_id),
    )
    return "pending"


def release_job_for_capacity(cur, job_id: str, attempt: int, *, backoff_s: int) -> None:
    """Put a running job back to pending without spending an attempt.

    Used when every parser slot is taken. ``claim_job`` already incremented
    ``attempts``; undoing that is what keeps a long queue from looking like
    repeated failures.
    """
    cur.execute(
        """
        UPDATE jobs SET
            status='pending',
            attempts=GREATEST(attempts-1, 0),
            error=NULL,
            not_before=now() + make_interval(secs => %s),
            lease_expires_at=NULL,
            queued_at=now(),
            updated_at=now()
        WHERE id=%s AND status='running' AND attempts=%s
        """,
        (backoff_s, job_id, attempt),
    )


def release_job_for_provider_busy(
    cur, job_id: str, attempt: int, *, backoff_s: int
) -> None:
    """Re-pend a job whose provider stayed busy past the in-call budget.

    Like ``release_job_for_capacity`` the attempt is handed back; the re-pend is
    counted on ``provider_waits`` so the worker can cap it. ``created_at`` is
    untouched, so the claim order puts the job ahead of anything newer once
    ``not_before`` passes.
    """
    cur.execute(
        """
        UPDATE jobs SET
            status='pending',
            attempts=GREATEST(attempts-1, 0),
            provider_waits=provider_waits+1,
            error=NULL,
            not_before=now() + make_interval(secs => %s),
            lease_expires_at=NULL,
            queued_at=now(),
            updated_at=now()
        WHERE id=%s AND status='running' AND attempts=%s
        """,
        (backoff_s, job_id, attempt),
    )


def set_job_local_source(
    cur, *, job_id: str, attempt: int, source_key: str, source_sha256: str
) -> bool:
    """Persist the shared-spool source so a requeued claim does not fetch B2 again."""
    cur.execute(
        """
        UPDATE jobs
        SET payload=jsonb_set(
                payload,
                '{localSource}',
                jsonb_build_object('key', %s::text, 'sha256', %s::text),
                true
            ),
            updated_at=now()
        WHERE id=%s AND status='running' AND attempts=%s
        """,
        (source_key, source_sha256, job_id, attempt),
    )
    return bool(cur.rowcount)


def active_local_spool_keys(cur) -> set[str]:
    """Return local source/artifact keys still referenced by queued work."""
    cur.execute(
        """
        SELECT key FROM (
          SELECT payload#>>'{localSource,key}' AS key
          FROM jobs WHERE status IN ('pending','running')
          UNION
          SELECT payload#>>'{parseArtifact,key}' AS key
          FROM jobs WHERE status IN ('pending','running')
          UNION
          SELECT f.parsed_blob_path AS key
          FROM jobs j JOIN files f ON f.id=j.payload->>'fileId'
          WHERE j.status IN ('pending','running')
        ) active
        WHERE key IS NOT NULL AND key <> ''
        """
    )
    return {str(row[0]) for row in cur.fetchall()}


# ------------------------------------------------ provider capacity leases


def acquire_provider_capacity(
    cur,
    *,
    lease_id: str,
    provider: str,
    units: int,
    capacity: int,
    lease_seconds: int,
) -> bool:
    """Atomically reserve weighted capacity across every ingest process."""
    cur.execute(
        "SELECT pg_advisory_xact_lock(hashtext(%s))",
        (f"provider-capacity:{provider}",),
    )
    cur.execute(
        "DELETE FROM provider_capacity_leases WHERE provider=%s AND expires_at<=now()",
        (provider,),
    )
    cur.execute(
        "SELECT COALESCE(SUM(units),0) FROM provider_capacity_leases WHERE provider=%s",
        (provider,),
    )
    used = int(cur.fetchone()[0])
    if used + units > capacity:
        return False
    cur.execute(
        """
        INSERT INTO provider_capacity_leases (id,provider,units,expires_at)
        VALUES (%s,%s,%s,now()+make_interval(secs => %s))
        """,
        (lease_id, provider, units, lease_seconds),
    )
    return True


def provider_capacity_used(cur, provider: str) -> int:
    """Unexpired units for one key, read without the advisory lock."""
    cur.execute(
        "SELECT COALESCE(SUM(units),0) FROM provider_capacity_leases "
        "WHERE provider=%s AND expires_at>now()",
        (provider,),
    )
    return int(cur.fetchone()[0])


def release_provider_capacity(cur, lease_id: str) -> None:
    cur.execute("DELETE FROM provider_capacity_leases WHERE id=%s", (lease_id,))


def renew_provider_capacity(cur, lease_id: str, lease_seconds: int) -> bool:
    """Extend a live capacity lease without reviving an expired one."""
    cur.execute(
        """
        UPDATE provider_capacity_leases
        SET expires_at=now()+make_interval(secs => %s)
        WHERE id=%s AND expires_at>now()
        """,
        (lease_seconds, lease_id),
    )
    return bool(cur.rowcount)


def reclaim_expired_leases(
    cur, *, max_attempts: dict[str, int], backoff_base_s: dict[str, int]
) -> list[dict[str, Any]]:
    """Turn stale running rows back into pending (or failed) jobs.

    A dead worker never finishes; lease_expires_at is the only signal.
    """
    cur.execute(
        """
        SELECT id, type, payload, attempts, error
        FROM jobs
        WHERE status='running' AND lease_expires_at IS NOT NULL
          AND type IN ('import','parse','ingest') AND lease_expires_at < now()
        """
    )
    candidates = cur.fetchall()
    reclaimed: list[dict[str, Any]] = []
    for job_id, job_type, payload, attempts, error in candidates:
        payload = payload or {}
        cap = max_attempts.get(job_type)
        terminal_pipeline = job_type in {"parse", "ingest"} and (
            cap is None or attempts >= cap
        )
        if terminal_pipeline:
            # Replacement and lifecycle cancellation lock the source boundary
            # before the job. Follow that order before the terminal transaction
            # updates the exact file revision and closes its reservation.
            _pipeline_source_cancellation(cur, payload, file_lock="UPDATE")
        cur.execute(
            """
            SELECT id, type, payload, attempts, error
            FROM jobs
            WHERE id=%s AND status='running'
              AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
            FOR UPDATE SKIP LOCKED
            """,
            (job_id,),
        )
        locked = cur.fetchone()
        if locked is None:
            continue
        job_id, job_type, payload, attempts, error = locked
        payload = payload or {}
        if payload.get("sourceRefresh") is True and payload.get(
            "sourcePublishedCheckpoint"
        ) == payload.get("sourceCheckpoint"):
            set_job(cur, job_id, "done")
            settle_credit_reservation(cur, str(payload.get("reservationId") or ""))
            cur.execute(
                "UPDATE ingest_job_attempts SET status='succeeded',finished_at=now() WHERE job_id=%s AND status='running'",
                (job_id,),
            )
            reclaimed.append(
                {
                    "id": job_id,
                    "type": job_type,
                    "payload": payload,
                    "attempts": attempts,
                    "outcome": "done",
                    "file_failed": False,
                }
            )
            continue
        if job_type in {"parse", "ingest"}:
            # The dead worker never ran abandon_content. Drop the claim it
            # created so a waiter (or this job's retry) can recreate it. Keyed
            # on the owning job, not on the file: a dead waiter's file points at
            # the creator's row, and deleting that would cascade a live ingest's
            # chunks away while it is still writing them.
            cur.execute(
                "DELETE FROM rag_contents WHERE claim_job_id = %s AND status = 'processing'",
                (job_id,),
            )
        cap = max_attempts.get(job_type)
        note = (error or "lease expired").strip() or "lease expired"
        if "lease expired" not in note:
            note = f"{note}; lease expired"
        outcome = "failed"
        retryable = False
        if not job_type or cap is None:
            set_job(cur, job_id, "failed", f"unknown job type {job_type!r}"[:500])
        elif attempts >= cap:
            set_job(cur, job_id, "failed", note[:500])
        else:
            base = int(backoff_base_s[job_type])
            outcome = requeue_job(
                cur,
                job_id=job_id,
                job_type=job_type,
                workspace_id=payload.get("workspaceId"),
                error=note,
                backoff_s=base * (2 ** max(int(attempts) - 1, 0)),
            )
            retryable = True
        file_failed = False
        if outcome == "failed" and job_type in {"parse", "ingest"}:
            file_failed = fail_pipeline_file_if_current(cur, payload)
            discard_source_candidate(cur, payload, job_id, note, stale=False)
            close_credit_reservation(cur, str(payload.get("reservationId") or ""))
        cur.execute(
            """
            UPDATE ingest_job_attempts SET
              status='lease_expired', stage=COALESCE(NULLIF(stage, ''), 'unknown'),
              error_category='worker', error_code='lease_expired',
              error_detail='worker lease expired', retryable=%s,
              next_retry_at=(SELECT not_before FROM jobs WHERE id=%s),
              finished_at=now(),
              duration_milliseconds=GREATEST(
                0, round(extract(epoch FROM (now() - claimed_at)) * 1000)
              )
            WHERE id = (
              SELECT id FROM ingest_job_attempts
              WHERE job_id=%s AND attempt=%s AND status='running'
              ORDER BY claimed_at DESC LIMIT 1
            )
            """,
            (retryable, job_id, job_id, attempts),
        )
        reclaimed.append(
            {
                "id": job_id,
                "type": job_type,
                "payload": payload,
                "attempts": attempts,
                "outcome": outcome,
                "file_failed": file_failed,
            }
        )
    return reclaimed


def set_file_status(cur, file_id: str, status: str) -> None:
    if source_refresh_for(file_id) is not None:
        return
    cur.execute("UPDATE files SET status=%s WHERE id=%s", (status, file_id))


def set_file_indexed(cur, file_id: str, indexed: bool) -> None:
    if source_refresh_for(file_id) is not None:
        return
    cur.execute("UPDATE files SET indexed=%s WHERE id=%s", (indexed, file_id))


def set_file_content_hash(cur, file_id: str, content_hash: str) -> None:
    """Record the hash of the parsed text, used to skip duplicate indexing."""
    if stage_source_candidate(cur, file_id, {"content_hash": content_hash}):
        return
    cur.execute("UPDATE files SET content_hash=%s WHERE id=%s", (content_hash, file_id))


def set_file_parse_artifact(
    cur,
    file_id: str,
    blob_path: str,
    fingerprint: str,
    parser_version: str,
) -> None:
    if stage_source_candidate(
        cur,
        file_id,
        {
            "parse_artifact_key": blob_path,
            "parse_artifact_fingerprint": fingerprint,
            "parse_artifact_version": parser_version,
        },
    ):
        return
    cur.execute(
        """UPDATE files
        SET parsed_blob_path=%s, parsed_fingerprint=%s, parsed_parser_version=%s
        WHERE id=%s""",
        (blob_path, fingerprint, parser_version, file_id),
    )


def clear_file_parse_artifact(cur, file_id: str) -> None:
    if stage_source_candidate(
        cur,
        file_id,
        {
            "parse_artifact_key": None,
            "parse_artifact_fingerprint": None,
            "parse_artifact_version": None,
        },
    ):
        return
    cur.execute(
        """UPDATE files
        SET parsed_blob_path=NULL, parsed_fingerprint=NULL, parsed_parser_version=NULL
        WHERE id=%s""",
        (file_id,),
    )


def set_file_caption_blob(cur, file_id: str, blob_path: str) -> None:
    if source_refresh_for(file_id) is not None:
        return
    cur.execute(
        "UPDATE files SET caption_blob_path=%s WHERE id=%s",
        (blob_path, file_id),
    )


def set_file_preview_blob(cur, file_id: str, blob_path: str | None) -> None:
    if stage_source_candidate(cur, file_id, {"preview_blob_path": blob_path}):
        return
    cur.execute(
        "UPDATE files SET preview_blob_path=%s WHERE id=%s",
        (blob_path, file_id),
    )


def require_current_file_source(
    cur,
    file_id: str,
    source_revision: int,
    source_etag: str = "",
) -> None:
    """Lock and fence a file mutation to the source version that queued it.

    Replacement keeps the logical file id but increments ``revision`` and
    changes ``source_etag``. Without this lock/check, an older worker can write
    its parse outcome into the replacement after the replacement transaction
    has cleared the old association.
    """
    refresh = source_refresh_for(file_id)
    if refresh is not None:
        if (
            int(refresh["sourceRevision"]) != int(source_revision)
            or str(refresh.get("sourceETag") or "") != source_etag
        ):
            raise SourceSupersededError("source candidate identity changed")
        if _pipeline_source_cancellation(cur, refresh, file_lock="UPDATE") is not None:
            raise SourceSupersededError("source candidate was superseded")
        if not claim_is_current(cur, refresh["_jobId"], refresh["_attempt"]):
            raise SourceSupersededError("source candidate lost its attempt lease")
        return
    cur.execute(
        "SELECT revision, COALESCE(source_etag, '') FROM files WHERE id=%s FOR UPDATE",
        (file_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise SourceSupersededError("ingest source no longer exists")
    revision, current_etag = int(row[0]), str(row[1] or "")
    if revision != int(source_revision) or current_etag != source_etag:
        raise SourceSupersededError("ingest source was superseded by a newer revision")


def add_notification(
    cur,
    file_id: str,
    kind: str,
    data: dict[str, Any],
) -> dict[str, Any] | None:
    cur.execute("SELECT user_id, workspace_id FROM files WHERE id=%s", (file_id,))
    owner = cur.fetchone()
    if not owner:
        return None
    user_id, workspace_id = owner
    notification_id = uid("nt")
    href = f"/workspaces/{workspace_id}?file={file_id}"
    cur.execute(
        """INSERT INTO notifications
            (id, user_id, kind, data, href, workspace_id)
        VALUES (%s,%s,%s,%s,%s,%s)
        RETURNING id, at""",
        (
            notification_id,
            user_id,
            kind,
            Jsonb(data),
            href,
            workspace_id,
        ),
    )
    row = cur.fetchone()
    return {
        "at": row[1].isoformat(),
        "data": data,
        "href": href,
        "id": row[0],
        "kind": kind,
        "userId": user_id,
    }


def add_workspace_notification(
    cur,
    *,
    user_id: str,
    workspace_id: str,
    kind: str,
    data: dict[str, Any],
) -> dict[str, Any] | None:
    """Notify a user about workspace-level work that is not tied to a file."""
    if not user_id:
        return None
    notification_id = uid("nt")
    href = f"/workspaces/{workspace_id}"
    cur.execute(
        """INSERT INTO notifications
            (id, user_id, kind, data, href, workspace_id)
        VALUES (%s,%s,%s,%s,%s,%s)
        RETURNING id, at""",
        (notification_id, user_id, kind, Jsonb(data), href, workspace_id),
    )
    row = cur.fetchone()
    return {
        "at": row[1].isoformat(),
        "data": data,
        "href": href,
        "id": row[0],
        "kind": kind,
        "userId": user_id,
    }


def upsert_artifact_cache(
    cur,
    *,
    object_path: str,
    kind: str,
    source_sha256: str,
    size_bytes: int = 0,
) -> None:
    if not object_path or not source_sha256:
        return
    cur.execute(
        """
        INSERT INTO artifact_cache
            (object_path, kind, source_sha256, size_bytes, created_at, last_used_at)
        VALUES (%s, %s, %s, %s, now(), now())
        ON CONFLICT (object_path) DO UPDATE SET
            kind = EXCLUDED.kind,
            source_sha256 = EXCLUDED.source_sha256,
            size_bytes = CASE
                WHEN EXCLUDED.size_bytes > 0 THEN EXCLUDED.size_bytes
                ELSE artifact_cache.size_bytes
            END,
            last_used_at = now()
        """,
        (object_path, kind, source_sha256, size_bytes),
    )


def touch_artifact_cache(cur, object_path: str) -> None:
    if not object_path:
        return
    cur.execute(
        "UPDATE artifact_cache SET last_used_at=now() WHERE object_path=%s",
        (object_path,),
    )


def drop_artifact_cache(cur, object_path: str) -> None:
    if not object_path:
        return
    cur.execute("DELETE FROM artifact_cache WHERE object_path=%s", (object_path,))


def sweep_artifact_cache(cur, *, caption_ttl_days: int) -> int:
    """Delete cold cache rows that no in-flight ingest still needs.

    Routed through the artifact_cache trigger into pending_blob_deletions.
    """
    cur.execute(
        """
        DELETE FROM artifact_cache a
        WHERE (
                (a.kind = 'captions'
                 AND a.last_used_at < now() - make_interval(days => %s))
             OR (a.kind = 'office_preview'
                 AND a.last_used_at < now() - make_interval(days => %s))
             OR (a.kind = 'derived_text'
                 AND a.last_used_at < now() - make_interval(days => %s))
             OR (a.kind = 'parse_bundle'
                 AND a.last_used_at < now() - make_interval(days => %s))
            )
          AND NOT EXISTS (
              SELECT 1
              FROM jobs j
              JOIN files f ON f.id = j.payload->>'fileId'
              WHERE j.status IN ('pending', 'running')
                AND f.source_sha256 = a.source_sha256
          )
        """,
        (
            caption_ttl_days,
            caption_ttl_days,
            caption_ttl_days,
            caption_ttl_days,
        ),
    )
    return cur.rowcount or 0


def file_name(cur, file_id: str) -> str:
    cur.execute("SELECT name FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return row[0] if row else file_id


def file_exists(cur, file_id: str) -> bool:
    cur.execute("SELECT 1 FROM files WHERE id=%s", (file_id,))
    return cur.fetchone() is not None


def set_file_source_sha256(cur, file_id: str, source_sha256: str) -> None:
    if stage_source_candidate(cur, file_id, {"source_sha256": source_sha256}):
        return
    cur.execute(
        "UPDATE files SET source_sha256=%s WHERE id=%s", (source_sha256, file_id)
    )


def file_source_sha256(cur, file_id: str) -> str:
    cur.execute("SELECT source_sha256 FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return str(row[0] or "") if row else ""


def file_owner_user_id(cur, file_id: str) -> str | None:
    cur.execute("SELECT user_id FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return row[0] if row else None


def workspace_owner_user_id(cur, workspace_id: str) -> str | None:
    cur.execute("SELECT user_id FROM workspaces WHERE id=%s", (workspace_id,))
    row = cur.fetchone()
    return row[0] if row else None


def credits_for_parse_pages(
    pages: int, ocr_pages: int, *, digital_rate: int, ocr_rate: int
) -> int:
    pages = max(0, int(pages))
    ocr_pages = min(pages, max(0, int(ocr_pages)))
    return (pages - ocr_pages) * int(digital_rate) + ocr_pages * int(ocr_rate)


def record_usage_event(
    cur,
    *,
    actor_user_id: str,
    workspace_id: str | None,
    kind: str,
    surface: str,
    provider: str = "",
    model: str = "",
    catalog_provider_slug: str = "",
    catalog_model_slug: str = "",
    model_version: int = 0,
    input_tokens: int = 0,
    output_tokens: int = 0,
    units: int = 0,
    unit: str = "",
    parse_pages: int = 0,
    parse_ocr_pages: int = 0,
    parse_cpu_milliseconds: int = 0,
    parse_elapsed_milliseconds: int = 0,
    parse_queue_milliseconds: int = 0,
    parse_download_milliseconds: int = 0,
    parse_upload_milliseconds: int = 0,
    parse_worker_rss_bytes: int = 0,
    parse_worker_pss_bytes: int = 0,
    parse_io_read_bytes: int = 0,
    parse_io_write_bytes: int = 0,
    credit_micros: int = 0,
    reservation_id: str = "",
    provider_call_id: str = "",
    idempotency_key: str = "",
    trace_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> bool:
    """Append one metered consumption and charge it to the actor's counter.

    Ingest is leased at enqueue. Provider calls use this helper as they settle;
    parse pages use it when each job attempt closes. A measured charge can push a
    user past their limit; the next interactive request is what refuses.
    """
    if not actor_user_id or credit_micros < 0:
        return False
    cur.execute(
        """
        INSERT INTO usage_events
            (trace_id, actor_user_id, workspace_id, kind, surface, provider, model,
             catalog_provider_slug, catalog_model_slug, model_version,
             input_tokens, output_tokens, units, unit, parse_pages,
             parse_ocr_pages, parse_cpu_milliseconds,
             parse_elapsed_milliseconds, parse_queue_milliseconds,
             parse_download_milliseconds, parse_upload_milliseconds,
             parse_worker_rss_bytes, parse_worker_pss_bytes,
             parse_io_read_bytes, parse_io_write_bytes,
             credit_micros, reservation_id, provider_call_id,
             idempotency_key, metadata)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING id
        """,
        (
            trace_id or None,
            actor_user_id,
            workspace_id or None,
            kind,
            surface,
            provider,
            model,
            catalog_provider_slug,
            catalog_model_slug,
            model_version,
            input_tokens,
            output_tokens,
            units,
            unit,
            parse_pages,
            parse_ocr_pages,
            parse_cpu_milliseconds,
            parse_elapsed_milliseconds,
            parse_queue_milliseconds,
            parse_download_milliseconds,
            parse_upload_milliseconds,
            parse_worker_rss_bytes,
            parse_worker_pss_bytes,
            parse_io_read_bytes,
            parse_io_write_bytes,
            credit_micros,
            reservation_id or None,
            provider_call_id or None,
            idempotency_key or None,
            Jsonb(metadata or {}),
        ),
    )
    inserted = cur.fetchone() is not None
    if inserted and credit_micros:
        cur.execute(
            "INSERT INTO user_credits (user_id) VALUES (%s) ON CONFLICT DO NOTHING",
            (actor_user_id,),
        )
        cur.execute(
            """
            UPDATE user_credits
            SET period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date,
                used_micros = CASE
                    WHEN period_start < date_trunc('month', now() AT TIME ZONE 'UTC')::date
                    THEN %s
                    ELSE used_micros + %s
                END,
                updated_at = now()
            WHERE user_id = %s
            """,
            (credit_micros, credit_micros, actor_user_id),
        )
    return inserted


def _lock_ingest_provider_boundary(
    cur,
    *,
    session_id: str,
    job_attempt_id: int | None,
    expected_actor: str,
    expected_workspace: str,
) -> None:
    """Fence ingest provider admission to its live claim and source.

    Lock order is workspace, ordered users, membership, file, job, attempt,
    then provider session. Claim transitions lock the job before the attempt,
    so admission must hold both in that order while it revalidates the lease.
    """
    if job_attempt_id is None:
        raise RuntimeError("ingest provider call requires a job attempt")

    # This first read only finds the source identity. The job and attempt are
    # read again under their locks after access and source are stable.
    cur.execute(
        """
        SELECT j.id, j.payload
        FROM ingest_job_attempts a
        JOIN jobs j ON j.id = a.job_id
        WHERE a.id = %s
        """,
        (job_attempt_id,),
    )
    preliminary = cur.fetchone()
    payload = preliminary[1] if preliminary is not None else None
    payload = payload if isinstance(payload, dict) else {}
    file_id = str(payload.get("fileId") or "")
    if not file_id:
        raise RuntimeError("ingest provider call has no source file")
    cancellation = _pipeline_source_cancellation(cur, payload, file_lock="SHARE")
    if cancellation is not None:
        raise RuntimeError(cancellation[3])

    preliminary_job_id = str(preliminary[0] or "")
    cur.execute(
        """
        SELECT type, status, attempts, lease_expires_at > now(), payload
        FROM jobs
        WHERE id = %s
        FOR SHARE
        """,
        (preliminary_job_id,),
    )
    locked_job = cur.fetchone()
    if locked_job is None:
        raise RuntimeError("ingest provider job no longer exists")
    cur.execute(
        """
        SELECT job_id, attempt, job_type, status
        FROM ingest_job_attempts
        WHERE id = %s
        FOR SHARE
        """,
        (job_attempt_id,),
    )
    locked_attempt = cur.fetchone()
    if locked_attempt is None:
        raise RuntimeError("ingest provider job attempt no longer exists")
    (
        job_type,
        job_status,
        job_attempt,
        lease_live,
        payload,
    ) = locked_job
    (
        attempt_job_id,
        attempt,
        attempt_type,
        attempt_status,
    ) = locked_attempt
    payload = payload if isinstance(payload, dict) else {}
    try:
        payload_revision = int(payload["sourceRevision"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("ingest provider source identity is invalid") from exc

    if (
        attempt_status != "running"
        or job_status != "running"
        or str(attempt_job_id or "") != preliminary_job_id
        or attempt_type not in {"parse", "ingest"}
        or job_type != attempt_type
        or int(attempt) != int(job_attempt)
        or not lease_live
    ):
        raise RuntimeError("ingest provider job claim is no longer current")
    if (
        str(payload.get("reservationId") or "") != session_id
        or str(payload.get("actorUserId") or "") != expected_actor
        or str(payload.get("workspaceId") or "") != expected_workspace
        or str(payload.get("fileId") or "") != file_id
    ):
        raise RuntimeError("ingest provider job identity does not match its session")
    # The source revision was validated under the file lock above. Parsing it
    # here still rejects malformed payloads before opening provider state.
    del payload_revision


def open_provider_call(
    cur,
    session_id: str,
    call_id: str,
    kind: str,
    purpose: str,
    thinking: str,
    *,
    job_attempt_id: int | None = None,
    job_stage: str = "",
    provider: str = "",
    model: str = "",
    context_system_tokens: int = 0,
    context_tool_tokens: int = 0,
    context_conversation_tokens: int = 0,
    context_total_tokens: int = 0,
    context_window_tokens: int = 0,
    context_counting_method: str = "",
    context_counting_version: int = 0,
    receipt_timeout_seconds: int = 12 * 60 * 60 + 5 * 60,
) -> None:
    """Authorize the exact call before the provider HTTP request."""
    context_values = (
        context_system_tokens,
        context_tool_tokens,
        context_conversation_tokens,
        context_total_tokens,
        context_window_tokens,
        context_counting_version,
    )
    if any(value < 0 for value in context_values):
        raise RuntimeError("provider call context values cannot be negative")
    if context_total_tokens != (
        context_system_tokens + context_tool_tokens + context_conversation_tokens
    ):
        raise RuntimeError("provider call context total does not match its components")
    if receipt_timeout_seconds <= 0:
        raise RuntimeError("provider receipt timeout must be positive")
    # Read identity without a lock. The surface-specific boundary below takes
    # its owning rows before the provider session lock.
    cur.execute(
        """
        SELECT actor_user_id, workspace_id, surface
          FROM provider_sessions WHERE id = %s
        """,
        (session_id,),
    )
    identity = cur.fetchone()
    if identity is None:
        raise RuntimeError("spend session not found")
    expected_actor, expected_workspace, expected_surface = identity
    if expected_surface == "ingest":
        _lock_ingest_provider_boundary(
            cur,
            session_id=session_id,
            job_attempt_id=job_attempt_id,
            expected_actor=str(expected_actor or ""),
            expected_workspace=str(expected_workspace or ""),
        )
    else:
        cur.execute(
            """
            SELECT u.id, u.deleted_at, u.suspended_at, u.deletion_requested_at
              FROM users u
             WHERE u.id = %s
                OR u.id = (SELECT user_id FROM workspaces WHERE id = %s)
             ORDER BY u.id
             FOR SHARE
            """,
            (expected_actor, expected_workspace),
        )
        lifecycle_rows = cur.fetchall()
        if not lifecycle_rows or any(any(row[1:]) for row in lifecycle_rows):
            raise RuntimeError("account lifecycle no longer permits provider work")

    cur.execute(
        """
        SELECT actor_user_id, workspace_id, surface, status,
               credits_exhausted_at, terminal_call_id
          FROM provider_sessions WHERE id = %s FOR UPDATE
        """,
        (session_id,),
    )
    reservation = cur.fetchone()
    if reservation is None:
        raise RuntimeError("spend session not found")
    (
        actor_user_id,
        workspace_id,
        surface,
        status,
        exhausted_at,
        terminal_call_id,
    ) = reservation
    if (
        actor_user_id != expected_actor
        or workspace_id != expected_workspace
        or surface != expected_surface
    ):
        raise RuntimeError("spend session changed during lifecycle admission")
    if status != "open":
        raise RuntimeError("provider session is closed")
    if purpose == "terminal" and (kind != "llm" or exhausted_at is None):
        raise RuntimeError("terminal provider call is not allowed")
    if kind == "llm" and exhausted_at is not None:
        if purpose != "terminal":
            raise RuntimeError("only a terminal provider call is allowed")
        if terminal_call_id and terminal_call_id != call_id:
            raise RuntimeError("terminal provider call was already used")

    cur.execute(
        """
        SELECT reservation_id, actor_user_id, job_attempt_id, job_stage,
               kind, purpose, thinking, status,
               context_system_tokens, context_tool_tokens,
               context_conversation_tokens, context_total_tokens,
               context_window_tokens, context_counting_method,
               context_counting_version
          FROM provider_calls WHERE id = %s FOR UPDATE
        """,
        (call_id,),
    )
    existing = cur.fetchone()
    if existing is not None:
        expected = (
            session_id,
            actor_user_id,
            job_attempt_id,
            job_stage,
            kind,
            purpose,
            thinking,
            "open",
            context_system_tokens,
            context_tool_tokens,
            context_conversation_tokens,
            context_total_tokens,
            context_window_tokens,
            context_counting_method,
            context_counting_version,
        )
        if existing != expected:
            raise RuntimeError("provider call id conflicts with an existing call")
        return
    cur.execute(
        """
        INSERT INTO provider_calls (
          id, reservation_id, actor_user_id, job_attempt_id, job_stage,
          kind, purpose, thinking, provider, model,
          context_system_tokens, context_tool_tokens,
          context_conversation_tokens, context_total_tokens,
          context_window_tokens, context_counting_method,
          context_counting_version, receipt_deadline_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                now() + (%s * interval '1 second'))
        """,
        (
            call_id,
            session_id,
            actor_user_id,
            job_attempt_id,
            job_stage,
            kind,
            purpose,
            thinking,
            provider[:120],
            model[:200],
            context_system_tokens,
            context_tool_tokens,
            context_conversation_tokens,
            context_total_tokens,
            context_window_tokens,
            context_counting_method,
            context_counting_version,
            receipt_timeout_seconds,
        ),
    )
    if purpose == "terminal":
        cur.execute(
            """
            UPDATE provider_sessions SET terminal_call_id = %s WHERE id = %s
            """,
            (call_id, session_id),
        )


def abandon_provider_call(
    cur,
    call_id: str,
    *,
    error_category: str = "provider",
    error_code: str = "provider_abandoned",
    provider_status: int | None = None,
) -> None:
    if not call_id:
        return
    cur.execute(
        "SELECT reservation_id, purpose FROM provider_calls WHERE id=%s", (call_id,)
    )
    candidate = cur.fetchone()
    if candidate is None:
        return
    if candidate[1] == "terminal":
        # Settlement locks session then call. Match that order so explicit
        # abandonment cannot deadlock a concurrent terminal receipt.
        cur.execute(
            "SELECT id FROM provider_sessions WHERE id=%s FOR UPDATE", (candidate[0],)
        )
    cur.execute(
        """
        UPDATE provider_calls SET status = 'abandoned', abandoned_at=now(),
          error_category=%s, error_code=%s, provider_status=%s
         WHERE id = %s AND status = 'open'
         RETURNING reservation_id, purpose
        """,
        (error_category[:80], error_code[:80], provider_status, call_id),
    )
    abandoned = cur.fetchone()
    if abandoned is not None and abandoned[1] == "terminal":
        cur.execute(
            """
            UPDATE provider_sessions SET terminal_call_id = NULL
             WHERE id = %s AND terminal_call_id = %s
            """,
            (abandoned[0], call_id),
        )


def _ingest_provider_metadata(
    call_id: str, purpose: str, kind: str, usage: Any
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "callId": call_id,
        "purpose": purpose,
        "paidBy": "platform",
    }
    if usage.cached_read_tokens:
        metadata["cachedReadTokens"] = usage.cached_read_tokens
    if usage.cache_write_tokens:
        metadata["cacheWriteTokens"] = usage.cache_write_tokens
    if usage.reasoning_tokens:
        metadata["reasoningTokens"] = usage.reasoning_tokens
    if usage.anomaly:
        metadata["cacheAnomaly"] = usage.anomaly
    if (
        kind in {"llm", "embedding"}
        and not usage.input_tokens
        and not usage.output_tokens
    ):
        metadata["usageMissing"] = True
    return metadata


def settle_ingest_provider_call(
    cur,
    *,
    session_id: str,
    call_id: str,
    kind: str,
    purpose: str,
    thinking: str,
    provider: str,
    model: str,
    catalog_provider_slug: str,
    catalog_model_slug: str,
    model_version: int,
    usage: Any,
    credit_micros: int,
    units: int = 0,
    unit: str = "tokens",
) -> str:
    """Atomically apply one post-paid ingest provider attempt."""
    cur.execute(
        """
        SELECT actor_user_id, workspace_id, trace_id, surface, status
          FROM provider_sessions WHERE id = %s FOR UPDATE
        """,
        (session_id,),
    )
    reservation = cur.fetchone()
    if reservation is None:
        raise ProviderSettlementRejected("ingest spend session not found")
    actor_user_id, workspace_id, trace_id, surface, reservation_status = reservation
    if surface != "ingest" or reservation_status not in {
        "open",
        "settled",
        "released",
    }:
        raise ProviderSettlementRejected(
            "ingest spend session is closed or has the wrong surface"
        )

    cur.execute(
        """
        SELECT reservation_id, kind, purpose, thinking, status,
               receipt_deadline_at <= now(), provider, model,
               input_tokens, output_tokens, cached_read_tokens,
               cache_write_tokens, reasoning_tokens, cache_anomaly,
               units, unit, credit_micros
          FROM provider_calls
         WHERE id = %s FOR UPDATE
        """,
        (call_id,),
    )
    call = cur.fetchone()
    if call is None or call[:4] != (session_id, kind, purpose, thinking):
        raise ProviderSettlementRejected(
            "ingest provider call does not match its open stub"
        )
    if call[4] == "applied":
        cur.execute(
            """
            SELECT reservation_id, provider_call_id, kind, surface,
                   provider, model, catalog_provider_slug,
                   catalog_model_slug, model_version, input_tokens,
                   output_tokens, units, unit, credit_micros, metadata
              FROM usage_events
             WHERE reservation_id = %s AND provider_call_id = %s
             FOR UPDATE
            """,
            (session_id, call_id),
        )
        event = cur.fetchone()
        expected_call_receipt = (
            provider,
            model,
            usage.input_tokens,
            usage.output_tokens,
            usage.cached_read_tokens,
            usage.cache_write_tokens,
            usage.reasoning_tokens,
            usage.anomaly,
            units,
            unit,
            credit_micros,
        )
        expected_event = (
            session_id,
            call_id,
            kind,
            "ingest",
            provider,
            model,
            catalog_provider_slug,
            catalog_model_slug,
            model_version,
            usage.input_tokens,
            usage.output_tokens,
            units,
            unit,
            credit_micros,
            _ingest_provider_metadata(call_id, purpose, kind, usage),
        )
        if call[6:] == expected_call_receipt and event == expected_event:
            return "duplicate"
        raise ProviderSettlementRejected(
            "ingest provider call receipt conflicts with its applied settlement"
        )
    if call[4] != "open":
        raise ProviderSettlementRejected("ingest provider call is not open")
    if call[5]:
        cur.execute(
            """
            UPDATE provider_calls SET status='abandoned', abandoned_at=now(),
              error_category='provider', error_code='receipt_timeout'
             WHERE id=%s AND reservation_id=%s AND status='open'
             RETURNING purpose
            """,
            (call_id, session_id),
        )
        expired = cur.fetchone()
        if expired is not None and expired[0] == "terminal":
            cur.execute(
                """
                UPDATE provider_sessions SET terminal_call_id=NULL
                 WHERE id=%s AND terminal_call_id=%s
                """,
                (session_id, call_id),
            )
        return "expired"

    metadata = _ingest_provider_metadata(call_id, purpose, kind, usage)

    record_usage_event(
        cur,
        actor_user_id=actor_user_id,
        workspace_id=workspace_id,
        kind=kind,
        surface="ingest",
        provider=provider,
        model=model,
        catalog_provider_slug=catalog_provider_slug,
        catalog_model_slug=catalog_model_slug,
        model_version=model_version,
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        units=units,
        unit=unit,
        credit_micros=credit_micros,
        reservation_id=session_id,
        provider_call_id=call_id,
        trace_id=trace_id,
        metadata=metadata,
    )
    cur.execute(
        """
        UPDATE provider_calls SET
          status = 'applied', provider = %s, model = %s,
          input_tokens = %s, output_tokens = %s,
          cached_read_tokens = %s, cache_write_tokens = %s,
          reasoning_tokens = %s, cache_anomaly = %s,
          units = %s, unit = %s, credit_micros = %s,
          received_at = now(), applied_at = now()
        WHERE id = %s AND reservation_id = %s AND status = 'open'
        """,
        (
            provider,
            model,
            usage.input_tokens,
            usage.output_tokens,
            usage.cached_read_tokens,
            usage.cache_write_tokens,
            usage.reasoning_tokens,
            usage.anomaly,
            units,
            unit,
            credit_micros,
            call_id,
            session_id,
        ),
    )
    if cur.rowcount != 1:
        raise ProviderSettlementRejected("ingest provider call could not be applied")
    if reservation_status == "released":
        cur.execute(
            """
            UPDATE provider_sessions SET status = 'settled'
             WHERE id = %s AND status = 'released'
            """,
            (session_id,),
        )
    return "applied"


def settle_credit_reservation(cur, reservation_id: str) -> None:
    if not reservation_id:
        return
    cur.execute(
        """
        WITH closed AS (
          UPDATE provider_sessions
          SET status = 'settled', settled_at = now()
          WHERE id = %s AND status = 'open'
          RETURNING actor_user_id, reserved_micros
        )
        UPDATE user_credits c
        SET reserved_micros = GREATEST(0, c.reserved_micros - closed.reserved_micros),
            updated_at = now()
        FROM closed WHERE c.user_id = closed.actor_user_id
        """,
        (reservation_id,),
    )


def release_credit_reservation(cur, reservation_id: str) -> None:
    if not reservation_id:
        return
    cur.execute(
        """
        WITH closed AS (
          UPDATE provider_sessions
          SET status = 'released', settled_at = now()
          WHERE id = %s AND status = 'open'
          RETURNING actor_user_id, reserved_micros
        )
        UPDATE user_credits c
        SET reserved_micros = GREATEST(0, c.reserved_micros - closed.reserved_micros),
            updated_at = now()
        FROM closed WHERE c.user_id = closed.actor_user_id
        """,
        (reservation_id,),
    )


def close_credit_reservation(cur, reservation_id: str) -> None:
    """Settle a session that spent anything; otherwise release it."""
    if not reservation_id:
        return
    cur.execute(
        """
        WITH closed AS (
          UPDATE provider_sessions AS cr
          SET status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM usage_events ue WHERE ue.reservation_id = cr.id
                ) THEN 'settled'
                ELSE 'released'
              END,
              settled_at = now()
          WHERE cr.id = %s AND cr.status = 'open'
          RETURNING actor_user_id, reserved_micros
        )
        UPDATE user_credits c
        SET reserved_micros = GREATEST(0, c.reserved_micros - closed.reserved_micros),
            updated_at = now()
        FROM closed WHERE c.user_id = closed.actor_user_id
        """,
        (reservation_id,),
    )


def account_allows_ingest(cur, user_id: str, *, allow_over_quota: bool = False) -> bool:
    """Mirror store.AccountStatus.CanCreate for the ingest worker.

    Locked / over-quota accounts must not keep consuming parse capacity. The
    Go gateway already refuses new uploads; this catches jobs that were
    enqueued before the account transitioned, or raced the gate.
    """
    cur.execute(
        """
        SELECT CASE
                 WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
                   WHERE any_sub.user_id=u.id) THEN u.plan_tier
                 ELSE COALESCE((SELECT live.plan_tier
                   FROM user_subscriptions live
                   WHERE live.user_id=u.id
                     AND live.status IN ('active','trialing','past_due')
                     AND (live.current_period_end IS NULL
                       OR live.current_period_end > now())
                   ORDER BY (live.plan_tier='pro') DESC,
                     live.current_period_end DESC NULLS FIRST LIMIT 1), 'free')
               END,
               u.deleted_at, u.suspended_at, u.deletion_requested_at,
               COALESCE(st.used_bytes, 0) + COALESCE(
                   (SELECT sum(delta_bytes) FROM user_storage_deltas d
                    WHERE d.user_id = u.id), 0
               ) + COALESCE(st.reserved_bytes, 0) AS effective_used,
               (SELECT max(s.current_period_end)
                  FROM user_subscriptions s
                 WHERE s.user_id = u.id
                   AND s.status IN ('active','trialing','past_due')
                   AND s.current_period_end IS NOT NULL) AS period_end,
               EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=u.id),
               EXISTS(SELECT 1 FROM user_subscriptions s
                   WHERE s.user_id=u.id
                     AND s.status IN ('active','trialing','past_due'))
        FROM users u
        LEFT JOIN user_storage st ON st.user_id = u.id
        WHERE u.id = %s
        """,
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return False
    (
        plan_tier,
        deleted_at,
        suspended_at,
        deletion_requested_at,
        effective_used,
        period_end,
        has_subscriptions,
        has_entitling_subscription,
    ) = row
    if (
        deleted_at is not None
        or suspended_at is not None
        or deletion_requested_at is not None
    ):
        return False
    from datetime import datetime, timezone

    if has_subscriptions and not has_entitling_subscription:
        plan_tier = "free"
    elif period_end is not None:
        now = datetime.now(timezone.utc)
        end = (
            period_end if period_end.tzinfo else period_end.replace(tzinfo=timezone.utc)
        )
        if end <= now:
            plan_tier = "free"
    return not (
        effective_used > plan_limits.for_tier(plan_tier).storage_bytes
        and not allow_over_quota
    )


def ingest_accounts_active(cur, file_id: str, actor_user_id: str) -> bool:
    """Lock and recheck source access for an in-flight ingest write.

    Claim-time admission is insufficient for a long parse/index job: suspension,
    deletion, or membership revocation may commit minutes later. Callers about
    to persist a stage outcome use this in the same transaction as that outcome.
    """
    if not file_id:
        return False
    refresh = source_refresh_for(file_id)
    if refresh is not None:
        return _pipeline_source_cancellation(cur, refresh, file_lock="UPDATE") is None
    cur.execute(
        """
        SELECT workspace_id, revision, COALESCE(source_etag, ''),
               COALESCE(created_by, user_id)
        FROM files WHERE id = %s
        """,
        (file_id,),
    )
    source = cur.fetchone()
    if source is None:
        return False
    if not actor_user_id:
        actor_user_id = str(source[3] or "")
    if not actor_user_id:
        return False
    cancellation = _pipeline_source_cancellation(
        cur,
        {
            "actorUserId": actor_user_id,
            "fileId": file_id,
            "sourceETag": str(source[2] or ""),
            "sourceRevision": int(source[1]),
            "workspaceId": str(source[0] or ""),
        },
        file_lock="UPDATE",
    )
    return cancellation is None


def actor_has_credits(cur, user_id: str) -> bool:
    """Unlocked lifecycle and credits check for ingest claim time."""
    if not user_id:
        return False
    cur.execute(
        """
        SELECT CASE
                 WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
                   WHERE any_sub.user_id=u.id) THEN u.plan_tier
                 ELSE COALESCE((SELECT live.plan_tier
                   FROM user_subscriptions live
                   WHERE live.user_id=u.id
                     AND live.status IN ('active','trialing','past_due')
                     AND (live.current_period_end IS NULL
                       OR live.current_period_end > now())
                   ORDER BY (live.plan_tier='pro') DESC,
                     live.current_period_end DESC NULLS FIRST LIMIT 1), 'free')
               END,
               u.deleted_at,
               u.suspended_at,
               u.deletion_requested_at,
               COALESCE(c.used_micros, 0),
               COALESCE(c.reserved_micros, 0),
               c.period_start,
               (SELECT max(s.current_period_end)
                  FROM user_subscriptions s
                 WHERE s.user_id = u.id
                   AND s.status IN ('active','trialing','past_due')
                   AND s.current_period_end IS NOT NULL) AS period_end,
               EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=u.id),
               EXISTS(SELECT 1 FROM user_subscriptions s
                   WHERE s.user_id=u.id
                     AND s.status IN ('active','trialing','past_due'))
          FROM users u
          LEFT JOIN user_credits c ON c.user_id = u.id
         WHERE u.id = %s
        """,
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return False
    (
        plan_tier,
        deleted_at,
        suspended_at,
        deletion_requested_at,
        used,
        reserved,
        period_start,
        period_end,
        has_subscriptions,
        has_entitling_subscription,
    ) = row
    if (
        deleted_at is not None
        or suspended_at is not None
        or deletion_requested_at is not None
    ):
        return False
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).date()
    if period_start is not None and period_start < today.replace(day=1):
        used = 0
    if has_subscriptions and not has_entitling_subscription:
        plan_tier = "free"
    elif period_end is not None:
        end = (
            period_end if period_end.tzinfo else period_end.replace(tzinfo=timezone.utc)
        )
        if end <= datetime.now(timezone.utc):
            plan_tier = "free"
    return (used + reserved) < plan_limits.for_tier(plan_tier).credit_micros
