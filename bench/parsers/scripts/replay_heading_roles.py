"""Replay the working-tree heading-role rules against a baseline revision.

Runs ``headings.correct_roles`` then ``furniture.mark_page_numbers`` from the
working tree and from ``--base`` (a git revision, extracted with ``git
archive``) on the same saved ``content_list.json`` and its PDF. The ODL Java
stage does not run, so this measures only the role rules. Blocks that the
saved run already discarded or marked as page numbers are not re-evaluated.

- ``regression`` mode: for each saved output under ``--outputs`` (later
  directories override earlier ones by document name), count headings the
  working tree removes as banners or folios, bullet demotions, other block
  changes, and body blocks whose heading path gains a component.
- ``books`` mode: count wrong-path chunks per knowledge-base book with the
  section-path investigation's ``measure.py`` (``--measure-dir``).

``--strict`` hides the text of blocks the saved run already discarded or
marked as page numbers. Folio families then cannot use them to prove their
page offset, which gives a lower bound.

    uv run --project pipeline python bench/parsers/scripts/replay_heading_roles.py regression \
      --outputs bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/native-alt-r2 \
                bench/parsers/reports/local/2026-09-20-parser-repairs/final \
      --pdfs bench/parsers/fixtures/local --output replay.json
"""

from __future__ import annotations

import argparse
import copy
import io
import json
import subprocess
import sys
import tarfile
import tempfile
from collections import Counter
from pathlib import Path

import pymupdf

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO / "parser"), str(REPO / "pipeline")]

from odl import furniture, headings  # noqa: E402

from pipeline.retrieval.chunking import (  # noqa: E402
    _heading_boundary_level,
    _is_furniture,
    _repeated_across_pages,
    clean_inline,
)


def baseline(revision: str, root: Path):
    """Import ``parser/odl`` at ``revision`` as the package ``odl_base``."""
    archive = subprocess.run(
        ["git", "archive", "--format=tar", revision, "parser/odl"],
        cwd=REPO,
        check=True,
        capture_output=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(root, filter="data")
    (root / "parser/odl").rename(root / "odl_base")
    sys.path.insert(0, str(root))
    from odl_base import furniture as base_furniture, headings as base_headings

    return lambda blocks, doc: base_furniture.mark_page_numbers(
        base_headings.correct_roles(blocks, doc), doc
    )


def current(strict: bool):
    def run(blocks, doc):
        hidden = {
            i: b["text"]
            for i, b in enumerate(blocks)
            if strict and b.get("type") in ("discarded", "page_number") and "text" in b
        }
        for i in hidden:
            blocks[i]["text"] = ""
        out = furniture.mark_page_numbers(headings.correct_roles(blocks, doc), doc)
        for i, text in hidden.items():
            out[i]["text"] = text
        return out

    return run


def body_paths(blocks: list[dict]) -> dict[int, tuple[str, ...]]:
    """The chunker's heading stack in front of each body text block."""
    keys = frozenset(_repeated_across_pages(blocks))
    stack: list[tuple[int, str]] = []
    paths = {}
    for i, block in enumerate(blocks):
        if _is_furniture(block, keys):
            continue
        boundary = _heading_boundary_level(block)
        if boundary is not None:
            while stack and stack[-1][0] >= boundary:
                stack.pop()
            continue
        if block.get("type") != "text":
            continue
        level = block.get("text_level")
        text = clean_inline(str(block.get("text") or "")).strip()
        if isinstance(level, int) and level > 0 and text:
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, "".join(text.split())))
        elif not level:
            paths[i] = tuple(t for _, t in stack)
    return paths


def regression(args, base, new) -> dict:
    docs = {}
    for directory in args.outputs:
        docs.update({p.parent.name: p for p in sorted(directory.glob("*/content_list.json"))})
    table = {}
    for name, path in docs.items():
        blocks = json.loads(path.read_text(encoding="utf-8"))
        with pymupdf.open(next(args.pdfs.glob(f"**/{name}.pdf"))) as doc:
            old = base(copy.deepcopy(blocks), doc)
            fresh = new(copy.deepcopy(blocks), doc)
        counts = Counter()
        for a, b in zip(old, fresh, strict=True):
            heading = a.get("type") == "text" and a.get("text_level")
            if heading and b.get("type") in ("discarded", "page_number"):
                counts["banner_or_folio"] += 1
            elif heading and b.get("_source_role") == "bullet-item":
                counts["bullet"] += 1
            elif a != b:
                counts["other_change"] += 1
        before, after = body_paths(old), body_paths(fresh)
        counts["body_new_ancestor"] = sum(
            1 for i, p in after.items() if set(p) - set(before.get(i, ()))
        )
        table[name] = dict(counts)
        print(name[:36].ljust(36), table[name], flush=True)
    return table


def books(args, base, new) -> dict:
    sys.path.insert(0, str(args.measure_dir))
    from books import books as intake
    from measure import measure

    table = {}
    for book in intake():
        if (book["dir"] / "corpus.json").exists():
            table[book["id"]] = {
                "saved": measure(book)["wrong_chunks"],
                "base": measure(book, base)["wrong_chunks"],
                "current": measure(book, new)["wrong_chunks"],
            }
            print(book["id"][:40].ljust(40), table[book["id"]], flush=True)
    return table


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["regression", "books"])
    parser.add_argument("--base", default="HEAD", help="baseline git revision")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--outputs", type=Path, nargs="+", default=[])
    parser.add_argument("--pdfs", type=Path, default=REPO / "bench/parsers/fixtures/local")
    parser.add_argument("--measure-dir", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as root:
        base = baseline(args.base, Path(root))
        run = regression if args.mode == "regression" else books
        table = run(args, base, current(args.strict))
    total = Counter()
    for row in table.values():
        total.update(row)
    args.output.write_text(json.dumps({"documents": table, "total": total}, indent=1), encoding="utf-8")
    print("TOTAL", dict(total))


if __name__ == "__main__":
    main()
