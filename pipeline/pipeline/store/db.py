"""Thin psycopg helpers over the shared Postgres job queue.

Only queue/file/notification plumbing lives here. The retrieval index has its
own async access layer in ``pipeline.retrieval.store``; these stay synchronous
because they run inside short transactions the worker commits explicitly, and
are called via ``asyncio.to_thread``.
"""

from __future__ import annotations

import secrets
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from ..config import cfg


def connect(autocommit: bool = False) -> psycopg.Connection:
    return psycopg.connect(cfg.dsn, autocommit=autocommit)


def uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


# ---------------------------------------------------------------- job queue


def claim_job(cur) -> dict[str, Any] | None:
    """Claim one pending ingest job atomically (FOR UPDATE SKIP LOCKED)."""
    cur.execute(
        """
        UPDATE jobs SET status='running', locked_at=now(), updated_at=now(), attempts=attempts+1
        WHERE id = (
            SELECT id FROM jobs WHERE status='pending'
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, type, payload
        """
    )
    row = cur.fetchone()
    if not row:
        return None
    return {"id": row[0], "type": row[1], "payload": row[2]}


def set_job(cur, job_id: str, status: str, error: str | None = None) -> None:
    cur.execute(
        "UPDATE jobs SET status=%s, error=%s, updated_at=now() WHERE id=%s",
        (status, error, job_id),
    )


def set_file_status(cur, file_id: str, status: str) -> None:
    cur.execute("UPDATE files SET status=%s WHERE id=%s", (status, file_id))


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


def add_notification(
    cur,
    file_id: str,
    kind: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    cur.execute("SELECT user_id, workspace_id FROM files WHERE id=%s", (file_id,))
    owner = cur.fetchone()
    if not owner:
        raise ValueError(f"cannot notify for missing file {file_id}")
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


def file_name(cur, file_id: str) -> str:
    cur.execute("SELECT name FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return row[0] if row else file_id


def file_owner_user_id(cur, file_id: str) -> str | None:
    cur.execute("SELECT user_id FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return row[0] if row else None


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
