"""Restore scientific-notation exponents only from matching raised source glyphs.

Only a caret is inserted; all existing text, blocks and geometry are retained.
"""

from __future__ import annotations

import copy
import re
from pathlib import Path

import pymupdf

from .source_text import RAW_FLAGS, source_text

SCIENTIFIC = re.compile(r"(?<![\w.])([+−-]?\d+(?:\.\d+)?\s*[×·]\s*10)$")


def source_exponents(page: pymupdf.Page) -> list[dict]:
    result = []
    for group in page.get_text("rawdict", flags=RAW_FLAGS)["blocks"]:
        for line in group.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01 or abs(line["dir"][1]) > 0.01:
                continue
            prefix, spans = "", []
            for raw_span in line["spans"]:
                span = {**raw_span, "text": "".join(c["c"] for c in raw_span["chars"])}
                match = SCIENTIFIC.search(prefix)
                exponent = span["text"].strip()
                if span["flags"] & 1 and match and re.fullmatch(r"[+−-]?\d+", exponent):
                    selected = [span] + [s for end, s in spans if end > match.start()]
                    boxes = [s["bbox"] for s in selected]
                    result.append(
                        {
                            "base": match[1],
                            "exponent": exponent,
                            "bbox": [
                                min(b[0] for b in boxes),
                                min(b[1] for b in boxes),
                                max(b[2] for b in boxes),
                                max(b[3] for b in boxes),
                            ],
                            "glyph_centers": [
                                [
                                    (c["bbox"][0] + c["bbox"][2]) / 2,
                                    (c["bbox"][1] + c["bbox"][3]) / 2,
                                ]
                                for s in selected
                                for c in s["chars"]
                                if not c["c"].isspace()
                            ],
                        }
                    )
                prefix += span["text"]
                spans.append((len(prefix), span))
    return result


def slots(block: dict):
    for key in ["text", "table_body", "list_items"]:
        value = block.get(key)
        if isinstance(value, str):
            yield key, None, value
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, str):
                    yield key, i, item


def restore_exponents(blocks: list[dict], pdf: Path) -> tuple[list[dict], int]:
    revised = copy.deepcopy(blocks)
    restored = 0
    needed = {
        b["page_idx"]
        for b in blocks
        if any(re.search(r"[×·]\s*10\s*[+−\d-]", text) for _, _, text in slots(b))
        and len(b.get("bbox", [])) == 4
    }
    with pymupdf.open(pdf) as document:
        for page_index in sorted(needed):
            page = document[page_index]
            if page.rotation:
                continue
            groups = None
            for source in source_exponents(page):
                base = re.sub(r"\s+", "", source["base"])
                pattern = re.compile(
                    r"(?<![\w.])("
                    + r"\s*".join(map(re.escape, base))
                    + r")\s*("
                    + re.escape(source["exponent"])
                    + r")(?!\d)"
                )
                box = pymupdf.Rect(source["bbox"])
                matches = []
                for i, block in enumerate(revised):
                    if (
                        block.get("page_idx") != page_index
                        or len(block.get("bbox", [])) != 4
                    ):
                        continue
                    native_box = pymupdf.Rect(
                        block["bbox"][0] * page.rect.width / 1000,
                        block["bbox"][1] * page.rect.height / 1000,
                        block["bbox"][2] * page.rect.width / 1000,
                        block["bbox"][3] * page.rect.height / 1000,
                    )
                    # Symbol font boxes include descenders below the printed row.
                    if not native_box.contains(
                        pymupdf.Point((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)
                    ):
                        continue
                    if not all(
                        native_box.contains(pymupdf.Point(center))
                        for center in source["glyph_centers"]
                    ):
                        continue
                    marked = re.compile(
                        r"\s*".join(map(re.escape, base))
                        + r"\s*\^\s*\{?\s*"
                        + re.escape(source["exponent"])
                        + r"(?!\d)"
                    )
                    if any(marked.search(text) for _, _, text in slots(block)):
                        continue
                    if groups is None:
                        groups = page.get_text("rawdict", flags=RAW_FLAGS)["blocks"]
                    # A raised and an ordinary expression can flatten identically.
                    # Require unique source text too, including already-correct output.
                    if (
                        len(list(pattern.finditer(source_text(groups, native_box))))
                        != 1
                    ):
                        continue
                    for key, item, text in slots(block):
                        matches.extend(
                            (i, key, item, text, m) for m in pattern.finditer(text)
                        )
                if len(matches) != 1:
                    continue
                i, key, item, text, match = matches[0]
                position = match.start(2)
                value = text[:position] + "^" + text[position:]
                if item is None:
                    revised[i][key] = value
                else:
                    revised[i][key][item] = value
                restored += 1
    return revised, restored
