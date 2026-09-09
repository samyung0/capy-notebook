"""Retain source-confirmed headings that existing chunks omit. Benchmark only."""

from __future__ import annotations

import argparse
import copy
import re
import time
import unicodedata
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

import pymupdf
from experiment_odl_native_text import (
    center_inside,
    compact,
    read,
    rect_for,
    save,
    sha,
    source_text,
)
from pipeline.retrieval.chunking import Chunk, Region


def canonical(text):
    text = unicodedata.normalize("NFKC", text).replace("\xad", "")
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\n\s*(?=[a-zäöüß])", "", text)
    return compact(text)


def retain_headings(blocks, pdf, chunks):
    """Add literal source headings, retaining every original chunk unchanged."""
    locations = defaultdict(list)
    furniture = defaultdict(set)
    for index, block in enumerate(blocks):
        if len(block.get("bbox", [])) == 4 and isinstance(block.get("page_idx"), int):
            locations[(block["page_idx"] + 1, tuple(block["bbox"]))].append(index)
        text = block.get("text", "")
        box = block.get("bbox", [])
        if text and len(box) == 4 and (box[3] < 100 or box[1] > 900):
            label = re.sub(r"\d+", "", canonical(text))
            if label:
                furniture[(label, box[3] < 100)].add(block["page_idx"])
    spans = []
    for chunk in chunks:
        positions = [
            i
            for region in chunk.regions
            for i in locations.get((region.page, tuple(region.bbox)), [])
        ]
        spans.append((min(positions), max(positions)) if positions else None)
    insertions, decisions, pages = defaultdict(list), [], {}
    with pymupdf.open(pdf) as document:
        for index, block in enumerate(blocks):
            text = block.get("text", "")
            box = block.get("bbox", [])
            if (
                not block.get("text_level")
                or len(box) != 4
                or len(compact(text)) < 12
                or sum(c.isalpha() for c in text) < 8
            ):
                continue
            page_number = block["page_idx"] + 1
            page_chunks = [
                c
                for c in chunks
                if c.page_start is not None
                and c.page_start <= page_number <= c.page_end
            ]
            if any(
                canonical(text) in canonical(value)
                for c in page_chunks
                for value in (c.text, c.section_path, c.indexed_text())
            ):
                continue
            record = {"index": index, "page": page_number, "text": text, "bbox": box}
            label = re.sub(r"\d+", "", canonical(text))
            if (box[3] < 100 or box[1] > 900) and len(
                furniture[(label, box[3] < 100)]
            ) >= 3:
                decisions.append({**record, "state": "repeated_margin"})
                continue
            page = document[page_number - 1]
            if page.rotation:
                decisions.append({**record, "state": "rotated_page"})
                continue
            if page_number not in pages:
                pages[page_number] = (
                    page.get_text(
                        "rawdict",
                        flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES,
                    )["blocks"],
                    page.get_texttrace(),
                )
            groups, traces = pages[page_number]
            area = rect_for(block, page)
            literal = source_text(groups, area)
            if canonical(literal) != canonical(text):
                decisions.append(
                    {**record, "state": "source_mismatch", "source_text": literal}
                )
                continue
            visible = [
                span
                for span in traces
                if span["opacity"] >= 0.99
                and span["type"] != 3
                and span["dir"][0] > 0.99
            ]
            count = sum(
                1
                for span in visible
                for char in span["chars"]
                if chr(char[0]).isalpha() and center_inside(char[3], area)
            )
            if count < sum(c.isalpha() for c in text):
                decisions.append({**record, "state": "source_not_visible"})
                continue
            if any(span and span[0] < index < span[1] for span in spans):
                decisions.append({**record, "state": "inside_existing_chunk"})
                continue
            slot = next(
                (j for j, span in enumerate(spans) if span and span[0] > index),
                len(chunks),
            )
            added = Chunk(
                text=text,
                page_start=page_number,
                page_end=page_number,
                regions=[Region(page_number, list(box))],
            )
            insertions[slot].append(added)
            decisions.append(
                {
                    **record,
                    "state": "retained",
                    "before_chunk": slot,
                    "source_text": literal,
                    "visible_letters": count,
                }
            )
    result = []
    for index in range(len(chunks) + 1):
        result.extend(insertions[index])
        if index < len(chunks):
            result.append(chunks[index])
    return result, decisions


def load_chunks(path):
    return [
        Chunk(
            **{k: v for k, v in row.items() if k not in {"regions", "indexed_text"}},
            regions=[Region(**r) for r in row["regions"]],
        )
        for row in read(path)
    ]


def judge(chunks, check):
    hits = [
        i
        for i, chunk in enumerate(chunks)
        if chunk.page_start is not None
        and chunk.page_start <= check["page"] <= chunk.page_end
        and canonical(check["text"]) in canonical(chunk.indexed_text())
    ]
    return {
        "id": check["id"],
        "kind": check["kind"],
        "pass": bool(hits) if check["kind"] == "retain" else not hits,
        "chunks": hits,
    }


