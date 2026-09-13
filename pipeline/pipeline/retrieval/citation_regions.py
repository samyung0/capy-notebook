"""Refine final citation regions using a unique text-layer match.

Chunk packing can split one parser block while retaining its enclosing box.
Resolve the complete cited chunk inside those regions; an absent or ambiguous
match retains the parser geometry. This does not change indexed evidence.
"""

from __future__ import annotations

import asyncio
import logging
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import capture
from .search import Passage

log = logging.getLogger("capy.retrieval.citation_regions")
SPACE = "page-1000-topleft"


def _normalize(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text) if not c.isspace())


def resolve(pdf: Path, passages: list[Passage]) -> list[list[dict[str, Any]]]:
    """Return tighter boxes only when every character has one scoped match."""
    import pymupdf

    resolved: list[list[dict[str, Any]]] = []
    with pymupdf.open(pdf) as doc:
        pages: dict[int, list[tuple[str, list[float]]]] = {}
        for passage in passages:
            regions = passage.regions
            scoped: dict[int, list[list[float]]] = defaultdict(list)
            for region in regions:
                if region.get("space") != SPACE:
                    break
                page, box = region.get("page"), region.get("bbox")
                if not isinstance(page, int) or not 1 <= page <= len(doc):
                    break
                if not isinstance(box, list) or len(box) != 4:
                    break
                scoped[page].append(box)
            else:
                characters: list[str] = []
                locations: list[tuple[int, list[float]]] = []
                for number, boxes in sorted(scoped.items()):
                    if number not in pages:
                        page = doc[number - 1]
                        rect = page.rect
                        glyphs = []
                        for block in page.get_text(
                            "rawdict",
                            sort=True,
                            flags=pymupdf.TEXTFLAGS_RAWDICT
                            & ~pymupdf.TEXT_PRESERVE_IMAGES,
                        )["blocks"]:
                            for line in block.get("lines", []):
                                for span in line["spans"]:
                                    for char in span["chars"]:
                                        box = (
                                            pymupdf.Rect(char["bbox"])
                                            * page.rotation_matrix
                                        )
                                        normalized = [
                                            (box.x0 - rect.x0) / rect.width * 1000,
                                            (box.y0 - rect.y0) / rect.height * 1000,
                                            (box.x1 - rect.x0) / rect.width * 1000,
                                            (box.y1 - rect.y0) / rect.height * 1000,
                                        ]
                                        glyphs.append((char["c"], normalized))
                        pages[number] = glyphs
                    for char, box in pages[number]:
                        x, y = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                        if any(b[0] <= x <= b[2] and b[1] <= y <= b[3] for b in boxes):
                            normalized = _normalize(char)
                            characters.extend(normalized)
                            locations.extend([(number, box)] * len(normalized))
                text, needle = (
                    "".join(characters),
                    _normalize(passage.hit_text or passage.text),
                )
                start = text.find(needle) if needle else -1
                if start >= 0 and text.find(needle, start + 1) < 0:
                    matched: dict[int, list[float]] = {}
                    for number, box in locations[start : start + len(needle)]:
                        if number not in matched:
                            matched[number] = list(box)
                        else:
                            old = matched[number]
                            matched[number] = [
                                min(old[0], box[0]),
                                min(old[1], box[1]),
                                max(old[2], box[2]),
                                max(old[3], box[3]),
                            ]
                    regions = [
                        {
                            "page": n,
                            "bbox": [max(0, min(1000, v)) for v in b],
                            "space": SPACE,
                        }
                        for n, b in matched.items()
                    ]
            resolved.append(regions)
    return resolved


async def refine(workspace_id: str, passages: list[Passage]) -> list[dict[str, Any]]:
    """Read each cited PDF once; inaccessible/non-native sources keep their boxes."""
    citations = [p.as_citation() for p in passages]
    files: dict[str, list[int]] = defaultdict(list)
    for index, passage in enumerate(passages):
        if passage.regions:
            files[passage.file_id].append(index)
    for file_id, indices in files.items():
        try:
            path = await capture.pdf_path(workspace_id, file_id)
            boxes = await asyncio.to_thread(
                resolve, path, [passages[i] for i in indices]
            )
        except Exception:
            # Citation refinement must not discard an otherwise valid answer.
            log.warning(
                "citation text-layer refinement unavailable for %s",
                file_id,
                exc_info=True,
            )
            continue
        for index, regions in zip(indices, boxes, strict=True):
            citations[index]["regions"] = regions[:12]
    return citations
