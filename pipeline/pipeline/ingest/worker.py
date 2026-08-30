"""Ingestion worker.

Claims jobs from the Postgres queue and executes the server-owned processing
plan attached at enqueue time. File-category checks do not select the pipeline.
The worker downloads the B2 source once into the Netcup VM's shared spool;
document parsing consumes that local file and returns a local cached bundle.

The parse returns a bundle — a ``content_list.json`` carrying a page index and
bounding box per block, plus the extracted images — so citations a reader can
jump to and figures that can be captioned come from the same shape.

Live progress is published to Redis; the Go gateway fans it to the browser over
SSE. A file is ``pending`` until this worker is actually parsing and holds a
parse slot; extra jobs wait there instead of oversubscribing the VM.

Run: ``python -m pipeline.ingest.worker``
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import shutil
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .. import obs, progress, registry, use_compatible_event_loop
from ..config import cfg
from ..jobs import (
    CONTENT_CLAIM_STALE_S,
    CONTENT_CLAIM_WAIT_S,
    POLICIES,
    CapacityWait,
    ExternalWait,
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
from . import plan as ingest_plan
from . import source_text

log = logging.getLogger("evo.worker")

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

_REQUIRED_INGEST_STRINGS = (
    "fileId",
    "workspaceId",
    "blobPath",
    "kind",
    "actorUserId",
    "reservationId",
    "ingestProviderSlug",
    "ingestModelSlug",
    "visionProviderSlug",
    "visionModelSlug",
)
_REQUIRED_INGEST_INTS = (
    "ingestModelVersion",
    "visionModelVersion",
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


# ----------------------------------------------------------- sync DB helpers
# (run via asyncio.to_thread so the event loop is never blocked)


def _announce_reclaimed(row: dict) -> None:
    payload = row.get("payload") or {}
    if row.get("outcome") != "failed" or not payload.get("fileId"):
        return
    _cleanup_payload_source(payload)
    try:
        _notify_ingest_terminal(
            payload.get("fileId"),
            payload.get("workspaceId"),
            row["id"],
            "ingest timed out after the worker died",
            payload=payload,
        )
    except db.SourceSupersededError:
        # A replacement may have skipped the running row while its old worker
        # held the job lock. If that worker then dies on its final attempt, the
        # reaper owns terminal cleanup and must release A's reservation without
        # writing a failed state onto replacement B.
        _finish_superseded(
            row["id"],
            int(row.get("attempts") or 1),
            _reservation_id(payload),
        )


def _claim_one() -> dict | None:
    leases = {name: p.lease_s for name, p in POLICIES.items()}
    max_attempts = {name: p.max_attempts for name, p in POLICIES.items()}
    backoff_base = {name: p.backoff_base_s for name, p in POLICIES.items()}
    with db.connect() as conn:
        with conn.cursor() as cur:
            reclaimed = db.reclaim_expired_leases(
                cur, max_attempts=max_attempts, backoff_base_s=backoff_base
            )
            job = db.claim_job(cur, leases)
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


def _claim_audio_cleanup() -> dict | None:
    with db.connect() as conn, conn.cursor() as cur:
        candidate = db.claim_audio_cleanup(cur)
        conn.commit()
        return candidate


def _finish_audio_cleanup(candidate: dict, error: str = "") -> None:
    with db.connect() as conn, conn.cursor() as cur:
        if error:
            db.fail_audio_cleanup(cur, candidate["id"], error)
        else:
            db.complete_audio_cleanup(
                cur, candidate["id"], str(candidate.get("provider_call_id") or "")
            )
        conn.commit()


async def _run_audio_cleanup_once() -> bool:
    candidate = await asyncio.to_thread(_claim_audio_cleanup)
    if candidate is None:
        return False
    provider_id = str(candidate.get("provider_transcription_id") or "")
    deleted = await asyncio.to_thread(source_text.delete_provider_audio, provider_id)
    error = "" if deleted else "provider transcript deletion failed"
    await asyncio.to_thread(_finish_audio_cleanup, candidate, error)
    if deleted:
        log.info("deleted provider transcript %s", provider_id)
    return True


def _heartbeat_loop(
    job_id: str, lease_s: int, attempt: int, stop: threading.Event
) -> None:
    while not stop.wait(min(30, max(lease_s // 3, 5))):
        try:
            with db.connect() as conn, conn.cursor() as cur:
                db.heartbeat_job(cur, job_id, lease_s, attempt)
                conn.commit()
        except Exception:
            log.warning("job heartbeat failed", exc_info=True)


def _lost_claim(cur, job_id: str, attempt: int | None) -> bool:
    """True when another worker has taken over, so this run must not write.

    ``attempt`` is None for the lease reaper, which is acting on a row it has
    already transitioned and therefore owns.
    """
    if attempt is None:
        return False
    if db.claim_is_current(cur, job_id, attempt):
        return False
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
                if _lost_claim(cur, job_id, attempt):
                    return False
                if source_revision is not None:
                    db.require_current_file_source(
                        cur, file_id, source_revision, source_etag
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
            conn.commit()
    except Exception:
        obs.record_parse_usage(
            pages=usage.pages,
            ocr_pages=usage.ocr_pages,
            cpu_milliseconds=usage.cpu_milliseconds,
            elapsed_milliseconds=usage.elapsed_milliseconds,
            queue_milliseconds=usage.queue_milliseconds,
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
) -> bool:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return False
            if file_id:
                if source_revision is not None:
                    db.require_current_file_source(
                        cur, file_id, source_revision, source_etag
                    )
                db.set_file_status(cur, file_id, "failed")
                db.set_file_indexed(cur, file_id, False)
                db.set_file_preview_blob(cur, file_id, None)
            db.fail_audio_transcription_for_job(cur, job_id, error)
            db.set_job(cur, job_id, "failed", error[:500])
            db.close_credit_reservation(cur, reservation_id)
        conn.commit()
    return True


def _finish_job_ok(job_id: str, attempt: int | None = None) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
            db.set_job(cur, job_id, "done")
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
        # Replacement normally closes this while canceling the old job. This
        # also covers the SKIP LOCKED race where the worker held the job row.
        db.close_credit_reservation(cur, reservation_id)
        conn.commit()


def _requeue(job: dict, error: str) -> str:
    job_type = (job.get("type") or "").strip()
    policy = policy_for(job_type)
    payload = job.get("payload") or {}
    attempt = int(job.get("attempts") or 1)
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt):
            return "stale"
        if job_type == "ingest" and payload.get("fileId"):
            db.require_current_file_source(
                cur,
                str(payload["fileId"]),
                int(payload["sourceRevision"]),
                str(payload.get("sourceETag") or ""),
            )
        outcome = db.requeue_job(
            cur,
            job_id=job["id"],
            job_type=job_type,
            workspace_id=payload.get("workspaceId"),
            error=error,
            backoff_s=backoff_s(policy, attempt),
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
) -> None:
    reservation_id = _reservation_id(payload or {})
    if not file_id:
        with db.connect() as conn, conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
            db.set_job(cur, job_id, "failed", error[:500])
            db.close_credit_reservation(cur, reservation_id)
            conn.commit()
        return
    name = _read_name(file_id)
    source_revision = payload.get("sourceRevision") if payload else None
    committed = _finish_fail(
        file_id,
        job_id,
        error,
        attempt,
        reservation_id,
        int(source_revision) if source_revision is not None else None,
        str((payload or {}).get("sourceETag") or ""),
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
    """Claim-time gate: owner lifecycle/storage, actor credits. Separate lookups.

    Actor lifecycle is not checked. Refusing a deletion_pending uploader would
    leave the owner holding an unindexed file whose bytes they already paid for.

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
        owner = db.file_owner_user_id(cur, file_id)
        if not owner or not db.account_allows_ingest(cur, owner):
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
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_parse_artifact(cur, file_id, key, fingerprint, version)
        conn.commit()


