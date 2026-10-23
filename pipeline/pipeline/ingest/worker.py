"""Ingestion worker.

Claims one selected stage from the Postgres queue and executes the server-owned
processing plan attached at enqueue time. File-category checks do not select
the pipeline. Parse coordinators download the B2 source into the ingest host's
shared spool and hand an immutable local bundle to an ingest continuation.

The parse returns a bundle — a ``content_list.json`` carrying a page index and
bounding box per block, plus the extracted images — so citations a reader can
jump to and page captures come from the same shape.

Live progress is published to Redis; the Go gateway fans it to the browser over
SSE. A document stays ``pending`` while the parser's queue is full; ingest
workers never wait on the parser.

Run: ``python -m pipeline.ingest.worker``
"""

from __future__ import annotations

import asyncio
import base64
import contextvars
import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import capy_sandbox
import requests

from .. import (
    elitellm,
    obs,
    plan_limits,
    progress,
    registry,
    use_compatible_event_loop,
)
from ..config import cfg, require_parse_timeouts
from ..jobs import (
    CONTENT_CLAIM_STALE_S,
    CONTENT_CLAIM_WAIT_S,
    POLICIES,
    PROVIDER_WAITS_MAX,
    CapacityWait,
    InputLimitError,
    RetryableError,
    TerminalError,
    backoff_s,
    is_retryable,
    policy_for,
    provider_wait_backoff_s,
)
from ..parse import caption_cache, parser_client
from ..retrieval import accounting, indexing, models, store
from ..retrieval.chunking import (
    CHUNKER_VERSION,
    Chunk,
    chunk_markdown,
    chunk_transcript,
)
from ..retrieval.confidence import VLM_RECOVERY, score_chunks, vlm_pages
from ..retrieval.headings import retain_headings
from ..retrieval.packing import pack_blocks
from ..store import blobstore, db
from . import capacity, decode, import_stage, source_text, telemetry, thumbnail, uat
from . import plan as ingest_plan

log = logging.getLogger("capy.worker")

_RESOURCE_DIGITAL_PAGE = "digital_parse_page"
_RESOURCE_VLM_PAGE = "vlm_ingest_page"
# Read only by an audio job, which fails explicitly without it (_rate).
_RESOURCE_AUDIO_SECOND = "audio_transcription_second"
_REQUIRED_RESOURCE_RATES = {
    _RESOURCE_DIGITAL_PAGE,
    _RESOURCE_VLM_PAGE,
}
# A job that found the parser or a provider full re-pends after this long.
YIELD_BACKOFF_S = 2
# A source publication may hold the collaboration room lock for 180 s (LOCK in
# collaboration-rs/crates/sources/src/handoff.rs); the gateway waits 200 s for it
# (sourcePublishTimeout in server/internal/store/source_proxy.go). Wait longer
# than both so the gateway's answer arrives first.
_SOURCE_PUBLISH_TIMEOUT_S = 210
_resource_rates: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "ingest_resource_rates", default=None
)

_PARSE_ROUTES = {
    "fast": parser_client.ROUTE_FAST,
}


def _publish_progress(workspace_id: str, file_id: str, *args, **kwargs) -> None:
    # Reprocessing an edited source is invisible: no progress or failure, only
    # the terminal ready event that refreshes the browser's file caches.
    if db.source_refresh_for(file_id) is not None and kwargs.get("status") != "ready":
        return
    progress.publish(workspace_id, file_id, *args, **kwargs)


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
    """An audio ingest gets its transcription task's budget on top of the
    ordinary one, which still covers download, indexing and the summary."""
    payload = job.get("payload") or {}
    plan = payload.get("processingPlan") or {}
    if (
        job.get("type") == "ingest"
        and plan.get("route") == ingest_plan.AUDIO_TRANSCRIPTION
    ):
        return default + source_text.FILETRANS_TIMEOUT_S
    return default


# ----------------------------------------------------------- sync DB helpers
# (run via asyncio.to_thread so the event loop is never blocked)


def _announce_reclaimed(row: dict) -> None:
    payload = row.get("payload") or {}
    if row.get("outcome") != "failed" or not payload.get("fileId"):
        return
    _cleanup_payload_source(payload)
    if payload.get("sourceRefresh") is True:
        return
    if not row.get("file_failed"):
        return
    error = f"{row.get('type') or 'pipeline'} worker died before the job completed"
    workspace_id = str(payload.get("workspaceId") or "")
    file_id = str(payload.get("fileId") or "")
    if workspace_id:
        _publish_progress(
            workspace_id,
            file_id,
            "failed",
            100,
            status="failed",
            message=error[:200],
            indexed=row.get("file_indexed") is True,
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
        payload = db.source_boundary_payload(payload)
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


def _source_refresh_published(job_id: str, payload: dict) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM jobs WHERE id=%s AND payload->>'sourcePublishedCheckpoint'=%s",
            (job_id, str(payload.get("sourceCheckpoint"))),
        )
        return cur.fetchone() is not None


def _settle_published_source_refresh(job_id: str, payload: dict) -> None:
    usage = obs.take_parse_usage()
    try:
        with db.connect() as conn, conn.cursor() as cur:
            _record_parse_usage_tx(
                cur,
                usage=usage,
                file_id=str(payload["fileId"]),
                workspace_id=str(payload["workspaceId"]),
                actor_user_id=str(payload["actorUserId"]),
                reservation_id=_reservation_id(payload),
                job_id=job_id,
                attempt=int(payload.get("_attempt") or 1),
                outcome="succeeded",
                charged=_parse_fee(payload),
            )
            db.settle_credit_reservation(cur, _reservation_id(payload))
            db.set_job(cur, job_id, "done")
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="succeeded",
                snapshot=telemetry.snapshot(),
            )
            conn.commit()
    except Exception:
        # Same as the other settle paths: keep the pages for the retry.
        obs.restore_parse_usage(usage)
        raise


