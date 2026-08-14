"""Ingestion worker.

Claims jobs from the Postgres queue and turns uploads into retrievable chunks:

- ``txt`` / ``md`` / ``json`` are read straight from B2 and chunked as markdown.
- ``parseMode=fast`` parses on Modal with MinerU's pipeline OCR backend.
- ``parseMode=accurate`` parses on Modal with MinerU's hybrid VLM backend:
  better on dense layouts, more GPU seconds per page.
- ``parseMode=none`` jobs are normally never enqueued (the gateway marks the
  file ready directly); a stray one is finished without indexing.

Both parse routes return the same bundle — a ``content_list.json`` carrying a
page index and bounding box per block, plus the extracted images — so both
produce citations a reader can jump to and figures that can be captioned. They
differ in cost and fidelity, not in output shape.

The second job type is ``summaries_rollup``: a debounced rebuild of the chapter
and workspace summaries, enqueued by a database trigger whenever files move
between chapters and by ingest whenever content changes.

Live progress is published to Redis; the Go gateway fans it to the browser over
SSE.

Run: ``python -m pipeline.ingest.worker``
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import threading
from pathlib import Path

from .. import obs, progress, registry, use_compatible_event_loop
from ..config import cfg
from ..parse import figures, modal_parser
from ..retrieval import indexing, store
from ..retrieval.chunking import Chunk, chunk_content_list, chunk_markdown
from ..store import blobstore, db

log = logging.getLogger("evo.worker")

# Ingested as plain text (no parse service) for these file kinds.
_TEXT_KINDS = {"txt", "md", "json"}

_PARSE_ROUTES = {
    "accurate": modal_parser.ROUTE_ACCURATE,
    "fast": modal_parser.ROUTE_FAST,
}


# ----------------------------------------------------------- sync DB helpers
# (run via asyncio.to_thread so the event loop is never blocked)


def _claim_one() -> dict | None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            job = db.claim_job(cur)
        conn.commit()
        return job


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
) -> None:
    notification = None
    with db.connect() as conn:
        with conn.cursor() as cur:
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
            notification = db.add_notification(
                cur,
                file_id,
                "system",
                {"code": notification_code, "fileName": name},
            )
            db.set_job(cur, job_id, "done")
        conn.commit()
    if notification is not None:
        user_id = str(notification.pop("userId"))
        progress.publish_notification(user_id, notification)


def _finish_fail(file_id: str | None, job_id: str, error: str) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if file_id:
                db.set_file_status(cur, file_id, "failed")
                db.set_file_indexed(cur, file_id, False)
            db.set_job(cur, job_id, "failed", error[:500])
        conn.commit()


def _finish_job_ok(job_id: str) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            db.set_job(cur, job_id, "done")
        conn.commit()


def _read_name(file_id: str) -> str:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_name(cur, file_id)


def _account_allows_ingest(file_id: str, payload: dict) -> bool:
    """Claim-time gate: owner lifecycle/storage, actor credits. Separate lookups.

    Actor lifecycle is not checked. Refusing a deletion_pending uploader would
    leave the owner holding an unindexed file whose bytes they already paid for.
    """
    with db.connect() as conn, conn.cursor() as cur:
        owner = db.file_owner_user_id(cur, file_id)
        if not owner or not db.account_allows_ingest(cur, owner):
            return False
        actor = payload.get("actorUserId") or ""
        return (not actor) or db.actor_has_credits(cur, actor)


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


def _charge_ingest(file_id: str, workspace_id: str, actor_user_id: str) -> None:
    """Settle everything one ingest job spent, billed to the actor.

    Ingest is no longer an owner-billed exception. The payload records who
    initiated the upload at enqueue time; that is who pays. GPU time is still
    a flat rate because it is not a model_configs row.
    """
    usage = obs.current_usage()
    gpu_millis = obs.take_gpu_millis()
    if usage is None and not gpu_millis:
        return
    actor = actor_user_id
    if not actor:
        return
    try:
        ingest = registry.ingest_spec()
        embed = registry.embedding_spec()
        vision = registry.vision_spec()
        with db.connect() as conn, conn.cursor() as cur:
            trace = obs.trace_id()
            if usage is not None:
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
                            cost_micro_usd=registry.cost_micro_usd(spec, inp, out),
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
                        cost_micro_usd=registry.cost_micro_usd(
                            ingest, usage.input_tokens, usage.output_tokens
                        ),
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
                        cost_micro_usd=registry.cost_micro_usd(embed, embed_tokens, 0),
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
                    trace_id=trace,
                    metadata={"fileId": file_id},
                )
            conn.commit()
    except Exception as exc:  # noqa: BLE001 - metering must not fail a successful ingest
        # The file is already indexed. A missed charge is found by reconciliation.
        obs.capture_error(exc, stage="ingest_charge")


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
) -> tuple[list[Chunk], str | None, str | None, str | None]:
    """Parse one source into chunks, plus its parse-artifact identity if any."""
    blob_path = payload.get("blobPath")

    if kind in _TEXT_KINDS:
        local_path, cleanup = await asyncio.to_thread(blobstore.fetch_local, blob_path)
        try:
            text = await asyncio.to_thread(_read_text, local_path)
        finally:
            await asyncio.to_thread(cleanup)
        progress.publish(ws, file_id, "indexing", 40)
        return chunk_markdown(text), None, None, None

    route = _PARSE_ROUTES.get(parse_mode, modal_parser.ROUTE_ACCURATE)
    info = await asyncio.to_thread(blobstore.object_info, blob_path)
    if info is None:
        raise RuntimeError("source blob is missing")
    descriptor = modal_parser.source_descriptor(
        blob_path=blob_path,
        file_id=file_id,
        source_etag=str(payload.get("sourceETag") or info["etag"]),
        source_size=int(info["size"]),
        route=route,
    )
    progress.publish(ws, file_id, "parsing", 15)
    raw_dir = Path(tempfile.mkdtemp(prefix="evo_parse_"))
    try:
        content_list, artifact_key, fingerprint = await asyncio.to_thread(
            modal_parser.parse_to_bundle, descriptor, name, raw_dir
        )
        source_etag = str(payload.get("sourceETag") or info["etag"])
        if artifact_key:
            # Record before captioning: a later vision failure must not leave
            # the zip untracked for the blob reaper.
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
                blob_path=str(blob_path or ""),
                source_etag=source_etag,
            )
            log.info("captioned figures for %s: %s", name, counts)
            if counts.get("key"):
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


async def process_ingest_job(job: dict) -> None:
    payload = job["payload"] or {}
    file_id = payload["fileId"]
    ws = payload["workspaceId"]
    kind = (payload.get("kind") or "").lower()
    # 'fast' (Modal pipeline OCR, default), 'accurate' (Modal hybrid VLM), or
    # 'none' (blob-only; normally never enqueued at all).
    parse_mode = (payload.get("parseMode") or "fast").lower()
    # Chosen per file at upload time; the env default only covers a job that
    # predates the option or an import path that cannot express one.
    caption_images = payload.get("captionImages")
    if caption_images is None:
        caption_images = cfg.caption_images

    registry.set_job_pins(registry.pins_from_payload(payload))
    try:
        await _process_ingest_job(
            job, payload, file_id, ws, kind, parse_mode, caption_images
        )
    finally:
        registry.set_job_pins(None)


async def _process_ingest_job(
    job: dict,
    payload: dict,
    file_id: str,
    ws: str,
    kind: str,
    parse_mode: str,
    caption_images: object,
) -> None:
    name = await asyncio.to_thread(_read_name, file_id)
    if not await asyncio.to_thread(_account_allows_ingest, file_id, payload):
        note = f"{name}: ingest refused because the account is locked or over quota."
        await asyncio.to_thread(_finish_fail, file_id, job["id"], note)
        progress.publish(
            ws, file_id, "failed", 100, status="failed", message=note, indexed=False
        )
        return
    progress.publish(ws, file_id, "queued", 5)

    if parse_mode == "none" and kind not in _TEXT_KINDS:
        # Safety net: the gateway skips job creation for parseMode=none, but a
        # stray job must not fall through to a parser that cannot handle it.
        note = f"{name}: stored without parsing (not indexed for retrieval)."
        await asyncio.to_thread(
            _finish_ok,
            file_id,
            name,
            job["id"],
            notification_code="source_stored",
            indexed=False,
        )
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=False
        )
        return

    chunks, artifact_key, fingerprint, artifact_version = await _chunks_for(
        payload=payload,
        name=name,
        kind=kind,
        parse_mode=parse_mode,
        caption_images=bool(caption_images),
        ws=ws,
        file_id=file_id,
    )
    if not chunks:
        raise RuntimeError("parse produced no indexable content")

    digest = indexing.content_hash(chunks)
    association = await store.attach_file_content(
        workspace_id=ws, file_id=file_id, content_hash=digest
    )
    while not association["created"] and not association["ready"]:
        # Another worker owns this content. Wait for its atomic ready marker;
        # if it fails, its cleanup removes the row and this upload can claim it.
        await asyncio.sleep(cfg.poll_interval)
        status = await store.content_status(association["content_id"])
        if status == "ready":
            association["ready"] = True
        elif status is None:
            association = await store.attach_file_content(
                workspace_id=ws, file_id=file_id, content_hash=digest
            )

    if association["ready"]:
        note = f"{name}: identical content already indexed; reusing its index."
        await store.mark_workspace_dirty(ws, file_id)
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
        )
        progress.publish(
            ws, file_id, "done", 100, status="ready", message=note, indexed=True
        )
        await asyncio.to_thread(
            _charge_ingest, file_id, ws, payload.get("actorUserId") or ""
        )
        return

    try:
        result = await indexing.index_file(
            workspace_id=ws,
            content_id=association["content_id"],
            file_id=file_id,
            file_name=name,
            chunks=chunks,
            on_progress=lambda pct: progress.publish(ws, file_id, "indexing", pct),
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
    )
    await asyncio.to_thread(
        _charge_ingest, file_id, ws, payload.get("actorUserId") or ""
    )
    progress.publish(ws, file_id, "done", 100, status="ready", indexed=True)
    log.info("indexed %s: %s", name, result)


async def process_rollup_job(job: dict) -> None:
    ws = (job["payload"] or {})["workspaceId"]
    result = await indexing.rollup_summaries(ws)
    await asyncio.to_thread(_finish_job_ok, job["id"])
    await asyncio.to_thread(_charge_rollup, ws)
    log.info("workspace %s summary rollup: %s", ws, result)


def _charge_rollup(workspace_id: str) -> None:
    """Bill summaries_rollup to the workspace owner. There is no actor: the
    job is enqueued from a trigger with no user context, and pending jobs
    fold together per workspace."""
    usage = obs.current_usage()
    if usage is None or usage.is_empty():
        return
    try:
        ingest = registry.ingest_spec()
        with db.connect() as conn, conn.cursor() as cur:
            owner = db.workspace_owner_user_id(cur, workspace_id)
            if not owner:
                return
            db.record_usage_event(
                cur,
                actor_user_id=owner,
                workspace_id=workspace_id,
                kind="llm",
                surface="ingest",
                provider=ingest.provider_slug,
                model=usage.model or ingest.provider_model_id,
                model_key=ingest.model_key,
                model_version=ingest.version,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                unit="tokens",
                credit_micros=registry.credits_for_tokens(
                    ingest, "llm", usage.input_tokens, usage.output_tokens
                ),
                cost_micro_usd=registry.cost_micro_usd(
                    ingest, usage.input_tokens, usage.output_tokens
                ),
                trace_id=obs.trace_id(),
                metadata={"kind": "summaries_rollup"},
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        obs.capture_error(exc, stage="rollup_charge")


async def main_async() -> None:
    obs.init_logging("worker")
    obs.init_sentry("worker")
    registry.registry.start()
    threading.Thread(
        target=registry.poll_forever, name="model-registry", daemon=True
    ).start()
    log.info(
        "worker up — ingest_model=%s embedding=%s accurate=%s fast=%s",
        cfg.ingest_model,
        cfg.embedding_model,
        cfg.modal_parse_url or "(unset)",
        cfg.modal_fast_parse_url or "(unset)",
    )

    try:
        while True:
            try:
                job = await asyncio.to_thread(_claim_one)
            except Exception:
                log.exception("claim error")
                await asyncio.sleep(cfg.poll_interval)
                continue

            if not job:
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
            payload = job.get("payload") or {}
            try:
                if job.get("type") == "summaries_rollup":
                    await process_rollup_job(job)
                else:
                    await process_ingest_job(job)
                log.info("job %s done", job["id"])
            except Exception as exc:
                log.exception("%s job %s failed", job.get("type"), job["id"])
                fid = payload.get("fileId")
                ws = payload.get("workspaceId")
                try:
                    await asyncio.to_thread(_finish_fail, fid, job["id"], str(exc))
                except Exception:
                    log.exception("failed to record job failure")
                if ws and fid:
                    progress.publish(
                        ws,
                        fid,
                        "failed",
                        100,
                        status="failed",
                        message=str(exc)[:200],
                        indexed=False,
                    )
    finally:
        await store.close_pool()


def main() -> None:
    use_compatible_event_loop()
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
