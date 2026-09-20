"""Evaluate unchanged detector on already-frozen source witnesses only."""

import argparse
import collections
import hashlib
import importlib.util
import json
import time
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--fixtures", nargs="+", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
OUT = args.output
OUT.mkdir(parents=True, exist_ok=True)
p = ROOT / "bench/parsers/scripts/experiment_prince_math_loss.py"
code_sha = hashlib.sha256(p.read_bytes()).hexdigest()
assert code_sha == "136de0218bda281e34a50454b5aff6d969c93d7ae5a074f6be7b9ac2cd897e35"
spec = importlib.util.spec_from_file_location("frozen_detector", p)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
files = args.fixtures
fs = [json.loads(p.read_text(encoding="utf8")) for p in files]
assert all(f["status"] == "frozen" for f in fs)
cases = [c | {"tranche": f["tranche"]} for f in fs for c in f["cases"]]
ds = {d["id"]: d for f in fs for d in f["documents"]}
pages = []
detections = {}
start = time.perf_counter()
for id in sorted(ds):
    path = ROOT / ds[id]["source_path"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == ds[id]["source_sha256"]
    doc = pymupdf.open(path)
    for n in sorted({c["page"] for c in cases if c["document_id"] == id}):
        t = time.perf_counter()
        found = m.detect(doc[n - 1])
        detections[id, n] = found
        pages.append(
            {
                "document_id": id,
                "page": n,
                "elapsed_seconds": time.perf_counter() - t,
                "detections": found,
            }
        )
results = []
for c in cases:
    matched = [
        d
        for d in detections[c["document_id"], c["page"]]
        if m.overlap(c["bbox"], d["bbox"]) > 0
    ]
    expected = c["detector_expected"]
    outcome = (
        "excluded"
        if expected is None
        else ("TP" if matched else "FN")
        if expected
        else ("FP" if matched else "TN")
    )
    results.append(
        {
            "id": c["id"],
            "document_id": c["document_id"],
            "page": c["page"],
            "tranche": c["tranche"],
            "category": c["category"],
            "exporter_family": ds[c["document_id"]]["exporter_family"],
            "expected": expected,
            "detected": bool(matched),
            "outcome": outcome,
            "matched": matched,
        }
    )
summary = {
    "detector_sha256": code_sha,
    "fixtures": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
    "elapsed_seconds": time.perf_counter() - start,
    "pages": len(pages),
    "case_counts": dict(collections.Counter(r["outcome"] for r in results)),
    "matching": "Positive-area bbox intersection; unchanged from original detector evaluation. Cases outside frozen witness boxes are unjudged.",
    "by_family": {
        f: dict(
            collections.Counter(
                r["outcome"] for r in results if r["exporter_family"] == f
            )
        )
        for f in sorted({d["exporter_family"] for d in ds.values()})
    },
    "by_tranche": {
        f: dict(collections.Counter(r["outcome"] for r in results if r["tranche"] == f))
        for f in sorted({r["tranche"] for r in results})
    },
}
(OUT / "detector-results.json").write_text(
    json.dumps(
        {"summary": summary, "cases": results, "pages": pages},
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf8",
)
print(json.dumps(summary, indent=2))
print("false positives", [r["id"] for r in results if r["outcome"] == "FP"])
print("true positives", [r["id"] for r in results if r["outcome"] == "TP"])
