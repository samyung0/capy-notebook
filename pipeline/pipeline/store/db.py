"""Thin psycopg helpers over the shared Postgres job queue.

Only queue/file/notification plumbing lives here. The retrieval index has its
own async access layer in ``pipeline.retrieval.store``; these stay synchronous
because they run inside short transactions the worker commits explicitly, and
are called via ``asyncio.to_thread``.
"""

from __future__ import annotations

import secrets
import threading
from typing import Any

from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from ..config import cfg

_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()


def pool() -> ConnectionPool:
    """Lazy singleton so tests can rewrite ``cfg.dsn`` before the first borrow."""
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = ConnectionPool(
                    cfg.dsn,
                    min_size=1,
                    max_size=4,
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


def uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


# ---------------------------------------------------------------- job queue


def claim_job(cur, leases: dict[str, int]) -> dict[str, Any] | None:
    """Claim one due pending job atomically (FOR UPDATE SKIP LOCKED)."""
    ingest_lease = int(leases.get("ingest") or 180)
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
              AND (not_before IS NULL OR not_before <= now())
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, type, payload, attempts
        """,
        (ingest_lease,),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "type": row[1], "payload": row[2], "attempts": row[3]}


def set_job(cur, job_id: str, status: str, error: str | None = None) -> None:
    cur.execute(
        "UPDATE jobs SET status=%s, error=%s, updated_at=now(), lease_expires_at=NULL WHERE id=%s",
        (status, error, job_id),
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
        FOR UPDATE
        """,
        (job_id, attempt),
    )
    return cur.fetchone() is not None


def heartbeat_job(cur, job_id: str, lease_s: int, attempt: int) -> None:
    cur.execute(
        """
        UPDATE jobs
        SET locked_at=now(),
            lease_expires_at=now() + make_interval(secs => %s),
            updated_at=now()
        WHERE id=%s AND status='running' AND attempts=%s
        """,
        (lease_s, job_id, attempt),
    )
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
            updated_at=now()
        WHERE id=%s
        """,
        (error[:500], backoff_s, job_id),
    )
    return "pending"


def release_job_for_capacity(cur, job_id: str, attempt: int, *, backoff_s: int) -> None:
    """Put a running job back to pending without spending an attempt.

    Used when every Modal parse slot is taken. ``claim_job`` already incremented
    ``attempts``; undoing that is what keeps a long queue from looking like
    three failures.
    """
    cur.execute(
        """
        UPDATE jobs SET
            status='pending',
            attempts=GREATEST(attempts-1, 0),
            error=NULL,
            not_before=now() + make_interval(secs => %s),
            lease_expires_at=NULL,
            updated_at=now()
        WHERE id=%s AND status='running' AND attempts=%s
        """,
        (backoff_s, job_id, attempt),
    )


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
          AND lease_expires_at < now()
        FOR UPDATE SKIP LOCKED
        """
    )
    rows = cur.fetchall()
    reclaimed: list[dict[str, Any]] = []
    for job_id, job_type, payload, attempts, error in rows:
        payload = payload or {}
        if job_type == "ingest":
            # The dead worker never ran abandon_content. Drop the claim it
            # created so a waiter (or this job's retry) can recreate it. Keyed
            # on the owning job, not on the file: a dead waiter's file points at
            # the creator's row, and deleting that would cascade a live ingest's
            # chunks away while it is still writing them.
            cur.execute(
                "DELETE FROM rag_contents WHERE claim_job_id = %s AND status = 'processing'",
                (job_id,),
            )
        cap = int(max_attempts.get(job_type) or max_attempts.get("ingest") or 3)
        note = (error or "lease expired").strip() or "lease expired"
        if "lease expired" not in note:
            note = f"{note}; lease expired"
        outcome = "failed"
        if attempts >= cap:
            set_job(cur, job_id, "failed", note[:500])
        else:
            base = int(
                backoff_base_s.get(job_type) or backoff_base_s.get("ingest") or 30
            )
            outcome = requeue_job(
                cur,
                job_id=job_id,
                job_type=job_type,
                workspace_id=payload.get("workspaceId"),
                error=note,
                backoff_s=base * (2 ** max(int(attempts) - 1, 0)),
            )
        reclaimed.append(
            {
                "id": job_id,
                "type": job_type,
                "payload": payload,
                "attempts": attempts,
                "outcome": outcome,
            }
        )
    return reclaimed


