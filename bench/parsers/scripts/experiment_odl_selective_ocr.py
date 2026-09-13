"""Refined ODL plus selective RapidOCR on pages that have no usable text layer.

Two steps, because the lab images split the tools: ``render`` (PyMuPDF image)
lists the text-less pages of the frozen corpus and renders them; ``ocr``
(RapidOCR image) recognises them with the September 8 configuration, merges the
lines into the refined ODL blocks as ordinary text blocks in the page-1000
space, re-runs the frozen chunk packing and stages every source as the
``odl_ocr`` arm for ``odl_agentic_prepare.py index --arms odl_ocr``.

  python experiment_odl_selective_ocr.py render /lab /lab/captioned/odl_ocr
  python experiment_odl_selective_ocr.py ocr /lab /lab/captioned/odl_ocr --models /opt/capy-parser-eval-20260908/models/docling/RapidOcr
  python experiment_odl_selective_ocr.py stage /lab /lab/captioned/odl_ocr   # PyMuPDF image again: chunk packing needs it
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

TEXTLESS_CHARS = 40  # a page with fewer native characters is OCR-routed
MAX_EDGE, THREADS, TEXT_SCORE = 2560, 8, 0.5  # the selected September 8 configuration


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def render(root: Path, out: Path) -> None:
    import pymupdf

    pages = []
    for entry in read(root / "corpus.json"):
        with pymupdf.open(entry["pdf"]) as doc:
            for index, page in enumerate(doc):
                if len(page.get_text().strip()) >= TEXTLESS_CHARS:
                    continue
                scale = MAX_EDGE / max(page.rect.width, page.rect.height)
                pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                path = out / "pages" / f"{entry['id']}-{index}.png"
                path.parent.mkdir(parents=True, exist_ok=True)
                pix.save(path)
                pages.append({
                    "source_id": entry["id"], "page_idx": index, "image": str(path), "image_sha256": sha(path),
                    "size": [pix.width, pix.height], "native_chars": len(page.get_text().strip()),
                })
                print(entry["id"], "page", index + 1, "rendered", pix.width, pix.height, flush=True)
    save(out / "pages.json", {"threshold_chars": TEXTLESS_CHARS, "max_edge": MAX_EDGE, "pages": pages})
    print(len(pages), "text-less pages")


def ocr_lines(reader, image_path: Path):
    import numpy
    from PIL import Image

    with Image.open(image_path) as source:
        image = source.convert("RGB")
        result = reader(numpy.asarray(image))
    if result.boxes is None:
        return []
    return [{"box": box.tolist(), "text": text, "score": float(score)}
            for box, text, score in zip(result.boxes, result.txts, result.scores)]


def line_blocks(lines, size, page_idx):
    """OCR lines as text blocks in the parser's page-1000 top-left space, reading order."""
    width, height = size
    blocks = []
    for line in lines:
        xs, ys = zip(*line["box"])
        blocks.append({
            "type": "text", "text": line["text"], "page_idx": page_idx,
            "bbox": [min(xs) / width * 1000, min(ys) / height * 1000, max(xs) / width * 1000, max(ys) / height * 1000],
            "_recovery": "rapidocr-line", "_ocr_score": line["score"],
        })
    return sorted(blocks, key=lambda b: (round(b["bbox"][1] / 12), b["bbox"][0]))


def merge(blocks, page_idx, new):
    """Insert the OCR blocks after the page's existing blocks, before the next page."""
    last = max((i for i, b in enumerate(blocks) if int(b.get("page_idx", -1)) <= page_idx), default=-1)
    return blocks[: last + 1] + new + blocks[last + 1 :]


