"""Join frozen witnesses to completed raw parses and downstream chunks, without scoring by token presence."""

import argparse
import hashlib
import json
import sys
from dataclasses import asdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--fixtures", nargs="+", type=Path, required=True)
parser.add_argument("--input-root", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
OUT = args.output
OUT.mkdir(parents=True, exist_ok=True)
BASE = args.input_root
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.retrieval.confidence import ocr_pages, score_chunks
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks


def read(p):
    return json.loads(p.read_text(encoding="utf8"))


def write(p, v):
    p.write_text(json.dumps(v, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def intersects(a, b):
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


fixtures = [read(p) for p in args.fixtures]
cases = [c for f in fixtures for c in f["cases"]]
sources = {s["id"]: s for f in fixtures for s in f["documents"]}
results = []
for id, s in sources.items():
    rows = [c for c in cases if c["document_id"] == id]
    status = BASE / "parse" / id / "status.json"
    parse_status = read(status)["status"] if status.exists() else "not_started"
    if parse_status != "complete":
        results.extend(
            {
                "id": c["id"],
                "document_id": id,
                "page": c["page"],
                "status": "parse_unavailable"
                if parse_status in {"failed", "timed_out"}
                else "awaiting_complete_parse",
                "parse_status": parse_status,
                "judgment": "unassessed",
            }
            for c in rows
        )
        continue
    st = read(status)
    attempt = BASE / "parse" / st["attempt_directory"]
    source_pdf = ROOT / s["source_path"]
    assert sha(source_pdf) == s["source_sha256"]
    parsed_pdf = attempt / "baseline/parsed.pdf"
    pdf = parsed_pdf if parsed_pdf.exists() else source_pdf
    parse_receipt = read(attempt / "baseline/parse.json")
    assert sha(pdf) == parse_receipt["measured_pdf_sha256"]
    doc = pymupdf.open(source_pdf)
    baseline = read(attempt / "baseline/content_list.json")
    candidate = read(attempt / "candidate/content_list.json")
    inputs = {
        "source_sha256": s["source_sha256"],
        "measured_pdf_sha256": sha(pdf),
        "parse_sha256": sha(attempt / "baseline/parse.json"),
        "content_sha256": sha(attempt / "baseline/content_list.json"),
        "refinement_sha256": sha(attempt / "baseline/refinement.json"),
        "chunker": {
            str(p.relative_to(ROOT)): sha(p)
            for p in sorted((ROOT / "pipeline/pipeline/retrieval").rglob("*.py"))
        },
        "fixture_sha256": {str(p): sha(p) for p in args.fixtures},
    }
    cache = OUT / f"{id}-baseline-chunks-v2.json"
    if not cache.exists() or read(cache)["inputs"] != inputs:
        chunks = retain_headings(
            baseline,
            pdf,
            pack_blocks(
                baseline,
                frozenset(read(attempt / "baseline/refinement.json")["furniture"]),
            ),
        )
        # Page coverage must see the full baseline before any witness filtering.
        score_chunks(chunks, pdf, ocr=ocr_pages(baseline))
        selected = [
            {"index": i, **asdict(c)}
            for i, c in enumerate(chunks)
            if any(c.page_start <= r["page"] <= c.page_end for r in rows)
        ]
        write(
            cache,
            {
                "schema": "baseline-witness-chunks-v2",
                "inputs": inputs,
                "chunks": selected,
            },
        )
    bc = read(cache)["chunks"]
    alt = BASE / "native-alt-r2" / id
    combined = (
        read(alt / "content_list.json") if (alt / "summary.json").exists() else None
    )
    cc = read(alt / "chunks.json") if combined is not None else None
    decisions = read(alt / "decisions.json") if combined is not None else []
    for c in rows:
        p = doc[c["page"] - 1]
        box = [
            c["bbox"][i] * 1000 / (p.rect.width if i % 2 == 0 else p.rect.height)
            for i in range(4)
        ]
        near = [box[0] - 10, box[1] - 35, box[2] + 10, box[3] + 35]

        def bs(blocks, page, region):
            return [
                dict(index=i, **v)
                for i, v in enumerate(blocks)
                if v.get("page_idx") == page - 1
                and intersects(v.get("bbox", [0, 0, 0, 0]), region)
            ]

        def cs(chunks, page, region):
            return [
                {"index": i, **v}
                for i, v in enumerate(chunks)
                if any(
                    r["page"] == page and intersects(r["bbox"], region)
                    for r in v["regions"]
                )
            ]

        results.append(
            {
                "id": c["id"],
                "document_id": id,
                "page": c["page"],
                "status": "ready" if combined is not None else "awaiting_native_alt",
                "judgment": "unassessed",
                "bbox_normalized": box,
                "matching_note": "35/1000 page-height surrounding context, not a correctness score",
                "baseline_inputs": inputs,
                "baseline_blocks": bs(baseline, c["page"], near),
                "candidate_blocks": bs(candidate, c["page"], near),
                "combined_blocks": bs(combined, c["page"], near)
                if combined is not None
                else [],
                "baseline_chunks": cs(bc, c["page"], near),
                "combined_chunks": cs(cc, c["page"], near) if cc is not None else [],
                "native_alt_decisions": [
                    d
                    for d in decisions
                    if d["page"] == c["page"]
                    and intersects(d["bbox_points"], c["bbox"])
                ],
            }
        )
write(
    OUT / "output-evidence.json",
    {
        "schema": "visual-output-evidence-v2",
        "note": "Every judgment starts unassessed; region or token overlap never establishes extraction correctness.",
        "cases": results,
    },
)
print("ready", sum(c["status"] == "ready" for c in results), "of", len(results))
