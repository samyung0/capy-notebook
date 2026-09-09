"""Freeze existing Capy inputs and small, explicitly derived parser controls.

Run inside the benchmark image with /eval mounted. No input is overwritten.
The source manifest records hashes, PDF page mappings, and raster parameters.
Native PDF text is a diagnostic reference, never a universal ground truth.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

import pypdfium2 as pdfium
from PIL import ImageFilter
from pypdf import PdfReader, PdfWriter


def digest(path: Path) -> str:
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def selected_pdf(source: Path, target: Path, indices: list[int]) -> None:
    reader = PdfReader(source)
    writer = PdfWriter()
    for index in indices:
        writer.add_page(reader.pages[index])
    with target.open("wb") as stream:
        writer.write(stream)


def raster_pdf(source: Path, target: Path, indices: list[int]) -> None:
    document = pdfium.PdfDocument(source)
    images = []
    for index in indices:
        page = document[index]
        bitmap = page.render(scale=150 / 72)
        image = bitmap.to_pil().convert("RGB")
        # All raster controls use the same modest scan degradation.
        image = image.filter(ImageFilter.GaussianBlur(0.25))
        jpeg = io.BytesIO()
        image.save(jpeg, format="JPEG", quality=85)
        from PIL import Image

        images.append(Image.open(io.BytesIO(jpeg.getvalue())).convert("RGB"))
        bitmap.close()
        page.close()
    images[0].save(
        target, format="PDF", save_all=True, append_images=images[1:], resolution=150
    )
    document.close()


def page_reference(path: Path) -> list[dict]:
    document = pdfium.PdfDocument(path)
    pages = []
    for index in range(len(document)):
        page = document[index]
        textpage = page.get_textpage()
        pages.append(
            {
                "page": index,
                "width": page.get_width(),
                "height": page.get_height(),
                "native_text": textpage.get_text_range(),
            }
        )
        textpage.close()
        page.close()
    document.close()
    return pages


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    root = args.root
    inputs = root / "inputs"
    prepared = root / "prepared"
    prepared.mkdir(exist_ok=True)
    if (root / "corpus.json").exists():
        raise SystemExit("corpus.json already exists; use a new experiment directory")

    from mineru_worker import normalize_document

    sources = sorted((inputs / "rag").rglob("*.pdf"))
    sources += sorted((inputs / "rag").rglob("*.pptx"))
    sources += sorted(inputs.glob("office-canary.*"))
    sources += [
        inputs / "lecture_deck.pdf",
        inputs / "lecture_plus_scan.pdf",
        inputs / "biology-accuracy-sample.pdf",
        inputs / "Biology_for_the_IB_Diploma.pdf",
    ]
    entries = []
    for source in sources:
        relative = source.relative_to(inputs)
        identity = str(relative.with_suffix("")).replace("/", "__")
        if source.stem == "office-canary":
            identity += "__" + source.suffix.lstrip(".")
        target = prepared / f"{identity}.pdf"
        normalized = normalize_document(source.read_bytes(), source.name)
        target.write_bytes(normalized.data)
        reference = page_reference(target)
        (prepared / f"{identity}.reference.json").write_text(
            json.dumps(reference, ensure_ascii=False), encoding="utf-8"
        )
        entry = {
            "id": identity,
            "source": str(relative),
            "source_sha256": digest(source),
            "pdf": str(target.relative_to(root)),
            "pdf_sha256": digest(target),
            "pages": len(reference),
            "source_pages": list(range(len(reference))),
            "lang": relative.parts[1] if relative.parts[0] == "rag" else "en",
            "kind": "native_or_mixed",
            "suite": "long" if len(reference) > 500 else "full",
        }
        entries.append(entry)
        print(identity, len(reference), flush=True)

        if entry["suite"] == "long":
            continue
        if "office-canary" in identity or "newspaper_scan" in identity:
            indices = list(range(len(reference)))
        elif identity == "biology-accuracy-sample":
            indices = [0, 2, 4, 7, 8, 10, 12, 15]
        elif identity == "lecture_plus_scan":
            indices = [0, 40, 41]
        else:
            indices = sorted({min(1, len(reference) - 1), len(reference) // 2})

        screen_id = f"screen__{identity}"
        screen_path = prepared / f"{screen_id}.pdf"
        selected_pdf(target, screen_path, indices)
        screen_entry = {
            **entry,
            "id": screen_id,
            "parent": identity,
            "pdf": str(screen_path.relative_to(root)),
            "pdf_sha256": digest(screen_path),
            "pages": len(indices),
            "source_pages": indices,
            "suite": "screen",
        }
        entries.append(screen_entry)
        (prepared / f"{screen_id}.reference.json").write_text(
            json.dumps([reference[i] for i in indices], ensure_ascii=False),
            encoding="utf-8",
        )

        # Matched native/raster pair for one real input per language plus biology.
        raster_sources = {
            "rag__de__grosse-sprachmodelle",
            "rag__es__sesgo-linguistico-digital",
            "rag__fr__camembert-taln",
            "rag__ja__jp_llm",
            "rag__zh__zh-CN",
            "rag__zh__zh_HK",
            "rag__zh__zh_TW_llm",
            "rag__en__biology-ib-chapter-1",
        }
        if identity in raster_sources:
            raster_id = f"raster__{identity}"
            raster_path = prepared / f"{raster_id}.pdf"
            raster_pdf(target, raster_path, indices)
            entries.append(
                {
                    **screen_entry,
                    "id": raster_id,
                    "pdf": str(raster_path.relative_to(root)),
                    "pdf_sha256": digest(raster_path),
                    "kind": "controlled_raster",
                    "raster": {"dpi": 150, "jpeg_quality": 85, "blur_radius": 0.25},
                }
            )
            (prepared / f"{raster_id}.reference.json").write_text(
                json.dumps([reference[i] for i in indices], ensure_ascii=False),
                encoding="utf-8",
            )

    (root / "corpus.json").write_text(
        json.dumps({"entries": entries}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
