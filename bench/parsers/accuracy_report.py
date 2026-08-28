"""Benchmark the persistent parser for speed, resource use, and visible accuracy.

The report renders each source page, overlays returned bounding boxes, and puts
the extracted text beside it. Native text is used as a reference only when its
encoding looks healthy; scan accuracy comes from explicit canaries supplied in
JSON. This keeps a broken PDF cmap from being treated as ground truth.

Example on the parser VM:

    python accuracy_report.py \
      --url http://10.77.0.2:8090/file_parse \
      --docs docs \
      --canaries canaries.example.json \
      --sweep 1,2,4,6,8 \
      --out out/netcup-2026-08-28
"""

from __future__ import annotations

import argparse
import html
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests
from PIL import ImageDraw

ROOT = Path(__file__).resolve().parents[2]
MODAL = ROOT / "modal"
if str(MODAL) not in sys.path:
    sys.path.insert(0, str(MODAL))

from marker_adapt import html_to_text
from marker_worker import normalize_document
from scan_pages import _text_quality_reason

SUPPORTED = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".tif",
    ".tiff",
    ".docx",
    ".pptx",
    ".xlsx",
}
MODES = ("marker_only", "selective_rapidocr", "all_rapidocr")


@dataclass
class PageScore:
    page: int
    reference_chars: int
    output_chars: int
    similarity: float | None
    blocks: int
    missing_bbox_blocks: int
    missing_canaries: list[str] = field(default_factory=list)
    rejections: list[str] = field(default_factory=list)


@dataclass
class ParseScore:
    document: str
    mode: str
    wall_seconds: float
    server_seconds: float
    pages: int
    ocr_pages: int
    chars: int
    tables: int
    duplicate_line_ratio: float
    worker_cpu_ms: int
    worker_pss_bytes: int
    parser_memory_bytes: int
    page_scores: list[PageScore]
    rejections: list[str] = field(default_factory=list)


def normalized(value: str) -> str:
    return " ".join(value.lower().split())


def item_text(item: dict[str, Any]) -> str:
    pieces = [str(item.get("text") or "")]
    table = str(item.get("table_body") or "")
    if table:
        pieces.append(html_to_text(table))
    pieces.extend(str(value) for value in item.get("image_caption") or [])
    return "\n".join(piece for piece in pieces if piece).strip()


def pages_from_result(
    result: dict[str, Any], page_count: int
) -> list[list[dict[str, Any]]]:
    pages: list[list[dict[str, Any]]] = [[] for _ in range(page_count)]
    for item in result.get("content_list") or []:
        page = item.get("page_idx")
        if isinstance(page, int) and 0 <= page < page_count:
            pages[page].append(item)
    return pages


def render_source(data: bytes, name: str, out: Path) -> tuple[list[Path], list[str]]:
    import pypdfium2 as pdfium

    normalized_data, _normalized_name, _source_format = normalize_document(data, name)
    images: list[Path] = []
    references: list[str] = []
    if normalized_data.lstrip().startswith(b"%PDF"):
        pdf = pdfium.PdfDocument(normalized_data)
        try:
            for index in range(len(pdf)):
                page = pdf[index]
                try:
                    width, height = page.get_size()
                    scale = min(2.0, 1800 / max(float(width), float(height), 1))
                    image = page.render(scale=max(1.0, scale)).to_pil().convert("RGB")
                    textpage = page.get_textpage()
                    try:
                        references.append(str(textpage.get_text_range() or ""))
                    finally:
                        textpage.close()
                finally:
                    page.close()
                target = out / f"source-p{index + 1}.jpg"
                image.save(target, quality=88)
                images.append(target)
        finally:
            pdf.close()
        return images, references

    import io

    from PIL import Image

    image = Image.open(io.BytesIO(normalized_data)).convert("RGB")
    target = out / "source-p1.jpg"
    image.save(target, quality=88)
    return [target], [""]


