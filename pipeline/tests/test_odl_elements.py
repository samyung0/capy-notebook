"""The element limits (parser/odl/elements.py): floods of images, vector
shapes, table rows or pictures are refused before the parse; a real-sized file
passes."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

import pymupdf
import pytest

PARSER_DIR = Path(__file__).resolve().parents[2] / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

from odl import elements


def _pdf(pages: list[bytes], forms: list[bytes] = ()) -> bytes:
    """Pages from raw content. One 1x1 image is /Im everywhere; forms[i] is
    /F{i} on every page and in every later form, drawing whatever it says."""
    doc = pymupdf.open()
    image = doc.get_new_xref()
    doc.update_object(
        image,
        "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
        "/ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>",
    )
    doc.update_stream(image, b"\x80", new=True, compress=False)
    names = [f"/Im {image} 0 R"]
    for index, content in enumerate(forms):
        form = doc.get_new_xref()
        doc.update_object(
            form,
            "<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] "
            f"/Resources << /XObject << {' '.join(names)} >> >> /Length 0 >>",
        )
        doc.update_stream(form, content, new=True)
        names.append(f"/F{index} {form} 0 R")
    for content in pages:
        page = doc.new_page()
        doc.xref_set_key(
            page.xref, "Resources", f"<< /XObject << {' '.join(names)} >> >>"
        )
        stream = doc.get_new_xref()
        doc.update_object(stream, "<< >>")
        doc.update_stream(stream, content, new=True)
        doc.xref_set_key(page.xref, "Contents", f"{stream} 0 R")
    return doc.tobytes()


def _package(parts: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as package:
        for name, data in parts.items():
            package.writestr(name, data)
    return out.getvalue()


def test_a_page_with_figures_and_shapes_passes() -> None:
    elements.check_pdf(_pdf([b"/Im Do\n" * 50 + b"0 0 1 1 re f\n" * 500] * 3))


def test_images_drawn_through_nested_forms_count_every_draw(monkeypatch) -> None:
    monkeypatch.setattr(elements, "PDF_PAGE_PLACEMENTS", 1_000)
    # F1 draws F0 40 times, F0 draws the image 30 times: 1,200 on one page.
    data = _pdf([b"/F1 Do\n"], forms=[b"/Im Do\n" * 30, b"/F0 Do\n" * 40])
    with pytest.raises(elements.TooManyElements, match="page 1 places 1,200"):
        elements.check_pdf(data)


def test_placements_and_paints_add_up_across_pages(monkeypatch) -> None:
    monkeypatch.setattr(elements, "PDF_PLACEMENTS", 100)
    with pytest.raises(elements.TooManyElements, match="image placements"):
        elements.check_pdf(_pdf([b"BI /W 1 /H 1 ID \x80 EI\n" * 30] * 4))
    monkeypatch.setattr(elements, "PDF_PAINTS", 100)
    with pytest.raises(elements.TooManyElements, match="vector shapes"):
        elements.check_pdf(_pdf([b"0 0 1 1 re f\n0 0 m 1 1 l S\n" * 30] * 2))


def test_a_form_drawing_itself_ends() -> None:
    elements.check_pdf(_pdf([b"/F0 Do\n"], forms=[b"/F0 Do\n/Im Do\n"]))


def test_docx_rows_and_pictures_are_counted_in_any_namespace(monkeypatch) -> None:
    monkeypatch.setattr(elements, "_CHUNK", 7)  # tags straddle every chunk
    rows = b"<w:tbl>" + b'<w:tr w:rsidR="1"><w:tc/></w:tr>' * 2_001 + b"</w:tbl>"
    with pytest.raises(elements.TooManyElements, match="2,000 table rows"):
        elements.check_office(_package({"word/document.xml": rows}), "a.docx")
    pictures = b"<x:drawing/>" * 1_000 + b"<w:pict>" * 1_001
    with pytest.raises(elements.TooManyElements, match="pictures and drawings"):
        elements.check_office(_package({"word/header1.xml": pictures}), "a.DOCX")
    # Exactly at the limit: no tag is counted twice across chunks.
    at_limit = b'<w:tr w:rsidR="1"><w:tc/></w:tr>' * 2_000
    elements.check_office(_package({"word/document.xml": at_limit}), "a.docx")


def test_pptx_shapes_and_pictures_add_up_across_slides() -> None:
    slide = b"<p:spTree>" + b"<p:sp>" * 500 + b"<p:pic>" * 300 + b"</p:spTree>"
    parts = {f"ppt/slides/slide{i}.xml": slide for i in range(3)}
    with pytest.raises(elements.TooManyElements, match="shapes and pictures"):
        elements.check_office(_package(parts), "deck.pptx")
    elements.check_office(_package({"ppt/slides/slide1.xml": slide}), "deck.pptx")


@pytest.mark.parametrize(
    ("data", "name"),
    [(b"\xd0\xcf\x11\xe0 legacy", "old.doc"), (b"PK\x03\x04 broken", "x.docx")],
)
def test_office_files_without_a_readable_package_go_to_the_conversion(
    data: bytes, name: str
) -> None:
    elements.check_office(data, name)
