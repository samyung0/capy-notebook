"""Index one file: chunk, embed, summarize.

Called by the ingest worker once a document has been parsed. Everything below is
idempotent per file — re-running replaces that file's rows and nothing else — so
a retried job converges instead of duplicating.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
from typing import Any

from .. import elitellm, registry
from ..jobs import RetryableError
from ..prompts.ingest import (
    DESCRIPTOR_WORDS,
    SUMMARY_VERSION,
    partial_messages,
    summary_messages,
)
from ..registry import embedding_spec, ingest_spec
from . import accounting, compact, models, store
from .chunking import Chunk, _is_cjk, estimate_tokens, tokenize_for_search
from .lang import detect_lang
from .workflows import extract_json

log = logging.getLogger("capy.retrieval.indexing")


def _uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def content_hash(chunks: list[Chunk]) -> str:
    """Hash the parsed passage text and any citation geometry it carries.

    Geometry is part of canonical content identity. Otherwise two documents
    with the same words but different pagination or layout would share chunks,
    and citations for one upload could point at coordinates from the other.
    """
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk.indexed_text().encode("utf-8"))
        digest.update(b"\x01" if chunk.reference else b"\x00")
        digest.update(b"\x00")
        geometry = {
            "page_start": chunk.page_start,
            "page_end": chunk.page_end,
            "regions": [region.as_dict() for region in chunk.regions],
        }
        if chunk.page_start is not None or chunk.page_end is not None or chunk.regions:
            digest.update(
                json.dumps(
                    geometry,
                    ensure_ascii=False,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
        digest.update(b"\x00")
    return digest.hexdigest()


async def index_file(
    *,
    workspace_id: str,
    content_id: str,
    file_id: str,
    file_name: str,
    chunks: list[Chunk],
    on_progress=None,
    claim_job_id: str | None = None,
    allow_empty: bool = False,
) -> dict[str, Any]:
    """Write chunks and summary for canonical parsed content."""
    if not chunks:
        await store.replace_content_chunks(
            workspace_id=workspace_id,
            content_id=content_id,
            rows=[],
            claim_job_id=claim_job_id,
        )
        if allow_empty:
            await store.upsert_content_summary(
                workspace_id=workspace_id,
                content_id=content_id,
                fingerprint=content_hash([]),
                descriptor="",
                summary="",
                summary_version=SUMMARY_VERSION,
            )
            await store.mark_content_ready(content_id, claim_job_id=claim_job_id)
        return {"chunks": 0}

    fingerprint = content_hash(chunks)
    indexed = [chunk.indexed_text() for chunk in chunks]
    # The workspace's embedding pin, installed on the job by the worker. Not the
    # registry default: this workspace's existing chunks are in that space and
    # there is no reindex job to move them.
    spec = embedding_spec()
    reusable = await store.existing_file_vectors(
        workspace_id=workspace_id,
        file_id=file_id,
        spec=spec,
        inputs=indexed,
    )
    missing = list(dict.fromkeys(text for text in indexed if text not in reusable))
    if missing:
        reusable.update(zip(missing, await models.embed(missing, spec=spec)))
    vectors = [reusable[text] for text in indexed]
    if on_progress:
        on_progress(70)

    rows: list[dict[str, Any]] = []
    for idx, (chunk, text, vector) in enumerate(zip(chunks, indexed, vectors)):
        rows.append(
            {
                "id": _uid("chk"),
                "chunk_idx": idx,
                "section_path": chunk.section_path,
                "text": chunk.text,
                "indexed_text": text,
                # CJK is ~1 token per character; Latin is ~4 characters per
                # token. The naive chars/4 heuristic under-counts CJK by 3-4x.
                "token_count": max(1, estimate_tokens(text)),
                "page_start": chunk.page_start,
                "page_end": chunk.page_end,
                "regions": [region.as_dict() for region in chunk.regions],
                # Per chunk, not per file: a bilingual textbook switches
                # language between passages, and the stemmer must follow.
                "lang": detect_lang(chunk.text),
                # A reference list stays out of the lexical leg: see Chunk.reference.
                "search_text": "" if chunk.reference else tokenize_for_search(text),
                "embedding": store.vector_literal(vector),
            }
        )
    await store.replace_content_chunks(
        workspace_id=workspace_id,
        content_id=content_id,
        rows=rows,
        claim_job_id=claim_job_id,
    )
    if on_progress:
        on_progress(85)

    descriptor, summary = await summarize_file(file_name, chunks)
    await store.upsert_content_summary(
        workspace_id=workspace_id,
        content_id=content_id,
        fingerprint=fingerprint,
        descriptor=descriptor,
        summary=summary,
        summary_version=SUMMARY_VERSION,
    )

    await store.mark_content_ready(content_id, claim_job_id=claim_job_id)
    if on_progress:
        on_progress(95)
    return {"chunks": len(rows), "fingerprint": fingerprint}


async def embed_copied_chunks(
    *,
    workspace_id: str,
    content_id: str,
    claim_job_id: str | None = None,
    mark_ready: bool = True,
) -> dict[str, Any]:
    """Re-embed chunk text copied from a donor in a different vector space."""
    chunks = await store.load_content_chunks(content_id)
    if not chunks:
        if mark_ready:
            await store.mark_content_ready(content_id, claim_job_id=claim_job_id)
        return {"chunks": 0, "reembedded": True}
    texts = [str(row["indexed_text"] or row["text"]) for row in chunks]
    vectors = await models.embed(texts, spec=embedding_spec())
    rows = []
    for row, text, vector in zip(chunks, texts, vectors):
        rows.append(
            {
                "id": row["id"],
                "chunk_idx": row["chunk_idx"],
                "section_path": row["section_path"],
                "text": row["text"],
                "indexed_text": row["indexed_text"],
                "token_count": row["token_count"],
                "page_start": row["page_start"],
                "page_end": row["page_end"],
                "regions": row["regions"]
                if isinstance(row["regions"], list)
                else json.loads(row["regions"] or "[]"),
                "lang": row["lang"],
                # A donor's reference list stays out of the lexical leg here too.
                "search_text": ""
                if row.get("reference")
                else tokenize_for_search(text),
                "embedding": store.vector_literal(vector),
            }
        )
    await store.replace_content_chunks(
        workspace_id=workspace_id,
        content_id=content_id,
        rows=rows,
        claim_job_id=claim_job_id,
    )
    if mark_ready:
        await store.mark_content_ready(content_id, claim_job_id=claim_job_id)
    return {"chunks": len(rows), "reembedded": True}


# ------------------------------------------------------------------ summaries

_PROMPT_RESERVE_TOKENS = 2000


def _summary_word_target(char_count: int) -> int:
    if char_count < 20_000:
        return 150
    if char_count < 100_000:
        return 300
    return 500


def _words(text: str) -> list[str]:
    """Split so CJK characters count as one word each and Latin runs split on space."""
    words: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if buf:
            words.append("".join(buf))
            buf.clear()

    for ch in text.strip():
        if _is_cjk(ch):
            flush()
            words.append(ch)
        elif ch.isspace():
            flush()
        else:
            buf.append(ch)
    flush()
    return words


_SENTENCE_END = re.compile(r"[.!?。！？][\"')\]]*$")


def _truncate_words(text: str, limit: int) -> str:
    words = _words(text)
    if len(words) <= limit:
        return text.strip()
    for end in range(min(limit, len(words)), 0, -1):
        piece = _join_words(words[:end])
        if _SENTENCE_END.search(piece):
            return piece
    return _join_words(words[:limit])


def _join_words(words: list[str]) -> str:
    out: list[str] = []
    for word in words:
        if not out:
            out.append(word)
            continue
        if _is_cjk(word[0]) and _is_cjk(out[-1][-1]):
            out.append(word)
        else:
            out.append(" " + word)
    return "".join(out).strip()


def _parse_summary_payload(raw: str) -> tuple[str, str]:
    parsed = extract_json(raw)
    if isinstance(parsed, dict):
        descriptor = str(parsed.get("descriptor") or "").strip()
        summary = str(parsed.get("summary") or "").strip()
        if summary:
            return descriptor or summary, summary
        if descriptor:
            return descriptor, descriptor
    text = (raw or "").strip()
    return text, text


def _input_budget() -> int:
    spec = ingest_spec()
    overhead = max(
        compact.request_context(summary_messages("", 1000), spec).total_tokens,
        compact.request_context(partial_messages("", 1000), spec).total_tokens,
    )
    available = (
        registry.input_budget(spec) - overhead - compact.PROTOCOL_SAFETY_MARGIN_TOKENS
    )
    if available <= 0:
        raise RetryableError("The ingest model has no space for source content.")
    return available


def _chunk_groups(chunks: list[Chunk], budget: int) -> list[list[Chunk]]:
    groups: list[list[Chunk]] = []
    current: list[Chunk] = []
    used = 0
    for chunk in chunks:
        cost = estimate_tokens(chunk.indexed_text()) + 2
        if current and used + cost > budget:
            groups.append(current)
            current = [chunk]
            used = cost
        else:
            current.append(chunk)
            used += cost
    if current:
        groups.append(current)
    return groups


async def _summarize_once(body: str, word_target: int) -> tuple[str, str]:
    raw = await models.complete_text(
        summary_messages(body, word_target),
        model=ingest_spec(),
        reasoning=False,
        call_purpose="file_summary",
    )
    return _parse_summary_payload(raw)


async def _summarize_mapped(chunks: list[Chunk], word_target: int) -> tuple[str, str]:
    """Summarize chunk groups, then combine. Used when the document exceeds the budget."""
    groups = _chunk_groups(chunks, _input_budget())
    partials: list[str] = []
    per_group = max(80, word_target // max(len(groups), 1))
    for group in groups:
        body = "\n\n".join(chunk.indexed_text() for chunk in group)
        raw = await models.complete_text(
            partial_messages(body, per_group),
            model=ingest_spec(),
            reasoning=False,
            call_purpose="file_summary",
        )
        if not raw or not raw.strip():
            raise RetryableError("A source section summary was empty.")
        partials.append(raw.strip())
    combined = "\n\n---\n\n".join(partials)
    while estimate_tokens(combined) > _input_budget():
        previous_size = estimate_tokens(combined)
        smaller: list[str] = []
        for group in _chunk_groups(
            [Chunk(text=part) for part in partials], _input_budget()
        ):
            raw = await models.complete_text(
                partial_messages("\n\n".join(chunk.text for chunk in group), per_group),
                model=ingest_spec(),
                reasoning=False,
                call_purpose="file_summary",
            )
            if not raw or not raw.strip():
                raise RetryableError("A source section summary was empty.")
            smaller.append(raw.strip())
        partials = smaller
        combined = "\n\n---\n\n".join(partials)
        if estimate_tokens(combined) >= previous_size:
            raise RetryableError(
                "Source summaries exceed the ingest model input limit."
            )
    return await _summarize_once(combined, word_target)


async def summarize_file(file_name: str, chunks: list[Chunk]) -> tuple[str, str]:
    """Summarize canonical content. ``file_name`` is log context, not prompt input.

    The summary belongs to the content, not to the file: it is stored on
    ``rag_content_summaries`` and copied verbatim to every later workspace that
    uploads the same bytes. A file name in the prompt would put one uploader's
    naming into another's summary, and would make the same bytes summarize
    differently depending on who happened to ingest them first.

    A failure raises rather than returning a blank. An empty summary is written
    as if it were real, marked ready, and then copied to future donors, and no
    later pass ever refills it. Retrying the job (and failing it after the
    budget) is recoverable; a permanent blank is not.
    """
    body = "\n\n".join(chunk.indexed_text() for chunk in chunks)
    word_target = _summary_word_target(len(body))
    try:
        if estimate_tokens(body) <= _input_budget():
            descriptor, summary = await _summarize_once(body, word_target)
        else:
            descriptor, summary = await _summarize_mapped(chunks, word_target)
    except (accounting.SettlementError, elitellm.ProviderBusy):
        # Settlement failures must not start another provider call; a busy
        # provider re-pends the job without spending its attempt.
        raise
    except Exception as exc:
        log.warning("file summary failed for %s", file_name, exc_info=True)
        raise RetryableError(f"file summary failed: {exc}") from exc
    return (
        _truncate_words(descriptor, DESCRIPTOR_WORDS),
        _truncate_words(summary, word_target),
    )
