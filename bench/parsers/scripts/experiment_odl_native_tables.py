"""Offline native-table context experiment. No parser or provider is called.

Input root contains results/, corpus.json and the separately frozen source checks.
The existing production and benchmark chunkers are the two controls. This adds
only adjacent explicit table captions/units and explicit native body-cell spans.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import statistics
import time
import unicodedata
from dataclasses import asdict
from pathlib import Path

from structured_recovery import (
    Table,
    _normalized,
    _push_heading,
    _repeated_across_pages,
    chunk_content_list,
    chunk_structured,
    clean_inline,
)

CAPTION = re.compile(
    r"^(?:table(?:au)?|tabla|tabelle|tab\.?|表)\s*[0-9０-９]+", re.IGNORECASE
)
UNIT = re.compile(r"^[（(][^()（）\n]{1,24}[)）]$")


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normal(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def native_spans(parser: Table) -> tuple[list[list[str]], list[dict]]:
    """Recover native HTML span origins, leaving covered body positions empty."""
    headers, rows = parser.grid()
    head = len(parser.rows) - len(rows)
    occupied = set()
    spans = []
    original = [[""] * len(headers) for _ in rows]
    for y, cells in enumerate(parser.rows):
        x = 0
        for cell in cells:
            while (y, x) in occupied:
                x += 1
            for yy in range(y, y + cell.rowspan):
                for xx in range(x, x + cell.colspan):
                    occupied.add((yy, xx))
            if y < head < y + cell.rowspan:
                raise ValueError("native span crosses the header/body boundary")
            if y >= head:
                original[y - head][x] = cell.text
                if cell.rowspan * cell.colspan > 1 and cell.text:
                    spans.append(
                        {
                            "row": y - head,
                            "column": x,
                            "rowspan": cell.rowspan,
                            "colspan": cell.colspan,
                        }
                    )
            x += cell.colspan
    return original, spans


def contextualize(
    blocks: list[dict], *, strict: bool = True
) -> tuple[list[dict], list[dict]]:
    result = copy.deepcopy(blocks)
    receipts = []
    for index, block in enumerate(result):
        if block.get("type") != "table":
            continue
        receipt = {"index": index, "page": block.get("page_idx"), "context_indices": []}
        parser = Table()
        try:
            parser.feed(block.get("table_body", ""))
            parser.close()
            rows, spans = native_spans(parser)
            if not strict and not any(parser.grid()[0]):
                raise ValueError("no explicit native column headers")
        except ValueError as exc:
            if strict:
                raise
            receipt.update(native_body_spans=0, ordinary_packing_reason=str(exc))
            receipts.append(receipt)
            continue
        block["_native_table_supported"] = True
        if spans and not block.get("_table_spans"):
            block.update(_table_rows=rows, _table_spans=spans)
        receipt["native_body_spans"] = len(spans)
        box = block.get("bbox")
        # ponytail: only adjacent, explicit captions above a table. Captions
        # below it, distant units and unlabelled section titles remain untouched.
        context = []
        if box and not block.get("table_caption"):
            for previous in range(index - 1, max(-1, index - 4), -1):
                candidate = blocks[previous]
                text = candidate.get("text", "").strip()
                bounds = candidate.get("bbox")
                if (
                    candidate.get("type") != "text"
                    or candidate.get("page_idx") != block.get("page_idx")
                    or not bounds
                    or not 0 <= box[1] - bounds[3] <= 60
                    or min(box[2], bounds[2]) <= max(box[0], bounds[0])
                ):
                    break
                if CAPTION.match(text):
                    context.insert(0, (previous, text, bounds))
                    break
                if UNIT.fullmatch(text):
                    context.insert(0, (previous, text, bounds))
                    continue
                break
        if context and CAPTION.match(context[0][1]):
            block["table_caption"] = [item[1] for item in context]
            block["_native_table_title"] = context[0][1]
            block["bbox"] = [
                min(box[0], *(item[2][0] for item in context)),
                min(box[1], *(item[2][1] for item in context)),
                max(box[2], *(item[2][2] for item in context)),
                max(box[3], *(item[2][3] for item in context)),
            ]
            receipt["context_indices"] = [item[0] for item in context]
            receipt["context"] = block["table_caption"]
        receipts.append(receipt)
    return result, receipts


def chunk_native(blocks: list[dict]):
    prepared, receipts = contextualize(blocks)
    chunks = chunk_structured(prepared)
    # The benchmark packer gives each table chunk one exact table region.
    # Reset only a positively attached table title; prose heading state survives.
    titles = {
        (b["page_idx"] + 1, tuple(b["bbox"])): b["_native_table_title"]
        for b in prepared
        if b.get("_native_table_title")
    }
    for chunk in chunks:
        if len(chunk.regions) == 1:
            region = chunk.regions[0]
            title = titles.get((region.page, tuple(region.bbox)))
            if title:
                chunk.section_path = title
    return prepared, chunks, receipts


def chunk_native_bounded(blocks: list[dict]):
    """Explicit experiment: ordinary packing for unsupported native tables."""
    prepared, receipts = contextualize(blocks, strict=False)
    if not any(b.get("_native_table_supported") for b in prepared):
        return prepared, chunk_content_list(prepared), receipts
    chunks, pending, seed, stack = [], [], [], []
    furniture = _repeated_across_pages(prepared)

    def flush():
        if pending:
            chunks.extend(chunk_content_list(seed + pending))
            pending.clear()
        seed[:] = [
            {"type": "text", "text_level": level, "text": text} for level, text in stack
        ]

    for block in prepared:
        if block.get("type") == "text" and block.get("text_level", 0) > 0:
            _push_heading(stack, block["text_level"], block["text"])
        elif (
            block.get("type") in {"text", "header", "page_footnote"}
            and _normalized(clean_inline(block.get("text", ""))) in furniture
        ):
            continue
        if not block.get("_native_table_supported"):
            pending.append(block)
            continue
        flush()
        for chunk in chunk_structured([block]):
            chunk.section_path = block.get("_native_table_title") or " › ".join(
                text for _, text in stack
            )
            chunks.append(chunk)
    flush()
    return prepared, chunks, receipts


def japan_checks(blocks, chunks, frozen):
    page = frozen["screen_page"] - 1
    table = next(
        b for b in blocks if b.get("type") == "table" and b.get("page_idx") == page
    )
    parser = Table()
    parser.feed(table["table_body"])
    headers, rows = parser.grid()
    title, unit = normal(frozen["title"]), normal(frozen["unit"])
    checks = []
    for expected in frozen["rows"]:
        row = next((r for r in rows if normal(r[0]) == normal(expected[0])), [])
        matches = [
            i
            for i, c in enumerate(chunks)
            if normal(" | ".join(expected)) in normal(c.text)
        ]
        complete = [
            i
            for i in matches
            if title in normal(chunks[i].text)
            and unit in normal(chunks[i].text)
            and all(normal(h) in normal(chunks[i].text) for h in frozen["headers"])
            and "図２" not in chunks[i].section_path
        ]
        checks.append(
            {
                "row": expected[0],
                "raw_exact": list(map(normal, row)) == list(map(normal, expected)),
                "row_chunks": matches,
                "self_contained_chunks": complete,
            }
        )
    all_rows = []
    for row in rows:
        matches = [
            i for i, c in enumerate(chunks) if normal(" | ".join(row)) in normal(c.text)
        ]
        all_rows.append(
            {
                "row": row[0],
                "chunks": matches,
                "headers": any(
                    all(normal(h) in normal(chunks[i].text) for h in headers)
                    for i in matches
                ),
                "title_unit": any(
                    title in normal(chunks[i].text) and unit in normal(chunks[i].text)
                    for i in matches
                ),
            }
        )
    return {
        "source_rows": checks,
        "all_native_rows": all_rows,
        "native_rows": len(rows),
        "native_numeric_cells": sum(len(r) - 1 for r in rows),
        "native_cell_grid_sha256": hashlib.sha256(
            json.dumps([headers, rows], ensure_ascii=False).encode()
        ).hexdigest(),
    }


def check() -> None:
    from structured_recovery import table_html

    long_rows = [[f"row{i}", str(i), ""] for i in range(150)]
    b = [
        {"type": "text", "text": "Figure 2 old title", "text_level": 1, "page_idx": 0},
        {
            "type": "text",
            "text": "Table 3 Recorded measurements",
            "page_idx": 1,
            "bbox": [100, 10, 800, 25],
        },
        {"type": "text", "text": "(kg)", "page_idx": 1, "bbox": [700, 30, 800, 40]},
        {
            "type": "table",
            "page_idx": 1,
            "bbox": [100, 45, 800, 900],
            "table_body": table_html(
                ["sample", "A", "B"],
                long_rows,
                [{"row": 0, "column": 1, "rowspan": 1, "colspan": 2}],
            ),
        },
    ]
    unchanged = copy.deepcopy(b)
    prepared, chunks, _ = chunk_native(b)
    assert b == unchanged
    assert prepared[-1]["_table_spans"] == [
        {"row": 0, "column": 1, "rowspan": 1, "colspan": 2}
    ]
    tables = [c for c in chunks if c.section_path == "Table 3 Recorded measurements"]
    assert len(tables) > 1
    assert all(
        "Table 3 Recorded measurements" in c.text and "(kg)" in c.text for c in tables
    )
    assert all(
        c.regions[0].bbox == [100, 10, 800, 900] and c.regions[0].page == 2
        for c in tables
    )
    assert (
        "one merged source cell" in tables[0].text and "columns A; B" in tables[0].text
    )
    assert "row149" in tables[-1].text
    b[1]["page_idx"] = 0
    prepared, _, _ = chunk_native(b)
    assert not prepared[-1].get("table_caption")
    invalid = {
        "type": "table",
        "page_idx": 0,
        "table_body": "<table><tr><td rowspan='3'>kept</td></tr></table>",
    }
    blocks = [{"type": "text", "text": "Before", "page_idx": 0}, invalid]
    prepared, chunks, receipts = chunk_native_bounded(blocks)
    assert prepared == blocks and chunks == chunk_content_list(blocks)
    assert (
        receipts[0]["ordinary_packing_reason"] == "overlapping or incomplete table span"
    )
    print("native-table context, scope, citation, no-mutation and split checks passed")


def run(root: Path, output: Path, repetitions: int) -> None:
    frozen = read(root / "frozen-checks.json")
    for name, expected in frozen["sources"].items():
        if sha(root / "inputs" / (name + ".pdf")) != expected:
            raise ValueError("source PDF differs from frozen checks")
    output.mkdir(parents=True, exist_ok=False)
    records = []
    sources = sorted((root / "results").glob("*/*/content_list.json"))
    if not sources:
        raise ValueError("no input content lists")
    for path in sources:
        run_name, case = path.parent.parent.name, path.parent.name
        blocks = read(path)
        arms = ["production", "structured"]
        if "mineru" not in run_name:
            arms += ["native-context", "native-bounded"]
        for arm in arms:
            elapsed = []
            error = None
            for _ in range(repetitions):
                begin = time.perf_counter()
                prepared, receipts = blocks, []
                try:
                    if arm == "production":
                        chunks = chunk_content_list(blocks)
                    elif arm == "structured":
                        chunks = chunk_structured(blocks)
                    elif arm == "native-context":
                        prepared, chunks, receipts = chunk_native(blocks)
                    else:
                        prepared, chunks, receipts = chunk_native_bounded(blocks)
                except ValueError as exc:
                    error = str(exc)
                    break
                elapsed.append(time.perf_counter() - begin)
            directory = output / run_name / case / arm
            if error is not None:
                record = {
                    "run": run_name,
                    "case": case,
                    "arm": arm,
                    "input_sha256": sha(path),
                    "state": "rejected",
                    "error": error,
                }
                save(directory / "error.json", record)
                records.append(record)
                continue
            payload = [asdict(c) | {"indexed_text": c.indexed_text()} for c in chunks]
            save(directory / "chunks.json", payload)
            if arm.startswith("native-"):
                save(directory / "content_list.json", prepared)
                save(directory / "context.json", receipts)
            record = {
                "run": run_name,
                "case": case,
                "arm": arm,
                "state": "ok",
                "input_sha256": sha(path),
                "chunks_sha256": sha(directory / "chunks.json"),
                "times_s": elapsed,
                "median_s": statistics.median(elapsed),
                "chunks": len(chunks),
                "characters": sum(len(c.text) for c in chunks),
                "tables": sum(b.get("type") == "table" for b in blocks),
                "attached_contexts": sum(bool(r["context_indices"]) for r in receipts),
                "native_body_spans": sum(r["native_body_spans"] for r in receipts),
            }
            if case == "screen__japan-migration" and "mineru" not in run_name:
                record["japan"] = japan_checks(prepared, chunks, frozen["japan"])
            records.append(record)
    save(
        output / "evaluation.json",
        {
            "records": records,
            "checks_sha256": sha(root / "frozen-checks.json"),
            "script_sha256": sha(Path(__file__)),
            "structured_sha256": sha(
                Path(__file__).with_name("structured_recovery.py")
            ),
            "timing_note": "Offline local saved-output replay, no parser, OCR, provider, rendering or indexing time.",
        },
    )
    print(json.dumps({"records": len(records), "output": str(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    else:
        if not args.root or not args.output or args.repetitions < 1:
            parser.error("root, output and positive repetitions are required")
        run(args.root, args.output, args.repetitions)
