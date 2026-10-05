"""Decks the ppt-master way (its Quick route): the model writes every slide as
an SVG, ppt-master's checker refuses a slide whose text spills out of a module
or the page, and ppt-master's exporter turns the slides into native, editable
PPTX shapes.

ppt-master runs from its official distribution, pinned below and checked out
into the ignored local/ppt-master; its exporter refuses a partial copy. Its
scripts run under uv with their own dependencies. A style is a folder in
deck-styles/: style.md (palette, type, page chrome, components), examples/
(reference slides the model imitates) and sources.svg (the Sources slide).
DECKS.md is the adoption guide: how the parts map onto ppt-master and how to
add a style.
"""

from __future__ import annotations

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

from common import REPO
from jsonschema import Draft202012Validator

PLAYGROUND = REPO / "lab/playground"
PPT_MASTER_REPO = "https://github.com/hugohe3/ppt-master.git"
PPT_MASTER_COMMIT = "44c10ed0bc3a9e1df7a25aa179ae7c26db09469b"
PPT_MASTER_DIR = PLAYGROUND / "local/ppt-master"
SKILL = PPT_MASTER_DIR / "skills/ppt-master"
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
STYLE_DIR = PLAYGROUND / "deck-styles"
DEFAULT_STYLE = "editorial"
VIEWBOX = "0 0 1280 720"
MAX_SLIDES = 30
MAX_SVG = 40_000  # characters; the example decks' slides are 3 to 9 KB
MAX_ERRORS = 6  # checker errors returned per refusal
NS = "{http://www.w3.org/2000/svg}"
IMAGE_HREF = re.compile(r"\.\./images/p(\d+)\.jpg")

RULES = f"""Write one slide as a single SVG; ppt-master's exporter turns it into native PowerPoint shapes.
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="{VIEWBOX}" lang="<the deck's BCP-47 language>" data-pptx-page-role="cover|toc|section|content|ending" font-family=... font-size=...>, then a background <rect id="background" data-pptx-role="background" .../>.
- Every visible part sits in a module: a root-level <g id="..." data-pptx-bounds="x y width height"> whose bounds enclose its children. Modules do not overlap. A checker measures every text line against its module's bounds and the canvas and refuses the slide when text spills out, so write each sentence first, estimate its width from the style's characters-per-100px table, then size the module.
- Allowed: rect, circle, ellipse, line, polyline, polygon, path, text and tspan, g, defs with linearGradient, and image. Each text has x and y; set font-size, font-weight and fill on it or inherit them from its module. Write raw Unicode; escape & < > as &amp; &lt; &gt;. No style element, class, foreignObject, textPath, filters, animation, script, symbol or use, and no HTML entities.
- A figure is <image href="../images/p<page>.jpg" x y width height preserveAspectRatio="xMidYMid meet"/> for a page captured this turn with a bbox around the figure.
- Write the slide for one audience move (what the student knows before it and after it) and lay its points out by how they relate: order as a numbered sequence, contrast side by side, membership as parallel cards. Use only facts from what you read; the footer names the source."""


# ------------------------------------------------------------------ ppt-master


def ensure_ppt_master() -> Path:
    """The pinned skill checkout, cloned on first use. Icons, sounds and the
    image-model comparison sheets are left out; the attribution guard does not
    need them."""
    if (SKILL / "SKILL.md").exists():
        return SKILL
    PPT_MASTER_DIR.parent.mkdir(parents=True, exist_ok=True)
    git = ["git", "-C", str(PPT_MASTER_DIR)]
    subprocess.run(
        ["git", "clone", "--quiet", "--filter=blob:none", "--no-checkout", PPT_MASTER_REPO, str(PPT_MASTER_DIR)],
        check=True,
    )
    subprocess.run(
        [*git, "sparse-checkout", "set", "--no-cone", "skills/ppt-master",
         "!skills/ppt-master/templates/icons/", "!skills/ppt-master/templates/sounds/",
         "!skills/ppt-master/references/ai-image-comparison/"],
        check=True,
    )
    subprocess.run([*git, "checkout", "--quiet", PPT_MASTER_COMMIT], check=True)
    return SKILL


def _script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    with_deps = [part for dep in PPT_MASTER_DEPS for part in ("--with", dep)]
    return subprocess.run(
        ["uv", "--native-tls", "run", "--quiet", "--no-project", *with_deps,
         "python", str(ensure_ppt_master() / "scripts" / name), *args],
        capture_output=True,
        text=True,
    )


def check(project: Path) -> dict[str, list[str]]:
    """ppt-master's final Quick check over project/svg_output: blocking errors
    per file, empty when every page passes. It also writes the report the
    exporter fingerprints."""
    proc = _script(
        "svg_quality_checker.py", str(project), "--quick-generate",
        "--canonical-authoring", "--stage", "final", "--json",
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
        return "; ".join(f"{name}: {e}" for name, errs in errors.items() for e in errs[:MAX_ERRORS])
    proc = _script("svg_to_pptx.py", str(project), "--quick-generate", "--no-notes", "-o", str(pptx))
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
        f'    <text x="64" y="{210 + 40 * i}">{escape(credit)}</text>' for i, credit in enumerate(credits)
    )
    template = (STYLE_DIR / style / "sources.svg").read_text(encoding="utf-8")
    return template.format(lang=escape(lang), kicker="SOURCES", title="Sources", rows=rows, page=page)


