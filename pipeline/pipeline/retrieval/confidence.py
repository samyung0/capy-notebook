"""Per-chunk extraction confidence from the source PDF's text layer (its page
texts come from the parser's Office evidence or the ingest decode helper).

Computed once per file at ingest and stored on ``rag_chunks``; passage headers
show the score and reasons below ``CAPY_CONFIDENCE_NOTE_BELOW`` so the chat
agent has a reason to call ``capture_page``. Ported from the playground's
``chunk_quality.py``.

What it cannot see: reading-order or cell-association errors when every word
is present. A page the VLM read has no text layer to agree with; it scores
1.0 (developer decision 2026-10-15) and carries no reason.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter

from .chunking import Chunk

# The ``_recovery`` mark of a block the ingest worker's VLM read.
VLM_RECOVERY = "vlm-page"
VLM_SCORE = 1.0
TEXT_LAYER_CHARS = 40

_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
_ROW = re.compile(r"^\s*\|?.*\|.*$")


def tokens(text: str) -> list[str]:
    """Words for spaced scripts and single characters for CJK runs, so a mixed
    page and a chunk in either script tokenize the same way."""
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"\[figure\]|\[table\]", " ", text)
    text = _CJK.sub(lambda m: f" {m.group(0)} ", text)
    return re.sub(r"[^\w]+", " ", text).split()


def recall(chunk: list[str], source: Counter) -> float:
    if not chunk:
        return 1.0
    counts = Counter(chunk)
    return sum(min(n, source[t]) for t, n in counts.items()) / len(chunk)


def table_consistency(text: str) -> float | None:
    rows = [
        line for line in text.splitlines() if _ROW.match(line) and line.count("|") >= 1
    ]
    if len(rows) < 2:
        return None
    widths = Counter(line.count("|") for line in rows)
    return widths.most_common(1)[0][1] / len(rows)


def score_chunk(
    text: str, page_texts: list[str], coverage: float | None, *, vlm_page: bool = False
) -> tuple[float, list[str]]:
    if vlm_page:
        return VLM_SCORE, []
    reasons: list[str] = []
    text_layer = any(len(p.strip()) >= TEXT_LAYER_CHARS for p in page_texts)
    if not text_layer:
        score = 0.35
        reasons.append("scanned page with no text layer")
    else:
        source = Counter(t for p in page_texts for t in tokens(p))
        score = recall(tokens(text), source)
        if score < 0.85:
            reasons.append(
                f"chunk text differs from the source text layer (match {score:.2f})"
            )
    consistency = table_consistency(text)
    if consistency is not None:
        score *= 0.5 + 0.5 * consistency
        if consistency < 0.8:
            reasons.append("table rows have uneven column counts")
    if coverage is not None and coverage < 0.7:
        reasons.append(
            f"part of this page's source text is missing from the index (coverage {coverage:.2f})"
        )
        score = min(score, 0.7 + 0.3 * coverage)
    return round(score, 3), reasons


def vlm_pages(content_list: list[dict]) -> set[int]:
    """1-based pages whose text the ingest worker's VLM read."""
    return {
        int(block["page_idx"]) + 1
        for block in content_list
        if isinstance(block, dict)
        and block.get("_recovery") == VLM_RECOVERY
        and isinstance(block.get("page_idx"), int)
    }


def _span(chunk: Chunk) -> range:
    assert chunk.page_start is not None
    return range(chunk.page_start, (chunk.page_end or chunk.page_start) + 1)


def score_chunks(
    chunks: list[Chunk], *, page_texts: list[str], vlm: set[int] = frozenset()
) -> None:
    """Fill ``confidence`` and ``confidence_reasons`` on every paged chunk in place."""
    paged = [c for c in chunks if c.page_start]
    have: dict[int, Counter] = {}
    for chunk in paged:
        for p in _span(chunk):
            have.setdefault(p, Counter()).update(tokens(chunk.text))
    coverage: dict[int, float] = {}
    for p, seen in have.items():
        if 1 <= p <= len(page_texts):
            source = tokens(page_texts[p - 1])
            coverage[p] = recall(source, seen) if source else 1.0
    for chunk in paged:
        span = [p for p in _span(chunk) if 1 <= p <= len(page_texts)]
        covs = [coverage[p] for p in span if p in coverage]
        chunk.confidence, chunk.confidence_reasons = score_chunk(
            chunk.text,
            [page_texts[p - 1] for p in span],
            min(covs) if covs else None,
            vlm_page=any(p in vlm for p in span),
        )
