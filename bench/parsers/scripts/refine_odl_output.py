"""Compose the reviewed third-pass native repairs before one final chunk pass."""

from __future__ import annotations

import argparse
import copy
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import experiment_odl_table_geometry as geometry
import experiment_odl_table_integration as tables
import pymupdf
from compare_opendataloader import odl_content_list
from experiment_odl_column_continuation import repair_columns
from experiment_odl_exponents import restore_exponents
from experiment_odl_heading_retention import retain_headings
from experiment_odl_list_geometry import repair_list_geometry
from experiment_odl_list_text import repair_lists
from experiment_odl_native_tables import chunk_native_bounded, contextualize
from experiment_odl_native_text import read, repair_text, save, sha


def mark_footer_tables(blocks, native_document):
    """Carry explicit footer ancestry through the adapter's flattened tables."""
    counts, footers = Counter(), {}

    def visit(node, in_footer=False):
        identity = node.get("id")
        counts[identity] += 1
        in_footer = in_footer or node.get("type") == "footer"
        if in_footer and node.get("type") == "table":
            footers[identity] = node
        for key in ("kids", "list items", "toc items", "rows", "cells"):
            for child in node.get(key, []):
                visit(child, in_footer)

    visit(native_document)
    result, decisions = copy.deepcopy(blocks), []
    for index, block in enumerate(result):
        identity = block.get("_native_id")
        node = footers.get(identity)
        if (
            block.get("type") != "table"
            or identity is None
            or counts[identity] != 1
            or node is None
        ):
            continue
        if node.get("page number") != block.get("page_idx", -1) + 1:
            continue
        if odl_content_list(node, [])[0]["table_body"] != block.get("table_body"):
            continue
        block["type"] = "footer"
        decisions.append(
            {"index": index, "native_id": identity, "page": block["page_idx"] + 1}
        )
    return result, decisions


def refine(blocks, pdf, native_document, *, table_recovery):
    phases, evidence = {}, {}
    started = time.perf_counter()
    blocks, evidence["context"] = contextualize(blocks, strict=False)
    phases["context"] = time.perf_counter() - started
    for name, operation in [
        ("footer_tables", lambda b: mark_footer_tables(b, native_document)),
        ("list_geometry", lambda b: repair_list_geometry(b, native_document, pdf)),
        ("text", lambda b: repair_text(b, pdf, paragraphs=True)),
        ("lists", lambda b: repair_lists(b, pdf)),
        ("exponents", lambda b: restore_exponents(b, pdf)),
        ("columns", lambda b: repair_columns(b, pdf)),
    ]:
        started = time.perf_counter()
        blocks, evidence[name] = operation(blocks)
        phases[name] = time.perf_counter() - started
    original = blocks
    if table_recovery:
        started = time.perf_counter()
        bundles, candidates = [], []
        with pymupdf.open(pdf) as document:
            for page in document:
                lines = geometry.text_lines(page)
                for number, region in enumerate(tables.select_regions(page, lines)):
                    record = {"page": page.number + 1, "region": number, "bbox": region}
                    try:
                        bundle = tables.recover(page, region, lines)
                    except ValueError as error:
                        candidates.append(
                            {**record, "state": "rejected", "error": str(error)}
                        )
                        continue
                    candidates.append(
                        {**record, "state": "extracted", "bundle": len(bundles)}
                    )
                    bundles.append(bundle)
            evidence["watermarks"] = tables.watermark_blocks(document, blocks)
            blocks, evidence["replacement"], dropped = tables.replace_tables(
                blocks, bundles, evidence["watermarks"], document
            )
        assert [b for i, b in enumerate(original) if i not in dropped] == [
            b for b in blocks if b.get("_recovery") != "source-geometry"
        ]
        evidence["bundles"], evidence["candidates"] = bundles, candidates
        phases["source_tables"] = time.perf_counter() - started
    started = time.perf_counter()
    if table_recovery:
        chunks, evidence["furniture"] = tables.stable_chunks(blocks, original)
    else:
        blocks, chunks, evidence["table_packing"] = chunk_native_bounded(blocks)
    phases["chunking"] = time.perf_counter() - started
    started = time.perf_counter()
    chunks, evidence["headings"] = retain_headings(blocks, pdf, chunks)
    phases["heading_retention"] = time.perf_counter() - started
    return blocks, chunks, evidence, phases


def check():
    table = {
        "id": 2,
        "type": "table",
        "page number": 1,
        "rows": [{"cells": [{"content": "Page footer"}]}],
    }
    native = {"kids": [{"type": "footer", "kids": [table]}]}
    block = {
        **odl_content_list(table, [])[0],
        "page_idx": 0,
        "bbox": [10, 950, 90, 980],
    }
    revised, decisions = mark_footer_tables([block], native)
    assert revised == [{**block, "type": "footer"}] and len(decisions) == 1
    assert mark_footer_tables(revised, native)[0] == revised
    assert mark_footer_tables([block], {"kids": [{"type": "header", "kids": [table]}]})[
        0
    ] == [block]
    assert mark_footer_tables([block], {"kids": [table, *native["kids"]]})[0] == [block]
    for changed in [{**block, "table_body": "changed"}, {**block, "page_idx": 1}]:
        assert mark_footer_tables([changed], native)[0] == [changed]
    assert block["type"] == "table"
    print(
        "Explicit footer ancestry, header preservation, identity, page and content guards passed"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--arm", choices=["text", "tables"])
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.sources or not args.output or not args.arm:
        parser.error("--sources, --output and --arm are required for replay")
    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    snapshot = args.output / "source-snapshot"
    sources = {}
    for path in [Path(__file__), *Path(__file__).parent.glob("experiment_odl_*.py")]:
        save_path = snapshot / path.name
        save_path.parent.mkdir(parents=True, exist_ok=True)
        save_path.write_bytes(path.read_bytes())
        sources[path.name] = sha(path)
    for entry in read(args.sources)["entries"]:
        assert sha(entry["parsed_pdf"]) == entry["parsed_pdf_sha256"]
        assert sha(entry["content_list"]) == entry["content_sha256"]
        original = read(entry["content_list"])
        native_folder = Path(entry["baseline"]) / "native"
        native_files = [
            path
            for path in native_folder.glob("*.json")
            if path.name not in {"content_list.json", "result.json"}
        ]
        if len(native_files) != 1:
            raise ValueError(f"expected one Java JSON: {native_folder}")
        if read(native_folder / "result.json")["pdf_sha256"] != sha(
            entry["parsed_pdf"]
        ):
            raise ValueError("Java JSON PDF binding differs from parsed source")
        started = time.perf_counter()
        blocks, chunks, evidence, phases = refine(
            original,
            entry["parsed_pdf"],
            read(native_files[0]),
            table_recovery=args.arm == "tables",
        )
        elapsed = time.perf_counter() - started
        target = args.output / entry["id"]
        save(target / "content_list.json", blocks)
        save(
            target / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
        )
        save(target / "evidence.json", evidence)
        records.append(
            {
                "id": entry["id"],
                "pages": entry["pages"],
                "seconds": elapsed,
                "phases": phases,
                "native_sha256": sha(native_files[0]),
                "chunks": len(chunks),
                "tables": sum(d["accepted"] for d in evidence.get("replacement", [])),
                "headings": len(
                    [d for d in evidence["headings"] if d["state"] == "retained"]
                ),
            }
        )
        print(records[-1], flush=True)
    save(
        args.output / "summary.json",
        {
            "sources_sha256": sha(args.sources),
            "arm": args.arm,
            "sources": sources,
            "records": records,
        },
    )


if __name__ == "__main__":
    main()
