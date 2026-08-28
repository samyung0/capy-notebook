"""Index one file: chunk, embed, summarize, extract concepts.

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

from .. import registry
from ..jobs import RetryableError
from ..registry import embedding_spec, ingest_spec
from . import models, store
from .chunking import Chunk, _is_cjk, estimate_tokens, tokenize_for_search
from .workflows import extract_json

log = logging.getLogger("evo.retrieval.indexing")


def _uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def content_hash(chunks: list[Chunk]) -> str:
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk.text.encode("utf-8"))
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
) -> dict[str, Any]:
    """Write chunks, summary and concepts for canonical parsed content."""
    if not chunks:
        await store.replace_content_chunks(
            workspace_id=workspace_id,
            content_id=content_id,
            rows=[],
            claim_job_id=claim_job_id,
        )
        return {"chunks": 0, "concepts": 0}

    fingerprint = content_hash(chunks)
    indexed = [chunk.indexed_text() for chunk in chunks]
    # The workspace's embedding pin, installed on the job by the worker. Not the
    # registry default: this workspace's existing chunks are in that space and
    # there is no reindex job to move them.
    vectors = await models.embed(indexed, spec=embedding_spec())
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
                "search_text": tokenize_for_search(text),
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

    concepts = await extract_concepts(file_name, chunks, rows)
    await store.replace_content_concepts(
        workspace_id=workspace_id, content_id=content_id, concepts=concepts
    )
    await store.mark_content_ready(content_id, claim_job_id=claim_job_id)
    if on_progress:
        on_progress(95)
    return {"chunks": len(rows), "concepts": len(concepts), "fingerprint": fingerprint}


async def embed_copied_chunks(
    *,
    workspace_id: str,
    content_id: str,
    claim_job_id: str | None = None,
) -> dict[str, Any]:
    """Re-embed chunk text copied from a donor in a different vector space."""
    chunks = await store.load_content_chunks(content_id)
    if not chunks:
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
                "search_text": tokenize_for_search(text),
                "embedding": store.vector_literal(vector),
            }
        )
    await store.replace_content_chunks(
        workspace_id=workspace_id,
        content_id=content_id,
        rows=rows,
        claim_job_id=claim_job_id,
    )
    await store.mark_content_ready(content_id, claim_job_id=claim_job_id)
    return {"chunks": len(rows), "reembedded": True}


# ------------------------------------------------------------------ summaries

# Bumped when the prompt or length policy changes. Not part of pipeline_identity:
# a prose change must not invalidate a parse. Donors copy the version so a later
# backfill can tell old summaries from new.
SUMMARY_VERSION = 1
_DESCRIPTOR_WORDS = 50
_PROMPT_RESERVE_TOKENS = 2000

_SUMMARY_SYSTEM = (
    "You summarize study material for another assistant. Return ONLY JSON: "
    '{"descriptor": "...", "summary": "..."}. descriptor is one dense sentence '
    "of about 50 words naming the topics covered. summary is a factual overview "
    "of the requested length. Name specific topics, terms and results. No "
    "preamble, no meta-commentary about the document being a document."
)

_PARTIAL_SYSTEM = (
    "You summarize one section of a longer study document. Write a dense "
    "factual overview of the requested length covering the specific topics, "
    "terms and results in this section. No preamble."
)


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
    return max(1000, registry.input_budget(ingest_spec()))


def _chunk_groups(chunks: list[Chunk], budget: int) -> list[list[Chunk]]:
    groups: list[list[Chunk]] = []
    current: list[Chunk] = []
    used = 0
    for chunk in chunks:
        cost = estimate_tokens(chunk.text)
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
        [
            {"role": "system", "content": _SUMMARY_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"Write a descriptor of about {_DESCRIPTOR_WORDS} words and "
                    f"a summary of about {word_target} words.\n\nContent:\n{body}"
                ),
            },
        ],
        model=ingest_spec(),
        reasoning=False,
    )
    return _parse_summary_payload(raw)


async def _summarize_mapped(chunks: list[Chunk], word_target: int) -> tuple[str, str]:
    """Summarize chunk groups, then combine. Used when the document exceeds the budget."""
    groups = _chunk_groups(chunks, _input_budget())
    partials: list[str] = []
    per_group = max(80, word_target // max(len(groups), 1))
    for group in groups:
        body = "\n\n".join(chunk.text for chunk in group)
        raw = await models.complete_text(
            [
                {"role": "system", "content": _PARTIAL_SYSTEM},
                {
                    "role": "user",
                    "content": f"Write about {per_group} words.\n\nContent:\n{body}",
                },
            ],
            model=ingest_spec(),
            reasoning=False,
        )
        if raw and raw.strip():
            partials.append(raw.strip())
    combined = "\n\n---\n\n".join(partials)
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
    body = "\n\n".join(chunk.text for chunk in chunks)
    word_target = _summary_word_target(len(body))
    try:
        if estimate_tokens(body) <= _input_budget():
            descriptor, summary = await _summarize_once(body, word_target)
        else:
            descriptor, summary = await _summarize_mapped(chunks, word_target)
    except Exception as exc:
        log.warning("file summary failed for %s", file_name, exc_info=True)
        raise RetryableError(f"file summary failed: {exc}") from exc
    return (
        _truncate_words(descriptor, _DESCRIPTOR_WORDS),
        _truncate_words(summary, word_target),
    )


# ------------------------------------------------------------------- concepts

_CONCEPT_SYSTEM = (
    "Extract the named concepts a student would look up: theories, methods, "
    "terms of art, named entities, formulas, events. Return ONLY a JSON array of "
    "strings. No relations, no descriptions, no duplicates, at most 24 items. "
    "Skip generic words that carry no meaning outside their sentence."
)

# Extraction runs per passage group rather than per chunk: one call for every
# chunk of a 400-page book is the cost profile that made graph extraction
# unaffordable in the first place. The group size is a mention-granularity
# knob, not a context budget — mentions attach to every chunk in the group.
_CONCEPT_GROUP = 12
_CONCEPT_CHARS = 20000


async def extract_concepts(
    file_name: str, chunks: list[Chunk], rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Concepts per chunk group, deduped by normalized name.

    Deliberately relation-free. Extracting typed edges is where graph RAG spends
    most of its ingest budget and most of its accuracy: the entities are
    reliable, the relations are not. Co-mention recovers the useful part of an
    edge at query time, from data that cannot be hallucinated.

    ``file_name`` is log context only, for the same reason as the summary above:
    concepts are copied to every workspace that uploads these bytes.
    """
    by_norm: dict[str, dict[str, Any]] = {}
    for start in range(0, len(chunks), _CONCEPT_GROUP):
        group = chunks[start : start + _CONCEPT_GROUP]
        group_rows = rows[start : start + _CONCEPT_GROUP]
        text = "\n\n".join(chunk.text for chunk in group)[:_CONCEPT_CHARS]
        if not text.strip():
            continue
        try:
            raw = await models.complete_text(
                [
                    {"role": "system", "content": _CONCEPT_SYSTEM},
                    {"role": "user", "content": text},
                ],
                model=ingest_spec(),
                temperature=0.0,
                reasoning=False,
            )
        except Exception:
            log.warning("concept extraction failed for %s", file_name, exc_info=True)
            continue
        for name in _parse_concepts(raw):
            norm = store.normalize_concept(name)
            if len(norm) < 2 or len(norm) > 120:
                continue
            entry = by_norm.setdefault(
                norm,
                {
                    "id": _uid("cpt"),
                    "name": name.strip(),
                    "norm": norm,
                    "chunk_ids": [],
                },
            )
            entry["chunk_ids"].extend(row["id"] for row in group_rows)
    for entry in by_norm.values():
        entry["chunk_ids"] = list(dict.fromkeys(entry["chunk_ids"]))
    return list(by_norm.values())


def _parse_concepts(raw: str) -> list[str]:
    if not raw:
        return []
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", raw, re.DOTALL)
    candidate = fenced.group(1) if fenced else raw
    match = re.search(r"\[.*\]", candidate, re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    return [str(item) for item in parsed if isinstance(item, (str, int, float))]
