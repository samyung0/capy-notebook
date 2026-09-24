"""Source-backed heading metadata: footers, chapter tabs, running headers and
clipped inline labels lose or gain ``text_level`` only with source evidence.
Capitals headings (``promote_capitals``) are promoted from block geometry, and
outline headings (``insert_outline_headings``) are added from the PDF outline
where only a discarded running head prints the title."""

from __future__ import annotations

import copy
import json
import re
import statistics
import unicodedata
from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path

import pymupdf

from .furniture import _folio
from .order import normal, repair_page

BULLET = re.compile(r"^\s*[•●▪◦‣⁃∙·■□☐➢✓✔]")
SENTENCE_END = re.compile(r"[.!?][\"'”’)\]]*$")


def _main_style(spans: list[dict]) -> tuple[str, int] | None:
    """The font and rounded size carrying the most characters."""
    weight: Counter = Counter()
    for span in spans:
        weight[span["font"], round(span["size"])] += len(span["text"])
    return weight.most_common(1)[0][0] if weight else None


def _literal(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).casefold().split())


def _outline_title(text: str) -> str:
    return _literal(
        re.sub(r"^(?:chapter\s+)?\d+(?:\.\d+)*[.\s]+", "", text, flags=re.IGNORECASE)
    )


def _centred(span: tuple[float, float, float, float], rect: pymupdf.Rect) -> bool:
    return rect.contains(
        pymupdf.Point((span[0] + span[2]) / 2, (span[1] + span[3]) / 2)
    )


def _thin(span: tuple[float, float, float, float], rect: pymupdf.Rect) -> bool:
    """An ODL box can be shorter than its glyphs: the span's horizontal centre
    lies in the box and they overlap by half the smaller height."""
    overlap = min(span[3], rect.y1) - max(span[1], rect.y0)
    return rect.x0 <= (span[0] + span[2]) / 2 <= rect.x1 and overlap >= 0.5 * min(
        span[3] - span[1], rect.height
    )


