"""Image blocks that are not figures, judged before image files enter the bundle.

veraPDF makes an image chunk of every placed image and ODL writes them all, so
rules and badges arrive as images
(bench/parsers/reports/2026-09-23-odl-thin-images-and-accuracy.md).

- Sliver: a side under 1 pt, or the short side under 1% of the long side (ODL's
  own "subtle" test). dvips rules drawn as 1x1 stencil masks, spacer pixels;
  dropped.
- Repeat: the same rendered picture on REPEAT_PAGES or more pages (licence
  badges, logos, icons, chapter bars). Kept as ``discarded`` page furniture.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import Path

import pymupdf

REPEAT_PAGES = 5
MIN_SIDE_PT = 1.0
SUBTLE_ASPECT = 0.01


def classify(
    blocks: list[dict], document: pymupdf.Document, native_dir: Path
) -> list[dict]:
    images = {
        index
        for index, block in enumerate(blocks)
        if block.get("type") == "image" and len(block.get("bbox") or []) == 4
    }
    digests: dict[int, str] = {}
    pages: dict[str, set[int]] = defaultdict(set)
    for index in images:
        path = native_dir / str(blocks[index].get("img_path") or "")
        if path.is_file():
            digests[index] = hashlib.sha1(path.read_bytes()).hexdigest()
            pages[digests[index]].add(blocks[index]["page_idx"])
    out: list[dict] = []
    for index, block in enumerate(blocks):
        if index not in images:
            out.append(block)
            continue
        x0, y0, x1, y1 = block["bbox"]
        page = document[block["page_idx"]].rect
        short, long = sorted(
            ((x1 - x0) * page.width / 1000, (y1 - y0) * page.height / 1000)
        )
        if short < MIN_SIDE_PT or short < SUBTLE_ASPECT * long:
            continue
        if index in digests and len(pages[digests[index]]) >= REPEAT_PAGES:
            block = {**block, "type": "discarded"}
        out.append(block)
    return out
