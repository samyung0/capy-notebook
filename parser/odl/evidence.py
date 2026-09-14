"""Compact source evidence needed after an Office conversion is discarded."""

from __future__ import annotations

import re
import unicodedata

import pymupdf


def _canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\xad", "")
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\n\s*(?=[a-zäöüß])", "", text)
    return "".join(text.split())


def _inside(box, area: pymupdf.Rect) -> bool:
    return area.contains(pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2))


def _disjoint(box, area: pymupdf.Rect) -> bool:
    return box[0] > area.x1 or box[2] < area.x0 or box[1] > area.y1 or box[3] < area.y0


def page_evidence(data: bytes, blocks: list[dict]) -> dict:
    """Freeze page text and visible-heading proofs, independent of chunk packing.

    These are the exact text/visibility checks used by retrieval/headings.py.
    Keeping their result lets cached Office ingestion run without a PDF.
    """
    headings = []
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        texts = [p.get_text() for p in doc]
        pages = {}
        for index, block in enumerate(blocks):
            text, box, number = (
                block.get("text", ""),
                block.get("bbox", []),
                block.get("page_idx"),
            )
            if (
                not block.get("text_level")
                or len(box) != 4
                or not any(c.isalpha() for c in text)
            ):
                continue
            if not isinstance(number, int) or not 0 <= number < len(doc):
                continue
            page = doc[number]
            if page.rotation:
                continue
            if number not in pages:
                pages[number] = (
                    page.get_text(
                        "rawdict",
                        flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES,
                    )["blocks"],
                    page.get_texttrace(),
                )
            groups, traces = pages[number]
            area = pymupdf.Rect(
                box[0] * page.rect.width / 1000,
                box[1] * page.rect.height / 1000,
                box[2] * page.rect.width / 1000,
                box[3] * page.rect.height / 1000,
            )
            source = "\n".join(
                "".join(
                    char["c"]
                    for span in line["spans"]
                    if not _disjoint(span["bbox"], area)
                    for char in span["chars"]
                    if _inside(char["bbox"], area)
                )
                for group in groups
                if not _disjoint(group["bbox"], area)
                for line in group.get("lines", [])
                if abs(line["dir"][0] - 1) < 0.01 and abs(line["dir"][1]) < 0.01
            )
            if _canonical(source) != _canonical(text):
                continue
            visible = sum(
                1
                for span in traces
                if span["opacity"] >= 0.99
                and span["type"] != 3
                and span["dir"][0] > 0.99
                for char in span["chars"]
                if chr(char[0]).isalpha() and _inside(char[3], area)
            )
            if visible >= sum(c.isalpha() for c in text):
                headings.append(index)
    return {"page_texts": texts, "visible_headings": headings}
