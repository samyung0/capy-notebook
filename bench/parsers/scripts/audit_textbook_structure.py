"""Measure saved textbook heading errors without parsing or changing the index.

Run --self-check for the diagnostic's narrow margin-label controls, then:
  .venv/Scripts/python.exe bench/parsers/scripts/audit_textbook_structure.py
Raw receipts go to reports/local/2026-09-16-structure-baseline/audit.json.
Known body-role witnesses are visually reviewed development cases, not an
unbiased estimate of all structural errors. Header detection is also a narrow
diagnostic, not a proposed production classifier.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from collections import defaultdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RUN = ROOT / "data/knowledge-base-pilot/run"
DEFAULT_FIXTURE = ROOT / "bench/parsers/fixtures/textbook-structure-witnesses.json"
DEFAULT_OUTPUT = (
    ROOT / "bench/parsers/reports/local/2026-09-16-structure-baseline/audit.json"
)


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def norm(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split()).casefold()


def path_parts(value: dict) -> list[str]:
    return [norm(part) for part in value["section_path"].split(" › ") if part]


def margin_key(block: dict) -> str | None:
    """Thin top-band heading with a folio equal to its PDF page number."""
    box = block.get("bbox", [])
    if (
        not block.get("text_level", 0)
        or len(box) != 4
        or not (0 <= box[1] < box[3] <= 60)
    ):
        return None
    page = block.get("page_idx")
    if not isinstance(page, int):
        return None
    text = norm(block.get("text", ""))
    folio = str(page + 1)
    if text.startswith(folio + " "):
        text = text[len(folio) + 1 :]
    elif text.endswith(" " + folio):
        text = text[: -len(folio) - 1]
    else:
        return None
    return text if any(ch.isalpha() for ch in text) else None


def count_groups(chunks: list[dict], omitted: set[str]) -> int:
    paths = [tuple(p for p in path_parts(c) if p not in omitted) for c in chunks]
    return sum(i == 0 or path != paths[i - 1] for i, path in enumerate(paths))


def summarize_hits(chunks: list[dict]) -> dict:
    return {
        "chunks": len(chunks),
        "first_page": min((c["page_start"] for c in chunks), default=None),
        "last_page": max(
            (c.get("page_end") or c["page_start"] for c in chunks), default=None
        ),
        "high_confidence_without_reasons": sum(
            c["confidence"] is not None
            and c["confidence"] >= 0.9
            and not c["confidence_reasons"]
            for c in chunks
        ),
        "chunk_ids": [c["id"] for c in chunks],
        "example_paths": list(dict.fromkeys(c["section_path"] for c in chunks))[:3],
    }


def audit_book(book: dict, run: Path, witnesses: list[dict]) -> dict:
    directory = run / "books" / book["id"]
    corpus = read(directory / "corpus.json")
    blocks = read(directory / "parsed/content_list.json")
    source = ROOT / book["pdf_path"]
    if sha(source) != book["sha256"] or corpus["book"]["sha256"] != book["sha256"]:
        raise ValueError("Source identity mismatch")
    chunks = [
        c
        for c in corpus["chunks"]
        if (c.get("page_start") or 0) >= book["first_content_page"]
    ]
    groups = defaultdict(list)
    for index, block in enumerate(blocks):
        key = margin_key(block)
        if key:
            groups[key].append((index, block))
    candidates = [
        (index, block)
        for items in groups.values()
        if len({b["page_idx"] for _, b in items}) >= 3
        for index, block in items
        if block["page_idx"] + 1 >= book["first_content_page"]
    ]
    margin = []
    with pymupdf.open(source) as pdf:
        for index, block in candidates:
            page = pdf[block["page_idx"]]
            clip = pymupdf.Rect(0, 0, page.rect.width, page.rect.height * 0.065)
            source_text = norm(page.get_text(clip=clip, sort=True))
            matched = norm(block["text"]).replace(" ", "") in source_text.replace(
                " ", ""
            )
            margin.append(
                {
                    "block_index": index,
                    "page": block["page_idx"] + 1,
                    "text": block["text"],
                    "source_text_matches": matched,
                }
            )
    header_keys = {norm(m["text"]) for m in margin if m["source_text_matches"]}
    witness_results = []
    for witness in witnesses:
        block = blocks[witness["block_index"]]
        if (
            block.get("text") != witness["text"]
            or block["page_idx"] + 1 != witness["page"]
        ):
            raise ValueError("Witness does not match the frozen block")
        hits = [c for c in chunks if norm(witness["text"]) in path_parts(c)]
        witness_results.append(
            {
                **witness,
                "heading_level": block.get("text_level"),
                "bbox": block["bbox"],
                **summarize_hits(hits),
            }
        )
    body_keys = {norm(w["text"]) for w in witnesses}
    header_hits = [c for c in chunks if header_keys.intersection(path_parts(c))]
    body_hits = [c for c in chunks if body_keys.intersection(path_parts(c))]
    union_hits = [
        c for c in chunks if (header_keys | body_keys).intersection(path_parts(c))
    ]
    eligible_ids = {c["id"] for c in chunks}
    excerpts = [
        e for e in corpus["excerpts"] if eligible_ids.intersection(e["chunk_ids"])
    ]
    return {
        "book": book["id"],
        "source_sha256": book["sha256"],
        "corpus_sha256": sha(directory / "corpus.json"),
        "blocks_sha256": sha(directory / "parsed/content_list.json"),
        "release_sha": corpus["release_sha"],
        "chunker_version": corpus["chunker_version"],
        "searchable_chunks": len(chunks),
        "searchable_excerpts": len(excerpts),
        "explicit_equation_blocks": sum(b["type"] == "equation" for b in blocks),
        "table_blocks": sum(b["type"] == "table" for b in blocks),
        "margin_candidates": margin,
        "header_hits": summarize_hits(header_hits),
        "body_role_hits": summarize_hits(body_hits),
        "union_hits": summarize_hits(union_hits),
        "witnesses": witness_results,
        "excerpts_with_matched_header": sum(
            bool(header_keys.intersection(path_parts(e))) for e in excerpts
        ),
        "metadata_group_diagnostic": {
            "current": count_groups(chunks, set()),
            "omit_matched_headers": count_groups(chunks, header_keys),
            "omit_headers_and_reviewed_body_roles": count_groups(
                chunks, header_keys | body_keys
            ),
            "limitation": "Removes path components only. No repacking or hierarchy reconstruction; not a validated fix.",
        },
    }


def self_check() -> None:
    base = {"page_idx": 49, "bbox": [40, 28, 850, 42], "text_level": 20}
    assert (
        margin_key({**base, "text": "50 CHAPTER 2. SUMMARIZING DATA"})
        == "chapter 2. summarizing data"
    )
    assert (
        margin_key({**base, "text": "2.1. EXAMINING DATA 50"}) == "2.1. examining data"
    )
    assert (
        margin_key({**base, "text": "2.1 Examining data", "bbox": [140, 67, 710, 86]})
        is None
    )
    assert margin_key({**base, "text": "51 CHAPTER 2. SUMMARIZING DATA"}) is None
    assert margin_key({**base, "text": "50"}) is None
    assert (
        margin_key(
            {**base, "text": "n = 50 n = 100 n = 250", "bbox": [220, 110, 780, 135]}
        )
        is None
    )
    print("6 source-role diagnostic controls passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, default=DEFAULT_RUN)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    fixture = read(args.fixture)
    manifest = read(ROOT / fixture["source_manifest"])
    results = [
        audit_book(
            b, args.run, [w for w in fixture["witnesses"] if w["book"] == b["id"]]
        )
        for b in manifest["books"]
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {"fixture_sha256": sha(args.fixture), "books": results},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            [
                {
                    key: b[key]
                    for key in (
                        "book",
                        "searchable_chunks",
                        "searchable_excerpts",
                        "explicit_equation_blocks",
                        "table_blocks",
                        "excerpts_with_matched_header",
                        "metadata_group_diagnostic",
                    )
                }
                | {
                    "header_chunks": b["header_hits"]["chunks"],
                    "reviewed_body_role_chunks": b["body_role_hits"]["chunks"],
                    "union_chunks": b["union_hits"]["chunks"],
                    "source_matched_header_blocks": sum(
                        m["source_text_matches"] for m in b["margin_candidates"]
                    ),
                }
                for b in results
            ],
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
