"""Focused check, run in the MinerU 3.4.5 environment without loading models."""

import math
from copy import deepcopy

import mineru_native_text as candidate
import numpy as np
import pypdfium2 as pdfium
from mineru.utils.bbox_utils import normalize_to_int_bbox
from mineru.utils.pdf_text_tool import get_lines_from_chars
from mineru.utils.span_pre_proc import fill_char_in_spans


def _pdf(stream, raster=False):
    if raster:
        stream = b"q 240 0 0 200 0 0 cm /I1 Do Q\n" + stream
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 4 0 R /F2 6 0 R >> /XObject << /I1 7 0 R >> /ExtGState << /Invisible << /Type /ExtGState /ca 0 /CA 0 >> >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length "
        + str(len(stream)).encode()
        + b" >>\nstream\n"
        + stream
        + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>",
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\xff\xff\xff\nendstream",
    ]
    result = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(result)
    result.extend(b"xref\n0 8\n0000000000 65535 f \n")
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(
        f"trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    )
    return bytes(result)


def _read(stream, raster=False):
    pdf = pdfium.PdfDocument(_pdf(stream, raster=raster))
    page = pdf[0]
    bitmap = page.render(scale=2)
    image = np.array(bitmap.to_pil())[:, :, :3]
    native = candidate._read_page(pdf, 0, 2)
    bitmap.close()
    page.close()
    pdf.close()
    return native, image


def main():
    stream = b"BT /F1 12 Tf 20 160 Td (Native text with words) Tj 0 -20 Td (Second line) Tj ET"
    native, image = _read(stream)
    lines = get_lines_from_chars(native["chars"])
    region = [35, 55, 305, 128]
    boxes, reason = candidate._region_boxes(native, region, [], image)
    assert reason == "accepted" and len(boxes) == len(lines) == 2

    # Real text extraction puts generated CR/LF after trailing spaces. A neural
    # box can include every visible glyph while excluding those separator boxes.
    expected_rows = [f"Ordinary row number {i}." for i in range(1, 10)]
    row_stream = b"BT /F1 12 Tf 20 170 Td "
    row_stream += (
        b" 0 -16 Td ".join(("(" + text + " ) Tj").encode() for text in expected_rows)
        + b" ET"
    )
    row_native, row_image = _read(row_stream)
    visible_boxes = [
        candidate._bbox(c["bbox"]) for c in row_native["chars"] if c["char"].strip()
    ]
    tight_region = [
        min(b[0] for b in visible_boxes) * 2 - 1,
        min(b[1] for b in visible_boxes) * 2 - 1,
        max(b[2] for b in visible_boxes) * 2 + 0.1,
        max(b[3] for b in visible_boxes) * 2 + 1,
    ]
    cropped_chars = [
        c
        for c in row_native["chars"]
        if candidate._inside_center(
            candidate._bbox(c["bbox"]), [v / 2 for v in tight_region]
        )
    ]
    assert not any(c["char"] in {"\r", "\n"} for c in cropped_chars)
    assert len(get_lines_from_chars(cropped_chars)) == 1
    row_boxes, reason = candidate._region_boxes(row_native, tight_region, [], row_image)
    assert reason == "accepted" and len(row_boxes) == len(expected_rows)
    spans = []
    for row_box in row_boxes:
        bbox = [int(v / 2) for v in normalize_to_int_bbox(row_box)]
        spans.append(
            {
                "bbox": bbox,
                "height": bbox[3] - bbox[1],
                "width": bbox[2] - bbox[0],
                "chars": [],
                "content": "",
            }
        )
    assert not fill_char_in_spans(spans, row_native["chars"], spans[0]["height"])
    assert [span["content"] for span in spans] == expected_rows
    x0, y0, x1, y1 = tight_region
    paragraph_box = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]
    assert (
        candidate._plain_fill_matches(row_native, cropped_chars, paragraph_box, [])
        == "native_fill_coverage"
    )

    # Same exponent in one text object and in a separate text object. The latter
    # can form its own native line with no superscript flag, as in the VM probe.
    for script_stream in (
        b"BT /F1 12 Tf 20 160 Td (4) Tj /F2 12 Tf (p) Tj /F1 12 Tf (r) Tj /F1 8 Tf 4 Ts (2) Tj 0 Ts /F1 12 Tf (.) Tj ET",
        b"BT /F1 12 Tf 20 160 Td (4) Tj /F2 12 Tf (p) Tj /F1 12 Tf (r) Tj ET BT /F1 8 Tf 37 164 Td (2) Tj ET BT /F1 12 Tf 42 160 Td (.) Tj ET",
    ):
        script_native, script_image = _read(script_stream)
        assert (
            "".join(c["char"] for c in script_native["chars"] if c["char"].strip())
            == "4πr2."
        )
        assert candidate._region_boxes(
            script_native, [35, 45, 110, 90], [], script_image
        )[1] in {"inline_scripts", "overlapping_native_lines"}

    corrupt = deepcopy(native)
    corrupt["chars"][0]["_unreliable"] = True
    assert candidate._region_boxes(corrupt, region, [], image)[1] == "unreliable_chars"
    corrupt = deepcopy(native)
    corrupt["chars"][0]["rotation"] = math.pi / 2
    assert candidate._region_boxes(corrupt, region, [], image)[1] == "unreliable_chars"
    corrupt = deepcopy(native)
    corrupt["chars"][0]["char"] = "\ue001"
    assert candidate._region_boxes(corrupt, region, [], image)[1] == "unreliable_chars"

    missing = deepcopy(native)
    missing["chars"] = missing["chars"][7:]
    assert candidate._region_boxes(missing, region, [], image)[1] == "unexplained_ink"
    raster, raster_image = _read(stream, raster=True)
    assert len(raster["images"]) == 1
    assert (
        candidate._region_boxes(raster, region, [], raster_image)[1]
        == "accepted_raster_overlap"
    )
    for color in ((240, 240, 240), (250, 239, 250)):
        missing_pixels = raster_image.copy()
        missing_pixels[120:125, 290:291] = color
        assert (
            candidate._region_boxes(raster, region, [], missing_pixels)[1]
            == "raster_unexplained_ink"
        )
    transparent, transparent_image = _read(b"q /Invisible gs " + stream + b" Q")
    assert (
        candidate._region_boxes(transparent, region, [], transparent_image)[1]
        == "unreliable_chars"
    )
    occluded, occluded_image = _read(stream + b" 1 1 1 rg 0 0 240 200 re f")
    assert (
        candidate._region_boxes(occluded, region, [], occluded_image)[1]
        == "invisible_native_line"
    )
    assert (
        candidate._region_boxes({"reason": "page_geometry"}, region, [], image)[1]
        == "page_geometry"
    )

    first = candidate._bbox(lines[0]["bbox"])
    formula = {
        "bbox": [first[0] * 2 + 60, first[1] * 2, first[0] * 2 + 90, first[3] * 2]
    }
    split_boxes, reason = candidate._region_boxes(native, region, [formula], image)
    assert reason == "accepted" and len(split_boxes) == 3
    assert all(
        box[2][0] <= formula["bbox"][0] or box[0][0] >= formula["bbox"][2]
        for box in split_boxes
        if box[0][1] < first[3] * 2
    )

    text = {"label": "text", "bbox": region, "score": 0.9}
    empty = {"label": "text", "bbox": [320, 55, 400, 128], "score": 0.9}
    table = {"label": "table", "bbox": [20, 160, 300, 350], "score": 0.9}
    layout = [text, empty, table]
    original = deepcopy(layout)
    remaining = candidate._filter_regions(
        native, False, image, layout, [text, empty], []
    )
    assert remaining == [empty] and layout[:3] == original
    assert len(layout[3:]) == 2 and all(item["text"] == "" for item in layout[3:])
    unchanged = deepcopy(original)
    assert candidate._filter_regions(native, True, image, unchanged, [text], []) == [
        text
    ]
    assert unchanged == original
    counts = candidate.stats()
    assert counts["regions_bypassed"] == 1 and counts["regions_fallback"] == 2

    # A question and its score marker may have overlapping neural boxes. Native
    # glyph centers cannot decide which block owns a parenthesis in their overlap.
    question_native, question_image = _read(
        b"BT /F1 12 Tf 20 160 Td (Question?) Tj ET BT /F1 12 Tf 205 160 Td ((2)) Tj ET"
    )
    question = {"label": "text", "bbox": [35, 55, 416, 90]}
    marker = {"label": "text", "bbox": [404, 55, 450, 90]}
    overlapping = [question, marker]
    original = deepcopy(overlapping)
    assert any(
        candidate._inside_center(
            [v * 2 for v in candidate._bbox(char["bbox"])], question["bbox"]
        )
        and candidate._inside_center(
            [v * 2 for v in candidate._bbox(char["bbox"])], marker["bbox"]
        )
        for char in question_native["chars"]
        if char["char"].strip()
    )
    assert (
        candidate._filter_regions(
            question_native, False, question_image, overlapping, overlapping.copy(), []
        )
        == original
    )
    assert overlapping == original
    assert candidate.stats()["overlapping_layout_regions"] == 2
    print(
        "Native-text check passed: cropped CR/LF with exact nine-row native fill, scripts, mapping, rotation, pale/colored/thin missing ink, raster background, transparency/occlusion, formulas and overlap fallback."
    )


if __name__ == "__main__":
    main()
