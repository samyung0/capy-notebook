"""Compare real ODL output with native targets; report coverage and abstentions.

Synthetic labels provide query excerpts and expected identities. The primary
matcher only sees text. A separate PPTX diagnostic takes page indices from ODL
blocks and assumes one exported PDF page per slide. Neither is an end-to-end
retrieval or visible-highlight accuracy score.
This is a bounded feasibility probe, not a production citation resolver.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import statistics
import unicodedata
from pathlib import Path


def normalized(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKC", text) if not c.isspace())


def load(path: Path):
    return json.loads(path.read_text())


def block_text(block: dict) -> str:
    text = block.get("text", "")
    text += " ".join(block.get("list_items", []))
    text += re.sub(r"<[^>]+>", " ", block.get("table_body", ""))
    return html.unescape(text)


def union(boxes: list[list[float]]) -> list[float]:
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def rect_box(rect: dict) -> list[float]:
    return [rect["x"], rect["y"], rect["x"] + rect["w"], rect["y"] + rect["h"]]


def overlap(left: list[float], right: list[float]) -> float:
    width = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    height = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    area = width * height
    total = (left[2] - left[0]) * (left[3] - left[1])
    total += (right[2] - right[0]) * (right[3] - right[1]) - area
    return area / total if total > 0 else 0


def pdf_matches(pages: list[dict], text: str) -> list[dict]:
    needle = normalized(text)
    matches = []
    if not needle:
        return matches
    for page in pages:
        chars = [
            (c, char["bbox"])
            for line in page["lines"]
            for char in line["chars"]
            for c in normalized(char["text"])
        ]
        haystack = "".join(c for c, _ in chars)
        start = haystack.find(needle)
        while start >= 0:
            matches.append(
                {
                    "page": page["page"],
                    "bbox": union([b for _, b in chars[start : start + len(needle)]]),
                    "width": page["width"],
                    "height": page["height"],
                }
            )
            start = haystack.find(needle, start + 1)
    return matches


def native_matches(
    native: dict, text: str, slide_index: int | None = None
) -> list[dict]:
    needle = normalized(text)
    found = [
        e for e in native["entries"] if needle and needle in normalized(e["value"])
    ]
    if slide_index is not None:
        found = [e for e in found if e["label"].startswith(f"Slide {slide_index + 1},")]
    return found


def native_boxes(native: dict, text: str) -> list[dict]:
    """Native rectangles for complete text groups, used only for geometry comparison."""
    needle = normalized(text)
    result = []
    geometry = native["geometry"]
    if native["format"] == "docx":
        for page in geometry["pages"]:
            for region in page["regions"]:
                groups: dict[str, list[dict]] = {}
                for item in region["items"]:
                    if item.get("text"):
                        key = str(
                            item.get("paraId")
                            or item.get("blockKey")
                            or item.get("blockId")
                        )
                        groups.setdefault(key, []).append(item)
                for items in groups.values():
                    if needle == normalized("".join(i["text"] for i in items)):
                        result.append(
                            {
                                "page": page["pageIndex"] + 1,
                                "width": page["width"],
                                "height": page["height"],
                                "bbox": union([rect_box(i["rect"]) for i in items]),
                            }
                        )
    elif native["format"] == "pptx":
        for slide in geometry["slides"]:
            display = slide["displayList"]
            for item in display["primitives"]:
                if (
                    item["kind"] != "textBox"
                    or not item.get("lines")
                    or item.get("transform")
                ):
                    continue
                text_value = "".join(
                    run["text"] for p in item["paragraphs"] for run in p["runs"]
                )
                if needle == normalized(text_value):
                    result.append(
                        {
                            "page": slide["slideIndex"] + 1,
                            "width": display["width"],
                            "height": display["height"],
                            "bbox": union(
                                [
                                    [
                                        line["x"],
                                        line["y"],
                                        line["x"] + line["width"],
                                        line["y"] + line["height"],
                                    ]
                                    for line in item["lines"]
                                ]
                            ),
                            "shape": item["shapeId"],
                        }
                    )
    return result


def walk_shapes(shapes: list[dict]):
    for shape in shapes:
        yield shape
        yield from walk_shapes(shape["children"])


def expected_ids(native: dict, case: dict) -> list[str]:
    anchor = case["anchor"]
    candidates = native_matches(native, case["text"])
    if native["format"] == "xlsx":
        return [
            e["id"]
            for e in candidates
            if e["label"] == f"{anchor['sheet']}!{anchor['cell']}"
        ]
    if native["format"] == "pptx":
        slide = native["geometry"]["slides"][anchor["slide_index"]]
        shape = next(
            s
            for s in walk_shapes(slide["shapes"])
            if s["sourceId"] == anchor["shape_id"]
        )
        ids = {p["id"] for story in shape["textStories"] for p in story["paragraphs"]}
        return [e["id"] for e in candidates if e["id"] in ids]
    if anchor["kind"] == "paragraph":
        return [
            e["id"]
            for e in candidates
            if e["position"] == f"body:{anchor['paragraph_index']}"
        ]
    prefix = f"body:t{anchor['table_index']}:r{anchor['row']}c{anchor['column']}:"
    return [e["id"] for e in candidates if e["position"].startswith(prefix)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root
    fixtures = load(root / "bookmarks/corpus/manifest.json")["documents"]
    report = {
        "method": __doc__,
        "documents": [],
        "cases": [],
        "odl_page_scoped_pptx": [],
        "negative_controls": [],
        "google_pdf_pairs": [],
    }
    for path in (
        sorted((root / "native").glob("*-docx.json"))
        + sorted((root / "native").glob("*-xlsx.json"))
        + sorted((root / "native").glob("*-pptx.json"))
    ):
        native = load(path)
        folder = (
            "output-google"
            if native["id"].startswith("google-")
            else "output-final"
            if native["id"].startswith("wetland-")
            else "output"
        )
        parsed = root / "odl" / folder / native["id"]
        record = load(parsed / "record.json")
        assert native["sha256"] == record["sha256"], (
            f"Different input bytes: {native['id']}"
        )
        assert record["status"] == "ok"
        assert native.get("geometry") and native.get("identity"), native["id"]
        pages = load(parsed / "pdf-geometry.json")
        blocks = load(parsed / "content-list.json")
        texts = [normalized(block_text(b)) for b in blocks]
        comparisons = []
        for entry in native["entries"]:
            if not normalized(entry["value"]):
                continue
            pdf = pdf_matches(pages, entry["value"])
            boxes = native_boxes(native, entry["value"])
            if len(pdf) == len(boxes) == 1:
                a, b = pdf[0], boxes[0]
                scaled = [
                    a["bbox"][i]
                    / a["width" if i % 2 == 0 else "height"]
                    * b["width" if i % 2 == 0 else "height"]
                    for i in range(4)
                ]
                comparisons.append(
                    {
                        "target": entry["id"],
                        "text": entry["value"],
                        "pdf_page": a["page"],
                        "native_page": b["page"],
                        "pdf_scaled": scaled,
                        "native_bbox": b["bbox"],
                        "iou": overlap(scaled, b["bbox"])
                        if a["page"] == b["page"]
                        else 0,
                    }
                )
        nonempty = [e for e in native["entries"] if normalized(e["value"])]
        if native["id"].startswith("google-"):
            original = parsed.with_name(native["id"].rsplit("-", 1)[0] + "-pdf")
            google_pages = load(original / "pdf-geometry.json")
            pairs = []
            for value in sorted(
                {e["value"] for e in nonempty if len(normalized(e["value"])) >= 20}
            ):
                left, right = (
                    pdf_matches(google_pages, value),
                    pdf_matches(pages, value),
                )
                if len(left) != 1 or len(right) != 1:
                    continue
                a, b = left[0], right[0]
                scaled = [
                    a["bbox"][i]
                    / a["width" if i % 2 == 0 else "height"]
                    * b["width" if i % 2 == 0 else "height"]
                    for i in range(4)
                ]
                pairs.append(
                    {
                        "text": value,
                        "google_page": a["page"],
                        "libreoffice_page": b["page"],
                        "iou": overlap(scaled, b["bbox"])
                        if a["page"] == b["page"]
                        else 0,
                    }
                )
            report["google_pdf_pairs"].append(
                {
                    "id": native["id"],
                    "google_pdf_sha256": load(original / "record.json")["sha256"],
                    "google_pages": len(google_pages),
                    "libreoffice_pages": len(pages),
                    "google_pdf_bytes": (original / "preview.pdf").stat().st_size,
                    "libreoffice_pdf_bytes": (parsed / "preview.pdf").stat().st_size,
                    "unique_text_pairs_at_least_20_characters": pairs,
                    "median_iou": statistics.median(p["iou"] for p in pairs)
                    if pairs
                    else None,
                }
            )
        report["documents"].append(
            {
                "id": native["id"],
                "sha256": record["sha256"],
                "pages": record["pages"],
                "preview_bytes": (parsed / "preview.pdf").stat().st_size,
                "entries": len(nonempty),
                "native_probe_status": native["status"],
                "native_probe_error": native.get("error"),
                "native_entries_found_in_odl": sum(
                    any(normalized(e["value"]) in text for text in texts)
                    for e in nonempty
                ),
                "geometry_comparisons": comparisons,
                "median_direct_bbox_iou": statistics.median(
                    c["iou"] for c in comparisons
                )
                if comparisons
                else None,
            }
        )
        fixture = next(
            (f for f in fixtures if f["id"].replace("_", "-") == native["id"]), None
        )
        if fixture:
            for case in fixture["objects"]:
                expected = expected_ids(native, case)
                assert len(expected) == 1, (native["id"], case["id"], expected)
                query = normalized(case["text"])
                present = any(query in text for text in texts)
                candidates = native_matches(native, case["text"])
                selected = (
                    candidates[0]["id"] if present and len(candidates) == 1 else None
                )
                outcome = (
                    "correct"
                    if selected in expected
                    else "wrong"
                    if selected
                    else "abstain"
                )
                report["cases"].append(
                    {
                        "document": native["id"],
                        "case": case["id"],
                        "tags": case["cases"],
                        "odl_text_present": present,
                        "pdf_occurrences": len(pdf_matches(pages, case["text"])),
                        "candidates": len(candidates),
                        "expected": expected[0],
                        "selected": selected,
                        "outcome": outcome,
                    }
                )
            if native["format"] == "pptx":
                # Build inputs from actual parsed occurrences, independently of labels.
                queries = {case["text"] for case in fixture["objects"]}
                for query in sorted(queries):
                    indices = {
                        b["page_idx"]
                        for b in blocks
                        if normalized(query) in normalized(block_text(b))
                    }
                    for page_index in sorted(indices):
                        candidates = native_matches(native, query, page_index)
                        selected = candidates[0]["id"] if len(candidates) == 1 else None
                        labels = [
                            c
                            for c in fixture["objects"]
                            if c["text"] == query
                            and c["anchor"]["slide_index"] == page_index
                        ]
                        expected = [
                            identity
                            for c in labels
                            for identity in expected_ids(native, c)
                        ]
                        assert len(expected) == 1, (query, page_index, expected)
                        outcome = (
                            "correct"
                            if selected in expected
                            else "wrong"
                            if selected
                            else "abstain"
                        )
                        report["odl_page_scoped_pptx"].append(
                            {
                                "document": native["id"],
                                "query": query,
                                "odl_page_index": page_index,
                                "candidates": len(candidates),
                                "expected": expected[0],
                                "selected": selected,
                                "outcome": outcome,
                            }
                        )
        for query in [
            "A sentence that does not occur in any source file.",
            "Never release water without checking the dam.",
        ]:
            candidates = native_matches(native, query)
            assert not candidates
            report["negative_controls"].append(
                {"document": native["id"], "query": query, "outcome": "abstain"}
            )
    assert not any(c["outcome"] == "wrong" for c in report["cases"])
    assert not any(c["outcome"] == "wrong" for c in report["odl_page_scoped_pptx"])
    report["summary"] = {
        outcome: sum(c["outcome"] == outcome for c in report["cases"])
        for outcome in ["correct", "abstain", "wrong"]
    }
    (root / "evaluation.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(report["summary"]))
    for doc in report["documents"]:
        print(json.dumps({k: v for k, v in doc.items() if k != "geometry_comparisons"}))


if __name__ == "__main__":
    main()
