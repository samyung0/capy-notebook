"""Ingestion worker.

Claims ingest jobs from the Postgres queue and feeds each upload into the
per-workspace LightRAG ingestion pipeline (v1.5, post RAG-Anything merge):

- Plain text / markdown is inserted directly as RAW text (``ainsert``).
- ``parseMode=normal`` parses via the free MinerU lightweight cloud API
  (mineru_lite) and inserts the returned markdown as RAW text.
- Everything else (``parseMode=advanced``, the default) is staged under
  ``INPUT_DIR/<workspace>/`` and enqueued as ``pending_parse`` with the custom
  ``modal`` engine, which parses on Modal (GPU MineRU) and reuses LightRAG's
  MinerU IR builder + i/t/e multimodal analysis (Gemini vlm role).
- ``parseMode=none`` jobs are normally never enqueued (the gateway marks the
  file ready directly); a stray one is finished without indexing.

Live progress is published to Redis; the Go gateway fans it to the browser
over SSE. The resulting LightRAG doc id is persisted on ``files.doc_id``; it
resolves basename collisions / job retries and records which document backs
each file (for future deletion or scoped-retrieval support).

Run: ``python -m pipeline.ingest.worker``

The whole worker runs on ONE asyncio event loop so the cached LightRAG asyncpg
pools survive across jobs. Synchronous bits (psycopg queue ops, blob staging)
are pushed to threads via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path

from lightrag import LightRAG
from lightrag.base import DocStatus
from lightrag.utils import compute_mdhash_id
from lightrag.utils_pipeline import (
    doc_status_field,
    get_existing_doc_by_file_basename,
    input_dir_path,
    normalize_document_file_path,
)

from ..config import cfg
from ..rag import mineru_lite, modal_parser, progress
from ..rag.cache import RagCache
from ..rag.factory import build_ingest_rag
from ..store import blobstore, db

log = logging.getLogger("evo.worker")

# Ingest as plain RAW text (no GPU parse) for these file kinds.
_TEXT_KINDS = {"txt", "md"}

# doc_status stage -> coarse progress percentage for the SSE bar.
_STAGE_PCT = {
    str(DocStatus.PENDING.value): 20,
    str(DocStatus.PARSING.value): 35,
    str(DocStatus.ANALYZING.value): 60,
    str(DocStatus.PROCESSING.value): 80,
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
    doc_id: str | None,
    name: str,
    job_id: str,
    note: str = "",
    artifact_key: str | None = None,
    artifact_fingerprint: str | None = None,
    artifact_version: str | None = None,
) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            db.set_file_status(cur, file_id, "ready")
            db.set_file_doc_id(cur, file_id, doc_id)
            if artifact_key:
                db.set_file_parse_artifact(
                    cur,
                    file_id,
                    artifact_key,
                    artifact_fingerprint or "",
                    artifact_version or "",
                )
            body = note or f"Finished processing {name}."
            db.add_notification(cur, "system", "Source ready", body)
            db.set_job(cur, job_id, "done")
        conn.commit()


def _finish_fail(file_id: str | None, job_id: str, error: str) -> None:
    with db.connect() as conn:
        with conn.cursor() as cur:
            if file_id:
                db.set_file_status(cur, file_id, "failed")
            db.set_job(cur, job_id, "failed", error[:500])
        conn.commit()


def _read_name(file_id: str) -> str:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_name(cur, file_id)


def _doc_owners(doc_id: str) -> list[str]:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_ids_for_doc_id(cur, doc_id)


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


# ----------------------------------------------------- naming / doc identity


def _suffixed(name: str, n: int) -> str:
    p = Path(name)
    return f"{p.stem} ({n}){p.suffix}"


async def _resolve_canonical_name(rag: LightRAG, file_id: str, name: str) -> str:
    """Pick the basename this file will be known by inside LightRAG.

    LightRAG dedups documents by canonical basename, but our files table allows
    several uploads with the same display name. When another file already owns
    a doc with this basename, disambiguate with `` (2)`` / `` (3)`` … suffixes
    (visible in citations, so keep it human-readable). A basename owned by this
    very file (job retry) is reused so processing resumes instead of forking.
    """
    candidate = normalize_document_file_path(name)
    if candidate == "unknown_source":
        candidate = f"{file_id}.bin"
    n = 2
    while True:
        match = await get_existing_doc_by_file_basename(rag.doc_status, candidate)
        if match is None:
            return candidate
        existing_doc_id = match[0]
        owners = await asyncio.to_thread(_doc_owners, existing_doc_id)
        if not owners or owners == [file_id]:
            # Unclaimed (retry / pre-migration doc) — claim it and resume.
            return candidate
        candidate = _suffixed(normalize_document_file_path(name), n)
        n += 1


# ----------------------------------------------------------------- pipeline


async def _publish_doc_progress(
    rag: LightRAG, ws: str, file_id: str, doc_id: str
) -> None:
    """Poll doc_status while the pipeline runs and mirror it to the SSE bar."""
    last = ""
    try:
        while True:
            await asyncio.sleep(2.0)
            try:
                doc = await rag.doc_status.get_by_id(doc_id)
            except Exception:
                # Progress is best-effort; keep polling on transient failures.
                log.debug("doc_status poll failed for %s", doc_id, exc_info=True)
                continue
            if not doc:
                continue
            status = str(doc_status_field(doc, "status", ""))
            if status and status != last:
                last = status
                pct = _STAGE_PCT.get(status)
                if pct is not None:
                    stage = (
                        "parsing"
                        if status == str(DocStatus.PARSING.value)
                        else "indexing"
                    )
                    progress.publish(ws, file_id, stage, pct)
    except asyncio.CancelledError:
        pass


def _stage_remote_source(ws: str, canonical: str, descriptor: dict) -> Path:
    """Stage a tiny B2 descriptor where LightRAG expects a source file."""
    dest_dir = input_dir_path() / ws
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / canonical
    dest.write_text(json.dumps(descriptor), encoding="utf-8")
    return dest


def _stage_local_source(ws: str, local_path: str, canonical: str) -> Path:
    dest_dir = input_dir_path() / ws
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / canonical
    shutil.copyfile(local_path, dest)
    return dest


def _cleanup_staged(ws: str, canonical: str) -> None:
    """Remove the staged source + parse artifacts for one document."""
    base = input_dir_path() / ws
    parsed = base / "__parsed__"
    targets = [
        base / canonical,
        parsed / canonical,  # archived source
        parsed / f"{canonical}.parsed",
        parsed / f"{canonical}.modal_raw",
    ]
    for t in targets:
        try:
            if t.is_dir():
                shutil.rmtree(t, ignore_errors=True)
            elif t.exists():
                t.unlink()
        except OSError:
            log.debug("cleanup of %s failed", t, exc_info=True)


async def process_job(cache: RagCache, job: dict) -> None:
    payload = job["payload"] or {}
    file_id = payload["fileId"]
    ws = payload["workspaceId"]
    blob_path = payload.get("blobPath")
    kind = (payload.get("kind") or "").lower()
    # 'advanced' (Modal GPU MinerU, default), 'normal' (MinerU lightweight
    # cloud API), or 'none' (blob-only; normally never enqueued at all).
    parse_mode = (payload.get("parseMode") or "advanced").lower()

    name = await asyncio.to_thread(_read_name, file_id)
    progress.publish(ws, file_id, "queued", 5)

    if parse_mode == "none" and kind not in _TEXT_KINDS:
        # Safety net: the gateway skips job creation for parseMode=none, but a
        # stray job must not fall through to a parser that can't handle it.
        note = f"{name}: stored without parsing (not indexed for retrieval)."
        await asyncio.to_thread(_finish_ok, file_id, None, name, job["id"], note)
        progress.publish(ws, file_id, "done", 100, status="ready", message=note)
        return

    rag = await cache.get(ws)
    canonical = await _resolve_canonical_name(rag, file_id, name)
    doc_id = compute_mdhash_id(canonical, prefix="doc-")
    staged = False
    blob_cleanup = lambda: None
    artifact_key: str | None = None
    artifact_fingerprint: str | None = None
    try:
        track_id: str
        if kind in _TEXT_KINDS:
            local_path, blob_cleanup = await asyncio.to_thread(
                blobstore.fetch_local, blob_path
            )
            text = await asyncio.to_thread(_read_text, local_path)
            progress.publish(ws, file_id, "indexing", 40)
            track_id = await rag.ainsert(input=text, ids=doc_id, file_paths=canonical)
        elif parse_mode == "normal":
            # The Cloudflare relay streams B2 -> MinerU's signed OSS upload URL;
            # no source bytes traverse this worker.
            progress.publish(ws, file_id, "parsing", 15)
            md_text = await asyncio.to_thread(
                mineru_lite.parse_blob,
                blob_path,
                name,
                lambda pct: progress.publish(ws, file_id, "parsing", pct),
            )
            progress.publish(ws, file_id, "indexing", 60)
            track_id = await rag.ainsert(
                input=md_text, ids=doc_id, file_paths=canonical
            )
        else:
            if cfg.modal_b2_artifacts:
                info = await asyncio.to_thread(blobstore.object_info, blob_path)
                if info is None:
                    raise RuntimeError("source blob is missing")
                descriptor = modal_parser.source_descriptor(
                    blob_path=blob_path,
                    file_id=file_id,
                    source_etag=str(payload.get("sourceETag") or info["etag"]),
                    source_size=int(info["size"]),
                )
                artifact_key, artifact_fingerprint = modal_parser.artifact_identity(
                    descriptor
                )
                await asyncio.to_thread(_stage_remote_source, ws, canonical, descriptor)
            else:
                local_path, blob_cleanup = await asyncio.to_thread(
                    blobstore.fetch_local, blob_path
                )
                await asyncio.to_thread(_stage_local_source, ws, local_path, canonical)
            staged = True
            progress.publish(ws, file_id, "parsing", 15)
            track_id = await rag.apipeline_enqueue_documents(
                input="",
                file_paths=canonical,
                docs_format="pending_parse",
                parse_engine="modal",
                # i/t/e: analyze images, tables and equations with the vlm role.
                process_options="ite",
            )
            poller = asyncio.create_task(
                _publish_doc_progress(rag, ws, file_id, doc_id)
            )
            try:
                await rag.apipeline_process_enqueue_documents()
            finally:
                poller.cancel()

        # The pipeline reports per-document failures via doc_status, not
        # exceptions — read the outcome explicitly.
        doc = await rag.doc_status.get_by_id(doc_id)
        status = str(doc_status_field(doc, "status", "")) if doc else ""
        error = str(doc_status_field(doc, "error_msg", "") or "") if doc else ""
        if status == str(DocStatus.PROCESSED.value):
            await asyncio.to_thread(
                _finish_ok,
                file_id,
                doc_id,
                name,
                job["id"],
                "",
                artifact_key,
                artifact_fingerprint,
                modal_parser.PARSER_VERSION if artifact_key else None,
            )
            progress.publish(ws, file_id, "done", 100, status="ready")
            return

        # Duplicate detection. Two shapes:
        # - post-parse content duplicate: OUR doc_id is FAILED with
        #   metadata.is_duplicate=True;
        # - enqueue-time duplicate: our doc never materializes and a `dup-*`
        #   stub carrying this run's track_id records the skip.
        meta = doc_status_field(doc, "metadata", {}) or {}
        is_duplicate = bool(isinstance(meta, dict) and meta.get("is_duplicate"))
        if not is_duplicate and not doc:
            track_docs = await rag.aget_docs_by_track_id(track_id)
            is_duplicate = any(
                (doc_status_field(d, "metadata", {}) or {}).get("is_duplicate")
                for d in track_docs.values()
            )
        if is_duplicate:
            # The content is queryable via the original document; this file
            # just doesn't own a LightRAG doc of its own.
            note = f"{name}: content already ingested; skipped re-indexing."
            await asyncio.to_thread(
                _finish_ok,
                file_id,
                None,
                name,
                job["id"],
                note,
                artifact_key,
                artifact_fingerprint,
                modal_parser.PARSER_VERSION if artifact_key else None,
            )
            progress.publish(ws, file_id, "done", 100, status="ready", message=note)
            return

        raise RuntimeError(
            f"ingest did not complete (doc status: {status or 'missing'})"
            + (f": {error}" if error else "")
        )
    finally:
        if staged:
            await asyncio.to_thread(_cleanup_staged, ws, canonical)
        await asyncio.to_thread(blob_cleanup)


async def main_async() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    cache = RagCache(build_ingest_rag, maxsize=cfg.lightrag_cache_size)
    log.info(
        "worker up — ingest_model=%s embedding=%s modal=%s input_dir=%s",
        cfg.ingest_model,
        cfg.embedding_model,
        cfg.modal_parse_url or "(unset)",
        os.getenv("INPUT_DIR", "(unset)"),
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

            log.info("claimed ingest job %s", job["id"])
            payload = job.get("payload") or {}
            try:
                await process_job(cache, job)
                log.info("job %s done", job["id"])
            except Exception as exc:
                log.exception("ingest job %s failed", job["id"])
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
        await cache.close()


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
