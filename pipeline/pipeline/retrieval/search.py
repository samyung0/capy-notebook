"""Hybrid search over the chunk store.

The pipeline is: embed the query, run vector and lexical search in one SQL
statement, fuse by reciprocal rank, rerank the first candidates with a
cross-encoder (:func:`rerank`), cap how much any single file may contribute,
and return the hit passages.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .. import registry
from ..config import cfg
from . import models, store
from .chunking import search_query_terms
from .lang import UND

log = logging.getLogger("capy.search")

# Fused candidates the reranker reorders; the rest keep fused order behind them.
# 20 scored as well as 40 on the library study at about half the latency
# (bench/rag/rerank/reports/2026-09-25-library-rerank.md).
RERANK_CANDIDATES = 20


@dataclass
class Passage:
    chunk_id: str
    # The resource the chunk belongs to: a file, or a note when kind is
    # "material" (file_id then holds the material id and file_name its title).
    file_id: str
    file_name: str
    chunk_idx: int
    section_path: str
    text: str
    # Citation snippet. Same as text for search hits; callers may attach extra
    # context to text without moving the citation.
    hit_text: str = ""
    page_start: int | None = None
    page_end: int | None = None
    regions: list[dict[str, Any]] = field(default_factory=list)
    score: float = 0.0
    # Retrieval evidence for telemetry: which leg found the hit and how well.
    # None rank means the leg did not have it among its candidates.
    lang: str = UND
    vec_rank: int | None = None
    vec_dist: float | None = None
    lex_rank: int | None = None
    # In the returned set only because the exact tier raised its lexical weight.
    tier_only: bool = False
    # Extraction confidence stored at ingest (retrieval/confidence.py); None
    # for sources without a page model.
    confidence: float | None = None
    confidence_reasons: list[str] = field(default_factory=list)
    kind: str = "file"

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Passage:
        dist = row.get("vec_dist")
        confidence = row.get("confidence")
        return cls(
            chunk_id=row["id"],
            file_id=row["file_id"],
            file_name=row["file_name"],
            kind=str(row.get("kind") or "file"),
            chunk_idx=row["chunk_idx"],
            section_path=row.get("section_path") or "",
            text=row["text"],
            hit_text=row["text"],
            page_start=row.get("page_start"),
            page_end=row.get("page_end"),
            regions=store.decode_regions(row.get("regions")),
            score=float(row.get("score") or 0.0),
            lang=row.get("lang") or UND,
            vec_rank=row.get("vec_rank"),
            vec_dist=None if dist is None else float(dist),
            lex_rank=row.get("lex_rank"),
            confidence=None if confidence is None else float(confidence),
            confidence_reasons=list(row.get("confidence_reasons") or []),
        )

    def location(self) -> str:
        parts = [self.file_name]
        if self.section_path:
            parts.append(self.section_path)
        if self.page_start:
            span = (
                f"p.{self.page_start}"
                if self.page_end in (None, self.page_start)
                else f"pp.{self.page_start}–{self.page_end}"
            )
            parts.append(span)
        header = " › ".join(parts)
        # This warns about text extraction. Visual facts require capture even
        # when the text-layer agreement score is high.
        if self.confidence is not None and self.confidence < cfg.confidence_note_below:
            reasons = "; ".join(self.confidence_reasons) or "no issue found"
            header += f" [extraction confidence {self.confidence:.2f}: {reasons}]"
        return header

    def as_context(self, index: int) -> str:
        return f"[{index}] {self.location()}\n{self.text}"

    def as_citation(self) -> dict[str, Any]:
        citation: dict[str, Any] = {
            "fileId": "" if self.kind == "material" else self.file_id,
            "chunkId": self.chunk_id,
            "fileName": self.file_name,
            "snippet": (self.hit_text or self.text)[:400],
        }
        if self.kind == "material":
            citation["kind"] = "material"
            citation["materialId"] = self.file_id
        if self.page_start:
            citation["pageStart"] = self.page_start
            citation["pageEnd"] = self.page_end or self.page_start
        if self.regions:
            citation["regions"] = self.regions[:12]
        return citation


@dataclass
class SearchStats:
    """Per-search telemetry, filled in by :func:`search` when a caller passes one.

    ``hits_lang`` is the majority language of the returned hits rather than a
    detection on the question: on the lab sets 30 of 42 French, German and
    Spanish questions were too short for ``detect_lang`` and read as ``und``.
    """

    hits_lang: str = UND
    query_terms: int = 0
    cjk_runs: int = 0
    embed_ms: int = 0
    sql_ms: int = 0


async def search(
    *,
    workspace_id: str,
    query: str,
    file_ids: list[str] | None = None,
    top_k: int | None = None,
    stats: SearchStats | None = None,
) -> list[Passage]:
    top_k = top_k or cfg.search_top_k
    # The query has to be embedded by the same model as the chunks it will be
    # compared against, and that is a property of the workspace rather than of
    # this process. Reading it per search costs one indexed primary-key lookup
    # and removes the possibility of a redeploy silently changing vector spaces.
    pin = await store.workspace_embedding_pin(workspace_id)
    spec = registry.resolve_pinned(
        pin["embedding_provider_slug"],
        pin["embedding_model_slug"],
        pin["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )
    started = time.monotonic()
    vectors = await models.embed([models.format_query(query, spec)], spec=spec)
    embedded = time.monotonic()
    if not vectors:
        return []
    terms = search_query_terms(query)
    rows = await store.hybrid_search(
        workspace_id=workspace_id,
        vector=vectors[0],
        terms=terms,
        file_ids=file_ids,
        candidates=cfg.search_candidates,
    )
    searched = time.monotonic()
    ranked, reranked = await rerank(query, rows)
    passages = [Passage.from_row(row) for row in ranked]
    top = _cap_per_file(passages, cfg.search_per_file_cap)[:top_k]
    _mark_tier_only(top, rows, top_k, reranked)
    if stats is not None:
        langs = Counter(p.lang for p in top)
        stats.hits_lang = langs.most_common(1)[0][0] if langs else UND
        stats.query_terms = terms.terms
        stats.cjk_runs = terms.cjk_runs
        stats.embed_ms = int((embedded - started) * 1000)
        stats.sql_ms = int((searched - embedded) * 1000)
    return top


def _mark_tier_only(
    top: list[Passage], rows: list[dict[str, Any]], top_k: int, reranked: bool
) -> None:
    """Flag hits that the exact tier alone put in the returned set.

    ``rows`` are in fused order. ``flat_score`` is the fusion with every
    lexical row at half weight. Ranking the candidates by it, with the same
    per-file cap, gives the set the caller would have seen without the tier;
    anything in ``top`` but not in that set owes its place to the tier. This is
    the counterfactual the telemetry needs to judge whether the tier surfaces
    answers or noise.

    After a rerank the tier's only lever is which rows reach the reranker, so a
    hit is tier-only when it is among the fused candidates the reranker scored
    but not among the first :data:`RERANK_CANDIDATES` by ``flat_score``.
    """
    if not any(row["score"] != row["flat_score"] for row in rows):
        return
    flat = sorted(rows, key=lambda row: row["flat_score"], reverse=True)
    if reranked:
        head = {row["id"] for row in rows[:RERANK_CANDIDATES]}
        flat_head = {row["id"] for row in flat[:RERANK_CANDIDATES]}
        for passage in top:
            passage.tier_only = (
                passage.chunk_id in head and passage.chunk_id not in flat_head
            )
        return
    flat_top = _cap_per_file(
        [Passage.from_row(row) for row in flat], cfg.search_per_file_cap
    )
    without_tier = {p.chunk_id for p in flat_top[:top_k]}
    for passage in top:
        passage.tier_only = passage.chunk_id not in without_tier


def _rerank_spec() -> registry.ModelConfig | None:
    """The rerank slot's default, or None when the slot is unassigned.

    The one slot whose missing default is not an error: clearing it is how an
    operator turns reranking off. It also reads the live default instead of a
    pin, because a rerank is recorded at zero credits like the query embedding
    of the same search, so there is no quoted price for a pin to hold.
    """
    try:
        return registry.registry.default(registry.Slot.RERANK)
    except registry.RegistryError:
        return None


async def rerank(
    query: str, rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], bool]:
    """Reorder the first fused candidates by the rerank slot's model.

    Used by workspace and library search, before the per-file cap and the
    excerpt fold. The model scores each row's ``indexed_text`` against the raw
    query; rows past :data:`RERANK_CANDIDATES` follow in fused order. Returns
    the rows and whether they were reranked. A search never fails because of
    the reranker: an error, a busy provider or the call's bound keeps fused
    order and logs a warning.
    """
    head = rows[:RERANK_CANDIDATES]
    spec = _rerank_spec() if len(head) > 1 else None
    if spec is None:
        return rows, False
    try:
        scores = await models.rerank(
            query, [row["indexed_text"] for row in head], spec=spec
        )
    except Exception:  # any failure keeps the fused order
        log.warning("rerank failed; keeping fused order", exc_info=True)
        return rows, False
    order = sorted(range(len(head)), key=lambda index: -scores[index])
    return [head[index] for index in order] + rows[RERANK_CANDIDATES:], True


def _cap_per_file(passages: list[Passage], cap: int) -> list[Passage]:
    """Limit each file's share of the result set, preserving fused order.

    Without this, a query whose terms recur throughout one long textbook returns
    that textbook five times and the other sources that actually answer the
    question never make the context window.
    """
    seen: dict[str, int] = {}
    kept: list[Passage] = []
    overflow: list[Passage] = []
    for passage in passages:
        count = seen.get(passage.file_id, 0)
        if count < cap:
            seen[passage.file_id] = count + 1
            kept.append(passage)
        else:
            overflow.append(passage)
    # Overflow is appended rather than dropped: in a single-file workspace the
    # cap would otherwise throw away every result but the first few.
    return kept + overflow
