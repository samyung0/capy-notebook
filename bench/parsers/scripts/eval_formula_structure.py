"""Evaluate ``parser/odl/scripts.py`` (formula structure from glyph geometry).

    prepare   before/after texts for the formula pages of two blind review sets,
              shuffled A/B packets with the key in a separate file
    corpus    every rewrite on the 49-document corpus, a seeded sample of 30,
              and the stage's process time per page
    aggregate join blind grades with the key: formula grades before vs after

Before texts are stored parser outputs where they exist (``--outputs``,
``doc-<id>.cand4.json``) and otherwise a re-parse of the review window with the
frozen parser (``--parser``); after texts apply the stage from this checkout to
the same blocks. Run with the parser venv::

    python bench/parsers/scripts/eval_formula_structure.py prepare \\
        --parser FROZEN/parser --outputs AB2 --pdfs DOCS49 --scratch SCRATCH --out OUT
    python bench/parsers/scripts/eval_formula_structure.py corpus \\
        --parser FROZEN/parser --outputs AB2 --pdfs DOCS49 --out OUT
    python bench/parsers/scripts/eval_formula_structure.py aggregate --out OUT
"""

from __future__ import annotations

import argparse
import difflib
import importlib.util
import json
import multiprocessing
import random
import re
import statistics
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LOCAL = ROOT / "bench/parsers/reports/local"
REVIEWS = [
    # (review set, review dir, our parser's label in its blind key)
    ("v12", LOCAL / "2026-10-12-mineru-v12", "shipped"),
    ("fresh", LOCAL / "2026-10-13-fresh", "cur"),
]
SLOT_TYPES = {"text", "list", "equation"}
STRUCTURE = set("^_{}()/√∑∏∫∮[]")


def load_parser(frozen: Path):
    """The frozen parser package, with this checkout's ``scripts`` stage."""
    sys.path.insert(0, str(frozen))
    import odl  # noqa: F401
    from odl import fonts, page_text, refine

    spec = importlib.util.spec_from_file_location(
        "odl.scripts", ROOT / "parser/odl/scripts.py"
    )
    scripts = importlib.util.module_from_spec(spec)
    sys.modules["odl.scripts"] = scripts
    spec.loader.exec_module(scripts)
    return fonts, page_text, refine, scripts


def formula_pages() -> list[dict]:
    pages = []
    for name, base, ours in REVIEWS:
        key = json.loads((base / "blind_key.json").read_text())
        for review in sorted((base / "review").glob("*.json")):
            book = review.stem
            for page in json.loads(review.read_text()):
                if not page["formulas"]:
                    continue
                label = next(k for k, v in key[f"{book}:{page['page']}"].items() if v == ours)
                pages.append(
                    {
                        "set": name,
                        "book": book,
                        "page": page["page"],
                        "formulas": [
                            {"desc": f["desc"], "reviewed": f[label]} for f in page["formulas"]
                        ],
                    }
                )
    return pages


def image_for(page: dict, scratch: Path) -> Path:
    if page["set"] == "v12":
        return LOCAL / "2026-10-12-mineru-v12/pages" / page["book"] / f"p{page['page']}.png"
    return scratch / "fresh-eval/pages" / page["book"] / f"p{page['page']}.png"


def slots(block: dict):
    for key in ("text", "list_items"):
        value = block.get(key)
        if isinstance(value, str):
            yield value
        elif isinstance(value, list):
            yield from (v for v in value if isinstance(v, str))


def render_blocks(blocks: list[dict]) -> str:
    out = []
    for b in blocks:
        kind = b.get("type")
        if kind == "text" and b.get("text_level"):
            out.append(f"[heading L{b['text_level']}] {b.get('text', '')}")
        elif kind == "list":
            out.append("[list]")
            out += [f"  - {t}" for t in b.get("list_items") or [] if isinstance(t, str)]
        elif kind in ("text", "equation"):
            out.append(f"[{kind}] {b.get('text', '')}")
        elif kind == "table":
            out.append("[table] " + re.sub(r"<[^>]+>", " ", b.get("table_body") or "")[:600])
        elif kind == "image":
            out.append("[figure] " + " ".join(b.get("figure_labels") or [])[:300])
        elif kind == "discarded":
            out.append(f"[dropped as page furniture] {b.get('text', '')}")
    return "\n".join(out)


