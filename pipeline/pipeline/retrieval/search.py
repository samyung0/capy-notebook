"""Hybrid search over the chunk store.

The pipeline is: embed the query, run vector and lexical search in one SQL
statement, fuse by reciprocal rank, cap how much any single file may contribute,
expand each survivor with its neighbours, and return passages carrying enough
provenance to cite. A reranker slots in at :func:`_rerank` — see the note there
for why V1 ships without one.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from .. import registry
from ..config import cfg
from . import models, store
from .chunking import search_query_terms

log = logging.getLogger("evo.retrieval.search")


@dataclass
class Passage:
    chunk_id: str
    file_id: str
    file_name: str
    chunk_idx: int
    section_path: str
    text: str
    # The matched chunk on its own. text may grow to include neighbours, but a
    # citation should point at what actually matched.
    hit_text: str = ""
    page_start: int | None = None
    page_end: int | None = None
    regions: list[dict[str, Any]] = field(default_factory=list)
    score: float = 0.0

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> Passage:
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


async def search(
    *,
    workspace_id: str,
    query: str,
    file_ids: list[str] | None = None,
    top_k: int | None = None,
    expand: bool = True,
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
        registry.Surface.EMBEDDING,
    )
    vectors = await models.embed([models.format_query(query, spec)], spec=spec)
    if not vectors:
        return []
    rows = await store.hybrid_search(
        workspace_id=workspace_id,
        vector=vectors[0],
        terms=search_query_terms(query),
        file_ids=file_ids,
        candidates=cfg.search_candidates,
    )
    passages = [Passage.from_row(row) for row in rows]
    passages = await _rerank(query, passages)
    passages = _cap_per_file(passages, cfg.search_per_file_cap)[:top_k]
    if expand:
        passages = await _expand_neighbours(passages)
    return passages


async def _rerank(query: str, passages: list[Passage]) -> list[Passage]:
    """Reranking seam. Currently identity.

    A cross-encoder is the single highest-value addition to this file, and it is
    deliberately not here yet: it needs either a hosted rerank API (a new vendor
    and per-query cost) or a local model (a GPU in the retrieval container).
    Contextual prefixes, the per-file cap and neighbour expansion recover a large
    share of the same benefit for free, so the ordering below stays RRF until
    retrieval quality is measured against real workspaces.
    """
    return passages


def _cap_per_file(passages: list[Passage], cap: int) -> list[Passage]:
    """Limit each file's share of the result set, preserving fused order.

    Without this, a query whose terms recur throughout one long textbook returns
    that textbook eight times and the four other sources that actually answer
    the question never make the context window.
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


async def _expand_neighbours(passages: list[Passage]) -> list[Passage]:
    """Attach adjacent chunks to each hit, merging overlaps.

    Chunk boundaries are a packing artifact, so a hit that starts mid-argument
    reads as a fragment. Neighbours are merged into the hit's text rather than
    returned as separate passages, which keeps the citation count honest.
    """
    out: list[Passage] = []
    for passage in passages:
        try:
            rows = await store.neighbor_chunks(
                file_id=passage.file_id, chunk_idx=passage.chunk_idx
            )
        except Exception:
            log.warning("neighbour expansion failed", exc_info=True)
            out.append(passage)
            continue
        if len(rows) <= 1:
            out.append(passage)
            continue
        # Pages stay those of the hit: the citation should send the reader to
        # where the answer is, not to the start of the surrounding context.
        passage.text = "\n\n".join(row["text"] for row in rows)
        out.append(passage)
    return out
