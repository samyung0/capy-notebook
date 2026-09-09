"""Focused, model-free check for the conservative native page experiment."""

from __future__ import annotations

from types import SimpleNamespace

import pymupdf
from mineru_native_page import inspect_page, install, stats


def prose(page):
    page.insert_text((40, 55), "Study notes", fontsize=20, fontname="hebo")
    page.insert_textbox(
        (40, 95, 360, 175),
        "A paragraph contains several words and continues onto another line. "
        "Native text extraction should retain the complete paragraph in reading order.",
        fontsize=11,
    )
    page.insert_textbox(
        (40, 205, 360, 265),
        "The next paragraph has a distinct box and should remain distinct. "
        "Its words must also survive the original MinerU text fill.",
        fontsize=11,
    )


def main():
    with pymupdf.open() as document:
        page = document.new_page(width=420, height=600)
        prose(page)
        layout, diagnostic = inspect_page(page)
        assert diagnostic["reason"] == "eligible", diagnostic
        assert layout is not None
        blocks = [item for item in layout if item["label"] != "ocr_text"]
        assert [item["label"] for item in blocks] == ["paragraph_title", "text", "text"]
        assert [b["bbox"][1] for b in blocks] == sorted(b["bbox"][1] for b in blocks)
        assert all(item["text"] for item in layout if item["label"] == "ocr_text")
        pdf_bytes = document.tobytes()

    # PDFium retains the original dimensions for UserUnit-scaled PDFs.
    for unit in ["1", "1.0", "2", "0.5"]:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
            document.xref_set_key(document[0].xref, "UserUnit", unit)
            scaled_bytes = document.tobytes()
        with pymupdf.open(stream=scaled_bytes, filetype="pdf") as document:
            page = document[0]
            assert abs(page.rect.width - 420 * float(unit)) < 0.01
            accepted, reason = inspect_page(page)
            if float(unit) == 1:
                assert accepted is not None, reason
            else:
                assert accepted is None and reason["reason"] == "page_user_unit", reason

    # One text object per printed line still forms two complete paragraphs.
    with pymupdf.open() as document:
        page = document.new_page(width=420, height=600)
        full = "Words stay together while the line wraps into a paragraph."
        for index, (x, text) in enumerate(
            [
                (40, full),
                (40, full),
                (40, "The first paragraph ends here."),
                (62, full),
                (40, full),
                (40, "The next paragraph ends here."),
            ]
        ):
            page.insert_text((x, 110 + index * 24), text, fontsize=11)
        accepted, reason = inspect_page(page)
        assert accepted is not None, reason
        paragraphs = [item for item in accepted if item["label"] == "text"]
        assert len(paragraphs) == 2, (paragraphs, reason)
        # A distant page number on the same row is not another body column.
        page.insert_text((40, 40), "Running section", fontsize=10)
        page.insert_text((370, 40), "3", fontsize=10)
        accepted, reason = inspect_page(page)
        assert accepted is not None, reason
        assert len([item for item in accepted if item["label"] == "number"]) == 1
        assert len([item for item in accepted if item["label"] == "header"]) == 1

    # Native geometry cannot reliably recover lists, mixed-style headings or
    # paragraphs that remain fragmented after the simple joining pass.
    for kind in [
        "hanging_indent",
        "heading_style",
        "numbered_heading",
        "paragraph_fragments",
    ]:
        with pymupdf.open() as document:
            page = document.new_page(width=420, height=600)
            if kind == "hanging_indent":
                page.insert_text(
                    (40, 90),
                    "Author and work listed among references\n"
                    "  More reference details and publication information.\n"
                    "  Further details complete a hanging paragraph.",
                    fontsize=11,
                )
            else:
                prose(page)
                if kind == "heading_style":
                    page.insert_text(
                        (40, 300),
                        "A different heading face",
                        fontname="cour",
                        fontsize=11,
                    )
                elif kind == "numbered_heading":
                    page.insert_text(
                        (40, 300), "3.2 A subsection in the body font", fontsize=11
                    )
                else:
                    for index in range(6):
                        page.insert_text(
                            (90, 300 + index * 20),
                            "A narrow paragraph line.",
                            fontsize=11,
                        )
            accepted, reason = inspect_page(page)
            assert accepted is None, (kind, reason)
            expected = {
                "hanging_indent": "hanging_indent",
                "heading_style": "ambiguous_heading_style",
                "numbered_heading": "ambiguous_heading_style",
                "paragraph_fragments": "unresolved_paragraph_fragments",
            }[kind]
            assert reason["reason"] == expected, (kind, reason)

    # Closely spaced source words can reconstruct a row; a repeated column grid cannot.
    with pymupdf.open() as document:
        page = document.new_page(width=420, height=600)
        prose(page)
        for y in [330, 354]:
            for index, word in enumerate(
                ["ColumnA ", "ColumnB ", "ColumnC ", "ColumnD "]
            ):
                page.insert_text((40 + index * 52, y), word, fontsize=11)
        accepted, reason = inspect_page(page)
        assert accepted is None, reason

    # Images, vector tables, equations, hidden text and split columns keep ML.
    for kind in [
        "image",
        "table",
        "equation",
        "hidden",
        "columns",
        "rotated",
        "annotation",
        "widget",
    ]:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
            page = document[0]
            if kind == "image":
                pixel = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 10, 10), False)
                pixel.clear_with(0)
                page.insert_image((40, 300, 140, 400), pixmap=pixel)
            elif kind == "table":
                for y in [300, 325, 350, 375]:
                    page.draw_line((40, y), (350, y))
            elif kind == "equation":
                page.insert_text((40, 320), "x = 2y + 3", fontsize=11)
            elif kind == "hidden":
                page.insert_text((40, 320), "Hidden layer", render_mode=3)
            elif kind == "columns":
                page.insert_text((40, 320), "Left column", fontsize=11)
                page.insert_text((245, 320), "Right column", fontsize=11)
            elif kind == "rotated":
                page.set_rotation(90)
            elif kind == "annotation":
                page.add_text_annot((40, 320), "Margin note")
            elif kind == "widget":
                widget = pymupdf.Widget()
                widget.field_name = "Study answer"
                widget.field_type = pymupdf.PDF_WIDGET_TYPE_TEXT
                widget.field_value = "Answer typed in a PDF field"
                widget.rect = pymupdf.Rect(40, 320, 340, 350)
                page.add_widget(widget)
            accepted, reason = inspect_page(page)
            assert accepted is None, (kind, reason)

    # Safe rectangular clipping may surround text, but cannot truncate it.
    for clip, expected in [("0 0 420 600", True), ("40 300 80 300", False)]:
        with pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
            page = document[0]
            page.clean_contents()
            xref = page.get_contents()[0]
            document.update_stream(
                xref,
                f"q\n{clip} re W n\n".encode() + document.xref_stream(xref) + b"\nQ",
            )
            page = document.reload_page(page)
            accepted, reason = inspect_page(page)
            assert (accepted is not None) == expected, reason
            if not expected:
                assert reason["reason"] == "clipping_or_transparency", reason

    # Damaged source encoding is excluded even when its text looks word-like.
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as document:
        page = document[0]
        source_raw = page.get_text("rawdict")
        source_raw["blocks"][0]["lines"][0]["spans"][0]["chars"][0]["c"] = "\ue001"
        proxy = SimpleNamespace(
            parent=page.parent,
            xref=page.xref,
            rect=page.rect,
            number=page.number,
            rotation=page.rotation,
            cropbox_position=page.cropbox_position,
            first_annot=page.first_annot,
            first_widget=page.first_widget,
            get_image_info=page.get_image_info,
            get_texttrace=page.get_texttrace,
            get_drawings=page.get_drawings,
            get_text=lambda *args, **kwargs: source_raw,
        )
        accepted, reason = inspect_page(proxy)
        assert accepted is None and reason["reason"] == "encoding_or_math", reason
        proxy.get_text = page.get_text
        for changes in [
            {"opacity": 0.5},
            {"blendmode": "Multiply"},
            {"knockout": True},
        ]:
            group = {
                "type": "group",
                "opacity": 1.0,
                "blendmode": "Normal",
                "knockout": False,
                **changes,
            }
            proxy.get_drawings = lambda group=group, **kwargs: [group]
            accepted, reason = inspect_page(proxy)
            assert (
                accepted is None and reason["reason"] == "clipping_or_transparency"
            ), reason
        proxy.get_drawings = lambda **kwargs: [
            {"type": "group", "opacity": 1.0, "blendmode": "Normal", "knockout": False}
        ]
        accepted, reason = inspect_page(proxy)
        assert accepted is not None, reason

    # Exercise actual patched boundary without loading models, including order,
    # scale, requested OCR, all-native windows and fallback result mismatch.
    calls = []
    pipeline = SimpleNamespace(
        load_images_from_pdf_doc=lambda *args, **kwargs: [
            {"img_pil": SimpleNamespace(), "scale": 2}
        ],
        batch_image_analyze=lambda images, **kwargs: (
            calls.append((images, kwargs))
            or [[{"unchanged": index}] for index in range(len(images))]
        ),
    )
    install(pipeline)
    patched = pipeline.batch_image_analyze
    install(pipeline)
    assert pipeline.batch_image_analyze is patched
    image = pipeline.load_images_from_pdf_doc(None, pdf_bytes=pdf_bytes)[0]["img_pil"]
    other = SimpleNamespace()
    results = pipeline.batch_image_analyze(
        [(image, False, "en"), (other, False, "ja"), (image, True, "en")],
        formula_enable=True,
        table_enable=True,
    )
    assert results[0][0]["bbox"] == [v * 2 for v in layout[0]["bbox"]]
    assert results[1] == [{"unchanged": 0}]
    assert all(item["text"] == "" for item in results[0] if item["label"] == "ocr_text")
    assert all(item["text"] for item in results[2] if item["label"] == "ocr_text")
    assert calls[0][0] == [(other, False, "ja")]
    assert calls[0][1] == {"formula_enable": True, "table_enable": True}
    assert pipeline.batch_image_analyze([(image, False, "en")])[0] == results[0]
    assert len(calls) == 1
    counters = stats()
    assert counters["pages_bypassed"] == 3
    assert counters["pages_bypassed_ocr"] == 1
    assert counters["pages_model_analyzed"] == 1
    assert counters["inspection_seconds"] > 0
    print("Native page eligibility and MinerU boundary checks passed.")


if __name__ == "__main__":
    main()