def apply_stage(scripts, page_text, fonts, pdf: Path, blocks: list[dict], pages: set[int]):
    """The stage on ``pages`` of ``pdf`` (font-repaired as the parser does),
    page by page, with the process time each page took."""
    repaired, _ = fonts.repair_fonts(pdf.read_bytes())
    import pymupdf

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "document.pdf"
        path.write_bytes(repaired)
        after, timings = [], {}
        with pymupdf.open(path) as document, page_text.session(path):
            by_page: dict[int, list[dict]] = {}
            for b in blocks:
                by_page.setdefault(b.get("page_idx"), []).append(b)
            for p in sorted(k for k in by_page if k is not None):
                if p not in pages:
                    after += by_page[p]
                    continue
                page_text.page_dict(document[p])  # earlier stages read it first
                started = time.process_time()
                after += scripts.restore_structure(by_page[p], document)
                timings[p] = (time.process_time() - started) * 1000
    return after, timings


def window_blocks(refine, book: str, out: Path) -> tuple[list[dict], Path, int]:
    """Re-parse a review window with the frozen parser (cached)."""
    window = LOCAL / "2026-10-12-mineru-v12/odl/window" / book
    sample = json.loads((LOCAL / "2026-10-12-mineru-v12/sample.json").read_text())
    start = next(b["window"][0] for b in sample["books"] if b["id"] == book)
    cached = out / "windows" / f"{book}.json"
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            parsed = refine.parse_pdf(
                (window / "window.pdf").read_bytes(), Path(tmp), java_timeout_s=600
            )
        cached.write_text(json.dumps(parsed.content_list, ensure_ascii=False))
    return json.loads(cached.read_text()), window / "window.pdf", start


def prepare(args) -> None:
    fonts, page_text, refine, scripts = load_parser(Path(args.parser))
    out = Path(args.out)
    (out / "packets").mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261013)
    pages = formula_pages()
    by_book: dict[str, list[dict]] = {}
    for p in pages:
        by_book.setdefault(p["book"], []).append(p)
    key, records, timings = {}, [], []
    for book, items in sorted(by_book.items()):
        stored = Path(args.outputs) / f"doc-{book}.cand4.json"
        if stored.exists():
            blocks, pdf, start = json.loads(stored.read_text()), Path(args.pdfs) / f"{book}.pdf", 1
        else:
            blocks, pdf, start = window_blocks(refine, book, out)  # page 0 is book page start
        index = {p["page"]: p["page"] - start for p in items}
        after, spent = apply_stage(scripts, page_text, fonts, pdf, blocks, set(index.values()))
        timings += spent.values()
        for p in items:
            idx = index[p["page"]]
            before_page = [b for b in blocks if b.get("page_idx") == idx]
            after_page = [b for b in after if b.get("page_idx") == idx]
            texts = {"before": render_blocks(before_page), "after": render_blocks(after_page)}
            order = ["before", "after"]
            rng.shuffle(order)
            pid = f"{book}:{p['page']}"
            key[pid] = {"A": order[0], "B": order[1]}
            changed = sorted(set(slots_of(after_page)) - set(slots_of(before_page)))
            records.append({**p, "page_idx": idx, "changed": changed, "ms": spent.get(idx)})
            packet = [
                f"# {book} — page {p['page']}",
                f"Page image: {image_for(p, Path(args.scratch))}",
                "",
                "Formulas a previous reviewer listed on this page (descriptions only, "
                "check them against the image and add any they missed):",
                *[f"- {f['desc']}" for f in p["formulas"]],
            ]
            for label in "AB":
                packet += ["", f"## Parser {label}: raw blocks in reading order", texts[key[pid][label]]]
            (out / "packets" / f"{book}-p{p['page']}.md").write_text("\n".join(packet) + "\n")
    (out / "key.json").write_text(json.dumps(key, indent=1))
    (out / "pages.json").write_text(json.dumps(records, ensure_ascii=False, indent=1))
    print(
        "review pages", len(records), "changed", sum(bool(r["changed"]) for r in records),
        "stage ms/page median", round(statistics.median(timings), 1),
    )  # fmt: skip


def slots_of(blocks: list[dict]) -> list[str]:
    return [t for b in blocks if b.get("type") in SLOT_TYPES for t in slots(b)]


def corpus_document(job: tuple[str, str, str]) -> tuple[list[dict], list[tuple], int]:
    frozen, stored, pdf = job
    fonts, page_text, _, scripts = load_parser(Path(frozen))
    book = Path(stored).name[4:-11]
    blocks = json.loads(Path(stored).read_text())
    pages = {b["page_idx"] for b in blocks if b.get("page_idx") is not None}
    after, spent = apply_stage(scripts, page_text, fonts, Path(pdf), blocks, pages)
    rewrites = []
    for p in sorted(pages):
        old = slots_of([b for b in blocks if b.get("page_idx") == p])
        new = slots_of([b for b in after if b.get("page_idx") == p])
        # The stage may only add structure marks (and glyphs ODL dropped from
        # an extension font); any other character change is a defect.
        before, now = Counter("".join(old)), Counter("".join(new))
        for c in " \n":
            before.pop(c, None)
            now.pop(c, None)
        lost = before - now
        gained = Counter({c: n for c, n in (now - before).items() if c not in STRUCTURE})
        if lost or gained:
            rewrites.append(
                {"book": book, "page": p + 1, "before": "", "after": "", "edits": [],
                 "defect": {"lost": "".join(lost.elements()), "gained": "".join(gained.elements())}}
            )  # fmt: skip
        removed = [t for t in old if t not in new]
        added = [t for t in new if t not in old]
        for a, b in pair(removed, added):
            rewrites.append({"book": book, "page": p + 1, "before": a, "after": b, "edits": edits(a, b)})
    return rewrites, [(book, p, ms) for p, ms in spent.items()], len(pages)


