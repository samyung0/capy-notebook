"""Offline, conservative PDF accessibility-alternative recovery experiment.

Inventory reachable tags, then insert inline alternatives into cached ODL blocks
only when native characters match exactly and a unique block owns the whole box.
Never writes a PDF, production code, or the supplied cached artifacts.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.retrieval.confidence import score_chunks
from pipeline.retrieval.packing import pack_blocks


def compact(text: str) -> str:
    return "".join(text.split())


def refs(value: str) -> list[int]:
    return [int(v) for v in re.findall(r"(\d+)\s+\d+\s+R", value)]


def alternatives(doc: pymupdf.Document) -> list[dict]:
    """Restrict inventory to reachable direct-page /Figure tags with layout boxes.

    This prototype deliberately abstains from inherited pages, array-valued
    layout attributes, form-XObject scopes and other semantic roles.
    """
    page_numbers = {p.xref: p.number for p in doc}
    pending = refs(doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[1])
    seen, result = set(), []
    while pending:
        xref = pending.pop()
        if xref in seen:
            continue
        seen.add(xref)
        kind = doc.xref_get_key(xref, "Type")[1]
        if kind not in {"/StructTreeRoot", "/StructElem"} and not (
            kind == "null" and doc.xref_get_key(xref, "S")[0] == "name"
        ):
            continue
        pending.extend(refs(doc.xref_get_key(xref, "K")[1]))
        alt_kind, alt = doc.xref_get_key(xref, "Alt")
        if alt_kind != "string" or doc.xref_get_key(xref, "S")[1] != "/Figure":
            continue
        page_refs = refs(doc.xref_get_key(xref, "Pg")[1])
        box_kind, box = doc.xref_get_key(xref, "A/BBox")
        if (
            len(page_refs) != 1
            or page_refs[0] not in page_numbers
            or box_kind != "array"
        ):
            continue
        page_index = page_numbers[page_refs[0]]
        rect = pymupdf.Rect([float(v) for v in box.strip("[]").split()])
        rect *= doc[page_index].transformation_matrix
        result.append(
            {
                "xref": xref,
                "page": page_index + 1,
                "bbox_points": list(rect),
                "text": alt,
                "placement": doc.xref_get_key(xref, "A/Placement")[1],
                "mcid": doc.xref_get_key(xref, "K")[1],
            }
        )
    return sorted(result, key=lambda r: r["xref"])


def box_points(block: dict, page: pymupdf.Page) -> pymupdf.Rect:
    return pymupdf.Rect(
        [
            v * (page.rect.width if i % 2 == 0 else page.rect.height) / 1000
            for i, v in enumerate(block["bbox"])
        ]
    )


def chars_for(page: pymupdf.Page) -> list[dict]:
    return [
        char
        for block in page.get_text(
            "rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
        )["blocks"]
        for line in block.get("lines", [])
        if abs(line["dir"][0] - 1) < 0.01
        for span in line["spans"]
        for char in span["chars"]
        if not char["c"].isspace()
    ]


def center(box) -> pymupdf.Point:
    rect = pymupdf.Rect(box)
    return (rect.tl + rect.br) / 2


def fields(block: dict) -> list[str]:
    if block.get("type") == "text":
        return [block.get("text", "")]
    return block.get("list_items", [])


def recover(doc, blocks: list[dict], tags: list[dict]) -> tuple[list[dict], list[dict]]:
    result = copy.deepcopy(blocks)
    by_page = defaultdict(list)
    for index, block in enumerate(blocks):
        if block.get("type") in {"text", "list"} and len(block.get("bbox", [])) == 4:
            by_page[block["page_idx"]].append(index)
    page_chars, block_chars, patches, decisions = {}, {}, defaultdict(list), []
    identities = Counter((t["page"], t["mcid"]) for t in tags)
    boxes = Counter((t["page"], tuple(t["bbox_points"])) for t in tags)
    for tag in tags:
        record = dict(tag)
        decisions.append(record)
        page_index, rect = tag["page"] - 1, pymupdf.Rect(tag["bbox_points"])
        page = doc[page_index]
        if tag["placement"] != "null":
            record["status"] = "block_alternative_review_only"
            continue
        if not re.fullmatch(r"\d+", tag["mcid"]):
            record["status"] = "unsupported_marked_content_scope"
            continue
        if (
            identities[tag["page"], tag["mcid"]] != 1
            or boxes[tag["page"], tuple(tag["bbox_points"])] != 1
        ):
            record["status"] = "duplicate_scope_or_box"
            continue
        if page.rotation or rect.is_empty or not page.rect.contains(rect):
            record["status"] = "unsupported_geometry"
            continue
        owners = [
            i for i in by_page[page_index] if box_points(blocks[i], page).contains(rect)
        ]
        if len(owners) != 1:
            record["status"] = "no_unique_containing_block"
            continue
        index = owners[0]
        record["block_index"] = index
        if page_index not in page_chars:
            page_chars[page_index] = chars_for(page)
        if index not in block_chars:
            owner_box = box_points(blocks[index], page)
            block_chars[index] = [
                c
                for c in page_chars[page_index]
                if owner_box.contains(center(c["bbox"]))
            ]
        chars = block_chars[index]
        source = "".join(c["c"] for c in chars)
        original = "".join(fields(blocks[index]))
        if source != compact(original):
            record["status"] = "native_block_text_mismatch"
            continue
        if any(rect.contains(center(c["bbox"])) for c in chars):
            record["status"] = "native_text_already_present"
            continue
        cy = center(rect).y
        row = [
            (i, c) for i, c in enumerate(chars) if c["bbox"][1] <= cy <= c["bbox"][3]
        ]
        right = [(i, c) for i, c in row if c["bbox"][0] >= rect.x1 - 0.1]
        left = [(i, c) for i, c in row if c["bbox"][2] <= rect.x0 + 0.1]
        if right:
            offset, anchor = min(right, key=lambda pair: pair[1]["bbox"][0])
            after_anchor = False
            gap = anchor["bbox"][0] - rect.x1
        elif left:
            before, anchor = max(left, key=lambda pair: pair[1]["bbox"][2])
            offset, gap = before, rect.x0 - anchor["bbox"][2]
            after_anchor = True
        else:
            record["status"] = "no_same_row_anchor"
            continue
        if gap > anchor["bbox"][3] - anchor["bbox"][1]:
            record["status"] = "anchor_too_distant"
            continue
        # Character identity was checked above. Keep the ODL text and item
        # boundaries; insert before/after the matching native character only.
        locations = [
            (f, i)
            for f, value in enumerate(fields(blocks[index]))
            for i, c in enumerate(value)
            if not c.isspace()
        ]
        f, pos = locations[offset]
        pos += int(after_anchor)
        record.update(status="recovered", field=f, offset=pos)
        patches[index].append(record)
    for index, inserts in patches.items():
        values = fields(result[index]).copy()
        for record in sorted(
            inserts,
            key=lambda r: (r["field"], r["offset"], r["bbox_points"][0]),
            reverse=True,
        ):
            f, pos = record["field"], record["offset"]
            values[f] = values[f][:pos] + " " + record["text"] + " " + values[f][pos:]
        if result[index]["type"] == "text":
            result[index]["text"] = values[0]
        else:
            result[index]["list_items"] = values
        result[index]["_benchmark_alt_xrefs"] = [r["xref"] for r in inserts]
    return result, decisions


def check() -> None:
    """Keep a formula after the last character of its own list item."""
    with pymupdf.open() as doc:
        page = doc.new_page(width=600, height=800)
        page.insert_text((60, 100), "a. x", fontsize=12)
        page.insert_text((60, 124), "b. y", fontsize=12)
        x = page.search_for("x")[0]
        block = {
            "type": "list",
            "page_idx": 0,
            "bbox": [80, 100, 500, 180],
            "list_items": ["a. x", "b. y"],
        }
        tag = {
            "xref": 1,
            "page": 1,
            "bbox_points": [x.x1 + 1, x.y0 + 2, x.x1 + 20, x.y1 - 2],
            "text": "MISSING",
            "placement": "null",
            "mcid": "0",
        }
        revised, decisions = recover(doc, [block], [tag])
        assert revised[0]["list_items"] == ["a. x MISSING ", "b. y"]
        assert decisions[0]["status"] == "recovered"
        for tags in [
            [tag, {**tag, "xref": 2}],
            [{**tag, "mcid": "<</MCID 0/Stm 8 0 R>>"}],
            [{**tag, "placement": "/Block"}],
        ]:
            revised, decisions = recover(doc, [block], tags)
            assert revised == [block]
            assert all(r["status"] != "recovered" for r in decisions)
    print("native Alt list-boundary and abstention checks passed")


def actualtext_probe(pdf: Path) -> dict:
    """Test the tempting metadata-only repair, entirely in memory, on the witness."""
    with pymupdf.open(pdf) as doc:
        page = doc[98]
        xref = page.get_contents()[0]
        stream = doc.xref_stream(xref)
        patched, count = re.subn(
            rb"(/MCID\s+8\b)",
            lambda m: m[0] + b" /ActualText <FEFF003300350020006D00650074006500720073>",
            stream,
        )
        doc.update_stream(xref, patched)
        return {
            "page": 99,
            "mcid": 8,
            "injected_properties": count,
            "native_extraction_recovers_35_meters": "35 meters" in page.get_text(),
            "writes_pdf": False,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--parsed", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--witnesses",
        type=Path,
        default=ROOT / "bench/parsers/fixtures/prince-native-alt.json",
    )
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not all([args.pdf, args.parsed, args.output]):
        parser.error("--pdf, --parsed and --output are required for a source run")
    args.output.mkdir(parents=True, exist_ok=False)
    start = time.perf_counter()
    pdf_sha = hashlib.sha256(args.pdf.read_bytes()).hexdigest()
    gold = json.loads(args.witnesses.read_text("utf-8"))
    assert pdf_sha == gold["source_sha256"], "witnesses belong to a different PDF"
    blocks_bytes = (args.parsed / "content_list.json").read_bytes()
    blocks = json.loads(blocks_bytes)
    refinement = json.loads((args.parsed / "refinement.json").read_text("utf-8"))
    with pymupdf.open(args.pdf) as doc:
        tags = alternatives(doc)
        inventory_s = time.perf_counter() - start
        print(f"inventoried {len(tags)} alternatives in {inventory_s:.2f}s", flush=True)
        repaired, decisions = recover(doc, blocks, tags)
        recovery_s = time.perf_counter() - start - inventory_s
        print(f"recovery took {recovery_s:.2f}s", flush=True)
    furniture = frozenset(refinement["furniture"])
    before, after = pack_blocks(blocks, furniture), pack_blocks(repaired, furniture)
    score_chunks(before, args.pdf)
    score_chunks(after, args.pdf)
    witnesses = []
    for case in gold["cases"]:
        page = case["page"]
        old = "\n".join(c.text for c in before if c.page_start <= page <= c.page_end)
        new = "\n".join(c.text for c in after if c.page_start <= page <= c.page_end)
        local_tags = [t for t in tags if t["page"] == page]
        witnesses.append(
            {
                **case,
                "tag_available": all(
                    any(v in t["text"] for t in local_tags) for v in case["alt_values"]
                ),
                "before_present": all(v in old for v in case["alt_values"]),
                "after_present": all(v in new for v in case["alt_values"]),
            }
        )
    controls = []
    for control in gold["controls"]:
        if "unchanged_context" in control:
            indices = [
                i
                for i, b in enumerate(blocks)
                if b["page_idx"] + 1 == control["page"]
                and control["unchanged_context"] in " ".join(fields(b))
            ]
            passed = bool(indices) and all(blocks[i] == repaired[i] for i in indices)
        else:
            records = [
                r
                for r in decisions
                if r["page"] == control["page"]
                and r["text"].startswith(control["excluded_alt_prefix"])
            ]
            passed = bool(records) and all(r["status"] != "recovered" for r in records)
        controls.append({**control, "passed": passed})
    p99 = [
        c for c in after if c.page_start <= 99 <= c.page_end and "35 meters" in c.text
    ]
    summary = {
        "source_sha256": pdf_sha,
        "cached_blocks_sha256": hashlib.sha256(blocks_bytes).hexdigest(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "fixture_sha256": hashlib.sha256(args.witnesses.read_bytes()).hexdigest(),
        "pymupdf_version": pymupdf.VersionBind,
        "method": "inline Alt insertion; exact native character sequence and containing block; no font/ODL reparse, no models",
        "inventory_seconds": round(inventory_s, 3),
        "recovery_seconds": round(recovery_s, 3),
        "elapsed_seconds": round(time.perf_counter() - start, 3),
        "tags": len(tags),
        "statuses": dict(Counter(r["status"] for r in decisions)),
        "modified_blocks": sum(a != b for a, b in zip(blocks, repaired)),
        "before_chunks": len(before),
        "after_chunks": len(after),
        "witnesses": witnesses,
        "controls": controls,
        "page99_recovered_chunks": [asdict(c) for c in p99],
        "actualtext_metadata_probe": actualtext_probe(args.pdf),
        "limitations": [
            "Same-document engineering witnesses, not an independent accuracy estimate",
            "Inline only; display formulas and alternatives outside containing ODL blocks abstain",
            "Spoken alternatives are source-authored and can still be ambiguous or wrong",
            "No production confidence semantics or artifact contract change",
            "No automatic mathematical conversion of spoken alternatives",
        ],
    }
    for name, value in [
        ("summary.json", summary),
        ("alternatives.json", decisions),
        (
            "witness-chunks.json",
            [
                asdict(c)
                for c in after
                if any(c.page_start <= v["page"] <= c.page_end for v in gold["cases"])
            ],
        ),
    ]:
        (args.output / name).write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8"
        )
    print(
        json.dumps(
            {k: v for k, v in summary.items() if k != "page99_recovered_chunks"},
            ensure_ascii=False,
        )
    )
    assert p99 and all(c["passed"] for c in controls)
    assert any(
        "walks 35 meters to the left, 18 meters to the right, and then 26 meters to the left?"
        in " ".join(c.text.split())
        for c in p99
    )
    assert any(
        "a. Distance is 79 m and displacement is negative 43 m"
        in " ".join(c.text.split())
        for c in p99
    )
    for expected in [
        "b. Distance is negative 79 m and displacement is 43 m",
        "c. Distance is 43 m and displacement is negative 79 m",
        "d. Distance is negative 43 m and displacement is 79 m",
    ]:
        assert any(expected in " ".join(c.text.split()) for c in p99)


if __name__ == "__main__":
    main()