def overlay(source: Path, blocks: list[dict[str, Any]], target: Path) -> None:
    from PIL import Image

    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image, "RGBA")
    colors = {
        "text": (0, 110, 255, 210),
        "table": (20, 160, 80, 220),
        "equation": (155, 70, 200, 220),
        "image": (230, 120, 20, 220),
    }
    for item in blocks:
        box = item.get("bbox")
        if not isinstance(box, list) or len(box) != 4:
            continue
        try:
            xy = [
                float(box[0]) * image.width / 1000,
                float(box[1]) * image.height / 1000,
                float(box[2]) * image.width / 1000,
                float(box[3]) * image.height / 1000,
            ]
        except (TypeError, ValueError):
            continue
        color = colors.get(str(item.get("type") or ""), (220, 20, 60, 220))
        draw.rectangle(xy, outline=color, width=max(2, image.width // 700))
    image.save(target, quality=88)


def parse(
    url: str, token: str, path: Path, mode: str, timeout: float
) -> tuple[float, dict[str, Any]]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    data = path.read_bytes()
    started = time.perf_counter()
    response = requests.post(
        url,
        headers=headers,
        files={"file": (path.name, data)},
        data={"filename": path.name, "parse_method": mode},
        timeout=timeout,
    )
    wall = time.perf_counter() - started
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        raise TypeError("parser returned a non-object response")
    return wall, payload


def similarity(reference: str, output: str) -> float | None:
    left, right = normalized(reference), normalized(output)
    if len(left) < 200 or _text_quality_reason(reference):
        return None
    return round(SequenceMatcher(None, left, right, autojunk=False).ratio(), 4)


def bbox_overlap_ratio(left: Any, right: Any) -> float:
    if not (
        isinstance(left, list)
        and len(left) == 4
        and isinstance(right, list)
        and len(right) == 4
    ):
        return 0.0
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = abs(left[2] - left[0]) * abs(left[3] - left[1])
    right_area = abs(right[2] - right[0]) * abs(right[3] - right[1])
    smaller = min(left_area, right_area)
    return intersection / smaller if smaller else 0.0


def duplicate_ratio(items: list[dict[str, Any]]) -> float:
    seen: dict[tuple[int, str], list[Any]] = {}
    eligible = duplicates = 0
    for item in items:
        line = normalized(item_text(item))
        page = item.get("page_idx")
        bbox = item.get("bbox")
        if len(line) < 8 or not isinstance(page, int):
            continue
        eligible += 1
        boxes = seen.setdefault((page, line), [])
        if any(bbox_overlap_ratio(bbox, previous) >= 0.80 for previous in boxes):
            duplicates += 1
        else:
            boxes.append(bbox)
    if not eligible:
        return 0.0
    return round(duplicates / eligible, 4)


def score(
    path: Path,
    mode: str,
    wall: float,
    payload: dict[str, Any],
    references: list[str],
    canaries: list[dict[str, Any]],
) -> ParseScore:
    page_items = pages_from_result(payload, len(references))
    page_scores: list[PageScore] = []
    all_items = [item for page in page_items for item in page]
    for index, items in enumerate(page_items):
        output = "\n".join(filter(None, (item_text(item) for item in items)))
        missing_bbox = sum(
            bool(item_text(item))
            and not (isinstance(item.get("bbox"), list) and len(item["bbox"]) == 4)
            for item in items
        )
        relevant = [item for item in canaries if int(item.get("page", -1)) == index]
        missing = [
            str(item.get("label") or item.get("text") or "canary")
            for item in relevant
            if normalized(str(item.get("text") or "")) not in normalized(output)
        ]
        ratio = similarity(references[index], output)
        rejections: list[str] = []
        if (
            ratio is not None
            and len(normalized(output)) < len(normalized(references[index])) * 0.20
        ):
            rejections.append("missing most of a visually healthy native-text page")
        if missing:
            rejections.append("missing required visual canary")
        if items and missing_bbox / len(items) > 0.10:
            rejections.append("more than 10% of text-bearing blocks lost their bbox")
        page_scores.append(
            PageScore(
                page=index,
                reference_chars=len(normalized(references[index])),
                output_chars=len(normalized(output)),
                similarity=ratio,
                blocks=len(items),
                missing_bbox_blocks=missing_bbox,
                missing_canaries=missing,
                rejections=rejections,
            )
        )
    duplicates = duplicate_ratio(all_items)
    rejections = [
        f"page {page.page + 1}: {reason}"
        for page in page_scores
        for reason in page.rejections
    ]
    if duplicates > 0.10:
        rejections.append(f"large duplicate-line ratio ({duplicates:.1%})")
    return ParseScore(
        document=path.name,
        mode=mode,
        wall_seconds=round(wall, 3),
        server_seconds=round(float(payload.get("_server_parse_s") or 0), 3),
        pages=max(0, int(payload.get("_page_count") or len(references))),
        ocr_pages=max(0, int(payload.get("_ocr_page_count") or 0)),
        chars=sum(len(item_text(item)) for item in all_items),
        tables=sum(item.get("type") == "table" for item in all_items),
        duplicate_line_ratio=duplicates,
        worker_cpu_ms=max(0, int(payload.get("_worker_cpu_ms") or 0)),
        worker_pss_bytes=max(0, int(payload.get("_worker_pss_bytes") or 0)),
        parser_memory_bytes=max(
            0, int(payload.get("_parser_cgroup_memory_bytes") or 0)
        ),
        page_scores=page_scores,
        rejections=rejections,
    )


def cross_mode_rejections(scores: list[ParseScore]) -> None:
    by_doc: dict[str, dict[str, ParseScore]] = {}
    for item in scores:
        by_doc.setdefault(item.document, {})[item.mode] = item
    for modes in by_doc.values():
        marker = modes.get("marker_only")
        selective = modes.get("selective_rapidocr")
        all_ocr = modes.get("all_rapidocr")
        if marker and all_ocr and all_ocr.tables < marker.tables:
            all_ocr.rejections.append("all-page OCR lost a native Marker table")
        if selective and all_ocr:
            selective_missing = sum(
                len(page.missing_canaries) for page in selective.page_scores
            )
            all_missing = sum(
                len(page.missing_canaries) for page in all_ocr.page_scores
            )
            recovered = (
                all_ocr.chars >= selective.chars * 1.02
                or all_missing < selective_missing
            )
            if all_ocr.wall_seconds > selective.wall_seconds * 1.75 and not recovered:
                all_ocr.rejections.append(
                    "all-page OCR was over 75% slower without meaningful text recovery"
                )


def concurrency_sweep(
    url: str,
    token: str,
    path: Path,
    mode: str,
    counts: list[int],
    timeout: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for count in counts:
        started = time.perf_counter()
        walls: list[float] = []
        payloads: list[dict[str, Any]] = []
        errors: list[str] = []
        with ThreadPoolExecutor(max_workers=count) as pool:
            futures = [
                pool.submit(parse, url, token, path, mode, timeout)
                for _ in range(count)
            ]
            for future in as_completed(futures):
                try:
                    wall, payload = future.result()
                    walls.append(wall)
                    payloads.append(payload)
                except Exception as exc:  # noqa: BLE001 - report each failed job
                    errors.append(str(exc))
        burst = time.perf_counter() - started
        pages = sum(max(0, int(body.get("_page_count") or 0)) for body in payloads)
        rows.append(
            {
                "jobs": count,
                "burst_seconds": round(burst, 3),
                "pages_per_second": round(pages / burst, 4) if burst else 0,
                "median_job_seconds": round(statistics.median(walls), 3)
                if walls
                else 0,
                "max_job_seconds": round(max(walls), 3) if walls else 0,
                "max_parser_memory_bytes": max(
                    (
                        int(body.get("_parser_cgroup_memory_bytes") or 0)
                        for body in payloads
                    ),
                    default=0,
                ),
                "errors": errors,
            }
        )
    return rows


def write_html(
    target: Path,
    scores: list[ParseScore],
    visuals: dict[tuple[str, str], list[tuple[Path, str]]],
    sweep: list[dict[str, Any]],
) -> None:
    score_rows = "".join(
        "<tr>"
        f"<td>{html.escape(item.document)}</td><td>{item.mode}</td>"
        f"<td>{item.wall_seconds:.2f}s</td><td>{item.pages}</td><td>{item.ocr_pages}</td>"
        f"<td>{item.chars:,}</td><td>{item.tables}</td>"
        f"<td class={'bad' if item.rejections else 'good'}>{html.escape('; '.join(item.rejections) or 'pass')}</td>"
        "</tr>"
        for item in scores
    )
    sections: list[str] = []
    for item in scores:
        pages = visuals.get((item.document, item.mode), [])
        page_html = "".join(
            f"<article><h4>Page {index + 1}</h4><img src='{image.relative_to(target.parent).as_posix()}' alt='Page {index + 1} bbox overlay'><pre>{html.escape(text)}</pre></article>"
            for index, (image, text) in enumerate(pages)
        )
        sections.append(
            f"<section><h2>{html.escape(item.document)} — {item.mode}</h2>{page_html}</section>"
        )
    target.write_text(
        "<!doctype html><meta charset='utf-8'><title>Parser VM benchmark</title>"
        "<style>body{font:14px system-ui;margin:24px;color:#17202a}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd1d1;padding:7px;text-align:left;vertical-align:top}.good{color:#087830}.bad{color:#b42318}section{margin-top:36px}article{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1fr);gap:16px;margin:20px 0}article h4{grid-column:1/-1}img{width:100%;height:auto;border:1px solid #aaa}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:12px;background:#f5f6f7;max-height:80vh;overflow:auto}</style>"
        "<h1>Parser VM benchmark</h1><p>Red rows require visual review or reject the mode. Inaccuracies below the listed rejection thresholds remain visible in the page comparisons.</p>"
        "<table><thead><tr><th>Document</th><th>Mode</th><th>Wall</th><th>Pages</th><th>OCR pages</th><th>Characters</th><th>Tables</th><th>Decision</th></tr></thead>"
        f"<tbody>{score_rows}</tbody></table>"
        f"<h2>Concurrency sweep</h2><pre>{html.escape(json.dumps(sweep, indent=2))}</pre>"
        + "".join(sections),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("PARSER_URL", ""))
    parser.add_argument("--token", default=os.environ.get("PARSER_TOKEN", ""))
    parser.add_argument("--docs", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--canaries", default="")
    parser.add_argument("--modes", default=",".join(MODES))
    parser.add_argument("--sweep", default="1,2,4,6,8")
    parser.add_argument("--sweep-mode", default="all_rapidocr")
    parser.add_argument("--max-visual-pages", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    if not args.url:
        parser.error("--url or PARSER_URL is required")
    url = args.url.rstrip("/")
    if not url.endswith("/file_parse"):
        url += "/file_parse"
    docs_path = Path(args.docs)
    docs = (
        [docs_path]
        if docs_path.is_file()
        else sorted(
            path for path in docs_path.iterdir() if path.suffix.lower() in SUPPORTED
        )
    )
    if not docs:
        parser.error("no supported documents found")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    canaries = json.loads(Path(args.canaries).read_text()) if args.canaries else {}
    modes = [value.strip() for value in args.modes.split(",") if value.strip()]
    if any(mode not in MODES for mode in modes):
        parser.error(f"modes must come from {', '.join(MODES)}")

    scores: list[ParseScore] = []
    visuals: dict[tuple[str, str], list[tuple[Path, str]]] = {}
    for doc in docs:
        doc_out = out / doc.name.replace(".", "-")
        doc_out.mkdir(exist_ok=True)
        source_images, references = render_source(doc.read_bytes(), doc.name, doc_out)
        for mode in modes:
            print(f"parse {doc.name} [{mode}]", flush=True)
            wall, payload = parse(url, args.token, doc, mode, args.timeout)
            result_score = score(
                doc,
                mode,
                wall,
                payload,
                references,
                list(canaries.get(doc.name, [])),
            )
            scores.append(result_score)
            page_items = pages_from_result(payload, len(source_images))
            visual_pages: list[tuple[Path, str]] = []
            for index, (source, items) in enumerate(
                zip(source_images[: args.max_visual_pages], page_items)
            ):
                target = doc_out / f"{mode}-p{index + 1}.jpg"
                overlay(source, items, target)
                text = "\n\n".join(filter(None, (item_text(item) for item in items)))
                visual_pages.append((target, text))
            visuals[(doc.name, mode)] = visual_pages
    cross_mode_rejections(scores)
    sweep = concurrency_sweep(
        url,
        args.token,
        docs[0],
        args.sweep_mode,
        [int(value) for value in args.sweep.split(",") if value.strip()],
        args.timeout,
    )
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scores": [asdict(item) for item in scores],
        "concurrency": sweep,
    }
    (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    write_html(out / "report.html", scores, visuals, sweep)
    rejected = [item for item in scores if item.rejections]
    print(
        f"report: {out / 'report.html'} ({len(rejected)} rejected mode/document rows)"
    )
    return 1 if rejected else 0


if __name__ == "__main__":
    raise SystemExit(main())
