"""Source-backed heading metadata experiments on saved parser output only."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

import pymupdf
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_reading_order import normal, repair_page


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def source_headings(blocks: list[dict], pdf: Path) -> dict[int, dict]:
    evidence = {}
    with pymupdf.open(pdf) as document:
        page_lines = {}
        for index, block in enumerate(blocks):
            if block.get("type") != "text" or len(block.get("bbox", [])) != 4:
                continue
            box = block["bbox"]
            if not block.get("text_level") and not (box[0] > 950 or box[2] < 50):
                continue
            page_index = block["page_idx"]
            page = document[page_index]
            if page.rotation:
                continue
            if page_index not in page_lines:
                page_lines[page_index] = [
                    line
                    for group in page.get_text(
                        "dict",
                        flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES,
                    )["blocks"]
                    for line in group.get("lines", [])
                ]
            rect = pymupdf.Rect(
                box[0] * page.rect.width / 1000,
                box[1] * page.rect.height / 1000,
                box[2] * page.rect.width / 1000,
                box[3] * page.rect.height / 1000,
            )
            matched = [
                (span, line)
                for line in page_lines[page_index]
                for span in line["spans"]
                # Empty spans retain the existing zero-area matching behavior.
                if not (
                    span["bbox"][0] < span["bbox"][2]
                    and span["bbox"][1] < span["bbox"][3]
                    and (
                        span["bbox"][2] <= rect.x0
                        or span["bbox"][0] >= rect.x1
                        or span["bbox"][3] <= rect.y0
                        or span["bbox"][1] >= rect.y1
                    )
                )
                if (pymupdf.Rect(span["bbox"]) & rect).get_area()
                >= pymupdf.Rect(span["bbox"]).get_area() * 0.6
            ]
            source_text = " ".join(span["text"] for span, _ in matched)
            if normal(source_text) != normal(block.get("text", "")):
                continue
            letters = [(s, line) for s, line in matched if normal(s["text"])]
            if not letters:
                continue
            style = max(letters, key=lambda item: len(normal(item[0]["text"])))[0]
            footer = re.fullmatch(r"[\s|–—-]*(\d{1,4})[\s|–—-]*", block["text"])
            footer_key = None
            if footer and box[1] > 900:
                footer_key = (
                    int(footer[1]) - page_index,
                    round((box[0] + box[2]) / 50),
                    round((box[1] + box[3]) / 20),
                    style["font"],
                    round(style["size"]),
                )
            tab_key = None
            if (
                (box[0] > 950 or box[2] < 50)
                and all(abs(line["dir"][0]) < 0.1 for _, line in letters)
                and all(s["flags"] & 16 and s["color"] == 0xFFFFFF for s, _ in letters)
            ):
                tab_key = (normal(block["text"]), style["font"], round(style["size"]))
            running_key = None
            if (
                box[3] < 100
                and len(normal(block["text"])) >= 5
                and any(c.isalpha() for c in block["text"])
                and all(
                    line["dir"][0] > 0.99 and s["flags"] & 16 for s, line in letters
                )
            ):
                running_key = (
                    normal(block["text"]),
                    style["font"],
                    round(style["size"]),
                    round(box[1] / 10),
                )
            clipped_prefix = False
            if all(line["dir"][0] > 0.99 for _, line in letters):
                bottom = max(s["bbox"][3] for s, _ in letters)
                following = [
                    line
                    for line in page_lines[page_index]
                    if line["dir"][0] > 0.99
                    and 0 <= line["bbox"][1] - bottom <= style["size"] * 0.3
                    and abs(line["bbox"][0] - rect.x0) <= style["size"]
                ]
                for line in following:
                    spans = [s for s in line["spans"] if normal(s["text"])]
                    if len(spans) < 2:
                        continue
                    first = spans[0]
                    if (
                        first["font"] == style["font"]
                        and abs(first["size"] - style["size"]) < 0.2
                        and first["color"] == style["color"]
                        and first["text"].rstrip().endswith(":")
                        and any(s["font"] != style["font"] for s in spans[1:])
                    ):
                        clipped_prefix = True
            evidence[index] = {
                "page": page_index,
                "native_id": block.get("_native_id"),
                "source_text": source_text,
                "bbox": box,
                "native_heading": bool(block.get("text_level")),
                "font": style["font"],
                "size": style["size"],
                "color": style["color"],
                "footer_key": footer_key,
                "tab_key": tab_key,
                "running_key": running_key,
                "clipped_prefix": clipped_prefix,
            }
    return evidence


def rewrite(
    blocks: list[dict], evidence: dict[int, dict], arm: str
) -> tuple[list[dict], list[dict]]:
    result = copy.deepcopy(blocks)
    footer_pages, tab_pages, running_pages = (
        defaultdict(set),
        defaultdict(set),
        defaultdict(set),
    )
    for item in evidence.values():
        if item["footer_key"]:
            footer_pages[tuple(item["footer_key"])].add(item["page"])
        if item["tab_key"]:
            tab_pages[tuple(item["tab_key"][1:])].add(item["page"])
        if item.get("running_key"):
            running_pages[tuple(item["running_key"])].add(item["page"])
    changes, tab_indices = [], set()
    previous_tab = None
    for index, item in evidence.items():
        block = result[index]
        reason = None
        if item["footer_key"] and len(footer_pages[tuple(item["footer_key"])]) >= 3:
            block.pop("text_level", None)
            reason = "sequence_confirmed_footer"
        if (
            arm in {"tabs", "structure"}
            and item["tab_key"]
            and len(tab_pages[tuple(item["tab_key"][1:])]) >= 3
        ):
            tab_indices.add(index)
            if item["tab_key"][0] == previous_tab:
                block.pop("text_level", None)
                reason = "repeated_chapter_tab"
            else:
                block["text_level"] = 1
                reason = "chapter_tab_root"
            previous_tab = item["tab_key"][0]
        if arm == "structure" and item["clipped_prefix"]:
            block.pop("text_level", None)
            reason = "clipped_inline_label"
        running = item.get("running_key")
        if arm == "structure" and running and len(running_pages[tuple(running)]) >= 2:
            earlier_title = any(
                other.get("native_heading")
                and other["page"] < item["page"]
                and normal(other["source_text"]) == normal(item["source_text"])
                and (other["font"] != item["font"] or other["bbox"][1] >= 100)
                for other in evidence.values()
            )
            if earlier_title:
                block.pop("text_level", None)
                reason = "running_header_with_prior_title"
        if reason:
            changes.append({"index": index, "reason": reason, **item})
    for page in sorted({b["page_idx"] for b in result}):
        slots = [i for i, b in enumerate(result) if b["page_idx"] == page]
        reordered = [result[i] for i in slots]
        if arm == "structure":
            # Reuse the existing empty-gutter check, letting column headings
            # travel with their column rather than keeping both above its prose.
            shadow = [
                {**b, "text_level": None, "_slot": i} for i, b in enumerate(reordered)
            ]
            sorted_shadow, reason = repair_page(shadow)
            if reason == "reordered":
                reordered = [reordered[b["_slot"]] for b in sorted_shadow]
                changes.append({"page": page, "reason": "column_headings_ordered"})
        if any(i in tab_indices for i in slots):
            tabs = [result[i] for i in slots if i in tab_indices]
            ids = {id(b) for b in tabs}
            reordered = tabs + [b for b in reordered if id(b) not in ids]
        for i, block in zip(slots, reordered):
            result[i] = block

    def without_level(block):
        return json.dumps(
            {k: v for k, v in block.items() if k != "text_level"}, sort_keys=True
        )

    assert Counter(map(without_level, result)) == Counter(map(without_level, blocks))
    return result, changes


def judge(chunks, check: dict) -> dict:
    hits = [
        (i, c)
        for i, c in enumerate(chunks)
        if c.page_start is not None
        and c.page_start <= check["page"] <= c.page_end
        and normal(check["anchor"]) in normal(c.text)
    ]
    rows = []
    for index, chunk in hits:
        components = chunk.section_path.split(" › ")
        path = normal(chunk.section_path)
        numeric = any(re.fullmatch(r"[\s|–—\-\d.,%]+", c) for c in components)
        passed = (
            all(normal(h) in path for h in check["require"])
            and all(normal(h) not in path for h in check["forbid"])
            and not numeric
            and ("root" not in check or normal(components[0]) == normal(check["root"]))
        )
        rows.append(
            {
                "chunk": index,
                "pass": passed,
                "section_path": chunk.section_path,
                "regions": [asdict(r) for r in chunk.regions],
            }
        )
    return {
        "id": check["id"],
        "role": check["role"],
        "pass": bool(rows) and all(r["pass"] for r in rows),
        "hits": rows,
    }


def check_rules() -> None:
    import tempfile

    blocks = [
        {
            "type": "text",
            "text": str(i + 1),
            "text_level": 4,
            "page_idx": i,
            "bbox": [480, 960, 520, 980],
        }
        for i in range(3)
    ]
    evidence = {
        i: {
            "page": i,
            "footer_key": (1, 20, 97, "font", 10),
            "tab_key": None,
            "clipped_prefix": False,
        }
        for i in range(3)
    }
    after, _ = rewrite(blocks, evidence, "footers")
    assert all("text_level" not in b for b in after)
    assert all(b["text_level"] == 4 for b in blocks)
    assert (
        rewrite(blocks[:2], {i: evidence[i] for i in range(2)}, "footers")[0]
        == blocks[:2]
    )
    with tempfile.TemporaryDirectory() as tmp:
        pdf = Path(tmp) / "source.pdf"
        source_blocks = []
        with pymupdf.open() as document:
            for page_index in range(3):
                page = document.new_page(width=1000, height=1000)
                page.draw_rect((950, 0, 1000, 1000), fill=(0, 0.3, 0.6))
                records = [
                    (str(page_index + 1), (480, 975), 10, "helv", 0, (0, 0, 0), 4),
                    (
                        "Tab section",
                        (975, 300),
                        12,
                        "hebo",
                        90,
                        (1, 1, 1),
                        4 if page_index == 0 else None,
                    ),
                    (
                        "Running chapter",
                        (50, 500 if page_index == 0 else 60),
                        18 if page_index == 0 else 12,
                        "hebo",
                        0,
                        (0, 0, 0),
                        2,
                    ),
                ]
                for text, point, size, font, rotation, color, level in records:
                    page.insert_text(
                        point,
                        text,
                        fontsize=size,
                        fontname=font,
                        rotate=rotation,
                        color=color,
                    )
                    span = [
                        s
                        for g in page.get_text("dict")["blocks"]
                        for line in g.get("lines", [])
                        for s in line["spans"]
                        if s["text"] == text
                    ][-1]
                    block = {
                        "type": "text",
                        "text": text,
                        "page_idx": page_index,
                        "bbox": list(span["bbox"]),
                    }
                    if level is not None:
                        block["text_level"] = level
                    source_blocks.append(block)
            document.save(pdf)
        source_evidence = source_headings(source_blocks, pdf)
        changed, receipts = rewrite(source_blocks, source_evidence, "structure")
        reasons = Counter(r["reason"] for r in receipts)
        assert reasons["sequence_confirmed_footer"] == 3
        assert reasons["chapter_tab_root"] == 1 and reasons["repeated_chapter_tab"] == 2
        assert reasons["running_header_with_prior_title"] == 2
        assert next(b for b in changed if b["text"] == "Tab section")["text_level"] == 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--checks", type=Path)
    args = parser.parse_args()
    check_rules()
    if args.check:
        print("heading metadata conservation and footer checks passed")
        return
    if args.root is None or args.output is None or args.checks is None:
        parser.error("root, new output and --checks are required")
    sources = read(args.root / "sources.json")
    checks = read(args.checks)["checks"]
    args.output.mkdir(parents=True, exist_ok=False)
    summary = []
    for case, item in sources.items():
        pdf, native = Path(item["pdf"]), Path(item["content_list"])
        if sha(pdf) != item["pdf_sha256"] or sha(native) != item["content_sha256"]:
            raise ValueError(f"source or native content changed: {case}")
        blocks = read(native)
        start = time.perf_counter()
        evidence = source_headings(blocks, pdf)
        inspect_seconds = time.perf_counter() - start
        save(args.output / case / "source-headings.json", evidence)
        for arm in ["baseline", "footers", "tabs", "structure"]:
            start = time.perf_counter()
            prepared, changes = (
                (blocks, []) if arm == "baseline" else rewrite(blocks, evidence, arm)
            )
            seconds = time.perf_counter() - start
            _, chunks, tables = chunk_native_bounded(prepared)
            directory = args.output / case / arm
            save(directory / "content_list.json", prepared)
            save(
                directory / "chunks.json",
                [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
            )
            save(directory / "changes.json", changes)
            save(directory / "table-context.json", tables)
            results = [judge(chunks, c) for c in checks if c["case"] == case]
            summary.append(
                {
                    "case": case,
                    "arm": arm,
                    "inspect_seconds": inspect_seconds,
                    "rewrite_seconds": seconds,
                    "changes": dict(Counter(c["reason"] for c in changes)),
                    "checks": results,
                }
            )
    save(
        args.output / "summary.json",
        {
            "sources_sha256": sha(args.root / "sources.json"),
            "checks_sha256": sha(args.checks),
            "script_sha256": sha(Path(__file__)),
            "runs": summary,
        },
    )
    for arm in ["baseline", "footers", "tabs", "structure"]:
        results = [c for r in summary if r["arm"] == arm for c in r["checks"]]
        print(arm, sum(c["pass"] for c in results), "/", len(results))


if __name__ == "__main__":
    main()