def _source_spans(
    blocks: list[dict],
    document: pymupdf.Document,
    pages: dict[int, list[dict]] | None = None,
    band=None,
) -> dict[int, list[dict]]:
    """Literal native spans for unrotated, source-matched heading boxes and
    paragraphs in the margin ``band`` (running heads ODL typed as body text).
    ``pages`` collects each visited page's spans for the caller."""
    pages = {} if pages is None else pages
    band = band or _folio_band
    evidence: dict[int, list[dict]] = {}
    for index, block in enumerate(blocks):
        box, page_index = block.get("bbox", []), block.get("page_idx")
        if (
            block.get("type") != "text"
            or len(box) != 4
            or not (block.get("text_level") or band(box))
            or type(page_index) is not int
            or not 0 <= page_index < len(document)
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
        text = block.get("text", "")
        # The thin-box test runs only when centre containment finds no match,
        # so it never replaces evidence the centre test already proves.
        for inside in (_centred, _thin):
            spans = [s for s in pages[page_index] if inside(s["bbox"], rect)]
            if spans and _literal(text) == _literal(" ".join(s["text"] for s in spans)):
                evidence[index] = spans
                break
    return evidence


def _outline_match(
    blocks: list[dict], document: pymupdf.Document, evidence: dict[int, list[dict]], row
) -> int | None:
    _, title, page, destination = row
    if not 1 <= page <= len(document):
        return None
    choices = []
    for index in evidence:
        block = blocks[index]
        if block.get("type") != "text" or block["page_idx"] != page - 1:
            continue
        texts = [block["text"]]
        # A literal appendix title may occupy two adjacent heading blocks.
        if (
            index + 1 in evidence
            and blocks[index + 1].get("type") == "text"
            and blocks[index + 1]["page_idx"] == page - 1
        ):
            texts.append(block["text"] + " " + blocks[index + 1]["text"])
        if any(_outline_title(text) == _outline_title(title) for text in texts):
            choices.append(
                (index, any(_literal(text) == _literal(title) for text in texts))
            )
    if any(exact for _, exact in choices):
        choices = [(index, exact) for index, exact in choices if exact]
    if (
        len(choices) > 1
        and destination.get("kind") == pymupdf.LINK_GOTO
        and "to" in destination
        and "nameddest" not in destination
    ):
        y = destination["to"].y / document[page - 1].rect.height * 1000
        choices = [
            item for item in choices if abs(blocks[item[0]]["bbox"][1] - y) <= 65
        ]
    return choices[0][0] if len(choices) == 1 else None


def correct_outline_roots(
    blocks: list[dict], document: pymupdf.Document, evidence: dict[int, list[dict]]
) -> list[dict]:
    """Require complete literal roots and proof across existing scope boundaries."""
    toc = document.get_toc(simple=False)
    matches = [_outline_match(blocks, document, evidence, row) for row in toc]
    counts = Counter(matches)
    roots: list[int] = []
    children: dict[int, set[int]] = {}
    for row, match in zip(toc, matches, strict=True):
        if row[0] == 1:
            if match is None or match in roots:
                return blocks
            roots.append(match)
            children[match] = set()
            if (
                match + 1 in evidence
                and blocks[match + 1].get("type") == "text"
                and blocks[match + 1]["page_idx"] == row[2] - 1
                and _outline_title(blocks[match]["text"]) != _outline_title(row[1])
                and _outline_title(
                    blocks[match]["text"] + " " + blocks[match + 1]["text"]
                )
                == _outline_title(row[1])
            ):
                children[match].add(match + 1)
        elif roots and match is not None and counts[match] == 1:
            children[roots[-1]].add(match)
    if not roots or roots != sorted(roots):
        return blocks
    for position, root in enumerate(roots):
        scope_level = blocks[root]["text_level"]
        if scope_level <= 1:
            continue
        end = roots[position + 1] if position + 1 < len(roots) else len(blocks)
        for index in range(root + 1, end):
            block = blocks[index]
            boundary = block.get("_heading_boundary_level")
            neutral = (
                block.get("type") == "discarded"
                and block.get("_source_role") == "running-banner"
                and type(boundary) is int
                and boundary > 0
            )
            level = (
                boundary
                if neutral
                else (block.get("text_level") if block.get("type") == "text" else None)
            )
            if type(level) is not int or level <= 0:
                continue
            if level == 1:
                break
            if level <= scope_level:
                # Promotion must not outlive a former peer boundary unless the
                # source outline proves this heading belongs under that root.
                if neutral or index not in children[root]:
                    return blocks
                scope_level = level
    matched = set(roots)
    return [
        {**block, "text_level": 1} if index in matched else block
        for index, block in enumerate(blocks)
    ]


def _span_lines(spans: list[dict]) -> list[list[dict]]:
    lines: list[list[dict]] = []
    for span in spans:
        if (
            not lines
            or abs(lines[-1][0]["origin"][1] - span["origin"][1]) > 0.3 * span["size"]
        ):
            lines.append([])
        lines[-1].append(span)
    return lines


def _additional_banners(
    blocks: list[dict], evidence: dict[int, list[dict]], outline: set[tuple[int, str]]
) -> set[int]:
    """Prove a recurring narrow band before accepting its alternating titles."""
    bands: dict[tuple, list[int]] = defaultdict(list)
    seeds: dict[tuple, list[int]] = defaultdict(list)
    body_titles: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for index, spans in evidence.items():
        block = blocks[index]
        text, box, page = block["text"], block["bbox"], block["page_idx"]
        size = max(s["size"] for s in spans)
        if box[1] >= 75 and box[3] <= 925:
            body_titles[_literal(text)].append((page, size))
        if (page, _outline_title(text)) in outline or not any(
            c.isalpha() for c in text
        ):
            continue
        top = 0 <= box[1] < 65
        bottom = 935 <= box[1] < box[3] <= 1000
        if not (bottom or top and box[3] <= 100 and len(_span_lines(spans)) <= 2):
            continue
        style = max(spans, key=lambda s: len(s["text"]))
        band = (top, round(box[1] / 10), style["font"], round(style["size"], 1))
        bands[band].append(index)
        # A taller or changing title cannot establish its own running band.
        if bottom or box[3] <= 65:
            seeds[band, _literal(text)].append(index)
    confirmed: set[tuple] = set()
    banners: set[int] = set()
    for (band, _), group in seeds.items():
        if len({blocks[index]["page_idx"] for index in group}) >= 3:
            confirmed.add(band)
            banners.update(group)
    for band in confirmed:
        for index in bands[band]:
            if index in banners:
                continue
            size = max(s["size"] for s in evidence[index])
            lines = [
                _literal(" ".join(s["text"] for s in line))
                for line in _span_lines(evidence[index])
            ]
            if all(
                any(
                    page <= blocks[index]["page_idx"] and body_size > size + 0.5
                    for page, body_size in body_titles.get(line, [])
                )
                for line in lines
            ):
                banners.add(index)
    return banners


def _folio_title(text: str) -> tuple[tuple[str, int], str] | None:
    """A leading or trailing folio (decimal first) and the rest as a title key
    with its digits and Roman numerals stripped."""
    value = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
    words = value.strip(" |•·–—-").split()
    if not words:
        return None
    for kind in ("decimal", "roman"):
        for word, rest in ((words[0], words[1:]), (words[-1], words[:-1])):
            folio = _folio(word)
            if folio and folio[0] == kind:
                title = " ".join(w for w in rest if not _folio(w))
                return folio, _literal(re.sub(r"\d+", "", title))
    return None


def _folio_band(box: list[float]) -> bool:
    return 0 <= box[1] < box[3] < 100 or 900 < box[1] < box[3] <= 1000


def _wide_band(box: list[float]) -> bool:
    """The top and bottom fifth of the page, for running heads set just below
    the margin band (Java, Java, Java's at y = 0.107)."""
    return 0 <= box[1] < box[3] < 200 or 800 < box[1] < box[3] <= 1000


def _family_banners(
    blocks: list[dict], evidence: dict[int, list[dict]], outline: set, band
) -> set[int]:
    """Running banners of folio families: blocks in ``band`` with a leading or
    trailing folio, grouped by folio kind, folio minus page index, top or
    bottom, band, font and size, whatever their title."""
    families: dict[tuple, list[tuple[int, int, str]]] = defaultdict(list)
    for index, spans in evidence.items():
        block = blocks[index]
        text, box, page_index = block["text"], block["bbox"], block["page_idx"]
        if (page_index, _outline_title(text)) in outline:
            continue
        found = _folio_title(text) if band(box) else None
        if found:
            (kind, folio), title = found
            style = max(spans, key=lambda s: len(s["text"]))
            key = (
                kind,
                folio - page_index,
                box[3] < 100,
                round(box[1] / 10),
                style["font"],
                round(style["size"]),
            )
            families[key].append((index, page_index, title))
    # Page offsets the margins show, by folio kind, so front matter numbered
    # apart from the body (Roman or Arabic) proves its own banners.
    shown: dict[tuple[str, int], list[tuple[int, str]]] = defaultdict(list)
    for index, block in enumerate(blocks):
        box, page_index = block.get("bbox") or [], block.get("page_idx")
        if len(box) == 4 and type(page_index) is int and band(box):
            found = _folio_title(str(block.get("text") or ""))
            if found:
                (kind, folio), title = found
                shown[kind, folio - page_index].append((index, title))

    def running(group: list[tuple[int, int, str]], kind, offset, top) -> bool:
        # A folio that tracks the page proves the band whatever the title,
        # but only a repeated title separates it from numbered slide titles.
        titles: dict[str, set[int]] = defaultdict(set)
        for _, page, title in group:
            titles[title].add(page)
        members = {index for index, _, _ in group}
        boxes = [blocks[index]["bbox"] for index in members]
        # A page-top Exercise N or Question N also rises with the page. It is
        # a folio only when the book shows that offset elsewhere: on a bare page
        # number or a banner with another title (a sibling of the same series,
        # typed as a paragraph or split off by band or size, proves nothing),
        # or on this family's banners of the facing (left and right) pages.
        # Bottom-margin families need no such proof: centred and full-width
        # footers are often a book's only page numbering.
        proven = (
            not top
            or any(
                index not in members and (not title or title not in titles)
                for index, title in shown[kind, offset]
            )
            or (
                any(box[2] < 500 for box in boxes)
                and any(box[0] > 500 for box in boxes)
            )
        )
        return (
            proven
            and len({page for _, page, _ in group}) >= 3
            and any(len(pages) >= 2 for pages in titles.values())
        )

    banners: set[int] = set()
    for (kind, offset, top, *_), group in families.items():
        # Headings are judged as before, where a margin paragraph outside
        # their group can show the offset (the facing pages' running heads);
        # paragraphs then join an accepted family. Judged together, no member
        # proves its own family.
        headed = [member for member in group if blocks[member[0]].get("text_level")]
        if (headed and running(headed, kind, offset, top)) or running(
            group, kind, offset, top
        ):
            banners.update(index for index, _, _ in group)
    return banners


def _wide_only(blocks: list[dict], found: list[int]) -> set[int]:
    """Banners found only through the wide band stay when their group (folio
    kind, page offset, top or bottom, height in hundredths) covers five pages
    and a tenth of the book."""
    pages = len(
        {b.get("page_idx") for b in blocks if isinstance(b.get("page_idx"), int)}
    )
    groups: dict[tuple, set[int]] = defaultdict(set)
    keys: dict[int, tuple] = {}
    for index in found:
        folio = _folio_title(str(blocks[index].get("text") or ""))
        if not folio:
            continue
        (kind, number), _ = folio
        box, page = blocks[index]["bbox"], blocks[index]["page_idx"]
        keys[index] = (kind, number - page, box[1] < 500, round(box[1] / 10))
        groups[keys[index]].add(page)
    return {i for i, key in keys.items() if len(groups[key]) >= max(5, 0.1 * pages)}


def correct_roles(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Correct source-backed heading roles before any section context is built."""
    outline = {
        (page - 1, _outline_title(text))
        for _, text, page in document.get_toc()
        if page > 0
    }
    page_spans: dict[int, list[dict]] = {}
    # Margin paragraphs join the banner rules only; every other rule and the
    # outline roots see headings alone. The wide band's evidence holds the
    # narrow margin band's.
    wide = _source_spans(blocks, document, page_spans, _wide_band)
    evidence = {
        i: s
        for i, s in wide.items()
        if blocks[i].get("text_level") or _folio_band(blocks[i]["bbox"])
    }
    roles: dict[int, str] = {}
    body_styles: dict[int, tuple] = {}
    for index, spans in evidence.items():
        block = blocks[index]
        text, box, page_index = block["text"], block["bbox"], block["page_idx"]
        if not block.get("text_level") or (page_index, _outline_title(text)) in outline:
            continue
        if 0 <= box[1] < box[3] <= 65 or 935 <= box[1] < box[3] <= 1000:
            continue
        if BULLET.match(text):
            roles[index] = "bullet-item"
            continue
        if re.match(
            r"^(?:figure|fig\.|table)\s+\d+(?:[.\-]\d+)*(?:[.:\s])", text.casefold()
        ):
            roles[index] = "numbered-caption"
            continue
        # A sentence set in the page's body font and size is a paragraph ODL
        # ranked as a heading (College Research's carried-over lines).
        if SENTENCE_END.search(text.strip()):
            if page_index not in body_styles:
                body_styles[page_index] = _main_style(page_spans[page_index])
            if _main_style(spans) == body_styles[page_index]:
                roles[index] = "body-style-heading"
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
    heading_roles = dict(roles)
    family = _family_banners(blocks, evidence, outline, _folio_band)
    roles.update((index, "running-banner") for index in family)
    additional = _additional_banners(blocks, evidence, outline) - roles.keys()
    roles.update((index, "running-banner") for index in additional)
    # The same rules in the top and bottom fifth; what they add there must also
    # span five pages and a tenth of the book.
    family = _family_banners(blocks, wide, outline, _wide_band)
    found = family | (_additional_banners(blocks, wide, outline) - heading_roles.keys())
    extra = [i for i in sorted(found) if roles.get(i) != "running-banner"]
    roles.update((index, "running-banner") for index in _wide_only(blocks, extra))
    result = list(blocks)
    for index, role in roles.items():
        result[index] = {**blocks[index], "_source_role": role}
        result[index].pop("text_level", None)
        if role == "running-banner":
            result[index]["type"] = "discarded"
            # Keep a former heading's scope reset without making its text an
            # ancestor; a paragraph banner never opened a scope.
            if blocks[index].get("text_level"):
                result[index]["_heading_boundary_level"] = blocks[index]["text_level"]
    headed = {i: s for i, s in evidence.items() if blocks[i].get("text_level")}
    result = correct_outline_roots(result, document, headed)
    return promote_capitals(insert_outline_headings(result, document), document)


def _is_heading(block: dict) -> bool:
    level = block.get("text_level")
    return block.get("type") == "text" and type(level) is int and level > 0


def _running_title(text: str) -> str:
    """A running head's title key without its leading or trailing folio."""
    words = " ".join(text.split()).strip(" |•·–—-").split()
    if words and _folio(words[0]):
        words = words[1:]
    if words and _folio(words[-1]):
        words = words[:-1]
    return _outline_title(" ".join(words).strip(" |•·–—-"))


def insert_outline_headings(
    blocks: list[dict], document: pymupdf.Document
) -> list[dict]:
    """Insert a heading for an outline entry that no heading on its page
    matches when the page's running head, discarded as a banner, carries the
    same title (College Research prints its chapter titles only there).

    The heading takes the level of the entry's matched sibling headings
    (their most common), else one below its parent entry's heading, else 1.
    It goes before the page's first block with the running head's box.
    """
    toc = document.get_toc()
    pages: dict[int, list[int]] = defaultdict(list)
    for index, block in enumerate(blocks):
        if type(block.get("page_idx")) is int:
            pages[block["page_idx"]].append(index)

    def matched(position: int) -> int | None:
        _, title, page = toc[position]
        headings = [i for i in pages.get(page - 1, []) if _is_heading(blocks[i])]
        for i in headings:
            texts = [blocks[i]["text"]]
            if i + 1 in headings:  # a title split over two heading blocks
                texts.append(blocks[i]["text"] + " " + blocks[i + 1]["text"])
            if any(_outline_title(t) == _outline_title(title) for t in texts):
                return blocks[i]["text_level"]
        return None

    parents = [
        next((p for p in range(position - 1, -1, -1) if toc[p][0] < depth), None)
        for position, (depth, _, _) in enumerate(toc)
    ]
    levels = {p: level for p in range(len(toc)) if (level := matched(p)) is not None}
    inserted: dict[int, int] = {}  # outline position -> level given here
    before: dict[int, list[dict]] = defaultdict(list)
    for position, (depth, title, page) in enumerate(toc):
        slots = pages.get(page - 1, [])
        key = _outline_title(title)
        if position in levels or not key or not slots:
            continue
        heads = [
            i
            for i in slots
            if blocks[i].get("_source_role") == "running-banner"
            and _running_title(str(blocks[i].get("text") or "")) == key
        ]
        if not heads:
            continue
        up = parents[position]
        siblings = Counter(
            level
            for p, level in levels.items()
            if toc[p][0] == depth and parents[p] == up
        )
        up_level = levels.get(up, inserted.get(up)) if up is not None else None
        level = (
            siblings.most_common(1)[0][0]
            if siblings
            else (up_level + 1 if up_level is not None else 1)
        )
        inserted[position] = level
        before[slots[0]].append(
            {
                "type": "text",
                "text": " ".join(title.split()),
                "text_level": level,
                "page_idx": page - 1,
                "bbox": blocks[heads[0]]["bbox"],
                "_source_role": "outline-heading",
            }
        )
    if not before:
        return blocks
    return [new for i, block in enumerate(blocks) for new in [*before[i], block]]


def _capitals(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return (
        len(text.split()) >= 2
        and len(letters) >= 10
        and all(c.isupper() for c in letters)
        and not text.endswith(".")
        and "=" not in text
    )


def promote_capitals(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Promote one-line all-capitals paragraphs set off by blank space and
    followed by body text (Conservation Techniques' body-font section titles).

    Title pages (up to the first native heading and its leading repeats),
    lines with a folio or '=', labels repeated on 3 or more pages and the
    capitals form of a heading or outline title stay text. A promoted heading
    sits one below the lowest heading in force; consecutive ones are siblings.
    """

    def letters(text: str) -> str:
        return "".join(c for c in text.casefold() if c.isalpha())

    def text_of(block: dict) -> str:
        return " ".join(str(block.get("text") or "").split())

    known = {letters(title) for _, title, _ in document.get_toc()}
    known |= {letters(text_of(b)) for b in blocks if _is_heading(b)}
    labels: dict[str, set] = defaultdict(set)
    for block in blocks:
        label = re.sub(r"\d+", "", text_of(block)).strip()
        if label:
            labels[label].add(block.get("page_idx"))
    # Title pages run to the last of the leading headings that repeat the
    # first heading's text (a half-title, then the title page with its author
    # line, as in the Business Plan Development Guide).
    title_page, title = 0, None
    for block in blocks:
        if _is_heading(block):
            if title is None:
                title = letters(text_of(block))
            elif letters(text_of(block)) != title:
                break
            title_page = block["page_idx"]
    pages: dict[int, list[int]] = defaultdict(list)
    for index, block in enumerate(blocks):
        if len(block.get("bbox") or []) == 4 and type(block.get("page_idx")) is int:
            pages[block["page_idx"]].append(index)
    promote: set[int] = set()
    for page, slots in pages.items():
        if page <= title_page:
            continue
        heights = [
            blocks[i]["bbox"][3] - blocks[i]["bbox"][1]
            for i in slots
            if blocks[i].get("type") == "text" and len(text_of(blocks[i])) < 90
        ]
        if not heights:
            continue
        line = statistics.median(heights)
        for position, index in enumerate(slots):
            block, text = blocks[index], text_of(blocks[index])
            if (
                block.get("type") != "text"
                or block.get("text_level")
                or block.get("_source_role")
                or not _capitals(text)
                or letters(text) in known
                or re.search(r"\d+$", text)
                or re.match(r"\d+\s", text)
                # A Roman folio only counts in the margins ("TITLE PAGE | XI").
                or (_folio_band(block["bbox"]) and _folio_title(text))
                or len(labels[re.sub(r"\d+", "", text).strip()]) >= 3
                or position + 1 == len(slots)
            ):
                continue
            height = block["bbox"][3] - block["bbox"][1]
            below = blocks[slots[position + 1]]
            # The page top counts as a blank line above.
            above = (
                block["bbox"][1] - blocks[slots[position - 1]]["bbox"][3]
                if position
                else height
            )
            following = " ".join(
                [text_of(below)] + [str(item) for item in below.get("list_items") or []]
            )
            if (
                height <= 1.6 * line
                and above >= 0.8 * height
                and below["bbox"][1] - block["bbox"][3] >= 0.8 * height
                and re.search(r"[a-z]", following[:40])
            ):
                promote.add(index)
    if not promote:
        return blocks
    result = list(blocks)
    stack: list[tuple[int, bool]] = []  # (level, promoted here)
    for index, block in enumerate(blocks):
        boundary = block.get("_heading_boundary_level")
        if block.get("_source_role") == "running-banner" and type(boundary) is int:
            while stack and stack[-1][0] >= boundary:
                stack.pop()
        elif _is_heading(block):
            while stack and stack[-1][0] >= block["text_level"]:
                stack.pop()
            stack.append((block["text_level"], False))
        elif index in promote:
            while stack and stack[-1][1]:
                stack.pop()  # an earlier capitals heading is a sibling
            level = (stack[-1][0] if stack else 0) + 1
            result[index] = {
                **block,
                "text_level": level,
                "_source_role": "capitals-heading",
            }
            stack.append((level, True))
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
