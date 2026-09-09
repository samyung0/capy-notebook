"""Evaluate saved parser outputs locally, without inference or database access.

Run with the repository's current chunker. Source probes are small, auditable
examples; native-character coverage is only a diagnostic. It does not measure
reading order, factual accuracy, equation correctness, or end-to-end retrieval.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import asdict
from pathlib import Path

from compare_opendataloader import odl_content_list

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pipeline"))
from pipeline.config import cfg
from pipeline.retrieval.chunking import _TableRows, chunk_content_list, flatten_table


def normal(text: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return "".join(
        c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum()
    )


def text_of(block: dict) -> str:
    parts = []
    for key in [
        "text",
        "description",
        "latex",
        "list_items",
        "image_caption",
        "chart_caption",
        "table_caption",
        "table_footnote",
        "image_footnote",
        "chart_footnote",
        "code_body",
        "code_caption",
        "code_footnote",
    ]:
        value = block.get(key, "")
        parts.extend(value if isinstance(value, list) else [str(value)])
    if block.get("table_body"):
        parts.append(flatten_table(block["table_body"]))
    return "\n".join(parts)


def in_order(text: str, anchors: list[str]) -> bool:
    text = normal(text)
    end = 0
    for anchor in anchors:
        target = normal(anchor)
        position = text.find(target, end)
        if position < 0:
            return False
        end = position + len(target)
    return True


def matches(text: str, anchors: list[str]) -> bool:
    text = normal(text)
    return all(normal(a) in text for a in anchors)


def geometry(block: dict, pages: int) -> str:
    page, box = block.get("page_idx"), block.get("bbox")
    if not isinstance(page, int) or not 0 <= page < pages:
        return "missing_or_invalid_page"
    if not isinstance(box, list) or len(box) != 4:
        return "missing_box"
    if not all(isinstance(n, (int, float)) and math.isfinite(n) for n in box):
        return "invalid_box"
    x0, y0, x1, y1 = box
    if x0 >= x1 or y0 >= y1:
        return "invalid_box"
    if min(box) < 0 or max(box) > 1000:
        return "out_of_bounds"
    return "valid"


def evaluate(
    directory: Path,
    entry: dict,
    reference: list[dict],
    checks: list[dict],
    *,
    chunker=chunk_content_list,
) -> dict:
    from pipeline.parse.figures import select_figures

    record = json.loads((directory / "result.json").read_text())
    if record["input_sha256"] != entry["pdf_sha256"]:
        raise ValueError(f"input hash mismatch: {directory}")
    record.update(kind=entry["kind"], lang=entry["lang"])
    applicable = [
        c
        for c in checks
        if c["source"] == entry.get("parent", entry["id"])
        and c["page"] in entry["source_pages"]
    ]
    if record["state"] != "ok":
        record["probes"] = [
            {
                "id": c["id"],
                "page": entry["source_pages"].index(c["page"]),
                "kind": "table_row"
                if "row" in c
                else "order"
                if "ordered" in c
                else "text",
                "raw_pass": False,
                "chunk_pass": False,
                "unavailable": True,
            }
            for c in applicable
        ]
        return record
    if record["config"].startswith("odl-"):
        native = json.loads((directory / f"{entry['id']}.json").read_text())
        blocks = odl_content_list(native, reference)
        (directory / "content_list.json").write_text(
            json.dumps(blocks, ensure_ascii=False, indent=2)
        )
    else:
        blocks = json.loads((directory / "content_list.json").read_text())
    chunks = chunker(blocks)
    (directory / "chunks.json").write_text(
        json.dumps([asdict(c) for c in chunks], ensure_ascii=False, indent=2)
    )
    page_text = [
        "\n".join(text_of(b) for b in blocks if b.get("page_idx") == i)
        for i in range(entry["pages"])
    ]
    diagnostics = []
    for i, page in enumerate(reference):
        expected, actual = (
            Counter(normal(page["native_text"])),
            Counter(normal(page_text[i])),
        )
        matched = sum((expected & actual).values())
        diagnostics.append(
            {
                "page": i,
                "native_chars": sum(expected.values()),
                "output_chars": sum(actual.values()),
                "native_character_recall": matched / sum(expected.values())
                if expected
                else None,
            }
        )
    probes = []
    for check in applicable:
        page = entry["source_pages"].index(check["page"])
        candidates = [
            c.indexed_text()
            for c in chunks
            if c.page_start and c.page_start <= page + 1 <= c.page_end
        ]
        anchors = check.get("anchors", check.get("ordered", check.get("row")))
        raw_pass = matches(page_text[page], anchors)
        chunk_pass = any(matches(text, anchors) for text in candidates)
        probe = {
            "id": check["id"],
            "page": page,
            "kind": "text",
            "raw_pass": raw_pass,
            "chunk_pass": raw_pass and chunk_pass,
            "chunk_anchor_presence": chunk_pass,
            "document_anchor_presence": matches("\n".join(page_text), anchors),
        }
        if "ordered" in check:
            probe.update(
                kind="order",
                raw_pass=in_order(page_text[page], anchors),
                chunk_pass=in_order(page_text[page], anchors)
                and in_order("\n".join(candidates), anchors),
            )
        if "row" in check:
            rows = []
            for block in blocks:
                if block.get("page_idx") == page and block.get("type") == "table":
                    parser = _TableRows()
                    parser.feed(block.get("table_body", ""))
                    rows.extend(" | ".join(row) for row in parser.rows)
            probe.update(
                kind="table_row", raw_pass=any(in_order(row, anchors) for row in rows)
            )
            probe["chunk_pass"] = probe["raw_pass"] and any(
                in_order(line, anchors)
                for text in candidates
                for line in text.splitlines()
            )
        probes.append(probe)
    images = [b for b in blocks if b.get("type") in {"image", "chart"}]
    selected = select_figures(blocks, directory)
    image_files = [
        p
        for folder in directory.iterdir()
        if folder.is_dir()
        and (folder.name == "images" or folder.name.endswith("_images"))
        for p in folder.rglob("*")
        if p.is_file()
    ]
    image_bytes = sum(p.stat().st_size for p in image_files)
    content_bytes = (directory / "content_list.json").stat().st_size
    artifact_flags = []
    if len(image_files) + 2 > cfg.parse_artifact_max_entries:
        artifact_flags.append("too_many_entries")
    if image_bytes > cfg.parse_images_max_bytes:
        artifact_flags.append("images_total_too_large")
    if any(p.stat().st_size > cfg.parse_image_max_bytes for p in image_files):
        artifact_flags.append("individual_image_too_large")
    if (
        content_bytes > cfg.parse_content_max_bytes
        or len(blocks) > cfg.parse_content_max_blocks
    ):
        artifact_flags.append("content_list_too_large")
    record.update(
        adapted_blocks=len(blocks),
        adapted_types=dict(Counter(b.get("type") for b in blocks)),
        chunk_count=len(chunks),
        chunks_with_regions=sum(bool(c.regions) for c in chunks),
        chunk_characters=sum(len(c.text) for c in chunks),
        headings=sum(bool(b.get("text_level")) for b in blocks),
        geometry=dict(Counter(geometry(b, entry["pages"]) for b in blocks)),
        image_count=len(images),
        captionable_images=len(selected),
        image_files=len(image_files),
        image_bytes=image_bytes,
        adapted_content_bytes=content_bytes,
        artifact_limit_flags=artifact_flags,
        captionable_paths=[str(f.path.relative_to(directory)) for f in selected],
        image_geometry=dict(Counter(geometry(b, entry["pages"]) for b in images)),
        missing_image_files=sum(
            not (directory / b.get("img_path", "")).is_file() for b in images
        ),
        page_diagnostics=diagnostics,
        probes=probes,
    )
    return record


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument(
        "--checks",
        type=Path,
        default=REPO / "bench/parsers/fixtures/opendataloader-checks.json",
    )
    args = parser.parse_args()
    corpus = {
        e["id"]: e
        for e in json.loads((args.root / "corpus.json").read_text())["entries"]
    }
    specification = json.loads(args.checks.read_text())
    checks = specification["checks"].copy()
    for mapping in specification.get("page_mappings", []):
        checks.extend(
            {
                **check,
                "source": mapping["source"],
                "page": mapping["pages"][check["page"]],
            }
            for check in specification["checks"]
            if check["source"] == mapping["checks_from"]
        )
    records = []
    capacity_records = []
    for result in sorted((args.root / "results").glob("*/*/result.json")):
        if result.parent.name.startswith("_"):
            continue
        if (result.parent.parent / "invalid.json").exists():
            continue
        run_path = result.parent.parent / "run.json"
        is_capacity = (
            run_path.exists()
            and json.loads(run_path.read_text()).get("kind") == "capacity"
        )
        data = json.loads(result.read_text())
        entry = corpus[data["id"]]
        reference_path = args.root / "prepared" / f"{entry['id']}.reference.json"
        if not reference_path.exists():
            reference_path = args.root / reference_path.name
        record = evaluate(
            result.parent, entry, json.loads(reference_path.read_text()), checks
        )
        destination = capacity_records if is_capacity else records
        destination.append(
            {"run": result.parent.parent.name, "case": result.parent.name, **record}
        )
    metadata = {
        "figure_selector_sha256": hashlib.sha256(
            (REPO / "pipeline/pipeline/parse/figures.py").read_bytes()
        ).hexdigest(),
        "adapter_sha256": hashlib.sha256(
            (Path(__file__).parent / "compare_opendataloader.py").read_bytes()
        ).hexdigest(),
        "chunker_sha256": hashlib.sha256(
            (REPO / "pipeline/pipeline/retrieval/chunking.py").read_bytes()
        ).hexdigest(),
        "chunk_tokens": cfg.chunk_tokens,
        "chunk_overlap_tokens": cfg.chunk_overlap_tokens,
        "chunk_min_tokens": cfg.chunk_min_tokens,
        "checks_sha256": hashlib.sha256(args.checks.read_bytes()).hexdigest(),
    }
    (args.root / "evaluation.json").write_text(
        json.dumps(
            {"metadata": metadata, "records": records}, ensure_ascii=False, indent=2
        )
    )
    (args.root / "capacity-quality.json").write_text(
        json.dumps(
            {"metadata": metadata, "records": capacity_records},
            ensure_ascii=False,
            indent=2,
        )
    )
    for run in sorted({r["run"] for r in records}):
        rows = [r for r in records if r["run"] == run]
        ok = [r for r in rows if r["state"] == "ok"]
        probes = [p for r in rows for p in r["probes"]]
        timings = [r.get("wall_s") for r in rows]
        memory = [r.get("peak_memory_bytes") for r in rows]
        print(
            run,
            json.dumps(
                {
                    "ok": len(ok),
                    "cases": len(rows),
                    "seconds": round(sum(timings), 1)
                    if all(t is not None for t in timings)
                    else None,
                    "probes": len(probes),
                    "unique_probes": len({p["id"] for p in probes}),
                    "raw_pass": sum(p["raw_pass"] for p in probes),
                    "chunk_pass": sum(p["chunk_pass"] for p in probes),
                    "peak_GiB": round(max(memory) / 2**30, 2)
                    if memory and all(m is not None for m in memory)
                    else None,
                }
            ),
        )


if __name__ == "__main__":
    main()