def _finish_source_refresh(
    file_id: str,
    job_id: str,
    content_hash: str | None,
) -> bool:
    payload = db.source_refresh_for(file_id)
    if payload is None:
        raise TerminalError("source refresh context is missing")
    if _source_refresh_published(job_id, payload):
        _settle_published_source_refresh(job_id, payload)
        return True
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job_id, payload["_attempt"], payload):
            return False
        cur.execute(
            "SELECT content_id,content_hash FROM source_refresh_candidates WHERE file_id=%s AND job_id=%s AND lease_token=%s",
            (file_id, job_id, payload["sourceLeaseToken"]),
        )
        candidate = cur.fetchone()
        if candidate is None or not candidate[0] or candidate[1] != content_hash:
            raise db.SourceSupersededError("source candidate index is missing")
        # Only this point certifies that captions and derivatives are complete.
        # A shared ready RAG content row alone can exist before those steps finish.
        cur.execute(
            "UPDATE jobs SET payload=payload||'{\"sourcePublicationReady\":true}'::jsonb WHERE id=%s",
            (job_id,),
        )
        conn.commit()
    if not cfg.gateway_url or not cfg.pipeline_secret:
        raise TerminalError(
            "GATEWAY_URL and PIPELINE_SECRET are required for source refresh"
        )
    body = {
        "fileId": file_id,
        "jobId": job_id,
        "epoch": payload["sourceEpoch"],
        "checkpoint": payload["sourceCheckpoint"],
        "leaseToken": payload["sourceLeaseToken"],
        "sourceETag": payload["sourceETag"],
        "contentId": candidate[0],
        "contentHash": candidate[1],
        "attemptId": telemetry.current_attempt_id(),
    }
    try:
        response = requests.post(
            cfg.gateway_url.rstrip("/") + "/api/internal/source-refresh/publish",
            json=body,
            headers={
                "X-Pipeline-Secret": cfg.pipeline_secret,
                **obs.outbound_headers(),
            },
            timeout=_SOURCE_PUBLISH_TIMEOUT_S,
        )
    except (requests.Timeout, requests.ConnectionError) as exc:
        if not _source_refresh_published(job_id, payload):
            raise RetryableError("source publication gateway was unavailable") from exc
    else:
        if response.status_code == 409:
            if not _source_refresh_published(job_id, payload):
                raise db.SourceSupersededError(
                    "source checkpoint advanced before publication"
                )
        elif response.status_code >= 500 or response.status_code == 429:
            raise RetryableError(
                f"source publication gateway returned {response.status_code}"
            )
        elif response.status_code != 200:
            detail = (
                f"source publication gateway returned {response.status_code}: "
                f"{response.text[:500]}"
            )
            # collaboration answers a publication rebase the Office engine
            # refused with 422 and the engine's "Office rebase:" message.
            if response.status_code == 422 and "Office rebase:" in response.text:
                raise db.SourceRebaseRefusedError(detail)
            raise TerminalError(detail)
    _settle_published_source_refresh(job_id, payload)
    return True


def _resume_source_publication(job: dict) -> bool:
    payload = job.get("payload") or {}
    if payload.get("sourceRefresh") is not True:
        return False
    if _source_refresh_published(job["id"], payload):
        _settle_published_source_refresh(job["id"], payload)
        return True
    with db.connect() as conn, conn.cursor() as cur:
        db.require_current_file_source(
            cur,
            payload["fileId"],
            int(payload["sourceRevision"]),
            payload["sourceETag"],
        )
        cur.execute(
            """SELECT c.content_hash
            FROM source_refresh_candidates c JOIN rag_contents r ON r.id=c.content_id
            JOIN jobs j ON j.id=c.job_id
            WHERE c.file_id=%s AND c.job_id=%s AND c.lease_token=%s
              AND j.payload->>'sourcePublicationReady'='true'
              AND r.status='ready' AND r.content_hash=c.content_hash""",
            (payload["fileId"], job["id"], payload["sourceLeaseToken"]),
        )
        ready = cur.fetchone()
    if ready is None:
        return False
    _set_stage("publishing")
    _finish_source_refresh(payload["fileId"], job["id"], *ready)
    return True


@dataclass(frozen=True)
class Missing:
    """The parts an ingest leaves missing: the pending descriptor's failure
    and the 1-based pages the VLM left unread. ``unread`` marks unread pages
    this job did not read itself (a parts-only job on content whose
    ``pipeline_identity`` is NULL), so it cannot name them."""

    summary: str | None = None
    pages: tuple[int, ...] = ()
    unread: bool = False

    def __bool__(self) -> bool:
        return self.summary is not None or bool(self.pages) or self.unread


COMPLETE = Missing()


def _finish_ok(
    file_id: str,
    job_id: str,
    content_hash: str | None = None,
    indexed: bool = True,
    attempt: int | None = None,
    actor_user_id: str = "",
    workspace_id: str = "",
    reservation_id: str = "",
    source_revision: int | None = None,
    source_etag: str = "",
    parse_fee: bool = True,
    content_id: str | None = None,
    missing: Missing = COMPLETE,
) -> bool:
    """Commit a finished ingest. With ``missing`` parts the file ends failed
    with its content indexed, so Retry processing fills them in.

    ``content_id`` is the content the job published, which the file must
    still alias (else the job ends superseded); once it is complete, every
    other file aliasing it that is failed with indexed content goes ready.
    A source refresh leaves the status to Go's publication."""
    refresh = db.source_refresh_for(file_id)
    if refresh is not None:
        return _finish_source_refresh(file_id, job_id, content_hash)
    usage = obs.take_parse_usage()
    siblings: list[str] = []
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
                if content_id is not None:
                    cur.execute(
                        "SELECT content_id FROM rag_file_contents WHERE file_id=%s FOR UPDATE",
                        (file_id,),
                    )
                    alias = cur.fetchone()
                    if alias is None or alias[0] != content_id:
                        raise db.SourceSupersededError(
                            "the file's index moved before the ingest finished"
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
                    charged=parse_fee,
                )
                db.settle_credit_reservation(cur, reservation_id)
                db.set_file_status(cur, file_id, "failed" if missing else "ready")
                db.set_file_indexed(cur, file_id, indexed)
                if content_hash is not None:
                    db.set_file_content_hash(cur, file_id, content_hash)
                cur.execute(
                    r"UPDATE files SET ever_parsed_successfully=true WHERE id=%s AND trashed_at IS NULL AND (kind='pdf' OR lower(name) ~ '\.(docx|xlsx|pptx)$') AND parse_mode='fast'",
                    (file_id,),
                )
                if content_id is not None and not missing:
                    # Duplicate uploads share the content row, so its parts;
                    # the row itself must show both present.
                    cur.execute(
                        """UPDATE files SET status='ready'
                        WHERE id IN (SELECT file_id FROM rag_file_contents WHERE content_id=%s)
                          AND id<>%s AND status='failed' AND indexed AND trashed_at IS NULL
                          AND EXISTS (SELECT 1 FROM rag_content_summaries WHERE content_id=%s)
                          AND EXISTS (SELECT 1 FROM rag_contents
                                      WHERE id=%s AND pipeline_identity IS NOT NULL)
                        RETURNING id""",
                        (content_id, file_id, content_id, content_id),
                    )
                    siblings = [row[0] for row in cur.fetchall()]
                db.set_job(
                    cur, job_id, "done", _missing_note(missing) if missing else None
                )
                db.finish_job_attempt(
                    cur,
                    attempt_id=telemetry.current_attempt_id(),
                    outcome="succeeded",
                    snapshot=telemetry.snapshot(),
                )
            conn.commit()
    except Exception:
        obs.restore_parse_usage(usage)
        raise
    for sibling in siblings:
        _publish_progress(
            workspace_id, sibling, "done", 100, status="ready", indexed=True
        )
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
    index_limit: str = "",
) -> bool | None:
    """Fail the job. The file fails too, still indexed while its alias serves
    a previous index, unless ``index_limit`` names the ingest limit its content
    is over: then it is ready and unindexed (its alias dropped), still usable,
    and only search and chat skip it. Returns the file's written ``indexed``
    (False without a file), or None when the claim was lost."""
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
                return None
            indexed = False
            if file_id:
                if source_revision is not None and boundary_payload is None:
                    db.require_current_file_source(
                        cur, file_id, source_revision, source_etag
                    )
                if index_limit and db.source_refresh_for(file_id) is None:
                    # Search skips a file over a limit, so its previous index
                    # goes too (the orphan trigger drops unshared content).
                    cur.execute(
                        "DELETE FROM rag_file_contents WHERE file_id=%s", (file_id,)
                    )
                    db.set_file_index_limit(cur, file_id, index_limit)
                db.set_file_status(cur, file_id, "ready" if index_limit else "failed")
                indexed = db.set_file_indexed_as_served(cur, file_id)
            db.set_job(cur, job_id, "failed", error[:500])
            db.close_credit_reservation(cur, reservation_id)
            if file_id:
                active = db.source_refresh_for(file_id)
                if active is not None:
                    # A refused Office rebase leaves the file due (stale), so a
                    # fresh publication captures the edits it could not place.
                    db.discard_source_candidate(
                        cur,
                        active,
                        job_id,
                        error,
                        stale=error_code == "office_rebase_refused",
                    )
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="failed",
                snapshot=telemetry.snapshot(),
                error_category=error_category,
                error_code=error_code,
            )
        conn.commit()
    return indexed


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
    """Close a stale job without mutating or notifying for the newer revision."""
    with db.connect() as conn, conn.cursor() as cur:
        if not _lost_claim(cur, job_id, attempt):
            db.set_job(cur, job_id, "failed", "superseded by newer source revision")
        # The publish may already have made the job terminal. The generated
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
        # Cancellation normally closes this with the old job. This also covers
        # the SKIP LOCKED race where the worker held the job row.
        db.close_credit_reservation(cur, reservation_id)
        active = db.source_refresh_for_job(job_id)
        if active is not None:
            db.discard_source_candidate(
                cur, active, job_id, "source checkpoint superseded", stale=True
            )
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
    index_limit: str = "",
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
    indexed = _finish_fail(
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
        index_limit=index_limit,
    )
    if indexed is None:
        return
    if index_limit:
        if ws:
            _publish_progress(ws, file_id, "done", 100, status="ready", indexed=False)
        log.info("ingest %s is over its %s and stays unindexed", name, index_limit)
        return
    # A refused Office rebase leaves the published file as it was and due for
    # a fresh publication, so the workspace sees no failure.
    if ws and error_code != "office_rebase_refused":
        _publish_progress(
            ws,
            file_id,
            "failed",
            100,
            status="failed",
            message=error[:200],
            indexed=indexed,
        )
    log.info("ingest %s failed terminally: %s", name, error)


