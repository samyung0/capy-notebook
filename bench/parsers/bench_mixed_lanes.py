"""Mixed-lane load: four digital lecture jobs plus two OCR jobs on the parser VM.

The VM has four digital Marker slots and two RapidOCR slots. This script fills
the digital lane with a lecture deck whose text layer keeps it out of OCR. It
fills both OCR slots with a combined PDF containing those slides plus two
full-page newspaper scans.

The original bench files (``metabolic_pathway.pdf``,
``newspaper-scan-sample.pdf``) live in gitignored ``bench/parsers/docs/``.
If they are missing, stand-in PDFs with the same mix are written there.

    python bench/parsers/bench_mixed_lanes.py
    python bench/parsers/bench_mixed_lanes.py --lecture ... --scan ...

Needs ``requests`` and ``Pillow``. URL/token from env or flags.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

from bench_parse import _healthz, _parse_url, _summarize, do_parse
from PIL import Image, ImageDraw, ImageFont

DECK_CANARY = "EVO-DECK-CANARY-GLYCOLYSIS"
SCAN_CANARIES = ("EVO-SCAN-FRONT-PAGE", "EVO-SCAN-SPORTS-PAGE")
LECTURE_PAGES = 40
DOCS_DIR = Path(__file__).resolve().parent / "docs"

_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def _font(size: int) -> ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def _escape_pdf(text: str) -> bytes:
    return (
        text.replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .encode("latin-1")
    )


def _pdf(objects: list[bytes]) -> bytes:
    pdf = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        pdf += b"%010d 00000 n \n" % off
    pdf += b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(pdf)


def _lecture_lines(page: int, total: int) -> list[str]:
    """Enough characters for the scan probe to treat the page as digital."""
    lines = [
        f"Metabolic Pathways  slide {page} of {total}",
        DECK_CANARY,
        "Glycolysis Step 1: glucose to glucose-6-phosphate.",
        "The Krebs cycle oxidizes acetyl-CoA; ATP synthase finishes the job.",
    ]
    filler = (
        "glucose glycolysis pyruvate dehydrogenase citrate synthase "
        "electron transport oxidative phosphorylation metabolic flux "
    )
    while sum(len(line) for line in lines) < 900:
        lines.append(f"{filler} page {page} line {len(lines)}")
    return lines


def _text_page_objects(
    content_id: int,
    font_id: int,
    lines: list[str],
) -> tuple[bytes, bytes]:
    chunks = [b"BT /F1 11 Tf 48 740 Td 13 TL"]
    for line in lines:
        chunks.append(b"(" + _escape_pdf(line) + b") Tj T*")
    chunks.append(b"ET")
    stream = b"\n".join(chunks)
    page = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents %d 0 R /Resources << /Font << /F1 %d 0 R >> >> >>"
        % (content_id, font_id)
    )
    content = b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream)
    return page, content


def _scan_image(canary: str, headline: str) -> Image.Image:
    img = Image.new("RGB", (1600, 2200), "white")
    draw = ImageDraw.Draw(img)
    title = _font(56)
    body = _font(28)
    draw.rectangle((40, 40, 1560, 160), outline="black", width=4)
    draw.text((60, 60), canary, fill="black", font=title)
    draw.text((60, 180), headline, fill="black", font=_font(36))
    y = 260
    column = (
        "City council voted last night on the harbour plan. "
        "Markets opened higher. Weather stays dry through Friday. "
        "A local bakery won the regional pie contest. "
    )
    for n in range(28):
        draw.text((60, y), f"{column} ({canary} para {n + 1})", fill="black", font=body)
        y += 64
    return img


def _image_page_objects(
    content_id: int,
    image_id: int,
    image: Image.Image,
) -> tuple[bytes, bytes, bytes]:
    rgb = image.convert("RGB")
    raw = zlib.compress(rgb.tobytes(), 9)
    xobj = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
        b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode "
        b"/Length %d >>\nstream\n%s\nendstream"
        % (rgb.size[0], rgb.size[1], len(raw), raw)
    )
    stream = b"q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ"
    page = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents %d 0 R /Resources << /XObject << /Im0 %d 0 R >> >> >>"
        % (content_id, image_id)
    )
    content = b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream)
    return page, content, xobj


def build_pdf(kind: str) -> bytes:
    """kind: lecture | scan | combined."""
    pages: list[tuple[str, object]] = []
    if kind in {"lecture", "combined"}:
        for i in range(LECTURE_PAGES):
            pages.append(("text", _lecture_lines(i + 1, LECTURE_PAGES)))
    if kind in {"scan", "combined"}:
        pages.append(
            ("image", _scan_image(SCAN_CANARIES[0], "Harbour vote shocks city"))
        )
        pages.append(
            ("image", _scan_image(SCAN_CANARIES[1], "Rovers win in extra time"))
        )

    n_pages = len(pages)
    # ids: 1 catalog, 2 pages, 3.. page objs, then content, then extras, then font
    page_ids = list(range(3, 3 + n_pages))
    content_ids = list(range(3 + n_pages, 3 + 2 * n_pages))
    next_id = 3 + 2 * n_pages
    extras: dict[int, bytes] = {}
    page_bodies: list[bytes] = []
    content_bodies: list[bytes] = []
    font_id = None
    for i, (ptype, payload) in enumerate(pages):
        if ptype == "text":
            if font_id is None:
                font_id = next_id
                next_id += 1
            page, content = _text_page_objects(content_ids[i], font_id, payload)
        else:
            image_id = next_id
            next_id += 1
            page, content, xobj = _image_page_objects(content_ids[i], image_id, payload)
            extras[image_id] = xobj
        page_bodies.append(page)
        content_bodies.append(content)
    if font_id is None:
        font_id = next_id
        next_id += 1

    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode(),
        *page_bodies,
        *content_bodies,
    ]
    # extras and font must sit at the ids we assigned. Fill holes with dummy
    # objects if the id sequence is not compact (it is: extras then font).
    tail: dict[int, bytes] = dict(extras)
    tail[font_id] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    for obj_id in range(3 + 2 * n_pages, max(tail) + 1):
        objects.append(tail[obj_id])
    return _pdf(objects)


def _merge_existing(lecture: bytes, scan: bytes) -> bytes:
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as exc:
        raise SystemExit(
            "pypdf is required to glue existing PDFs. "
            "Run: uv run --with pypdf python bench/parsers/bench_mixed_lanes.py"
        ) from exc
    writer = PdfWriter()
    for blob in (lecture, scan):
        writer.append(PdfReader(BytesIO(blob)))
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def _page_count(data: bytes) -> int:
    try:
        from pypdf import PdfReader

        return len(PdfReader(BytesIO(data)).pages)
    except Exception:  # noqa: BLE001
        import re

        match = re.search(rb"/Type /Pages /Kids \[[^\]]*\] /Count (\d+)", data)
        return int(match.group(1)) if match else LECTURE_PAGES


def _load_or_build(docs: Path, lecture_path: Path | None, scan_path: Path | None):
    docs.mkdir(parents=True, exist_ok=True)
    default_lecture = docs / "metabolic_pathway.pdf"
    default_scan = docs / "newspaper-scan-sample.pdf"
    lecture_file = lecture_path or (
        default_lecture if default_lecture.is_file() else None
    )
    scan_file = scan_path or (default_scan if default_scan.is_file() else None)

    if lecture_file and scan_file:
        lecture = lecture_file.read_bytes()
        scan = scan_file.read_bytes()
        combined = _merge_existing(lecture, scan)
        source = f"merged {lecture_file.name} + {scan_file.name}"
    else:
        print(
            "bench PDFs not in docs/; writing stand-in lecture + scan "
            "(same mix: digital slides then two image-only newspaper pages)"
        )
        lecture = build_pdf("lecture")
        scan = build_pdf("scan")
        combined = build_pdf("combined")
        (docs / "lecture_deck.pdf").write_bytes(lecture)
        (docs / "newspaper_scan.pdf").write_bytes(scan)
        source = "generated stand-ins"

    combined_path = docs / "lecture_plus_scan.pdf"
    combined_path.write_bytes(combined)
    lecture_out = docs / "lecture_deck.pdf"
    if not lecture_out.is_file():
        lecture_out.write_bytes(lecture)
    print(f"combined -> {combined_path} ({len(combined)} bytes)  [{source}]")
    return lecture, combined, combined_path, _page_count(lecture)


def _text_blob(body: dict) -> str:
    parts: list[str] = []
    for item in body.get("content_list") or []:
        for key in ("text", "table_body"):
            value = item.get(key)
            if value:
                parts.append(str(value))
        for cap in item.get("image_caption") or []:
            parts.append(str(cap))
    return "\n".join(parts)


def _pages_with(body: dict, needle: str) -> list[int]:
    hits: list[int] = []
    for item in body.get("content_list") or []:
        blob = " ".join(
            str(part)
            for part in (
                item.get("text"),
                item.get("table_body"),
                " ".join(item.get("image_caption") or []),
            )
            if part
        )
        if needle in blob:
            page = item.get("page_idx")
            if isinstance(page, int) and page not in hits:
                hits.append(page)
    return hits


def _check_combined(body: dict, lecture_page_count: int) -> list[str]:
    """Return problem strings. Empty list = the mixed PDF parsed as we hoped."""
    problems: list[str] = []
    lane = body.get("_fast_lane")
    if lane != "ocr":
        problems.append(f"expected OCR lane, got {lane!r}")
    blob = _text_blob(body)
    if DECK_CANARY not in blob:
        problems.append(f"missing lecture canary {DECK_CANARY}")
    for canary in SCAN_CANARIES:
        if canary not in blob:
            problems.append(f"missing scan canary {canary}")
    ocr_pages = body.get("_ocr_pages")
    expected_scan = list(range(lecture_page_count, lecture_page_count + 2))
    if ocr_pages is not None:
        if sorted(ocr_pages) != expected_scan:
            problems.append(
                f"_ocr_pages={ocr_pages} want newspaper pages {expected_scan}"
            )
        digital_pages = _pages_with(body, DECK_CANARY)
        if any(page in set(ocr_pages) for page in digital_pages):
            problems.append(
                f"lecture canary landed on an OCR page: {digital_pages} vs {ocr_pages}"
            )
    scan_pages = [_pages_with(body, canary) for canary in SCAN_CANARIES]
    if ocr_pages is None and not any(scan_pages):
        problems.append("no _ocr_pages and no scan text — RapidOCR did not run")
    full_page_scans = 0
    for item in body.get("content_list") or []:
        if item.get("type") != "image":
            continue
        bbox = item.get("bbox") or []
        if (
            len(bbox) == 4
            and abs(bbox[2] - bbox[0]) * abs(bbox[3] - bbox[1]) >= 700_000
        ):
            full_page_scans += 1
    if full_page_scans:
        problems.append(
            f"{full_page_scans} full-page scan raster(s) still in content_list"
        )
    ocr_without_box = [
        item
        for item in body.get("content_list") or []
        if item.get("page_idx") in set(ocr_pages or [])
        and item.get("type") == "text"
        and not item.get("bbox")
    ]
    if ocr_without_box:
        problems.append(
            f"{len(ocr_without_box)} OCR line(s) have no bbox (citations cannot highlight)"
        )
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--url", default="")
    ap.add_argument("--token", default=os.environ.get("PARSER_TOKEN", ""))
    ap.add_argument("--lecture", default="", help="digital lecture PDF")
    ap.add_argument("--scan", default="", help="scanned newspaper PDF")
    ap.add_argument("--docs", default=str(DOCS_DIR))
    ap.add_argument("--parse-method", default="ocr")
    ap.add_argument("--timeout", type=float, default=900.0)
    ap.add_argument("--save-json", default="", help="write one combined parse JSON")
    args = ap.parse_args()

    lecture, combined, combined_path, lecture_pages = _load_or_build(
        Path(args.docs),
        Path(args.lecture) if args.lecture else None,
        Path(args.scan) if args.scan else None,
    )
    token = args.token or None
    url = _parse_url(args)
    _healthz(url, token, args.timeout)

    # Lecture jobs use txt so they stay on the digital Marker lane even if a
    # real deck's text layer is thin. Combined uses ocr so the newspaper pages
    # take the RapidOCR lane.
    jobs: list[tuple[str, bytes, str]] = [
        ("lecture_deck.pdf", lecture, "marker_only")
    ] * 4 + [(combined_path.name, combined, args.parse_method)] * 2
    print(f"\n-- 4 digital lecture + 2 combined OCR  ({len(jobs)} HTTP) --")
    t0 = time.perf_counter()
    results: list[tuple[str, float, dict | None, str | None]] = []
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futs = {
            pool.submit(do_parse, url, token, data, name, method, args.timeout): name
            for name, data, method in jobs
        }
        for fut in as_completed(futs):
            name = futs[fut]
            try:
                wall, payload = fut.result()
                results.append((name, wall, payload, None))
                print(
                    f"  {name:24s}  wall={wall:.2f}s  "
                    f"server_parse={payload.get('_server_parse_s')}  "
                    f"{_summarize(payload)}"
                )
            except Exception as exc:  # noqa: BLE001
                results.append((name, 0.0, None, str(exc)))
                print(f"  {name:24s}  FAILED: {exc}")
    burst = time.perf_counter() - t0
    servers = [
        float(p["_server_parse_s"])
        for _, _, p, err in results
        if err is None and isinstance((p or {}).get("_server_parse_s"), (int, float))
    ]
    print(
        f"burst wall (all done): {burst:.2f}s  errors={sum(1 for r in results if r[3])}"
    )
    if servers:
        print(
            f"per-job server_parse median={statistics.median(servers):.2f}s  "
            f"sum={sum(servers):.2f}s  parallelism={sum(servers) / burst:.2f}x"
        )

    digital = [r for r in results if r[0] == "lecture_deck.pdf"]
    mixed = [r for r in results if r[0] == combined_path.name]
    print("\n-- lanes --")
    for label, rows, want in (
        ("lecture", digital, "digital"),
        ("combined", mixed, "ocr"),
    ):
        lanes = [(row[2] or {}).get("_fast_lane") for row in rows]
        ok = all(lane == want and row[3] is None for row, lane in zip(rows, lanes))
        print(f"  {label}: {lanes}  {'ok' if ok else 'NOT ' + want}")

    print("\n-- combined parse check --")
    failed = False
    saved = False
    for i, (name, _wall, payload, err) in enumerate(mixed):
        if err or payload is None:
            print(f"  combined[{i}] failed: {err}")
            failed = True
            continue
        problems = _check_combined(payload, lecture_pages)
        if args.save_json and not saved:
            slim = {
                "filename": name,
                "_fast_lane": payload.get("_fast_lane"),
                "_ocr_pages": payload.get("_ocr_pages"),
                "_server_parse_s": payload.get("_server_parse_s"),
                "content_list": payload.get("content_list"),
                "image_names": list((payload.get("images") or {}).keys()),
                "md": (payload.get("md") or "")[:4000],
            }
            Path(args.save_json).write_text(json.dumps(slim, indent=2))
            saved = True
        ocr_pages = payload.get("_ocr_pages")
        print(
            f"  combined[{i}]  lane={payload.get('_fast_lane')}  "
            f"ocr_pages={ocr_pages}  blocks={len(payload.get('content_list') or [])}  "
            f"chars={len(_text_blob(payload))}"
        )
        print(f"    lecture canary pages: {_pages_with(payload, DECK_CANARY)}")
        for canary in SCAN_CANARIES:
            print(f"    {canary} pages: {_pages_with(payload, canary)}")
        if problems:
            failed = True
            for problem in problems:
                print(f"    FAIL: {problem}")
        else:
            print("    PASS: digital slides kept their text, scans became OCR lines")

    return 1 if failed or any(r[3] for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
