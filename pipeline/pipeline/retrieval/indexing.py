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

from ..jobs import RetryableError
from ..registry import embedding_spec, ingest_spec
from . import models, store
from .chunking import Chunk, outline_from_chunks, tokenize_for_search

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
) -> dict[str, Any]:
    """Write chunks, summary and concepts for canonical parsed content."""
    if not chunks:
        await store.replace_content_chunks(
            workspace_id=workspace_id, content_id=content_id, rows=[]
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
                # Characters/4 is the usual English approximation and roughly
                # doubles the true count for CJK. It drives display and context
                # budgeting only, so a cheap estimate beats a tokenizer
                # dependency that has to match whichever model reads it.
                "token_count": max(1, len(text) // 4),
                "page_start": chunk.page_start,
                "page_end": chunk.page_end,
                "regions": [region.as_dict() for region in chunk.regions],
                "search_text": tokenize_for_search(text),
                "embedding": store.vector_literal(vector),
            }
        )
    await store.replace_content_chunks(
        workspace_id=workspace_id, content_id=content_id, rows=rows
    )
    if on_progress:
        on_progress(85)

    summary = await summarize_file(file_name, chunks)
    await store.upsert_content_summary(
        workspace_id=workspace_id,
        content_id=content_id,
        fingerprint=fingerprint,
        summary=summary,
        outline=outline_from_chunks(chunks),
    )

    concepts = await extract_concepts(file_name, chunks, rows)
    await store.replace_content_concepts(
        workspace_id=workspace_id, content_id=content_id, concepts=concepts
    )
    await store.mark_content_ready(content_id)
    await store.mark_workspace_dirty(workspace_id, file_id)
    if on_progress:
        on_progress(95)
    return {"chunks": len(rows), "concepts": len(concepts), "fingerprint": fingerprint}


async def embed_copied_chunks(*, workspace_id: str, content_id: str) -> dict[str, Any]:
    """Re-embed chunk text copied from a donor in a different vector space."""
    chunks = await store.load_content_chunks(content_id)
    if not chunks:
        await store.mark_content_ready(content_id)
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
        workspace_id=workspace_id, content_id=content_id, rows=rows
    )
    await store.mark_content_ready(content_id)
    return {"chunks": len(rows), "reembedded": True}


# ------------------------------------------------------------------ summaries

_SUMMARY_SYSTEM = (
    "You summarize study material. Write a dense factual summary that another "
    "assistant will use to decide whether this document is worth reading in full. "
    "Name the specific topics, terms and results covered. No preamble, no "
    "meta-commentary about the document being a document."
)


