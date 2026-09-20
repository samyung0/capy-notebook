"""Benchmark-only geometry loss detector. No OCR, provider calls, or source edits.

Run from the repository root with ``uv run --frozen python``. Frozen cases are
visual source witnesses, not training labels or a prevalence sample.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import statistics
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = ROOT / "bench/parsers/fixtures/prince-math-loss.json"
DEFAULT_OUTPUT = ROOT / "bench/parsers/reports/local/2026-09-20-prince-math-loss"
REASON = "possible math missing from text layer"


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def overlap(a, b) -> float:
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0, min(a[3], b[3]) - max(a[1], b[1])
    )


def union(a, b) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def components(objects: list[dict]) -> list[dict]:
    """Join nearby glyph paths; deliberately no shape recognition."""
    pending = list(objects)
    result = []
    while pending:
        current = pending.pop()
        changed = True
        while changed:
            changed = False
            for i in range(len(pending) - 1, -1, -1):
                a, b = current["bbox"], pending[i]["bbox"]
                dx = max(a[0], b[0]) - min(a[2], b[2])
                dy = max(a[1], b[1]) - min(a[3], b[3])
                # Separate stacked answer rows instead of chaining them vertically.
                if dx <= 6 and dy <= 2 and max(a[3], b[3]) - min(a[1], b[1]) <= 26:
                    item = pending.pop(i)
                    current = {
                        "bbox": union(a, b),
                        "objects": current["objects"] + item["objects"],
                        "kind": "vector",
                    }
                    changed = True
        result.append(current)
    return result


def detect(page: pymupdf.Page) -> list[dict]:
    """Find small unrepresented ink beside native text, with no semantic claim.

    ponytail: adjacent native text is required; display and image-only formulas
    need another source of evidence. Geometry cannot distinguish a small diagram.
    """
    if page.rotation:
        return []
    chars = []
    for block in page.get_text(
        "rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    )["blocks"]:
        for line in block.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01 or abs(line["dir"][1]) > 0.01:
                continue
            for span in line["spans"]:
                chars.extend(
                    {"bbox": c["bbox"], "size": span["size"], "c": c["c"]}
                    for c in span["chars"]
                    if not c["c"].isspace()
                )
    if not chars:
        return []
    images = [list(i["bbox"]) for i in page.get_image_info()]
    vectors = []
    for drawing in page.get_drawings():
        box = list(drawing["rect"])
        fill = drawing.get("fill")
        if (
            fill is None
            or max(fill) > 0.25
            or (drawing.get("fill_opacity") or 0) < 0.9
            or not 0.3 <= box[2] - box[0] <= 80
            or not 0.3 <= box[3] - box[1] <= 26
            or len(drawing["items"]) < 2
        ):
            continue
        area = (box[2] - box[0]) * (box[3] - box[1])
        if any(overlap(box, image) > area * 0.5 for image in images):
            continue
        if any(overlap(box, c["bbox"]) > area * 0.5 for c in chars):
            continue
        vectors.append({"bbox": box, "objects": 1, "kind": "vector"})
    candidates = [c for c in components(vectors) if c["objects"] >= 2]
    for box in images:
        if 2 <= box[3] - box[1] <= 26 and 2 <= box[2] - box[0] <= 220:
            area = (box[2] - box[0]) * (box[3] - box[1])
            # A raster over a usable text layer is not a known text-layer hole.
            if sum(overlap(box, c["bbox"]) for c in chars) < area * 0.25:
                candidates.append({"bbox": box, "objects": 1, "kind": "raster"})
    result = []
    for candidate in candidates:
        box = candidate["bbox"]
        anchors = []
        for char in chars:
            c, size = char["bbox"], char["size"]
            dy = min(box[3], c[3]) - max(box[1], c[1])
            dx = max(box[0], c[0]) - min(box[2], c[2])
            if (
                dy >= min(box[3] - box[1], c[3] - c[1]) * 0.35
                and 0 <= dx <= 1.6 * size
                and box[3] - box[1] <= 2 * size
            ):
                anchors.append(char)
        if anchors:
            result.append(
                {
                    **candidate,
                    "page": page.number + 1,
                    "bbox": [round(v, 4) for v in box],
                    "reason": f"{REASON} ({candidate['kind']} ink beside text)",
                    "anchor_characters": "".join(c["c"] for c in anchors),
                    "anchor_boxes": [list(c["bbox"]) for c in anchors],
                }
            )
    return sorted(result, key=lambda c: (c["bbox"][1], c["bbox"][0]))


def grid_box(box, page) -> list[float]:
    return [
        box[0] * 1000 / page.rect.width,
        box[1] * 1000 / page.rect.height,
        box[2] * 1000 / page.rect.width,
        box[3] * 1000 / page.rect.height,
    ]


def attach(chunks, detections, document) -> tuple[list[dict], list[dict]]:
    """Attach after score_chunks so its assignment cannot overwrite the reasons."""
    attached, unmatched = [], []
    by_page: dict[int, list] = {}
    for index, chunk in enumerate(chunks):
        for region in chunk.regions:
            by_page.setdefault(region.page, []).append((index, region))
    for d in detections:
        box = grid_box(d["bbox"], document[d["page"] - 1])
        anchors = [grid_box(b, document[d["page"] - 1]) for b in d["anchor_boxes"]]
        direct = {i for i, r in by_page.get(d["page"], []) if overlap(r.bbox, box) > 0}
        anchored = {
            i
            for i, r in by_page.get(d["page"], [])
            if any(overlap(r.bbox, b) > 0 for b in anchors)
        }
        owners = sorted(direct | anchored)
        if not owners:
            unmatched.append(d)
        for i in owners:
            if d["reason"] not in chunks[i].confidence_reasons:
                chunks[i].confidence_reasons.append(d["reason"])
            attached.append(
                {
                    "chunk_idx": i,
                    "loss_region": {
                        "page": d["page"],
                        "bbox": box,
                        "space": "page-1000-topleft",
                    },
                    "evidence": d,
                    "mapping": "ink-intersection"
                    if i in direct
                    else "native-anchor-intersection",
                }
            )
    return attached, unmatched


def synthetic_raster_checks(source) -> list[dict]:
    """Controlled probes, kept separate from the natural-source case counts."""
    png = (
        source[98]
        .get_pixmap(matrix=pymupdf.Matrix(3, 3), clip=pymupdf.Rect(246, 129, 288, 139))
        .tobytes("png")
    )
    d = pymupdf.open()
    page = d.new_page(width=300, height=160)
    page.insert_text((20, 40), "Walks", fontsize=10)
    page.insert_image(pymupdf.Rect(50, 32, 92, 42), stream=png)
    page.insert_text((96, 40), "to the left.", fontsize=10)
    raster_inline = detect(page)
    page = d.new_page(width=300, height=160)
    page.insert_text((20, 40), "Find the distance.", fontsize=10)
    page.insert_image(pymupdf.Rect(100, 75, 142, 85), stream=png)
    raster_display = detect(page)
    page = d.new_page(width=300, height=160)
    page.insert_image(pymupdf.Rect(50, 32, 92, 42), stream=png)
    image_only = detect(page)
    page = d.new_page(width=300, height=160)
    page.insert_text((20, 40), "Walks", fontsize=10)
    page.insert_text((50, 40), "35 meters", fontsize=10)
    page.insert_image(pymupdf.Rect(50, 32, 92, 42), stream=png)
    raster_with_text = detect(page)
    assert raster_inline and raster_inline[0]["kind"] == "raster"
    assert not raster_display and not image_only and not raster_with_text
    return [
        {"id": name, "positive": positive, "detected": bool(found), "detections": found}
        for name, positive, found in [
            ("inline-raster", True, raster_inline),
            ("display-raster", True, raster_display),
            ("image-only-raster", True, image_only),
            ("raster-with-native-text", False, raster_with_text),
        ]
    ]


def run(fixture: Path, output: Path, whole_book: bool) -> dict:
    from pipeline.config import cfg
    from pipeline.retrieval.confidence import ocr_pages, score_chunks
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.indexing import content_hash
    from pipeline.retrieval.packing import pack_blocks
    from pipeline.retrieval.search import Passage

    output.mkdir(parents=True, exist_ok=True)
    f = read(fixture)
    pdf, parsed = ROOT / f["source"], ROOT / f["parsed"]
    assert sha(pdf) == f["sha256"], "source changed"
    blocks = read(parsed / "content_list.json")
    refinement = read(parsed / "refinement.json")
    document = pymupdf.open(pdf)
    pages = (
        list(range(1, len(document) + 1))
        if whole_book
        else sorted({c["page"] for c in f["cases"]})
    )
    detections, runtimes = [], []
    for n in pages:
        start = time.perf_counter()
        detections.extend(detect(document[n - 1]))
        runtimes.append(time.perf_counter() - start)
    for i, d in enumerate(detections):
        d["id"] = f"loss-{i}"
    results = []
    for c in f["cases"]:
        matching = [
            d["id"]
            for d in detections
            if d["page"] == c["page"] and overlap(c["bbox"], d["bbox"]) > 0
        ]
        results.append({**c, "detected": bool(matching), "detections": matching})
    counts = Counter((c["positive"], c["detected"]) for c in results)
    start = time.perf_counter()
    chunks = pack_blocks(blocks, frozenset(refinement["furniture"]))
    chunks = retain_headings(blocks, pdf, chunks)
    score_chunks(chunks, pdf, ocr=ocr_pages(blocks))
    chunk_seconds = time.perf_counter() - start
    originals = copy.deepcopy(chunks)
    old_hash = content_hash(chunks)
    attachments, unmatched = attach(chunks, detections, document)
    assert any(
        c.confidence_reasons != o.confidence_reasons
        for c, o in zip(chunks, originals, strict=True)
    )
    assert all(
        c.text == o.text and c.regions == o.regions and c.confidence == o.confidence
        for c, o in zip(chunks, originals, strict=True)
    )
    assert old_hash != content_hash(chunks)
    affected = []
    for i in sorted({a["chunk_idx"] for a in attachments}):
        chunk = chunks[i]
        p = Passage(
            chunk_id=f"benchmark-{i}",
            file_id="benchmark",
            file_name="Physics.pdf",
            chunk_idx=i,
            section_path=chunk.section_path,
            text=chunk.text,
            page_start=chunk.page_start,
            page_end=chunk.page_end,
            regions=[r.as_dict() for r in chunk.regions],
            confidence=chunk.confidence,
            confidence_reasons=chunk.confidence_reasons,
        )
        loss = [a for a in attachments if a["chunk_idx"] == i]
        affected.append(
            {
                "chunk_idx": i,
                **asdict(chunk),
                "regions": p.regions,
                "loss_regions": [a["loss_region"] for a in loss],
                "detection_ids": [a["evidence"]["id"] for a in loss],
                "attachment_methods": [a["mapping"] for a in loss],
                "existing_location_header": p.location(),
                "reason_visible_to_existing_chat": REASON in p.location(),
                "would_need_explicit_visual_review": True,
            }
        )
    summary = {
        "fixture_sha256": sha(fixture),
        "source_sha256": sha(pdf),
        "parsed_content_sha256": sha(parsed / "content_list.json"),
        "parser_manifest": read(parsed / "manifest.json"),
        "pymupdf": pymupdf.VersionBind,
        "pages_scanned": len(pages),
        "detections": len(detections),
        "case_counts": {
            "tp": counts[True, True],
            "fn": counts[True, False],
            "fp": counts[False, True],
            "tn": counts[False, False],
        },
        "seconds": {
            "detect_total": sum(runtimes),
            "detect_median_page": statistics.median(runtimes),
            "detect_max_page": max(runtimes),
            "raw_pack_and_score": chunk_seconds,
        },
        "chunks": len(chunks),
        "affected_chunks": len(affected),
        "unmatched_detections": len(unmatched),
        "reason_visible_in_existing_chat": sum(
            c["reason_visible_to_existing_chat"] for c in affected
        ),
        "existing_confidence_note_below": cfg.confidence_note_below,
        "content_hash_changed": old_hash != content_hash(chunks),
        "text_scores_and_citation_regions_unchanged": True,
        "synthetic_raster": synthetic_raster_checks(document),
    }
    for name, data in [
        ("summary", summary),
        ("cases", results),
        ("detections", detections),
        ("affected-chunks", affected),
        ("unmatched", unmatched),
    ]:
        (output / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {
                k: v
                for k, v in summary.items()
                if k not in {"parser_manifest", "synthetic_raster"}
            },
            indent=2,
        )
    )
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--whole-book", action="store_true")
    args = parser.parse_args()
    run(args.fixture, args.output, args.whole_book)
