"""Index one file: chunk, embed, describe.

Called by the ingest worker once a document has been parsed. Everything below is
idempotent per file — re-running replaces that file's rows and nothing else — so
a retried job converges instead of duplicating.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import logging
import re
import secrets
import unicodedata
from datetime import datetime
from typing import Any

from .. import elitellm
from ..ingest import uat
from ..jobs import RetryableError
from ..prompts.ingest import (
    summary_messages,
)
from ..registry import embedding_spec, ingest_spec
from . import accounting, models, store
from .chunking import Chunk, clip_to_tokens, estimate_tokens, tokenize_for_search
from .lang import detect_lang

log = logging.getLogger("capy.retrieval.indexing")


def _uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def content_hash(chunks: list[Chunk]) -> str:
    """Hash passage text, citation geometry and extraction confidence.

    Geometry is part of canonical content identity. Otherwise two documents
    with the same words but different pagination or layout would share chunks,
    and citations for one upload could point at coordinates from the other.
    Confidence also belongs to the content: reusing higher-confidence chunks
    for an OCR upload would remove the prompt's reason to inspect the page.
    """
    digest = hashlib.sha256()
    for chunk in chunks:
        digest.update(chunk.indexed_text().encode("utf-8"))
        digest.update(b"\x01" if chunk.reference else b"\x00")
        digest.update(b"\x00")
        metadata = {
            "page_start": chunk.page_start,
            "page_end": chunk.page_end,
            "regions": [region.as_dict() for region in chunk.regions],
        }
        if chunk.confidence is not None or chunk.confidence_reasons:
            metadata.update(
                confidence=chunk.confidence,
                confidence_reasons=chunk.confidence_reasons,
            )
        if (
            chunk.page_start is not None
            or chunk.page_end is not None
            or chunk.regions
            or chunk.confidence is not None
            or chunk.confidence_reasons
        ):
            digest.update(
                json.dumps(
                    metadata,
                    ensure_ascii=False,
                    allow_nan=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
        digest.update(b"\x00")
    return digest.hexdigest()


def _space(workspace_id: str | None, pin: dict[str, Any] | None) -> dict[str, Any]:
    """The embedding space argument of ``store.replace_content_chunks``: none
    for a workspace file, whose space the store reads from the workspace row;
    a standalone file's (no workspace) is the pin its job resolved."""
    return {} if workspace_id else {"pin": pin}


async def index_file(
    *,
    workspace_id: str | None,
    content_id: str,
    file_id: str,
    file_name: str,
    chunks: list[Chunk],
    on_progress=None,
    claim_job_id: str | None = None,
    allow_empty: bool = False,
    pin: dict[str, Any] | None = None,
    note_rule: bool = False,
) -> dict[str, Any]:
    """Write chunks and the descriptor for canonical parsed content; the
    caller publishes it (``store.publish_file_content``). A standalone file
    passes no workspace and its ``pin``; its rows are owner-scoped through
    their content row. ``note_rule``: a text or markdown file, whose
    descriptor follows a note's summary rule (Q457).

    The descriptor is a part: when it fails, no summary row is written (the
    descriptor is pending, never blank) and ``summary_error`` carries the
    failure. Only an AccountingError raises.
    """
    if not chunks:
        await store.replace_content_chunks(
            workspace_id=workspace_id,
            content_id=content_id,
            rows=[],
            claim_job_id=claim_job_id,
            **_space(workspace_id, pin),
        )
        if allow_empty:
            await store.upsert_content_summary(
                workspace_id=workspace_id,
                content_id=content_id,
                fingerprint=content_hash([]),
                descriptor="",
                change_share=0.0,
            )
        return {"chunks": 0, "summary_error": None}

    # Read before any write: reindexing the same content replaces these rows.
    published = await store.published_summary(
        workspace_id=workspace_id, file_id=file_id
    )
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
                "confidence": chunk.confidence,
                "confidence_reasons": list(chunk.confidence_reasons),
                "embedding": store.vector_literal(vector),
            }
        )
    await store.replace_content_chunks(
        workspace_id=workspace_id,
        content_id=content_id,
        rows=rows,
        claim_job_id=claim_job_id,
        **_space(workspace_id, pin),
    )
    if on_progress:
        on_progress(85)

    descriptor, change_share, written_at, summary_error = await _descriptor(
        file_name, chunks, published, note_rule=note_rule
    )
    if descriptor is not None:
        await store.upsert_content_summary(
            workspace_id=workspace_id,
            content_id=content_id,
            fingerprint=fingerprint,
            descriptor=descriptor,
            change_share=change_share,
            written_at=written_at,
        )
    if on_progress:
        on_progress(95)
    return {
        "chunks": len(rows),
        "fingerprint": fingerprint,
        "summary_error": summary_error,
    }


