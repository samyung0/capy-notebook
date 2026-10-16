"""Element limits: a PDF or Office file that draws far more images, vector
shapes, table rows or pictures than real documents do is refused before the
parse (bench/parsers/reports/2026-10-16-element-limit.md). The counts are
cheap: a PDF's content streams, or an Office package's XML before LibreOffice.
"""

from __future__ import annotations

import re
import zipfile
from collections import Counter
from io import BytesIO

import pymupdf

# Image placements (a Do or an inline image; a form XObject counts what it
# draws, times how often it is drawn). The largest real file has 53,668 and the
# largest real page 17,561; a million cost the parse 179 s.
PDF_PLACEMENTS = 250_000
PDF_PAGE_PLACEMENTS = 40_000
# Path-painting operators. The largest real file has 1.3 million; two million
# exhaust OpenDataLoader's 1 GiB heap.
PDF_PAINTS = 2_000_000
# Per Office file, before LibreOffice: (what, tag local names, limit). A tag of
# any namespace prefix counts. 10,000 DOCX rows convert in 142 s, 20,000
# pictures in 120 s, 10,000 PPTX shapes in up to 56 s.
OFFICE_LIMITS = {
    ".docx": (
        ("table rows", rb"tr", 2_000),
        ("pictures and drawings", rb"drawing|pict", 2_000),
    ),
    ".pptx": (("shapes and pictures", rb"sp|cxnSp|pic", 2_000),),
}
_OFFICE_PARTS = ("word/", "ppt/")
_CHUNK = 1 << 20
# The longest tag a pattern matches: "<", a 16-character prefix and ":", the
# name, and its delimiter; a chunk keeps this much of the previous one.
_TAIL = 64

_PAINT = re.compile(rb"(?<![^\s\]\)>])(?:f\*?|F|S|s|B\*?|b\*?)(?=\s)")
_INLINE = re.compile(rb"(?<!\S)BI(?=\s)")
_DO = re.compile(rb"/([^\s/\[\]()<>{}%]+)\s*Do(?=\s|$)")


class TooManyElements(ValueError):
    """The file holds more figures, shapes or table rows than the parser reads."""


def check_office(data: bytes, name: str) -> None:
    """Refuse a DOCX or PPTX past its limits. Other files, and packages that
    don't open, are left to the conversion."""
    suffix = name[name.rfind(".") :].lower() if "." in name else ""
    limits = OFFICE_LIMITS.get(suffix)
    if not limits:
        return
    patterns = [
        (what, re.compile(rb"<(?:[\w.-]{1,16}:)?(?:" + tags + rb")[\s/>]"), limit)
        for what, tags, limit in limits
    ]
    counts = Counter[str]()
    try:
        with zipfile.ZipFile(BytesIO(data)) as package:
            for info in package.infolist():
                if not (
                    info.filename.startswith(_OFFICE_PARTS)
                    and info.filename.endswith(".xml")
                ):
                    continue
                with package.open(info) as part:
                    tail = b""
                    while chunk := part.read(_CHUNK):
                        buffer = tail + chunk
                        for what, pattern, limit in patterns:
                            # A match inside the kept tail was counted already.
                            counts[what] += sum(
                                1
                                for m in pattern.finditer(buffer)
                                if m.end() > len(tail)
                            )
                            if counts[what] > limit:
                                raise TooManyElements(
                                    f"more than {limit:,} {what}; "
                                    f"the parser reads at most {limit:,}"
                                )
                        tail = buffer[-_TAIL:]
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError):
        return


def check_pdf(data: bytes) -> None:
    """Refuse a PDF past its image or vector limits."""
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        counter = _PdfCounter(doc)
        placements = paints = 0
        for page in doc:
            names = counter.names(page)
            page_placements, page_paints = counter.stream(
                page.read_contents(), names.get(0, {}), names
            )
            if page_placements > PDF_PAGE_PLACEMENTS:
                raise TooManyElements(
                    f"page {page.number + 1} places {page_placements:,} images; "
                    f"the parser reads at most {PDF_PAGE_PLACEMENTS:,} a page"
                )
            placements += page_placements
            paints += page_paints
            if placements > PDF_PLACEMENTS:
                raise TooManyElements(
                    f"more than {PDF_PLACEMENTS:,} image placements; "
                    f"the parser reads at most {PDF_PLACEMENTS:,}"
                )
            if paints > PDF_PAINTS:
                raise TooManyElements(
                    f"more than {PDF_PAINTS:,} vector shapes; "
                    f"the parser reads at most {PDF_PAINTS:,}"
                )


class _PdfCounter:
    """Placements and paints of content streams, each form XObject counted
    once and multiplied by its draws."""

    def __init__(self, doc: pymupdf.Document) -> None:
        self.doc = doc
        self.forms: dict[int, tuple[int, int]] = {}

    @staticmethod
    def names(page: pymupdf.Page) -> dict[int, dict[bytes, tuple[str, int]]]:
        """XObject names by the stream that names them: 0 for the page, else
        the form's xref."""
        names: dict[int, dict[bytes, tuple[str, int]]] = {}
        for xref, name, invoker, _ in page.get_xobjects():
            names.setdefault(invoker, {})[name.encode()] = ("form", xref)
        for image in page.get_images(full=True):
            names.setdefault(image[-1], {})[image[7].encode()] = ("image", image[0])
        return names

    def stream(
        self,
        content: bytes,
        local: dict[bytes, tuple[str, int]],
        names: dict[int, dict[bytes, tuple[str, int]]],
    ) -> tuple[int, int]:
        placements = len(_INLINE.findall(content))
        paints = len(_PAINT.findall(content))
        for name, draws in Counter(m.group(1) for m in _DO.finditer(content)).items():
            kind, xref = local.get(name, ("image", 0))
            if kind == "form":
                form_placements, form_paints = self.form(xref, names)
                placements += draws * form_placements
                paints += draws * form_paints
            else:
                placements += draws
        return placements, paints

    def form(
        self, xref: int, names: dict[int, dict[bytes, tuple[str, int]]]
    ) -> tuple[int, int]:
        if xref not in self.forms:
            self.forms[xref] = (0, 0)  # a form drawing itself adds nothing more
            self.forms[xref] = self.stream(
                self.doc.xref_stream(xref) or b"", names.get(xref, {}), names
            )
        return self.forms[xref]
