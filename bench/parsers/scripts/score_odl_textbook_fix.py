"""Score frozen role witnesses on full-book outputs; this is not an accuracy rate."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def label(value):
    return re.sub(r"[\W_]", "", unicodedata.normalize("NFKD", value).casefold())


def literal(value):
    return "".join(unicodedata.normalize("NFKC", value).split())


def on_page(chunk, page):
    return any(r["page"] == page for r in chunk["regions"])


def is_parent(chunk, text, *, exact=False):
    # Table labels can also be ordinary words within genuine section titles.
    # Only a whole breadcrumb component represents such a false parent.
    key = label(text)
    return bool(key) and any(
        label(part) == key if exact else key in label(part)
        for part in chunk["section_path"].split(" › ")
    )


def body_matches(blocks, chunks, page, text, role):
    normalize = literal if role == "math-fragment" else label
    key = normalize(text)
    raw = []
    for block in blocks:
        if block["page_idx"] + 1 != page:
            continue
        value = " ".join(
            [
                str(block.get("text", "")),
                re.sub(r"<[^>]+>", " ", block.get("table_body", "")),
                *block.get("list_items", []),
            ]
        )
        if key not in normalize(value):
            continue
        if role in {"table_header", "repeated_interior_table_header"} and (
            block["type"] not in {"list", "table"} and label(value) != label(text)
        ):
            continue
        raw.append(block)
    matches = []
    for chunk in chunks:
        if key not in normalize(chunk["text"]):
            continue
        # A multi-page chunk can contain the target only on another page.
        # Bind it to a matching raw block's own page and citation region.
        if any(
            r["page"] == page and r["bbox"] == b.get("bbox")
            for r in chunk["regions"]
            for b in raw
        ):
            matches.append(chunk)
    return raw, matches


def score(run, legacy_run=None, manifests=None):
    result = []
    if manifests:
        cases = [case for path in manifests for case in read(path)["sources"]]
    else:
        sources = read(ROOT / "bench/parsers/fixtures/selective-recovery-sources.json")
        known = read(ROOT / "bench/parsers/fixtures/textbook-recovery.json")
        cases = [c for c in known["cases"] if c["role"] == "known-textbook-development"]
        cases += sources["sources"]
    for case in cases:
        directory = run / "books" / case["id"]
        if not (directory / "corpus.json").exists() and legacy_run is not None:
            directory = legacy_run / "books" / case["id"]
        corpus = read(directory / "corpus.json")
        blocks = read(directory / "parsed/content_list.json")
        receipt = read(directory / "parsed/manifest.json")
        chunks = corpus["chunks"]
        checks = []
        for witness in case.get("witnesses", []):
            page, text = witness["page"], witness["text"]
            _, matches = body_matches(
                blocks, chunks, page, text, witness["source_role"]
            )
            parents = [c for c in chunks if is_parent(c, text)]
            checks.append(
                {
                    **witness,
                    "body_chunks_on_page": len(matches),
                    "parent_chunks": len(parents),
                    "passes": bool(matches)
                    if witness["source_role"] == "math-fragment"
                    else not parents,
                }
            )
        for witness in case.get("checks", []):
            for page in witness.get("pages", [witness.get("page")]):
                texts = witness.get("texts", [witness.get("text")])
                for text in texts:
                    raw, body = body_matches(
                        blocks, chunks, page, text, witness["role"]
                    )
                    parents = [
                        c
                        for c in chunks
                        if on_page(c, page)
                        and is_parent(
                            c,
                            text,
                            exact=witness["role"]
                            in {
                                "table_header",
                                "diagram_label",
                                "repeated_interior_table_header",
                            },
                        )
                    ]
                    checks.append(
                        {
                            "page": page,
                            "text": text,
                            "role": witness["role"],
                            "body_chunks_on_page": len(body),
                            "parent_chunks_on_page": len(parents),
                            "matching_raw_blocks": len(raw),
                            "passes": bool(parents)
                            if witness["role"] == "genuine_heading"
                            else (
                                not parents
                                and (
                                    bool(body)
                                    if witness.get("must_preserve_body")
                                    else True
                                )
                            ),
                        }
                    )
        result.append(
            {
                "book": case["id"],
                "pages": corpus["pages"],
                "chunks": len(chunks),
                "source_sha256": corpus["book"]["sha256"],
                "parser_version": receipt["parser_version"],
                "chunker_version": corpus["chunker_version"],
                "content_sha256": hashlib.sha256(
                    (directory / "parsed/content_list.json").read_bytes()
                ).hexdigest(),
                "role_counts": dict(
                    Counter(b["_source_role"] for b in blocks if "_source_role" in b)
                ),
                "server_parse_seconds": receipt["parse_receipt"]["measurements"][
                    "_server_parse_ms"
                ]
                / 1000,
                "execution_seconds": receipt["parse_receipt"]["measurements"][
                    "_execution_ms"
                ]
                / 1000,
                "queue_seconds": receipt["parse_receipt"]["measurements"]["_queue_ms"]
                / 1000,
                "checks": checks,
            }
        )
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--legacy-run", type=Path)
    parser.add_argument("--manifest", type=Path, action="append")
    args = parser.parse_args()
    results = score(args.run, args.legacy_run, args.manifest)
    args.output.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    for result in results:
        print(json.dumps({k: v for k, v in result.items() if k != "checks"}))
        for check in result["checks"]:
            if not check["passes"]:
                print("UNRESOLVED " + json.dumps(check))
