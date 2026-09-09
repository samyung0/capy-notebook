"""Benchmark conservative column ordering on saved OpenDataLoader blocks.

No parser reruns or source transcription. Requires a fresh output directory and
source-bound check JSON. Writes the actual production chunks for review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import unicodedata
from collections import Counter
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "pipeline"))
from pipeline.retrieval.chunking import chunk_content_list


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def text(block: dict) -> str:
    return " ".join([block.get("text", ""), *block.get("list_items", [])])


def normal(value: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum()
    )


def order_check(value: str, anchors: list[str]) -> dict:
    value = normal(value)
    positions = [value.find(normal(anchor)) for anchor in anchors]
    return {
        "positions": positions,
        "pass": all(p >= 0 for p in positions)
        and all(a < b for a, b in pairwise(positions)),
    }


def repair_page(blocks: list[dict]) -> tuple[list[dict], str]:
    """Reorder only a page with two tall text columns and an empty gutter.

    ponytail: this handles whole-page, left-to-right columns only. Mixed layouts,
    tables and images remain untouched; use a layout model for those pages.
    """
    if any(b.get("type") not in {"text", "list"} for b in blocks):
        return blocks, "non_prose_block"
    if any(len(b.get("bbox", [])) != 4 for b in blocks):
        return blocks, "missing_geometry"
    body = [
        b
        for b in blocks
        if len(text(b)) >= 80
        and not b.get("text_level")
        and b["bbox"][2] - b["bbox"][0] >= 200
    ]
    if len(body) < 4:
        return blocks, "insufficient_prose"
    left_edge = min(b["bbox"][0] for b in body)
    right_edge = max(b["bbox"][2] for b in body)
    candidates = sorted({b["bbox"][2] for b in body})
    for edge in candidates:
        left = [b for b in body if b["bbox"][2] <= edge]
        right = [b for b in body if b["bbox"][0] >= edge + 15]
        if len(left) < 2 or len(right) < 2 or len(left) + len(right) != len(body):
            continue
        cut = (edge + min(b["bbox"][0] for b in right)) / 2
        if (
            not left_edge + (right_edge - left_edge) * 0.3
            < cut
            < left_edge + (right_edge - left_edge) * 0.7
        ):
            continue
        if any(
            max(b["bbox"][3] for b in col) - min(b["bbox"][1] for b in col) < 300
            for col in [left, right]
        ):
            continue
        top = min(b["bbox"][1] for b in body)
        bottom = max(b["bbox"][3] for b in body)
        # Short full-width text inside the columns signals a different layout.
        if any(
            b["bbox"][0] < cut < b["bbox"][2]
            and b["bbox"][1] < bottom
            and b["bbox"][3] > top
            for b in blocks
        ):
            return blocks, "spanning_body_block"
        slots = [
            i
            for i, b in enumerate(blocks)
            if b["bbox"][0] >= left_edge - 2
            and b["bbox"][2] <= right_edge + 2
            and b["bbox"][1] >= top - 2
            and b["bbox"][3] <= bottom + 2
        ]
        ordered = sorted(
            (blocks[i] for i in slots),
            key=lambda b: (b["bbox"][0] >= cut, b["bbox"][1], b["bbox"][0]),
        )
        result = blocks.copy()
        for i, b in zip(slots, ordered):
            result[i] = b
        return result, "reordered" if result != blocks else "already_ordered"
    return blocks, "no_clear_columns"


def repair(blocks: list[dict]) -> tuple[list[dict], list[dict]]:
    # Keep page slots too: unexpected interleaving cannot silently change pages.
    result = blocks.copy()
    receipts = []
    for page in sorted({b["page_idx"] for b in blocks}):
        slots = [i for i, b in enumerate(blocks) if b["page_idx"] == page]
        ordered, reason = repair_page([blocks[i] for i in slots])
        for i, block in zip(slots, ordered):
            result[i] = block
        receipts.append({"page": page, "reason": reason})
    assert Counter(json.dumps(b, sort_keys=True) for b in blocks) == Counter(
        json.dumps(b, sort_keys=True) for b in result
    )
    return result, receipts


def demote_rotated(
    blocks: list[dict], pages: set[int], pdf: Path, *, demote: bool = True
) -> tuple[list[dict], list[dict]]:
    """Keep source-confirmed vertical sidebar labels outside the prose flow."""
    import pymupdf

    result = blocks.copy()
    changes = []
    with pymupdf.open(pdf) as document:
        for page in sorted(pages):
            source = document[page]
            rotated = []
            for group in source.get_text("dict")["blocks"]:
                for line in group.get("lines", []):
                    if abs(line["dir"][0]) < 0.1:
                        rotated.append(line)
            labels = []
            for index, block in enumerate(result):
                if block["page_idx"] != page or not block.get("text_level"):
                    continue
                box = block["bbox"]
                rect = pymupdf.Rect(
                    box[0] * source.rect.width / 1000,
                    box[1] * source.rect.height / 1000,
                    box[2] * source.rect.width / 1000,
                    box[3] * source.rect.height / 1000,
                )
                matching = [
                    line
                    for line in rotated
                    if (pymupdf.Rect(line["bbox"]) & rect).get_area()
                    >= pymupdf.Rect(line["bbox"]).get_area() * 0.8
                ]
                source_text = " ".join(
                    "".join(s["text"] for s in line["spans"]) for line in matching
                )
                if normal(source_text) == normal(text(block)) and normal(source_text):
                    label = block.copy()
                    if demote:
                        del label["text_level"]
                    labels.append((index, label))
                    changes.append(
                        {
                            "page": page,
                            "native_id": block.get("_native_id"),
                            "source_text": source_text,
                            "source_directions": [
                                list(line["dir"]) for line in matching
                            ],
                        }
                    )
            if labels:
                page_slots = [i for i, b in enumerate(result) if b["page_idx"] == page]
                removed = {i for i, _ in labels}
                replacement = [b for _, b in labels] + [
                    result[i] for i in page_slots if i not in removed
                ]
                for index, block in zip(page_slots, replacement):
                    result[index] = block
    return result, changes


def split_continuations(
    blocks: list[dict], pages: set[int], pdf: Path
) -> tuple[list[dict], list[dict]]:
    """Expose a small column-continuation prefix to the existing chunk packer.

    Every derived right-column block retains the original right-column box.
    This is conservative citation geometry, not tighter word-level positioning.
    """
    import pymupdf

    result = []
    changes = []
    with pymupdf.open(pdf) as document:
        for index, block in enumerate(blocks):
            previous = blocks[index - 1] if index else None
            page = block["page_idx"]
            if previous is None or page not in pages or previous["page_idx"] != page:
                result.append(block)
                continue
            left, right = previous["bbox"], block["bbox"]
            if (
                previous.get("type") not in {"text", "list"}
                or block.get("type") != "text"
                or previous.get("text_level")
                or block.get("text_level")
                or left[2] + 15 >= right[0]
                or left[1] <= right[1] + 100
                or not re.search(r"\w$", text(previous))
            ):
                result.append(block)
                continue
            split = re.search(r"[.!?](?=\s)", block["text"])
            if split is None or not 10 <= split.end() <= 400:
                result.append(block)
                continue
            source = document[page]
            spans = [
                s
                for g in source.get_text("dict")["blocks"]
                for line in g.get("lines", [])
                if line["dir"][0] > 0.99
                for s in line["spans"]
                if s["text"].strip()
            ]

            def boundary_font(box, first, source, spans):
                rect = pymupdf.Rect(
                    box[0] * source.rect.width / 1000,
                    box[1] * source.rect.height / 1000,
                    box[2] * source.rect.width / 1000,
                    box[3] * source.rect.height / 1000,
                )
                selected = [
                    s
                    for s in spans
                    if (pymupdf.Rect(s["bbox"]) & rect).get_area()
                    >= pymupdf.Rect(s["bbox"]).get_area() * 0.8
                ]
                selected.sort(key=lambda s: (round(s["origin"][1], 1), s["origin"][0]))
                if not selected:
                    return None
                span = selected[0 if first else -1]
                return span["font"], round(span["size"], 1)

            font = boundary_font(left, False, source, spans)
            if font is None or font != boundary_font(right, True, source, spans):
                result.append(block)
                continue
            prefix, remainder = (
                block["text"][: split.end()],
                block["text"][split.end() :],
            )
            assert prefix + remainder == block["text"]
            result.extend([{**block, "text": prefix}, {**block, "text": remainder}])
            changes.append(
                {
                    "page": page,
                    "native_id": block.get("_native_id"),
                    "left_tail": text(previous)[-100:],
                    "prefix": prefix,
                    "font": font,
                    "bbox": block["bbox"],
                }
            )
    return result, changes


def self_check() -> None:
    def block(x: int, y: int, title: str) -> dict:
        return {
            "type": "text",
            "page_idx": 0,
            "bbox": [x, y, x + 350, y + 180],
            "text": title + " ordinary prose" * 20,
        }

    a, b, c, d = [
        block(x, y, name)
        for x, y, name in [
            (50, 100, "a"),
            (500, 100, "b"),
            (50, 400, "c"),
            (500, 400, "d"),
        ]
    ]
    result, receipt = repair([a, b, c, d])
    assert result == [a, c, b, d] and receipt[0]["reason"] == "reordered"
    assert repair(result)[0] == result
    mixed = [a, b, c, d, {"type": "image", "page_idx": 0, "bbox": [0, 0, 100, 100]}]
    assert repair(mixed)[0] == mixed
    assert not order_check("third first second", ["first", "second", "third"])["pass"]


def check_rotated() -> None:
    import tempfile

    import pymupdf

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "source.pdf"
        with pymupdf.open() as document:
            page = document.new_page(width=1000, height=1000)
            page.insert_text((975, 300), "Sidebar label", rotate=90)
            box = page.get_text("dict")["blocks"][0]["lines"][0]["bbox"]
            document.save(path)
        label = {
            "type": "text",
            "page_idx": 0,
            "bbox": list(box),
            "text": "Sidebar label",
            "text_level": 5,
        }
        body = {
            "type": "text",
            "page_idx": 0,
            "bbox": [50, 100, 400, 300],
            "text": "Prose",
        }
        after, changes = demote_rotated([body, label], {0}, path)
        assert after == [{k: v for k, v in label.items() if k != "text_level"}, body]
        assert len(changes) == 1
        assert demote_rotated([body], {0}, path) == ([body], [])
        assert demote_rotated([body, label], {0}, path, demote=False)[0] == [
            label,
            body,
        ]


def check_continuations() -> None:
    import tempfile

    import pymupdf

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "source.pdf"
        with pymupdf.open() as document:
            page = document.new_page(width=1000, height=1000)
            page.insert_text((50, 530), "A sentence continues into")
            page.insert_text((500, 130), "the next column. Another sentence follows.")
            document.save(path)
        left = {
            "type": "text",
            "page_idx": 0,
            "bbox": [50, 500, 400, 580],
            "text": "A sentence continues into",
        }
        right = {
            "type": "text",
            "page_idx": 0,
            "bbox": [500, 100, 850, 280],
            "text": "the next column. Another sentence follows.",
        }
        after, changes = split_continuations([left, right], {0}, path)
        assert len(changes) == 1 and len(after) == 3
        assert after[1]["text"] + after[2]["text"] == right["text"]
        assert after[1]["bbox"] == after[2]["bbox"] == right["bbox"]
        list_left = {**left, "type": "list", "list_items": [left["text"]]}
        del list_left["text"]
        assert len(split_continuations([list_left, right], {0}, path)[1]) == 1
        assert (
            split_continuations(
                [{**left, "text": left["text"] + "."}, right], {0}, path
            )[1]
            == []
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--run", default="screen-odl-java-headers-screen-r1")
    parser.add_argument("--checks", type=Path)
    parser.add_argument("--demote-rotated", action="store_true")
    parser.add_argument("--move-rotated", action="store_true")
    parser.add_argument("--split-continuations", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    self_check()
    if args.demote_rotated or args.move_rotated:
        check_rotated()
    if args.split_continuations:
        check_continuations()
    if args.self_check:
        print("reading order checks passed")
        return
    if args.root is None or args.output is None or args.checks is None:
        parser.error("root, output and --checks are required")
    args.output.mkdir(parents=True, exist_ok=False)
    checks = read(args.checks)["checks"]
    corpus = {e["id"]: e for e in read(args.root / "corpus.json")["entries"]}
    for check in checks:
        pdf = args.root / corpus[check["case"]]["pdf"]
        if digest(pdf) != check["pdf_sha256"]:
            raise ValueError(f"source mismatch: {pdf}")
    summaries = []
    timings = []
    for content_path in sorted(
        (args.root / "results" / args.run).glob("*/content_list.json")
    ):
        case = content_path.parent.name
        native_receipt = read(content_path.parent / "result.json")
        if (
            native_receipt["input_sha256"] != corpus[case]["pdf_sha256"]
            or native_receipt["state"] != "ok"
        ):
            raise ValueError(f"native source mismatch or incomplete result: {case}")
        before = read(content_path)
        start = time.perf_counter()
        after, receipt = repair(before)
        rotated = []
        continuations = []
        changed_pages = {r["page"] for r in receipt if r["reason"] == "reordered"}
        if (
            args.demote_rotated or args.move_rotated or args.split_continuations
        ) and changed_pages:
            pdf = args.root / corpus[case]["pdf"]
            if digest(pdf) != corpus[case]["pdf_sha256"]:
                raise ValueError(f"source mismatch: {pdf}")
            if args.demote_rotated or args.move_rotated:
                after, rotated = demote_rotated(
                    after, changed_pages, pdf, demote=args.demote_rotated
                )
            if args.split_continuations:
                after, continuations = split_continuations(after, changed_pages, pdf)
        elapsed = time.perf_counter() - start
        timings.append(elapsed)
        out = args.output / case
        save(out / "content_list.json", after)
        save(out / "pages.json", receipt)
        save(out / "rotated.json", rotated)
        save(out / "continuations.json", continuations)
        versions = {}
        for name, blocks in [("before", before), ("after", after)]:
            chunks = [
                {**asdict(c), "indexed_text": c.indexed_text()}
                for c in chunk_content_list(blocks)
            ]
            save(out / f"chunks-{name}.json", chunks)
            versions[name] = {"blocks": blocks, "chunks": chunks}
        case_checks = []
        for check in [c for c in checks if c["case"] == case]:
            judged = {"id": check["id"], "role": check["role"]}
            for name, data in versions.items():
                blocks = [b for b in data["blocks"] if b["page_idx"] == check["page"]]
                raw = "\n".join(text(b) for b in blocks)
                chunks = [
                    c
                    for c in data["chunks"]
                    if c["page_start"] <= check["page"] + 1 <= c["page_end"]
                ]
                packed = "\n".join(c["text"] for c in chunks)
                judged[name] = {
                    "raw": order_check(raw, check["anchors"]),
                    "chunks": order_check(packed, check["anchors"]),
                    "indexed": order_check(
                        "\n".join(c["indexed_text"] for c in chunks), check["anchors"]
                    ),
                    "single_chunk": any(
                        order_check(c["text"], check["anchors"])["pass"] for c in chunks
                    ),
                    "boundary_same_chunk": any(
                        order_check(c["text"], check["anchors"][:2])["pass"]
                        for c in chunks
                    ),
                }
            case_checks.append(judged)
        summaries.append(
            {
                "case": case,
                "input_sha256": digest(content_path),
                "repair_seconds": elapsed,
                "page_reasons": dict(Counter(r["reason"] for r in receipt)),
                "rotated": rotated,
                "continuations": continuations,
                "checks": case_checks,
            }
        )
    if not summaries:
        raise ValueError("no saved results")
    from pipeline.retrieval import chunking

    from pipeline import config

    save(
        args.output / "summary.json",
        {
            "script_sha256": digest(Path(__file__)),
            "chunker_sha256": digest(Path(chunking.__file__)),
            "config_sha256": digest(Path(config.__file__)),
            "corpus_sha256": digest(args.root / "corpus.json"),
            "checks_sha256": digest(args.checks),
            "run": args.run,
            "demote_rotated": args.demote_rotated,
            "move_rotated": args.move_rotated,
            "split_continuations": args.split_continuations,
            "repair_seconds": sum(timings),
            "cases": summaries,
        },
    )
    print(
        json.dumps(
            {
                "cases": len(summaries),
                "repair_seconds": sum(timings),
                "output": str(args.output),
            }
        )
    )


if __name__ == "__main__":
    main()