def _record_caption_blob(
    file_id: str, key: str, source_revision: int, source_etag: str
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_caption_blob(cur, file_id, key)
        conn.commit()


def _record_preview_blob(
    file_id: str, key: str, source_revision: int, source_etag: str
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_preview_blob(cur, file_id, key)
        conn.commit()


def _clear_preview_blob(file_id: str, source_revision: int, source_etag: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.set_file_preview_blob(cur, file_id, None)
        conn.commit()


def _record_source_sha(
    file_id: str,
    source_sha256: str,
    source_revision: int,
    source_etag: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
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
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.upsert_artifact_cache(
            cur,
            object_path=object_path,
            kind=kind,
            source_sha256=source_sha256,
            size_bytes=size_bytes,
        )
        conn.commit()


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


def _cache_office_preview(
    *,
    raw_dir: Path,
    file_id: str,
    source_sha256: str,
    parser_version: str,
    fingerprint: str,
    source_revision: int,
    source_etag: str,
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
    key = _office_preview_key(source_sha256, parser_version, fingerprint)
    info = blobstore.object_info(key)
    if info is None:
        with preview.open("rb") as handle:
            data = handle.read(cfg.office_preview_max_bytes + 1)
        if len(data) != local_size or len(data) > cfg.office_preview_max_bytes:
            log.warning(
                "refusing Office preview for %s: size changed while reading", file_id
            )
            return None
        blobstore.write_bytes(key, data, "application/pdf")
        size_bytes = len(data)
    else:
        size_bytes = _office_preview_size(info)
        if size_bytes is None:
            log.warning("refusing oversized or empty cached Office preview %s", key)
            return None
    _touch_or_upsert_artifact(
        object_path=key,
        kind="office_preview",
        source_sha256=source_sha256,
        size_bytes=size_bytes,
    )
    _record_preview_blob(file_id, key, source_revision, source_etag)
    return key


def _reuse_office_preview(
    *,
    file_id: str,
    source_sha256: str,
    preview_blob_path: str,
    source_revision: int,
    source_etag: str,
) -> bool:
    if not preview_blob_path:
        return False
    info = blobstore.object_info(preview_blob_path)
    size_bytes = _office_preview_size(info)
    if size_bytes is None:
        return False
    _touch_or_upsert_artifact(
        object_path=preview_blob_path,
        kind="office_preview",
        source_sha256=source_sha256,
        size_bytes=size_bytes,
    )
    _record_preview_blob(file_id, preview_blob_path, source_revision, source_etag)
    return True


def _donor_office_preview(name: str, donor: dict) -> str | None:
    """Return an existing exact preview, or refuse Office donor reuse."""
    if Path(name).suffix.lower() not in parser_client.OFFICE_SUFFIXES:
        return ""
    preview_blob_path = str(donor.get("preview_blob_path") or "")
    if (
        not preview_blob_path
        or _office_preview_size(blobstore.object_info(preview_blob_path)) is None
    ):
        return None
    return preview_blob_path


def _set_file_status(
    file_id: str,
    status: str,
    source_revision: int,
    source_etag: str,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
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
    message: str = "waiting for a parser slot",
    backoff_s: int = slots.YIELD_BACKOFF_S,
) -> None:
    """Give the parse slot back to the queue. File stays pending; attempt is undone."""
    attempt = int(job.get("attempts") or 1)
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt):
            return
        db.require_current_file_source(cur, file_id, source_revision, source_etag)
        db.release_job_for_capacity(cur, job["id"], attempt, backoff_s=backoff_s)
        db.set_file_status(cur, file_id, "pending")
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
    db.record_usage_event(
        cur,
        actor_user_id=actor_user_id,
        workspace_id=workspace_id,
        kind="parse",
        surface="ingest",
        provider="netcup-vm",
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
) -> None:
    """Persist one page-priced parse attempt before changing the job state."""
    usage = obs.take_parse_usage()
    if usage.is_empty():
        return
    try:
        with db.connect() as conn, conn.cursor() as cur:
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
            )
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
            (
                text,
                derived_key,
                derived_size,
            ) = await source_text.caption_image_source(
                local_path=local_path,
                name=name,
                source_sha256=source_sha256,
            )
        elif direct == "audio":
            (
                text,
                derived_key,
                derived_size,
            ) = await source_text.transcribe_audio_source(
                local_path=local_path,
                source_sha256=source_sha256,
                blob_path=str(blob_path),
                file_id=file_id,
                job_id=str(job_id or ""),
                audio_rate=_rate(_RESOURCE_AUDIO_SECOND),
            )
        else:
            if not local_path:
                raise RetryableError("local delimited source is missing")
            text = await asyncio.to_thread(source_text.tabular_text, local_path, name)
        if derived_key:
            await asyncio.to_thread(
                _touch_or_upsert_artifact,
                object_path=derived_key,
                kind="derived_text",
                source_sha256=source_sha256,
                size_bytes=derived_size,
            )
            await asyncio.to_thread(
                _record_caption_blob,
                file_id,
                derived_key,
                source_revision,
                source_etag,
            )
        progress.publish(ws, file_id, "indexing", 50, status="processing")
        return chunk_markdown(text), None, None, None

    if processing_plan.route != ingest_plan.DOCUMENT_PARSE:
        raise TerminalError(f"unsupported processing route {processing_plan.route!r}")
    if not local_path or not source_key:
        raise RetryableError("local document source is missing")
    route = _parse_route(processing_plan.parser_route)
    descriptor = parser_client.source_descriptor(
        source_key=source_key,
        source_sha256=source_sha256,
        route=route,
    )
    held_slot = False
    if job_id:
        held_slot = await asyncio.to_thread(slots.try_acquire, route, job_id)
        if not held_slot:
            raise CapacityWait(route)
        await asyncio.to_thread(
            _set_file_status,
            file_id,
            "processing",
            source_revision,
            source_etag,
        )
    progress.publish(ws, file_id, "parsing", 15, status="processing")
    raw_dir = Path(tempfile.mkdtemp(prefix="evo_parse_"))
    try:
        try:
            try:
                content_list, artifact_key, fingerprint = await asyncio.to_thread(
                    parser_client.parse_to_bundle,
                    descriptor,
                    name,
                    raw_dir,
                    processing_plan.office_preview,
                    request_id=str(job_id or ""),
                )
            except parser_client.ParserHardTimeoutError as exc:
                raise TerminalError(
                    "this file exceeded the parser hard deadline and is quarantined "
                    "for the current parser version"
                ) from exc
        finally:
            # Free the parse slot before captioning / indexing; those do not
            # occupy a parser process.
            if held_slot and job_id:
                await asyncio.to_thread(slots.release, route, job_id)
        if artifact_key:
            # Record the local cache identity before captioning so an operator
            # can see which parse completed if a later provider call fails.
            await asyncio.to_thread(
                _record_parse_artifact,
                file_id,
                artifact_key,
                fingerprint,
                parser_client.parser_version(route),
                source_revision,
                source_etag,
            )
        preview_path = raw_dir / "preview.pdf"
        if preview_path.is_file():
            await asyncio.to_thread(
                _cache_office_preview,
                raw_dir=raw_dir,
                file_id=file_id,
                source_sha256=source_sha256,
                parser_version=parser_client.parser_version(route),
                fingerprint=fingerprint,
                source_revision=source_revision,
                source_etag=source_etag,
            )
        progress.publish(
            ws,
            file_id,
            "captioning" if processing_plan.caption_embedded_images else "indexing",
            45,
        )
        if processing_plan.caption_embedded_images:
            # Before chunking on purpose: a caption has to be inside the passage
            # it belongs to before that passage is embedded, summarized and
            # concept-extracted, or the figure stays invisible to all three.
            counts = await figures.caption_figures(
                content_list=content_list,
                raw_dir=raw_dir,
                file_name=name,
                source_sha256=source_sha256,
            )
            log.info("captioned figures for %s: %s", name, counts)
            if counts.get("key"):
                await asyncio.to_thread(
                    _touch_or_upsert_artifact,
                    object_path=str(counts["key"]),
                    kind="captions",
                    source_sha256=source_sha256,
                )
                await asyncio.to_thread(
                    _record_caption_blob,
                    file_id,
                    str(counts["key"]),
                    source_revision,
                    source_etag,
                )
        progress.publish(ws, file_id, "indexing", 55)
        return (
            chunk_content_list(content_list),
            artifact_key,
            fingerprint,
            parser_client.parser_version(route),
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
    if job_type != "ingest":
        raise TerminalError(f"unknown job type {job_type!r}")
    await process_ingest_job(job)


async def process_ingest_job(job: dict) -> None:
    payload = job["payload"] or {}
    _require_ingest_payload(payload)
    file_id = payload["fileId"]
    ws = payload["workspaceId"]
    kind = str(payload["kind"]).lower()
    processing_plan = ingest_plan.require(payload.get("processingPlan"))
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
        accounting_token = accounting.bind_ingest(_reservation_id(payload), rates)
        await _process_ingest_job(job, payload, file_id, ws, kind, processing_plan)
    except (CapacityWait, ExternalWait) as exc:
        name = await asyncio.to_thread(_read_name, file_id)
        external = isinstance(exc, ExternalWait)
        await asyncio.to_thread(
            _yield_for_capacity,
            job,
            file_id,
            ws,
            name,
            int(payload["sourceRevision"]),
            str(payload.get("sourceETag") or ""),
            "waiting for audio transcription"
            if external
            else "waiting for a parser slot",
            30 if external else slots.YIELD_BACKOFF_S,
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
        registry.Surface.EMBEDDING,
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
        info = await asyncio.to_thread(blobstore.object_info, derived_key)
        if info is None:
            return False
        await asyncio.to_thread(
            _touch_or_upsert_artifact,
            object_path=derived_key,
            kind="derived_text",
            source_sha256=source_sha256,
            size_bytes=int(info.get("size") or 0),
        )
        await asyncio.to_thread(
            _record_caption_blob,
            file_id,
            derived_key,
            source_revision,
            source_etag,
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
        if preview_blob_path and not await asyncio.to_thread(
            _reuse_office_preview,
            file_id=file_id,
            source_sha256=source_sha256,
            preview_blob_path=preview_blob_path,
            source_revision=source_revision,
            source_etag=source_etag,
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
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        note = f"{name}: ingest refused because the account is locked or over quota."
        committed = await asyncio.to_thread(
            _finish_fail,
            file_id,
            job["id"],
            note,
            attempt,
            _reservation_id(payload),
            source_revision,
            source_etag,
        )
        if not committed:
            return
        progress.publish(
            ws, file_id, "failed", 100, status="failed", message=note, indexed=False
        )
        return
    progress.publish(ws, file_id, "queued", 5, status="pending")

    if processing_plan.route == ingest_plan.STORE_ONLY:
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
    audio_state = None
    if processing_plan.route == ingest_plan.AUDIO_TRANSCRIPTION:
        audio_state = await asyncio.to_thread(source_text.audio_state, job["id"])
    if audio_state is not None:
        local_path = None
        source_key = ""
        source_sha256 = str(audio_state.get("source_sha256") or "")
        if not source_sha256:
            raise TerminalError("audio transcription state has no source checksum")
        await asyncio.to_thread(_cleanup_payload_source, payload)
        cleanup_source: Callable[[], None] = lambda: None
    else:
        try:
            (
                local_path,
                source_key,
                source_sha256,
                cleanup_source,
            ) = await asyncio.to_thread(
                _acquire_local_source, job, payload, str(blob_path)
            )
        except FileNotFoundError as exc:
            raise TerminalError("source blob is missing") from exc
    await asyncio.to_thread(
        _record_source_sha,
        file_id,
        source_sha256,
        source_revision,
        source_etag,
    )
    identity = _pipeline_identity(processing_plan)
    pin = await store.workspace_embedding_pin(ws)
    donor = None
    if audio_state is None:
        donor = await store.find_ready_donor(
            source_sha256=source_sha256,
            pipeline_identity=identity,
            embedding_provider_slug=pin["embedding_provider_slug"],
            embedding_model_slug=pin["embedding_model_slug"],
            embedding_model_version=pin["embedding_model_version"],
            embedding_dim=pin["embedding_dim"],
        )
    if donor:
        preview_blob_path = await asyncio.to_thread(_donor_office_preview, name, donor)
        if preview_blob_path is not None:
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
    if not chunks:
        raise RetryableError("parse produced no indexable content")

    digest = indexing.content_hash(chunks)
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


async def main_async() -> None:
    obs.init_logging("worker")
    obs.init_sentry("worker")
    registry.registry.start()
    threading.Thread(
        target=registry.poll_forever, name="model-registry", daemon=True
    ).start()
    # No models are reported: ingest and vision come from each job's payload and
    # embedding from its workspace, so this process has no single answer for any
    # of them.
    log.info(
        "worker up — parse=%s",
        cfg.parser_url or "(unset)",
    )

    last_sweep = 0.0
    last_audio_cleanup = 0.0
    sweep_every = 300.0
    try:
        while True:
            now = time.monotonic()
            if now - last_audio_cleanup >= 30:
                try:
                    await _run_audio_cleanup_once()
                except Exception:
                    log.warning("audio provider cleanup failed", exc_info=True)
                last_audio_cleanup = now
            try:
                job = await asyncio.to_thread(_claim_one)
            except Exception:
                log.warning("claim error", exc_info=True)
                await asyncio.sleep(cfg.poll_interval)
                continue

            if not job:
                now = time.monotonic()
                if now - last_sweep >= sweep_every:
                    try:
                        with db.connect() as conn, conn.cursor() as cur:
                            db.sweep_artifact_cache(
                                cur,
                                caption_ttl_days=cfg.caption_cache_ttl_days,
                            )
                            conn.commit()
                        removed = await asyncio.to_thread(
                            parser_client.sweep_local_spool
                        )
                        if any(removed.values()):
                            log.info("swept local parse spool: %s", removed)
                        last_sweep = now
                    except Exception:
                        log.warning("artifact cache sweep failed", exc_info=True)
                await asyncio.sleep(cfg.poll_interval)
                continue

            # One trace and one usage accumulator per job. Ingest has no
            # inbound request to continue a trace from, so it starts its own;
            # the job id is what links it back to the upload that queued it.
            obs.set_trace(obs.new_trace_id())
            obs.start_usage()
            obs.bind_error_context()

            log.info(
                "claimed %s job %s",
                job.get("type"),
                job["id"],
                extra={"job_id": job["id"]},
            )
            job_type = (job.get("type") or "").strip()
            try:
                policy = policy_for(job_type)
            except TerminalError as exc:
                await _handle_job_failure(job, exc)
                continue
            stop = threading.Event()
            heartbeat = threading.Thread(
                target=_heartbeat_loop,
                args=(job["id"], policy.lease_s, int(job.get("attempts") or 1), stop),
                name=f"job-lease-{job['id']}",
                daemon=True,
            )
            heartbeat.start()
            try:
                async with asyncio.timeout(policy.timeout_s):
                    await process_job(job)
                log.info("job %s done", job["id"])
            except (CapacityWait, ExternalWait) as exc:
                wait_target = (
                    "an external provider"
                    if isinstance(exc, ExternalWait)
                    else "a parser slot"
                )
                log.info("job %s waiting for %s", job["id"], wait_target)
            except Exception as exc:  # noqa: BLE001 - retry vs terminal is decided below
                try:
                    async with asyncio.timeout(30):
                        await _handle_job_failure(job, exc)
                except Exception:
                    # Bookkeeping for one failed job must not take the worker
                    # down; the lease reaper is the backstop for this row.
                    log.exception("could not record failure of job %s", job["id"])
            finally:
                stop.set()
    finally:
        db.close_pool()
        await store.close_pool()


async def _handle_job_failure(job: dict, exc: BaseException) -> None:
    payload = job.get("payload") or {}
    fid = payload.get("fileId")
    ws = payload.get("workspaceId")
    job_type = (job.get("type") or "").strip()
    policy = POLICIES.get(job_type)
    attempts = int(job.get("attempts") or 1)
    if isinstance(exc, TimeoutError):
        exc = RetryableError("job exceeded its wall-clock timeout")
    if job_type == "ingest" and fid and payload.get("sourceRevision") is not None:
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
    retry = policy is not None and is_retryable(exc) and attempts < policy.max_attempts
    if job_type == "ingest":
        await asyncio.to_thread(
            _record_parse_attempt,
            str(fid or ""),
            str(ws or ""),
            str(payload.get("actorUserId") or ""),
            _reservation_id(payload),
            job["id"],
            attempts,
            "retrying" if retry else "failed",
        )
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
            outcome = await asyncio.to_thread(_requeue, job, str(exc))
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


def main() -> None:
    use_compatible_event_loop()
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