def _missing_note(missing: Missing) -> str:
    """The job note (and progress message) naming a file's missing parts."""
    parts = []
    if missing.summary is not None:
        parts.append(f"summary pending ({missing.summary[:200]})")
    if missing.pages:
        pages = missing.pages
        shown = ", ".join(str(page) for page in pages[:20])
        more = f" and {len(pages) - 20} more" if len(pages) > 20 else ""
        parts.append(f"{len(pages)} pages could not be read (p. {shown}{more})")
    elif missing.unread:
        parts.append("some pages could not be read")
    return "; ".join(parts) + "; retry processing fills them in"


def _summary_reason(job: dict, error: Exception | None) -> str | None:
    """The pending descriptor's failure, None once a descriptor is present.

    A busy provider re-pends the job once: its content is already published,
    so the re-claim only fills the descriptor. After that, or on any other
    failure, the descriptor is a missing part."""
    if error is None:
        return None
    if (
        isinstance(error, elitellm.ProviderBusy)
        and int(job.get("provider_waits") or 0) < PROVIDER_WAITS_MAX
    ):
        raise error
    return str(error) or type(error).__name__


async def _fill_summary(job: dict, ws: str, content_id: str, name: str) -> str | None:
    """Fill published content's pending descriptor (a no-op when present)."""
    error = await indexing.fill_descriptor(
        workspace_id=ws, content_id=content_id, file_name=name
    )
    return _summary_reason(job, error)


def _publish_done(
    ws: str, file_id: str, missing: Missing, note: str | None = None
) -> None:
    """The terminal progress event: ready, or failed with the missing parts
    named while the content stays indexed."""
    if missing:
        _publish_progress(
            ws,
            file_id,
            "failed",
            100,
            status="failed",
            message=_missing_note(missing),
            indexed=True,
        )
        return
    if note is None:
        _publish_progress(ws, file_id, "done", 100, status="ready", indexed=True)
    else:
        _publish_progress(
            ws, file_id, "done", 100, status="ready", message=note, indexed=True
        )


def _read_name(file_id: str) -> str:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_name(cur, file_id)


def _audio_context(workspace_id: str, name: str) -> str:
    """The text sent ahead of a recording so names come out right: the
    workspace's title and the file's name."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT name FROM workspaces WHERE id=%s", (workspace_id,))
        row = cur.fetchone()
    title = str(row[0]) if row else ""
    return f"Workspace: {title}\nFile: {name}"


def _account_allows_ingest(file_id: str, payload: dict, check_credits: bool) -> bool:
    """Stage gate: owner lifecycle/storage, actor lifecycle, optionally credits.

    Credits are checked once, at a job's first claim. A job admitted there runs
    to completion even if its own parse pushes the actor past the limit; the
    next interactive request is what refuses. Later stages and the parse-to-
    ingest continuation pass ``check_credits=False`` so a half-parsed file is
    never abandoned over the bill it already ran up.

    A missing actor is refused rather than waved through. It used to mean "no
    actor, nothing to check", which let a job parse, caption and embed
    and against three providers while billing nobody. The gateway will not
    enqueue without one, so reaching here without an actor means the row was
    written around it.
    """
    actor = payload.get("actorUserId") or ""
    if not actor:
        return False
    # A system-paid job (a maintenance republish or an export-only file's
    # reprocess) skips the owner's storage and the credit checks.
    system = payload.get("paidBy") == "system"
    with db.connect() as conn, conn.cursor() as cur:
        if not db.ingest_accounts_active(cur, file_id, actor):
            return False
        owner = db.file_owner_user_id(cur, file_id)
        if not owner or not (system or db.account_allows_ingest(cur, owner)):
            return False
        if not check_credits or system:
            return True
        return db.actor_has_credits(cur, actor)


def _first_claim(job: dict, payload: dict) -> bool:
    """True for the first attempt of a job that is not a parse continuation.

    Busy-provider and capacity re-pends hand the attempt back, so a re-claimed
    job would look first again; the wait counter tells them apart.
    """
    return (
        int(job.get("attempts") or 1) == 1
        and int(job.get("provider_waits") or 0) == 0
        and not payload.get("parseJobId")
    )


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


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
    """Remove a finished job's local source and parse bundle."""
    descriptor = payload.get("localSource")
    if isinstance(descriptor, dict):
        blobstore.cleanup_local_source(
            str(descriptor.get("key") or ""), cfg.parse_shared_dir
        )
    _release_parse_artifact(payload)


