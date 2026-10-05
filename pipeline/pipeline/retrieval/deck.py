"""Decks the ppt-master way (its Quick route): the model writes every slide as
an SVG, ppt-master's checker refuses a slide whose text spills out of a module
or the page, and ppt-master's exporter turns the slides into native, editable
PPTX shapes (openwiki/decks.md).

ppt-master (MIT, Copyright (c) 2025-2026 Hugo He) is the whole checkout pinned
below, with its dependencies in their own virtualenv (pipeline/Dockerfile); its
attribution guard refuses a partial copy. Its two scripts run as subprocesses.
The playground points SKILL and PYTHON at its own clone.

A deck lives for one turn: its outline and slides on the ToolContext, its
figures in the turn's working directory. Once every slide is written it is
closed by a Sources slide, checked and exported, and the PPTX is stored as a
workspace file; from then on the PPTX is the document. A style is a folder in
prompts/deck_styles/: style.md (palette, type, page chrome, components),
examples/ (reference slides the model imitates) and sources.svg.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from functools import cache
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

PPT_MASTER_REPO = "https://github.com/hugohe3/ppt-master.git"
PPT_MASTER_COMMIT = "44c10ed0bc3a9e1df7a25aa179ae7c26db09469b"
# skills/ppt-master/requirements.txt, less narration, audio and source import.
PPT_MASTER_DEPS = (
    "python-pptx",
    "lxml",
    "pillow",
    "fonttools",
    "pyyaml",
    "xlsxwriter",
    "skia-pathops",
    "uharfbuzz",
)
# Where the retrieval image puts the checkout and its virtualenv.
SKILL = Path("/opt/ppt-master/skills/ppt-master")
PYTHON: list[str] = ["/opt/ppt-master/.venv/bin/python"]
SCRIPT_TIMEOUT_S = 180

STYLE_DIR = Path(__file__).resolve().parent.parent / "prompts" / "deck_styles"
DEFAULT_STYLE = "editorial"
VIEWBOX = "0 0 1280 720"
MAX_ERRORS = 6  # checker errors returned per refusal
NS = "{http://www.w3.org/2000/svg}"
IMAGE_HREF = re.compile(r"\.\./images/p(\d+)\.jpg")
WHOLE_PAGE = [0, 0, 1000, 1000]
FILE_NAME_MAX = 120  # fieldlimits.FileName


def available() -> bool:
    """ppt-master is installed: the deck tools are offered only then."""
    return (SKILL / "SKILL.md").exists()


def _script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [*PYTHON, str(SKILL / "scripts" / name), *args],
        capture_output=True,
        text=True,
        timeout=SCRIPT_TIMEOUT_S,
        check=False,
    )


def check(project: Path) -> dict[str, list[str]]:
    """ppt-master's final Quick check over project/svg_output: blocking errors
    per file, empty when every page passes. It also writes the report the
    exporter fingerprints."""
    proc = _script(
        "svg_quality_checker.py",
        str(project),
        "--quick-generate",
        "--canonical-authoring",
        "--stage",
        "final",
        "--json",
    )
    report = project / "validation" / "svg_quality_report.json"
    if not report.exists():
        raise RuntimeError(f"svg_quality_checker wrote no report: {proc.stderr[-800:]}")
    files = json.loads(report.read_text(encoding="utf-8"))["files"]
    return {f["file"]: f["errors"] for f in files if f["errors"]}


def export(project: Path, pptx: Path) -> str:
    """The checked svg_output as a PPTX; the problem, or empty."""
    errors = check(project)
    if errors:
        return "; ".join(
            f"{name}: {e}" for name, errs in errors.items() for e in errs[:MAX_ERRORS]
        )
    proc = _script(
        "svg_to_pptx.py",
        str(project),
        "--quick-generate",
        "--no-notes",
        "-o",
        str(pptx),
    )
    if proc.returncode or not pptx.exists():
        return f"svg_to_pptx failed: {(proc.stdout + proc.stderr)[-800:]}"
    return ""


# ------------------------------------------------------------------ styles


def styles() -> list[str]:
    return sorted(p.name for p in STYLE_DIR.iterdir() if (p / "style.md").exists())


@cache
def style_text(style: str) -> str:
    """What the model needs to write in a style: its rules and reference slides."""
    folder = STYLE_DIR / style
    examples = "\n\n".join(
        f"Reference slide {p.stem}:\n{p.read_text(encoding='utf-8')}"
        for p in sorted((folder / "examples").glob("*.svg"))
    )
    return (folder / "style.md").read_text(encoding="utf-8") + "\n\n" + examples


def sources_svg(style: str, credits: list[str], page: int, lang: str) -> str:
    rows = "\n".join(
        f'    <text x="64" y="{210 + 40 * i}">{escape(credit)}</text>'
        for i, credit in enumerate(credits)
    )
    template = (STYLE_DIR / style / "sources.svg").read_text(encoding="utf-8")
    return template.format(
        lang=escape(lang), kicker="SOURCES", title="Sources", rows=rows, page=page
    )


# ------------------------------------------------------------------ records
#
# A deck is a dict: id, title, chapter_id, deck {style, slides [{title, brief,
# svg}]}, provenance {books} or None, and file (the stored file's id) once it
# is stored. The playground writes the same record as JSON.


def deck_id(assistant_message_id: str, call_id: str) -> str:
    digest = hashlib.sha256(f"{assistant_message_id}\n{call_id}".encode()).hexdigest()
    return "deck_" + digest[:12]


def create(args: dict[str, Any], rid: str) -> dict[str, Any]:
    slides = [
        {"title": s["title"].strip(), "brief": s["brief"].strip(), "svg": None}
        for s in args["slides"]
    ]
    return {
        "id": rid,
        "kind": "deck",
        "title": args["title"].strip(),
        "chapter_id": str(args.get("chapter_id") or ""),
        "deck": {"style": DEFAULT_STYLE, "slides": slides},
        "provenance": None,
    }


def add_books(record: dict[str, Any], books: list[dict[str, Any]]) -> None:
    """Credit these books on the deck: merged by book id, excerpts unioned."""
    if not books:
        return
    merged = {b["id"]: dict(b) for b in (record["provenance"] or {}).get("books") or []}
    for book in books:
        current = merged.setdefault(book["id"], {**book, "excerptIds": []})
        current["excerptIds"] = sorted(
            {*current.get("excerptIds", []), *book.get("excerptIds", [])}
        )
    record["provenance"] = {"books": list(merged.values())}


def _credit(book: dict[str, Any]) -> str:
    parts = [book.get("title") or book["id"]]
    if book.get("authors"):
        parts.append(", ".join(book["authors"]))
    for key in ("edition", "license"):
        if book.get(key):
            parts.append(str(book[key]))
    return " · ".join(parts)


def credits(record: dict[str, Any]) -> list[str]:
    books = (record.get("provenance") or {}).get("books") or []
    return [_credit(b) for b in books]


def outline_text(record: dict[str, Any]) -> str:
    slides = record["deck"]["slides"]
    out = [
        f"Deck {record['id']}, {len(slides)} slides, style {record['deck']['style']}:"
    ]
    for n, slide in enumerate(slides, 1):
        out.append(
            f"{n}. {slide['title']} ({'written' if slide['svg'] else 'to write'})"
        )
    return "\n".join(out)


def created_text(record: dict[str, Any]) -> str:
    return outline_text(record) + "\n\nWrite the slides one per write_slide call."


def complete(record: dict[str, Any]) -> bool:
    return all(s["svg"] for s in record["deck"]["slides"])


def file_name(record: dict[str, Any]) -> str:
    """The stored file's name: the title, without path separators, as .pptx."""
    title = re.sub(r"[\\/\x00-\x1f]+", " ", record["title"]).strip() or "Deck"
    return title[: FILE_NAME_MAX - len(".pptx")].strip() + ".pptx"