async def fill_descriptor(
    *,
    workspace_id: str | None,
    content_id: str,
    file_name: str,
    note_rule: bool = False,
) -> Exception | None:
    """Describe published content whose descriptor is pending, from its stored
    chunks: one summary call, no parse and no embedding. The row is inserted
    only if still absent. Returns the failure, or None once a descriptor is
    present; an AccountingError raises."""
    if await store.has_content_summary(content_id):
        return None
    rows = await store.load_content_chunks(content_id)
    chunks = [Chunk(text=r["text"], section_path=r["section_path"] or "") for r in rows]
    descriptor, _, _, error = await _descriptor(
        file_name, chunks, None, note_rule=note_rule
    )
    if descriptor is not None:
        await store.fill_content_summary(
            workspace_id=workspace_id, content_id=content_id, descriptor=descriptor
        )
    return error


async def index_material(
    *,
    workspace_id: str,
    material_id: str,
    title: str,
    content_id: str,
    previous_content_id: str | None,
    chunks: list[Chunk],
    claim_job_id: str,
    blocks: list[dict[str, Any]],
) -> dict[str, Any]:
    """Write a note's chunks and summary into canonical content and publish
    it. Unchanged chunks reuse the previous content's vectors, which stays
    aliased (and searchable) until the publish."""
    if not chunks:
        await store.replace_content_chunks(
            workspace_id=workspace_id,
            content_id=content_id,
            rows=[],
            claim_job_id=claim_job_id,
        )
        await store.publish_material_content(
            workspace_id=workspace_id,
            material_id=material_id,
            content_id=content_id,
            claim_job_id=claim_job_id,
            blocks=blocks,
        )
        return {"chunks": 0, "embedded": 0}
    published = (
        await store.content_summary(previous_content_id)
        if previous_content_id
        else None
    )
    indexed = [chunk.indexed_text() for chunk in chunks]
    spec = embedding_spec()
    reusable = (
        await store.existing_content_vectors(
            workspace_id=workspace_id,
            content_id=previous_content_id,
            spec=spec,
            inputs=indexed,
        )
        if previous_content_id
        else {}
    )
    missing = list(dict.fromkeys(text for text in indexed if text not in reusable))
    if missing:
        reusable.update(zip(missing, await models.embed(missing, spec=spec)))
    rows = [
        {
            "id": _uid("chk"),
            "chunk_idx": idx,
            "section_path": chunk.section_path,
            "text": chunk.text,
            "indexed_text": text,
            "token_count": max(1, estimate_tokens(text)),
            "page_start": None,
            "page_end": None,
            "regions": [],
            "lang": detect_lang(chunk.text),
            "search_text": "" if chunk.reference else tokenize_for_search(text),
            "confidence": chunk.confidence,
            "confidence_reasons": list(chunk.confidence_reasons),
            "embedding": store.vector_literal(reusable[text]),
        }
        for idx, (chunk, text) in enumerate(zip(chunks, indexed))
    ]
    await store.replace_content_chunks(
        workspace_id=workspace_id,
        content_id=content_id,
        rows=rows,
        claim_job_id=claim_job_id,
    )
    await _note_summary(
        workspace_id=workspace_id,
        name=f"{title} ({material_id})",
        content_id=content_id,
        chunks=chunks,
        published=published,
    )
    await store.publish_material_content(
        workspace_id=workspace_id,
        material_id=material_id,
        content_id=content_id,
        claim_job_id=claim_job_id,
        blocks=blocks,
    )
    return {"chunks": len(rows), "embedded": len(missing)}


