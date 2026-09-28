"""Browser OCR estimate against the parser's textless-page decision.

    # Backend side, with the parser's pinned readers (parser/requirements.txt):
    uv run --no-project --with pymupdf==1.28.2 --with pypdf==6.18.0 \
        python bench/parsers/scripts/ocr_estimate_compare.py backend OUT.json FILE.pdf...
    # Synthetic one-page probes for each suspected disagreement source:
    uv run --no-project --with pymupdf==1.28.2 \
        python bench/parsers/scripts/ocr_estimate_compare.py probes OUT_DIR
    # Browser side: bench/parsers/scripts/ocr_estimate_browser.ts
    # Both together:
    python3 bench/parsers/scripts/ocr_estimate_compare.py report BROWSER.json BACKEND.json

The backend rule is ``parser/odl/ocr.textless_pages``: a page goes to OCR when
``len(page.get_text().strip()) < 40``. The parser applies it to the PDF after
``parser/odl/fonts.repair_fonts``; the admission count in ``parser/app.py``
applies it to the uploaded bytes. Both are measured here.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

TEXTLESS_CHARS = 40  # parser/odl/ocr.py and sourceAnalysisCore.ts
SNIPPET_CHARS = 160
NEAR = range(20, 80)  # "near the threshold" in the report

# Office sources and the LibreOffice PDF the parser read for them (made by the
# 2026-09-09 corpus preparation with the then-current normalize_document).
OFFICE_PDFS = {
    "office-canary.docx": "office-canary__docx.pdf",
    "office-canary.pptx": "office-canary__pptx.pdf",
    "office-canary.xlsx": "office-canary__xlsx.pdf",
    "jp_llm2.pptx": "rag__ja__jp_llm2.pdf",
    "zh_TW_llm.pptx": "rag__zh__zh_TW_llm.pdf",
}


def page_counts(document) -> list[dict]:
    pages = []
    for page in document:
        text = page.get_text().strip()
        entry = {"chars": len(text), "nonSpace": len(re.sub(r"\s", "", text))}
        if len(text) < SNIPPET_CHARS:
            entry["text"] = text
        pages.append(entry)
    return pages


def backend(output: Path, files: list[Path]) -> None:
    import pymupdf

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "parser"))
    from odl import fonts

    pymupdf.TOOLS.mupdf_display_errors(False)
    results = {}
    for file in files:
        data = file.read_bytes()
        started = time.perf_counter()
        try:
            with pymupdf.open(stream=data, filetype="pdf") as document:
                original = page_counts(document)
            repaired_bytes, repaired_fonts = fonts.repair_fonts(data)
            if repaired_fonts:
                with pymupdf.open(stream=repaired_bytes, filetype="pdf") as document:
                    repaired = page_counts(document)
            else:
                repaired = original
        except Exception as error:  # noqa: BLE001 - recorded per document
            results[file.name] = {"error": f"{type(error).__name__}: {error}"}
            continue
        results[file.name] = {
            "bytes": len(data),
            "elapsedMs": round((time.perf_counter() - started) * 1000),
            "original": original,
            "repaired": repaired,
            "repairedFonts": repaired_fonts,
        }
        print(file.name, len(original), repaired_fonts, file=sys.stderr, flush=True)
    output.write_text(json.dumps(results, ensure_ascii=False))


def probes(output: Path) -> None:
    """One synthetic PDF per suspected disagreement source, one page each."""
    import pymupdf

    sample = "The quick brown fox jumps over the lazy dog again"  # 49 chars
    output.mkdir(parents=True, exist_ok=True)

    def page(name: str, draw, **page_args) -> None:
        with pymupdf.open() as document:
            p = document.new_page(**page_args)
            draw(p)
            document.save(output / f"probe-{name}.pdf")

    page("39-chars", lambda p: p.insert_text((72, 100), sample[:39]))
    page("40-chars", lambda p: p.insert_text((72, 100), sample[:39] + "!"))
    # 24 one-letter labels, each its own text object: pdf.js gives 24 items.
    page(
        "split-labels",
        lambda p: [
            p.insert_text((40 + 22 * i, 300), "ABCDEFGHIJKLMNOPQRSTUVWX"[i])
            for i in range(24)
        ],
    )
    # 12 short labels stacked vertically: separators become newlines.
    page(
        "axis-labels",
        lambda p: [p.insert_text((72, 100 + 30 * i), f"{i * 10}") for i in range(12)],
    )
    page("outside-mediabox", lambda p: p.insert_text((72, -20), sample))

    def cropped(p) -> None:
        p.insert_text((72, 700), sample)
        p.set_cropbox(pymupdf.Rect(0, 0, 595, 400))

    page("outside-cropbox", cropped)
    page("invisible", lambda p: p.insert_text((72, 100), sample, render_mode=3))
    page("white", lambda p: p.insert_text((72, 100), sample, color=(1, 1, 1)))
    page("tiny", lambda p: p.insert_text((72, 100), sample, fontsize=0.5))

    def covered(p) -> None:
        p.insert_text((72, 100), sample)
        p.draw_rect(pymupdf.Rect(60, 80, 500, 110), color=None, fill=(1, 1, 1))

    page("covered", covered)
    # 45 CJK characters in PyMuPDF's non-embedded CJK font (predefined CMap).
    page(
        "cjk-cmap",
        lambda p: p.insert_text((72, 100), "文字識別" * 11 + "文", fontname="china-t"),
    )
    page(
        "rotated",
        lambda p: (p.insert_text((72, 100), sample), p.set_rotation(90)),
    )
    # A user password blocks both readers; an owner password alone blocks neither.
    for name, user_pw in (("encrypted-user", "secret"), ("encrypted-owner", "")):
        with pymupdf.open() as document:
            document.new_page().insert_text((72, 100), sample)
            document.save(
                output / f"probe-{name}.pdf",
                encryption=pymupdf.PDF_ENCRYPT_AES_256,
                owner_pw="owner",
                user_pw=user_pw,
                permissions=0,
            )


def textless(pages: list[dict]) -> list[bool]:
    return [page["chars"] < TEXTLESS_CHARS for page in pages]


def compare(browser: list[dict], backend: list[dict]) -> dict:
    """Page-level agreement of the browser flag against a backend page list."""
    b_flags = [page["needsOcr"] for page in browser]
    s_flags = textless(backend)
    shared = min(len(b_flags), len(s_flags))
    pairs = list(zip(b_flags[:shared], s_flags[:shared]))
    return {
        "both_ocr": sum(b and s for b, s in pairs),
        "both_text": sum(not b and not s for b, s in pairs),
        "browser_only": [i + 1 for i, (b, s) in enumerate(pairs) if b and not s],
        "backend_only": [i + 1 for i, (b, s) in enumerate(pairs) if s and not b],
        "near": sum(
            browser[i]["chars"] in NEAR or backend[i]["chars"] in NEAR
            for i in range(shared)
        ),
        "browser_ocr": sum(b_flags),
        "backend_ocr": sum(s_flags),
        "browser_pages": len(b_flags),
        "backend_pages": len(s_flags),
    }


def report(browser_path: Path, backend_path: Path) -> None:
    browser = json.loads(browser_path.read_text())
    backend_runs = json.loads(backend_path.read_text())
    rows, details, totals = [], [], {"pdf": {}, "office": {}}
    for name, b in sorted(browser.items()):
        pdf_name = OFFICE_PDFS.get(name, name)
        s = backend_runs.get(pdf_name)
        if s is None or "error" in b or "error" in s:
            rows.append(
                f"| {name} | error: {b.get('error') or (s or {}).get('error') or 'no backend run'} |"
            )
            continue
        final = compare(b["pages"], s["repaired"])
        admission = compare(b["pages"], s["original"])
        repair_flips = sum(
            x != y for x, y in zip(textless(s["original"]), textless(s["repaired"]))
        )
        total = totals["office" if name in OFFICE_PDFS else "pdf"]
        add = {
            **{
                k: final[k]
                for k in ("both_ocr", "both_text", "browser_ocr", "backend_ocr", "near")
            },
            "browser_only": len(final["browser_only"]),
            "backend_only": len(final["backend_only"]),
            "documents": 1,
            "pages": final["backend_pages"],
            "admission_ocr": admission["backend_ocr"],
            "repair_flips": repair_flips,
        }
        for key, value in add.items():
            total[key] = total.get(key, 0) + value
        budget = b.get("budgetError")
        rows.append(
            "| {name} | {bp}/{sp} | {bo} | {ao} | {so} | {both_ocr} | {both_text} | {bonly} | {sonly} | {near} | {fonts}/{flips} | {budget} |".format(
                name=name,
                bp=final["browser_pages"],
                sp=final["backend_pages"],
                bo=final["browser_ocr"],
                ao=admission["backend_ocr"],
                so=final["backend_ocr"],
                both_ocr=final["both_ocr"],
                both_text=final["both_text"],
                bonly=len(final["browser_only"]),
                sonly=len(final["backend_only"]),
                near=final["near"],
                fonts=s["repairedFonts"],
                flips=repair_flips,
                budget=f"p{budget['page']}: {budget['message']}" if budget else "",
            )
        )
        if name.endswith(".pdf"):
            shown = final["browser_only"] + final["backend_only"]
            if name.startswith("probe-"):  # every probe page, agreeing or not
                shown = range(1, final["backend_pages"] + 1)
            for page in shown:
                bp, sp = b["pages"][page - 1], s["repaired"][page - 1]
                details.append(
                    f"| {name} | {page} | {bp['chars']} ({bp['nonSpace']}) | "
                    f"{sp['chars']} ({sp['nonSpace']}) | "
                    f"{json.dumps(bp.get('text', '')[:60], ensure_ascii=False)} | "
                    f"{json.dumps(sp.get('text', '')[:60], ensure_ascii=False)} |"
                )
    print(
        "| Document | Pages browser/backend | Browser OCR | Admission OCR (original) | Parser OCR (repaired) "
        "| Both OCR | Both text | Browser-only | Backend-only | Near 20-79 | Fonts repaired/flips | Browser budget stop |"
    )
    print("|" + "---|" * 12)
    print("\n".join(rows))
    print()
    for kind, total in totals.items():
        print(f"Totals {kind}:", json.dumps(total))
    print()
    print(
        "| Document | Page | Browser chars (non-space) | Parser chars (non-space) | Browser text | Parser text |"
    )
    print("|---|---|---|---|---|---|")
    print("\n".join(details))


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    if command == "backend":
        backend(Path(args[0]), [Path(arg) for arg in args[1:]])
    elif command == "report":
        report(Path(args[0]), Path(args[1]))
    elif command == "probes":
        probes(Path(args[0]))
    else:
        raise SystemExit(__doc__)
