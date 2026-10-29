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
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
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
# A slide figure names the capture it shows, numbered as this turn made them
# (pages of two sources may share a number).
IMAGE_HREF = re.compile(r"\.\./images/c(\d+)\.jpg")
WHOLE_PAGE = [0, 0, 1000, 1000]
FILE_NAME_MAX = 120  # fieldlimits.FileName


def available() -> bool:
    """ppt-master is installed. The deck tools are always offered (Epo
    2026-10-14): the retrieval image holds it, and elsewhere a deck fails
    loudly (_script)."""
    return (SKILL / "SKILL.md").exists()


def _script(
    name: str, *args: str, stdin: str | None = None
) -> subprocess.CompletedProcess[str]:
    if not available():
        raise RuntimeError(f"ppt-master is not installed at {SKILL}")
    return subprocess.run(
        [*PYTHON, str(SKILL / "scripts" / name), *args],
        input=stdin,
        capture_output=True,
        # UTF-8 stdio both ways whatever the locale (a Windows playground
        # otherwise sends a credit's "·" through cp1252).
        encoding="utf-8",
        env={**os.environ, "PYTHONUTF8": "1"},
        timeout=SCRIPT_TIMEOUT_S,
        check=False,
    )


def wrap(text: str, *, size: float, width: float, family: str) -> list[str]:
    """``text`` in lines of at most ``width`` px, wrapped by ppt-master's
    text_measure with the estimator its checker measures with."""
    proc = _script(
        "text_measure.py",
        "wrap",
        "--stdin",
        "--json",
        "--max-width",
        str(width),
        "--size",
        str(size),
        "--family",
        family,
        "--x",
        "0",
        "--dy",
        "1",
        stdin=text,
    )
    if proc.returncode:
        raise RuntimeError(f"text_measure wrap failed: {proc.stderr[-800:]}")
    return json.loads(proc.stdout)["lines"]


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
    """svg_output, already through check(), as a PPTX; the problem, or empty."""
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


# The credit rows of a style's sources.svg: its sources module
# (data-pptx-bounds "64 180 1152 480") in the root's Arial 20 px. A credit
# wraps at the module's width, its lines LINE apart; credits are GAP apart.
SOURCES_X = 64
SOURCES_WIDTH = 1152
SOURCES_FIRST = 210
SOURCES_BOTTOM = 660
SOURCES_SIZE = 20
SOURCES_FAMILY = "Arial"
SOURCES_LINE = 26
SOURCES_GAP = 40


def sources_svg(style: str, credits: list[str], page: int, lang: str) -> str | None:
    """The deck's Sources slide, each credit wrapped as ppt-master wraps a
    text block (a tspan per line), or None when the credits are too many
    for the module's height."""
    rows: list[str] = []
    y = SOURCES_FIRST
    for credit in credits:
        lines = wrap(
            credit, size=SOURCES_SIZE, width=SOURCES_WIDTH, family=SOURCES_FAMILY
        )
        last = y + SOURCES_LINE * (len(lines) - 1)
        if last + 0.35 * SOURCES_SIZE > SOURCES_BOTTOM:
            return None
        rest = "".join(
            f'<tspan x="{SOURCES_X}" dy="{SOURCES_LINE}">{escape(line)}</tspan>'
            for line in lines[1:]
        )
        rows.append(
            f'    <text x="{SOURCES_X}" y="{y}">{escape(lines[0])}{rest}</text>'
        )
        y = last + SOURCES_GAP
    template = (STYLE_DIR / style / "sources.svg").read_text(encoding="utf-8")
    return template.format(
        lang=escape(lang),
        kicker="SOURCES",
        title="Sources",
        rows="\n".join(rows),
        page=page,
    )


# ------------------------------------------------------------------ records
#
# A deck is a dict: id, title, chapter_id, sources (its made-from line, as
# written), deck {style, slides [{title, brief, svg}]}, provenance {books} or
# None, and file (the stored file's id) once it is stored. The playground
# writes the same record as JSON.


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
        "sources": list(args.get("sources") or []),
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


