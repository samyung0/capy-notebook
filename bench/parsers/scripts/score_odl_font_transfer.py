"""Score the frozen neighboring-paper font transfer without treating values as table semantics."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import asdict
from pathlib import Path

import pymupdf
from structured_recovery import chunk_content_list


def text(block: dict) -> str:
    return str(block.get("text", "")) + " " + " ".join(block.get("list_items", []))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="completed font prepare/run directory")
    parser.add_argument("pdf", type=Path, help="original COT source")
    parser.add_argument("checks", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    checks = json.loads(args.checks.read_text(encoding="utf-8"))
    case, control = checks["cases"]
    if sha(args.pdf) != case["pdf_sha256"]:
        raise ValueError("source changed")
    if sha(args.checks) != sha(args.root / "source-checks.json"):
        raise ValueError("checks differ from pre-run freeze")
    control_audit = json.loads(
        (args.root / control["id"] / "audit.json").read_text(encoding="utf-8")
    )
    assert control_audit["sha256"] == control["pdf_sha256"]
    assert not any(font["eligible"] for font in control_audit["fonts"])
    with pymupdf.open(args.pdf) as document:
        page = document[case["page"] - 1]
        region = pymupdf.Rect(case["table_bbox_top_left_points"])
        box = pymupdf.Rect(
            region.x0 / page.rect.width * 1000,
            region.y0 / page.rect.height * 1000,
            region.x1 / page.rect.width * 1000,
            region.y1 / page.rect.height * 1000,
        )
    expected = [value for row in case["rows"] for value in row["values"]]
    records = []
    for arm in ["baseline", "drop-cmap", "rebuild-cmap"]:
        source = args.root / case["id"] / arm / "content_list.json"
        blocks = json.loads(source.read_text(encoding="utf-8"))
        page_blocks = [b for b in blocks if b.get("page_idx") == case["page"] - 1]
        # The candidate joins the last numeric rows and the caption in one list.
        # Inspect intersecting source blocks, ending at the printed caption label.
        table_text = " ".join(
            text(b) for b in page_blocks if pymupdf.Rect(b["bbox"]).intersects(box)
        )
        table_text = re.split(r"\bTable\s+1\s*:", table_text)[0]
        numbers = re.findall(r"(?<!\w)\d[\d,]*(?:\.\d+)?(?!\w)", table_text)
        chunks = chunk_content_list(blocks)
        rows = []
        for row in case["rows"]:
            pattern = r"\s+".join(re.escape(v) for v in row["values"])
            hits = [
                i
                for i, c in enumerate(chunks)
                if c.page_start is not None
                and c.page_start <= case["page"] <= c.page_end
                and re.search(pattern, c.text)
            ]
            rows.append({"source_row": row["label"], "numeric_sequence_chunks": hits})
        page_text = " ".join(text(b) for b in page_blocks)
        page_chunks = " ".join(
            c.text
            for c in chunks
            if c.page_start is not None and c.page_start <= case["page"] <= c.page_end
        )
        record = {
            "arm": arm,
            "content_sha256": sha(source),
            "numeric_tokens": numbers,
            "exact_66_in_order": numbers == expected,
            "exact_cells_at_position": sum(a == b for a, b in zip(numbers, expected)),
            "rows": rows,
            "identifiers": {
                name: {"native": name in page_text, "chunks": name in page_chunks}
                for name in case["identifiers"]
            },
            "chunks": len(chunks),
            "scope": "Exact numbers and identifiers only; SDS/MDS row scope and nested header fidelity are not established by this score.",
        }
        output = args.output / f"{arm}-chunks.json"
        output.write_text(
            json.dumps([asdict(c) for c in chunks], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        record["chunks_sha256"] = sha(output)
        records.append(record)
    result = {
        "source_sha256": sha(args.pdf),
        "checks_sha256": sha(args.checks),
        "script_sha256": sha(Path(__file__)),
        "negative_control_abstained": True,
        "records": records,
    }
    (args.output / "score.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(records, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
