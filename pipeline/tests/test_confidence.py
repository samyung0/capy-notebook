"""Extraction confidence and heading retention on a parsed document's PDF."""

from __future__ import annotations

from pathlib import Path

import pymupdf

from pipeline.retrieval import confidence
from pipeline.retrieval.chunking import Chunk, Region, chunk_content_list
from pipeline.retrieval.headings import retain_headings

PAGE = "Mean height 15 m. West 16 18 12 20. Total 120 120."


def test_score_rewards_agreement_and_flags_drift_tables_and_coverage() -> None:
    good, reasons = confidence.score_chunk("Mean height 15 m. West 16 18", [PAGE], 0.9)
    assert good > 0.95 and not reasons
    garbled, reasons = confidence.score_chunk("ｍean heigh1 l5 rn wesf 1G", [PAGE], 0.9)
    assert garbled < 0.6 and "differs" in reasons[0]
    table, reasons = confidence.score_chunk(
        "a | b | c\n1 | 2 | 3\n4 | 5", [PAGE + " a b c 1 2 3 4 5"], 0.9
    )
    assert table < 1 and "uneven" in reasons[0]
    gap, reasons = confidence.score_chunk("Mean height 15 m", [PAGE], 0.4)
    assert gap < 0.9 and "missing from the index" in reasons[0]
    scan, reasons = confidence.score_chunk("anything", [""], None)
    assert scan == 0.35 and "no text layer" in reasons[0]
    assert confidence.tokens("光合作用 ATP") == list("光合作用") + ["atp"]
    mixed, _ = confidence.score_chunk(
        "Tian Qi, Harbin 150001",
        [
            "祁天1 哈尔滨工业大学计算学部 Tian Qi, Harbin 150001 摘要 随着全球化的加速发展跨语言信息"
        ],
        0.9,
    )
    assert mixed == 1.0


def test_ocr_routed_pages_score_a_fixed_half() -> None:
    assert confidence.score_chunk("whatever", [PAGE], 1.0, ocr_page=True) == (
        0.5,
        ["page text came from OCR"],
    )
    blocks = [
        {"type": "text", "text": "native", "page_idx": 0},
        {"type": "text", "text": "line", "page_idx": 3, "_recovery": "rapidocr-line"},
    ]
    assert confidence.ocr_pages(blocks) == {4}


def test_score_chunks_reads_the_pdf_once_per_file(tmp_path: Path) -> None:
    document = pymupdf.open()
    document.new_page().insert_text((50, 50), PAGE)
    document.new_page().insert_text(
        (50, 50), "Second page says something else entirely here."
    )
    path = tmp_path / "doc.pdf"
    document.save(path)
    chunks = [
        Chunk(
            text="Mean height 15 m. West 16 18 12 20. Total 120 120.",
            page_start=1,
            page_end=1,
        ),
        Chunk(text="invented words nowhere on the page", page_start=2, page_end=2),
        Chunk(text="no page model"),
    ]
    confidence.score_chunks(chunks, path, ocr={2})
    assert chunks[0].confidence == 1.0 and chunks[0].confidence_reasons == []
    assert chunks[1].confidence == 0.5 and chunks[1].confidence_reasons == [
        "page text came from OCR"
    ]
    assert chunks[2].confidence is None and chunks[2].confidence_reasons == []


def _heading_fixture(tmp_path: Path):
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "A confirmed source heading", fontsize=14)
    page.insert_text((50, 150), "An invisible OCR heading", fontsize=14, render_mode=3)
    page.insert_text((50, 200), "The next section", fontsize=14)
    page.insert_text((50, 225), "Source body remains unchanged.", fontsize=11)
    blocks = []
    for index, group in enumerate(page.get_text("dict")["blocks"]):
        box = group["bbox"]
        blocks.append(
            {
                "type": "text",
                "text": " ".join(
                    s["text"] for line in group["lines"] for s in line["spans"]
                ),
                "page_idx": 0,
                "bbox": [
                    box[0] / page.rect.width * 1000,
                    box[1] / page.rect.height * 1000,
                    box[2] / page.rect.width * 1000,
                    box[3] / page.rect.height * 1000,
                ],
            }
        )
        if index < 3:
            blocks[-1]["text_level"] = 1
    path = tmp_path / "headings.pdf"
    document.save(path)
    return blocks, path