def written_text(record: dict[str, Any], n: int) -> str:
    """A landed write's result: which slide it was, then the outline. Four
    outlines in a row otherwise read alike, and MiniMax rewrote a kept slide
    (2026-10-30 loop trace)."""
    return f"Slide {n} is written and kept.\n{outline_text(record)}"


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
    """This turn's captures as figures, keyed by capture number as the model
    names them: why each cannot be a figure (empty when it can), the JPEGs,
    and the library excerpt each came from. A whole page is refused: a slide
    shrinks it unreadable. An Office picture inspect_office_document attached
    is a figure as it is (Q278)."""
    problems: dict[int, str] = {}
    figures: dict[int, bytes] = {}
    excerpts: dict[int, str] = {}
    for n, cap in enumerate(captures, 1):
        bbox = cap.get("bbox")
        if not cap.get("picture") and (not bbox or list(bbox) == WHOLE_PAGE):
            problems[n] = (
                f"capture {n} is a whole page; capture it again with a bbox "
                "around the figure"
            )
            continue
        _, url = images.get(cap["callId"], ("", ""))
        if not url:
            problems[n] = f"capture {n} is no longer available"
            continue
        problems[n] = ""
        figures[n] = base64.b64decode(url.split(",", 1)[1])
        if cap.get("excerptId"):
            excerpts[n] = str(cap["excerptId"])
    return problems, figures, excerpts


def figure_pages(svg: str) -> set[int]:
    """The captures a slide embeds, by number."""
    return {int(m.group(1)) for m in IMAGE_HREF.finditer(svg)}


# ------------------------------------------------------------------ writing


def _file(n: int, title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:40] or "slide"
    return f"{n:02d}_{slug}.svg"


def _local_problem(svg: str, captures: dict[int, str]) -> tuple[str, set[int]]:
    """What the checker cannot say: XML that does not parse, another canvas, no
    language, or a figure that is not a bbox capture from this turn. Returns the
    captures used."""
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
            return f'image href "{href}" must be ../images/c<capture>.jpg', set()
        page = int(match.group(1))
        problem = captures.get(page, f"capture {page} was not made this turn")
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
    maps each capture of this turn, by number, to why it cannot be a figure, empty when
    it can; ``figures`` holds those captures' images, placed in ``project``."""
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
        (project / "images" / f"c{page}.jpg").write_bytes(image)


@dataclass(frozen=True)
class ExportProblem:
    """Why a complete deck did not export, in the model's words. ``ours`` when
    no slide the model wrote is at fault (the Sources slide, the exporter):
    writing slides again cannot fix it."""

    text: str
    ours: bool


# The end of an export problem the model cannot fix (Epo 2026-10-30, T2b).
NOT_YOURS = (
    " Writing slides again does not change it, so this deck cannot be saved in "
    "this turn: tell the learner."
)


def save(record: dict[str, Any], project: Path, pptx: Path) -> ExportProblem | None:
    """Rewrite svg_output from the record, closed by a Sources slide when the deck
    credits library books, check it and export it; the problem, or None. The
    model is pointed at its own slides only, by number and title."""
    out = project / "svg_output"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    slides = record["deck"]["slides"]
    names: dict[str, tuple[int, str]] = {}
    for n, slide in enumerate(slides, 1):
        names[_file(n, slide["title"])] = (n, slide["title"])
        (out / _file(n, slide["title"])).write_text(slide["svg"], encoding="utf-8")
    books = credits(record)
    if books:
        lang = ET.fromstring(slides[0]["svg"]).attrib["lang"]
        page = len(slides) + 1
        svg = sources_svg(record["deck"]["style"], books, page, lang)
        if svg is None:
            return ExportProblem(
                f"The deck did not export: its Sources slide, made from the "
                f"{len(books)} books it credits, cannot hold them all.{NOT_YOURS}",
                ours=True,
            )
        (out / _file(page, "sources")).write_text(svg, encoding="utf-8")
    errors = check(project)
    yours = {name: errs for name, errs in errors.items() if name in names}
    if yours:
        listed = "\n".join(
            f"- slide {names[name][0]} ({names[name][1]}): {e}"
            for name, errs in yours.items()
            for e in errs[:MAX_ERRORS]
        )
        return ExportProblem(
            "The deck did not export: the final check refused these slides. "
            f"Write each of them again; the deck exports once every slide passes.\n{listed}",
            ours=False,
        )
    if errors:
        ours = "; ".join(e for errs in errors.values() for e in errs[:MAX_ERRORS])
        return ExportProblem(
            "The deck did not export: its Sources slide, made from the books it "
            f"credits and not written by you, failed the check ({ours}).{NOT_YOURS}",
            ours=True,
        )
    problem = export(project, pptx)
    if problem:
        return ExportProblem(
            f"The deck did not export: {problem}.{NOT_YOURS}", ours=True
        )
    return None