def set_file_status(cur, file_id: str, status: str) -> None:
    cur.execute("UPDATE files SET status=%s WHERE id=%s", (status, file_id))


def set_file_indexed(cur, file_id: str, indexed: bool) -> None:
    cur.execute("UPDATE files SET indexed=%s WHERE id=%s", (indexed, file_id))


def set_file_content_hash(cur, file_id: str, content_hash: str) -> None:
    """Record the hash of the parsed text, used to skip duplicate indexing."""
    cur.execute("UPDATE files SET content_hash=%s WHERE id=%s", (content_hash, file_id))


def set_file_parse_artifact(
    cur,
    file_id: str,
    blob_path: str,
    fingerprint: str,
    parser_version: str,
) -> None:
    cur.execute(
        """UPDATE files
        SET parsed_blob_path=%s, parsed_fingerprint=%s, parsed_parser_version=%s
        WHERE id=%s""",
        (blob_path, fingerprint, parser_version, file_id),
    )


def clear_file_parse_artifact(cur, file_id: str) -> None:
    cur.execute(
        """UPDATE files
        SET parsed_blob_path=NULL, parsed_fingerprint=NULL, parsed_parser_version=NULL
        WHERE id=%s""",
        (file_id,),
    )


def set_file_caption_blob(cur, file_id: str, blob_path: str) -> None:
    cur.execute(
        "UPDATE files SET caption_blob_path=%s WHERE id=%s",
        (blob_path, file_id),
    )


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


