"""Frozen row/prose diagnostics for independent PDFs, alongside source visual review.

These checks cannot certify table semantics. The source rubric separately lists
headers, merged scopes, units, notes, emphasis and captions that require review.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import unicodedata
from pathlib import Path


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normal(value: str) -> str:
    value = html.unescape(value)
    value = re.sub(r"<(?:br|/tr|/p)\b[^>]*>", "\n", value)
    value = re.sub(r"<[^>]*>", " ", value)
    value = re.sub(r"\\(?:mathrm|mathbf|text|operatorname)\b", "", value)
    value = unicodedata.normalize("NFKC", value).replace("’", "'")
    value = re.sub(r"(?<=[^\W\d_])-\s*(?=[^\W\d_])", "", value)
    return re.sub(r"[\s_{}$|*]", "", value)


def block_text(block: dict) -> str:
    return "\n".join(
        [str(block.get("text", "")), str(block.get("table_body", ""))]
        + block.get("list_items", [])
        + block.get("table_caption", [])
        + block.get("table_footnote", [])
    )


def row_hit(text: str, row: dict) -> bool:
    # Diagnostic only: preserve exact decimal digits and source missing marks.
    return normal(row["label"] + " " + " ".join(row["values"])) in normal(text)


def score(checks: dict, run: Path) -> dict:
    documents = {}
    for name in {t["document"] for t in checks["tables"] + checks["prose"]}:
        directory = run / name
        files = [directory / "content_list.json", directory / "chunks.json"]
        documents[name] = {
            "blocks": read(files[0]),
            "chunks": read(files[1]),
            "sha256": {p.name: sha(p) for p in files},
        }
    tables = []
    for table in checks["tables"]:
        doc, page = documents[table["document"]], table["page"]
        page_text = "\n".join(
            block_text(b) for b in doc["blocks"] if b.get("page_idx") == page - 1
        )
        chunks = [
            (i, c)
            for i, c in enumerate(doc["chunks"])
            if c.get("page_start") is not None
            and c["page_start"] <= page <= c["page_end"]
        ]
        rows = [
            {
                "label": row["label"],
                "raw_page_sequence": row_hit(page_text, row),
                "chunk_indices": [i for i, c in chunks if row_hit(c["text"], row)],
            }
            for row in table["rows"]
        ]
        tables.append({"id": table["id"], "rows": rows})
    prose = []
    for case in checks["prose"]:
        doc, page = documents[case["document"]], case["page"]
        page_text = "\n".join(
            block_text(b) for b in doc["blocks"] if b.get("page_idx") == page - 1
        )
        expected = normal(case["text"])
        prose.append(
            {
                "id": case["id"],
                "raw_page_sequence": expected in normal(page_text),
                "chunk_indices": [
                    i
                    for i, c in enumerate(doc["chunks"])
                    if c.get("page_start") is not None
                    and c["page_start"] <= page <= c["page_end"]
                    and expected in normal(c["text"])
                ],
                "math_requires_separate_review": bool(case.get("formulae")),
            }
        )
    rows = [row for table in tables for row in table["rows"]]
    return {
        "run": str(run.resolve()),
        "files": {k: v["sha256"] for k, v in documents.items()},
        "summary": {
            "rows": len(rows),
            "raw_row_sequences": sum(r["raw_page_sequence"] for r in rows),
            "chunk_row_sequences": sum(bool(r["chunk_indices"]) for r in rows),
            "prose": len(prose),
            "raw_prose_sequences": sum(p["raw_page_sequence"] for p in prose),
            "chunk_prose_sequences": sum(bool(p["chunk_indices"]) for p in prose),
        },
        "tables": tables,
        "prose": prose,
        "complete_table_semantics": "Not scored by this diagnostic; review against frozen source rubric.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--checks", type=Path)
    parser.add_argument("--runs", type=Path, nargs="+")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.check:
        row = {"label": "BERT_BASE", "values": ["80.8", "88.5", "-", "-"]}
        assert row_hit("BERT<sub>BASE</sub> | 80.8 | 88.5 | - | -", row)
        assert not row_hit("BERT_BASE | 80.8 | 85.8 | - | -", row)
        assert not row_hit("BERT_BASE | 80.8 | 88.5 | 0 | 0", row)
        assert normal("the parameter-\nfree shortcut") == normal(
            "the parameter-free shortcut"
        )
        print("row diagnostics reject changed values and invented missing values")
        return
    if not args.checks or not args.runs or not args.output:
        parser.error("--checks, --runs and --output are required")
    checks = read(args.checks)
    result = {
        "checks_sha256": sha(args.checks),
        "script_sha256": sha(Path(__file__)),
        "runs": [score(checks, path) for path in args.runs],
    }
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps([r["summary"] for r in result["runs"]]))


if __name__ == "__main__":
    main()