def corpus(args) -> None:
    """Every rewrite on the 49-document corpus, a seeded sample of 30, and
    the stage's process time per page."""
    out = Path(args.out)
    jobs = [
        (args.parser, str(stored), str(Path(args.pdfs) / f"{stored.name[4:-11]}.pdf"))
        for stored in sorted(Path(args.outputs).glob("doc-*.cand4.json"))
        if (Path(args.pdfs) / f"{stored.name[4:-11]}.pdf").exists()
    ]
    rewrites, timings, pages_total = [], [], 0
    with multiprocessing.get_context("spawn").Pool(args.jobs) as pool:
        for found, spent, pages in pool.imap_unordered(corpus_document, jobs):
            rewrites += found
            timings += spent
            pages_total += pages
    rewrites.sort(key=lambda r: (r["book"], r["page"]))
    defects = [r for r in rewrites if "defect" in r]
    rewrites = [r for r in rewrites if "defect" not in r]
    sample = random.Random(20261013).sample(rewrites, min(30, len(rewrites)))
    ms = [t for _, _, t in timings]
    summary = {
        "documents": len(jobs),
        "pages": pages_total,
        "changed_slots": len(rewrites),
        "pages_changed": len({(r["book"], r["page"]) for r in rewrites}),
        "edits": sum(len(r["edits"]) for r in rewrites),
        "pages_with_character_changes": [(r["book"], r["page"], r["defect"]) for r in defects],
        "ms_per_page": {
            "mean": round(statistics.mean(ms), 2),
            "median": round(statistics.median(ms), 2),
            "p95": round(sorted(ms)[int(0.95 * len(ms))], 1),
            "max": round(max(ms), 1),
            "slowest": sorted(timings, key=lambda t: -t[2])[:5],
        },
        "by_document": {
            book: sum(r["book"] == book for r in rewrites) for book in sorted({r["book"] for r in rewrites})
        },
    }
    (out / "corpus.json").write_text(
        json.dumps({"summary": summary, "rewrites": rewrites}, ensure_ascii=False, indent=1)
    )
    lines = [f"# Corpus rewrites: 30 random of {len(rewrites)}", ""]
    for r in sample:
        lines.append(
            f"- {r['book']} p{r['page']}: "
            + " | ".join(f"`{a}` → `{b}`" for a, b in r["edits"][:6])
        )
    (out / "corpus-sample.md").write_text("\n".join(lines) + "\n")
    print(json.dumps(summary, indent=1))


def pair(removed: list[str], added: list[str]):
    """Match each removed slot to its most similar added slot."""
    left = list(added)
    for a in removed:
        if not left:
            yield a, ""
            continue
        best = max(left, key=lambda b: difflib.SequenceMatcher(None, a, b, autojunk=False).quick_ratio())
        left.remove(best)
        yield a, best
    for b in left:
        yield "", b


def edits(a: str, b: str) -> list[tuple[str, str]]:
    """Changed spans with a little context, as (before, after)."""
    out = []
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            continue
        lo, hi = max(0, i1 - 12), min(len(a), i2 + 12)
        out.append((a[lo:hi], b[max(0, j1 - 12) : min(len(b), j2 + 12)]))
    return out


def aggregate(args) -> None:
    out = Path(args.out)
    key = json.loads((out / "key.json").read_text())
    grades = []
    for f in sorted((out / "grades").glob("*.json")):
        grades += json.loads(f.read_text())
    table = {"before": {}, "after": {}}
    false_rewrites, pages = [], 0
    for g in grades:
        pid = g["page_id"]
        k = key[pid]
        pages += 1
        for f in g["formulas"]:
            for label in "AB":
                side = k[label]
                table[side][f[label]] = table[side].get(f[label], 0) + 1
        for label in "AB":
            if k[label] == "after":
                false_rewrites += [(pid, x) for x in g.get(f"{label}_false_rewrites", [])]
    print(json.dumps({"pages": pages, "grades": table, "false_rewrites": false_rewrites}, ensure_ascii=False, indent=1))


