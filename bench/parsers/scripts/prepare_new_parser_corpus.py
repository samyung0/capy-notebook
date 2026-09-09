"""Fetch publisher PDFs and prepare a source-bound, explicitly selected corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
import urllib.request
from pathlib import Path

from prepare_opendataloader_corpus import page_reference, raster_pdf, selected_pdf


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def fetch(manifest: Path, root: Path) -> None:
    inputs = root / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    receipts = []
    for source in json.loads(manifest.read_text())["sources"]:
        target = inputs / (source["id"] + ".pdf")
        receipt = {"id": source["id"], "url": source["url"]}
        if target.exists():
            raise ValueError(f"source already exists: {target}")
        started = time.monotonic()
        try:
            request = urllib.request.Request(
                source["url"], headers={"User-Agent": "CapyParserResearch/1.0"}
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(100_000_001)
                if len(data) > 100_000_000 or not data.startswith(b"%PDF-"):
                    raise ValueError("source is not a PDF within the 100 MB limit")
                target.write_bytes(data)
                receipt.update(
                    state="ok",
                    resolved_url=response.url,
                    source_sha256=sha(target),
                    bytes=len(data),
                    retrieved_unix=time.time(),
                )
        except Exception as exc:  # noqa: BLE001 - preserve failed download attempts
            receipt.update(state="error", error_type=type(exc).__name__)
        receipt["seconds"] = time.monotonic() - started
        receipts.append(receipt)
        save(root / "download-receipts.json", receipts)
        print(json.dumps(receipt), flush=True)


def prepare(manifest: Path, root: Path) -> None:
    import pymupdf

    manifest_bytes = manifest.read_bytes()
    sources = json.loads(manifest_bytes)["sources"]
    if len({s["id"] for s in sources}) != len(sources):
        raise ValueError("duplicate source identities")
    prepared = root / "prepared"
    prepared.mkdir(exist_ok=False)
    images = root / "source-pages"
    images.mkdir(exist_ok=False)
    entries, jobs = [], []
    for source in sources:
        path = root / "inputs" / (source["id"] + ".pdf")
        if sha(path) != source["sha256"]:
            raise ValueError("source hash changed")
        original = prepared / path.name
        shutil.copyfile(path, original)
        if sha(original) != source["sha256"]:
            raise ValueError("source changed while copying")
        reference = page_reference(original)
        pages = [p - 1 for p in source["screen_pages"]]
        if not pages or len(set(pages)) != len(pages):
            raise ValueError("empty or duplicate selected pages")
        if min(pages) < 0 or max(pages) >= len(reference):
            raise ValueError("selected source page is out of range")
        full = {
            "id": source["id"],
            "source": path.name,
            "source_sha256": source["sha256"],
            "pdf": str(original.relative_to(root)),
            "pdf_sha256": sha(original),
            "pages": len(reference),
            "source_pages": list(range(len(reference))),
            "lang": source["lang"],
            "kind": source["kind"],
            "suite": "full",
            "role": source["role"],
        }
        entries.append(full)
        save(prepared / (full["id"] + ".reference.json"), reference)
        screen = {**full, "id": "screen__" + full["id"], "parent": full["id"]}
        screen_path = prepared / (screen["id"] + ".pdf")
        selected_pdf(original, screen_path, pages)
        screen.update(
            pdf=str(screen_path.relative_to(root)),
            pdf_sha256=sha(screen_path),
            pages=len(pages),
            source_pages=pages,
            suite="screen",
        )
        entries.append(screen)
        save(
            prepared / (screen["id"] + ".reference.json"), [reference[p] for p in pages]
        )
        with pymupdf.open(screen_path) as doc:
            for index, page in enumerate(doc):
                identity = f"context-{screen['id']}-p{index + 1}"
                image = images / (identity + ".png")
                scale = 2560 / max(page.rect.width, page.rect.height)
                page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).save(
                    image
                )
                jobs.append(
                    {
                        "id": identity,
                        "kind": "page",
                        "case": screen["id"],
                        "page": index,
                        "source_page": pages[index],
                        "lang": source["lang"],
                        "image": str(image.resolve()),
                        "image_sha256": sha(image),
                        "pdf_sha256": screen["pdf_sha256"],
                        "bbox": [0, 0, 1000, 1000],
                        "role": source["role"],
                    }
                )
        if source["raster_pages"]:
            indices = [p - 1 for p in source["raster_pages"]]
            if not set(indices) <= set(pages):
                raise ValueError("raster controls must be selected source pages")
            raster = {**screen, "id": "raster__" + full["id"]}
            raster_path = prepared / (raster["id"] + ".pdf")
            raster_pdf(original, raster_path, indices)
            raster.update(
                pdf=str(raster_path.relative_to(root)),
                pdf_sha256=sha(raster_path),
                pages=len(indices),
                source_pages=indices,
                kind="controlled_raster",
                raster={"dpi": 150, "jpeg_quality": 85, "blur_radius": 0.25},
            )
            entries.append(raster)
            save(
                prepared / (raster["id"] + ".reference.json"),
                [reference[p] for p in indices],
            )
        print(source["id"], len(reference), pages, flush=True)
    save(
        root / "corpus.json",
        {
            "entries": entries,
            "source_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        },
    )
    save(root / "source-page-jobs.json", {"jobs": jobs})
    (root / "source-manifest.json").write_bytes(manifest_bytes)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["fetch", "prepare"])
    parser.add_argument("manifest", type=Path)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    (fetch if args.command == "fetch" else prepare)(args.manifest, args.root)


if __name__ == "__main__":
    main()
