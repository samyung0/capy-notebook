"""Benchmark-only native layout bypass for MinerU 3.4.5 and PyMuPDF 1.28.2.

Call install() before parsing and stats() after each measured run. Eligible pages
skip model analysis, then use MinerU's existing paragraph split, title processing
and content-list generation. Digital mode retains the original PDFium text fill;
OCR mode receives the already inspected native line text. All other pages keep
the original pipeline. This accepts only simple horizontal prose: it is a routing
experiment, not an alternative general PDF parser.
"""

from __future__ import annotations

import copy
import itertools
import math
import re
import threading
import time
import unicodedata
from collections import Counter
from functools import wraps
from statistics import median

import pymupdf

_LOCK = threading.Lock()
_STATS_LOCK = threading.Lock()
_COUNTS: Counter = Counter()
_ATTRIBUTE = "_capy_native_page_layout"
_MATH_FONT = re.compile(r"math|symbol|cmsy|cmmi|cmex|msam|msbm|stix", re.IGNORECASE)


def stats() -> dict:
    """Return cumulative numeric counters. The caller can subtract snapshots."""
    with _STATS_LOCK:
        return dict(_COUNTS)


def _count(**values) -> None:
    with _STATS_LOCK:
        _COUNTS.update(values)


def _valid_box(box, width: float, height: float) -> bool:
    return (
        len(box) == 4
        and all(math.isfinite(v) for v in box)
        and 0 <= box[0] < box[2] <= width + 1
        and 0 <= box[1] < box[3] <= height + 1
    )


def _safe_render_groups(drawings: list[dict], traces: list[dict]) -> bool:
    text_bounds = (
        pymupdf.Rect(_box_union(trace["bbox"] for trace in traces)) if traces else None
    )
    for drawing in drawings:
        if drawing["type"] == "group" and (
            drawing.get("opacity") != 1.0
            or drawing.get("blendmode") != "Normal"
            or drawing.get("knockout") is not False
        ):
            return False
        if drawing["type"] == "clip":
            if (
                len(drawing["items"]) != 1
                or drawing["items"][0][0] != "re"
                or text_bounds is None
            ):
                return False
            # Fail closed instead of reconstructing per-span clipping scopes.
            scissor = drawing["scissor"] + (-0.05, -0.05, 0.05, 0.05)
            if not scissor.contains(text_bounds):
                return False
    return True


def _plain_drawings(drawings: list[dict], page, traces: list[dict]) -> bool:
    rules = 0
    first_text = min((t["seqno"] for t in traces), default=-1)
    for drawing in drawings:
        rect = drawing["rect"]
        # A white page background painted before text contributes no structure.
        if (
            drawing["type"] == "f"
            and drawing.get("fill") == (1.0, 1.0, 1.0)
            and len(drawing["items"]) == 1
            and drawing["items"][0][0] == "re"
            and rect.contains(page.rect)
            and drawing["seqno"] < first_text
        ):
            continue
        if (
            drawing["type"] != "s"
            or len(drawing["items"]) != 1
            or drawing["items"][0][0] != "l"
            or rect.height > 0.1
            or drawing["width"] > 1
        ):
            return False
        rules += 1
    # ponytail: at most two rules; ruled tables and graphics stay with MinerU.
    return rules <= 2


def _box_union(boxes) -> list[float]:
    boxes = list(boxes)
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]


def _page_number(line, height: float) -> bool:
    return bool(
        re.fullmatch(r"[0-9]+|[ivxlcdm]{1,6}", line["text"].strip(), re.IGNORECASE)
    ) and (line["bbox"][3] < height * 0.1 or line["bbox"][1] > height * 0.9)


def _margin_number_pair(first, second, height: float) -> bool:
    return (_page_number(first, height) or _page_number(second, height)) and (
        max(first["bbox"][3], second["bbox"][3]) < height * 0.1
        or min(first["bbox"][1], second["bbox"][1]) > height * 0.9
    )


