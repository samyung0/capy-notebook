"""MinerU pipeline adapter for bounded, independently parsed PDF slices."""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MINERU_BACKEND = "pipeline"
MINERU_DEFAULT_METHOD = "auto"
MINERU_METHODS = frozenset({"auto", "txt", "ocr"})
OFFICE_SUFFIXES = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})
OFFICE_PREVIEW_MAX_BYTES = int(
    os.environ.get("CAPY_OFFICE_PREVIEW_MAX_BYTES", str(128 << 20))
)
OUTPUT_ROOT = Path(
    os.environ.get("MINERU_API_OUTPUT_ROOT", "/run/capy-parser/output")
).resolve()


@dataclass(frozen=True)
class NormalizedDocument:
    data: bytes
    name: str
    source_format: str
    preview_pdf: bytes | None = None


@dataclass(frozen=True)
class PageSlice:
    start: int
    end: int

    @property
    def page_count(self) -> int:
        return self.end - self.start + 1


@dataclass(frozen=True)
class SliceResult:
    page_slice: PageSlice
    content_list: list[dict[str, Any]]
    markdown: str
    images: dict[str, bytes]
    ocr_enabled: bool


def normalize_parse_method(value: str) -> str:
    method = (value or MINERU_DEFAULT_METHOD).strip().lower()
    if method not in MINERU_METHODS:
        raise ValueError(f"unsupported MinerU parse method {value!r}")
    return method


def normalize_document(data: bytes, name: str) -> NormalizedDocument:
    """Return the PDF bytes MinerU parses and the exact Office citation PDF."""
    suffix = Path(name).suffix.lower()
    if not suffix and data.lstrip().startswith(b"%PDF"):
        suffix = ".pdf"
    if suffix == ".pdf":
        return NormalizedDocument(data, name or "document.pdf", "pdf")
    if suffix not in OFFICE_SUFFIXES:
        raise ValueError("MinerU document parsing supports PDF and Office files")

    timeout = max(30, int(os.environ.get("CAPY_OFFICE_CONVERT_TIMEOUT", "180")))
    with tempfile.TemporaryDirectory(prefix="capy_office_") as tmp_name:
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
        if rendered.stat().st_size > OFFICE_PREVIEW_MAX_BYTES:
            raise RuntimeError(
                "LibreOffice PDF exceeds the "
                f"{OFFICE_PREVIEW_MAX_BYTES}-byte preview limit"
            )
        pdf = rendered.read_bytes()
    return NormalizedDocument(
        pdf,
        f"{Path(name).stem or 'document'}.pdf",
        suffix.lstrip("."),
        preview_pdf=pdf,
    )


def pdf_page_count(data: bytes) -> int:
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(data)
    try:
        return len(document)
    finally:
        document.close()


def page_slices(page_count: int, pages_per_slice: int) -> list[PageSlice]:
    if page_count <= 0:
        return []
    if pages_per_slice <= 0:
        raise ValueError("pages per slice must be positive")
    return [
        PageSlice(start, min(page_count - 1, start + pages_per_slice - 1))
        for start in range(0, page_count, pages_per_slice)
    ]


def _safe_stem(name: str) -> str:
    stem = re.sub(r"[^a-zA-Z0-9_.-]+", "-", Path(name).stem).strip("-.")
    return stem[:80] or "document"


def _offset_page_indices(value: Any, offset: int) -> None:
    if isinstance(value, dict):
        page_idx = value.get("page_idx")
        if isinstance(page_idx, int) and not isinstance(page_idx, bool):
            value["page_idx"] = page_idx + offset
        for nested in value.values():
            _offset_page_indices(nested, offset)
    elif isinstance(value, list):
        for nested in value:
            _offset_page_indices(nested, offset)


def _slice_uses_ocr(data: bytes, page_slice: PageSlice, method: str) -> bool:
    if method == "ocr":
        return True
    if method == "txt":
        return False
    from mineru.backend.pipeline.pipeline_analyze import _get_ocr_enable
    from mineru.cli.common import convert_pdf_bytes_to_bytes

    sliced = convert_pdf_bytes_to_bytes(data, page_slice.start, page_slice.end)
    return bool(_get_ocr_enable(sliced, method))


def parse_slice(
    data: bytes,
    name: str,
    page_slice: PageSlice,
    parse_method: str = MINERU_DEFAULT_METHOD,
) -> SliceResult:
    """Parse one inclusive page range through MinerU's persistent model cache."""
    from mineru.cli.common import do_parse

    method = normalize_parse_method(parse_method)
    slice_name = f"{_safe_stem(name)}-p{page_slice.start + 1}-{page_slice.end + 1}"
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="slice-", dir=OUTPUT_ROOT) as tmp_name:
        do_parse(
            output_dir=tmp_name,
            pdf_file_names=[slice_name],
            pdf_bytes_list=[data],
            p_lang_list=["ch"],
            backend=MINERU_BACKEND,
            parse_method=method,
            formula_enable=True,
            table_enable=True,
            image_analysis=False,
            f_draw_layout_bbox=False,
            f_draw_span_bbox=False,
            f_dump_md=True,
            f_dump_middle_json=False,
            f_dump_model_output=False,
            f_dump_orig_pdf=False,
            f_dump_content_list=True,
            start_page_id=page_slice.start,
            end_page_id=page_slice.end,
        )
        parse_dir = Path(tmp_name) / slice_name / method
        content_path = parse_dir / f"{slice_name}_content_list.json"
        markdown_path = parse_dir / f"{slice_name}.md"
        content_list = json.loads(content_path.read_text(encoding="utf-8"))
        if not isinstance(content_list, list) or not all(
            isinstance(item, dict) for item in content_list
        ):
            raise TypeError("MinerU returned an invalid content list")
        _offset_page_indices(content_list, page_slice.start)
        images = {
            path.name: path.read_bytes()
            for path in sorted((parse_dir / "images").glob("*"))
            if path.is_file()
        }
        markdown = (
            markdown_path.read_text(encoding="utf-8") if markdown_path.is_file() else ""
        )
        return SliceResult(
            page_slice=page_slice,
            content_list=content_list,
            markdown=markdown,
            images=images,
            ocr_enabled=_slice_uses_ocr(data, page_slice, method),
        )


def merge_slices(results: list[SliceResult]) -> dict[str, Any]:
    content_list: list[dict[str, Any]] = []
    markdown: list[str] = []
    images: dict[str, bytes] = {}
    ocr_pages: list[int] = []
    for result in sorted(results, key=lambda item: item.page_slice.start):
        content_list.extend(result.content_list)
        if result.markdown.strip():
            markdown.append(result.markdown.strip())
        if result.ocr_enabled:
            ocr_pages.extend(range(result.page_slice.start, result.page_slice.end + 1))
        for name, body in result.images.items():
            previous = images.get(name)
            if previous is not None and previous != body:
                raise ValueError(f"MinerU image name collision for {name}")
            images[name] = body
    return {
        "content_list": content_list,
        "md": "\n\n".join(markdown),
        "images": {
            name: base64.b64encode(body).decode("ascii")
            for name, body in images.items()
        },
        "_ocr_pages": ocr_pages,
    }