def check():
    from unittest.mock import patch

    assert canonical("Ausbildungsabsol-\nvent:innen") == canonical(
        "Ausbildungsabsolvent:innen"
    )
    assert canonical("2019-2022") != canonical("20192022")
    assert canonical("non-formal") != canonical("nonformal")
    original_open = pymupdf.open
    document = original_open()
    page = document.new_page()
    page.insert_text((50, 100), "A confirmed source heading", fontsize=14)
    page.insert_text((50, 150), "An invisible OCR heading", fontsize=14, render_mode=3)
    page.insert_text((50, 200), "The next section", fontsize=14)
    page.insert_text((50, 225), "Source body remains unchanged.", fontsize=11)
    blocks = []
    for index, group in enumerate(page.get_text("dict")["blocks"]):
        box = group["bbox"]
        blocks.append(
            {
                "type": "text",
                "text": " ".join(
                    s["text"] for line in group["lines"] for s in line["spans"]
                ),
                "page_idx": 0,
                "bbox": [
                    box[0] / page.rect.width * 1000,
                    box[1] / page.rect.height * 1000,
                    box[2] / page.rect.width * 1000,
                    box[3] / page.rect.height * 1000,
                ],
            }
        )
        if index < 3:
            blocks[-1]["text_level"] = 1
    original = Chunk(
        text=blocks[-1]["text"],
        section_path=blocks[-2]["text"],
        page_start=1,
        page_end=1,
        regions=[Region(1, blocks[-1]["bbox"])],
    )
    data = document.tobytes()
    with patch.object(
        pymupdf, "open", lambda _: original_open(stream=data, filetype="pdf")
    ):
        retained, decisions = retain_headings(blocks, "memory", [original])
        assert len(retained) == 2 and retained[1] == original
        assert retained[0].text == blocks[0]["text"] and retained[0].section_path == ""
        assert retained[0].regions == [Region(1, blocks[0]["bbox"])]
        assert any(d["state"] == "source_not_visible" for d in decisions)
        assert retain_headings(blocks, "memory", retained)[0] == retained
    # Joining section and body text must not hide a terminal source hyphen.
    page.insert_text((50, 280), "Already indexed source head-", fontsize=14)
    group = page.get_text("dict")["blocks"][-1]
    box = group["bbox"]
    heading = {
        "type": "text",
        "text": "Already indexed source head-",
        "text_level": 1,
        "page_idx": 0,
        "bbox": [
            box[0] / page.rect.width * 1000,
            box[1] / page.rect.height * 1000,
            box[2] / page.rect.width * 1000,
            box[3] / page.rect.height * 1000,
        ],
    }
    existing = Chunk(
        text="ing continues", section_path=heading["text"], page_start=1, page_end=1
    )
    data = document.tobytes()
    with patch.object(
        pymupdf, "open", lambda _: original_open(stream=data, filetype="pdf")
    ):
        assert retain_headings([heading], "memory", [existing])[0] == [existing]
    print(
        "Source-visible retention, OCR abstention, citation placement, chunk preservation and idempotence checks passed"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.root or not args.output:
        parser.error("root and fresh output required")
    args.output.mkdir(parents=True, exist_ok=False)
    sources, checks = (
        read(args.root / "sources.json"),
        read(args.root / "checks-v1.json"),
    )
    assert sha(args.root / "sources.json") == checks["sources_sha256"]
    results = []
    for case, source in sources.items():
        for field, digest in [
            ("content_list", "content_sha256"),
            ("chunks", "chunks_sha256"),
            ("source_pdf", "source_pdf_sha256"),
            ("parsed_pdf", "parsed_pdf_sha256"),
        ]:
            assert sha(source[field]) == source[digest]
        blocks, chunks = read(source["content_list"]), load_chunks(source["chunks"])
        before = copy.deepcopy(chunks)
        started = time.perf_counter()
        retained, decisions = retain_headings(blocks, source["parsed_pdf"], chunks)
        seconds = time.perf_counter() - started
        assert chunks == before
        originals = iter(retained)
        assert all(any(item == chunk for item in originals) for chunk in chunks)
        again, second = retain_headings(blocks, source["parsed_pdf"], retained)
        assert again == retained and not any(d["state"] == "retained" for d in second)
        target = args.output / case
        save(
            target / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in retained],
        )
        save(target / "decisions.json", decisions)
        rubric = [c for c in checks["checks"] if c["case"] == case]
        results.append(
            {
                "case": case,
                "pages": source["pages"],
                "seconds": seconds,
                "added_chunks": len(retained) - len(chunks),
                "original_chunks_unchanged": True,
                "idempotent": True,
                "baseline": [judge(chunks, c) for c in rubric],
                "retained": [judge(retained, c) for c in rubric],
            }
        )
    save(
        args.output / "summary.json",
        {
            "script_sha256": sha(__file__),
            "checks_sha256": sha(args.root / "checks-v1.json"),
            "records": results,
        },
    )
    print(
        "Added",
        sum(r["added_chunks"] for r in results),
        "chunks in",
        round(sum(r["seconds"] for r in results), 3),
        "seconds",
    )
    print(
        "Checks",
        sum(c["pass"] for r in results for c in r["baseline"]),
        "->",
        sum(c["pass"] for r in results for c in r["retained"]),
    )


if __name__ == "__main__":
    main()
