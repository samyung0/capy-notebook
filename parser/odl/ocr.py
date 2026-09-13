"""Selective RapidOCR: pages with almost no native text are rendered and read.

Configuration selected in the September 8 lab runs: PP-OCRv6 small detector and
recogniser, the mobile angle classifier, 2560 px long edge, 8 ONNX threads,
text score 0.5. Blank pages are routed too and simply yield no lines; every
routed page counts as an OCR page for billing.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pymupdf
from PIL import Image

from . import layout

TEXTLESS_CHARS = 40
MAX_EDGE, THREADS, TEXT_SCORE = 2560, 8, 0.5
MODEL_DIR = Path(os.environ.get("CAPY_RAPIDOCR_MODEL_DIR", "/models/rapidocr"))
MODEL_FILES = {
    "Det": "PP-OCRv6_det_small.onnx",
    "Rec": "PP-OCRv6_rec_small.onnx",
    "Cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
}

_reader = None


def textless_pages(document: pymupdf.Document) -> list[int]:
    return [
        page.number
        for page in document
        if len(page.get_text().strip()) < TEXTLESS_CHARS
    ]


def reader():
    """The RapidOCR engine, loaded once per process (about half a second)."""
    global _reader
    if _reader is None:
        from rapidocr import RapidOCR

        params = {
            **{
                f"{kind}.model_path": str(MODEL_DIR / name)
                for kind, name in MODEL_FILES.items()
            },
            "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
            "EngineConfig.onnxruntime.use_cuda": False,
            "Global.text_score": TEXT_SCORE,
        }
        started = time.perf_counter()
        _reader = RapidOCR(params=params)
        print(
            f"rapidocr models loaded in {time.perf_counter() - started:.2f}s",
            flush=True,
        )
    return _reader


def render(page: pymupdf.Page) -> Image.Image:
    scale = MAX_EDGE / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def ocr_lines(image: Image.Image) -> list[dict]:
    import numpy

    result = reader()(numpy.asarray(image.convert("RGB")))
    if result.boxes is None:
        return []
    return [
        {"box": box.tolist(), "text": text, "score": float(score)}
        for box, text, score in zip(result.boxes, result.txts, result.scores)
    ]


def line_blocks(lines: list[dict], size: tuple[int, int], page_idx: int) -> list[dict]:
    """OCR lines as text blocks in the parser's page-1000 top-left space."""
    width, height = size
    blocks = []
    for line in lines:
        xs, ys = zip(*line["box"])
        blocks.append(
            {
                "type": "text",
                "text": line["text"],
                "page_idx": page_idx,
                "bbox": [
                    min(xs) / width * 1000,
                    min(ys) / height * 1000,
                    max(xs) / width * 1000,
                    max(ys) / height * 1000,
                ],
                "_recovery": "rapidocr-line",
                "_ocr_score": line["score"],
            }
        )
    return sorted(blocks, key=lambda b: (round(b["bbox"][1] / 12), b["bbox"][0]))


def merge(blocks: list[dict], page_idx: int, new: list[dict]) -> list[dict]:
    """Insert the OCR blocks after the page's existing blocks, before the next page."""
    last = max(
        (i for i, b in enumerate(blocks) if int(b.get("page_idx", -1)) <= page_idx),
        default=-1,
    )
    return blocks[: last + 1] + new + blocks[last + 1 :]


def add_ocr_text(
    blocks: list[dict], document: pymupdf.Document
) -> tuple[list[dict], list[int]]:
    """Append OCR line blocks for every text-less page; return the routed pages."""
    pages = textless_pages(document)
    for page_idx in pages:
        image = render(document[page_idx])
        new = line_blocks(ocr_lines(image), image.size, page_idx)
        if len(new) > 1:
            new, decision = layout.order_blocks(new, layout.regions(image, MODEL_DIR))
            print(
                f"ocr page={page_idx + 1} lines={len(new)} order={decision}", flush=True
            )
        blocks = merge(blocks, page_idx, new)
    return blocks, pages