def _label(block, body_size: float, height: float) -> str:
    lines = block["lines"]
    text = " ".join(line["text"] for line in lines)
    if len(lines) == 1 and _page_number(lines[0], height):
        return "number"
    size = median(line["size"] for line in lines)
    if (
        len(lines) <= 2
        and len(text) <= 160
        and (
            size >= body_size * 1.18
            or (all(line["bold"] for line in lines) and size >= body_size)
        )
    ):
        return "paragraph_title"
    return "text"


def _aligned_native_rows(blocks, body_size: float) -> bool:
    rows = []
    for line in sorted(
        (line for block in blocks for line in block["lines"]),
        key=lambda line: line["baseline"],
    ):
        if rows and abs(rows[-1][0]["baseline"] - line["baseline"]) < body_size * 0.15:
            rows[-1].append(line)
        else:
            rows.append([line])
    for first, second in itertools.pairwise(rows):
        first_gaps = [gap for line in first for gap in line.get("gaps", [])]
        second_gaps = [gap for line in second for gap in line.get("gaps", [])]
        if (
            sum(
                any(abs(left - right) < body_size * 0.2 for right in second_gaps)
                for left in first_gaps
            )
            >= 2
        ):
            return True
    fragmented = [row for row in rows if len(row) >= 3]
    for first, second in itertools.pairwise(fragmented):
        matches = sum(
            any(
                abs(left["bbox"][0] - right["bbox"][0]) < body_size * 0.2
                for right in second
            )
            for left in first
        )
        if matches >= 3:
            return True
    return False


def _normalize_blocks(blocks, body_size: float, width: float, height: float):
    normalized = []
    for block in blocks:
        rows = []
        for line in sorted(
            block["lines"], key=lambda line: (line["baseline"], line["bbox"][0])
        ):
            if (
                rows
                and abs(rows[-1][0]["baseline"] - line["baseline"]) < body_size * 0.15
            ):
                rows[-1].append(line)
            else:
                rows.append([line])
        lines = []
        for row in rows:
            row.sort(key=lambda line: line["bbox"][0])
            # PDF producers sometimes expose each justified word as a line.
            # Only join a long word run with explicit source spaces and tight gaps.
            if (
                len(row) >= 4
                and sum(len(line["text"]) for line in row) >= 30
                and all(
                    0 <= right["bbox"][0] - left["bbox"][2] <= body_size
                    and (left["text"][-1].isspace() or right["text"][0].isspace())
                    and abs(left["size"] - right["size"]) < body_size * 0.1
                    and left["bold"] == right["bold"]
                    for left, right in itertools.pairwise(row)
                )
            ):
                lines.append(
                    {
                        **row[0],
                        "bbox": _box_union(line["bbox"] for line in row),
                        "text": " ".join(line["text"].strip() for line in row),
                    }
                )
            elif len(row) > 1:
                # Keep distant cells separate so the global column guard sees them.
                if lines:
                    normalized.append(
                        {
                            "bbox": _box_union(line["bbox"] for line in lines),
                            "lines": lines,
                        }
                    )
                    lines = []
                normalized.extend(
                    {"bbox": line["bbox"], "lines": [line]} for line in row
                )
            else:
                lines.extend(row)
        if lines:
            normalized.append(
                {"bbox": _box_union(line["bbox"] for line in lines), "lines": lines}
            )
    normalized.sort(key=lambda block: (block["bbox"][1], block["bbox"][0]))
    for block in normalized:
        block["fragment"] = len(block["lines"]) == 1
        block["label"] = _label(block, body_size, height)
    for block in normalized:
        if (
            block["label"] == "text"
            and len(block["lines"]) == 1
            and block["bbox"][3] < height * 0.1
            and any(
                other["label"] == "number"
                and abs(other["lines"][0]["baseline"] - block["lines"][0]["baseline"])
                < body_size * 0.15
                for other in normalized
            )
            and all(
                other["bbox"][1] - block["bbox"][3] >= body_size
                for other in normalized
                if other["bbox"][1] >= block["bbox"][3]
            )
        ):
            block["label"] = "header"
    lines = sorted(
        (line for block in normalized for line in block["lines"]),
        key=lambda line: line["baseline"],
    )
    wide = [
        line
        for line in lines
        if line["bbox"][2] - line["bbox"][0] >= width * 0.5
        and abs(line["size"] - body_size) < body_size * 0.15
    ]
    if len(wide) < 3:
        return normalized
    body_left = median(line["bbox"][0] for line in wide)
    body_right = median(line["bbox"][2] for line in wide)
    steps = [
        right["baseline"] - left["baseline"]
        for left, right in itertools.pairwise(lines)
        if body_size * 0.7 < right["baseline"] - left["baseline"] < body_size * 3
    ]
    if not steps:
        return normalized
    step = median(steps)
    grouped = []
    for block in normalized:
        if grouped:
            previous = grouped[-1]
            last, first = previous["lines"][-1], block["lines"][0]
            if (
                block["fragment"]
                and previous["fragment"]
                and block["label"] == previous["label"] == "text"
                and abs(first["size"] - last["size"]) < body_size * 0.1
                and first["bold"] == last["bold"]
                and abs(first["bbox"][0] - body_left) <= body_size * 0.45
                and last["bbox"][2] >= body_right - body_size * 1.3
                and step * 0.7 <= first["baseline"] - last["baseline"] <= step * 1.15
            ):
                previous["lines"].extend(block["lines"])
                previous["bbox"] = _box_union([previous["bbox"], block["bbox"]])
                continue
        grouped.append(block)
    return grouped


