"""Ingestion worker.

Claims jobs from the Postgres queue and turns uploads into retrievable chunks:

- ``txt`` / ``md`` are read straight from B2 and chunked as markdown.
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
from pathlib import Path

from .. import progress, use_compatible_event_loop
from ..config import cfg
from ..parse import figures, modal_parser
from ..retrieval import indexing, store
from ..retrieval.chunking import Chunk, chunk_content_list, chunk_markdown
from ..store import blobstore, db

log = logging.getLogger("evo.worker")

# Ingested as plain text (no parse service) for these file kinds.
_TEXT_KINDS = {"txt", "md"}

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
) -> None:
    notification = None
    with db.connect() as conn:
        with conn.cursor() as cur:
            db.set_file_status(cur, file_id, "ready")
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


def _account_allows_ingest(file_id: str) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        owner = db.file_owner_user_id(cur, file_id)
        return bool(owner) and db.account_allows_ingest(cur, owner)


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


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
                fingerprint=fingerprint,
            )
            log.info("captioned figures for %s: %s", name, counts)
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

    name = await asyncio.to_thread(_read_name, file_id)
    if not await asyncio.to_thread(_account_allows_ingest, file_id):
        note = f"{name}: ingest refused because the account is locked or over quota."
        await asyncio.to_thread(_finish_fail, file_id, job["id"], note)
        progress.publish(ws, file_id, "failed", 100, status="failed", message=note)
        return
    progress.publish(ws, file_id, "queued", 5)

    if parse_mode == "none" and kind not in _TEXT_KINDS:
        # Safety net: the gateway skips job creation for parseMode=none, but a
        # stray job must not fall through to a parser that cannot handle it.
        note = f"{name}: stored without parsing (not indexed for retrieval)."
        await asyncio.to_thread(
            _finish_ok, file_id, name, job["id"], notification_code="source_stored"
        )
        progress.publish(ws, file_id, "done", 100, status="ready", message=note)
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
        progress.publish(ws, file_id, "done", 100, status="ready", message=note)
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
    progress.publish(ws, file_id, "done", 100, status="ready")
    log.info("indexed %s: %s", name, result)


async def process_rollup_job(job: dict) -> None:
    ws = (job["payload"] or {})["workspaceId"]
    result = await indexing.rollup_summaries(ws)
    await asyncio.to_thread(_finish_job_ok, job["id"])
    log.info("workspace %s summary rollup: %s", ws, result)


async def main_async() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
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

            log.info("claimed %s job %s", job.get("type"), job["id"])
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
                        ws, fid, "failed", 100, status="failed", message=str(exc)[:200]
                    )
    finally:
        await store.close_pool()


def main() -> None:
    use_compatible_event_loop()
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
