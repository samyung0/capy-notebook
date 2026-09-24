"""One PDF through OpenDataLoader, the reviewed native repairs and selective OCR.

The stage order is the lab's ``refined`` variant and must not be reshuffled:
font repair, Java, cell styles, adaptation, picture triage, column order,
hidden-OCR order, heading context, then table context, footer ancestry, list
geometry, glyph repairs, exponents, column continuations, source tables,
negation composition, and finally RapidOCR lines for pages without a text layer.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

from . import (
    columns,
    context,
    exponents,
    fonts,
    furniture,
    headings,
    hidden,
    java,
    lists,
    ocr,
    order,
    pictures,
    source_text,
    styles,
    tables,
)
from .adapter import odl_content_list


@dataclass
class ParseOutput:
    content_list: list[dict]
    markdown: str
    images: dict[str, bytes]
    ocr_pages: list[int]
    page_count: int
    phases: dict[str, float] = field(default_factory=dict)
    repaired_fonts: int = 0
    # Frozen before table recovery (furniture.py); the chunker must not infer
    # recurrence again on the replaced list.
    furniture: list[str] = field(default_factory=list)
    # The bytes every repair measured. Only set when a repair changed them,
    # so the ingest worker's heading retention and confidence read the same
    # text layer the parser did instead of the CJK-decoded original.
    parsed_pdf: bytes | None = None


def _check_images(
    blocks: list[dict], native_dir: Path
) -> tuple[dict[str, bytes], dict[str, str]]:
    images: dict[str, bytes] = {}
    names_by_content: dict[bytes, str] = {}
    names_by_path: dict[str, str] = {}
    for block in blocks:
        path = block.get("img_path")
        if not path:
            continue
        if path in names_by_path:
            block["img_path"] = names_by_path[path]
            continue
        file = native_dir / path
        if not file.is_file():
            raise ValueError(f"OpenDataLoader referenced a missing image {path}")
        content = file.read_bytes()
        name = names_by_content.get(content)
        if name is None:
            name = file.name
            if name in images:
                raise ValueError(f"OpenDataLoader reused an image basename {name}")
            images[name] = content
            names_by_content[content] = name
        names_by_path[path] = name
        block["img_path"] = name
    return images, names_by_path


def _image_markdown(markdown: str, names_by_path: dict[str, str]) -> str:
    # OpenDataLoader emits angle-bracket destinations for external images.
    def replace(match: re.Match) -> str:
        name = names_by_path.get(match[2])
        return f"{match[1]}<images/{name}>{match[3]}" if name else match[0]

    return re.sub(r"(!\[[^\]\n]*\]\()<([^>\n]+)>(\))", replace, markdown)


def parse_pdf(data: bytes, work_dir: Path, *, java_timeout_s: float) -> ParseOutput:
    """Parse one PDF. ``work_dir`` must be empty and is left for the caller to remove."""
    phases: dict[str, float] = {}
    started = time.perf_counter()
    repaired, repaired_fonts = fonts.repair_fonts(data)
    pdf = work_dir / "document.pdf"
    pdf.write_bytes(repaired)
    phases["fonts"] = time.perf_counter() - started

    started = time.perf_counter()
    java_deadline = started + java_timeout_s
    native_dir = work_dir / "native"
    native_dir.mkdir()
    try:
        native = java.run(pdf, native_dir, timeout_s=java_timeout_s)
    except java.JavaPageTreeError:
        phases["java"] = time.perf_counter() - started
        started = time.perf_counter()
        # Flatten the reader-incompatible xref history in this attempt's copy.
        # The source remains unchanged; both Java calls share one time budget.
        with pymupdf.open(pdf) as document:
            repaired = document.tobytes(
                garbage=0,
                deflate=False,
                no_new_id=True,
                encryption=pymupdf.PDF_ENCRYPT_KEEP,
            )
        pdf.write_bytes(repaired)
        phases["pdf_structure_rewrite"] = time.perf_counter() - started
        # Partial files from the first attempt must never reach refinement.
        native_dir = work_dir / "native-retry"
        native_dir.mkdir()
        remaining = java_deadline - time.perf_counter()
        if remaining <= 0:
            raise java.JavaTimeout("OpenDataLoader exhausted its PDF repair budget")
        started = time.perf_counter()
        native = java.run(pdf, native_dir, timeout_s=remaining)
        phases["java_structure_retry"] = time.perf_counter() - started
    else:
        phases["java"] = time.perf_counter() - started

    started = time.perf_counter()
    with pymupdf.open(pdf) as document:
        if native.get("number of pages") != len(document):
            raise ValueError("OpenDataLoader page count does not match the PDF")
        native, _ = styles.annotate(document, native)
        blocks = odl_content_list(
            native,
            [{"width": p.rect.width, "height": p.rect.height} for p in document],
        )
        blocks = pictures.classify(blocks, document, native_dir)
        images, image_paths = _check_images(blocks, native_dir)
        blocks, reordered = order.repair(blocks)
        blocks = order.move_rotated_labels(blocks, reordered, pdf)
        blocks = order.split_continuations(blocks, reordered, pdf)
        eligible = {
            page.number for page in document if hidden.source_facts(page)["eligible"]
        }
        blocks = hidden.recover_hidden_ocr_order(blocks, eligible)
        blocks = headings.rewrite(blocks, headings.source_headings(blocks, pdf))
        blocks = headings.correct_roles(blocks, document)
        phases["structure"] = time.perf_counter() - started

        started = time.perf_counter()
        blocks = context.contextualize(blocks)
        blocks, _ = tables.mark_footer_tables(blocks, native)
        blocks, _ = lists.repair_list_geometry(blocks, native, pdf)
        blocks, _ = source_text.repair_text(blocks, pdf, paragraphs=True)
        blocks, _ = lists.repair_lists(blocks, pdf)
        blocks, _ = exponents.restore_exponents(blocks, pdf)
        blocks, _ = columns.repair_columns(blocks, pdf)
        blocks = furniture.mark_page_numbers(blocks, document)
        furniture_texts = furniture.repeated_across_pages(blocks)
        blocks, _ = tables.recover_tables(blocks, document)
        blocks = fonts.compose_negations(blocks)
        phases["repairs"] = time.perf_counter() - started

        started = time.perf_counter()
        blocks, ocr_pages = ocr.add_ocr_text(blocks, document)
        phases["ocr"] = time.perf_counter() - started
        page_count = len(document)

    markdown_path = native_dir / "document.md"
    markdown = (
        markdown_path.read_text(encoding="utf-8") if markdown_path.is_file() else ""
    )
    return ParseOutput(
        content_list=blocks,
        markdown=_image_markdown(markdown, image_paths),
        images=images,
        ocr_pages=ocr_pages,
        page_count=page_count,
        phases=phases,
        repaired_fonts=repaired_fonts,
        furniture=furniture_texts,
        parsed_pdf=repaired if repaired != data else None,
    )


def dump(blocks: list[dict]) -> str:
    return json.dumps(blocks, ensure_ascii=False, separators=(",", ":"))
