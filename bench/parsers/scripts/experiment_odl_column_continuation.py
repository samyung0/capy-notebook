"""Move source-confirmed column continuations ahead of intervening small print."""

from __future__ import annotations

import argparse
import copy
import json
import re
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import pymupdf
from experiment_odl_heading_retention import canonical, load_chunks, retain_headings
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_native_text import (
    center_inside,
    read,
    rect_for,
    save,
    sha,
    source_text,
)


def text(block):
    return (
        block.get("text", "")
        if block.get("type") == "text"
        else "\n".join(block.get("list_items", []))
    )


def source_page(page):
    groups = page.get_text(
        "rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    )["blocks"]
    glyphs = []
    for span in page.get_texttrace():
        if span["type"] == 3 or span["opacity"] < 0.99 or span["dir"][0] < 0.99:
            continue
        for code, _, origin, box in span["chars"]:
            if chr(code).isalnum():
                glyphs.append((box, origin, span["font"], span["size"]))
    return groups, glyphs


def selected_glyphs(glyphs, area):
    return sorted(
        [g for g in glyphs if center_inside(g[0], area)],
        key=lambda g: (round(g[1][1], 1), g[1][0]),
    )


def prove(page, groups, glyphs, left, right, intervening):
    a, b = rect_for(left, page), rect_for(right, page)
    first, following = text(left).strip(), text(right).strip()
    stop = re.search(r"[.!?](?=\s|$)", following)
    if stop is None or not 20 <= stop.end() <= 400:
        return None
    prefix = following[: stop.end()]
    if canonical(source_text(groups, a)) != canonical(first):
        return None
    if not canonical(source_text(groups, b)).startswith(canonical(prefix)):
        return None
    ag, bg = selected_glyphs(glyphs, a), selected_glyphs(glyphs, b)
    if not ag or not bg:
        return None
    font, size = ag[-1][2:]
    if bg[0][2] != font or abs(bg[0][3] - size) > 0.05:
        return None
    # The endpoints must be the last/first body-sized text in their columns.
    if any(
        g[3] >= size * 0.95
        and (
            a.x0 <= g[1][0] <= a.x1
            and g[1][1] > a.y1 + 1
            or b.x0 <= g[1][0] <= b.x1
            and g[1][1] < b.y0 - 1
        )
        for g in glyphs
    ):
        return None
    smaller = []
    for block in intervening:
        if block.get("text_level") or len(block.get("bbox", [])) != 4:
            return None
        box = rect_for(block, page)
        if not (
            box.x1 <= a.x1 + 1
            and box.y0 >= a.y1 - 1
            or box.x0 >= b.x0 - 1
            and box.y1 <= b.y0 + 1
        ):
            return None
        selected = selected_glyphs(glyphs, box)
        if not selected or max(g[3] for g in selected) > size * 0.92:
            return None
        smaller.append(max(g[3] for g in selected))
    return {"font": font, "size": size, "intervening_sizes": smaller, "prefix": prefix}


def repair_columns(blocks, pdf):
    result, decisions = copy.deepcopy(blocks), []
    with pymupdf.open(pdf) as document:
        for number in sorted({b["page_idx"] for b in blocks}):
            slots = [i for i, b in enumerate(result) if b["page_idx"] == number]
            page_blocks = [result[i] for i in slots]
            groups = glyphs = None
            moved = False
            for i, left in enumerate(page_blocks):
                a = left.get("bbox", [])
                if (
                    len(a) != 4
                    or left.get("type") not in {"text", "list"}
                    or left.get("text_level")
                    or len(text(left)) < 25
                    or not re.search(r"\w$", text(left).strip())
                    or a[1] < 650
                    or a[2] - a[0] < 200
                ):
                    continue
                for j in range(i + 2, min(i + 32, len(page_blocks))):
                    right = page_blocks[j]
                    b = right.get("bbox", [])
                    if (
                        len(b) != 4
                        or right.get("type") != "text"
                        or right.get("text_level")
                        or a[2] + 15 >= b[0]
                        or a[1] < b[1] + 200
                        or not 0.8 <= (b[2] - b[0]) / (a[2] - a[0]) <= 1.2
                    ):
                        continue
                    page = document[number]
                    if page.rotation:
                        break
                    if groups is None:
                        groups, glyphs = source_page(page)
                    proof = prove(
                        page, groups, glyphs, left, right, page_blocks[i + 1 : j]
                    )
                    if proof is None:
                        continue
                    ordered = (
                        page_blocks[: i + 1]
                        + [right]
                        + page_blocks[i + 1 : j]
                        + page_blocks[j + 1 :]
                    )
                    for slot, block in zip(slots, ordered):
                        result[slot] = block
                    decisions.append(
                        {
                            "page": number + 1,
                            "left_index": slots[i],
                            "right_index": slots[j],
                            "intervening_indices": slots[i + 1 : j],
                            "left_tail": text(left)[-120:],
                            **proof,
                        }
                    )
                    moved = True
                    break
                if moved:
                    break
    return result, decisions


def judge(chunks, check):
    return {
        "id": check["id"],
        "pass": any(
            c.page_start is not None
            and c.page_start <= check["page"] <= c.page_end
            and canonical(check["text"]) in canonical(c.text)
            for c in chunks
        ),
    }


def check():
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        for small, hidden in [(True, False), (False, False), (True, True)]:
            pdf = Path(directory) / f"{small}-{hidden}.pdf"
            document = pymupdf.open()
            page = document.new_page(width=600, height=800)
            texts = [
                "An ordinary body paragraph continues from",
                "1 A footnote preserves independent facts.",
                "Another source finishes the sentence.",
            ]
            for position, value, size in zip(
                [(60, 720), (60, 755), (330, 200)], texts, [10, 8 if small else 10, 10]
            ):
                page.insert_text(
                    position, value, fontsize=size, render_mode=3 if hidden else 0
                )
            blocks = []
            for value in texts:
                box = page.search_for(value)[0]
                blocks.append(
                    {
                        "type": "text",
                        "text": value,
                        "page_idx": 0,
                        "bbox": [
                            box.x0 / 600 * 1000,
                            box.y0 / 800 * 1000,
                            box.x1 / 600 * 1000,
                            box.y1 / 800 * 1000,
                        ],
                    }
                )
            document.save(pdf)
            document.close()
            revised, decisions = repair_columns(blocks, pdf)
            expected = (
                [blocks[0], blocks[2], blocks[1]] if small and not hidden else blocks
            )
            assert revised == expected
            assert bool(decisions) == (small and not hidden)
            assert repair_columns(revised, pdf)[0] == revised
    print(
        "Visible continuation preserved; body-sized interruption and hidden text abstain"
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
        parser.error("root and fresh output are required")
    args.output.mkdir(parents=True, exist_ok=False)
    sources, checks = (
        read(args.root / "sources.json"),
        read(args.root / "checks-v1.json"),
    )
    assert sha(args.root / "sources.json") == checks["sources_sha256"]
    records = []
    for case, source in sources.items():
        for field, digest in [
            ("content_list", "content_sha256"),
            ("parsed_pdf", "parsed_pdf_sha256"),
            ("chunks", "chunks_sha256"),
        ]:
            assert sha(source[field]) == source[digest]
        blocks, baseline = read(source["content_list"]), load_chunks(source["chunks"])
        before = copy.deepcopy(blocks)
        started = time.perf_counter()
        revised, decisions = repair_columns(blocks, source["parsed_pdf"])
        seconds = time.perf_counter() - started
        assert blocks == before
        assert repair_columns(revised, source["parsed_pdf"])[0] == revised
        assert Counter(json.dumps(b, sort_keys=True) for b in blocks) == Counter(
            json.dumps(b, sort_keys=True) for b in revised
        )
        _, chunks, _ = chunk_native_bounded(revised)
        chunks, _ = retain_headings(revised, source["parsed_pdf"], chunks)
        if not decisions:
            assert chunks == baseline
        target = args.output / case
        save(target / "content_list.json", revised)
        save(
            target / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
        )
        save(target / "decisions.json", decisions)
        subset = [c for c in checks["checks"] if c["case"] == case]
        records.append(
            {
                "case": case,
                "pages": source["pages"],
                "seconds": seconds,
                "decisions": decisions,
                "baseline": [judge(baseline, c) for c in subset],
                "candidate": [judge(chunks, c) for c in subset],
                "native_blocks_preserved": True,
                "idempotent": True,
                "caller_unchanged": True,
            }
        )
    save(
        args.output / "summary.json",
        {
            "script_sha256": sha(__file__),
            "checks_sha256": sha(args.root / "checks-v1.json"),
            "records": records,
        },
    )
    print(
        "Moved",
        sum(len(r["decisions"]) for r in records),
        "seconds",
        round(sum(r["seconds"] for r in records), 3),
    )
    print(
        "Checks",
        sum(c["pass"] for r in records for c in r["baseline"]),
        "->",
        sum(c["pass"] for r in records for c in r["candidate"]),
    )


if __name__ == "__main__":
    main()
