"""Benchmark hidden OCR-layer triage and local RapidOCR recovery, without services."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from itertools import pairwise
from pathlib import Path


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def normalized(text: str) -> str:
    return "".join(char.lower() for char in text if char.isalnum())


def distance(left: str, right: str) -> int:
    previous = list(range(len(right) + 1))
    for i, char in enumerate(left):
        row = [i + 1]
        for j, other in enumerate(right):
            row.append(
                min(row[-1] + 1, previous[j + 1] + 1, previous[j] + (char != other))
            )
        previous = row
    return previous[-1]


def source_facts(page) -> dict:
    import pymupdf

    spans = page.get_texttrace()
    count = sum(len(span["chars"]) for span in spans)
    hidden = sum(
        len(span["chars"])
        for span in spans
        if span["type"] == 3 or span["opacity"] == 0
    )
    coverage = max(
        (
            (pymupdf.Rect(image["bbox"]) & page.rect).get_area() / page.rect.get_area()
            for image in page.get_image_info()
        ),
        default=0,
    )
    return {
        "characters": count,
        "hidden_characters": hidden,
        "hidden_fraction": hidden / count if count else 0,
        "largest_image_fraction": coverage,
        "eligible": count >= 100 and hidden >= 0.9 * count and coverage >= 0.9,
    }


def probe_rect(page):
    import pymupdf

    blocks = [block for block in page.get_text("dict")["blocks"] if block["type"] == 0]
    block = max(
        blocks,
        key=lambda block: sum(
            len(span["text"]) for line in block["lines"] for span in line["spans"]
        ),
    )
    rect = pymupdf.Rect()
    for line in block["lines"][:4]:
        rect |= pymupdf.Rect(line["bbox"])
    return (rect + (-3, -3, 3, 3)) & page.rect


def prepare(args: argparse.Namespace) -> None:
    import pymupdf

    args.output.mkdir(parents=True, exist_ok=False)
    corpus = json.loads((args.root / "corpus.json").read_text())["entries"]
    screening = [
        entry
        for entry in corpus
        if entry["suite"] == "screen" and entry["kind"] != "controlled_raster"
    ]
    save(
        args.output / "protocol.json",
        {
            "started_unix": time.time(),
            "script_sha256": sha(Path(__file__).read_bytes()),
            "checks_sha256": sha(args.checks.read_bytes()),
            "gate": "At least 100 extracted characters, >=90% hidden, largest raster >=90% page. Probe first four lines of largest native text block at 288 dpi. Compare normalized edit distance with native clip; diagnostic threshold 2% fixed before OCR.",
            "arms": [
                "probe-288dpi",
                "page-1280",
                "page-2560",
                "column-left-2560",
                "column-right-2560",
            ],
            "corpus": screening,
        },
    )
    (args.output / "source-checks.json").write_bytes(args.checks.read_bytes())
    (args.output / "runner.py.snapshot").write_bytes(Path(__file__).read_bytes())
    audit = []
    jobs = []
    control_pages = {
        "attention": 1,
        "taln-complexity": 1,
        "ccl-feedback": 2,
        "spain-figures": 7,
        "japan-migration": 10,
        "german-education": 8,
        "hongkong-figures": 12,
    }
    started = time.monotonic()
    for entry in screening:
        doc = pymupdf.open(args.root / entry["pdf"])
        assert sha((args.root / entry["pdf"]).read_bytes()) == entry["pdf_sha256"]
        for index, page in enumerate(doc):
            source_page = entry["source_pages"][index]
            identity = f"{entry['parent']}-p{source_page + 1}"
            facts = source_facts(page)
            audit.append(
                {
                    "id": identity,
                    "case": entry["id"],
                    "screen_page": index,
                    "source_page": source_page,
                    **facts,
                }
            )
            if (
                entry["parent"] != "nist-accelerometers"
                and source_page != control_pages[entry["parent"]]
            ):
                continue
            target = args.output / identity
            target.mkdir()
            page.get_pixmap(dpi=144).save(target / "source.png")
            specs = [("probe-288dpi", probe_rect(page), 288, None)]
            if entry["parent"] == "nist-accelerometers":
                specs += [
                    ("page-1280", page.rect, 288, 1280),
                    ("page-2560", page.rect, 288, 2560),
                ]
                if source_page in [2, 4]:
                    middle = page.rect.width / 2
                    specs += [
                        (
                            "column-left-2560",
                            pymupdf.Rect(0, 0, middle, page.rect.height),
                            288,
                            2560,
                        ),
                        (
                            "column-right-2560",
                            pymupdf.Rect(middle, 0, page.rect.width, page.rect.height),
                            288,
                            2560,
                        ),
                    ]
            for name, rect, dpi, edge in specs:
                image = target / f"{name}.png"
                page.get_pixmap(dpi=dpi, clip=rect).save(image)
                jobs.append(
                    {
                        "id": f"{identity}--{name}",
                        "page_id": identity,
                        "case": entry["id"],
                        "screen_page": index,
                        "source_page": source_page,
                        "arm": name,
                        "image": str(image),
                        "image_sha256": sha(image.read_bytes()),
                        "pdf_sha256": entry["pdf_sha256"],
                        "page_size": [page.rect.width, page.rect.height],
                        "rect": list(rect),
                        "native_clip": page.get_textbox(rect),
                        "max_edge": edge,
                        "eligible": facts["eligible"],
                    }
                )
    save(
        args.output / "audit.json",
        {"seconds_with_rendering": time.monotonic() - started, "pages": audit},
    )
    save(args.output / "jobs.json", jobs)
    print(
        json.dumps(
            {
                "pages": len(audit),
                "eligible": [page["id"] for page in audit if page["eligible"]],
                "jobs": len(jobs),
            }
        ),
        flush=True,
    )


def ocr(args: argparse.Namespace) -> None:
    import importlib.metadata

    import numpy
    from PIL import Image
    from rapidocr import RapidOCR

    target = args.output / "ocr"
    target.mkdir(exist_ok=False)
    models = {
        "Det": args.models / "PP-OCRv6_det_small.onnx",
        "Rec": args.models / "PP-OCRv6_rec_small.onnx",
        "Cls": args.models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    }
    params = {
        **{f"{kind}.model_path": str(path) for kind, path in models.items()},
        "EngineConfig.onnxruntime.intra_op_num_threads": 8,
        "EngineConfig.onnxruntime.use_cuda": False,
        "Global.text_score": 0.5,
    }
    save(
        target / "run.json",
        {
            "params": params,
            "models": {kind: sha(path.read_bytes()) for kind, path in models.items()},
            "versions": {
                name: importlib.metadata.version(name)
                for name in ["rapidocr", "onnxruntime"]
            },
            "script_sha256": sha(Path(__file__).read_bytes()),
            "started_unix": time.time(),
        },
    )
    started = time.monotonic()
    reader = RapidOCR(params=params)
    load_seconds = time.monotonic() - started
    records = []
    for job in json.loads((args.output / "jobs.json").read_text()):
        call_started = time.monotonic()
        assert sha(Path(job["image"]).read_bytes()) == job["image_sha256"]
        with Image.open(job["image"]) as original:
            image = original.convert("RGB")
            if job["max_edge"]:
                image.thumbnail(
                    (job["max_edge"], job["max_edge"]), Image.Resampling.LANCZOS
                )
            output = reader(numpy.asarray(image))
            lines = (
                []
                if output.boxes is None
                else [
                    {"box": box.tolist(), "text": text, "score": float(score)}
                    for box, text, score in zip(
                        output.boxes, output.txts, output.scores
                    )
                ]
            )
            result = {
                **job,
                "image_size": list(image.size),
                "seconds": time.monotonic() - call_started,
                "lines": lines,
                "text": "\n".join(line["text"] for line in lines),
            }
        a, b = normalized(job["native_clip"]), normalized(result["text"])
        result["native_ocr_disagreement"] = distance(a, b) / max(len(a), len(b), 1)
        result["mean_score"] = sum(line["score"] for line in lines) / max(len(lines), 1)
        save(target / f"{job['id']}.json", result)
        records.append(
            {
                key: result[key]
                for key in [
                    "id",
                    "seconds",
                    "native_ocr_disagreement",
                    "mean_score",
                    "eligible",
                ]
            }
        )
        print(json.dumps(records[-1]), flush=True)
    save(
        target / "complete.json",
        {
            "seconds": time.monotonic() - started,
            "load_seconds": load_seconds,
            "records": records,
        },
    )


def check() -> None:
    assert distance("kitten", "sitting") == 3
    assert distance("", "123") == 3
    assert distance("123", "123") == 0
    assert normalized("A-b C, 1.2 中文") == "abc12中文"
    assert fragment_match("hello", "prefix hello suffix")["edits"] == 0
    blocks = [
        {"type": "text", "page_idx": 0, "bbox": box, "text": label * 40}
        for box, label in [
            ([20, 10, 430, 40], "left top "),
            ([500, 10, 910, 40], "right top "),
            ([20, 50, 430, 80], "left bottom "),
            ([500, 50, 910, 80], "right bottom "),
        ]
    ]
    ordered, _ = recover_hidden_ocr_order(blocks, {0})
    assert ordered == [blocks[0], blocks[2], blocks[1], blocks[3]]
    assert recover_hidden_ocr_order(ordered, {0})[0] == ordered
    assert recover_hidden_ocr_order(blocks, set())[0] == blocks
    print("OCR disagreement checks passed")


def block_text(block: dict) -> str:
    return block.get("text", block.get("latex", "\n".join(block.get("list_items", []))))


def gutter(blocks: list[dict]) -> float | None:
    candidates = [
        block
        for block in blocks
        if len(block_text(block)) >= 100
        and "bbox" in block
        and block["bbox"][2] - block["bbox"][0] < 600
    ]
    starts = sorted({block["bbox"][0] for block in candidates})
    if len(starts) < 2:
        return None
    left, right = max(pairwise(starts), key=lambda pair: pair[1] - pair[0])
    if right - left < 150:
        return None
    boundary = (left + right) / 2
    end = max(block["bbox"][2] for block in candidates if block["bbox"][0] < boundary)
    start = min(
        block["bbox"][0] for block in candidates if block["bbox"][0] >= boundary
    )
    return (end + start) / 2 if start > end else None


def column_order(blocks: list[dict], cut: float) -> list[dict]:
    images = [block for block in blocks if block.get("type") in {"image", "chart"}]
    text = [block for block in blocks if block not in images]
    wide = sorted(
        [
            block
            for block in text
            if block["bbox"][0] < cut - 80 and block["bbox"][2] > cut + 80
        ],
        key=lambda block: block["bbox"][1],
    )
    remaining = [block for block in text if block not in wide]
    result = images.copy()

    def ordered(items: list[dict]) -> list[dict]:
        return sorted(
            items,
            key=lambda block: (
                (block["bbox"][0] + block["bbox"][2]) / 2 > cut,
                block["bbox"][1],
                block["bbox"][0],
            ),
        )

    for barrier in wide:
        above = [
            block
            for block in remaining
            if (block["bbox"][1] + block["bbox"][3]) / 2 < barrier["bbox"][1]
        ]
        result.extend(ordered(above))
        result.append(barrier)
        remaining = [block for block in remaining if block not in above]
    result.extend(ordered(remaining))
    return result


def recover_hidden_ocr_order(
    blocks: list[dict], eligible_pages: set[int]
) -> tuple[list[dict], list[dict]]:
    """Reorder only source-verified hidden OCR pages; preserve every native block."""
    result = blocks.copy()
    decisions = []
    for page in sorted({block["page_idx"] for block in blocks}):
        positions = [
            index for index, block in enumerate(blocks) if block["page_idx"] == page
        ]
        original = [blocks[index] for index in positions]
        cut = gutter(original) if page in eligible_pages else None
        if cut is None or any("bbox" not in block for block in original):
            decisions.append({"page_idx": page, "reordered": False, "gutter": cut})
            continue
        ordered = column_order(original, cut)
        assert column_order(ordered, cut) == ordered
        assert sorted(
            json.dumps(block, sort_keys=True) for block in original
        ) == sorted(json.dumps(block, sort_keys=True) for block in ordered)
        for index, block in zip(positions, ordered):
            result[index] = block
        decisions.append(
            {"page_idx": page, "reordered": ordered != original, "gutter": cut}
        )
    return result, decisions


def ocr_blocks(result: dict) -> list[dict]:
    width, height = result["image_size"]
    return [
        {
            "type": "text",
            "page_idx": result["screen_page"],
            "text": line["text"],
            "bbox": [
                min(p[0] for p in line["box"]) / width * 1000,
                min(p[1] for p in line["box"]) / height * 1000,
                max(p[0] for p in line["box"]) / width * 1000,
                max(p[1] for p in line["box"]) / height * 1000,
            ],
            "_ocr_score": line["score"],
        }
        for line in result["lines"]
    ]


def fragment_match(expected: str, actual: str) -> dict:
    """Minimum edits to a contiguous substring; unmatched page prefix/suffix free."""
    left, right = normalized(expected), normalized(actual)
    costs = [0] * (len(right) + 1)
    starts = list(range(len(right) + 1))
    for i, char in enumerate(left):
        row, positions = [i + 1], [0]
        for j, other in enumerate(right):
            value, start = min(
                (row[-1] + 1, positions[-1]),
                (costs[j + 1] + 1, starts[j + 1]),
                (costs[j] + (char != other), starts[j]),
            )
            row.append(value)
            positions.append(start)
        costs, starts = row, positions
    end = min(range(len(costs)), key=lambda index: costs[index])
    return {
        "edits": costs[end],
        "expected_chars": len(left),
        "error_fraction": costs[end] / max(len(left), 1),
        "matched_normalized_text": right[starts[end] : end],
    }


def replay(args: argparse.Namespace) -> None:
    import copy
    from dataclasses import asdict

    from structured_recovery import chunk_content_list

    base = args.output.parent
    native = json.loads((base / "native.json").read_text())
    arms = {
        "native": native,
        "mineru": json.loads((base / "mineru.json").read_text()),
        "native-column-order": [],
        "ocr1280-column-order": [],
        "ocr2560-column-order": [],
        "selective995": [],
    }
    target = args.replay_output
    target.mkdir(exist_ok=False)
    save(
        target / "protocol.json",
        {
            "started_unix": time.time(),
            "script_sha256": sha(Path(__file__).read_bytes()),
            "selective_rule": "Preserve native blocks except paragraphs >=50 characters with >=99.5% mean OCR score, >=3 matched OCR lines, 0.5%-8% normalized disagreement and 80%-120% character length. This is an exploratory heuristic, not a claim OCR confidence measures correctness.",
            "source_fragments_sha256": sha(
                (base / "source-fragments.json").read_bytes()
            ),
            "heldout_fragments_sha256": sha(
                (base / "heldout-fragments.json").read_bytes()
            ),
            "baseline_sha256": sha((base / "native.json").read_bytes()),
            "mineru_sha256": sha((base / "mineru.json").read_bytes()),
        },
    )
    selections = []
    pages = [1, 3, 4, 5, 9]
    for index, source_page in enumerate(pages):
        blocks = [block for block in native if block.get("page_idx") == index]
        cut = gutter(blocks)
        if cut is None:
            for arm in [
                "native-column-order",
                "ocr1280-column-order",
                "ocr2560-column-order",
                "selective995",
            ]:
                arms[arm].extend(blocks)
            selections.append(
                {
                    "source_page": source_page,
                    "gutter": None,
                    "state": "unchanged_no_supported_gutter",
                }
            )
            continue
        arms["native-column-order"].extend(column_order(blocks, cut))
        rendered = {}
        for edge in [1280, 2560]:
            record = json.loads(
                (
                    args.output
                    / "ocr"
                    / f"nist-accelerometers-p{source_page}--page-{edge}.json"
                ).read_text()
            )
            rendered[edge] = ocr_blocks(record)
            arms[f"ocr{edge}-column-order"].extend(
                column_order(
                    [block for block in blocks if block["type"] == "image"]
                    + rendered[edge],
                    cut,
                )
            )
        selected = copy.deepcopy(blocks)
        replacements = []
        for block_index, block in enumerate(selected):
            if block.get("type") != "text" or len(block_text(block)) < 50:
                continue
            box = block["bbox"]
            matches = [
                line
                for line in rendered[2560]
                if box[0] <= (line["bbox"][0] + line["bbox"][2]) / 2 <= box[2]
                and box[1] <= (line["bbox"][1] + line["bbox"][3]) / 2 <= box[3]
            ]
            if len(matches) < 3:
                continue
            proposed = "\n".join(line["text"] for line in matches)
            a, b = normalized(block_text(block)), normalized(proposed)
            score = sum(line["_ocr_score"] for line in matches) / len(matches)
            disagreement = distance(a, b) / max(len(a), len(b), 1)
            if (
                score >= 0.995
                and 0.005 <= disagreement <= 0.08
                and 0.8 <= len(b) / max(len(a), 1) <= 1.2
            ):
                replacements.append(
                    {
                        "block_index": block_index,
                        "native": block_text(block),
                        "ocr": proposed,
                        "score": score,
                        "disagreement": disagreement,
                    }
                )
                block["text"] = proposed
        arms["selective995"].extend(column_order(selected, cut))
        selections.append(
            {"source_page": source_page, "gutter": cut, "replacements": replacements}
        )
    save(target / "selection.json", selections)
    fragments = (
        json.loads((base / "source-fragments.json").read_text())["fragments"]
        + json.loads((base / "heldout-fragments.json").read_text())["fragments"]
    )
    scores = []
    for name, blocks in arms.items():
        folder = target / name
        folder.mkdir()
        save(folder / "content_list.json", blocks)
        chunks = chunk_content_list(blocks)
        save(folder / "chunks.json", [asdict(chunk) for chunk in chunks])
        checks = []
        for fragment in fragments:
            index = pages.index(fragment["page"])
            text = "\n".join(
                block_text(block) for block in blocks if block.get("page_idx") == index
            )
            checks.append(
                {"id": fragment["id"], **fragment_match(fragment["text"], text)}
            )
            checks[-1]["exact_final_chunk_indices"] = [
                chunk_index
                for chunk_index, chunk in enumerate(chunks)
                if normalized(fragment["text"]) in normalized(chunk.text)
            ]
            (folder / f"source-page-{fragment['page']}.txt").write_text(
                text, encoding="utf-8"
            )
        scores.append({"arm": name, "chunks": len(chunks), "checks": checks})
    save(target / "score.json", scores)
    repaired, decisions = recover_hidden_ocr_order(native, set(range(5)))
    assert repaired == arms["native-column-order"]
    assert recover_hidden_ocr_order(repaired, set(range(5)))[0] == repaired
    save(
        target / "native-order-verification.json",
        {
            "all_original_blocks_preserved": True,
            "idempotent": True,
            "decisions": decisions,
        },
    )
    print(
        json.dumps(
            [
                {
                    **{key: record[key] for key in ["arm", "chunks"]},
                    "fragment_edits": {
                        check["id"]: check["edits"] for check in record["checks"]
                    },
                }
                for record in scores
            ]
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "ocr", "replay", "check"])
    parser.add_argument("--root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--checks", type=Path)
    parser.add_argument("--models", type=Path)
    parser.add_argument("--replay-output", type=Path)
    args = parser.parse_args()
    if args.mode == "check":
        check()
    elif args.mode == "prepare":
        prepare(args)
    elif args.mode == "replay":
        if args.replay_output is None:
            parser.error("replay requires a fresh --replay-output directory")
        replay(args)
    else:
        ocr(args)