def test_orphan_headings_are_retained_only_when_visible_in_the_source(
    tmp_path: Path,
) -> None:
    blocks, path = _heading_fixture(tmp_path)
    original = Chunk(
        text=blocks[-1]["text"],
        section_path=blocks[-2]["text"],
        page_start=1,
        page_end=1,
        regions=[Region(1, blocks[-1]["bbox"])],
    )
    retained = retain_headings(blocks, path, [original])
    assert len(retained) == 2 and retained[1] == original
    assert retained[0].text == blocks[0]["text"] and retained[0].section_path == ""
    assert retained[0].regions == [Region(1, blocks[0]["bbox"])]
    # The invisible heading is not retained and the pass is idempotent.
    assert retain_headings(blocks, path, retained) == retained


def test_chunker_output_keeps_the_heading_that_has_a_body(tmp_path: Path) -> None:
    blocks, path = _heading_fixture(tmp_path)
    chunks = chunk_content_list(blocks)
    retained = retain_headings(blocks, path, chunks)
    texts = [c.text for c in retained]
    assert texts[0] == "A confirmed source heading"
    assert "An invisible OCR heading" not in texts
    assert any(c.section_path == "The next section" for c in retained)


def test_short_orphan_headings_keep_source_proof_and_furniture_guards(
    tmp_path: Path,
) -> None:
    labels = [
        "Cell cycle",
        "Interphase",
        "Prophase",
        "Metaphase",
        "Anaphase",
        "Telophase",
        "摘要",
    ]
    blocks = []
    with pymupdf.open() as document:
        for page_idx in range(3):
            page = document.new_page(width=600, height=800)
            page.insert_text((50, 35), "Notes", fontsize=14)
            if page_idx == 0:
                for i, label in enumerate(labels):
                    page.insert_text(
                        (50, 100 + i * 60),
                        label,
                        fontsize=18,
                        fontname="china-s" if label == "摘要" else "helv",
                    )
                page.insert_text((50, 600), "Invisible", render_mode=3)
                page.insert_text((50, 650), "123")
            for group in page.get_text("dict")["blocks"]:
                box = group["bbox"]
                blocks.append(
                    {
                        "type": "text",
                        "text_level": 1,
                        "page_idx": page_idx,
                        "text": "".join(
                            s["text"] for line in group["lines"] for s in line["spans"]
                        ),
                        "bbox": [
                            box[0] / 600 * 1000,
                            box[1] / 800 * 1000,
                            box[2] / 600 * 1000,
                            box[3] / 800 * 1000,
                        ],
                    }
                )
        path = tmp_path / "short-headings.pdf"
        document.save(path)
    chunks = retain_headings(blocks, path, [])
    assert [c.text for c in chunks] == labels
    assert retain_headings(blocks, path, chunks) == chunks


def test_font_repaired_pdf_scores_like_the_lab(tmp_path: Path) -> None:
    """ccl-feedback page 1 trips the Type1/ToUnicode gate: read through the
    uploaded bytes every chunk looks garbled; read through the bytes the
    parser repaired (the bundle's ``parsed.pdf``) they match the text layer."""
    import copy
    import json
    import sys

    parser_dir = Path(__file__).resolve().parents[2] / "parser"
    if str(parser_dir) not in sys.path:
        sys.path.insert(0, str(parser_dir))
    from odl import fonts

    fixture = Path(__file__).parent / "fixtures" / "odl-ccl-feedback-p1"
    original = (fixture / "source.pdf").read_bytes()
    repaired, count = fonts.repair_fonts(original)
    assert count == 1
    chunks = [
        Chunk(
            text=c["text"],
            section_path=c["section_path"],
            page_start=c["page_start"],
            page_end=c["page_end"],
            regions=[Region(r["page"], r["bbox"]) for r in c["regions"]],
        )
        for c in json.loads((fixture / "chunks.json").read_text(encoding="utf-8"))
    ]
    assert len(chunks) == 4

    # The broken font is the body Latin: its glyphs decode as CJK until repaired.
    with pymupdf.open(stream=original, filetype="pdf") as doc:
        assert "（畃界畆畃畇）" in doc[0].get_text()
    with pymupdf.open(stream=repaired, filetype="pdf") as doc:
        assert "（CLFCG）" in doc[0].get_text()

    repaired_path = tmp_path / "parsed.pdf"
    repaired_path.write_bytes(repaired)
    unrepaired = copy.deepcopy(chunks)
    confidence.score_chunks(unrepaired, fixture / "source.pdf", ocr=set())
    confidence.score_chunks(chunks, repaired_path, ocr=set())
    assert all(c.confidence < 0.9 for c in unrepaired)
    assert all(c.confidence >= 0.98 and not c.confidence_reasons for c in chunks)
