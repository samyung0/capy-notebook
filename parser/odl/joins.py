"""Line joins ODL got wrong inside a block.

ODL joins a block's lines with a space and drops a line-end hyphen. Both are
wrong in two cases, decided against the page's source lines so that a gap or
hyphen printed inside a line is never touched:

- CJK: a line that runs to the block's right edge (it wrapped) ending in Han,
  kana or full-width text, and the next starting in it, are joined without the
  space ("地域住民にとって身近な", not "にとって 身近な"). A line ending short is a
  deliberate break (a list of names) and keeps it. Hangul is not included:
  Korean separates words with spaces.
- Hyphens: a line ending in "word-" whose hyphen ODL dropped gets it back when
  the document prints the hyphenated form elsewhere more often than the joined
  one; with no such evidence, when the next line starts with a digit or a
  capital ("mid-1950s", "Banach-Tarski") or the word is part of an address
  ("merriam-webster.com"), unless the first part is camel case (code:
  "forceNewFile-" "Named:do:"). Other line-end hyphens are syllable breaks and
  stay joined.
"""

from __future__ import annotations

import re
from collections import Counter
from itertools import pairwise

import pymupdf

from . import page_text

_CJK = re.compile(r"[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]")
_BREAK = re.compile(r"([^\W\d_]+)-$")
_FIRST = re.compile(r"^(\w+)")
_ADDRESS = re.compile(r"(?:www\.|https?://|@)\S*$")


def _page_lines(page: pymupdf.Page) -> tuple[list, list[int]]:
    """Horizontal source lines (box, centre, font size, text) in MuPDF's order,
    and the indexes of those a join could follow: ending in CJK or "word-"."""
    lines = []
    for group in page_text.page_dict(page)["blocks"]:
        for line in group.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01:
                continue
            text = "".join(s["text"] for s in line["spans"]).strip()
            if text:
                box = pymupdf.Rect(line["bbox"])
                size = max(span["size"] for span in line["spans"])
                lines.append(
                    (box, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, size, text)
                )
    ends = [
        i
        for i, line in enumerate(lines)
        if _CJK.match(line[4][-1]) or _BREAK.search(line[4])
    ]
    return lines, ends


def _texts(block: dict) -> list[str]:
    if block.get("type") == "list":
        return [str(item) for item in block.get("list_items") or []]
    return [str(block["text"])] if isinstance(block.get("text"), str) else []


def repair_joins(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    words: Counter | None = None  # the document's words, counted on first need
    out = []
    current: tuple[int, list, list[int]] = (-1, [], [])  # the current page only
    for block in blocks:
        texts = _texts(block)
        page_index = block.get("page_idx")
        if (
            block.get("type") not in ("text", "list")
            or not texts
            or len(block.get("bbox") or []) != 4
            or type(page_index) is not int
            or not 0 <= page_index < len(document)
            or document[page_index].rotation
        ):
            out.append(block)
            continue
        page = document[page_index]
        if current[0] != page_index:
            current = (page_index, *_page_lines(page))
        _, lines, ends = current
        w, h = page.rect.width / 1000, page.rect.height / 1000
        x0, y0, x1, y1 = (v * s for v, s in zip(block["bbox"], (w, h, w, h)))

        def inside(line: tuple, x0=x0, y0=y0, x1=x1, y1=y1) -> bool:
            return x0 <= line[1] <= x1 and y0 <= line[2] <= y1

        if not any(inside(lines[i]) for i in ends):
            out.append(block)
            continue
        own = [line for line in lines if inside(line)]
        right = max(box.x1 for box, *_ in own)
        fixes: list[tuple[str, str]] = []
        for (box, _, _, size, first), (*_, second) in pairwise(own):
            if (
                _CJK.match(first[-1])
                and _CJK.match(second[0])
                and box.x1 >= right - 1.5 * size
            ):
                fixes.append((f"{first[-2:]} {second[:2]}", first[-2:] + second[:2]))
            head, tail = _BREAK.search(first), _FIRST.match(second)
            if head and tail:
                if words is None:
                    words = _words(blocks)
                if _keep_hyphen(head[1], tail[1], first, words):
                    fixes.append((head[1] + tail[1], f"{head[1]}-{tail[1]}"))
        if not fixes:
            out.append(block)
            continue
        fixed = [_apply(text, fixes) for text in texts]
        if fixed == texts:
            out.append(block)
        elif block["type"] == "list":
            out.append({**block, "list_items": fixed})
        else:
            out.append({**block, "text": fixed[0]})
    return out


def _words(blocks: list[dict]) -> Counter:
    return Counter(
        word.casefold()
        for block in blocks
        for text in _texts(block)
        for word in re.findall(r"[^\W_]+(?:-[^\W_]+)*", text)
    )


def _keep_hyphen(head: str, tail: str, line: str, words: Counter) -> bool:
    hyphenated = words[f"{head}-{tail}".casefold()]
    joined = words[(head + tail).casefold()] - 1  # less this break itself
    if hyphenated != joined:
        return hyphenated > joined
    if any(c.isupper() for c in head[1:]):
        return False
    return tail[0].isdigit() or tail[0].isupper() or bool(_ADDRESS.search(line))


def _apply(text: str, fixes: list[tuple[str, str]]) -> str:
    for wrong, right in fixes:
        # Whole-word for hyphens, so "re" + "port" never edits "reporter".
        if "-" in right:
            text = re.sub(rf"(?<!\w){re.escape(wrong)}(?!\w)", right, text, count=1)
        else:
            text = text.replace(wrong, right, 1)
    return text