# ------------------------------------------------------------------ tools

_TODO = {
    "type": "integer",
    "minimum": 0,
    "description": "Id of the open ledger todo this write completes, as the turn context shows it.",
}
_EXCERPTS = {
    "type": "array",
    "maxItems": 32,
    "items": {"type": "string"},
    "description": "Library excerpt ids this was written from; they become the deck's Sources slide.",
}
SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "create_deck",
            "description": "Create a slide deck from an outline, one title and brief per slide, as the deck skill describes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 120},
                    "slides": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_SLIDES,
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string", "minLength": 1, "maxLength": 160},
                                "brief": {"type": "string", "minLength": 1, "maxLength": 1200},
                            },
                            "required": ["title", "brief"],
                            "additionalProperties": False,
                        },
                    },
                    "excerpt_ids": _EXCERPTS,
                    "todo": _TODO,
                },
                "required": ["title", "slides"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_slide",
            "description": "Write one slide of a deck as SVG in the deck skill's rules; writing a slide again replaces it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "deck_id": {"type": "string"},
                    "slide": {"type": "integer", "minimum": 1},
                    "svg": {"type": "string", "minLength": 1, "maxLength": MAX_SVG},
                    "excerpt_ids": _EXCERPTS,
                    "todo": _TODO,
                },
                "required": ["deck_id", "slide", "svg"],
                "additionalProperties": False,
            },
        },
    },
]
NAMES = frozenset(s["function"]["name"] for s in SCHEMAS)
ADDON = (
    "\n\nDecks are the other main explainer: a deck for brief or lecture-like "
    "learning, a note for detailed, text-dense learning."
)
WHEN = "read before making a slide deck (create_deck, write_slide)"
# The skills each deck tool needs; the playground adds these to skills.REQUIRES.
REQUIRES = {"create_deck": ("editing", "deck"), "write_slide": ("editing", "deck")}
MAIN_FORMAT = {
    "note": "Main explainer: a note for every chapter.",
    "deck": "Main explainer: a deck for every chapter.",
    "auto": "Main explainer: choose from the explainer style; brief leans deck, detailed leans note.",
}
_validators = {s["function"]["name"]: Draft202012Validator(s["function"]["parameters"]) for s in SCHEMAS}


def addon(main_format: str) -> str:
    return ADDON + " " + MAIN_FORMAT[main_format]


def validate(name: str, args: dict[str, Any]) -> str:
    error = next(iter(sorted(_validators[name].iter_errors(args), key=str)), None)
    if error is None:
        return ""
    where = "/".join(str(p) for p in error.absolute_path)
    return f"{name} arguments invalid at {where or '$'}: {error.message}"


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
    out = [f"Deck {record['id']}, {len(slides)} slides, style {record['deck']['style']}:"]
    for n, slide in enumerate(slides, 1):
        out.append(f"{n}. {slide['title']} ({'written' if slide['svg'] else 'to write'})")
    return "\n".join(out)


def create(args: dict[str, Any], rid: str) -> dict[str, Any]:
    slides = [{"title": s["title"].strip(), "brief": s["brief"].strip(), "svg": None} for s in args["slides"]]
    return {
        "id": rid,
        "kind": "deck",
        "title": args["title"].strip(),
        "deck": {"style": DEFAULT_STYLE, "slides": slides},
    }


def skill_text() -> str:
    """The deck skill: the method, the slide rules and the default style."""
    return (
        "How to make a slide deck, the brief or lecture-like main explainer.\n\n"
        "Plan:\n"
        "- Outline with create_deck: one title and brief per slide, in order, one slide per idea, "
        "8 to 20 per chapter, opening with a cover. A brief says the slide's audience move (what "
        "the student knows before and after), how its points relate, and the content with its source.\n"
        "- Then write the slides one per write_slide call, each from what you just read for it. "
        "Each write_slide completes the ledger todo it names, so keep one open todo per slide still "
        "to write. Pass excerpt_ids for library content and todo while todos are open.\n"
        "- A slide the checker refuses comes back with its errors: fix those and send the whole "
        "slide again. The deck is exported once every slide is written.\n\n"
        f"Slides:\n{RULES}\n\n"
        f"Write every slide in the {DEFAULT_STYLE} style:\n\n{style_text(DEFAULT_STYLE)}"
    )


def created_text(record: dict[str, Any]) -> str:
    return outline_text(record) + "\n\nWrite the slides one per write_slide call."


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
    it can; ``figures`` holds those pages' images."""
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
        return f"slide {n} refused by the checker:\n- " + "\n- ".join(errors[:MAX_ERRORS])
    _place(project, {p: figures[p] for p in pages})
    slides[n - 1]["svg"] = svg
    return ""


def _place(project: Path, figures: dict[int, bytes]) -> None:
    if figures:
        (project / "images").mkdir(parents=True, exist_ok=True)
    for page, image in figures.items():
        (project / "images" / f"p{page}.jpg").write_bytes(image)


def complete(record: dict[str, Any]) -> bool:
    return all(s["svg"] for s in record["deck"]["slides"])


def save(record: dict[str, Any], project: Path, pptx: Path) -> str:
    """Rewrite svg_output from the record, closed by a Sources slide when the deck
    used library excerpts, and export it; the problem, or empty."""
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