async def embed_copied_chunks(
    *,
    workspace_id: str | None,
    content_id: str,
    claim_job_id: str | None = None,
    pin: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-embed chunk text copied from a donor in a different vector space;
    the caller publishes the content."""
    chunks = await store.load_content_chunks(content_id)
    if not chunks:
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
                "confidence": row.get("confidence"),
                "confidence_reasons": list(row.get("confidence_reasons") or []),
                "embedding": store.vector_literal(vector),
            }
        )
    await store.replace_content_chunks(
        workspace_id=workspace_id,
        content_id=content_id,
        rows=rows,
        claim_job_id=claim_job_id,
        **_space(workspace_id, pin),
    )
    return {"chunks": len(rows), "reembedded": True}


# ------------------------------------------------------------------ summaries

# A descriptor reads at most this many estimated tokens of the content (see
# ``descriptor_excerpt``): the outline, about half the budget of opening
# chunks, and openings of evenly spaced later chunks.
DESCRIPTOR_INPUT_TOKENS = 8000
_OUTLINE_TOKENS = 1200
_OPENING_TOKENS = 150

# The prompt asks for about ``DESCRIPTOR_WORDS`` as plain text; like
# compaction's summary, the reply is stored as written. A reply cut off at this
# bound is a failed attempt (models.complete_response). It fits a normal reply
# several times over with thinking off, which the ingest pin is assumed to have.
_DESCRIPTOR_MAX_TOKENS = 400

# A refresh reuses the published descriptor until the net text change since its
# last regeneration reaches this share of the document.
SUMMARY_REUSE_SHARE = 0.02

# A note's summary (Epo 2026-10-20), and a text or markdown file's (Q457):
# none under NOTE_SUMMARY_MIN_TOKENS, and a rewrite once the change reaches
# NOTE_SUMMARY_SHARE and the summary is at least NOTE_SUMMARY_MIN_AGE_S old.
# Notes and text files reindex after every burst of typing, so the age bound
# keeps an active one from paying for a summary per session.
NOTE_SUMMARY_MIN_TOKENS = 200
NOTE_SUMMARY_SHARE = 0.10
NOTE_SUMMARY_MIN_AGE_S = 24 * 3600


async def _descriptor(
    name: str,
    chunks: list[Chunk],
    published: dict[str, Any] | None,
    *,
    note: bool = False,
    note_rule: bool = False,
) -> tuple[str | None, float, datetime | None, Exception | None]:
    """The descriptor to store, the running change share kept next to it, when
    the descriptor was written (``None``: now), and the failure that left the
    descriptor pending (``None`` to store).

    Regenerates from the complete content when no published descriptor exists
    (a blank one is none) or once the change reaches the share. A note, and a
    file under ``note_rule``, takes the note rule: blank under the minimum
    tokens, else the note share and age. A failed regeneration keeps a
    non-blank published descriptor with the accumulated share, so the next
    run tries again; without one the descriptor is pending. An accounting
    error (a SettlementError among them) raises: it is no part failure.
    """
    note_rule = note_rule or note
    # The document size is the same estimate as the full summary input.
    document = estimate_tokens("\n\n".join(c.indexed_text() for c in chunks))
    if note_rule and document < NOTE_SUMMARY_MIN_TOKENS:
        return "", 0.0, None, None
    share = 0.0
    if published is not None and published["descriptor"]:
        changed = text_change_tokens(published["chunks"], chunks)
        share = published["change_share"] + changed / max(1, document)
        if share < (NOTE_SUMMARY_SHARE if note_rule else SUMMARY_REUSE_SHARE) or (
            note_rule and published["age"] < NOTE_SUMMARY_MIN_AGE_S
        ):
            return published["descriptor"], share, published["updated_at"], None
    try:
        if uat.fail_summary(name):
            raise RuntimeError(f"UAT: the file name carries {uat.FAIL_SUMMARY}")
        summarize = summarize_note if note else summarize_file
        return await summarize(name, chunks), 0.0, None, None
    except accounting.AccountingError:
        raise
    except Exception as exc:  # noqa: BLE001 - any failure leaves a part missing
        log.warning("descriptor failed for %s: %s", name, exc)
        if published is not None and published["descriptor"]:
            return published["descriptor"], share, published["updated_at"], None
        return None, 0.0, None, exc


async def fill_note_summary(
    *,
    workspace_id: str,
    material_id: str,
    title: str,
    content_id: str,
    chunks: list[Chunk],
) -> None:
    """A reindex onto ready content (an unchanged text hash, as after a
    formatting-only edit) runs the summary step alone when that content has
    none (Epo 2026-10-20): no re-chunk, no re-embed."""
    if await store.has_content_summary(content_id):
        return
    await _note_summary(
        workspace_id=workspace_id,
        name=f"{title} ({material_id})",
        content_id=content_id,
        chunks=chunks,
        published=None,
    )


async def _note_summary(
    *,
    workspace_id: str,
    name: str,
    content_id: str,
    chunks: list[Chunk],
    published: dict[str, Any] | None,
) -> None:
    """Write the note's summary row on its new content, before the publish
    drops the previous content and its row. ``name`` (title and id) is log
    and UAT context, never prompt input. A failure publishes the note
    without a summary, or with its previous one, and the next index writes it:
    failing the job would abandon the new chunks with it."""
    descriptor, share, written_at, _ = await _descriptor(
        name, chunks, published, note=True
    )
    if not descriptor:
        # Blank under the minimum tokens: a note stores no row.
        return
    await store.upsert_content_summary(
        workspace_id=workspace_id,
        content_id=content_id,
        fingerprint="note:" + content_hash(chunks),
        descriptor=descriptor,
        change_share=share,
        written_at=written_at,
    )


def _key(text: str) -> str:
    """Comparison key: ligatures folded, whitespace ignored. The parser returns
    figure labels and ligatures with other spacing or glyphs when the layout
    moves, without any edit."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def _lines(chunks: list[Chunk], headings: set[str]) -> list[str]:
    """Lines in reading order without chunk overlap or retained headings: a
    chunk repeats the trailing blocks of the chunk before it, and heading
    retention repeats a heading depending on where a chunk starts."""
    out: list[str] = []
    previous: list[str] = []
    for chunk in chunks:
        lines = [line for line in chunk.text.split("\n") if line.strip()]
        carry = next(
            (
                k
                for k in range(min(len(previous), len(lines)), 0, -1)
                if previous[-k:] == lines[:k]
            ),
            0,
        )
        out.extend(line for line in lines[carry:] if _key(line) not in headings)
        previous = lines
    return out


def _edits(a: list[str], b: list[str], gap: int) -> list[list[int]]:
    """Changed ranges ``[i1, i2, j1, j2]``, neighbours within ``gap`` merged."""
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    merged: list[list[int]] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if merged and i1 - merged[-1][1] <= gap and j1 - merged[-1][3] <= gap:
            merged[-1][1], merged[-1][3] = i2, j2
        else:
            merged.append([i1, i2, j1, j2])
    return merged


# A changed line range longer than this on either side counts as wholly changed
# instead of being diffed word by word: the word diff goes quadratic on
# repetitive text such as a renumbered CSV or a sorted table (minutes for a
# 500-row CSV) and grows with the larger side when a block is pasted or
# deleted. The count is an upper bound, so the gate can only regenerate earlier.
_WORD_DIFF_CAP = 1000


def text_change_tokens(old: list[Chunk], new: list[Chunk]) -> int:
    """Estimated tokens of the text removed plus the text added between two
    indexed versions, ignoring reflow.

    Page breaks and chunk packing re-split unchanged text, so the chunk lists
    differ far more than the words do. Lines are aligned first, then words
    inside each changed range; spans that differ only in spacing or glyph
    forms count nothing. A range over ``_WORD_DIFF_CAP`` words on either side
    counts whole.
    """
    headings = {
        _key(part)
        for version in (old, new)
        for chunk in version
        for part in chunk.section_path.split(" › ")
        if part.strip()
    }
    a, b = _lines(old, headings), _lines(new, headings)
    total = 0
    for i1, i2, j1, j2 in _edits([_key(t) for t in a], [_key(t) for t in b], 1):
        aw = " ".join(a[i1:i2]).split()
        bw = " ".join(b[j1:j2]).split()
        if max(len(aw), len(bw)) > _WORD_DIFF_CAP:
            total += estimate_tokens(" ".join(aw)) + estimate_tokens(" ".join(bw))
            continue
        folded = [
            [unicodedata.normalize("NFKC", w) for w in words] for words in (aw, bw)
        ]
        for x1, x2, y1, y2 in _edits(*folded, 12):
            removed, added = " ".join(aw[x1:x2]), " ".join(bw[y1:y2])
            if _key(removed) != _key(added):
                total += estimate_tokens(removed) + estimate_tokens(added)
    return total


def descriptor_excerpt(chunks: list[Chunk]) -> str:
    """What the descriptor call reads: the whole content when it fits
    ``DESCRIPTOR_INPUT_TOKENS``, else the heading outline, the opening chunks
    and the start of evenly spaced later chunks (decision 2026-10-15)."""
    full = "\n\n".join(chunk.indexed_text() for chunk in chunks)
    if estimate_tokens(full) <= DESCRIPTOR_INPUT_TOKENS:
        return full
    outline = list(dict.fromkeys(c.section_path for c in chunks if c.section_path))
    while estimate_tokens("\n".join(outline)) > _OUTLINE_TOKENS:
        outline = outline[::2]
    parts = ["\n".join(outline)] if outline else []
    budget = DESCRIPTOR_INPUT_TOKENS - estimate_tokens("\n".join(outline))
    used, start = 0, 0
    while start < len(chunks):
        cost = estimate_tokens(chunks[start].indexed_text())
        if used + cost > budget // 2:
            break
        parts.append(chunks[start].indexed_text())
        used += cost
        start += 1
    rest = chunks[start:]
    count = max(1, (budget - used) // _OPENING_TOKENS)
    step = max(1.0, len(rest) / count)
    position = 0.0
    while int(position) < len(rest):
        chunk = rest[int(position)]
        opening = clip_to_tokens(chunk.text, _OPENING_TOKENS - 20) + " …"
        piece = f"{chunk.section_path}\n{opening}" if chunk.section_path else opening
        cost = estimate_tokens(piece)
        if used + cost > budget:
            break
        parts.append(piece)
        used += cost
        position += step
    return "\n\n".join(parts)


async def _summarize(body: str, purpose: str) -> str:
    raw = await models.complete_text(
        summary_messages(body),
        model=ingest_spec(),
        max_tokens=_DESCRIPTOR_MAX_TOKENS,
        reasoning=False,
        call_purpose=purpose,
    )
    descriptor = (raw or "").strip()
    if not descriptor:
        raise RetryableError(f"The {purpose} was empty.")
    return descriptor


async def summarize_note(name: str, chunks: list[Chunk]) -> str:
    """A note's summary: the file prompt, without the note's title, so the
    same text describes the same way. ``name`` is log context."""
    try:
        return await _summarize(descriptor_excerpt(chunks), "note_summary")
    except (accounting.AccountingError, elitellm.ProviderBusy):
        raise
    except Exception as exc:
        log.warning("note summary failed for %s", name, exc_info=True)
        raise RetryableError(f"note summary failed: {exc}") from exc


async def summarize_file(file_name: str, chunks: list[Chunk]) -> str:
    """Describe canonical content. ``file_name`` is log context, not prompt input.

    The descriptor belongs to the content, not to the file: it is stored on
    ``rag_content_summaries`` and copied verbatim to every later workspace that
    uploads the same bytes. A file name in the prompt would put one uploader's
    naming into another's descriptor, and would make the same bytes describe
    differently depending on who happened to ingest them first.

    A failure raises rather than returning a blank. An empty descriptor would
    be stored as if it were real and copied to future donors, and no later pass
    would ever refill it; a pending one (no row, ``_descriptor``) is filled by
    the next busy re-pend, donor continuation, refresh or Retry processing.
    """
    try:
        descriptor = await _summarize(descriptor_excerpt(chunks), "file_summary")
    except (accounting.AccountingError, elitellm.ProviderBusy):
        # Accounting failures (settlement among them) must not start another
        # provider call; a busy provider re-pends the job without spending its
        # attempt.
        raise
    except Exception as exc:
        log.warning("file summary failed for %s", file_name, exc_info=True)
        raise RetryableError(f"file summary failed: {exc}") from exc
    return descriptor
