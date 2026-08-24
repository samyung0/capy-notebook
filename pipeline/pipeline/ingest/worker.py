"""Ingestion worker.

Claims jobs from the Postgres queue and turns uploads into retrievable chunks:

- ``txt`` / ``md`` / ``json`` are read straight from B2 and chunked as markdown.
  The gateway still labels those jobs ``parseMode=none`` (there is no GPU parse
  route to pick); they are indexed. ``parseMode=none`` on any other kind is
  store-only: the blob is kept, ``indexed=false``.
- ``parseMode=fast`` parses on Modal with Marker plus PP-OCRv6 on scanned /
  thin-text pages. Unknown modes fail the job.

The parse returns a bundle — a ``content_list.json`` carrying a page index and
bounding box per block, plus the extracted images — so citations a reader can
jump to and figures that can be captioned come from the same shape.

Live progress is published to Redis; the Go gateway fans it to the browser over
SSE. A file is ``pending`` until this worker is actually parsing (and holding a
GPU slot); extra jobs wait there instead of opening more Modal boxes.

Run: ``python -m pipeline.ingest.worker``
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import threading
import time
from pathlib import Path

from .. import obs, progress, registry, use_compatible_event_loop
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
from ..parse import figures, modal_parser, slots
from ..retrieval import indexing, store
from ..retrieval.chunking import (
    CHUNKER_VERSION,
    Chunk,
    chunk_content_list,
    chunk_markdown,
)
from ..store import blobstore, db

log = logging.getLogger("evo.worker")

# Ingested as plain text (no parse service) for these file kinds.
_TEXT_KINDS = {"txt", "md", "json"}

_PARSE_ROUTES = {
    "fast": modal_parser.ROUTE_FAST,
}

_REQUIRED_INGEST_STRINGS = (
    "fileId",
    "workspaceId",
    "blobPath",
    "kind",
    "parseMode",
    "actorUserId",
    "ingestModelKey",
    "visionModelKey",
)
_REQUIRED_INGEST_INTS = ("ingestModelVersion", "visionModelVersion")
_REQUIRED_INGEST_BOOLS = ("captionImages",)


def _parse_route(parse_mode: str) -> str:
    route = _PARSE_ROUTES.get(parse_mode)
    if route is None:
        raise TerminalError(f"unknown parse mode {parse_mode!r}")
    return route


# ----------------------------------------------------------- sync DB helpers
# (run via asyncio.to_thread so the event loop is never blocked)


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
        payload = row["payload"] or {}
        # The reclaim is already committed and `job` is already claimed, so a
        # failure here must not propagate: it would discard a job that is
        # marked running and leave it to expire, burning an attempt on work
        # nothing ever started.
        try:
            if row["outcome"] == "failed" and payload.get("fileId"):
                _notify_ingest_terminal(
                    payload.get("fileId"),
                    payload.get("workspaceId"),
                    row["id"],
                    "ingest timed out after the worker died",
                    payload=payload,
                )
        except Exception:
            log.exception("could not announce reclaimed job %s", row["id"])
    return job


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
) -> None:
    notification = None
    with db.connect() as conn:
        with conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
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
    try:
        with db.connect() as conn:
            with conn.cursor() as cur:
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


def _finish_fail(
    file_id: str | None,
    job_id: str,
    error: str,
    attempt: int | None = None,
    reservation_id: str = "",
) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
            if file_id:
                db.set_file_status(cur, file_id, "failed")
                db.set_file_indexed(cur, file_id, False)
            db.set_job(cur, job_id, "failed", error[:500])
            db.release_credit_reservation(cur, reservation_id)
        conn.commit()


def _finish_job_ok(job_id: str, attempt: int | None = None) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if _lost_claim(cur, job_id, attempt):
                return
            db.set_job(cur, job_id, "done")
        conn.commit()


def _requeue(job: dict, error: str) -> str:
    job_type = (job.get("type") or "").strip()
    policy = policy_for(job_type)
    payload = job.get("payload") or {}
    attempt = int(job.get("attempts") or 1)
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt):
            return "stale"
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
            db.release_credit_reservation(cur, reservation_id)
            conn.commit()
        return
    name = _read_name(file_id)
    _finish_fail(file_id, job_id, error, attempt, reservation_id)
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
    actor, nothing to check", which let a job parse, caption and embed on GPU
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
    file_id: str, key: str, fingerprint: str, version: str
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.set_file_parse_artifact(cur, file_id, key, fingerprint, version)
        conn.commit()


def _record_caption_blob(file_id: str, key: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.set_file_caption_blob(cur, file_id, key)
        conn.commit()


def _record_source_sha(file_id: str, source_sha256: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.set_file_source_sha256(cur, file_id, source_sha256)
        conn.commit()


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


def _drop_parse_zip(object_path: str | None, file_id: str | None = None) -> None:
    if not object_path:
        return
    with db.connect() as conn, conn.cursor() as cur:
        db.drop_artifact_cache(cur, object_path)
        if file_id:
            db.clear_file_parse_artifact(cur, file_id)
        conn.commit()


def _set_file_status(file_id: str, status: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.set_file_status(cur, file_id, status)
        conn.commit()


def _yield_for_capacity(job: dict, file_id: str, workspace_id: str, name: str) -> None:
    """Give the GPU slot back to the queue. File stays pending; attempt is undone."""
    attempt = int(job.get("attempts") or 1)
    with db.connect() as conn, conn.cursor() as cur:
        if _lost_claim(cur, job["id"], attempt):
            return
        db.release_job_for_capacity(
            cur, job["id"], attempt, backoff_s=slots.YIELD_BACKOFF_S
        )
        db.set_file_status(cur, file_id, "pending")
        conn.commit()
    progress.publish(
        workspace_id,
        file_id,
        "queued",
        5,
        status="pending",
        message=f"{name}: waiting for a parser slot",
    )
    log.info("ingest %s waiting for a parser slot", name)


def _file_exists(file_id: str) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_exists(cur, file_id)


def _pipeline_identity(*, kind: str, parse_mode: str, caption_images: bool) -> str:
    if kind in _TEXT_KINDS:
        return f"{cfg.parse_method}:direct:none:none:{CHUNKER_VERSION}"
    route = _parse_route(parse_mode)
    cap = cfg.caption_version if caption_images else "none"
    return (
        f"{cfg.parse_method}:{route}:{modal_parser.parser_version(route)}"
        f":{cap}:{CHUNKER_VERSION}"
    )


def _charge_ingest(
    file_id: str,
    workspace_id: str,
    actor_user_id: str,
    reservation_id: str = "",
) -> None:
    """Settle everything one ingest job spent, billed to the actor.

    Ingest is no longer an owner-billed exception. The payload records who
    initiated the upload at enqueue time; that is who pays. GPU time is still
    a flat rate because it is not a model_configs row.
    """
    usage = obs.current_usage()
    gpu_millis = obs.take_gpu_millis()
    actor = actor_user_id
    try:
        with db.connect() as conn, conn.cursor() as cur:
            trace = obs.trace_id()
            if actor and (usage is not None or gpu_millis):
                ingest = registry.ingest_spec()
                embed = registry.embedding_spec()
                vision = registry.vision_spec()
            if actor and usage is not None:
                if usage.by_model:
                    for model_id, bucket in usage.by_model.items():
                        if model_id == embed.provider_model_id:
                            continue
                        spec = (
                            vision if model_id == vision.provider_model_id else ingest
                        )
                        inp = int(bucket.get("input") or 0)
                        out = int(bucket.get("output") or 0)
                        if not (inp or out):
                            continue
                        db.record_usage_event(
                            cur,
                            actor_user_id=actor,
                            workspace_id=workspace_id,
                            kind="llm",
                            surface="ingest",
                            provider=spec.provider_slug,
                            model=model_id,
                            model_key=spec.model_key,
                            model_version=spec.version,
                            input_tokens=inp,
                            output_tokens=out,
                            unit="tokens",
                            credit_micros=registry.credits_for_tokens(
                                spec, "llm", inp, out
                            ),
                            reservation_id=reservation_id,
                            trace_id=trace,
                            metadata={
                                "fileId": file_id,
                                "calls": bucket.get("calls", 0),
                            },
                        )
                elif usage.input_tokens or usage.output_tokens:
                    db.record_usage_event(
                        cur,
                        actor_user_id=actor,
                        workspace_id=workspace_id,
                        kind="llm",
                        surface="ingest",
                        provider=ingest.provider_slug,
                        model=usage.model,
                        model_key=ingest.model_key,
                        model_version=ingest.version,
                        input_tokens=usage.input_tokens,
                        output_tokens=usage.output_tokens,
                        unit="tokens",
                        credit_micros=registry.credits_for_tokens(
                            ingest, "llm", usage.input_tokens, usage.output_tokens
                        ),
                        reservation_id=reservation_id,
                        trace_id=trace,
                        metadata={"fileId": file_id, "calls": usage.calls},
                    )
                embed_tokens = usage.embed_tokens
                if embed_tokens:
                    db.record_usage_event(
                        cur,
                        actor_user_id=actor,
                        workspace_id=workspace_id,
                        kind="embedding",
                        surface="ingest",
                        provider=embed.provider_slug,
                        model=embed.provider_model_id,
                        model_key=embed.model_key,
                        model_version=embed.version,
                        input_tokens=embed_tokens,
                        unit="tokens",
                        credit_micros=registry.credits_for_tokens(
                            embed, "embedding", embed_tokens, 0
                        ),
                        reservation_id=reservation_id,
                        trace_id=trace,
                        metadata={"fileId": file_id},
                    )
            if gpu_millis:
                db.record_usage_event(
                    cur,
                    actor_user_id=actor,
                    workspace_id=workspace_id,
                    kind="parse_gpu",
                    surface="ingest",
                    provider="modal",
                    units=gpu_millis,
                    unit="ms",
                    credit_micros=db.credits_for_gpu(gpu_millis),
                    reservation_id=reservation_id,
                    trace_id=trace,
                    metadata={"fileId": file_id},
                )
            db.settle_credit_reservation(cur, reservation_id)
            conn.commit()
    except Exception as exc:  # noqa: BLE001 - metering must not fail a successful ingest
        # The file is already indexed. A missed charge is found by reconciliation.
        obs.capture_error(exc, stage="ingest_charge")
        try:
            with db.connect() as conn, conn.cursor() as cur:
                db.settle_credit_reservation(cur, reservation_id)
                conn.commit()
        except Exception as close_exc:  # noqa: BLE001
            obs.capture_error(close_exc, stage="ingest_lease_settle")


# ------------------------------------------------------------------ parsing


async def _chunks_for(
    *,
    payload: dict,
    name: str,
    kind: str,
    parse_mode: str,
    caption_images: bool,
    ws: str,
    file_id: str,
    source_sha256: str,
    job_id: str | None = None,
) -> tuple[list[Chunk], str | None, str | None, str | None]:
    """Parse one source into chunks, plus its parse-artifact identity if any."""
    blob_path = payload.get("blobPath")

    if kind in _TEXT_KINDS:
        if job_id:
            await asyncio.to_thread(_set_file_status, file_id, "processing")
        local_path, cleanup = await asyncio.to_thread(blobstore.fetch_local, blob_path)
        try:
            text = await asyncio.to_thread(_read_text, local_path)
        finally:
            await asyncio.to_thread(cleanup)
        progress.publish(ws, file_id, "indexing", 40, status="processing")
        return chunk_markdown(text), None, None, None

    route = _parse_route(parse_mode)
    info = await asyncio.to_thread(blobstore.object_info, blob_path)
    if info is None:
        raise TerminalError("source blob is missing")
    descriptor = modal_parser.source_descriptor(
        blob_path=blob_path,
        source_sha256=source_sha256,
        route=route,
    )
    held_slot = False
    if job_id:
        held_slot = await asyncio.to_thread(slots.try_acquire, route, job_id)
        if not held_slot:
            raise CapacityWait(route)
        await asyncio.to_thread(_set_file_status, file_id, "processing")
    progress.publish(ws, file_id, "parsing", 15, status="processing")
    raw_dir = Path(tempfile.mkdtemp(prefix="evo_parse_"))
    try:
        try:
            content_list, artifact_key, fingerprint = await asyncio.to_thread(
                modal_parser.parse_to_bundle, descriptor, name, raw_dir
            )
        finally:
            # Free the GPU slot before captioning / indexing; those do not
            # occupy a Modal container.
            if held_slot and job_id:
                await asyncio.to_thread(slots.release, route, job_id)
        if artifact_key:
            # Record before captioning: a later vision failure must not leave
            # the zip untracked for the blob reaper.
            await asyncio.to_thread(
                _touch_or_upsert_artifact,
                object_path=artifact_key,
                kind="parse_zip",
                source_sha256=source_sha256,
                size_bytes=int(info.get("size") or 0),
            )
            await asyncio.to_thread(
                _record_parse_artifact,
                file_id,
                artifact_key,
                fingerprint,
                modal_parser.parser_version(route),
            )
        progress.publish(
            ws, file_id, "captioning" if caption_images else "indexing", 45
        )
        if caption_images:
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
                    _record_caption_blob, file_id, str(counts["key"])
                )
        progress.publish(ws, file_id, "indexing", 55)
        return (
            chunk_content_list(content_list),
            artifact_key,
            fingerprint,
            modal_parser.parser_version(route),
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
    for key in _REQUIRED_INGEST_BOOLS:
        if key not in payload:
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
    parse_mode = str(payload["parseMode"]).lower()
    caption_images = bool(payload["captionImages"])

    try:
        pins = registry.pins_from_payload(
            payload, embedding=await _workspace_embedding_spec(ws)
        )
    except (registry.RegistryError, TerminalError) as exc:
        raise TerminalError(
            f"ingest refused because its model pins could not be resolved: {exc}"
        ) from exc

    registry.set_job_pins(pins)
    try:
        await _process_ingest_job(
            job, payload, file_id, ws, kind, parse_mode, caption_images
        )
    except CapacityWait:
        name = await asyncio.to_thread(_read_name, file_id)
        await asyncio.to_thread(_yield_for_capacity, job, file_id, ws, name)
        raise
    finally:
        registry.set_job_pins(None)


async def _workspace_embedding_spec(workspace_id: str) -> registry.ModelConfig:
    """The embedding model this workspace was created with.

    Read from the workspace rather than taken from the payload or the registry
    default: the workspace's existing chunks are in this space, and there is no
    reindex job that could move them into another one.
    """
    pin = await store.workspace_embedding_pin(workspace_id)
    return registry.resolve_pinned(
        pin["embedding_model_key"],
        pin["embedding_model_version"],
        registry.SURFACE_EMBEDDING,
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
        )
    return association


async def _reuse_donor(
    *,
    job: dict,
    payload: dict,
    file_id: str,
    ws: str,
    name: str,
    donor: dict,
    identity: str,
    source_sha256: str,
) -> bool:
    """Copy a ready donor into this workspace. Returns False on a vanished donor."""
    pin = await store.workspace_embedding_pin(ws)
    copy_vectors = (
        donor.get("embedding_model_key") == pin["embedding_model_key"]
        and donor.get("embedding_model_version") == pin["embedding_model_version"]
        and donor.get("embedding_dim") == pin["embedding_dim"]
    )
    attempt = int(job.get("attempts") or 1)
    association = await store.attach_file_content(
        workspace_id=ws,
        file_id=file_id,
        content_hash=donor["content_hash"],
        source_sha256=source_sha256,
        pipeline_identity=identity,
        claim_job_id=job["id"],
    )
    association = await _wait_for_content(
        association,
        workspace_id=ws,
        file_id=file_id,
        content_hash=donor["content_hash"],
        claim_job_id=job["id"],
        source_sha256=source_sha256,
        pipeline_identity=identity,
    )
    if association["ready"]:
        note = f"{name}: identical content already indexed; reusing its index."
        await asyncio.to_thread(
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
        )
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=True
        )
        await asyncio.to_thread(
            _charge_ingest,
            file_id,
            ws,
            payload.get("actorUserId") or "",
            _reservation_id(payload),
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
        )
        return False
    try:
        if copy_vectors:
            await store.mark_content_ready(
                association["content_id"], claim_job_id=job["id"]
            )
            result = {"chunks": "copied", "donor": donor["id"]}
        else:
            result = await indexing.embed_copied_chunks(
                workspace_id=ws,
                content_id=association["content_id"],
                claim_job_id=job["id"],
            )
    except BaseException:
        await store.abandon_content(association["content_id"])
        raise
    await asyncio.to_thread(
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
    )
    await asyncio.to_thread(
        _charge_ingest,
        file_id,
        ws,
        payload.get("actorUserId") or "",
        _reservation_id(payload),
    )
    progress.publish(ws, file_id, "done", 100, status="ready", indexed=True)
    log.info("indexed %s from donor: %s", name, result)
    return True


async def _process_ingest_job(
    job: dict,
    payload: dict,
    file_id: str,
    ws: str,
    kind: str,
    parse_mode: str,
    caption_images: object,
) -> None:
    attempt = int(job.get("attempts") or 1)
    if not await asyncio.to_thread(_file_exists, file_id):
        raise TerminalError("file no longer exists")
    name = await asyncio.to_thread(_read_name, file_id)
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        note = f"{name}: ingest refused because the account is locked or over quota."
        await asyncio.to_thread(
            _finish_fail,
            file_id,
            job["id"],
            note,
            attempt,
            _reservation_id(payload),
        )
        progress.publish(
            ws, file_id, "failed", 100, status="failed", message=note, indexed=False
        )
        return
    progress.publish(ws, file_id, "queued", 5, status="pending")

    if parse_mode == "none" and kind not in _TEXT_KINDS:
        note = f"{name}: stored without parsing (not indexed for retrieval)."
        await asyncio.to_thread(
            _finish_ok,
            file_id,
            name,
            job["id"],
            notification_code="source_stored",
            indexed=False,
            attempt=attempt,
        )
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=False
        )
        await asyncio.to_thread(
            _charge_ingest,
            file_id,
            ws,
            payload.get("actorUserId") or "",
            _reservation_id(payload),
        )
        return

    blob_path = payload.get("blobPath")
    if not blob_path:
        raise TerminalError("source blob is missing")
    try:
        source_sha256 = await asyncio.to_thread(blobstore.sha256_object, blob_path)
    except FileNotFoundError as exc:
        raise TerminalError("source blob is missing") from exc
    await asyncio.to_thread(_record_source_sha, file_id, source_sha256)
    identity = _pipeline_identity(
        kind=kind, parse_mode=parse_mode, caption_images=bool(caption_images)
    )
    pin = await store.workspace_embedding_pin(ws)
    donor = await store.find_ready_donor(
        source_sha256=source_sha256,
        pipeline_identity=identity,
        embedding_model_key=pin["embedding_model_key"],
        embedding_model_version=pin["embedding_model_version"],
        embedding_dim=pin["embedding_dim"],
    )
    if donor:
        reused = await _reuse_donor(
            job=job,
            payload=payload,
            file_id=file_id,
            ws=ws,
            name=name,
            donor=donor,
            identity=identity,
            source_sha256=source_sha256,
        )
        if reused:
            return

    chunks, artifact_key, fingerprint, artifact_version = await _chunks_for(
        payload=payload,
        name=name,
        kind=kind,
        parse_mode=parse_mode,
        caption_images=bool(caption_images),
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
    )
    association = await _wait_for_content(
        association,
        workspace_id=ws,
        file_id=file_id,
        content_hash=digest,
        claim_job_id=job["id"],
        source_sha256=source_sha256,
        pipeline_identity=identity,
    )

    if association["ready"]:
        note = f"{name}: identical content already indexed; reusing its index."
        await asyncio.to_thread(
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
        )
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=True
        )
        await asyncio.to_thread(
            _charge_ingest,
            file_id,
            ws,
            payload.get("actorUserId") or "",
            _reservation_id(payload),
        )
        await asyncio.to_thread(_drop_parse_zip, artifact_key, file_id)
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
    await asyncio.to_thread(
        _finish_ok,
        file_id,
        name,
        job["id"],
        digest,
        artifact_key,
        fingerprint,
        artifact_version,
        attempt=attempt,
    )
    await asyncio.to_thread(
        _charge_ingest,
        file_id,
        ws,
        payload.get("actorUserId") or "",
        _reservation_id(payload),
    )
    await asyncio.to_thread(_drop_parse_zip, artifact_key, file_id)
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
        cfg.modal_fast_parse_url or "(unset)",
    )

    last_sweep = 0.0
    sweep_every = 300.0
    try:
        while True:
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
                                parse_zip_ttl_hours=cfg.parse_zip_ttl_hours,
                            )
                            conn.commit()
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
            except CapacityWait:
                log.info("job %s waiting for a parser slot", job["id"])
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
    retry = policy is not None and is_retryable(exc) and attempts < policy.max_attempts
    if retry:
        log.warning("%s job %s failed; retrying: %s", job_type, job["id"], exc)
        outcome = await asyncio.to_thread(_requeue, job, str(exc))
        log.info("job %s requeued (%s)", job["id"], outcome)
        return
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
    except Exception:
        log.exception("failed to record job failure")


def main() -> None:
    use_compatible_event_loop()
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