def _release_parse_artifact(payload: dict) -> None:
    """Delete a continuation's local parse bundle once its job row is terminal.

    Bundles are fingerprint-addressed, so one another pending or running job
    still names stays for that job. Post-commit and best effort: the idle spool
    sweep removes anything left behind.
    """
    artifact = payload.get("parseArtifact")
    if not isinstance(artifact, dict):
        return
    try:
        with db.connect() as conn, conn.cursor() as cur:
            in_use = db.active_local_spool_keys(cur)
        if str(artifact.get("key") or "") not in in_use:
            parser_client.discard_artifact(artifact)
    except Exception:
        log.warning("could not delete local parse bundle", exc_info=True)


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
    message: str = "waiting for parser capacity",
    backoff_s: int = YIELD_BACKOFF_S,
    outcome: str = "capacity_wait",
    count_provider_wait: bool = False,
) -> None:
    """Give the slot back to the queue. File stays pending; attempt is undone.

    A provider that stayed busy is the same wait with its own counter, so the
    worker can cap how often one job comes back for the same model. A note
    index job (no ``file_id``) keeps its note's job pointer and sends no
    progress.
    """
    attempt = int(job.get("attempts") or 1)
    payload = job.get("payload") or {}
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt, payload):
            return
        if count_provider_wait:
            db.release_job_for_provider_busy(
                cur, job["id"], attempt, backoff_s=backoff_s
            )
        else:
            db.release_job_for_capacity(cur, job["id"], attempt, backoff_s=backoff_s)
        if file_id:
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
    if file_id:
        _publish_progress(
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
        direct = "direct:image"
    elif processing_plan.route == ingest_plan.AUDIO_TRANSCRIPTION:
        direct = "direct:filetrans"
    else:
        direct = ""
    if direct:
        return f"plan-v{processing_plan.version}:{direct}:{CHUNKER_VERSION}"
    route = _parse_route(processing_plan.parser_route)
    return (
        f"plan-v{processing_plan.version}:{route}:"
        f"{parser_client.parser_implementation(route)}:{CHUNKER_VERSION}"
    )


def _parse_fee(payload: dict) -> bool:
    """Whether this job's parse pays the page fee. Go decides it for each
    source refresh at admission and for a partial file's Retry processing
    (parts design Q6); an upload's parse is its first and pays; a system-paid
    job (an export-only file's reprocess) never does."""
    if payload.get("paidBy") == "system":
        return False
    if payload.get("sourceRefresh") is True:
        return payload["parseFee"] is True
    return payload.get("parseFee", True) is True


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
    charged: bool,
) -> None:
    """Record one parse's pages. ``charged`` is False for a refresh of a parsed
    file: the page fee applies to a file's first parse only."""
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
        )
        if charged
        else 0,
        reservation_id=reservation_id,
        # Job-scoped: the fingerprint alone is a global content hash, and the
        # ledger key is globally unique, so two jobs that each really ran the
        # parser on identical bytes would otherwise bill only the first.
        idempotency_key=(
            f"parse-receipt:{usage.receipt_id}:{job_id}"
            if usage.receipt_id
            else f"parse:{job_id}:{attempt}"
        ),
        trace_id=obs.trace_id(),
        metadata={
            "fileId": file_id,
            "jobId": job_id,
            "attempt": attempt,
            "outcome": outcome,
            "parseFee": charged,
            "sourceFormat": usage.source_format,
            "parseReceiptId": usage.receipt_id,
            "digitalPageRate": _rate(_RESOURCE_DIGITAL_PAGE),
            "vlmPageRate": _rate(_RESOURCE_VLM_PAGE),
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
                charged=_parse_fee(payload),
            )
            conn.commit()
    except Exception:
        # Keep the receipt in this context if the database write failed. The job
        # stays running, so its lease/retry path can try the same idempotency key.
        obs.restore_parse_usage(usage)
        raise


