"""Conservative OCR region ordering with the frozen PP-DocLayoutV3 model.

Every line must map to a region. Otherwise the whole page keeps its original
order; partial reordering displaced titles and authors in the source checks.
The model orders regions; the existing OCR order stays intact inside each one.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

_reader = None


def regions(image: Image.Image, model_dir: Path) -> list[list[float]]:
    global _reader
    if _reader is None:
        from rapid_layout import ModelType, RapidLayout

        model = model_dir / "pp_doc_layoutv3.onnx"
        if not model.is_file():
            raise FileNotFoundError(f"OCR layout model missing: {model}")
        _reader = RapidLayout(
            model_type=ModelType.PP_DOC_LAYOUTV3,
            model_dir_or_path=model,
            engine_type="onnxruntime",
            engine_cfg={"intra_op_num_threads": 4, "inter_op_num_threads": 1},
            conf_thresh=0.5,
            iou_thresh=0.5,
        )
    import numpy

    result = _reader(numpy.asarray(image.convert("RGB")))
    if result.boxes is None:
        return []
    width, height = image.size
    return [
        [float(v) * 1000 / (width if i % 2 == 0 else height) for i, v in enumerate(box)]
        for box in result.boxes
    ]


def _area(box: list[float]) -> float:
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def order_blocks(
    blocks: list[dict], boxes: list[list[float]]
) -> tuple[list[dict], str]:
    """Return only a permutation, with an explicit reason for abstention."""
    if not boxes:
        return blocks, "no-regions"
    for box in [b.get("bbox") for b in blocks] + boxes:
        if (
            not isinstance(box, (list, tuple))
            or len(box) != 4
            or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in box)
            or _area(box) <= 0
        ):
            return blocks, "invalid-geometry"
    assignments = []
    for block in blocks:
        box = block["bbox"]
        matches = [
            i
            for i, r in enumerate(boxes)
            if _area(
                [
                    max(box[0], r[0]),
                    max(box[1], r[1]),
                    min(box[2], r[2]),
                    min(box[3], r[3]),
                ]
            )
            / _area(box)
            >= 0.5
        ]
        if not matches:
            return blocks, "unmapped-line"
        if len(matches) != 1:
            return blocks, "ambiguous-regions"
        assignments.append(matches[0])
    indices = sorted(range(len(blocks)), key=lambda i: (assignments[i], i))
    return [blocks[i] for i in indices], "layout"
