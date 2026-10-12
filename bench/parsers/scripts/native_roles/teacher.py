"""Run one teacher detector over every selected page; boxes are stored in PDF points.

usage: teacher.py v3|egret [threads]
Needs NATIVE_ROLES_MODELS (directory holding pp_doc_layoutv3.onnx) for v3 and a
Hugging Face cache with docling-project/docling-layout-egret-medium (HF_HOME,
HF_HUB_OFFLINE=1) for egret. Resumable: pages already in the output are skipped.
Writes OUT/teacher/<model>.jsonl lines {"page": "<book>/<n>", "boxes": [[label, score, x0, y0, x1, y1]], "ms": t}.
"""

import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pymupdf

from common import OUT, book_pdf, selected_pages


def teacher_order():
    """Test pages first, then training pages round-robin over books, so a run cut short
    still leaves every training book with the same number of labelled pages."""
    test = selected_pages(("heldout", "review"))
    by_book = {}
    for book, p in selected_pages(("train",)):
        by_book.setdefault(book, []).append(p)
    rr = [(b, ps[i]) for i in range(max(map(len, by_book.values()))) for b, ps in by_book.items() if i < len(ps)]
    return test + [x for x in rr if x not in set(test)]


DPI = 110
SCALE = DPI / 72


def v3(threads):
    from rapid_layout import RapidLayout

    eng = RapidLayout(model_type="pp_doc_layoutv3",
                      model_dir_or_path=str(Path(os.environ["NATIVE_ROLES_MODELS"]) / "pp_doc_layoutv3.onnx"),
                      engine_type="onnxruntime",
                      engine_cfg={"intra_op_num_threads": threads, "inter_op_num_threads": 1},
                      conf_thresh=0.4, iou_thresh=0.5)

    def run(bgr):
        r = eng(bgr)
        if r.boxes is None:
            return []
        return [[c, float(s), *map(float, b)] for b, c, s in zip(r.boxes, r.class_names, r.scores)]

    return run


def egret(threads):
    import torch
    from transformers import AutoImageProcessor, AutoModelForObjectDetection

    torch.set_num_threads(threads)
    repo = "docling-project/docling-layout-egret-medium"
    proc = AutoImageProcessor.from_pretrained(repo)
    model = AutoModelForObjectDetection.from_pretrained(repo).eval()
    names = model.config.id2label

    def run(bgr):
        inputs = proc(images=bgr[:, :, ::-1], return_tensors="pt")
        with torch.inference_mode():
            out = model(**inputs)
        res = proc.post_process_object_detection(out, target_sizes=torch.tensor([bgr.shape[:2]]), threshold=0.4)[0]
        return [[names[int(l)].lower().replace("-", "_"), float(s), *map(float, b)]
                for s, l, b in zip(res["scores"], res["labels"], res["boxes"])]

    return run


if __name__ == "__main__":
    model = sys.argv[1]
    threads = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    run = {"v3": v3, "egret": egret}[model](threads)
    path = OUT / "teacher" / f"{model}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    done = {json.loads(l)["page"] for l in path.open()} if path.exists() else set()
    # Egret follows V3: only pages V3 has labelled (V3 may be stopped early).
    only = {json.loads(l)["page"] for l in (OUT / "teacher/v3.jsonl").open()} if model == "egret" else None
    docs = {}
    with path.open("a") as f:
        for book, p in teacher_order():
            key = f"{book}/{p}"
            if key in done or (only is not None and key not in only):
                continue
            doc = docs.setdefault(book, pymupdf.open(book_pdf(book)))
            pix = doc[p].get_pixmap(dpi=DPI)
            img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3][:, :, ::-1].copy()
            t = time.perf_counter()
            boxes = run(img)
            ms = (time.perf_counter() - t) * 1000
            boxes = [[c, round(s, 3), *(round(v / SCALE, 2) for v in b)] for c, s, *b in boxes]
            f.write(json.dumps({"page": key, "boxes": boxes, "ms": round(ms)}) + "\n")
            f.flush()
