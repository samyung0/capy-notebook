"""Fast-route Marker worker (one process per in-flight parse).

PDFium is not thread-safe. Threads in one container blew up with
``Failed to load page`` / ``Data format error``. Marker's own CLI uses
spawned processes for the same reason: each ``PdfConverter`` gets its own
PDFium, while ``FastLayoutPredictor`` is a thin client of one rf-detr server.
"""

from __future__ import annotations

import io
import json
import os
import resource
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PARSE_METHOD = "selective_rapidocr"
FAST_MODE = "fast"

MARKER_ONLY = "marker_only"
SELECTIVE_RAPIDOCR = "selective_rapidocr"
ALL_RAPIDOCR = "all_rapidocr"
_PARSE_METHOD_ALIASES = {
    "txt": MARKER_ONLY,
    "ocr": SELECTIVE_RAPIDOCR,
    "auto": SELECTIVE_RAPIDOCR,
}
_OFFICE_SUFFIXES = {".docx", ".pptx", ".xlsx"}
_DIRECT_SUFFIXES = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".tif",
    ".tiff",
}

_MODELS: dict[str, Any] | None = None
_OCR: Any = None


@dataclass
class _Document:
    data: bytes
    name: str
    parse_method: str


def init_worker() -> None:
    global _MODELS
    if _MODELS is not None:
        return
    from marker.models import create_model_dict

    _MODELS = create_model_dict()
    print(f"marker: models pid={os.getpid()} rapidocr=lazy-local", flush=True)


def ping() -> int:
    if _MODELS is None:
        init_worker()
    return os.getpid()


def parse_document(data: bytes, name: str, parse_method: str) -> dict:
    """Parse one document and always return its attributable measurements.

    ``process_time_ns`` counts CPU consumed by this Marker child, including its
    threads, while excluding time that another job spends in a sibling child.
    Returning an error envelope lets the caller meter a parse that failed after
    it had already consumed CPU.
    """
    started = time.perf_counter_ns()
    cpu_started = _cpu_time_ns()
    io_started = _process_io_bytes()
    probes: list[Any] = []
    flagged: list[int] = []
    try:
        normalized_data, normalized_name, source_format = normalize_document(data, name)
        from scan_pages import probe_pages

        probes = probe_pages(normalized_data)
        method = normalize_parse_method(parse_method)
        flagged = _ocr_page_indices(probes, method)
        if _MODELS is None:
            init_worker()
        converter = _marker_converter(
            FAST_MODE,
            disable_ocr=True,
            force_ocr=False,
            models=dict(_MODELS),
        )
        result = parse_fast(
            _Document(normalized_data, normalized_name, method),
            converter,
            probes=probes,
            ocr_page_indices=flagged,
        )
        result["_source_format"] = source_format
    except Exception as exc:  # noqa: BLE001 - parent needs measured failure data
        result = {"_worker_error": f"{type(exc).__name__}: {exc}"}
    result["_page_count"] = len(probes)
    result["_ocr_pages"] = flagged
    io_finished = _process_io_bytes()
    result["_worker_cpu_ms"] = max(0, round((_cpu_time_ns() - cpu_started) / 1_000_000))
    result["_worker_wall_ms"] = max(
        0, round((time.perf_counter_ns() - started) / 1_000_000)
    )
    result["_worker_io_read_bytes"] = max(0, io_finished[0] - io_started[0])
    result["_worker_io_write_bytes"] = max(0, io_finished[1] - io_started[1])
    result.update(_process_memory())
    return result


def normalize_parse_method(value: str) -> str:
    method = (value or PARSE_METHOD).strip().lower()
    method = _PARSE_METHOD_ALIASES.get(method, method)
    if method not in {MARKER_ONLY, SELECTIVE_RAPIDOCR, ALL_RAPIDOCR}:
        raise ValueError(f"unsupported parse method {value!r}")
    return method


def _ocr_page_indices(probes: list[Any], method: str) -> list[int]:
    if method == MARKER_ONLY:
        return []
    if method == ALL_RAPIDOCR:
        return [probe.page_idx for probe in probes]
    return [probe.page_idx for probe in probes if probe.needs_ocr]


