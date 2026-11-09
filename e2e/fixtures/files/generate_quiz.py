"""Regenerate make-quiz/, the small invented papers of the Make a quiz specs; never contacts a provider."""

from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from docx import Document
from docx.shared import Pt
from pptx import Presentation
from pptx.util import Inches
from pptx.util import Pt as SlidePt

ROOT = Path(__file__).parent / "make-quiz"
TITLE = "Harbour Town practice sheet"
MARKER = "Sheet code: UAT_RUN_MARKER"
PAGES = (
    (
        (
            "1. A ferry leaves Pier Alto with 18 passengers and 5 more board at Reed Point. "
            "How many passengers are on the ferry now?"
        ),
        (
            "2. The lighthouse at Cape Morrow flashes every 6 seconds. "
            "How many times does it flash in one minute?"
        ),
    ),
    ("3. A market stall sells pears in bags of 4. How many pears are in 7 bags?",),
)


def stable_zip(path):
    with ZipFile(path) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name, data in sorted(entries.items()):
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, data)


def write_docx(path):
    doc = Document()
    doc.core_properties.created = doc.core_properties.modified = datetime(2026, 1, 1)
    doc.styles["Normal"].font.size = Pt(14)
    doc.add_paragraph(TITLE)
    doc.add_paragraph(MARKER)
    for number, questions in enumerate(PAGES):
        if number:
            doc.add_page_break()
        for question in questions:
            doc.add_paragraph(question)
    doc.save(path)
    stable_zip(path)


def write_pptx(path):
    deck = Presentation()
    deck.core_properties.created = deck.core_properties.modified = datetime(2026, 1, 1)
    for number, questions in enumerate(PAGES):
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        lines = ((TITLE, MARKER) if number == 0 else ()) + questions
        frame = slide.shapes.add_textbox(
            Inches(0.5), Inches(0.5), Inches(9), Inches(6.5)
        ).text_frame
        frame.word_wrap = True
        for i, line in enumerate(lines):
            paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
            paragraph.space_after = SlidePt(14)
            run = paragraph.add_run()
            run.text = line
            run.font.size = SlidePt(24)
    deck.save(path)
    stable_zip(path)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    write_docx(ROOT / "paper.docx")
    write_pptx(ROOT / "paper.pptx")


if __name__ == "__main__":
    main()