def _handoff_parsed_artifact(
    *,
    job: dict,
    payload: dict,
    file_id: str,
    workspace_id: str,
    artifact: dict | None,
) -> bool:
    """Finish the parse claim and enqueue its ingest continuation atomically.

    Without an artifact the continuation is parts-only: a donor copy whose
    descriptor is pending, which the coordinator (no provider keys) leaves to
    an ingest worker."""
    attempt = int(job.get("attempts") or 1)
    continuation_payload = dict(payload)
    if artifact is None:
        continuation_payload["partsOnly"] = True
        # The coordinator removes its local source once the copy is done.
        continuation_payload.pop("localSource", None)
    else:
        continuation_payload["parseArtifact"] = dict(artifact)
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
                charged=_parse_fee(payload),
            )
            db.enqueue_job(cur, continuation_id, "ingest", continuation_payload)
            db.transfer_source_candidate(cur, payload, job["id"], continuation_id)
            if artifact is not None:
                # A parse ran. A donor copy leaves it to _finish_ok's rule.
                cur.execute(
                    "UPDATE files SET ever_parsed_successfully=true WHERE id=%s AND trashed_at IS NULL",
                    (file_id,),
                )
            db.set_job(cur, job["id"], "done")
            db.finish_job_attempt(
                cur,
                attempt_id=telemetry.current_attempt_id(),
                outcome="succeeded",
                snapshot=telemetry.snapshot(),
            )
            conn.commit()
    except Exception:
        obs.restore_parse_usage(usage)
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
        db.enqueue_job(cur, repair_id, "parse", repair_payload)
        db.transfer_source_candidate(cur, payload, job["id"], repair_id)
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
    await asyncio.to_thread(
        _set_file_status,
        file_id,
        "processing",
        int(payload["sourceRevision"]),
        str(payload.get("sourceETag") or ""),
        str(payload.get("actorUserId") or ""),
    )
    _publish_progress(workspace_id, file_id, "parsing", 15, status="processing")
    try:
        _set_stage("parser_call")
        artifact = await asyncio.to_thread(
            parser_client.ensure_artifact,
            descriptor,
            name,
            job["id"],
        )
    except parser_client.ParserTooManyScannedPagesError as exc:
        raise InputLimitError("scanned_page_limit", str(exc)) from exc
    except parser_client.ParserTooManyPagesError as exc:
        raise InputLimitError("page_limit", str(exc)) from exc
    except parser_client.ParserTooManyElementsError as exc:
        raise InputLimitError("element_limit", str(exc)) from exc
    except parser_client.ParserTerminalResourceError as exc:
        raise TerminalError(
            "this file hit a terminal parser resource limit and is "
            "quarantined for the current parser version"
        ) from exc
    except parser_client.ParserFormatMismatchError as exc:
        raise TerminalError(str(exc)) from exc
    except parser_client.ParserUnreadableError as exc:
        raise TerminalError(f"this file cannot be parsed: {exc}") from exc
    except parser_client.ParserCapacityError as exc:
        # The parser's bounded queue answered 429; the job re-pends without
        # spending an attempt.
        raise CapacityWait(route) from exc

    if not all(artifact.get(field) for field in ("key", "fingerprint", "version")):
        raise RetryableError("parser returned an incomplete artifact descriptor")
    await asyncio.to_thread(
        parser_client.validate_artifact,
        artifact,
        route=route,
        office=processing_plan.office,
    )
    telemetry.record(artifact_bytes=max(0, int(artifact.get("size") or 0)))
    _set_stage("parse_handoff")
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
    last_wait: bool = False,
) -> tuple[list[Chunk], list[int], bytes | None]:
    """Parse one source into chunks, the 1-based pages the VLM left unread,
    and the parse's page-1 image for the card thumbnail. ``last_wait``: the
    job's busy re-pend is spent (see ``_read_vlm_pages``)."""
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
        _publish_progress(ws, file_id, "indexing", 40, status="processing")
        return chunk_markdown(text), [], None

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
        _publish_progress(
            ws,
            file_id,
            {"image": "captioning", "audio": "transcribing"}.get(direct, "indexing"),
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
                file_id=file_id,
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
            if not local_path:
                raise RetryableError("local audio source is missing")
            _set_stage("audio_transcription")
            (
                sentences,
                derived_key,
                derived_size,
            ) = await source_text.transcribe_audio_source(
                local_path=local_path,
                source_sha256=source_sha256,
                blob_path=str(payload["blobPath"]),
                context=await asyncio.to_thread(_audio_context, ws, name),
                second_rate_micros=_rate(_RESOURCE_AUDIO_SECOND)["creditMicrosPerUnit"],
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
        _publish_progress(ws, file_id, "indexing", 50, status="processing")
        if direct == "audio":
            return chunk_transcript(sentences), [], None
        if direct == "tabular":
            # Every row carries its own headers, so a table chunks with no
            # overlap: a carried row would only repeat in the next chunk.
            return chunk_markdown(text, overlap_tokens=0), [], None
        return chunk_markdown(text), [], None

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
            office=processing_plan.office,
        )
        _publish_progress(ws, file_id, "indexing", 45)
        _set_stage("vlm_pages")
        content_list, unread = await _read_vlm_pages(
            content_list, raw_dir, file_id, name, last_wait=last_wait
        )
        _set_stage("chunking")
        chunks = await asyncio.to_thread(
            _page_chunks, content_list, raw_dir, Path(local_path or "")
        )
        _publish_progress(ws, file_id, "indexing", 55)
        # Extraction already bounded this entry (parser_client._entry_limit).
        page = raw_dir / parser_client.PAGE_IMAGE
        return chunks, unread, page.read_bytes() if page.is_file() else None
    finally:
        shutil.rmtree(raw_dir, ignore_errors=True)


async def _read_vlm_pages(
    content_list: list[dict],
    raw_dir: Path,
    file_id: str,
    name: str,
    *,
    last_wait: bool = False,
) -> tuple[list[dict], list[int]]:
    """Read the bundle's text-less page renders (``vlm/<page>.jpg``) with the
    VLM. Each read page becomes one text block after that page's own blocks;
    returns the blocks and the 1-based pages left unread. A page read before
    for this file, or an eligible donor, comes from the caption cache free.

    A provider busy past its budget re-pends the job; on ``last_wait`` (the
    job's one re-pend spent) that page is unread instead, so the file ends
    partial rather than failing ``provider_busy`` (parts design §6)."""
    renders = sorted(raw_dir.glob("vlm/*.jpg"), key=lambda path: int(path.stem))
    if not renders:
        return content_list, []
    rate = int(_rate(_RESOURCE_VLM_PAGE)["creditMicrosPerUnit"])
    # One job reads CAPY_VLM_PAGES_PER_JOB pages at once, below the gate every
    # worker shares (CAPY_VLM_PAGE_CAPACITY), so jobs take turns at it.
    limit = asyncio.Semaphore(cfg.vlm_pages_per_job)
    # UAT only (ingest/uat.py): a marked file's reads fail or are scripted,
    # under a cache key of their own, so no real read is served from them or
    # them from a real one.
    fail, token = uat.fail_pages(name), uat.scripted_token(name)
    marker = uat.FAIL_PAGES if fail else None if token is None else uat.SCRIPTED_VLM
    salt = f"{marker}{token or ''}\0".encode() if marker else b""

    async def read_page(page: int, data_url: str) -> str | None:
        if fail:
            return None
        try:
            if token is None:
                return await models.read_page(data_url, credit_micros=rate)
            return await models.read_page(
                data_url,
                credit_micros=rate,
                scripted=uat.scripted_page(token, page + 1),
            )
        except elitellm.ProviderBusy:
            if last_wait:
                return None
            raise

    async def read(path: Path) -> tuple[int, str]:
        page = int(path.stem)
        jpeg = await asyncio.to_thread(path.read_bytes)
        url = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
        async with limit:
            text, *_ = await caption_cache.caption(
                file_id=file_id,
                image_sha256=hashlib.sha256(b"vlm-page\0" + salt + jpeg).hexdigest(),
                data_url=url,
                read=lambda data_url: read_page(page, data_url),
                exclusive=False,
            )
        return page, text

    tasks = [asyncio.ensure_future(read(path)) for path in renders]
    try:
        results = await asyncio.gather(*tasks)
    except BaseException:
        # A busy provider re-pends the job; the pages already read are cached.
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    blocks = list(content_list)
    unread = []
    for page_idx, text in results:
        if not text:
            unread.append(page_idx + 1)
            continue
        after = max(
            (i for i, b in enumerate(blocks) if int(b.get("page_idx", -1)) <= page_idx),
            default=-1,
        )
        blocks.insert(
            after + 1,
            {
                "type": "text",
                "text": text,
                "page_idx": page_idx,
                # No line boxes: the whole page, so a citation opens this page.
                "bbox": [0, 0, 1000, 1000],
                "_recovery": VLM_RECOVERY,
            },
        )
    return blocks, unread


def _page_chunks(
    content_list: list[dict], raw_dir: Path, source_pdf: Path
) -> list[Chunk]:
    """Pack blocks, then keep the headings and score the chunks against the
    frozen Office page evidence or, for a PDF, the evidence the decode helper
    reads from the exact PDF the parse used."""
    refinement_path = raw_dir / "refinement.json"
    if not refinement_path.is_file():
        raise TerminalError("parse artifact has no refinement.json")
    refinement = json.loads(refinement_path.read_text(encoding="utf-8"))
    furniture = refinement.get("furniture")
    if not isinstance(furniture, list) or not all(
        isinstance(t, str) for t in furniture
    ):
        raise TerminalError("parse artifact refinement.json has no furniture list")
    chunks = pack_blocks(content_list, frozenset(furniture))
    evidence = refinement.get("page_evidence")
    if evidence is None:
        repaired = raw_dir / "parsed.pdf"
        page_pdf = repaired if repaired.is_file() else source_pdf
        if not page_pdf.is_file():
            raise RetryableError("page-model PDF for the parsed document is missing")
        evidence = decode.page_evidence(page_pdf, content_list)
    chunks = retain_headings(
        content_list, chunks, verified=set(evidence["visible_headings"])
    )
    score_chunks(chunks, vlm=vlm_pages(content_list), page_texts=evidence["page_texts"])
    return chunks


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
    token = db.bind_source_refresh(job)
    try:
        await _process_ingest_job_bound(job)
    finally:
        db.reset_source_refresh(token)


async def _process_ingest_job_bound(job: dict) -> None:
    _set_stage("validating")
    payload = job["payload"] or {}
    if payload.get("materialId"):
        await _process_material_index_bound(job)
        return
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
        and payload.get("partsOnly") is not True
        and (
            not isinstance(payload.get("parseArtifact"), dict)
            or not str(payload.get("parseJobId") or "").strip()
        )
    ):
        raise TerminalError("document ingest has no completed parse handoff")
    rates = payload.get("resourceRates")
    if not isinstance(rates, dict) or not _REQUIRED_RESOURCE_RATES.issubset(rates):
        raise TerminalError("ingest payload is missing resource rate snapshots")

    if await asyncio.to_thread(_resume_source_publication, job):
        await asyncio.to_thread(_release_parse_artifact, payload)
        return

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
            else "waiting for parser capacity",
            YIELD_BACKOFF_S,
            "capacity_wait",
        )
        raise
    finally:
        if accounting_token is not None:
            accounting.reset(accounting_token)
        _resource_rates.reset(rates_token)
        registry.set_job_pins(None)