# Synthetic lines for the footnote guard: (pieces, expected words that change).
# A piece is (text, role): role "" is base text, "^" raised, "_" lowered,
# "^_" a raised and a lowered run stacked at the same x ("+0.03|-0.04").
GUARD_CASES = [
    ([("called a derivative in calculus", ""), ("3", "^"), (".", "")], []),
    ([("oxidation of diatomic hydrogen.", ""), ("13", "^"), (" Since", "")], []),
    ([("risk of cancer", ""), ("1,2", "^"), (" in adults", "")], []),
    ([("patients", ""), ("12–14", "^"), (" were excluded", "")], []),
    ([("(see Smith)", ""), ("4", "^"), (" for details", "")], []),
    ([("the 1", ""), ("st", "^"), (" and 2", ""), ("nd", "^"), (" rows", "")], []),
    ([("Total", ""), ("a", "^"), (" 1,200", "")], []),
    ([("in 2019", ""), ("7", "^"), (" the rate fell", "")], []),
    ([("Brand", ""), ("TM", "^"), (" products", "")], []),
    ([("see [MJS", ""), ("+", "^"), ("00] for", "")], []),
    ([("an area of 12 m", ""), ("2", "^"), (" of land", "")], ["m^2"]),
    ([("Volume = 10,597.5 ft", ""), ("3", "^")], ["ft^3"]),
    ([("= 0.785 × (3 ft)", ""), ("2", "^")], ["ft)^2"]),
    ([("so that x", ""), ("2", "^"), (" + y = 4", "")], ["x^2"]),
    ([("the value e", ""), ("−x", "^"), (" decays", "")], ["e^{−x}"]),
    ([("strain of 1.0 × 10", ""), ("−21", "^")], ["10^{−21}"]),
    ([("the redshift z = 0.09", ""), ("+0.03|−0.04", "^_")], ["0.09^{+0.03}_{−0.04}"]),
    ([("dissolved Ca", ""), ("2+", "^"), (" ions", "")], ["Ca^{2+}"]),
    ([("water is H", ""), ("2", "_"), ("O and", "")], ["H_2O"]),
    ([("the term x", ""), ("i", "_"), (" here", "")], ["x_i"]),
    ([("ammonium NH", ""), ("4", "_"), ("+", "^"), (" ions", "")], ["NH_4^+"]),
]


def guard_line(scripts, pieces) -> list:
    """Glyphs for one synthetic line: 10 pt text on baseline 100, 7 pt
    scripts raised 3.5 pt or lowered 2 pt, 5 pt advances."""
    line, x, spaced = [], 72.0, False

    def glyph(c, size, base):
        nonlocal x, spaced
        w = 0.5 * size
        g = scripts.Glyph(c, x, base - 0.8 * size, x + w, base + 0.2 * size, size, base, spaced=spaced)
        x += w
        spaced = False
        return g

    for text, role in pieces:
        if role == "^_":
            up, down = text.split("|")
            start = x
            line += [glyph(c, 7, 96.5) for c in up]
            x = start
            line += [glyph(c, 7, 102) for c in down]
            continue
        for c in text:
            if c == " ":
                x += 3
                spaced = True
                continue
            line.append(glyph(c, 7 if role else 10, {"": 100, "^": 96.5, "_": 102}[role]))
    return line


def selftest(args) -> None:
    sys.path.insert(0, str(ROOT / "parser"))
    scripts = importlib.import_module("odl.scripts")
    failures = 0
    for pieces, expected in GUARD_CASES:
        words = scripts._linear([], guard_line(scripts, pieces), math=None)
        changed = [
            scripts._render_word(w) for w in words if any(a.sups or a.subs for a in w)
        ]
        ok = changed == expected
        failures += not ok
        text = "".join(t for t, _ in pieces)
        print("ok  " if ok else "FAIL", repr(text), "->", changed, "" if ok else f"(expected {expected})")
    raise SystemExit(1 if failures else 0)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--parser", required=True, help="frozen parser directory (holds odl/)")
    p.add_argument("--outputs", required=True, help="directory of doc-<id>.cand4.json")
    p.add_argument("--pdfs", required=True, help="directory of <id>.pdf")
    p.add_argument("--scratch", required=True, help="holds fresh-eval/pages")
    p.add_argument("--out", required=True)
    c = sub.add_parser("corpus")
    c.add_argument("--parser", required=True)
    c.add_argument("--outputs", required=True)
    c.add_argument("--pdfs", required=True)
    c.add_argument("--out", required=True)
    c.add_argument("--jobs", type=int, default=4)
    a = sub.add_parser("aggregate")
    a.add_argument("--out", required=True)
    sub.add_parser("selftest", help="footnote-marker guard on synthetic lines")
    args = parser.parse_args()
    {"prepare": prepare, "corpus": corpus, "aggregate": aggregate, "selftest": selftest}[args.command](args)


if __name__ == "__main__":
    main()