# ------------------------------------------------------------------ figures


def turn_figures(
    captures: list[dict[str, Any]], images: dict[str, tuple[str, str]]
) -> tuple[dict[int, str], dict[int, bytes], dict[int, str]]:
    """This turn's captures as figures, keyed by page as the model names them
    (a later capture of the same page wins): why each page cannot be a figure
    (empty when it can), the JPEGs, and the library excerpt each came from.
    A whole page is refused: a slide shrinks it unreadable."""
    problems: dict[int, str] = {}
    figures: dict[int, bytes] = {}
    excerpts: dict[int, str] = {}
    for cap in captures:
        page = int(cap["page"])
        bbox = cap.get("bbox")
        if not bbox or list(bbox) == WHOLE_PAGE:
            problems[page] = (
                f"page {page} was captured whole; capture it again with a bbox "
                "around the figure"
            )
            continue
        _, url = images.get(cap["callId"], ("", ""))
        if not url:
            problems[page] = f"page {page}'s capture is no longer available"
            continue
        problems[page] = ""
        figures[page] = base64.b64decode(url.split(",", 1)[1])
        if cap.get("excerptId"):
            excerpts[page] = str(cap["excerptId"])
        else:
            excerpts.pop(page, None)
    return problems, figures, excerpts


def figure_pages(svg: str) -> set[int]:
    """The captured pages a slide embeds."""
    return {int(m.group(1)) for m in IMAGE_HREF.finditer(svg)}


