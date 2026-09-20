"""Local A1/A2 experiment over cached parser blocks; never parses or publishes.

uv run --frozen python bench/parsers/scripts/experiment_prince_headings.py --self-check
uv run --frozen python bench/parsers/scripts/experiment_prince_headings.py
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "pipeline"), str(ROOT / "parser")]
from odl.headings import _literal, _outline_title

from pipeline.retrieval.chunking import CHUNKER_VERSION, clean_inline
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

OUTPUT = ROOT / "bench/parsers/reports/local/2026-09-20-prince-headings"
CONTROL = ROOT / "bench/parsers/reports/local/2026-09-16-odl-shared-fix/final/books"
PHYSICS = ROOT / "data/knowledge-base/runs/physics/books/physics/parsed"
PDF = (
    ROOT
    / "data/knowledge-base/sources/a3f75487411ef13d0270c65fc801ceff2b28e6b339afed9b407fe477f7e8453e.pdf"
)


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def source_evidence(
    blocks: list[dict], document: pymupdf.Document
) -> dict[int, list[dict]]:
    """The existing role repair's literal span-center match, on heading blocks only."""
    pages = {}
    evidence = {}
    for index, block in enumerate(blocks):
        box, page_index = block.get("bbox", []), block.get("page_idx")
        if (
            block.get("type") != "text"
            or not block.get("text_level")
            or len(box) != 4
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
        spans = [
            s
            for s in pages[page_index]
            if rect.contains(
                pymupdf.Point(
                    (s["bbox"][0] + s["bbox"][2]) / 2, (s["bbox"][1] + s["bbox"][3]) / 2
                )
            )
        ]
        if spans and _literal(block["text"]) == _literal(
            " ".join(s["text"] for s in spans)
        ):
            evidence[index] = spans
    return evidence


def changes(
    blocks: list[dict], toc: list[list], evidence: dict
) -> tuple[set[int], dict[int, int], bool]:
    outline = defaultdict(list)
    for row in toc:
        level, title, page = row[:3]
        if page > 0:
            outline[page - 1, _outline_title(title)].append(level)
    banners = defaultdict(list)
    for index, spans in evidence.items():
        block = blocks[index]
        key = block["page_idx"], _outline_title(block["text"])
        if key in outline:
            continue
        box = block["bbox"]
        text = " ".join(block["text"].split())
        margin = 0 <= box[1] < box[3] <= 65 or 935 <= box[1] < box[3] <= 1000
        if (
            not margin
            or not any(c.isalpha() for c in text)
            or re.fullmatch(r"\d{1,4}\s+.+|.+?\s+\d{1,4}", text)
        ):
            continue
        style = max(spans, key=lambda s: len(s["text"]))
        # Exactly the current role repair's geometry/style grouping, without a folio.
        banners[
            _literal(text),
            box[3] <= 65,
            round(box[1] / 10),
            style["font"],
            round(style["size"]),
        ].append(index)
    discarded = {
        index
        for group in banners.values()
        if len({blocks[i]["page_idx"] for i in group}) >= 3
        for index in group
    }
    anchors = {}
    roots_found = 0
    for row in toc:
        level, title, page = row[:3]
        choices = []
        for i in evidence:
            block = blocks[i]
            if block["page_idx"] != page - 1:
                continue
            texts = [block["text"]]
            # An appendix title can occupy two adjacent heading blocks.
            if i + 1 in evidence and blocks[i + 1]["page_idx"] == page - 1:
                texts.append(block["text"] + " " + blocks[i + 1]["text"])
            if any(_outline_title(text) == _outline_title(title) for text in texts):
                exact = any(_literal(text) == _literal(title) for text in texts)
                choices.append((i, exact))
        if any(exact for _, exact in choices):
            choices = [(i, exact) for i, exact in choices if exact]
        if len(choices) > 1 and len(row) > 3 and row[3].get("y") is not None:
            # Only direct GoTo destinations have reliable top-origin coordinates.
            # Require one matching title within 6.5% page height of that position.
            choices = [
                (i, exact)
                for i, exact in choices
                if abs(blocks[i]["bbox"][1] - row[3]["y"]) <= 65
            ]
        if len(choices) == 1:
            i = choices[0][0]
            if i not in anchors or anchors[i] == level:
                anchors[i] = level
                roots_found += level == 1
    root_count = sum(row[0] == 1 and row[2] > 0 for row in toc)
    return discarded, anchors, root_count > 0 and roots_found == root_count


def candidate(
    blocks: list[dict],
    discarded: set[int],
    anchors: dict[int, int],
    arm: str,
    roots_complete: bool = True,
) -> list[dict]:
    result = copy.deepcopy(blocks)
    if arm in {"banner_only", "combined", "full_outline", "demote_frontmatter"}:
        for index in discarded:
            result[index]["type"] = "discarded"
            result[index].pop("text_level")
            result[index]["_source_role"] = "running-banner"
    if roots_complete and arm in {"roots_only", "combined", "full_outline"}:
        for index, level in anchors.items():
            if level == 1 or arm == "full_outline":
                result[index]["text_level"] = level
    if arm == "demote_frontmatter":
        # Deliberately compare the suggested name-based alternative on physics only.
        for index, level in anchors.items():
            if level == 1 and _literal(result[index]["text"]) in {
                "contents",
                "preface",
            }:
                result[index].pop("text_level")
    return result


def pack(blocks: list[dict], furniture: list[str], pdf: Path):
    return retain_headings(blocks, pdf, pack_blocks(blocks, frozenset(furniture)))


def body_coverage(blocks: list[dict], chunks: list) -> dict[int, bool]:
    """Literal body text against chunks citing that exact source block's box/page.

    Long blocks may be split across chunks. This is a retention proxy, not an
    extraction-accuracy score; baseline omissions remain separately measurable.
    """
    by_region = defaultdict(list)
    for chunk in chunks:
        for region in chunk.regions:
            by_region[region.page - 1, tuple(region.bbox)].append(chunk.text)
    result = {}
    for i, block in enumerate(blocks):
        if (
            block.get("type") != "text"
            or block.get("text_level")
            or not block.get("text", "").strip()
        ):
            continue
        values = by_region.get(
            (block.get("page_idx"), tuple(block.get("bbox", []))), []
        )
        wanted = _literal(clean_inline(block["text"]))
        result[i] = wanted in _literal(" ".join(values))
    return result


def metrics(
    original: list[dict],
    blocks: list[dict],
    chunks: list,
    baseline: list,
    anchors: dict[int, int],
    base_coverage: dict[int, bool],
    first_body: int | None,
) -> dict:
    coverage = body_coverage(original, chunks)
    old_text = Counter(c.text for c in baseline)
    new_text = Counter(c.text for c in chunks)
    by_page = defaultdict(list)
    for c in chunks:
        for region in c.regions:
            by_page[region.page].append(c)
    retained = []
    for i in anchors:
        b = blocks[i]
        retained.append(
            any(
                _literal(b["text"]) in _literal(c.indexed_text())
                for c in by_page[b["page_idx"] + 1]
            )
        )
    bad = lambda c: any(
        p.casefold() in {"contents", "preface"} for p in c.section_path.split(" › ")
    )
    selected = [
        c for c in chunks if first_body and c.page_start and c.page_start >= first_body
    ]
    root_indices = sorted(i for i, level in anchors.items() if level == 1)
    root_titles = {_literal(original[i]["text"]): i for i in root_indices}
    locations = {
        (b["page_idx"] + 1, tuple(b["bbox"])): i
        for i, b in enumerate(original)
        if "page_idx" in b and len(b.get("bbox", [])) == 4
    }
    stale_roots = []
    for c in chunks:
        positions = [
            locations[r.page, tuple(r.bbox)]
            for r in c.regions
            if (r.page, tuple(r.bbox)) in locations
        ]
        active = [i for i in root_indices if positions and i <= min(positions)]
        if active and any(
            root_titles.get(_literal(part), active[-1]) < active[-1]
            for part in c.section_path.split(" › ")
        ):
            stale_roots.append(
                {"page_start": c.page_start, "section_path": c.section_path}
            )
    return {
        "chunks": len(chunks),
        "banner_breadcrumb_chunks": sum(
            "Access for free at openstax.org" in c.section_path for c in chunks
        ),
        "frontmatter_breadcrumb_chunks_after_first_chapter": sum(
            bad(c) for c in selected
        )
        if first_body
        else None,
        "chunks_after_first_chapter": len(selected) if first_body else None,
        "matched_outline_headings": len(anchors),
        "matched_outline_headings_still_typed": sum(
            bool(blocks[i].get("text_level")) for i in anchors
        ),
        "matched_outline_headings_readable_on_page": sum(retained),
        "body_text_blocks": len(coverage),
        "body_text_blocks_literal_covered": sum(coverage.values()),
        "previously_covered_body_blocks_lost": [
            i for i in coverage if base_coverage[i] and not coverage[i]
        ],
        "body_block_payload_changes": sum(
            b != blocks[i] for i, b in enumerate(original) if not b.get("text_level")
        ),
        "unchanged_canonical_chunk_texts_multiset": sum((old_text & new_text).values()),
        "removed_canonical_chunk_texts_multiset": sum((old_text - new_text).values()),
        "added_canonical_chunk_texts_multiset": sum((new_text - old_text).values()),
        "canonical_text_sequence_equal": [c.text for c in chunks]
        == [c.text for c in baseline],
        "complete_chunk_records_equal": [asdict(c) for c in chunks]
        == [asdict(c) for c in baseline],
        "frontmatter_titles_on_own_page": {
            b["text"]: any(
                _literal(b["text"]) in _literal(c.indexed_text())
                for c in by_page[b["page_idx"] + 1]
            )
            for b in original
            if b.get("text_level")
            and _literal(b.get("text", "")) in {"contents", "preface"}
        },
        "first_chapter_paths": list(
            dict.fromkeys(c.section_path for c in selected[:15])
        ),
        "stale_outline_root_ancestor_chunks": len(stale_roots),
        "stale_outline_root_examples": stale_roots[:5],
    }


def self_check() -> None:
    blocks = [
        {
            "type": "text",
            "text": "Free textbook",
            "text_level": 25,
            "page_idx": page,
            "bbox": [100, 955, 300, 970],
        }
        for page in range(3)
    ]
    blocks += [
        {
            "type": "text",
            "text": "Contents",
            "text_level": 1,
            "page_idx": 3,
            "bbox": [100, 100, 500, 150],
        },
        {
            "type": "text",
            "text": "PREFACE",
            "text_level": 3,
            "page_idx": 4,
            "bbox": [100, 100, 500, 150],
        },
        {
            "type": "text",
            "text": "Mechanics",
            "text_level": 5,
            "page_idx": 5,
            "bbox": [100, 100, 500, 150],
        },
        {
            "type": "text",
            "text": "Motion",
            "text_level": 10,
            "page_idx": 5,
            "bbox": [100, 200, 500, 240],
        },
        {
            "type": "text",
            "text": "A source paragraph about motion remains readable.",
            "page_idx": 5,
            "bbox": [100, 260, 800, 300],
        },
    ]
    spans = lambda b: [{"text": b["text"], "font": "Font", "size": 10}]
    evidence = {i: spans(b) for i, b in enumerate(blocks[:-1])}
    toc = [
        [1, "Contents", 4],
        [1, "Preface", 5],
        [1, "Chapter 1 Mechanics", 6],
        [2, "Motion", 6],
    ]
    discarded, anchors, complete = changes(blocks, toc, evidence)
    assert complete
    assert discarded == {0, 1, 2}
    fixed = candidate(blocks, discarded, anchors, "combined")
    chunks = pack_blocks(fixed, frozenset())
    assert chunks[0].section_path == "Mechanics › Motion"
    assert chunks[0].text == blocks[-1]["text"]
    assert (
        fixed[3]["text_level"] == fixed[4]["text_level"] == fixed[5]["text_level"] == 1
    )
    assert (
        changes(blocks, toc, {i: x for i, x in evidence.items() if i != 1})[0] == set()
    )
    protected = toc + [[1, "Free textbook", 1]]
    assert changes(blocks, protected, evidence)[0] == set()
    assert not changes(blocks, toc + [[1, "Missing root", 7]], evidence)[2]
    assert candidate(blocks, set(), anchors, "roots_only", False) == blocks
    # Repeated titles on the same page need the direct outline destination.
    duplicate = blocks + [{**blocks[5], "bbox": [100, 750, 500, 790]}]
    more_evidence = {**evidence, len(blocks): spans(duplicate[-1])}
    toc[2].append({"y": 85})
    assert changes(duplicate, toc, more_evidence)[2]
    split = blocks + [
        {
            "type": "text",
            "text": "APPENDIX A",
            "text_level": 3,
            "page_idx": 7,
            "bbox": [100, 80, 500, 120],
        },
        {
            "type": "text",
            "text": "Reference tables",
            "text_level": 7,
            "page_idx": 7,
            "bbox": [100, 155, 500, 190],
        },
    ]
    split_evidence = {
        **evidence,
        len(blocks): spans(split[-2]),
        len(blocks) + 1: spans(split[-1]),
    }
    assert changes(
        split, toc + [[1, "Appendix A Reference tables", 8]], split_evidence
    )[2]
    print(
        "self-check passed: source-bound banners, protected outline, complete sibling roots, duplicate/split titles, body retention"
    )


def run(book: str, output: Path) -> dict:
    parsed = PHYSICS if book == "physics" else CONTROL / book / "parsed"
    # Only read control book metadata from the old corpus. Never use its chunks.
    pdf = (
        PDF
        if book == "physics"
        else ROOT / read(parsed.parent / "corpus.json")["book"]["pdf_path"]
    )
    measured_pdf = parsed / "parsed.pdf" if (parsed / "parsed.pdf").is_file() else pdf
    blocks, refinement = (
        read(parsed / "content_list.json"),
        read(parsed / "refinement.json"),
    )
    with pymupdf.open(measured_pdf) as document:
        toc = [
            row[:3]
            + [
                {
                    "y": row[3]["to"].y / document[row[2] - 1].rect.height * 1000
                    if row[2] > 0 and row[3].get("kind") == 1 and "to" in row[3]
                    else None
                }
            ]
            for row in document.get_toc(simple=False)
        ]
        evidence = source_evidence(blocks, document)
        discarded, anchors, roots_complete = changes(blocks, toc, evidence)
        meta = {
            "pages": len(document),
            "producer": document.metadata.get("producer"),
            "outline_entries": len(toc),
            "source_matched_heading_blocks": len(evidence),
            "outline_roots": sum(row[0] == 1 for row in toc),
            "matched_outline_roots": sum(level == 1 for level in anchors.values()),
            "outline_roots_complete": roots_complete,
        }
    first_body = 17 if book == "physics" else None
    arms = ["baseline", "banner_only", "roots_only", "combined"]
    if book == "physics":
        arms += ["full_outline", "demote_frontmatter"]
    baseline = pack(blocks, refinement["furniture"], measured_pdf)
    base_coverage = body_coverage(blocks, baseline)
    result = {
        "book": book,
        **meta,
        "parser_identity": read(parsed / "manifest.json")["parser_version"],
        "inputs": {
            str(p.relative_to(ROOT)): digest(p)
            for p in [
                pdf,
                parsed / "content_list.json",
                parsed / "refinement.json",
                parsed / "manifest.json",
            ]
        },
        "new_banner_blocks": len(discarded),
        "new_banner_pages": len({blocks[i]["page_idx"] for i in discarded}),
        "outline_root_level_changes": sum(
            roots_complete and level == 1 and blocks[i]["text_level"] != 1
            for i, level in anchors.items()
        ),
        "arms": {},
    }
    write(
        output / book / "evidence.json",
        {
            "toc": toc,
            "banners": [{"block_index": i, **blocks[i]} for i in sorted(discarded)],
            "outline_anchors": [
                {"block_index": i, "outline_level": level, **blocks[i]}
                for i, level in anchors.items()
            ],
        },
    )
    for arm in arms:
        started = time.perf_counter()
        revised = candidate(blocks, discarded, anchors, arm, roots_complete)
        chunks = (
            baseline
            if arm == "baseline"
            else pack(revised, refinement["furniture"], measured_pdf)
        )
        result["arms"][arm] = metrics(
            blocks, revised, chunks, baseline, anchors, base_coverage, first_body
        )
        result["arms"][arm]["seconds_pack_and_metrics"] = round(
            time.perf_counter() - started, 3
        )
        write(output / book / f"{arm}-chunks.json", [asdict(c) for c in chunks])
        print(
            book,
            arm,
            "chunks",
            len(chunks),
            "bad paths",
            result["arms"][arm]["frontmatter_breadcrumb_chunks_after_first_chapter"],
            flush=True,
        )
    write(output / book / "metrics.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument(
        "--book",
        choices=[
            "physics",
            "os4",
            "ahss4",
            "lsj",
            "exo7-analyse",
            "hefferon-linear-algebra",
        ],
    )
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    books = (
        [args.book]
        if args.book
        else [
            "physics",
            "os4",
            "ahss4",
            "lsj",
            "exo7-analyse",
            "hefferon-linear-algebra",
        ]
    )
    results = [run(book, OUTPUT) for book in books]
    code = [
        Path(__file__),
        ROOT / "parser/odl/headings.py",
        ROOT / "pipeline/pipeline/retrieval/chunking.py",
        ROOT / "pipeline/pipeline/retrieval/packing.py",
        ROOT / "pipeline/pipeline/retrieval/headings.py",
        ROOT / "pipeline/pipeline/config.py",
    ]
    write(
        OUTPUT / ("summary.json" if not args.book else f"{args.book}-summary.json"),
        {
            "chunker_version": CHUNKER_VERSION,
            "code_sha256": {str(p.relative_to(ROOT)): digest(p) for p in code},
            "books": results,
        },
    )


if __name__ == "__main__":
    main()
