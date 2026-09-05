"""Ingestion worker.

Claims one selected stage from the Postgres queue and executes the server-owned
processing plan attached at enqueue time. File-category checks do not select
the pipeline. Parse coordinators download the B2 source into the ingest host's
shared spool and hand an immutable local bundle to an ingest continuation.

The parse returns a bundle — a ``content_list.json`` carrying a page index and
bounding box per block, plus the extracted images — so citations a reader can
jump to and figures that can be captioned come from the same shape.

Live progress is published to Redis; the Go gateway fans it to the browser over
SSE. A document stays ``pending`` until a coordinator holds a parse slot; ingest
workers never wait on MinerU.

Run: ``python -m pipeline.ingest.worker``
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .. import obs, plan_limits, progress, registry, use_compatible_event_loop
from ..config import cfg
from ..jobs import (
    CONTENT_CLAIM_STALE_S,
    CONTENT_CLAIM_WAIT_S,
    POLICIES,
    CapacityWait,
    RetryableError,
    TerminalError,
    backoff_s,
    is_retryable,
    policy_for,
)
from ..parse import figures, parser_client, slots
from ..retrieval import accounting, indexing, store
from ..retrieval.chunking import (
    CHUNKER_VERSION,
    Chunk,
    chunk_content_list,
    chunk_markdown,
)
from ..store import blobstore, db
from . import capacity, import_stage, source_text, telemetry
from . import plan as ingest_plan

log = logging.getLogger("capy.worker")

_RESOURCE_AUDIO_SECOND = "audio_transcription_second"
_RESOURCE_DIGITAL_PAGE = "digital_parse_page"
_RESOURCE_OCR_PAGE = "ocr_parse_page"
_RESOURCE_FIGURE_CAPTION = "figure_caption_call"
_REQUIRED_RESOURCE_RATES = {
    _RESOURCE_AUDIO_SECOND,
    _RESOURCE_DIGITAL_PAGE,
    _RESOURCE_OCR_PAGE,
    _RESOURCE_FIGURE_CAPTION,
}
_resource_rates: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "ingest_resource_rates", default=None
)

_PARSE_ROUTES = {
    "fast": parser_client.ROUTE_FAST,
}


def _set_stage(name: str) -> None:
    telemetry.stage(name)
    accounting.set_job_stage(name)


_REQUIRED_INGEST_STRINGS = (
    "fileId",
    "workspaceId",
    "blobPath",
    "kind",
    "actorUserId",
    "reservationId",
    "ingestProviderSlug",
    "ingestModelSlug",
    "captioningProviderSlug",
    "captioningModelSlug",
)
_REQUIRED_INGEST_INTS = (
    "ingestModelVersion",
    "captioningModelVersion",
    "sourceRevision",
)
_REQUIRED_INGEST_KEYS = ("sourceETag",)


def _parse_route(parse_mode: str) -> str:
    route = _PARSE_ROUTES.get(parse_mode)
    if route is None:
        raise TerminalError(f"unknown parse mode {parse_mode!r}")
    return route


def _rate(resource_key: str) -> dict:
    rate = (_resource_rates.get() or {}).get(resource_key)
    if not isinstance(rate, dict):
        raise TerminalError(f"ingest payload has no {resource_key} rate")
    try:
        version = int(rate["version"])
        micros = int(rate["creditMicrosPerUnit"])
    except (KeyError, TypeError, ValueError) as exc:
        raise TerminalError(f"ingest payload has invalid {resource_key} rate") from exc
    if version <= 0 or micros < 0:
        raise TerminalError(f"ingest payload has invalid {resource_key} rate")
    return {**rate, "version": version, "creditMicrosPerUnit": micros}


def _job_timeout(job: dict, default: int) -> int:
    payload = job.get("payload") or {}
    processing_plan = payload.get("processingPlan") or {}
    if (
        job.get("type") == "ingest"
        and processing_plan.get("route") == ingest_plan.AUDIO_TRANSCRIPTION
    ):
        # Preserve the ordinary ingest budget for download, validation, and
        # admission before giving the synchronous provider its full receipt
        # window.
        return default + cfg.elevenlabs_sync_timeout_s + 300
    return default


# ----------------------------------------------------------- sync DB helpers
# (run via asyncio.to_thread so the event loop is never blocked)


def _announce_reclaimed(row: dict) -> None:
    payload = row.get("payload") or {}
    if row.get("outcome") != "failed" or not payload.get("fileId"):
        return
    _cleanup_payload_source(payload)
    if not row.get("file_failed"):
        return
    error = f"{row.get('type') or 'pipeline'} worker died before the job completed"
    workspace_id = str(payload.get("workspaceId") or "")
    file_id = str(payload.get("fileId") or "")
    if workspace_id:
        progress.publish(
            workspace_id,
            file_id,
            "failed",
            100,
            status="failed",
            message=error[:200],
            indexed=False,
        )
    log.info("ingest %s failed terminally: %s", file_id, error)


def _claim_one(job_type: str) -> dict | None:
    leases = {name: p.lease_s for name, p in POLICIES.items()}
    max_attempts = {name: p.max_attempts for name, p in POLICIES.items()}
    backoff_base = {name: p.backoff_base_s for name, p in POLICIES.items()}
    trace_id = obs.new_trace_id()
    claim = telemetry.claim_metadata(job_type)
    with db.connect() as conn:
        with conn.cursor() as cur:
            reclaimed = db.reclaim_expired_leases(
                cur, max_attempts=max_attempts, backoff_base_s=backoff_base
            )
            job = db.claim_job(cur, job_type, leases[job_type])
            if job is not None:
                job["attemptId"] = db.start_job_attempt(
                    cur,
                    job=job,
                    trace_id=trace_id,
                    environment=claim["environment"],
                    host_id=claim["host_id"],
                    worker_instance_id=claim["worker_instance_id"],
                    release_sha=claim["release_sha"],
                )
                job["traceId"] = trace_id
        conn.commit()
    for row in reclaimed:
        log.warning(
            "reclaimed stale %s job %s (%s)",
            row["type"],
            row["id"],
            row["outcome"],
        )
        # The reclaim is already committed and `job` is already claimed, so a
        # failure here must not propagate: it would discard a job that is
        # marked running and leave it to expire, burning an attempt on work
        # nothing ever started.
        try:
            _announce_reclaimed(row)
        except Exception:
            log.exception("could not announce reclaimed job %s", row["id"])
    return job


def _claim_one_with_capacity(
    job_type: str,
) -> tuple[dict | None, capacity.CapacityLease | None, bool]:
    """Claim only while this process owns the optional host-wide role slot."""

    lease = capacity.try_acquire(job_type)
    if lease is None:
        return None, None, True
    try:
        job = _claim_one(job_type)
    except BaseException:
        lease.release()
        raise
    if job is None:
        lease.release()
        return None, None, False
    return job, lease, False


def _heartbeat_loop(
    job_id: str,
    lease_s: int,
    attempt: int,
    stop: threading.Event,
    cancel_job: Callable[[], None] | None = None,
) -> None:
    while not stop.wait(min(30, max(lease_s // 3, 5))):
        try:
            with db.connect() as conn, conn.cursor() as cur:
                claim_is_live = db.heartbeat_job(cur, job_id, lease_s, attempt)
                conn.commit()
            if not claim_is_live:
                if cancel_job is not None:
                    cancel_job()
                return
        except Exception:
            log.warning("job heartbeat failed", exc_info=True)


def _lost_claim(
    cur,
    job_id: str,
    attempt: int | None,
    payload: dict | None = None,
) -> bool:
    """True when another worker has taken over, so this run must not write.

    ``attempt`` is None for the lease reaper, which is acting on a row it has
    already transitioned and therefore owns.
    """
    if attempt is None:
        return False
    if payload is not None:
        boundary = db.lock_pipeline_claim_boundary(
            cur,
            job_id=job_id,
            attempt=attempt,
            payload=payload,
        )
    else:
        boundary = "current" if db.claim_is_current(cur, job_id, attempt) else "lost"
    if boundary == "current":
        return False
    if boundary == "cancelled":
        # Finalization returns immediately on a closed boundary. Commit the
        # cancellation now so stopping the heartbeat cannot leave it retryable.
        cur.connection.commit()
    log.warning(
        "job %s lost its claim (attempt %s); discarding outcome", job_id, attempt
    )
    return True


def _finish_ok(
    file_id: str,
    name: str,
    job_id: str,
    content_hash: str | None = None,
    artifact_key: str | None = None,
    artifact_fingerprint: str | None = None,
    artifact_version: str | None = None,
    notification_code: str = "source_ready",
    indexed: bool = True,
    attempt: int | None = None,
    actor_user_id: str = "",
    workspace_id: str = "",
    reservation_id: str = "",
    source_revision: int | None = None,
    source_etag: str = "",
) -> bool:
    notification = None
    usage = obs.take_parse_usage()
    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
                boundary_payload = None
                if source_revision is not None:
                    boundary_payload = {
                        "actorUserId": actor_user_id,
                        "fileId": file_id,
                        "reservationId": reservation_id,
                        "sourceETag": source_etag,
                        "sourceRevision": source_revision,
                        "workspaceId": workspace_id,
                    }
                if _lost_claim(cur, job_id, attempt, boundary_payload):
                    return False
                if boundary_payload is None and not db.ingest_accounts_active(
                    cur, file_id, actor_user_id
                ):
                    raise TerminalError(
                        "ingest stopped because workspace access is no longer writable"
                    )
                _record_parse_usage_tx(
                    cur,
                    usage=usage,
                    file_id=file_id,
                    workspace_id=workspace_id,
                    actor_user_id=actor_user_id,
                    reservation_id=reservation_id,
                    job_id=job_id,
                    attempt=int(attempt or 1),
                    outcome="succeeded",
                )
                db.settle_credit_reservation(cur, reservation_id)
                db.set_file_status(cur, file_id, "ready")
                db.set_file_indexed(cur, file_id, indexed)
                if content_hash is not None:
                    db.set_file_content_hash(cur, file_id, content_hash)
                if artifact_key:
                    db.set_file_parse_artifact(
                        cur,
                        file_id,
                        artifact_key,
                        artifact_fingerprint or "",
                        artifact_version or "",
                    )
                db.set_job(cur, job_id, "done")
                db.finish_job_attempt(
                    cur,
                    attempt_id=telemetry.current_attempt_id(),
                    outcome="succeeded",
                    snapshot=telemetry.snapshot(),
                )
            conn.commit()
    except Exception:
        obs.record_parse_usage(
            pages=usage.pages,
            ocr_pages=usage.ocr_pages,
            cpu_milliseconds=usage.cpu_milliseconds,
            elapsed_milliseconds=usage.elapsed_milliseconds,
            queue_milliseconds=usage.queue_milliseconds,
            execution_milliseconds=usage.execution_milliseconds,
            slices=usage.slices,
            download_milliseconds=usage.download_milliseconds,
            upload_milliseconds=usage.upload_milliseconds,
            worker_rss_bytes=usage.worker_rss_bytes,
            worker_pss_bytes=usage.worker_pss_bytes,
            io_read_bytes=usage.io_read_bytes,
            io_write_bytes=usage.io_write_bytes,
            method=usage.method,
            source_format=usage.source_format,
            receipt_id=usage.receipt_id,
        )
        raise
    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
                if source_revision is not None:
                    db.require_current_file_source(
                        cur, file_id, source_revision, source_etag
                    )
                notification = db.add_notification(
                    cur,
                    file_id,
                    "system",
                    {"code": notification_code, "fileName": name},
                )
            conn.commit()
    except Exception:
        log.warning("could not notify for file %s", file_id, exc_info=True)
    if notification is not None:
        user_id = str(notification.pop("userId"))
        progress.publish_notification(user_id, notification)
    return True


def _finish_fail(
    file_id: str | None,
    job_id: str,
    error: str,
    attempt: int | None = None,
    reservation_id: str = "",
    source_revision: int | None = None,
    source_etag: str = "",
    actor_user_id: str = "",
    workspace_id: str = "",
    error_category: str = "",
    error_code: str = "",
) -> bool:
    with db.connect() as conn:
        with conn.cursor() as cur:
            boundary_payload = None
            if file_id and source_revision is not None:
                boundary_payload = {
                    "actorUserId": actor_user_id,
                    "fileId": file_id,
                    "reservationId": reservation_id,
                    "sourceETag": source_etag,
                    "sourceRevision": source_revision,
                    "workspaceId": workspace_id,
                }
            if _lost_claim(cur, job_id, attempt, boundary_payload):
                return False
            if file_id:
                if source_revision is not None and boundary_payload is None:
                    db.require_current_file_source(
                        cur, file_id, source_revision, source_etag
                    )
                db.set_file_status(cur, file_id, "failed")
                db.set_file_indexed(cur, file_id, False)
                db.set_file_preview_blob(cur, file_id, None)
            db.set_job(cur, job_id, "failed", error[:500])
            db.close_credit_reservation(cur, reservation_id)
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="failed",
                snapshot=telemetry.snapshot(),
                error_category=error_category,
                error_code=error_code,
            )
        conn.commit()
    return True


def _finish_job_ok(job_id: str, attempt: int | None = None) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
            db.set_job(cur, job_id, "done")
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="succeeded",
                snapshot=telemetry.snapshot(),
            )
        conn.commit()


def _finish_superseded(
    job_id: str,
    attempt: int,
    reservation_id: str,
) -> None:
    """Close a stale job without mutating or notifying for the replacement."""
    with db.connect() as conn, conn.cursor() as cur:
        if not _lost_claim(cur, job_id, attempt):
            db.set_job(cur, job_id, "failed", "superseded by file replacement")
        # Replacement may already have made the job terminal. The generated
        # attempt id still identifies this exact run and must be closed rather
        # than left permanently visible as running.
        db.finish_job_attempt(
            cur,
            attempt_id=telemetry.current_attempt_id(),
            outcome="superseded",
            snapshot=telemetry.snapshot(),
            error_category="superseded",
            error_code="source_superseded",
        )
        # Replacement normally closes this while canceling the old job. This
        # also covers the SKIP LOCKED race where the worker held the job row.
        db.close_credit_reservation(cur, reservation_id)
        conn.commit()


def _requeue(
    job: dict, error: str, *, error_category: str = "", error_code: str = ""
) -> str:
    job_type = (job.get("type") or "").strip()
    policy = policy_for(job_type)
    payload = job.get("payload") or {}
    attempt = int(job.get("attempts") or 1)
    # Only parse/ingest payloads carry a source boundary to lock; an import
    # fences on the bare claim.
    boundary_payload = payload if job_type in {"parse", "ingest"} else None
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt, boundary_payload):
            return "stale"
        outcome = db.requeue_job(
            cur,
            job_id=job["id"],
            job_type=job_type,
            workspace_id=payload.get("workspaceId"),
            error=error,
            backoff_s=backoff_s(policy, attempt),
        )
        cur.execute("SELECT not_before FROM jobs WHERE id=%s", (job["id"],))
        row = cur.fetchone()
        db.finish_job_attempt(
            cur,
            attempt_id=telemetry.current_attempt_id(),
            outcome="retrying",
            snapshot=telemetry.snapshot(),
            error_category=error_category,
            error_code=error_code,
            retryable=True,
            next_retry_at=row[0] if row else None,
        )
        conn.commit()
    return outcome


def _reservation_id(payload: dict) -> str:
    return str(payload.get("reservationId") or "")


def _notify_ingest_terminal(
    file_id: str | None,
    ws: str | None,
    job_id: str,
    error: str,
    attempt: int | None = None,
    payload: dict | None = None,
    error_category: str = "",
    error_code: str = "",
) -> None:
    reservation_id = _reservation_id(payload or {})
    if not file_id:
        with db.connect() as conn, conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
            db.set_job(cur, job_id, "failed", error[:500])
            db.close_credit_reservation(cur, reservation_id)
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="failed",
                snapshot=telemetry.snapshot(),
                error_category=error_category,
                error_code=error_code,
            )
            conn.commit()
        return
    name = _read_name(file_id)
    source_revision = payload.get("sourceRevision") if payload else None
    committed = _finish_fail(
        file_id=file_id,
        job_id=job_id,
        error=error,
        attempt=attempt,
        reservation_id=reservation_id,
        source_revision=(int(source_revision) if source_revision is not None else None),
        source_etag=str((payload or {}).get("sourceETag") or ""),
        actor_user_id=str((payload or {}).get("actorUserId") or ""),
        workspace_id=str((payload or {}).get("workspaceId") or ws or ""),
        error_category=error_category,
        error_code=error_code,
    )
    if not committed:
        return
    if ws:
        progress.publish(
            ws,
            file_id,
            "failed",
            100,
            status="failed",
            message=error[:200],
            indexed=False,
        )
    log.info("ingest %s failed terminally: %s", name, error)


def _read_name(file_id: str) -> str:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_name(cur, file_id)


def _account_allows_ingest(file_id: str, payload: dict) -> bool:
    """Claim-time gate: owner lifecycle/storage, actor lifecycle/credits.

    A missing actor is refused rather than waved through. It used to mean "no
    actor, nothing to check", which let a job parse, caption and embed
    and against three providers while billing nobody. The gateway will not
    enqueue without one, so reaching here without an actor means the row was
    written around it.
    """
    actor = payload.get("actorUserId") or ""
    if not actor:
        return False
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor):
            return False
        owner = db.file_owner_user_id(cur, file_id)
        if not owner or not db.account_allows_ingest(
            cur, owner, allow_over_quota=bool(payload.get("quotaRecovery"))
        ):
            return False
        return db.actor_has_credits(cur, actor)


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _record_parse_artifact(
    file_id: str,
    key: str,
    fingerprint: str,
    version: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor_user_id):
            raise TerminalError(
                "ingest stopped because an account is suspended or deleting"
            )
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_parse_artifact(cur, file_id, key, fingerprint, version)
        conn.commit()


def _record_caption_blob(
    file_id: str,
    key: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor_user_id):
            raise TerminalError(
                "ingest stopped because an account is suspended or deleting"
            )
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_caption_blob(cur, file_id, key)
        conn.commit()


def _record_caption_blob_best_effort(
    file_id: str,
    key: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> None:
    """Record optional cache identity without making ingest depend on it."""
    try:
        _record_caption_blob(
            file_id,
            key,
            source_revision,
            source_etag,
            actor_user_id,
        )
    except Exception:
        log.warning(
            "could not record optional caption cache identity for file %s",
            file_id,
            exc_info=True,
        )


def _record_preview_blob(
    file_id: str,
    key: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor_user_id):
            raise TerminalError(
                "ingest stopped because an account is suspended or deleting"
            )
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_preview_blob(cur, file_id, key)
        conn.commit()


def _clear_preview_blob(
    file_id: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
    *,
    job_id: str,
    attempt: int,
    workspace_id: str,
    reservation_id: str,
) -> bool:
    """Clear a preview only while the installing attempt still owns the job."""
    payload = {
        "actorUserId": actor_user_id,
        "fileId": file_id,
        "reservationId": reservation_id,
        "sourceETag": source_etag,
        "sourceRevision": source_revision,
        "workspaceId": workspace_id,
    }
    with db.connect() as conn, conn.cursor() as cur:
        boundary = db.lock_pipeline_claim_boundary(
            cur,
            job_id=job_id,
            attempt=attempt,
            payload=payload,
        )
        if boundary != "current":
            conn.commit()
            return False
        db.set_file_preview_blob(cur, file_id, None)
        conn.commit()
    return True


def _record_source_sha(
    file_id: str,
    source_sha256: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor_user_id):
            raise TerminalError(
                "ingest stopped because an account is suspended or deleting"
            )
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_source_sha256(cur, file_id, source_sha256)
        conn.commit()


def _remember_local_source(
    job_id: str,
    attempt: int,
    source_key: str,
    source_sha256: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if not db.set_job_local_source(
            cur,
            job_id=job_id,
            attempt=attempt,
            source_key=source_key,
            source_sha256=source_sha256,
        ):
            raise RetryableError("ingest lost its job claim while saving the source")
        conn.commit()


def _cleanup_payload_source(payload: dict) -> None:
    descriptor = payload.get("localSource")
    if not isinstance(descriptor, dict):
        return
    blobstore.cleanup_local_source(
        str(descriptor.get("key") or ""), cfg.parse_shared_dir
    )


def _acquire_local_source(
    job: dict, payload: dict, blob_path: str
) -> tuple[str, str, str, Callable[[], None]]:
    descriptor = payload.get("localSource")
    if isinstance(descriptor, dict):
        try:
            return blobstore.reuse_local_hashed(
                str(descriptor.get("key") or ""),
                str(descriptor.get("sha256") or ""),
                cfg.parse_shared_dir,
            )
        except (FileNotFoundError, ValueError):
            log.warning(
                "local source descriptor is stale; fetching B2 object again",
                extra={"job_id": job["id"]},
            )

    local_path, source_key, source_sha256, cleanup = blobstore.fetch_local_hashed(
        blob_path, cfg.parse_shared_dir
    )
    try:
        _remember_local_source(
            job["id"], int(job.get("attempts") or 1), source_key, source_sha256
        )
    except Exception:
        cleanup()
        raise
    payload["localSource"] = {"key": source_key, "sha256": source_sha256}
    return local_path, source_key, source_sha256, cleanup


def _touch_or_upsert_artifact(
    *,
    object_path: str,
    kind: str,
    source_sha256: str,
    size_bytes: int = 0,
    strict: bool = False,
) -> bool:
    """Register a cache object and reject a row whose object was reaped."""
    try:
        with db.connect() as conn, conn.cursor() as cur:
            db.upsert_artifact_cache(
                cur,
                object_path=object_path,
                kind=kind,
                source_sha256=source_sha256,
                size_bytes=size_bytes,
            )
            conn.commit()
    except Exception:
        if strict:
            raise
        log.warning(
            "could not register optional cache object %s; current ingest will continue",
            object_path,
            exc_info=True,
        )
        return False
    try:
        info = blobstore.object_info(object_path)
        if info is not None:
            return True
    except Exception:
        if strict:
            raise
        log.warning(
            "could not verify optional cache object %s; dropping its cache row",
            object_path,
            exc_info=True,
        )
    try:
        with db.connect() as conn, conn.cursor() as cur:
            db.drop_artifact_cache(cur, object_path)
            conn.commit()
    except Exception:
        if strict:
            raise
        log.warning(
            "could not drop unverified cache row %s", object_path, exc_info=True
        )
    if strict:
        raise RetryableError(f"required cache object {object_path} is missing")
    log.warning("cache object %s vanished before registration completed", object_path)
    return False


def _clear_parse_artifact_reference(
    object_path: str | None,
    file_id: str | None = None,
    source_revision: int | None = None,
    source_etag: str = "",
) -> None:
    if not object_path:
        return
    with db.connect() as conn, conn.cursor() as cur:
        if file_id:
            if source_revision is not None:
                db.require_current_file_source(
                    cur, file_id, source_revision, source_etag
                )
            db.clear_file_parse_artifact(cur, file_id)
        conn.commit()


def _office_preview_key(
    source_sha256: str, parser_version: str, fingerprint: str
) -> str:
    return f"previews/{source_sha256}/{parser_version}/{fingerprint}.pdf"


def _office_preview_size(info: dict | None) -> int | None:
    if info is None:
        return None
    size_bytes = int(info.get("size") or 0)
    if not 0 < size_bytes <= cfg.office_preview_max_bytes:
        return None
    return size_bytes


def _existing_office_preview_bytes(key: str, info: dict | None) -> bytes | None:
    """Return a bounded, validated PDF object instead of trusting HEAD size."""
    size_bytes = _office_preview_size(info)
    if size_bytes is None:
        return None
    content_type = str((info or {}).get("content_type") or "").split(";", 1)[0]
    if content_type.strip().lower() != "application/pdf":
        return None
    data = blobstore.read_bytes(key, cfg.office_preview_max_bytes)
    if data is None or len(data) != size_bytes or not data.startswith(b"%PDF-"):
        return None
    return data


def _cache_office_preview(
    *,
    raw_dir: Path,
    file_id: str,
    source_sha256: str,
    parser_version: str,
    fingerprint: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> str | None:
    preview = raw_dir / "preview.pdf"
    if not preview.is_file():
        return None
    local_size = preview.stat().st_size
    if not 0 < local_size <= cfg.office_preview_max_bytes:
        log.warning(
            "refusing Office preview for %s: %s bytes exceeds the %s-byte limit",
            file_id,
            local_size,
            cfg.office_preview_max_bytes,
        )
        return None
    with preview.open("rb") as handle:
        data = handle.read(cfg.office_preview_max_bytes + 1)
    if (
        len(data) != local_size
        or len(data) > cfg.office_preview_max_bytes
        or not data.startswith(b"%PDF-")
    ):
        log.warning("refusing invalid Office preview for %s", file_id)
        return None
    key = _office_preview_key(source_sha256, parser_version, fingerprint)
    info = blobstore.object_info(key)
    existing = _existing_office_preview_bytes(key, info) if info is not None else None
    if existing != data:
        if info is not None:
            log.warning("replacing invalid cached Office preview %s", key)
        blobstore.write_bytes(key, data, "application/pdf")
    size_bytes = len(data)
    _touch_or_upsert_artifact(
        object_path=key,
        kind="office_preview",
        source_sha256=source_sha256,
        size_bytes=size_bytes,
        strict=True,
    )
    _record_preview_blob(file_id, key, source_revision, source_etag, actor_user_id)
    return key


def _reuse_office_preview(
    *,
    file_id: str,
    source_sha256: str,
    preview_blob_path: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> bool:
    if not preview_blob_path:
        return False
    try:
        info = blobstore.object_info(preview_blob_path)
        data = _existing_office_preview_bytes(preview_blob_path, info)
    except Exception:
        log.warning("could not validate donor Office preview", exc_info=True)
        return False
    if data is None:
        return False
    _touch_or_upsert_artifact(
        object_path=preview_blob_path,
        kind="office_preview",
        source_sha256=source_sha256,
        size_bytes=len(data),
        strict=True,
    )
    _record_preview_blob(
        file_id, preview_blob_path, source_revision, source_etag, actor_user_id
    )
    return True


def _donor_office_preview(name: str, donor: dict) -> str | None:
    """Return an existing exact preview, or refuse Office donor reuse."""
    if Path(name).suffix.lower() not in parser_client.OFFICE_SUFFIXES:
        return ""
    preview_blob_path = str(donor.get("preview_blob_path") or "")
    if not preview_blob_path:
        return None
    try:
        info = blobstore.object_info(preview_blob_path)
        data = _existing_office_preview_bytes(preview_blob_path, info)
    except Exception:
        log.warning("could not validate donor Office preview", exc_info=True)
        return None
    if data is None:
        return None
    return preview_blob_path


def _set_file_status(
    file_id: str,
    status: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor_user_id):
            raise TerminalError(
                "ingest stopped because an account is suspended or deleting"
            )
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_status(cur, file_id, status)
        conn.commit()


def _yield_for_capacity(
    job: dict,
    file_id: str,
    workspace_id: str,
    name: str,
    source_revision: int,
    source_etag: str,
    actor_user_id: str,
    message: str = "waiting for a parser slot",
    backoff_s: int = slots.YIELD_BACKOFF_S,
    outcome: str = "capacity_wait",
) -> None:
    """Give the parse slot back to the queue. File stays pending; attempt is undone."""
    attempt = int(job.get("attempts") or 1)
    payload = job.get("payload") or {}
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt, payload):
            return
        db.release_job_for_capacity(cur, job["id"], attempt, backoff_s=backoff_s)
        db.set_file_status(cur, file_id, "pending")
        cur.execute("SELECT not_before FROM jobs WHERE id=%s", (job["id"],))
        row = cur.fetchone()
        db.finish_job_attempt(
            cur,
            attempt_id=telemetry.current_attempt_id(),
            outcome=outcome,
            snapshot=telemetry.snapshot(),
            error_category="capacity" if outcome == "capacity_wait" else "provider",
            error_code=outcome,
            next_retry_at=row[0] if row else None,
        )
        conn.commit()
    progress.publish(
        workspace_id,
        file_id,
        "queued",
        5,
        status="pending",
        message=f"{name}: {message}",
    )
    log.info("ingest %s %s", name, message)


def _file_exists(file_id: str) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_exists(cur, file_id)


def _require_current_source(
    file_id: str, source_revision: int, source_etag: str
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        conn.commit()


def _pipeline_identity(
    processing_plan: ingest_plan.ProcessingPlan,
) -> str:
    if processing_plan.route == ingest_plan.RAW_TEXT:
        direct = "direct:text"
    elif processing_plan.route == ingest_plan.DELIMITED_TEXT:
        direct = f"direct:tabular:{cfg.tabular_text_version}"
    elif processing_plan.route == ingest_plan.IMAGE_CAPTION:
        direct = f"direct:image:{cfg.caption_version}"
    elif processing_plan.route == ingest_plan.AUDIO_TRANSCRIPTION:
        direct = f"direct:elevenlabs:{cfg.elevenlabs_transcript_version}"
    else:
        direct = ""
    if direct:
        return f"plan-v{processing_plan.version}:{direct}:{CHUNKER_VERSION}"
    route = _parse_route(processing_plan.parser_route)
    cap = cfg.caption_version if processing_plan.caption_embedded_images else "none"
    return (
        f"plan-v{processing_plan.version}:{cfg.parse_method}:{route}:"
        f"{parser_client.parser_version(route)}"
        f":{cap}:{CHUNKER_VERSION}"
    )


def _record_parse_usage_tx(
    cur,
    *,
    usage: obs.ParseUsage,
    file_id: str,
    workspace_id: str,
    actor_user_id: str,
    reservation_id: str,
    job_id: str,
    attempt: int,
    outcome: str,
) -> None:
    if usage.is_empty():
        return
    db.record_job_parse_metrics(
        cur,
        attempt_id=telemetry.current_attempt_id(),
        pages=usage.pages,
        ocr_pages=usage.ocr_pages,
        slices=usage.slices,
        queue_milliseconds=usage.queue_milliseconds,
        execution_milliseconds=usage.execution_milliseconds,
    )
    db.record_usage_event(
        cur,
        actor_user_id=actor_user_id,
        workspace_id=workspace_id,
        kind="parse",
        surface="ingest",
        provider="netcup-ingest",
        units=usage.pages,
        unit="pages",
        parse_pages=usage.pages,
        parse_ocr_pages=usage.ocr_pages,
        parse_cpu_milliseconds=usage.cpu_milliseconds,
        parse_elapsed_milliseconds=usage.elapsed_milliseconds,
        parse_queue_milliseconds=usage.queue_milliseconds,
        parse_download_milliseconds=usage.download_milliseconds,
        parse_upload_milliseconds=usage.upload_milliseconds,
        parse_worker_rss_bytes=usage.worker_rss_bytes,
        parse_worker_pss_bytes=usage.worker_pss_bytes,
        parse_io_read_bytes=usage.io_read_bytes,
        parse_io_write_bytes=usage.io_write_bytes,
        credit_micros=db.credits_for_parse_pages(
            usage.pages,
            usage.ocr_pages,
            digital_rate=_rate(_RESOURCE_DIGITAL_PAGE)["creditMicrosPerUnit"],
            ocr_rate=_rate(_RESOURCE_OCR_PAGE)["creditMicrosPerUnit"],
        ),
        reservation_id=reservation_id,
        idempotency_key=(
            f"parse-receipt:{usage.receipt_id}"
            if usage.receipt_id
            else f"parse:{job_id}:{attempt}"
        ),
        trace_id=obs.trace_id(),
        metadata={
            "fileId": file_id,
            "jobId": job_id,
            "attempt": attempt,
            "outcome": outcome,
            "parseMethod": usage.method,
            "sourceFormat": usage.source_format,
            "parseReceiptId": usage.receipt_id,
            "digitalPageRate": _rate(_RESOURCE_DIGITAL_PAGE),
            "ocrPageRate": _rate(_RESOURCE_OCR_PAGE),
        },
    )


def _record_parse_attempt(
    file_id: str,
    workspace_id: str,
    actor_user_id: str,
    reservation_id: str,
    job_id: str,
    attempt: int,
    outcome: str,
    payload: dict,
) -> None:
    """Persist one page-priced parse attempt before changing the job state."""
    usage = obs.take_parse_usage()
    if usage.is_empty():
        return
    try:
        with db.connect() as conn, conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt, payload):
                return
            _record_parse_usage_tx(
                cur,
                usage=usage,
                file_id=file_id,
                workspace_id=workspace_id,
                actor_user_id=actor_user_id,
                reservation_id=reservation_id,
                job_id=job_id,
                attempt=attempt,
                outcome=outcome,
            )
            conn.commit()
    except Exception:
        # Keep the receipt in this context if the database write failed. The job
        # stays running, so its lease/retry path can try the same idempotency key.
        obs.record_parse_usage(
            pages=usage.pages,
            ocr_pages=usage.ocr_pages,
            cpu_milliseconds=usage.cpu_milliseconds,
            elapsed_milliseconds=usage.elapsed_milliseconds,
            queue_milliseconds=usage.queue_milliseconds,
            execution_milliseconds=usage.execution_milliseconds,
            slices=usage.slices,
            download_milliseconds=usage.download_milliseconds,
            upload_milliseconds=usage.upload_milliseconds,
            worker_rss_bytes=usage.worker_rss_bytes,
            worker_pss_bytes=usage.worker_pss_bytes,
            io_read_bytes=usage.io_read_bytes,
            io_write_bytes=usage.io_write_bytes,
            method=usage.method,
            source_format=usage.source_format,
            receipt_id=usage.receipt_id,
        )
        raise


def _handoff_parsed_artifact(
    *,
    job: dict,
    payload: dict,
    file_id: str,
    workspace_id: str,
    artifact: dict,
) -> bool:
    """Finish the parse claim and enqueue its ingest continuation atomically."""
    attempt = int(job.get("attempts") or 1)
    continuation_artifact = dict(artifact)
    durable_key = str(continuation_artifact.get("durableKey") or "")
    local_source = payload.get("localSource")
    source_sha256 = (
        str(local_source.get("sha256") or "") if isinstance(local_source, dict) else ""
    )
    if durable_key and not _touch_or_upsert_artifact(
        object_path=durable_key,
        kind="parse_bundle",
        source_sha256=source_sha256,
        size_bytes=max(0, int(continuation_artifact.get("size") or 0)),
    ):
        continuation_artifact.pop("durableKey", None)
    continuation_payload = dict(payload)
    continuation_payload["parseArtifact"] = continuation_artifact
    continuation_payload["parseJobId"] = job["id"]
    continuation_id = f"{job['id']}_ingest"
    usage = obs.take_parse_usage()
    try:
        with db.connect() as conn, conn.cursor() as cur:
            if _lost_claim(cur, job["id"], attempt, payload):
                return False
            _record_parse_usage_tx(
                cur,
                usage=usage,
                file_id=file_id,
                workspace_id=workspace_id,
                actor_user_id=str(payload.get("actorUserId") or ""),
                reservation_id=_reservation_id(payload),
                job_id=job["id"],
                attempt=attempt,
                outcome="succeeded",
            )
            db.enqueue_job(cur, continuation_id, "ingest", continuation_payload)
            db.set_job(cur, job["id"], "done")
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="succeeded",
                snapshot=telemetry.snapshot(),
            )
            conn.commit()
    except Exception:
        obs.record_parse_usage(
            pages=usage.pages,
            ocr_pages=usage.ocr_pages,
            cpu_milliseconds=usage.cpu_milliseconds,
            elapsed_milliseconds=usage.elapsed_milliseconds,
            queue_milliseconds=usage.queue_milliseconds,
            execution_milliseconds=usage.execution_milliseconds,
            slices=usage.slices,
            download_milliseconds=usage.download_milliseconds,
            upload_milliseconds=usage.upload_milliseconds,
            worker_rss_bytes=usage.worker_rss_bytes,
            worker_pss_bytes=usage.worker_pss_bytes,
            io_read_bytes=usage.io_read_bytes,
            io_write_bytes=usage.io_write_bytes,
            method=usage.method,
            source_format=usage.source_format,
            receipt_id=usage.receipt_id,
        )
        raise
    return True


def _handoff_for_artifact_repair(
    *,
    job: dict,
    payload: dict,
    file_id: str,
) -> bool:
    """Return one invalid post-parse artifact to parsing exactly once."""
    attempt = int(job.get("attempts") or 1)
    repair_payload = dict(payload)
    repair_payload.pop("parseArtifact", None)
    repair_payload["artifactRepairAttempts"] = 1
    repair_payload["repairingIngestJobId"] = job["id"]
    repair_id = f"{job['id']}_parse"
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt, payload):
            return False
        db.clear_file_parse_artifact(cur, file_id)
        db.enqueue_job(cur, repair_id, "parse", repair_payload)
        db.set_job(cur, job["id"], "done")
        db.set_file_status(cur, file_id, "pending")
        db.finish_job_attempt(
            cur,
            attempt_id=telemetry.current_attempt_id(),
            outcome="succeeded",
            snapshot=telemetry.snapshot(),
        )
        conn.commit()
    return True


async def _ensure_document_artifact(
    *,
    job: dict,
    payload: dict,
    name: str,
    processing_plan: ingest_plan.ProcessingPlan,
    source_key: str,
    source_sha256: str,
    workspace_id: str,
    file_id: str,
) -> dict:
    """Run only the document parse stage and return its immutable artifact."""
    _set_stage("parser_admission")
    route = _parse_route(processing_plan.parser_route)
    descriptor = parser_client.source_descriptor(
        source_key=source_key,
        source_sha256=source_sha256,
        route=route,
    )
    held_slot = await asyncio.to_thread(slots.try_acquire, route, job["id"])
    if not held_slot:
        raise CapacityWait(route)
    try:
        await asyncio.to_thread(
            _set_file_status,
            file_id,
            "processing",
            int(payload["sourceRevision"]),
            str(payload.get("sourceETag") or ""),
            str(payload.get("actorUserId") or ""),
        )
        progress.publish(workspace_id, file_id, "parsing", 15, status="processing")
        try:
            _set_stage("mineru_parse")
            artifact = await asyncio.to_thread(
                parser_client.ensure_artifact,
                descriptor,
                name,
                job["id"],
            )
        except parser_client.ParserTerminalResourceError as exc:
            raise TerminalError(
                "this file hit a terminal parser resource limit and is "
                "quarantined for the current parser version"
            ) from exc
        except parser_client.ParserCapacityError as exc:
            raise CapacityWait(route) from exc
    finally:
        await asyncio.to_thread(slots.release, route, job["id"])

    artifact_key = str(artifact.get("key") or "")
    fingerprint = str(artifact.get("fingerprint") or "")
    version = str(artifact.get("version") or "")
    if not artifact_key or not fingerprint or not version:
        raise RetryableError("parser returned an incomplete artifact descriptor")
    durable_key = await asyncio.to_thread(
        parser_client.publish_durable_artifact,
        artifact,
        route=route,
        require_office_preview=processing_plan.office_preview,
    )
    if durable_key:
        artifact["durableKey"] = durable_key
    telemetry.record(artifact_bytes=max(0, int(artifact.get("size") or 0)))
    _set_stage("parse_handoff")
    await asyncio.to_thread(
        _record_parse_artifact,
        file_id,
        artifact_key,
        fingerprint,
        version,
        int(payload["sourceRevision"]),
        str(payload.get("sourceETag") or ""),
        str(payload.get("actorUserId") or ""),
    )
    return artifact


# ------------------------------------------------------------------ parsing


async def _chunks_for(
    *,
    payload: dict,
    name: str,
    processing_plan: ingest_plan.ProcessingPlan,
    local_path: str | None,
    source_key: str,
    ws: str,
    file_id: str,
    source_sha256: str,
    job_id: str | None = None,
) -> tuple[list[Chunk], str | None, str | None, str | None]:
    """Parse one source into chunks, plus its parse-artifact identity if any."""
    blob_path = payload.get("blobPath")
    source_revision = int(payload.get("sourceRevision") or 0)
    source_etag = str(payload.get("sourceETag") or "")

    if processing_plan.route == ingest_plan.RAW_TEXT:
        if not local_path:
            raise RetryableError("local text source is missing")
        if job_id:
            await asyncio.to_thread(
                _set_file_status,
                file_id,
                "processing",
                source_revision,
                source_etag,
                str(payload.get("actorUserId") or ""),
            )
        _set_stage("text_normalization")
        text = await asyncio.to_thread(_read_text, local_path)
        progress.publish(ws, file_id, "indexing", 40, status="processing")
        return chunk_markdown(text), None, None, None

    direct = {
        ingest_plan.IMAGE_CAPTION: "image",
        ingest_plan.AUDIO_TRANSCRIPTION: "audio",
        ingest_plan.DELIMITED_TEXT: "tabular",
    }.get(processing_plan.route)
    if direct:
        if job_id:
            await asyncio.to_thread(
                _set_file_status,
                file_id,
                "processing",
                source_revision,
                source_etag,
                str(payload.get("actorUserId") or ""),
            )
        progress.publish(
            ws,
            file_id,
            "captioning"
            if direct == "image"
            else "transcribing"
            if direct == "audio"
            else "indexing",
            20,
            status="processing",
        )
        derived_key = ""
        derived_size = 0
        if direct == "image":
            if not local_path:
                raise RetryableError("local image source is missing")
            _set_stage("image_caption")
            (
                text,
                derived_key,
                derived_size,
                caption_cached,
            ) = await source_text.caption_image_source(
                local_path=local_path,
                name=name,
                source_sha256=source_sha256,
            )
            telemetry.record(
                figures_selected=1,
                figures_cached=1 if caption_cached else 0,
                figures_captioned=0 if caption_cached else 1,
                figures_applied=1,
            )
        elif direct == "audio":
            _set_stage("audio_transcription")
            (
                text,
                derived_key,
                derived_size,
            ) = await source_text.transcribe_audio_source(
                local_path=local_path,
                source_sha256=source_sha256,
                blob_path=str(blob_path),
                audio_rate=_rate(_RESOURCE_AUDIO_SECOND),
            )
        else:
            if not local_path:
                raise RetryableError("local delimited source is missing")
            _set_stage("tabular_normalization")
            text = await asyncio.to_thread(source_text.tabular_text, local_path, name)
        if derived_key:
            registered = await asyncio.to_thread(
                _touch_or_upsert_artifact,
                object_path=derived_key,
                kind="derived_text",
                source_sha256=source_sha256,
                size_bytes=derived_size,
            )
            if registered:
                await asyncio.to_thread(
                    _record_caption_blob_best_effort,
                    file_id,
                    derived_key,
                    source_revision,
                    source_etag,
                    str(payload.get("actorUserId") or ""),
                )
        progress.publish(ws, file_id, "indexing", 50, status="processing")
        return chunk_markdown(text), None, None, None

    if processing_plan.route != ingest_plan.DOCUMENT_PARSE:
        raise TerminalError(f"unsupported processing route {processing_plan.route!r}")
    route = _parse_route(processing_plan.parser_route)
    artifact = payload.get("parseArtifact")
    if not isinstance(artifact, dict):
        raise TerminalError("document ingest has no completed parse artifact")
    raw_dir = Path(tempfile.mkdtemp(prefix="capy_parse_"))
    try:
        _set_stage("artifact_extract")
        content_list = await asyncio.to_thread(
            parser_client.extract_artifact,
            artifact,
            raw_dir,
            route=route,
            require_office_preview=processing_plan.office_preview,
        )
        artifact_key = str(artifact.get("key") or "")
        fingerprint = str(artifact.get("fingerprint") or "")
        artifact_version = str(artifact.get("version") or "")
        if artifact_key:
            await asyncio.to_thread(
                _record_parse_artifact,
                file_id,
                artifact_key,
                fingerprint,
                artifact_version,
                source_revision,
                source_etag,
                str(payload.get("actorUserId") or ""),
            )
        preview_path = raw_dir / "preview.pdf"
        published_preview = None
        if preview_path.is_file():
            published_preview = await asyncio.to_thread(
                _cache_office_preview,
                raw_dir=raw_dir,
                file_id=file_id,
                source_sha256=source_sha256,
                parser_version=artifact_version,
                fingerprint=fingerprint,
                source_revision=source_revision,
                source_etag=source_etag,
                actor_user_id=str(payload.get("actorUserId") or ""),
            )
        if processing_plan.office_preview and not published_preview:
            raise RetryableError("required Office preview could not be published")
        progress.publish(
            ws,
            file_id,
            "captioning" if processing_plan.caption_embedded_images else "indexing",
            45,
        )
        if processing_plan.caption_embedded_images:
            # Before chunking on purpose: a caption has to be inside the passage
            # it belongs to before that passage is embedded and summarized, or
            # the figure stays invisible to both.
            _set_stage("figure_captioning")
            counts = await figures.caption_figures(
                content_list=content_list,
                raw_dir=raw_dir,
                file_name=name,
                source_sha256=source_sha256,
            )
            log.info("captioned figures for %s: %s", name, counts)
            selected = max(0, int(counts.get("selected") or 0))
            captioned = max(0, int(counts.get("captioned") or 0))
            cached = max(0, int(counts.get("cached") or 0))
            telemetry.record(
                figures_selected=selected,
                figures_cached=cached,
                figures_captioned=captioned,
                figures_decorative=max(0, int(counts.get("decorative") or 0)),
                figures_applied=max(0, int(counts.get("applied") or 0)),
                figures_failed=max(0, selected - cached - captioned),
            )
            if counts.get("key"):
                registered = await asyncio.to_thread(
                    _touch_or_upsert_artifact,
                    object_path=str(counts["key"]),
                    kind="captions",
                    source_sha256=source_sha256,
                )
                if registered:
                    await asyncio.to_thread(
                        _record_caption_blob_best_effort,
                        file_id,
                        str(counts["key"]),
                        source_revision,
                        source_etag,
                        str(payload.get("actorUserId") or ""),
                    )
        _set_stage("chunking")
        progress.publish(ws, file_id, "indexing", 55)
        return (
            chunk_content_list(content_list),
            artifact_key,
            fingerprint,
            artifact_version,
        )
    finally:
        shutil.rmtree(raw_dir, ignore_errors=True)


# ------------------------------------------------------------------- jobs


def _require_ingest_payload(payload: dict) -> None:
    missing = [
        key
        for key in _REQUIRED_INGEST_STRINGS
        if not str(payload.get(key) or "").strip()
    ]
    for key in _REQUIRED_INGEST_INTS:
        if key not in payload or payload[key] is None:
            missing.append(key)
    for key in _REQUIRED_INGEST_KEYS:
        if key not in payload or payload[key] is None:
            missing.append(key)
    if missing:
        raise TerminalError(f"ingest payload missing {', '.join(missing)}")


async def process_job(job: dict) -> None:
    job_type = (job.get("type") or "").strip()
    policy_for(job_type)
    if job_type == "import":
        await import_stage.process(job)
        return
    if job_type not in {"parse", "ingest"}:
        raise TerminalError(f"unknown job type {job_type!r}")
    await process_ingest_job(job)


async def process_ingest_job(job: dict) -> None:
    _set_stage("validating")
    payload = job["payload"] or {}
    _require_ingest_payload(payload)
    file_id = payload["fileId"]
    ws = payload["workspaceId"]
    kind = str(payload["kind"]).lower()
    processing_plan = ingest_plan.require(payload.get("processingPlan"))
    job_type = str(job.get("type") or "ingest")
    if job_type == "parse" and processing_plan.route != ingest_plan.DOCUMENT_PARSE:
        raise TerminalError("parse job does not select document parsing")
    if (
        job_type == "ingest"
        and processing_plan.route == ingest_plan.DOCUMENT_PARSE
        and (
            not isinstance(payload.get("parseArtifact"), dict)
            or not str(payload.get("parseJobId") or "").strip()
        )
    ):
        raise TerminalError("document ingest has no completed parse handoff")
    rates = payload.get("resourceRates")
    if not isinstance(rates, dict) or not _REQUIRED_RESOURCE_RATES.issubset(rates):
        raise TerminalError("ingest payload is missing resource rate snapshots")

    try:
        pins = registry.pins_from_payload(
            payload, embedding=await _workspace_embedding_spec(ws)
        )
    except (registry.RegistryError, TerminalError) as exc:
        raise TerminalError(
            f"ingest refused because its model pins could not be resolved: {exc}"
        ) from exc

    registry.set_job_pins(pins)
    rates_token = _resource_rates.set(rates)
    accounting_token = None
    try:
        accounting_token = accounting.bind_ingest(
            _reservation_id(payload),
            rates,
            job_attempt_id=telemetry.current_attempt_id(),
            job_stage=telemetry.current_stage(),
        )
        await _process_ingest_job(job, payload, file_id, ws, kind, processing_plan)
    except CapacityWait:
        name = await asyncio.to_thread(_read_name, file_id)
        await asyncio.to_thread(
            _yield_for_capacity,
            job,
            file_id,
            ws,
            name,
            int(payload["sourceRevision"]),
            str(payload.get("sourceETag") or ""),
            str(payload.get("actorUserId") or ""),
            "waiting for provider capacity"
            if processing_plan.route == ingest_plan.AUDIO_TRANSCRIPTION
            else "waiting for a parser slot",
            slots.YIELD_BACKOFF_S,
            "capacity_wait",
        )
        raise
    finally:
        if accounting_token is not None:
            accounting.reset(accounting_token)
        _resource_rates.reset(rates_token)
        registry.set_job_pins(None)


async def _workspace_embedding_spec(workspace_id: str) -> registry.ModelConfig:
    """The embedding model this workspace was created with.

    Read from the workspace rather than taken from the payload or the registry
    default: the workspace's existing chunks are in this space, and there is no
    reindex job that could move them into another one.
    """
    pin = await store.workspace_embedding_pin(workspace_id)
    return registry.resolve_pinned(
        pin["embedding_provider_slug"],
        pin["embedding_model_slug"],
        pin["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )


async def _wait_for_content(
    association: dict,
    *,
    workspace_id: str,
    file_id: str,
    content_hash: str,
    claim_job_id: str,
    source_sha256: str | None = None,
    pipeline_identity: str | None = None,
    source_revision: int | None = None,
    source_etag: str = "",
) -> dict:
    """Wait for another worker's claim, stealing it if that worker looks dead.

    Returns only once this job owns the claim (``created``) or the content is
    ``ready``; the caller indexes into the row afterwards, so returning on a
    claim someone else holds would mean two workers writing the same content.
    The job wall-clock timeout is the hard bound — raising after a short wait
    would burn the waiter's attempt budget while a live creator is still
    indexing.
    """
    loop = asyncio.get_running_loop()
    steal_after = loop.time() + CONTENT_CLAIM_WAIT_S
    while not association["created"] and not association["ready"]:
        await asyncio.sleep(cfg.poll_interval)
        status = await store.content_status(association["content_id"])
        if status == "ready":
            association["ready"] = True
            break
        if status is not None and loop.time() < steal_after:
            continue
        # The claim is either gone (the creator abandoned it) or stale enough
        # that its owner looks dead. Either way, try to take it over; losing the
        # race just means waiting on whoever won it.
        await store.steal_stale_content(
            workspace_id=workspace_id,
            content_hash=content_hash,
            stale_s=CONTENT_CLAIM_STALE_S,
        )
        association = await store.attach_file_content(
            workspace_id=workspace_id,
            file_id=file_id,
            content_hash=content_hash,
            source_sha256=source_sha256,
            pipeline_identity=pipeline_identity,
            claim_job_id=claim_job_id,
            source_revision=source_revision,
            source_etag=source_etag,
        )
    return association


async def _reuse_donor(
    *,
    job: dict,
    payload: dict,
    file_id: str,
    ws: str,
    name: str,
    kind: str,
    route: str,
    donor: dict,
    identity: str,
    source_sha256: str,
    preview_blob_path: str = "",
) -> bool:
    """Copy a ready donor into this workspace. Returns False on a vanished donor."""
    pin = await store.workspace_embedding_pin(ws)
    copy_vectors = (
        donor.get("embedding_provider_slug") == pin["embedding_provider_slug"]
        and donor.get("embedding_model_slug") == pin["embedding_model_slug"]
        and donor.get("embedding_model_version") == pin["embedding_model_version"]
        and donor.get("embedding_dim") == pin["embedding_dim"]
    )
    attempt = int(job.get("attempts") or 1)
    source_revision = int(payload["sourceRevision"])
    source_etag = str(payload.get("sourceETag") or "")
    direct = {
        ingest_plan.IMAGE_CAPTION: "image",
        ingest_plan.AUDIO_TRANSCRIPTION: "audio",
    }.get(route)
    if direct in {"image", "audio"}:
        derived_key = source_text.artifact_key(source_sha256, direct)
        try:
            info = await asyncio.to_thread(blobstore.object_info, derived_key)
        except Exception:
            # Donor reuse is optional. A failed cache HEAD falls through to the
            # normal transformation instead of consuming a whole job attempt.
            log.warning(
                "could not inspect derived-text cache %s", derived_key, exc_info=True
            )
            return False
        if info is None:
            return False
        registered = await asyncio.to_thread(
            _touch_or_upsert_artifact,
            object_path=derived_key,
            kind="derived_text",
            source_sha256=source_sha256,
            size_bytes=int(info.get("size") or 0),
        )
        if registered:
            await asyncio.to_thread(
                _record_caption_blob_best_effort,
                file_id,
                derived_key,
                source_revision,
                source_etag,
                str(payload.get("actorUserId") or ""),
            )
    association = await store.attach_file_content(
        workspace_id=ws,
        file_id=file_id,
        content_hash=donor["content_hash"],
        source_sha256=source_sha256,
        pipeline_identity=identity,
        claim_job_id=job["id"],
        source_revision=source_revision,
        source_etag=source_etag,
    )
    association = await _wait_for_content(
        association,
        workspace_id=ws,
        file_id=file_id,
        content_hash=donor["content_hash"],
        claim_job_id=job["id"],
        source_sha256=source_sha256,
        pipeline_identity=identity,
        source_revision=source_revision,
        source_etag=source_etag,
    )
    if association["ready"]:
        if preview_blob_path and not await asyncio.to_thread(
            _reuse_office_preview,
            file_id=file_id,
            source_sha256=source_sha256,
            preview_blob_path=preview_blob_path,
            source_revision=source_revision,
            source_etag=source_etag,
            actor_user_id=str(payload.get("actorUserId") or ""),
        ):
            return False
        note = f"{name}: identical content already indexed; reusing its index."
        committed = await asyncio.to_thread(
            _finish_ok,
            file_id,
            name,
            job["id"],
            donor["content_hash"],
            None,
            None,
            None,
            "source_duplicate",
            attempt=attempt,
            actor_user_id=payload.get("actorUserId") or "",
            workspace_id=ws,
            reservation_id=_reservation_id(payload),
            source_revision=source_revision,
            source_etag=source_etag,
        )
        if not committed:
            return False
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=True
        )
        return True
    copied = await store.copy_content_from_donor(
        donor_id=donor["id"],
        dest_content_id=association["content_id"],
        dest_workspace_id=ws,
        copy_vectors=copy_vectors,
    )
    if not copied:
        await store.abandon_content(association["content_id"])
        await store.attach_file_content(
            workspace_id=ws,
            file_id=file_id,
            content_hash=donor["content_hash"],
            source_sha256=source_sha256,
            pipeline_identity=identity,
            claim_job_id=job["id"],
            source_revision=source_revision,
            source_etag=source_etag,
        )
        return False
    try:
        if copy_vectors:
            result = {"chunks": "copied", "donor": donor["id"]}
        else:
            result = await indexing.embed_copied_chunks(
                workspace_id=ws,
                content_id=association["content_id"],
                claim_job_id=job["id"],
                mark_ready=False,
            )
        if isinstance(result.get("chunks"), int):
            telemetry.record(chunks_created=max(0, int(result["chunks"])))
        if preview_blob_path and not await asyncio.to_thread(
            _reuse_office_preview,
            file_id=file_id,
            source_sha256=source_sha256,
            preview_blob_path=preview_blob_path,
            source_revision=source_revision,
            source_etag=source_etag,
            actor_user_id=str(payload.get("actorUserId") or ""),
        ):
            await store.abandon_content(association["content_id"])
            await store.attach_file_content(
                workspace_id=ws,
                file_id=file_id,
                content_hash=donor["content_hash"],
                source_sha256=source_sha256,
                pipeline_identity=identity,
                claim_job_id=job["id"],
                source_revision=source_revision,
                source_etag=source_etag,
            )
            return False
        await store.mark_content_ready(
            association["content_id"], claim_job_id=job["id"]
        )
    except BaseException:
        if preview_blob_path:
            await asyncio.to_thread(
                _clear_preview_blob,
                file_id,
                source_revision,
                source_etag,
                str(payload.get("actorUserId") or ""),
                job_id=str(job["id"]),
                attempt=attempt,
                workspace_id=ws,
                reservation_id=_reservation_id(payload),
            )
        await store.abandon_content(association["content_id"])
        raise
    committed = await asyncio.to_thread(
        _finish_ok,
        file_id,
        name,
        job["id"],
        donor["content_hash"],
        None,
        None,
        None,
        "source_duplicate",
        attempt=attempt,
        actor_user_id=payload.get("actorUserId") or "",
        workspace_id=ws,
        reservation_id=_reservation_id(payload),
        source_revision=source_revision,
        source_etag=source_etag,
    )
    if not committed:
        return False
    progress.publish(ws, file_id, "done", 100, status="ready", indexed=True)
    log.info("indexed %s from donor: %s", name, result)
    return True


async def _process_ingest_job(
    job: dict,
    payload: dict,
    file_id: str,
    ws: str,
    kind: str,
    processing_plan: ingest_plan.ProcessingPlan,
) -> None:
    _set_stage("validating_source")
    job_type = str(job.get("type") or "ingest")
    attempt = int(job.get("attempts") or 1)
    source_revision = int(payload["sourceRevision"])
    source_etag = str(payload.get("sourceETag") or "")
    if not await asyncio.to_thread(_file_exists, file_id):
        raise TerminalError("file no longer exists")
    name = await asyncio.to_thread(_read_name, file_id)
    if processing_plan.format != source_text.extension(name):
        raise TerminalError("processing plan format does not match source name")
    log.info(
        "executing processing plan v%s route=%s format=%s stages=%s resources=%s",
        processing_plan.version,
        processing_plan.route,
        processing_plan.format or "<none>",
        ",".join(processing_plan.stages),
        ",".join(processing_plan.resources),
    )
    await asyncio.to_thread(
        _require_current_source, file_id, source_revision, source_etag
    )
    _set_stage("admission_check")
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        note = f"{name}: ingest refused because the account is locked or over quota."
        committed = await asyncio.to_thread(
            _finish_fail,
            file_id=file_id,
            job_id=job["id"],
            error=note,
            attempt=attempt,
            reservation_id=_reservation_id(payload),
            source_revision=source_revision,
            source_etag=source_etag,
            actor_user_id=str(payload.get("actorUserId") or ""),
            workspace_id=ws,
            error_category="accounting",
            error_code="ingest_admission_refused",
        )
        if not committed:
            return
        progress.publish(
            ws, file_id, "failed", 100, status="failed", message=note, indexed=False
        )
        return
    progress.publish(ws, file_id, "queued", 5, status="pending")

    if processing_plan.route == ingest_plan.STORE_ONLY:
        _set_stage("store_only")
        note = f"{name}: stored without parsing (not indexed for retrieval)."
        committed = await asyncio.to_thread(
            _finish_ok,
            file_id,
            name,
            job["id"],
            notification_code="source_stored",
            indexed=False,
            attempt=attempt,
            actor_user_id=payload.get("actorUserId") or "",
            workspace_id=ws,
            reservation_id=_reservation_id(payload),
            source_revision=source_revision,
            source_etag=source_etag,
        )
        if not committed:
            return
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=False
        )
        return

    blob_path = payload.get("blobPath")
    if not blob_path:
        raise TerminalError("source blob is missing")
    try:
        _set_stage("source_download")
        (
            local_path,
            source_key,
            source_sha256,
            cleanup_source,
        ) = await asyncio.to_thread(_acquire_local_source, job, payload, str(blob_path))
    except FileNotFoundError as exc:
        raise TerminalError("source blob is missing") from exc
    if local_path:
        try:
            telemetry.record(source_bytes=max(0, Path(local_path).stat().st_size))
        except OSError:
            pass
    await asyncio.to_thread(
        _record_source_sha,
        file_id,
        source_sha256,
        source_revision,
        source_etag,
        str(payload.get("actorUserId") or ""),
    )
    identity = _pipeline_identity(processing_plan)
    _set_stage("donor_lookup")
    pin = await store.workspace_embedding_pin(ws)
    donor = None
    donor = await store.find_ready_donor(
        source_sha256=source_sha256,
        pipeline_identity=identity,
        embedding_provider_slug=pin["embedding_provider_slug"],
        embedding_model_slug=pin["embedding_model_slug"],
        embedding_model_version=pin["embedding_model_version"],
        embedding_dim=pin["embedding_dim"],
    )
    if job_type == "parse" and donor:
        # A parse coordinator may take the exact-vector donor fast path, which
        # is only database copying. A donor in another vector space needs an
        # embedding provider and therefore belongs to an ingest worker.
        exact_vector_space = (
            donor.get("embedding_provider_slug") == pin["embedding_provider_slug"]
            and donor.get("embedding_model_slug") == pin["embedding_model_slug"]
            and donor.get("embedding_model_version") == pin["embedding_model_version"]
            and donor.get("embedding_dim") == pin["embedding_dim"]
        )
        if not exact_vector_space:
            donor = None
    if donor:
        preview_blob_path = await asyncio.to_thread(_donor_office_preview, name, donor)
        if preview_blob_path is not None:
            _set_stage("donor_reuse")
            telemetry.record(donor_reused=True)
            reused = await _reuse_donor(
                job=job,
                payload=payload,
                file_id=file_id,
                ws=ws,
                name=name,
                kind=kind,
                route=processing_plan.route,
                donor=donor,
                identity=identity,
                source_sha256=source_sha256,
                preview_blob_path=preview_blob_path,
            )
            if reused:
                await asyncio.to_thread(cleanup_source)
                return

    if job_type == "parse":
        if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
            raise TerminalError(
                "ingest stopped because an account is suspended or deleting"
            )
        if not local_path or not source_key:
            raise RetryableError("local document source is missing")
        artifact = await _ensure_document_artifact(
            job=job,
            payload=payload,
            name=name,
            processing_plan=processing_plan,
            source_key=source_key,
            source_sha256=source_sha256,
            workspace_id=ws,
            file_id=file_id,
        )
        handed_off = await asyncio.to_thread(
            _handoff_parsed_artifact,
            job=job,
            payload=payload,
            file_id=file_id,
            workspace_id=ws,
            artifact=artifact,
        )
        if handed_off:
            progress.publish(
                ws,
                file_id,
                "indexing",
                45,
                status="processing",
                message=f"{name}: parsed; waiting for ingestion.",
            )
        return

    _set_stage("content_prepare")
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        raise TerminalError(
            "ingest stopped because an account is suspended or deleting"
        )
    try:
        chunks, artifact_key, fingerprint, artifact_version = await _chunks_for(
            payload=payload,
            name=name,
            processing_plan=processing_plan,
            local_path=local_path,
            source_key=source_key,
            ws=ws,
            file_id=file_id,
            source_sha256=source_sha256,
            job_id=job["id"],
        )
    except parser_client.ParserClientError:
        artifact = payload.get("parseArtifact")
        repair_attempts = int(payload.get("artifactRepairAttempts") or 0)
        if (
            processing_plan.route != ingest_plan.DOCUMENT_PARSE
            or not isinstance(artifact, dict)
            or repair_attempts >= 1
        ):
            raise
        await asyncio.to_thread(parser_client.discard_artifact, artifact)
        repaired = await asyncio.to_thread(
            _handoff_for_artifact_repair,
            job=job,
            payload=payload,
            file_id=file_id,
        )
        if repaired:
            progress.publish(
                ws,
                file_id,
                "queued",
                5,
                status="pending",
                message=f"{name}: parse artifact was invalid; parsing once more.",
            )
        return
    if not chunks:
        raise RetryableError("parse produced no indexable content")
    telemetry.record(chunks_created=len(chunks))

    digest = indexing.content_hash(chunks)
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        raise TerminalError(
            "ingest stopped because an account is suspended or deleting"
        )
    association = await store.attach_file_content(
        workspace_id=ws,
        file_id=file_id,
        content_hash=digest,
        source_sha256=source_sha256,
        pipeline_identity=identity,
        claim_job_id=job["id"],
        source_revision=source_revision,
        source_etag=source_etag,
    )
    _set_stage("content_claim")
    association = await _wait_for_content(
        association,
        workspace_id=ws,
        file_id=file_id,
        content_hash=digest,
        claim_job_id=job["id"],
        source_sha256=source_sha256,
        pipeline_identity=identity,
        source_revision=source_revision,
        source_etag=source_etag,
    )

    if association["ready"]:
        _set_stage("content_reuse")
        telemetry.record(donor_reused=True)
        note = f"{name}: identical content already indexed; reusing its index."
        committed = await asyncio.to_thread(
            _finish_ok,
            file_id,
            name,
            job["id"],
            digest,
            artifact_key,
            fingerprint,
            artifact_version,
            "source_duplicate",
            attempt=attempt,
            actor_user_id=payload.get("actorUserId") or "",
            workspace_id=ws,
            reservation_id=_reservation_id(payload),
            source_revision=source_revision,
            source_etag=source_etag,
        )
        if not committed:
            return
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=True
        )
        await asyncio.to_thread(
            _clear_parse_artifact_reference,
            artifact_key,
            file_id,
            source_revision,
            source_etag,
        )
        await asyncio.to_thread(cleanup_source)
        return

    _set_stage("indexing")
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        raise TerminalError(
            "ingest stopped because an account is suspended or deleting"
        )
    try:
        result = await indexing.index_file(
            workspace_id=ws,
            content_id=association["content_id"],
            file_id=file_id,
            file_name=name,
            chunks=chunks,
            on_progress=lambda pct: progress.publish(ws, file_id, "indexing", pct),
            claim_job_id=job["id"],
        )
    except BaseException:
        await store.abandon_content(association["content_id"])
        raise
    telemetry.record(
        chunks_created=max(0, int(result.get("chunks") or 0)),
    )
    _set_stage("finalizing")
    committed = await asyncio.to_thread(
        _finish_ok,
        file_id,
        name,
        job["id"],
        digest,
        artifact_key,
        fingerprint,
        artifact_version,
        attempt=attempt,
        actor_user_id=payload.get("actorUserId") or "",
        workspace_id=ws,
        reservation_id=_reservation_id(payload),
        source_revision=source_revision,
        source_etag=source_etag,
    )
    if not committed:
        return
    await asyncio.to_thread(cleanup_source)
    await asyncio.to_thread(
        _clear_parse_artifact_reference,
        artifact_key,
        file_id,
        source_revision,
        source_etag,
    )
    progress.publish(ws, file_id, "done", 100, status="ready", indexed=True)
    log.info("indexed %s: %s", name, result)


async def main_async(job_type: str = "ingest") -> None:
    worker_role = job_type
    policy_for(worker_role)
    obs.init_logging(f"{worker_role}-worker")
    obs.init_sentry(f"{worker_role}-worker")
    # Product limits are a process snapshot. A malformed or missing catalog is
    # a startup failure, never a per-job database lookup or numeric fallback.
    await asyncio.to_thread(plan_limits.load_once)
    registry.registry.start()
    threading.Thread(
        target=registry.poll_forever, name="model-registry", daemon=True
    ).start()
    runtime_reporter = telemetry.start_runtime_reporter(worker_role)
    # No models are reported: ingest and vision come from each job's payload and
    # embedding from its workspace, so this process has no single answer for any
    # of them.
    log.info(
        "%s worker up — parse=%s",
        worker_role,
        cfg.parser_url or "(unset)",
    )

    last_sweep = 0.0
    sweep_every = 300.0
    try:
        while True:
            now = time.monotonic()
            try:
                job, capacity_lease, capacity_busy = await asyncio.to_thread(
                    _claim_one_with_capacity, worker_role
                )
            except Exception:
                log.warning("claim error", exc_info=True)
                await asyncio.sleep(cfg.poll_interval)
                continue

            if capacity_busy:
                await asyncio.sleep(cfg.poll_interval)
                continue

            if not job:
                now = time.monotonic()
                if worker_role == "ingest" and now - last_sweep >= sweep_every:
                    try:
                        with db.connect() as conn, conn.cursor() as cur:
                            db.sweep_artifact_cache(
                                cur,
                                caption_ttl_days=cfg.caption_cache_ttl_days,
                            )
                            protected_spool_keys = db.active_local_spool_keys(cur)
                            conn.commit()
                        removed = await asyncio.to_thread(
                            parser_client.sweep_local_spool,
                            protected_spool_keys,
                        )
                        if any(removed.values()):
                            log.info("swept local parse spool: %s", removed)
                        last_sweep = now
                    except Exception:
                        log.warning("artifact cache sweep failed", exc_info=True)
                await asyncio.sleep(cfg.poll_interval)
                continue

            try:
                # One trace and one usage accumulator per job. Ingest has no
                # inbound request to continue a trace from, so it starts its own;
                # the job id is what links it back to the upload that queued it.
                obs.set_trace(str(job.get("traceId") or obs.new_trace_id()))
                obs.start_usage()
                obs.bind_error_context()
                job_telemetry_token = telemetry.begin_job(job)

                log.info(
                    "claimed %s job %s",
                    job.get("type"),
                    job["id"],
                    extra={"job_id": job["id"]},
                )
                claimed_type = (job.get("type") or "").strip()
                try:
                    policy = policy_for(claimed_type)
                except TerminalError as exc:
                    try:
                        await _handle_job_failure(job, exc)
                    finally:
                        telemetry.reset_job(job_telemetry_token)
                    continue
                stop = threading.Event()
                claim_lost = threading.Event()
                loop = asyncio.get_running_loop()
                job_task = asyncio.create_task(process_job(job))

                def cancel_lost_claim(
                    claim_lost: threading.Event = claim_lost,
                    loop: asyncio.AbstractEventLoop = loop,
                    job_task: asyncio.Task[None] = job_task,
                ) -> None:
                    claim_lost.set()
                    loop.call_soon_threadsafe(job_task.cancel)

                heartbeat = threading.Thread(
                    target=_heartbeat_loop,
                    args=(
                        job["id"],
                        policy.lease_s,
                        int(job.get("attempts") or 1),
                        stop,
                        cancel_lost_claim,
                    ),
                    name=f"job-lease-{job['id']}",
                    daemon=True,
                )
                heartbeat.start()
                restart_after_failure = False
                try:
                    async with asyncio.timeout(_job_timeout(job, policy.timeout_s)):
                        await job_task
                    if claim_lost.is_set():
                        log.info("job %s stopped after losing its claim", job["id"])
                    else:
                        log.info("job %s done", job["id"])
                except asyncio.CancelledError:
                    if not claim_lost.is_set():
                        raise
                    # The durable lifecycle transition already closed this job.
                    # Cancelling its task closes an uncertain async provider
                    # request. A response that won the race still crosses the
                    # provider boundary's shielded settlement path.
                    log.info("job %s cancelled after losing its claim", job["id"])
                    restart_after_failure = True
                except CapacityWait:
                    log.info("job %s waiting for capacity", job["id"])
                except Exception as exc:  # noqa: BLE001 - retry policy lives below
                    restart_after_failure = isinstance(exc, TimeoutError)
                    try:
                        async with asyncio.timeout(30):
                            await _handle_job_failure(job, exc)
                    except Exception:
                        # Bookkeeping for one failed job must not take the worker
                        # down; the lease reaper is the backstop for this row.
                        log.exception("could not record failure of job %s", job["id"])
                finally:
                    stop.set()
                    telemetry.reset_job(job_telemetry_token)
            finally:
                assert capacity_lease is not None
                capacity_lease.release()
            if restart_after_failure:
                # Work delegated through asyncio.to_thread cannot be killed by
                # cancellation. Exit this one-job worker process after timeout or
                # claim loss so no stale blocking thread overlaps a successor.
                log.error("job %s stopped; restarting this worker", job["id"])
                os._exit(1)
    finally:
        runtime_reporter.stop()
        db.close_pool()
        await store.close_pool()


async def _handle_job_failure(job: dict, exc: BaseException) -> None:
    payload = job.get("payload") or {}
    fid = payload.get("fileId")
    ws = payload.get("workspaceId")
    job_type = (job.get("type") or "").strip()
    policy = POLICIES.get(job_type)
    attempts = int(job.get("attempts") or 1)
    error_category, error_code, _provider_status = telemetry.classify_error(exc)
    if isinstance(exc, TimeoutError):
        exc = RetryableError("job exceeded its wall-clock timeout")
    if (
        job_type in {"parse", "ingest"}
        and fid
        and payload.get("sourceRevision") is not None
    ):
        try:
            await asyncio.to_thread(
                _require_current_source,
                str(fid),
                int(payload["sourceRevision"]),
                str(payload.get("sourceETag") or ""),
            )
        except db.SourceSupersededError as superseded:
            # Any error after replacement is terminal for the old source, even
            # if the original error would normally retry. Never re-pend A once
            # the logical file points at B.
            exc = superseded
            error_category, error_code, _provider_status = telemetry.classify_error(exc)
    retry = (
        policy is not None
        and not isinstance(exc, accounting.SettlementError)
        and is_retryable(exc)
        and attempts < policy.max_attempts
    )
    if job_type == "parse":
        await asyncio.to_thread(
            _record_parse_attempt,
            str(fid or ""),
            str(ws or ""),
            str(payload.get("actorUserId") or ""),
            _reservation_id(payload),
            job["id"],
            attempts,
            outcome="retrying" if retry else "failed",
            payload=payload,
        )
    if job_type == "import":
        # Release or close the gateway attempt before the queue row moves, so
        # a retry acquires at once and a terminal failure frees the reservation.
        await asyncio.to_thread(import_stage.report, job, exc, retry)
    if isinstance(exc, db.SourceSupersededError):
        log.info("ingest job %s was superseded", job["id"])
        await asyncio.to_thread(_cleanup_payload_source, payload)
        await asyncio.to_thread(
            _finish_superseded,
            job["id"],
            attempts,
            _reservation_id(payload),
        )
        return
    if retry:
        log.warning("%s job %s failed; retrying: %s", job_type, job["id"], exc)
        try:
            outcome = await asyncio.to_thread(
                _requeue,
                job,
                str(exc),
                error_category=error_category,
                error_code=error_code,
            )
        except db.SourceSupersededError:
            await asyncio.to_thread(
                _finish_superseded,
                job["id"],
                attempts,
                _reservation_id(payload),
            )
            return
        log.info("job %s requeued (%s)", job["id"], outcome)
        return
    await asyncio.to_thread(_cleanup_payload_source, payload)
    log.exception("%s job %s failed", job_type, job["id"])
    obs.capture_error(exc, stage=f"{job_type}_terminal")
    try:
        await asyncio.to_thread(
            _notify_ingest_terminal,
            fid,
            ws,
            job["id"],
            str(exc),
            attempts,
            payload,
            error_category,
            error_code,
        )
    except db.SourceSupersededError:
        await asyncio.to_thread(
            _finish_superseded,
            job["id"],
            attempts,
            _reservation_id(payload),
        )
    except Exception:
        log.exception("failed to record job failure")


def main(job_type: str = "ingest") -> None:
    use_compatible_event_loop()
    asyncio.run(main_async(job_type))


if __name__ == "__main__":
    main()
