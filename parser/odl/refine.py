"""One PDF through OpenDataLoader and the reviewed native repairs.

The stage order is the lab's ``refined`` variant and must not be reshuffled:
font repair, Java, cell styles, adaptation, picture triage, vector figures,
column order, hidden-OCR order, heading context, then table context, footer
ancestry, list geometry, glyph repairs, exponents, formula structure, column
continuations, split ligatures, line joins, page numbers, list headings, layout
headings, heading levels, source tables, inline formula placeholders, figure
captions and negation composition. Pages without a text layer are listed for
the ingest worker's VLM (``textless.py``).
"""

from __future__ import annotations

import functools
import json
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
    joins,
    layout_headings,
    levels,
    list_headings,
    lists,
    order,
    outline_levels,
    page_text,
    pictures,
    scripts,
    source_text,
    styles,
    tables,
    textless,
)
from .adapter import odl_content_list


@dataclass
class ParseOutput:
    content_list: list[dict]
    # 0-based pages without a text layer, blank pages included.
    textless_pages: list[int]
    page_count: int
    phases: dict[str, float] = field(default_factory=dict)
    # Seconds per structure and repair stage ("module.function"), for profiles.
    stages: dict[str, float] = field(default_factory=dict)
    repaired_fonts: int = 0
    # Frozen before table recovery (furniture.py); the chunker must not infer
    # recurrence again on the replaced list.
    furniture: list[str] = field(default_factory=list)
    # The bytes every repair measured. Only set when a repair changed them,
    # so the ingest worker's heading retention and confidence read the same
    # text layer the parser did instead of the CJK-decoded original.
    parsed_pdf: bytes | None = None


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

    stages: dict[str, float] = {}
    step = functools.partial(_timed, stages)
    started = time.perf_counter()
    with pymupdf.open(pdf) as document, page_text.session(pdf):
        if native.get("number of pages") != len(document):
            raise ValueError("OpenDataLoader page count does not match the PDF")
        native, _ = step(styles.annotate)(document, native)
        blocks = step(odl_content_list)(
            native,
            [{"width": p.rect.width, "height": p.rect.height} for p in document],
        )
        blocks = step(pictures.classify)(
            blocks, document, java.image_objects(native_dir)
        )
        blocks = step(pictures.add_vector_figures)(blocks, document)
        blocks, reordered = step(order.repair)(blocks)
        blocks = step(order.move_rotated_labels)(blocks, reordered, pdf)
        blocks = step(order.split_continuations)(blocks, reordered, pdf)
        hidden_layer = step(hidden.hidden_text_layer)
        eligible = {page.number for page in document if hidden_layer(page)}
        blocks = step(hidden.recover_hidden_ocr_order)(blocks, eligible)
        blocks = step(headings.rewrite)(
            blocks, step(headings.source_headings)(blocks, pdf)
        )
        blocks = step(headings.correct_roles)(blocks, document)
        phases["structure"] = time.perf_counter() - started

        started = time.perf_counter()
        blocks = step(context.contextualize)(blocks)
        blocks, _ = step(tables.mark_footer_tables)(blocks, native)
        blocks, _ = step(lists.repair_list_geometry)(blocks, native, pdf)
        blocks, _ = step(source_text.repair_text)(blocks, pdf, paragraphs=True)
        blocks, _ = step(lists.repair_lists)(blocks, pdf)
        blocks, _ = step(exponents.restore_exponents)(blocks, pdf)
        blocks = step(scripts.restore_structure)(blocks, document)
        blocks, _ = step(columns.repair_columns)(blocks, pdf)
        # Before furniture is frozen, so a repeated line keeps one text key.
        blocks, _ = step(source_text.join_split_ligatures)(blocks, pdf)
        blocks = step(joins.repair_joins)(blocks, document)
        blocks = step(furniture.mark_page_numbers)(blocks, document)
        # Headings ODL folded into list items, before levels are settled.
        blocks = step(list_headings.split_headings)(blocks, document)
        blocks = step(layout_headings.recall_headings)(blocks, document)
        # Heading levels once roles, folios and heading text are settled.
        blocks = step(levels.demote_fragments)(blocks, document)
        blocks = step(levels.demote_contents_lines)(blocks, document)
        blocks = step(outline_levels.relevel)(blocks, document)
        blocks = step(outline_levels.mark_book_titles)(blocks, document)
        furniture_texts = step(furniture.repeated_across_pages)(blocks)
        blocks, _ = step(tables.recover_tables)(blocks, document)
        # Empty tables carry nothing once recovery had its chance to fill them.
        blocks = [b for b in blocks if not pictures.empty_table(b)]
        blocks = step(pictures.place_inline)(blocks, document)
        blocks = step(pictures.attach_captions)(blocks)
        blocks = step(fonts.compose_negations)(blocks)
        # Last heading stage: levels become stack depths, paths unchanged.
        blocks = step(outline_levels.depth_levels)(blocks)
        phases["repairs"] = time.perf_counter() - started

        started = time.perf_counter()
        textless_pages = textless.textless_pages(document)
        phases["textless"] = time.perf_counter() - started
        page_count = len(document)

    return ParseOutput(
        content_list=blocks,
        textless_pages=textless_pages,
        page_count=page_count,
        phases=phases,
        stages=stages,
        repaired_fonts=repaired_fonts,
        furniture=furniture_texts,
        parsed_pdf=repaired if repaired != data else None,
    )


def _timed(stages: dict[str, float], stage):
    """``stage`` with its seconds added to ``stages`` under its module and name."""
    name = f"{stage.__module__.rsplit('.', 1)[-1]}.{stage.__name__}"

    def call(*args, **kwargs):
        started = time.perf_counter()
        try:
            return stage(*args, **kwargs)
        finally:
            stages[name] = stages.get(name, 0.0) + time.perf_counter() - started

    return call


def dump(blocks: list[dict]) -> str:
    return json.dumps(blocks, ensure_ascii=False, separators=(",", ":"))
