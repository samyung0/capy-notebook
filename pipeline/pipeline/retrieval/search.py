"""Hybrid search over the chunk store.

The pipeline is: embed the query, run vector and lexical search in one SQL
statement, fuse by reciprocal rank, cap how much any single file may contribute,
and return the hit passages. A reranker slots in at :func:`_rerank` — see the
note there for why V1 ships without one.
"""

from __future__ import annotations

import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from .. import registry
from ..config import cfg
from . import models, store
from .chunking import search_query_terms
from .lang import UND


@dataclass
class Passage:
    chunk_id: str
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

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Passage:
        dist = row.get("vec_dist")
        return cls(
            chunk_id=row["id"],
            file_id=row["file_id"],
            file_name=row["file_name"],
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
        return " › ".join(parts)

    def as_context(self, index: int) -> str:
        return f"[{index}] {self.location()}\n{self.text}"

    def as_citation(self) -> dict[str, Any]:
        citation: dict[str, Any] = {
            "fileId": self.file_id,
            "chunkId": self.chunk_id,
            "fileName": self.file_name,
            "snippet": (self.hit_text or self.text)[:400],
        }
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
    passages = [Passage.from_row(row) for row in rows]
    passages = await _rerank(query, passages)
    top = _cap_per_file(passages, cfg.search_per_file_cap)[:top_k]
    _mark_tier_only(top, rows, top_k)
    if stats is not None:
        langs = Counter(p.lang for p in top)
        stats.hits_lang = langs.most_common(1)[0][0] if langs else UND
        stats.query_terms = terms.terms
        stats.cjk_runs = terms.cjk_runs
        stats.embed_ms = int((embedded - started) * 1000)
        stats.sql_ms = int((time.monotonic() - embedded) * 1000)
    return top


def _mark_tier_only(top: list[Passage], rows: list[dict[str, Any]], top_k: int) -> None:
    """Flag hits that the exact tier alone put in the returned set.

    ``flat_score`` is the fusion with every lexical row at half weight. Ranking
    the candidates by it, with the same per-file cap, gives the set the caller
    would have seen without the tier; anything in ``top`` but not in that set
    owes its place to the tier. This is the counterfactual the telemetry
    needs to judge whether the tier surfaces answers or noise.
    """
    if not any(row["score"] != row["flat_score"] for row in rows):
        return
    flat = sorted(rows, key=lambda row: row["flat_score"], reverse=True)
    flat_top = _cap_per_file(
        [Passage.from_row(row) for row in flat], cfg.search_per_file_cap
    )
    without_tier = {p.chunk_id for p in flat_top[:top_k]}
    for passage in top:
        passage.tier_only = passage.chunk_id not in without_tier


async def _rerank(query: str, passages: list[Passage]) -> list[Passage]:
    """Reranking seam. Currently identity.

    A cross-encoder is the single highest-value addition to this file, and it is
    deliberately not here yet: it needs either a hosted rerank API (a new vendor
    and per-query cost) or a local model (a GPU in the retrieval container).
    Heading prefixes and the per-file cap recover a large share of the same
    benefit for free, so the ordering below stays RRF until retrieval quality is
    measured against real workspaces.
    """
    return passages


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