def sweep_artifact_cache(
    cur, *, caption_ttl_days: int, parse_zip_ttl_hours: int
) -> int:
    """Delete cold cache rows that no in-flight ingest still needs.

    Routed through the artifact_cache trigger into pending_blob_deletions.
    """
    cur.execute(
        """
        DELETE FROM artifact_cache a
        WHERE (
                (a.kind = 'captions'
                 AND a.last_used_at < now() - make_interval(days => %s))
             OR (a.kind = 'parse_zip'
                 AND a.last_used_at < now() - make_interval(hours => %s))
            )
          AND NOT EXISTS (
              SELECT 1
              FROM jobs j
              JOIN files f ON f.id = j.payload->>'fileId'
              WHERE j.status IN ('pending', 'running')
                AND f.source_sha256 = a.source_sha256
          )
        """,
        (caption_ttl_days, parse_zip_ttl_hours),
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
    cur.execute(
        "UPDATE files SET source_sha256=%s WHERE id=%s", (source_sha256, file_id)
    )


def file_owner_user_id(cur, file_id: str) -> str | None:
    cur.execute("SELECT user_id FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return row[0] if row else None


def workspace_owner_user_id(cur, workspace_id: str) -> str | None:
    cur.execute("SELECT user_id FROM workspaces WHERE id=%s", (workspace_id,))
    row = cur.fetchone()
    return row[0] if row else None


# Credit pricing for non-token resources. Token rates live on model_configs
# and are applied via pipeline.registry.credits_for_tokens; they must not be
# duplicated here or the same work costs different amounts depending on which
# process did it.
MICROS_PER_CREDIT = 1_000_000
_MICROS_PER_GPU_SECOND = 500_000
_FREE_CREDITS_PER_MONTH = 1_000
_PRO_CREDITS_PER_MONTH = 20_000


def credits_for_gpu(gpu_millis: int) -> int:
    return gpu_millis * _MICROS_PER_GPU_SECOND // 1000


def credit_limit_micros(plan_tier: str) -> int:
    if plan_tier == "pro":
        return _PRO_CREDITS_PER_MONTH * MICROS_PER_CREDIT
    return _FREE_CREDITS_PER_MONTH * MICROS_PER_CREDIT


def record_usage_event(
    cur,
    *,
    actor_user_id: str,
    workspace_id: str | None,
    kind: str,
    surface: str,
    provider: str = "",
    model: str = "",
    model_key: str = "",
    model_version: int = 0,
    input_tokens: int = 0,
    output_tokens: int = 0,
    units: int = 0,
    unit: str = "",
    credit_micros: int = 0,
    reservation_id: str = "",
    trace_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Append one metered consumption and charge it to the actor's counter.

    Ingest is leased at enqueue and recorded here after the job finishes. The
    measured charge can still push a user past their limit; the next
    interactive request is what refuses.
    """
    if not actor_user_id or credit_micros < 0:
        return
    cur.execute(
        """
        INSERT INTO usage_events
            (trace_id, actor_user_id, workspace_id, kind, surface, provider, model,
             model_key, model_version,
             input_tokens, output_tokens, units, unit, credit_micros,
             reservation_id, metadata)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """,
        (
            trace_id or None,
            actor_user_id,
            workspace_id or None,
            kind,
            surface,
            provider,
            model,
            model_key,
            model_version,
            input_tokens,
            output_tokens,
            units,
            unit,
            credit_micros,
            reservation_id or None,
            Jsonb(metadata or {}),
        ),
    )
    if credit_micros:
        cur.execute(
            "INSERT INTO user_credits (user_id) VALUES (%s) ON CONFLICT DO NOTHING",
            (actor_user_id,),
        )
        cur.execute(
            """
            UPDATE user_credits
            SET used_micros = used_micros + %s, updated_at = now()
            WHERE user_id = %s
            """,
            (credit_micros, actor_user_id),
        )


def settle_credit_reservation(cur, reservation_id: str) -> None:
    if not reservation_id:
        return
    cur.execute(
        """
        UPDATE credit_reservations
        SET status = 'settled', settled_at = now()
        WHERE id = %s AND status = 'open'
        """,
        (reservation_id,),
    )


def release_credit_reservation(cur, reservation_id: str) -> None:
    if not reservation_id:
        return
    cur.execute(
        """
        UPDATE credit_reservations
        SET status = 'released', settled_at = now()
        WHERE id = %s AND status = 'open'
        """,
        (reservation_id,),
    )


def account_allows_ingest(cur, user_id: str) -> bool:
    """Mirror store.AccountStatus.CanCreate for the ingest worker.

    Locked / over-quota accounts must not keep consuming parse capacity. The
    Go gateway already refuses new uploads; this catches jobs that were
    enqueued before the account transitioned, or raced the gate.
    """
    cur.execute(
        """
        SELECT u.deleted_at, u.suspended_at, u.deletion_requested_at,
               COALESCE(st.used_bytes, 0) + COALESCE(
                   (SELECT sum(delta_bytes) FROM user_storage_deltas d
                    WHERE d.user_id = u.id), 0
               ) + COALESCE(st.reserved_bytes, 0) AS effective_used,
               (SELECT max(s.current_period_end)
                  FROM user_subscriptions s
                 WHERE s.user_id = u.id
                   AND s.current_period_end IS NOT NULL) AS period_end
        FROM users u
        LEFT JOIN user_storage st ON st.user_id = u.id
        WHERE u.id = %s
        """,
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return False
    deleted_at, suspended_at, deletion_requested_at, effective_used, period_end = row
    if (
        deleted_at is not None
        or suspended_at is not None
        or deletion_requested_at is not None
    ):
        return False
    from datetime import datetime, timezone

    if period_end is not None:
        now = datetime.now(timezone.utc)
        end = (
            period_end if period_end.tzinfo else period_end.replace(tzinfo=timezone.utc)
        )
        if end < now:
            # After lapse the free-tier storage limit applies regardless of the
            # denormalized plan_tier column, which may lag a missed webhook.
            free_limit = 100 * 1024 * 1024
            if effective_used > free_limit:
                return False
    return True


def actor_has_credits(cur, user_id: str) -> bool:
    """Unlocked credits remaining check for ingest claim time.

    Lifecycle is deliberately not consulted: a deletion_pending uploader must
    not strand the owner with bytes they already paid for. Credits are the
    actor's money; the owner's workspace is the owner's business.
    """
    if not user_id:
        return False
    cur.execute(
        """
        SELECT u.plan_tier,
               COALESCE(c.used_micros, 0),
               COALESCE(c.reserved_micros, 0),
               c.period_start
          FROM users u
          LEFT JOIN user_credits c ON c.user_id = u.id
         WHERE u.id = %s
        """,
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return False
    plan_tier, used, reserved, period_start = row
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).date()
    if period_start is not None and period_start < today.replace(day=1):
        used = 0
    return (used + reserved) < credit_limit_micros(plan_tier)
