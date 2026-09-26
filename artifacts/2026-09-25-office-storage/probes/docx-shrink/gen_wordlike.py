"""Word-like variant of book-30p: the same text model, but with the run
structure Word writes. Each paragraph is split into 2-6 runs at word
boundaries with rsid attributes (identical formatting), some runs carry
rFonts hints and w:lang, spell-check proofErr marks sit between runs, a
_GoBack bookmark, a few lastRenderedPageBreak marks, and about 2% of runs
carry a tracked formatting change (w:rPrChange).

Writes files/book-30p-word.docx next to this script. Deterministic.
"""

import random
import sys
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).parent.parent / "storage"))
import gen_files as g

OUT = Path(__file__).parent / "files"
OUT.mkdir(exist_ok=True)
RSIDS = ["00A1B2C3", "00D4E5F6", "0012AB34", "00CD56EF", "00778899", "00334455"]


def rsid_run(
    rng: random.Random, text: str, bold=False, italic=False, tracked=False
) -> str:
    props = []
    if rng.random() < 0.25:
        props.append('<w:rFonts w:hint="eastAsia"/>')
    if bold:
        props.append("<w:b/><w:bCs/>")
    if italic:
        props.append("<w:i/><w:iCs/>")
    if rng.random() < 0.15:
        props.append('<w:lang w:eastAsia="ja-JP"/>')
    if tracked:
        props.append(
            f'<w:rPrChange w:id="{rng.randrange(100, 100000)}" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"><w:rPr/></w:rPrChange>'
        )
    rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
    lrpb = "<w:lastRenderedPageBreak/>" if rng.random() < 0.01 else ""
    return (
        f'<w:r w:rsidR="{rng.choice(RSIDS)}" w:rsidRPr="{rng.choice(RSIDS)}">{rpr}{lrpb}'
        f'<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'
    )


def split_runs(rng: random.Random, text: str, **fmt) -> str:
    words = text.split(" ")
    pieces = max(1, min(len(words), rng.randint(2, 6)))
    cuts = (
        sorted(rng.sample(range(1, len(words)), pieces - 1))
        if len(words) > pieces
        else []
    )
    out, start = [], 0
    for cut in cuts + [len(words)]:
        chunk = " ".join(words[start:cut]) + (" " if cut < len(words) else "")
        out.append(rsid_run(rng, chunk, tracked=rng.random() < 0.02, **fmt))
        if rng.random() < 0.1 and cut < len(words):
            out.append('<w:proofErr w:type="spellStart"/>')
        start = cut
    return "".join(out)


def rich(rng: random.Random, text: str) -> str:
    if rng.random() < 0.3:
        words = text.split(" ")
        if len(words) > 12:
            a = rng.randrange(1, len(words) - 6)
            b = a + rng.randint(2, 5)
            return (
                split_runs(rng, " ".join(words[:a]) + " ")
                + rsid_run(
                    rng, " ".join(words[a:b]), bold=rng.random() < 0.5, italic=True
                )
                + split_runs(rng, " " + " ".join(words[b:]))
            )
    return split_runs(rng, text)


def body(rng: random.Random, pages: int) -> str:
    ids = g.ParaIds(rng)
    out = [
        g.w_par(
            ids,
            split_runs(rng, "A Field Guide to Everything, Volume " + str(pages)),
            "Title",
        )
    ]
    out.append(
        g.w_par(
            ids, '<w:bookmarkStart w:id="0" w:name="_GoBack"/><w:bookmarkEnd w:id="0"/>'
        )
    )
    words = 0
    chapter = 0
    while words < pages * 480:
        chapter += 1
        out.append(
            g.w_par(
                ids,
                split_runs(
                    rng, f"Chapter {chapter}: " + g.sentence(rng, 3, 7).rstrip(".?;")
                ),
                "Heading1",
            )
        )
        for section in range(rng.randint(3, 5)):
            out.append(
                g.w_par(
                    ids,
                    split_runs(
                        rng,
                        f"{chapter}.{section + 1} "
                        + g.sentence(rng, 3, 8).rstrip(".?;"),
                    ),
                    "Heading2",
                )
            )
            for _ in range(rng.randint(4, 8)):
                text = g.paragraph_text(rng)
                words += len(text.split())
                out.append(g.w_par(ids, rich(rng, text)))
            if rng.random() < 0.25:
                for _ in range(rng.randint(3, 6)):
                    text = g.sentence(rng, 6, 16)
                    words += len(text.split())
                    out.append(
                        g.w_par(ids, split_runs(rng, text), "ListParagraph", num=True)
                    )
    return "".join(out)


if __name__ == "__main__":
    for pages in [int(p) for p in (sys.argv[1:] or ["30"])]:
        rng = random.Random(4242 + pages)
        g.zip_write(OUT / f"book-{pages}p-word.docx", g.docx_package(body(rng, pages)))