def _ambiguous_structure(blocks, body_size: float, body_font: str) -> str | None:
    fragment_run = 0
    previous_bottom = 0
    for block in blocks:
        lines = block["lines"]
        if block["label"] != "text":
            fragment_run = 0
            continue
        if len(lines) == 1:
            fragment_run = (
                fragment_run + 1
                if block["bbox"][1] - previous_bottom < body_size * 2
                else 1
            )
            if fragment_run >= 5:
                return "unresolved_paragraph_fragments"
        else:
            fragment_run = 0
            if (
                lines[0]["bbox"][0]
                < median(line["bbox"][0] for line in lines[1:]) - body_size * 0.5
            ):
                return "hanging_indent"
        previous_bottom = block["bbox"][3]
        if any(
            line["size"] >= body_size * 1.12
            or (
                len(line["text"]) <= 160
                and re.match(r"\d+(?:\.\d+)+\s", line["text"].strip())
            )
            or (
                len(line["text"]) <= 160
                and line["size"] >= body_size * 0.95
                and body_font not in line["fonts"]
            )
            for line in lines
        ):
            return "ambiguous_heading_style"
    return None


def inspect_page(page) -> tuple[list[dict] | None, dict]:
    """Return native layout in PDF points, or an explicit rejection reason.

    Call under the module lock when sharing a process across parser threads.
    No file name, expected answer or prior parser output participates in routing.
    """
    width, height = page.rect.width, page.rect.height
    diagnostic = {"page_index": page.number, "reason": "eligible"}

    def reject(reason):
        return None, {**diagnostic, "reason": reason}

    if page.rotation or page.cropbox_position != (0, 0):
        return reject("page_transform")
    unit_type, unit_value = page.parent.xref_get_key(page.xref, "UserUnit")
    if unit_type != "null" and (
        unit_type not in {"int", "float"} or float(unit_value) != 1.0
    ):
        return reject("page_user_unit")
    if page.first_annot is not None or page.first_widget is not None:
        return reject("annotations_or_widgets")
    if page.get_image_info():
        return reject("images")
    traces = page.get_texttrace()
    if any(
        trace["type"] != 0
        or trace["opacity"] < 0.99
        or abs(trace["dir"][0] - 1) > 0.001
        or abs(trace["dir"][1]) > 0.001
        for trace in traces
    ):
        return reject("nonstandard_text_rendering")
    drawings = page.get_drawings(extended=True)
    if not _safe_render_groups(drawings, traces):
        return reject("clipping_or_transparency")
    if not _plain_drawings(
        [drawing for drawing in drawings if drawing["type"] not in {"clip", "group"}],
        page,
        traces,
    ):
        return reject("drawings")
    raw = page.get_text(
        "rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    )
    blocks = []
    all_lines = []
    sizes = []
    fonts = Counter()
    for block in raw["blocks"]:
        if block["type"] != 0:
            return reject("nontext_block")
        lines = []
        for line in block["lines"]:
            if line["wmode"] or tuple(line["dir"]) != (1.0, 0.0):
                return reject("text_direction")
            chars = [char for span in line["spans"] for char in span["chars"]]
            text = "".join(char["c"] for char in chars)
            if not text.strip():
                continue
            if not _valid_box(line["bbox"], width, height):
                return reject("invalid_geometry")
            if any(
                unicodedata.category(c) in {"Co", "Cs", "Cn", "Sm"}
                or c == "\ufffd"
                or (unicodedata.category(c) == "Cc" and not c.isspace())
                for c in text
            ):
                return reject("encoding_or_math")
            if re.search(r"\s{4}|\t", text):
                return reject("aligned_fields")
            for span in line["spans"]:
                if span["flags"] & 1 or _MATH_FONT.search(span["font"]):
                    return reject("math_or_superscript")
                if span["size"] < 5 or span["size"] > 48:
                    return reject("font_size")
                if span["color"] == 0xFFFFFF:
                    return reject("white_text")
                sizes.extend([span["size"]] * len(span["chars"]))
                fonts[span["font"]] += len(span["chars"])
                for char in span["chars"]:
                    if char["c"].isspace() or unicodedata.category(
                        char["c"]
                    ).startswith("M"):
                        continue
                    if not _valid_box(char["bbox"], width, height):
                        return reject("invalid_glyph_geometry")
            for left, right in itertools.pairwise(chars):
                if right["bbox"][0] - left["bbox"][2] > 1.5 * max(
                    s["size"] for s in line["spans"]
                ):
                    return reject("aligned_fields")
            visible_boxes = [char["bbox"] for char in chars if not char["c"].isspace()]
            line_info = {
                "bbox": _box_union(visible_boxes),
                "baseline": median(s["origin"][1] for s in line["spans"]),
                "gaps": [
                    (left[2] + right[0]) / 2
                    for left, right in itertools.pairwise(visible_boxes)
                    if right[0] - left[2]
                    > 0.6 * median(s["size"] for s in line["spans"])
                ],
                "text": text,
                "size": median(s["size"] for s in line["spans"]),
                "bold": all(s["flags"] & 16 for s in line["spans"]),
                "fonts": {s["font"] for s in line["spans"]},
            }
            lines.append(line_info)
            all_lines.append(line_info)
        if lines:
            blocks.append({"bbox": list(block["bbox"]), "lines": lines})
    char_count = sum(len(line["text"].strip()) for line in all_lines)
    diagnostic.update(characters=char_count, blocks=len(blocks), lines=len(all_lines))
    if not 80 <= char_count <= 16000:
        return reject("text_count")
    body_size = median(sizes)
    if _aligned_native_rows(blocks, body_size):
        return reject("aligned_native_rows")
    blocks = _normalize_blocks(blocks, body_size, width, height)
    ambiguous = _ambiguous_structure(blocks, body_size, fonts.most_common(1)[0][0])
    if ambiguous:
        return reject(ambiguous)
    all_lines = [line for block in blocks for line in block["lines"]]
    diagnostic.update(grouped_blocks=len(blocks), grouped_lines=len(all_lines))
    ordered_lines = sorted(
        all_lines, key=lambda line: (line["bbox"][1], line["bbox"][0])
    )
    # Two separate text runs on one row may be columns, table cells or an equation.
    for index, line in enumerate(ordered_lines):
        box = line["bbox"]
        for other in ordered_lines[index + 1 :]:
            other_box = other["bbox"]
            if other_box[1] >= box[3]:
                break
            overlap = min(box[3], other_box[3]) - max(box[1], other_box[1])
            if _margin_number_pair(line, other, height):
                continue
            if overlap > 0.3 * min(box[3] - box[1], other_box[3] - other_box[1]):
                return reject("overlapping_rows_or_columns")
    blocks.sort(key=lambda block: (block["bbox"][1], block["bbox"][0]))
    for first, second in itertools.pairwise(blocks):
        if second["bbox"][1] < first["bbox"][3] - body_size * 0.2 and not (
            len(first["lines"]) == len(second["lines"]) == 1
            and _margin_number_pair(first["lines"][0], second["lines"][0], height)
        ):
            return reject("overlapping_blocks")
    layout = []
    for index, block in enumerate(blocks):
        label = block["label"]
        layout.append(
            {"label": label, "bbox": block["bbox"], "score": 1.0, "index": index}
        )
        layout.extend(
            {
                "label": "ocr_text",
                "bbox": line["bbox"],
                "text": line["text"],
                "score": 1.0,
            }
            for line in block["lines"]
        )
    return layout, diagnostic


def install(pipeline=None) -> None:
    """Install once; optional module argument permits a model-free contract check."""
    if pipeline is None:
        from mineru.backend.pipeline import pipeline_analyze as pipeline
    if getattr(pipeline, "_capy_native_page_installed", False):
        return
    original_load = pipeline.load_images_from_pdf_doc
    original_analyze = pipeline.batch_image_analyze

    @wraps(original_load)
    def load(pdf_doc, *args, **kwargs):
        images = original_load(pdf_doc, *args, **kwargs)
        pdf_bytes = kwargs.get("pdf_bytes")
        if pdf_bytes is None:
            _count(rejected_missing_pdf_bytes=len(images))
            return images
        # MinerU 3.4.5 streaming pipeline supplies these as keyword arguments.
        start_page = kwargs.get("start_page_id", 0)
        started = time.perf_counter()
        try:
            with _LOCK, pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
                for offset, image in enumerate(images):
                    layout, diagnostic = inspect_page(document[start_page + offset])
                    _count(
                        pages_inspected=1, **{f"inspection_{diagnostic['reason']}": 1}
                    )
                    if layout is not None:
                        for item in layout:
                            item["bbox"] = [v * image["scale"] for v in item["bbox"]]
                        setattr(image["img_pil"], _ATTRIBUTE, layout)
        except (pymupdf.FileDataError, RuntimeError, ValueError, OverflowError):
            # A PDF inspection failure must not leave a partly accepted window.
            for image in images:
                if hasattr(image["img_pil"], _ATTRIBUTE):
                    delattr(image["img_pil"], _ATTRIBUTE)
            _count(inspection_errors=1)
        finally:
            _count(inspection_seconds=time.perf_counter() - started)
        return images

    @wraps(original_analyze)
    def analyze(images, *args, **kwargs):
        results = [None] * len(images)
        remaining = []
        positions = []
        for index, (image, ocr_enable, _lang) in enumerate(images):
            layout = getattr(image, _ATTRIBUTE, None)
            if layout is not None:
                results[index] = copy.deepcopy(layout)
                if ocr_enable:
                    _count(pages_bypassed_ocr=1)
                else:
                    # Preserve MinerU's digital text fill, including its spacing.
                    for item in results[index]:
                        if item["label"] == "ocr_text":
                            item["text"] = ""
                _count(pages_bypassed=1)
            else:
                remaining.append(images[index])
                positions.append(index)
        if remaining:
            fallback = original_analyze(remaining, *args, **kwargs)
            if len(fallback) != len(positions):
                raise RuntimeError("MinerU fallback result count mismatch")
            for position, result in zip(positions, fallback):
                results[position] = result
            _count(pages_model_analyzed=len(remaining))
        return results

    pipeline.load_images_from_pdf_doc = load
    pipeline.batch_image_analyze = analyze
    pipeline._capy_native_page_installed = True