def _sample(chunks: list[Chunk], budget: int = 12000) -> str:
    """Head, middle and tail of the document, within a fixed character budget.

    Summaries only need coverage, and the first N characters of a textbook are a
    title page. Sampling across the document costs the same and describes it.
    """
    if not chunks:
        return ""
    texts = [chunk.text for chunk in chunks]
    joined = "\n\n".join(texts)
    if len(joined) <= budget:
        return joined
    slice_size = budget // 3
    return "\n\n[…]\n\n".join(
        [
            joined[:slice_size],
            joined[len(joined) // 2 : len(joined) // 2 + slice_size],
            joined[-slice_size:],
        ]
    )


async def summarize_file(file_name: str, chunks: list[Chunk]) -> str:
    """Summarize canonical content. ``file_name`` is log context, not prompt input.

    The summary belongs to the content, not to the file: it is stored on
    ``rag_content_summaries`` and copied verbatim to every later workspace that
    uploads the same bytes. A file name in the prompt would put one uploader's
    naming into another's summary, and would make the same bytes summarize
    differently depending on who happened to ingest them first.

    A failure raises rather than returning a blank. An empty summary is written
    as if it were real, marked ready, and then copied to future donors, and no
    later pass ever refills it — the file silently drops out of chapter and
    workspace rollups and out of the agent's overview. Retrying the job (and
    failing it after the budget) is recoverable; a permanent blank is not.
    """
    outline = [c.section_path for c in chunks if c.section_path]
    unique_outline = list(dict.fromkeys(outline))[:40]
    prompt = (
        (f"Sections: {'; '.join(unique_outline)}\n" if unique_outline else "")
        + "\nContent:\n"
        + _sample(chunks)
        + "\n\nWrite 4-8 sentences."
    )
    try:
        return await models.complete_text(
            [
                {"role": "system", "content": _SUMMARY_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            model=ingest_spec(),
        )
    except Exception as exc:
        log.warning("file summary failed for %s", file_name, exc_info=True)
        raise RetryableError(f"file summary failed: {exc}") from exc


# ------------------------------------------------------------------- concepts

_CONCEPT_SYSTEM = (
    "Extract the named concepts a student would look up: theories, methods, "
    "terms of art, named entities, formulas, events. Return ONLY a JSON array of "
    "strings. No relations, no descriptions, no duplicates, at most 12 items. "
    "Skip generic words that carry no meaning outside their sentence."
)

# Extraction runs per passage group rather than per chunk: one call for every
# chunk of a 400-page book is the cost profile that made graph extraction
# unaffordable in the first place.
_CONCEPT_GROUP = 6


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
        text = "\n\n".join(chunk.text for chunk in group)[:8000]
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


# -------------------------------------------------------------- summary rollup

_CHAPTER_SYSTEM = (
    "You are building a table of contents for a study workspace. Given the "
    "per-document summaries below, write 3-5 sentences describing what this "
    "chapter covers as a whole and what distinguishes its documents from each "
    "other. Name specifics."
)

_WORKSPACE_SYSTEM = (
    "Given the chapter and document summaries below, write 4-6 sentences "
    "describing what this workspace is about and where each major topic lives. "
    "This is read by an assistant deciding which documents to search."
)


async def rollup_summaries(workspace_id: str) -> dict[str, int]:
    """Rebuild the dirty parts of the summary tree from the level below.

    Chapter and workspace summaries derive from file summaries, never from raw
    content, which is what bounds the cost of reorganization: moving a file
    between chapters rewrites two short paragraphs from prose that already
    exists. It is the same reason a wiki's folder READMEs stay cheap to maintain
    while the pages under them do not.
    """
    rebuilt = 0
    failed = 0
    for chapter in await store.dirty_chapters(workspace_id):
        files = await store.chapter_file_summaries(chapter["chapter_id"])
        body = "\n\n".join(
            f"{f['name']}: {f['summary']}" for f in files if f.get("summary")
        )
        if not body:
            await store.set_chapter_summary(chapter["chapter_id"], "")
            rebuilt += 1
            continue
        try:
            summary = await models.complete_text(
                [
                    {"role": "system", "content": _CHAPTER_SYSTEM},
                    {
                        "role": "user",
                        "content": f"Chapter: {chapter['name']}\n\n{body}",
                    },
                ],
                model=ingest_spec(),
            )
        except Exception:
            log.warning("chapter rollup failed", exc_info=True)
            failed += 1
            continue
        await store.set_chapter_summary(chapter["chapter_id"], summary)
        rebuilt += 1

    if failed:
        raise RetryableError(
            f"chapter rollup failed for {failed} chapter(s); left dirty"
        )

    outline = await store.workspace_outline(workspace_id)
    parts: list[str] = []
    for chapter in outline["chapters"]:
        if chapter.get("summary"):
            parts.append(f"Chapter {chapter['name']}: {chapter['summary']}")
    for file in outline["files"]:
        if file.get("summary") and not file.get("chapter_id"):
            parts.append(f"Unfiled document {file['name']}: {file['summary']}")
    summary = ""
    if parts:
        try:
            summary = await models.complete_text(
                [
                    {"role": "system", "content": _WORKSPACE_SYSTEM},
                    {"role": "user", "content": "\n\n".join(parts)[:16000]},
                ],
                model=ingest_spec(),
            )
        except Exception as exc:
            log.warning("workspace rollup failed", exc_info=True)
            raise RetryableError("workspace rollup failed") from exc
    await store.set_workspace_summary(workspace_id, summary)
    return {"chapters": rebuilt}
