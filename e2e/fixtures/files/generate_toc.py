"""Regenerate toc/report.docx, a Word table of contents whose publication rebase refuses a later edit to a TOC link; never contacts a provider."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).parent / "toc"
MARKER = "UAT_RUN_MARKER"
FACT = "Wetland plants absorb carbon and protect the shoreline."
W = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
)
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def run(xml):
    return f"<w:r>{xml}</w:r>"


def text(value):
    return run(f'<w:t xml:space="preserve">{value}</w:t>')


def char(kind):
    return run(f'<w:fldChar w:fldCharType="{kind}"/>')


def instr(value):
    return run(f'<w:instrText xml:space="preserve"> {value} </w:instrText>')


def paragraph(para_id, xml, style=None):
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f'<w:p w14:paraId="{para_id}">{props}{xml}</w:p>'


def entry(label, bookmark):
    """A TOC entry as Word writes it: a link to the heading, a tab and PAGEREF."""
    page = instr(f"PAGEREF {bookmark} \\h")
    return (
        f'<w:hyperlink w:anchor="{bookmark}" w:history="1">'
        '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:noProof/></w:rPr>'
        f"<w:t>{label}</w:t></w:r>"
        "<w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:tab/></w:r>"
        + char("begin")
        + page
        + char("separate")
        + "<w:r><w:rPr><w:noProof/><w:webHidden/></w:rPr><w:t>1</w:t></w:r>"
        + char("end")
        + "</w:hyperlink>"
    )


def heading(para_id, label, bookmark, number):
    return paragraph(
        para_id,
        f'<w:bookmarkStart w:id="{number}" w:name="{bookmark}"/>{text(label)}'
        f'<w:bookmarkEnd w:id="{number}"/>',
        "Heading1",
    )


def main():
    # The first TOC paragraph opens with one run holding a label and a tab,
    # which the export writes as two runs: the export's seed then numbers the
    # TOC field otherwise than the editor's, so text typed inside the first
    # entry after a publication's capture cannot be rebased.
    body = (
        paragraph("10000001", text("Wetland field report"), "Title")
        + paragraph(
            "10000002",
            "<w:r><w:t>Contents</w:t><w:tab/></w:r>"
            + char("begin")
            + instr('TOC \\o "1-3" \\h \\z \\u')
            + char("separate")
            + entry("Introduction", "_Toc1"),
            "TOC1",
        )
        + paragraph("10000003", entry("Details", "_Toc2") + char("end"), "TOC1")
        + heading("10000004", "Introduction", "_Toc1", 1)
        + paragraph("10000005", text(FACT), "Normal")
        + heading("10000006", "Details", "_Toc2", 2)
        + paragraph("10000007", text(MARKER), "Normal")
    )
    main_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    parts = {
        "[Content_Types].xml": (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            f'<Override PartName="/word/document.xml" ContentType="{main_type}"/></Types>'
        ),
        "_rels/.rels": (
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL}/officeDocument" Target="word/document.xml"/>'
            "</Relationships>"
        ),
        "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
        "word/document.xml": (
            f"<w:document {W}><w:body>{body}"
            '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>'
        ),
    }
    ROOT.mkdir(parents=True, exist_ok=True)
    with ZipFile(ROOT / "report.docx", "w", ZIP_DEFLATED) as archive:
        for name, xml in parts.items():
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, xml)


if __name__ == "__main__":
    main()