# ------------------------------------------------------------- note index


async def _process_material_index_bound(job: dict) -> None:
    """Index one workspace note: fetch its text from the gateway, chunk it like
    a text file, embed the chunks that changed and publish the canonical
    content with the note's summary (indexing._note_summary). Notes get no
    parse stage and no page model. A failed claim is abandoned; the note keeps
    its previous index."""
    payload = job["payload"] or {}
    material_id = str(payload["materialId"])
    ws = str(payload["workspaceId"])
    rates = payload.get("resourceRates")
    if not isinstance(rates, dict) or not _REQUIRED_RESOURCE_RATES.issubset(rates):
        raise TerminalError("note index payload is missing resource rate snapshots")
    try:
        pins = registry.pins_from_payload(
            payload, embedding=await _workspace_embedding_spec(ws)
        )
    except (registry.RegistryError, TerminalError) as exc:
        raise TerminalError(
            f"note index refused because its model pins could not be resolved: {exc}"
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
        _set_stage("indexing")
        note = await asyncio.to_thread(_fetch_material_text, material_id, ws)
        if note is None:
            # Trashed, standalone or gone: nothing to index, nothing to retry.
            await asyncio.to_thread(_finish_material_index, job)
            return
        chunks = chunk_markdown(str(note.get("text") or ""))
        blocks = note["blocks"]
        association = await store.attach_material_content(
            workspace_id=ws,
            material_id=material_id,
            content_hash="note:" + indexing.content_hash(chunks),
            claim_job_id=job["id"],
            blocks=blocks,
        )
        embedded = 0
        if not association["ready"]:
            if not association["created"]:
                raise RetryableError("note content is being indexed by another job")
            try:
                result = await indexing.index_material(
                    workspace_id=ws,
                    material_id=material_id,
                    title=str(note.get("title") or ""),
                    content_id=association["content_id"],
                    previous_content_id=association["previous_content_id"],
                    chunks=chunks,
                    claim_job_id=job["id"],
                    blocks=blocks,
                )
            except BaseException:
                await store.abandon_content(association["content_id"])
                raise
            embedded = result["embedded"]
        else:
            await indexing.fill_note_summary(
                workspace_id=ws,
                material_id=material_id,
                title=str(note.get("title") or ""),
                content_id=association["content_id"],
                chunks=chunks,
            )
        telemetry.record(chunks_created=len(chunks), chunks_embedded=embedded)
        await asyncio.to_thread(_finish_material_index, job)
    finally:
        if accounting_token is not None:
            accounting.reset(accounting_token)
        _resource_rates.reset(rates_token)
        registry.set_job_pins(None)


def _fetch_material_text(material_id: str, workspace_id: str) -> dict | None:
    """The note's markdown-like text from Go; None when the note is no longer
    indexable (trashed, standalone, deleted or outside this workspace)."""
    if not cfg.gateway_url or not cfg.pipeline_secret:
        raise TerminalError(
            "GATEWAY_URL and PIPELINE_SECRET are required to index notes"
        )
    try:
        response = requests.get(
            cfg.gateway_url.rstrip("/")
            + f"/api/internal/materials/{material_id}/index-text",
            params={"workspaceId": workspace_id},
            headers={"X-Pipeline-Secret": cfg.pipeline_secret},
            timeout=30,
        )
    except (requests.Timeout, requests.ConnectionError) as exc:
        raise RetryableError("note index gateway was unavailable") from exc
    if response.status_code == 404:
        return None
    if response.status_code >= 500 or response.status_code == 429:
        raise RetryableError(f"note index gateway returned {response.status_code}")
    if response.status_code != 200:
        raise TerminalError(f"note index gateway returned {response.status_code}")
    body = response.json()
    return body if isinstance(body, dict) else None


def _finish_material_index(job: dict) -> None:
    attempt = int(job.get("attempts") or 1)
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt):
            return
        db.settle_credit_reservation(cur, _reservation_id(job["payload"] or {}))
        # Migration 0082's trigger releases the note when its job ends.
        db.set_job(cur, job["id"], "done")
        db.finish_job_attempt(
            cur,
            attempt_id=telemetry.current_attempt_id(),
            outcome="succeeded",
            snapshot=telemetry.snapshot(),
        )
        conn.commit()


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
    ``ready`` and aliased; the caller indexes into the row afterwards, so
    returning on a claim someone else holds would mean two workers writing the
    same content. The job wall-clock timeout is the hard bound — raising after
    a short wait would burn the waiter's attempt budget while a live creator is
    still indexing.
    """
    loop = asyncio.get_running_loop()
    steal_after = loop.time() + CONTENT_CLAIM_WAIT_S
    while not association["created"] and not association["ready"]:
        await asyncio.sleep(cfg.poll_interval)
        status = await store.content_status(association["content_id"])
        if status not in (None, "ready") and loop.time() < steal_after:
            continue
        if status != "ready":
            # The claim is either gone (the creator abandoned it) or stale
            # enough that its owner looks dead. Either way, try to take it
            # over; losing the race just means waiting on whoever won it.
            await store.steal_stale_content(
                workspace_id=workspace_id,
                content_hash=content_hash,
                stale_s=CONTENT_CLAIM_STALE_S,
            )
        # Attaching again aliases ready content (a deferred alias moves now)
        # or takes over a dropped claim.
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
    if route == ingest_plan.IMAGE_CAPTION:
        try:
            cached = await caption_cache.lookup(file_id, source_sha256)
        except TerminalError:
            raise
        except Exception:
            log.warning("could not read eligible image caption", exc_info=True)
            return False
        if cached is None:
            return False
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
    content_id = association["content_id"]
    note = None
    if association["ready"]:
        if not await store.attach_donor_captions(
            donor_id=donor["id"], dest_workspace_id=ws, dest_file_id=file_id
        ):
            return False
        note = f"{name}: identical content already indexed; reusing its index."
    else:
        copied = await store.copy_content_from_donor(
            dest_file_id=file_id,
            donor_id=donor["id"],
            dest_content_id=content_id,
            dest_workspace_id=ws,
            copy_vectors=copy_vectors,
        )
        if not copied:
            # Parsing follows; a re-ingest's previous index keeps serving.
            await store.abandon_content(content_id)
            return False
        try:
            if copy_vectors:
                result = {"chunks": "copied", "donor": donor["id"]}
            else:
                result = await indexing.embed_copied_chunks(
                    workspace_id=ws,
                    content_id=content_id,
                    claim_job_id=job["id"],
                )
            if isinstance(result.get("chunks"), int):
                telemetry.record(chunks_created=max(0, int(result["chunks"])))
            await store.publish_file_content(
                workspace_id=ws,
                file_id=file_id,
                content_id=content_id,
                claim_job_id=job["id"],
                source_revision=source_revision,
                source_etag=source_etag,
            )
        except BaseException:
            await store.abandon_content(content_id)
            raise
        log.info("indexed %s from donor: %s", name, result)
    # A donor's pending descriptor is filled for this file (parts design Q9):
    # inline here, or by a parts-only continuation from a parse coordinator,
    # which holds no provider keys.
    if job.get("type") == "parse":
        if not await store.has_content_summary(content_id):
            handed_off = await asyncio.to_thread(
                _handoff_parsed_artifact,
                job=job,
                payload=payload,
                file_id=file_id,
                workspace_id=ws,
                artifact=None,
            )
            if handed_off:
                _publish_progress(
                    ws,
                    file_id,
                    "indexing",
                    90,
                    status="processing",
                    message=f"{name}: identical content already indexed; describing it.",
                )
            return handed_off
        missing = COMPLETE
    else:
        missing = Missing(await _fill_summary(job, ws, content_id, name))
    committed = await asyncio.to_thread(
        _finish_ok,
        file_id,
        job["id"],
        donor["content_hash"],
        attempt=attempt,
        actor_user_id=payload.get("actorUserId") or "",
        workspace_id=ws,
        reservation_id=_reservation_id(payload),
        source_revision=source_revision,
        source_etag=source_etag,
        content_id=content_id,
        missing=missing,
    )
    if not committed:
        return False
    _publish_done(ws, file_id, missing, note)
    return True


async def _process_parts_bound(
    job: dict, payload: dict, file_id: str, ws: str, name: str
) -> None:
    """A parts-only job (``partsOnly``): Retry processing of a file whose only
    missing part is its descriptor, or a parse coordinator's donor
    continuation. Fills the published content's pending descriptor from its
    stored chunks, with no parse and no embedding, then finishes the file.
    Unread pages (a NULL ``pipeline_identity``) stay a missing part."""
    _set_stage("parts_fill")
    content = await store.file_content(file_id)
    if content is None or content["status"] != "ready":
        raise TerminalError("parts-only job found no published content")
    missing = Missing(
        await _fill_summary(job, ws, content["id"], name),
        unread=content["pipeline_identity"] is None,
    )
    committed = await asyncio.to_thread(
        _finish_ok,
        file_id,
        job["id"],
        content["content_hash"],
        attempt=int(job.get("attempts") or 1),
        actor_user_id=payload.get("actorUserId") or "",
        workspace_id=ws,
        reservation_id=_reservation_id(payload),
        source_revision=int(payload["sourceRevision"]),
        source_etag=str(payload.get("sourceETag") or ""),
        content_id=content["id"],
        missing=missing,
    )
    if committed:
        _publish_done(ws, file_id, missing)


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
    if not await asyncio.to_thread(
        _account_allows_ingest, file_id, payload, _first_claim(job, payload)
    ):
        note = f"{name}: ingest refused because the account is locked or over quota."
        indexed = await asyncio.to_thread(
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
        if indexed is None:
            return
        _publish_progress(
            ws, file_id, "failed", 100, status="failed", message=note, indexed=indexed
        )
        return
    if payload.get("partsOnly") is True:
        await _process_parts_bound(job, payload, file_id, ws, name)
        return
    _publish_progress(ws, file_id, "queued", 5, status="pending")

    if processing_plan.route == ingest_plan.STORE_ONLY:
        _set_stage("store_only")
        note = f"{name}: stored without parsing (not indexed for retrieval)."
        committed = await asyncio.to_thread(
            _finish_ok,
            file_id,
            job["id"],
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
        _publish_progress(
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
        workspace_id=ws,
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
        )
        if reused:
            await _capture_thumbnail(
                ws, file_id, processing_plan, local_path, source_sha256, None
            )
            await asyncio.to_thread(cleanup_source)
            await asyncio.to_thread(_release_parse_artifact, payload)
            return

    if job_type == "parse":
        if not await asyncio.to_thread(_account_allows_ingest, file_id, payload, False):
            raise TerminalError(
                "ingest refused because the account is locked or over quota"
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
            _publish_progress(
                ws,
                file_id,
                "indexing",
                45,
                status="processing",
                message=f"{name}: parsed; waiting for ingestion.",
            )
        return

    _set_stage("content_prepare")
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload, False):
        raise TerminalError(
            "ingest refused because the account is locked or over quota"
        )
    try:
        chunks, unread, page_image = await _chunks_for(
            payload=payload,
            name=name,
            processing_plan=processing_plan,
            local_path=local_path,
            source_key=source_key,
            ws=ws,
            file_id=file_id,
            source_sha256=source_sha256,
            job_id=job["id"],
            last_wait=int(job.get("provider_waits") or 0) >= PROVIDER_WAITS_MAX,
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
            _publish_progress(
                ws,
                file_id,
                "queued",
                5,
                status="pending",
                message=f"{name}: parse artifact was invalid; parsing once more.",
            )
        return
    if not chunks and not (
        payload.get("sourceRefresh") is True and payload.get("format") == "text"
    ):
        if unread:
            raise TerminalError(_missing_note(Missing(pages=tuple(unread))))
        # The same artifact chunks the same way on every attempt.
        raise TerminalError("parse produced no indexable content")
    telemetry.record(chunks_created=len(chunks))

    digest = indexing.content_hash(chunks)
    # Content with unread pages has no identity, so it is never a donor: not
    # for this file's own retry, nor from a shared workspace.
    if unread:
        identity = None
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload, False):
        raise TerminalError(
            "ingest refused because the account is locked or over quota"
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
        missing = Missing(
            await _fill_summary(job, ws, association["content_id"], name),
            tuple(unread),
        )
        committed = await asyncio.to_thread(
            _finish_ok,
            file_id,
            job["id"],
            digest,
            attempt=attempt,
            actor_user_id=payload.get("actorUserId") or "",
            workspace_id=ws,
            reservation_id=_reservation_id(payload),
            source_revision=source_revision,
            source_etag=source_etag,
            parse_fee=_parse_fee(payload),
            content_id=association["content_id"],
            missing=missing,
        )
        if not committed:
            return
        _publish_done(ws, file_id, missing, note)
        await _capture_thumbnail(
            ws, file_id, processing_plan, local_path, source_sha256, page_image
        )
        await asyncio.to_thread(cleanup_source)
        await asyncio.to_thread(_release_parse_artifact, payload)
        return

    _set_stage("indexing")
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload, False):
        raise TerminalError(
            "ingest refused because the account is locked or over quota"
        )
    try:
        result = await indexing.index_file(
            workspace_id=ws,
            content_id=association["content_id"],
            file_id=file_id,
            file_name=name,
            chunks=chunks,
            allow_empty=payload.get("sourceRefresh") is True
            and payload.get("format") == "text",
            on_progress=lambda pct: _publish_progress(ws, file_id, "indexing", pct),
            claim_job_id=job["id"],
        )
        await store.publish_file_content(
            workspace_id=ws,
            file_id=file_id,
            content_id=association["content_id"],
            claim_job_id=job["id"],
            source_revision=source_revision,
            source_etag=source_etag,
        )
    except BaseException:
        await store.abandon_content(association["content_id"])
        raise
    telemetry.record(
        chunks_created=max(0, int(result.get("chunks") or 0)),
    )
    _set_stage("finalizing")
    # Published first: a busy summary provider re-pends with the content
    # searchable, and the re-claim only fills the descriptor.
    missing = Missing(_summary_reason(job, result["summary_error"]), tuple(unread))
    committed = await asyncio.to_thread(
        _finish_ok,
        file_id,
        job["id"],
        digest,
        attempt=attempt,
        actor_user_id=payload.get("actorUserId") or "",
        workspace_id=ws,
        reservation_id=_reservation_id(payload),
        source_revision=source_revision,
        source_etag=source_etag,
        parse_fee=_parse_fee(payload),
        content_id=association["content_id"],
        missing=missing,
    )
    if not committed:
        return
    _publish_done(ws, file_id, missing)
    await _capture_thumbnail(
        ws, file_id, processing_plan, local_path, source_sha256, page_image
    )
    await asyncio.to_thread(cleanup_source)
    await asyncio.to_thread(_release_parse_artifact, payload)
    log.info("indexed %s: %s", name, result)


async def _capture_thumbnail(
    ws: str,
    file_id: str,
    processing_plan: ingest_plan.ProcessingPlan,
    local_path: str | None,
    source_sha256: str,
    page_image: bytes | None,
) -> None:
    """The card thumbnail of a committed ingest; failures stay inside
    ``thumbnail.capture_source`` and never reach the job."""
    await asyncio.to_thread(
        thumbnail.capture_source,
        file_id=file_id,
        workspace_id=ws,
        plan=processing_plan,
        local_path=local_path,
        source_sha256=source_sha256,
        page_image=page_image,
    )


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
    token = db.bind_source_refresh(job)
    try:
        await _handle_job_failure_bound(job, exc)
    finally:
        db.reset_source_refresh(token)


async def _handle_job_failure_bound(job: dict, exc: BaseException) -> None:
    payload = job.get("payload") or {}
    fid = payload.get("fileId")
    ws = payload.get("workspaceId")
    if payload.get("sourceRefresh") is True and await asyncio.to_thread(
        _source_refresh_published, job["id"], payload
    ):
        await asyncio.to_thread(_settle_published_source_refresh, job["id"], payload)
        return
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
            # Any error after a publish is terminal for the old source, even
            # if the original error would normally retry. Never re-pend A once
            # the logical file points at B.
            exc = superseded
            error_category, error_code, _provider_status = telemetry.classify_error(exc)
        else:
            if payload.get("sourceRefresh") is True and isinstance(
                exc, db.SourceSupersededError
            ):
                # The refresh's source is still current, so nothing replaced
                # it. Fail it with its error: a superseded finish would leave
                # the file due, and the scheduler would admit it every pass.
                exc = TerminalError(f"source refresh refused its current source: {exc}")
                error_category, error_code = "source_refresh", "source_refresh_refused"
    if (
        isinstance(exc, elitellm.ProviderBusy)
        and job_type == "ingest"
        and (fid or payload.get("materialId"))
        and ws
    ):
        # The in-call busy budget is spent. Re-pend without spending an attempt
        # until the per-job cap, then fail the file (or park the note) as busy.
        waits = int(job.get("provider_waits") or 0)
        if waits < PROVIDER_WAITS_MAX:
            name = (
                await asyncio.to_thread(_read_name, str(fid))
                if fid
                else str(payload["materialId"])
            )
            await asyncio.to_thread(
                _yield_for_capacity,
                job,
                str(fid or ""),
                str(ws),
                name,
                int(payload.get("sourceRevision") or 0),
                str(payload.get("sourceETag") or ""),
                str(payload.get("actorUserId") or ""),
                "waiting for the model to free up",
                provider_wait_backoff_s(exc.provider_retry_after, waits),
                "provider_busy",
                count_provider_wait=True,
            )
            return
        error_category, error_code = "provider", "provider_busy"
        exc = TerminalError(f"the model stayed busy across {waits} waits: {exc}")
    # An accounting error fails the job: a settlement failure is never re-run
    # over a charged response, and missing capacity or accounting
    # configuration fails the same on another attempt.
    retry = (
        policy is not None
        and not isinstance(exc, accounting.AccountingError)
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
        await asyncio.to_thread(
            _finish_superseded,
            job["id"],
            attempts,
            _reservation_id(payload),
        )
        await asyncio.to_thread(_cleanup_payload_source, payload)
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
        if (
            outcome == "stale"
            and payload.get("sourceRefresh") is True
            and await asyncio.to_thread(_source_refresh_published, job["id"], payload)
        ):
            await asyncio.to_thread(
                _settle_published_source_refresh, job["id"], payload
            )
        log.info("job %s requeued (%s)", job["id"], outcome)
        return
    index_limit = ""
    if isinstance(exc, InputLimitError):
        # The user's file is over a documented limit and nothing on our side
        # broke. The job fails with the limit's code; the file stays usable,
        # unindexed. An edited source over it keeps its published version, like
        # any refused refresh.
        log.info("%s job %s refused its input: %s", job_type, job["id"], exc)
        if payload.get("sourceRefresh") is not True:
            index_limit = exc.code
    elif isinstance(exc, db.SourceRebaseRefusedError):
        # A documented engine refusal: the file stays due and the next
        # publication captures the edits.
        log.warning("%s job %s rebase refused: %s", job_type, job["id"], exc)
    else:
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
            index_limit,
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
    # After the terminal transition, so this job no longer protects its bundle.
    await asyncio.to_thread(_cleanup_payload_source, payload)


def main(job_type: str = "ingest") -> None:
    require_parse_timeouts()
    # Decoders run as children with this uid (ingest/decode.py): none may read
    # this process's memory or environment. A deployed host without Landlock
    # ABI 6 refuses here.
    capy_sandbox.make_undumpable()
    if not capy_sandbox.landlock_available():
        log.warning("Landlock unavailable: decoders run without it")
    use_compatible_event_loop()
    asyncio.run(main_async(job_type))


if __name__ == "__main__":
    main()