# ------------------------------------------------------------------ writing


def _file(n: int, title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:40] or "slide"
    return f"{n:02d}_{slug}.svg"


def _local_problem(svg: str, captures: dict[int, str]) -> tuple[str, set[int]]:
    """What the checker cannot say: XML that does not parse, another canvas, no
    language, or a figure that is not a bbox capture from this turn. Returns the
    pages used."""
    try:
        root = ET.fromstring(svg)
    except ET.ParseError as e:
        return f"the SVG does not parse: {e}", set()
    if root.tag != f"{NS}svg":
        return 'the root must be <svg xmlns="http://www.w3.org/2000/svg">', set()
    if root.attrib.get("viewBox") != VIEWBOX:
        return f'the root viewBox must be "{VIEWBOX}"', set()
    if not root.attrib.get("lang"):
        return "the root needs lang, the deck's BCP-47 language", set()
    pages: set[int] = set()
    for image in root.iter(f"{NS}image"):
        href = image.attrib.get("href", "")
        match = IMAGE_HREF.fullmatch(href)
        if not match:
            return f'image href "{href}" must be ../images/p<page>.jpg', set()
        page = int(match.group(1))
        problem = captures.get(page, f"page {page} was not captured this turn")
        if problem:
            return problem, set()
        pages.add(page)
    return "", pages


def write(
    record: dict[str, Any],
    args: dict[str, Any],
    captures: dict[int, str],
    figures: dict[int, bytes],
    project: Path,
) -> str:
    """Check one slide alone and keep it; the problem, or empty. ``captures``
    maps each page captured this turn to why it cannot be a figure, empty when
    it can; ``figures`` holds those pages' images, placed in ``project``."""
    slides = record["deck"]["slides"]
    n = args["slide"]
    if not 1 <= n <= len(slides):
        return f"slide {n}: the deck has {len(slides)} slides"
    svg = args["svg"]
    problem, pages = _local_problem(svg, captures)
    if problem:
        return f"slide {n}: {problem}"
    name = _file(n, slides[n - 1]["title"])
    with tempfile.TemporaryDirectory() as tmp:
        alone = Path(tmp)
        (alone / "svg_output").mkdir()
        (alone / "svg_output" / name).write_text(svg, encoding="utf-8")
        _place(alone, {p: figures[p] for p in pages})
        errors = check(alone).get(name, [])
    if errors:
        return f"slide {n} refused by the checker:\n- " + "\n- ".join(
            errors[:MAX_ERRORS]
        )
    _place(project, {p: figures[p] for p in pages})
    slides[n - 1]["svg"] = svg
    return ""


def _place(project: Path, figures: dict[int, bytes]) -> None:
    if figures:
        (project / "images").mkdir(parents=True, exist_ok=True)
    for page, image in figures.items():
        (project / "images" / f"p{page}.jpg").write_bytes(image)


def save(record: dict[str, Any], project: Path, pptx: Path) -> str:
    """Rewrite svg_output from the record, closed by a Sources slide when the deck
    credits library books, and export it; the problem, or empty."""
    out = project / "svg_output"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    slides = record["deck"]["slides"]
    for n, slide in enumerate(slides, 1):
        (out / _file(n, slide["title"])).write_text(slide["svg"], encoding="utf-8")
    books = credits(record)
    if books:
        lang = ET.fromstring(slides[0]["svg"]).attrib["lang"]
        page = len(slides) + 1
        (out / _file(page, "sources")).write_text(
            sources_svg(record["deck"]["style"], books, page, lang), encoding="utf-8"
        )
    return export(project, pptx)
