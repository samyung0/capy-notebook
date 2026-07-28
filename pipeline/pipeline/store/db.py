"""Thin psycopg helpers over the shared Postgres job queue.

Only the queue/file/notification plumbing the worker needs lives here — all the
actual RAG state (entities, relations, vectors, chunks) is owned by LightRAG's
own ``lightrag_*`` tables, created on ``initialize_storages()``.

These are synchronous (psycopg) and are called from the async worker via
``asyncio.to_thread`` so a single event loop keeps the cached LightRAG asyncpg
pools alive across jobs.
"""

from __future__ import annotations

import secrets
from typing import Any

import psycopg

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


def set_file_doc_id(cur, file_id: str, doc_id: str | None) -> None:
    """Record the LightRAG document id backing this file (None = no doc)."""
    cur.execute("UPDATE files SET doc_id=%s WHERE id=%s", (doc_id, file_id))


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


def file_ids_for_doc_id(cur, doc_id: str) -> list[str]:
    """Files (if any) already claiming this LightRAG doc id."""
    cur.execute("SELECT id FROM files WHERE doc_id=%s", (doc_id,))
    return [row[0] for row in cur.fetchall()]


def file_names_for_ids(cur, file_ids: list[str]) -> list[str]:
    """Display names for the given file ids (order not guaranteed)."""
    if not file_ids:
        return []
    cur.execute("SELECT name FROM files WHERE id = ANY(%s)", (file_ids,))
    return [row[0] for row in cur.fetchall()]


def add_notification(cur, kind: str, title: str, body: str) -> None:
    cur.execute(
        "INSERT INTO notifications (id, kind, title, body) VALUES (%s,%s,%s,%s)",
        (uid("nt"), kind, title, body),
    )


def file_name(cur, file_id: str) -> str:
    cur.execute("SELECT name FROM files WHERE id=%s", (file_id,))
    row = cur.fetchone()
    return row[0] if row else file_id