def ocr(root: Path, out: Path, models: Path) -> None:
    from rapidocr import RapidOCR

    manifest = read(out / "pages.json")
    params = {
        "Det.model_path": str(models / "PP-OCRv6_det_small.onnx"),
        "Rec.model_path": str(models / "PP-OCRv6_rec_small.onnx"),
        "Cls.model_path": str(models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
        "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
        "EngineConfig.onnxruntime.use_cuda": False,
        "Global.text_score": TEXT_SCORE,
    }
    started = time.perf_counter()
    reader = RapidOCR(params=params)
    load_seconds = time.perf_counter() - started
    by_source: dict[str, list[dict]] = {}
    for page in manifest["pages"]:
        assert sha(page["image"]) == page["image_sha256"]
        t = time.perf_counter()
        lines = ocr_lines(reader, Path(page["image"]))
        page.update(lines=lines, seconds=round(time.perf_counter() - t, 3), chars=sum(len(l["text"]) for l in lines))
        by_source.setdefault(page["source_id"], []).append(page)
        print(page["source_id"], "page", page["page_idx"] + 1, len(lines), "lines", page["chars"], "chars", page["seconds"], "s", flush=True)
    save(out / "ocr.json", {"params": params, "model_load_seconds": load_seconds, "pages": manifest["pages"]})


def stage(root: Path, out: Path) -> None:
    import sys

    sys.path.insert(0, "/lab")
    from odl_agentic_prepare import pack_odl, serialize

    by_source: dict[str, list[dict]] = {}
    for page in read(out / "ocr.json")["pages"]:
        by_source.setdefault(page["source_id"], []).append(page)
    for entry in read(root / "corpus.json"):
        target = out / entry["id"]
        folder = Path(entry["odl"])
        blocks = read(folder / "content_list.json")
        added = 0
        for page in sorted(by_source.get(entry["id"], []), key=lambda p: p["page_idx"]):
            new = line_blocks(page["lines"], page["size"], page["page_idx"])
            blocks = merge(blocks, page["page_idx"], new)
            added += len(new)
        chunks = serialize(pack_odl(blocks, entry))
        if not added:
            assert chunks == read(folder / "chunks.json"), entry["id"]
        save(target / "content_list.json", blocks)
        save(target / "chunks.json", chunks)
        save(target / "complete.json", {
            "id": entry["id"], "arm": "odl_ocr", "selected": 0, "captions": "none", "ocr_pages": len(by_source.get(entry["id"], [])),
            "ocr_blocks": added, "chunks": len(chunks), "input_sha256": sha(folder / "content_list.json"),
            "content_sha256": sha(target / "content_list.json"), "chunks_sha256": sha(target / "chunks.json"),
        })
        print(entry["id"], "staged", len(chunks), "chunks", added, "ocr blocks", flush=True)


def check() -> None:
    blocks = [{"page_idx": 0, "type": "image", "bbox": [0, 0, 1000, 1000]}, {"page_idx": 1, "type": "text", "text": "b", "bbox": [0, 0, 1, 1]}]
    lines = [{"box": [[10, 500], [90, 500], [90, 520], [10, 520]], "text": "second", "score": 0.9},
             {"box": [[10, 10], [90, 10], [90, 30], [10, 30]], "text": "first", "score": 0.9}]
    new = line_blocks(lines, (100, 1000), 0)
    assert [b["text"] for b in new] == ["first", "second"] and new[0]["bbox"] == [100.0, 10.0, 900.0, 30.0], new
    merged = merge(blocks, 0, new)
    assert [b.get("text", b["type"]) for b in merged] == ["image", "first", "second", "b"], merged
    assert merge(blocks, 1, new)[-1]["text"] == "second"
    print("selective ocr checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("render", "ocr", "stage", "check"))
    parser.add_argument("root", nargs="?", type=Path)
    parser.add_argument("out", nargs="?", type=Path)
    parser.add_argument("--models", type=Path)
    args = parser.parse_args()
    if args.mode == "check":
        check()
    elif args.mode == "render":
        render(args.root, args.out)
    elif args.mode == "stage":
        stage(args.root, args.out)
    else:
        ocr(args.root, args.out, args.models)


if __name__ == "__main__":
    main()
