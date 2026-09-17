"""Source-backed heading metadata: footers, chapter tabs, running headers and
clipped inline labels lose or gain ``text_level`` only with source evidence."""

from __future__ import annotations

import copy
import json
import re
import unicodedata
from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path

import pymupdf

from .order import normal, repair_page


def _literal(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).casefold().split())


def _outline_title(text: str) -> str:
    return _literal(
        re.sub(r"^(?:chapter\s+)?\d+(?:\.\d+)*[.\s]+", "", text, flags=re.IGNORECASE)
    )


def correct_roles(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Keep literal source text while correcting supported non-section roles.

    Running banners require repeated geometry/style and a stable folio offset.
    Captions and widely separated diagram labels remain body text. Ambiguous
    source boxes and headings present in the PDF outline retain their old role.
    """
    outline = {
        (page - 1, _outline_title(text))
        for _, text, page in document.get_toc()
        if page > 0
    }
    pages: dict[int, list[dict]] = {}
    banners: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
    roles: dict[int, str] = {}
    for index, block in enumerate(blocks):
        box, page_index = block.get("bbox", []), block.get("page_idx")
        if (
            block.get("type") != "text"
            or not block.get("text_level")
            or len(box) != 4
            or type(page_index) is not int
            or not 0 <= page_index < len(document)
            or (page_index, _outline_title(block.get("text", ""))) in outline
        ):
            continue
        page = document[page_index]
        if page.rotation:
            continue
        if page_index not in pages:
            pages[page_index] = [
                span
                for group in page.get_text(
                    "dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
                )["blocks"]
                for line in group.get("lines", [])
                if abs(line["dir"][0] - 1) < 0.01
                for span in line["spans"]
                if span["text"].strip()
            ]
        rect = pymupdf.Rect(
            box[0] * page.rect.width / 1000,
            box[1] * page.rect.height / 1000,
            box[2] * page.rect.width / 1000,
            box[3] * page.rect.height / 1000,
        )
        spans = [
            s
            for s in pages[page_index]
            if rect.contains(
                pymupdf.Point(
                    (s["bbox"][0] + s["bbox"][2]) / 2,
                    (s["bbox"][1] + s["bbox"][3]) / 2,
                )
            )
        ]
        text = block.get("text", "")
        if not spans or _literal(text) != _literal(" ".join(s["text"] for s in spans)):
            continue
        margin = 0 <= box[1] < box[3] <= 65 or 935 <= box[1] < box[3] <= 1000
        if margin:
            value = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
            leading = re.fullmatch(r"(\d{1,4})\s+(.+)", value)
            trailing = re.fullmatch(r"(.+?)\s+(\d{1,4})", value)
            title, folio = (
                (leading[2], leading[1])
                if leading
                else ((trailing[1], trailing[2]) if trailing else ("", ""))
            )
            if any(c.isalpha() for c in title):
                style = max(spans, key=lambda s: len(s["text"]))
                key = (
                    title,
                    int(folio) - page_index,
                    box[3] <= 65,
                    round(box[1] / 10),
                    style["font"],
                    round(style["size"]),
                )
                banners[key].append((index, page_index))
            continue
        if re.match(
            r"^(?:figure|fig\.|table)\s+\d+(?:[.\-]\d+)*(?:[.:\s])", text.casefold()
        ):
            roles[index] = "numbered-caption"
            continue
        if (
            len(spans) < 2
            or re.match(
                r"^\s*(?:\d+[.)\s]|[IVXLCDMivxlcdm]+[.)]?\s|[A-Za-z][.)]\s"
                r"|\((?:\d+|[IVXLCDMivxlcdm]+|[A-Za-z])\)\s)",
                text,
            )
            or any(s["flags"] & 16 for s in spans)
        ):
            continue
        size = max(s["size"] for s in spans)
        if (
            max(s["origin"][1] for s in spans) - min(s["origin"][1] for s in spans)
            > 0.3 * size
        ):
            continue
        ordered = sorted(spans, key=lambda s: s["bbox"][0])
        if any(b["bbox"][0] - a["bbox"][2] >= 4 * size for a, b in pairwise(ordered)):
            roles[index] = "diagram-label"
    for group in banners.values():
        if len({page for _, page in group}) >= 3:
            roles.update((index, "running-banner") for index, _ in group)
    result = list(blocks)
    for index, role in roles.items():
        result[index] = {**blocks[index], "_source_role": role}
        result[index].pop("text_level", None)
        if role == "running-banner":
            result[index]["type"] = "discarded"
    return result


def source_headings(blocks: list[dict], pdf: Path) -> dict[int, dict]:
    evidence: dict[int, dict] = {}
    with pymupdf.open(pdf) as document:
        page_lines: dict[int, list] = {}
        for index, block in enumerate(blocks):
            if block.get("type") != "text" or len(block.get("bbox", [])) != 4:
                continue
            box = block["bbox"]
            if not block.get("text_level") and not (box[0] > 950 or box[2] < 50):
                continue
            page_index = block["page_idx"]
            page = document[page_index]
            if page.rotation:
                continue
            if page_index not in page_lines:
                page_lines[page_index] = [
                    line
                    for group in page.get_text(
                        "dict",
                        flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES,
                    )["blocks"]
                    for line in group.get("lines", [])
                ]
            rect = pymupdf.Rect(
                box[0] * page.rect.width / 1000,
                box[1] * page.rect.height / 1000,
                box[2] * page.rect.width / 1000,
                box[3] * page.rect.height / 1000,
            )
            matched = [
                (span, line)
                for line in page_lines[page_index]
                for span in line["spans"]
                # Empty spans retain the existing zero-area matching behavior.
                if not (
                    span["bbox"][0] < span["bbox"][2]
                    and span["bbox"][1] < span["bbox"][3]
                    and (
                        span["bbox"][2] <= rect.x0
                        or span["bbox"][0] >= rect.x1
                        or span["bbox"][3] <= rect.y0
                        or span["bbox"][1] >= rect.y1
                    )
                )
                if (pymupdf.Rect(span["bbox"]) & rect).get_area()
                >= pymupdf.Rect(span["bbox"]).get_area() * 0.6
            ]
            source_text = " ".join(span["text"] for span, _ in matched)
            if normal(source_text) != normal(block.get("text", "")):
                continue
            letters = [(s, line) for s, line in matched if normal(s["text"])]
            if not letters:
                continue
            style = max(letters, key=lambda item: len(normal(item[0]["text"])))[0]
            footer = re.fullmatch(r"[\s|–—-]*(\d{1,4})[\s|–—-]*", block["text"])
            footer_key = None
            if footer and box[1] > 900:
                footer_key = (
                    int(footer[1]) - page_index,
                    round((box[0] + box[2]) / 50),
                    round((box[1] + box[3]) / 20),
                    style["font"],
                    round(style["size"]),
                )
            tab_key = None
            if (
                (box[0] > 950 or box[2] < 50)
                and all(abs(line["dir"][0]) < 0.1 for _, line in letters)
                and all(s["flags"] & 16 and s["color"] == 0xFFFFFF for s, _ in letters)
            ):
                tab_key = (normal(block["text"]), style["font"], round(style["size"]))
            running_key = None
            if (
                box[3] < 100
                and len(normal(block["text"])) >= 5
                and any(c.isalpha() for c in block["text"])
                and all(
                    line["dir"][0] > 0.99 and s["flags"] & 16 for s, line in letters
                )
            ):
                running_key = (
                    normal(block["text"]),
                    style["font"],
                    round(style["size"]),
                    round(box[1] / 10),
                )
            clipped_prefix = False
            if all(line["dir"][0] > 0.99 for _, line in letters):
                bottom = max(s["bbox"][3] for s, _ in letters)
                following = [
                    line
                    for line in page_lines[page_index]
                    if line["dir"][0] > 0.99
                    and 0 <= line["bbox"][1] - bottom <= style["size"] * 0.3
                    and abs(line["bbox"][0] - rect.x0) <= style["size"]
                ]
                for line in following:
                    spans = [s for s in line["spans"] if normal(s["text"])]
                    if len(spans) < 2:
                        continue
                    first = spans[0]
                    if (
                        first["font"] == style["font"]
                        and abs(first["size"] - style["size"]) < 0.2
                        and first["color"] == style["color"]
                        and first["text"].rstrip().endswith(":")
                        and any(s["font"] != style["font"] for s in spans[1:])
                    ):
                        clipped_prefix = True
            evidence[index] = {
                "page": page_index,
                "source_text": source_text,
                "bbox": box,
                "native_heading": bool(block.get("text_level")),
                "font": style["font"],
                "size": style["size"],
                "color": style["color"],
                "footer_key": footer_key,
                "tab_key": tab_key,
                "running_key": running_key,
                "clipped_prefix": clipped_prefix,
            }
    return evidence


def rewrite(blocks: list[dict], evidence: dict[int, dict]) -> list[dict]:
    """The lab's ``structure`` arm: every rule on, tabs and columns reordered."""
    result = copy.deepcopy(blocks)
    footer_pages, tab_pages, running_pages = (
        defaultdict(set),
        defaultdict(set),
        defaultdict(set),
    )
    for item in evidence.values():
        if item["footer_key"]:
            footer_pages[tuple(item["footer_key"])].add(item["page"])
        if item["tab_key"]:
            tab_pages[tuple(item["tab_key"][1:])].add(item["page"])
        if item.get("running_key"):
            running_pages[tuple(item["running_key"])].add(item["page"])
    tab_indices: set[int] = set()
    previous_tab = None
    for index, item in evidence.items():
        block = result[index]
        if item["footer_key"] and len(footer_pages[tuple(item["footer_key"])]) >= 3:
            block.pop("text_level", None)
        if item["tab_key"] and len(tab_pages[tuple(item["tab_key"][1:])]) >= 3:
            tab_indices.add(index)
            if item["tab_key"][0] == previous_tab:
                block.pop("text_level", None)
            else:
                block["text_level"] = 1
            previous_tab = item["tab_key"][0]
        if item["clipped_prefix"]:
            block.pop("text_level", None)
        running = item.get("running_key")
        if running and len(running_pages[tuple(running)]) >= 2:
            earlier_title = any(
                other.get("native_heading")
                and other["page"] < item["page"]
                and normal(other["source_text"]) == normal(item["source_text"])
                and (other["font"] != item["font"] or other["bbox"][1] >= 100)
                for other in evidence.values()
            )
            if earlier_title:
                block.pop("text_level", None)
    for page in sorted({b["page_idx"] for b in result}):
        slots = [i for i, b in enumerate(result) if b["page_idx"] == page]
        reordered = [result[i] for i in slots]
        # Reuse the empty-gutter check, letting column headings travel with
        # their column rather than keeping both above its prose.
        shadow = [
            {**b, "text_level": None, "_slot": i} for i, b in enumerate(reordered)
        ]
        sorted_shadow, reason = repair_page(shadow)
        if reason == "reordered":
            reordered = [reordered[b["_slot"]] for b in sorted_shadow]
        if any(i in tab_indices for i in slots):
            tabs = [result[i] for i in slots if i in tab_indices]
            ids = {id(b) for b in tabs}
            reordered = tabs + [b for b in reordered if id(b) not in ids]
        for i, block in zip(slots, reordered):
            result[i] = block

    def without_level(block):
        return json.dumps(
            {k: v for k, v in block.items() if k != "text_level"}, sort_keys=True
        )

    assert Counter(map(without_level, result)) == Counter(map(without_level, blocks))
    return result