def normalize_document(data: bytes, name: str) -> tuple[bytes, str, str]:
    """Convert supported Office inputs to PDF before probing and parsing.

    A single paginated representation keeps page numbers identical for Marker,
    RapidOCR, citations, and benchmark rendering. Legacy binary Office formats
    are deliberately rejected; accepting them would add a second, weakly tested
    conversion path.
    """
    suffix = Path(name).suffix.lower()
    if not suffix and data.lstrip().startswith(b"%PDF"):
        suffix = ".pdf"
    if suffix in _DIRECT_SUFFIXES:
        return data, name or f"document{suffix}", suffix.lstrip(".")
    if suffix not in _OFFICE_SUFFIXES:
        raise ValueError(
            "supported formats are PDF, PNG, JPEG, WebP, TIFF, DOCX, PPTX, and XLSX"
        )

    timeout = max(30, int(os.environ.get("EVO_OFFICE_CONVERT_TIMEOUT", "180")))
    with tempfile.TemporaryDirectory(prefix="evo_office_") as tmp_name:
        tmp = Path(tmp_name)
        source = tmp / f"source{suffix}"
        source.write_bytes(data)
        completed = subprocess.run(
            [
                "/usr/bin/soffice",
                "--headless",
                "--nologo",
                "--nodefault",
                "--nolockcheck",
                "--nofirststartwizard",
                "--convert-to",
                "pdf",
                "--outdir",
                str(tmp),
                str(source),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        rendered = tmp / "source.pdf"
        if completed.returncode != 0 or not rendered.is_file():
            detail = (
                completed.stderr or completed.stdout or "conversion failed"
            ).strip()
            raise RuntimeError(
                f"LibreOffice could not convert {suffix}: {detail[:500]}"
            )
        return (
            rendered.read_bytes(),
            f"{Path(name).stem or 'document'}.pdf",
            suffix.lstrip("."),
        )


def _cpu_time_ns() -> int:
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    seconds = own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime
    return round(seconds * 1_000_000_000)


def _process_io_bytes() -> tuple[int, int]:
    try:
        fields = {}
        with open("/proc/self/io", encoding="ascii") as handle:
            for line in handle:
                key, value = line.split(":", 1)
                fields[key] = int(value.strip())
        return fields.get("read_bytes", 0), fields.get("write_bytes", 0)
    except (OSError, ValueError):
        return 0, 0


def _process_memory() -> dict[str, int]:
    try:
        import psutil

        info = psutil.Process().memory_full_info()
        return {
            "_worker_rss_bytes": max(0, int(info.rss)),
            "_worker_pss_bytes": max(0, int(getattr(info, "pss", 0))),
        }
    except (ImportError, OSError):
        return {"_worker_rss_bytes": 0, "_worker_pss_bytes": 0}


def _marker_converter(mode: str, *, disable_ocr: bool, force_ocr: bool, models: dict):
    from marker.config.parser import ConfigParser
    from marker.converters.pdf import PdfConverter

    config = {
        "output_format": "json",
        "mode": mode,
        "disable_ocr": disable_ocr,
        "force_ocr": force_ocr,
        "disable_image_extraction": False,
    }
    parser = ConfigParser(config)
    return PdfConverter(
        config=parser.generate_config_dict(),
        artifact_dict=models,
        processor_list=parser.get_processors(),
        renderer=parser.get_renderer(),
        llm_service=parser.get_llm_service(),
    )


def _rendered_dict(rendered: Any) -> dict[str, Any]:
    dump = getattr(rendered, "model_dump", None)
    if callable(dump):
        try:
            payload = dump(mode="json")
        except TypeError:
            payload = dump()
        if isinstance(payload, dict):
            return payload
    dump_json = getattr(rendered, "model_dump_json", None)
    if callable(dump_json):
        return json.loads(dump_json())
    if isinstance(rendered, dict):
        return rendered
    raise TypeError(f"unsupported marker output: {type(rendered)!r}")


def _run_marker(converter: Any, data: bytes, name: str) -> dict[str, Any]:
    from marker_adapt import (
        collect_marker_images,
        content_list_to_md,
        crop_missing_images,
        from_marker,
    )

    suffix = Path(name).suffix or ".pdf"
    if suffix.lower() not in {
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
        ".tif",
        ".tiff",
    }:
        suffix = ".pdf"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(data)
        path = handle.name
    try:
        rendered = converter(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    payload = _rendered_dict(rendered)
    content_list = from_marker(payload)
    images = collect_marker_images(payload)
    images = crop_missing_images(data, content_list, images)
    return {
        "content_list": content_list,
        "images": images,
        "md": content_list_to_md(content_list),
    }


def _rapidocr_engine() -> Any:
    from rapidocr import RapidOCR

    print(f"rapidocr: lazy-local pid={os.getpid()}", flush=True)
    return RapidOCR()


def _ensure_local_ocr() -> Any:
    global _OCR
    if _OCR is None:
        _OCR = _rapidocr_engine()
    return _OCR


def _page_lines(image: Any) -> list[dict[str, Any]]:
    return _rapid_lines(_ensure_local_ocr(), image)


def _as_seq(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    try:
        return list(value)
    except TypeError:
        return []


def _rapid_lines(engine: Any, image: Any) -> list[dict[str, Any]]:
    import numpy as np
    from marker_adapt import ocr_line_bbox

    result = engine(np.asarray(image))
    if result is None:
        return []
    texts: list[Any] = []
    boxes: list[Any] = []
    if hasattr(result, "txts"):
        texts = _as_seq(getattr(result, "txts", None))
        boxes = _as_seq(getattr(result, "boxes", None))
    elif isinstance(result, (list, tuple)) and result:
        first = result[0]
        if (
            isinstance(first, (list, tuple))
            and len(first) >= 2
            and not isinstance(first[0], (int, float))
        ):
            for row in result:
                try:
                    boxes.append(row[0])
                    texts.append(row[1])
                except (TypeError, IndexError):
                    continue
        elif len(result) >= 2:
            boxes = _as_seq(result[0])
            texts = _as_seq(result[1])
    width, height = image.size
    lines: list[dict[str, Any]] = []
    for text, poly in zip(texts, boxes):
        body = str(text or "").strip()
        if not body:
            continue
        lines.append(
            {"text": body, "bbox": ocr_line_bbox(poly, float(width), float(height))}
        )
    return lines


def _render_page(pdf: Any, index: int, max_edge: float = 2800.0) -> Any:
    page = pdf[index]
    try:
        width, height = float(page.get_width()), float(page.get_height())
        scale = min(2.0, max_edge / max(width, height, 1.0))
        return page.render(scale=max(scale, 1.0)).to_pil().convert("RGB")
    finally:
        page.close()


def _ocr_flagged_pages(
    data: bytes, page_indices: list[int]
) -> dict[int, list[dict[str, Any]]]:
    if not page_indices or not data.lstrip().startswith(b"%PDF"):
        if page_indices and not data.lstrip().startswith(b"%PDF"):
            from PIL import Image as PILImage

            image = PILImage.open(io.BytesIO(data)).convert("RGB")
            return {0: _page_lines(image)}
        return {}
    import pypdfium2 as pdfium

    out: dict[int, list[dict[str, Any]]] = {}
    pdf = pdfium.PdfDocument(data)
    try:
        for index in page_indices:
            if index < 0 or index >= len(pdf):
                continue
            image = _render_page(pdf, index)
            out[index] = _page_lines(image)
    finally:
        pdf.close()
    return out


def parse_fast(
    document: _Document,
    converter: Any,
    _ocr_engine: Any = None,
    *,
    probes: list[Any] | None = None,
    ocr_page_indices: list[int] | None = None,
) -> dict:
    from marker_adapt import content_list_to_md, drop_scan_rasters, merge_ocr_lines
    from scan_pages import probe_pages

    result = _run_marker(converter, document.data, document.name)
    method = normalize_parse_method(document.parse_method)
    if method == MARKER_ONLY:
        return result
    if probes is None:
        probes = probe_pages(document.data)
    flagged = (
        list(ocr_page_indices)
        if ocr_page_indices is not None
        else _ocr_page_indices(probes, method)
    )
    print(
        "fast probe: "
        + ", ".join(
            f"p{p.page_idx}:{p.reason}/{p.chars}ch/img{p.image_coverage:.2f}"
            for p in probes[:20]
        )
        + (f" ... ({len(probes)} pages)" if len(probes) > 20 else ""),
        flush=True,
    )
    if not flagged:
        return result
    ocr_pages = _ocr_flagged_pages(document.data, flagged)
    flagged_set = set(flagged)
    result["content_list"] = drop_scan_rasters(result["content_list"], flagged_set)
    result["content_list"] = merge_ocr_lines(result["content_list"], ocr_pages)
    result["md"] = content_list_to_md(result["content_list"])
    keep = {
        os.path.basename(str(item.get("img_path") or ""))
        for item in result["content_list"]
        if item.get("type") == "image"
    }
    result["images"] = {
        name: blob
        for name, blob in (result.get("images") or {}).items()
        if os.path.basename(name) in keep
    }
    return result
