"""Run one document layout model over the extraction bench's gold pages and
record every region it finds, with its timings.

Runs inside the throwaway bench container (``layout_host.sh``), one model per
process so its memory is its own:

    python layout_detect.py render --pdfs /work/data --gold /work/gold \
        --pages /work/pages
    python layout_detect.py render --pdfs /work/digital \
        --digital /work/digital/figures.json --pages /work/pages-digital
    python layout_detect.py detect --backend pp-onnx --model PP-DocLayout_plus-L \
        --path /work/models/PP-DocLayout_plus-L_onnx --pages /work/pages \
        --out /work/out/pp-plus-l-onnx.json

``render`` draws each gold page (or each born-digital figure's page) as the
extraction windows see it: the production capture renderer's whole page, long
side 1,568 px (``CAPY_CAPTURE_MAX_EDGE``), JPEG quality 80. ``detect`` loads
the model,
then runs it on every page image in name order, recording each page's wall
and process CPU time (all threads) for preprocessing, inference and
postprocessing; the JPEG decode is outside the timing. Regions are kept down
to a score of 0.3 so the scorer can try thresholds; boxes are written on the
0-1000 page grid the gold boxes use.

Backends:
- ``pp-onnx``: PaddlePaddle's own ONNX exports (``PaddlePaddle/<model>_onnx``)
  under onnxruntime, with the preprocessing in their ``inference.yml``.
- ``heron-onnx``: ``docling-project/docling-layout-heron-onnx`` under
  onnxruntime; its graph holds the scaling and post-processing.
- ``paddle``: PaddleOCR 3.x ``LayoutDetection`` on the Paddle framework.
- ``torch``: a Docling layout model (Heron) through transformers on torch.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import resource
import statistics
import time
from pathlib import Path

PAGE_EDGE = 1568
JPEG_QUALITY = 80
SCORE_FLOOR = 0.3


def render(pdfs: Path, gold: Path | None, digital: Path | None, out: Path) -> None:
    """The gold files' pages from ``pdfs/<pdf>``, or the born-digital
    figures' pages from ``pdfs/<paper>/paper.pdf``."""
    import pymupdf
    from PIL import Image

    pages: list[tuple[str, Path, int]] = []
    for path in sorted(gold.glob("*.json")) if gold else []:
        paper = json.loads(path.read_text())
        pages += [(paper["paper"], pdfs / paper["pdf"], n) for n in paper["pages"]]
    if digital:
        figures = json.loads(digital.read_text())["figures"]
        pages += sorted(
            {(f["paper"], pdfs / f["paper"] / "paper.pdf", f["page"]) for f in figures}
        )
    out.mkdir(parents=True, exist_ok=True)
    for paper, pdf, number in pages:
        with pymupdf.open(pdf) as doc:
            page = doc[number - 1]
            scale = PAGE_EDGE / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        image.save(out / f"{paper}-p{number:02d}.jpg", "JPEG", quality=JPEG_QUALITY)
        print(f"{paper} p{number}: {pix.width}x{pix.height}")


def rss_mb() -> float:
    # Linux reports kilobytes.
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)


def loadavg() -> list[float]:
    # Not namespaced: the host's load, which the shared ingest containers share.
    return [float(v) for v in Path("/proc/loadavg").read_text().split()[:3]]


# ------------------------------------------------------------------ backends


class PaddleOnnx:
    """A PaddlePaddle ``*_onnx`` export: resize to the model's square input
    without keeping the ratio, scale to 0-1 (``norm_type: none``) or
    mean/std, channels first. The graph returns [class, score, x0, y0, x1,
    y1, ...] rows in the original image's pixels."""

    def __init__(self, path: Path, threads: int, spin: bool = True):
        import onnxruntime as ort
        import yaml

        spec = yaml.safe_load((path / "inference.yml").read_text())
        self.labels = spec["label_list"]
        steps = {step["type"]: step for step in spec["Preprocess"]}
        self.size = steps["Resize"]["target_size"]  # [height, width]
        norm = steps["NormalizeImage"]
        self.mean_std = (
            None if norm.get("norm_type") == "none" else (norm["mean"], norm["std"])
        )
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        if not spin:
            # Waiting threads sleep instead of holding a core.
            options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.session = ort.InferenceSession(
            str(path / "inference.onnx"),
            options,
            providers=["CPUExecutionProvider"],
        )
        self.inputs = [i.name for i in self.session.get_inputs()]

    def __call__(self, image) -> list[dict]:
        import numpy as np
        from PIL import Image

        width, height = image.size
        th, tw = self.size
        pixels = np.asarray(
            image.resize((tw, th), Image.Resampling.BICUBIC), dtype=np.float32
        )
        pixels /= 255.0
        if self.mean_std:
            mean, std = self.mean_std
            pixels = (pixels - np.array(mean, np.float32)) / np.array(std, np.float32)
        feed = {
            "image": pixels.transpose(2, 0, 1)[None],
            "im_shape": np.array([[th, tw]], np.float32),
            "scale_factor": np.array([[th / height, tw / width]], np.float32),
        }
        rows = self.session.run(None, {k: feed[k] for k in self.inputs})[0]
        return [
            {
                "label": self.labels[int(row[0])],
                "score": float(row[1]),
                "px": [float(v) for v in row[2:6]],
            }
            for row in rows
            if row[1] >= SCORE_FLOOR and int(row[0]) >= 0
        ]


class HeronOnnx:
    """docling-layout-heron's ONNX export: RT-DETRv2 with its scaling and
    post-processing inside the graph. It takes the page resized to 640x640
    (bilinear, as the model's image processor) as uint8 and the original
    [width, height], and returns 300 (label, box in original pixels, score)."""

    def __init__(self, path: Path, threads: int):
        import onnxruntime as ort

        config = json.loads((path / "config.json").read_text())
        self.labels = {int(k): v for k, v in config["id2label"].items()}
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(path / "model.onnx"), options, providers=["CPUExecutionProvider"]
        )

    def __call__(self, image) -> list[dict]:
        import numpy as np
        from PIL import Image

        width, height = image.size
        pixels = np.asarray(image.resize((640, 640), Image.Resampling.BILINEAR))
        labels, boxes, scores = self.session.run(
            ["labels", "boxes", "scores"],
            {
                "images": np.ascontiguousarray(pixels.transpose(2, 0, 1)[None]),
                "orig_target_sizes": np.array([[width, height]], np.int64),
            },
        )
        return [
            {
                "label": self.labels[int(label)],
                "score": float(score),
                "px": [float(v) for v in box],
            }
            for label, box, score in zip(labels[0], boxes[0], scores[0])
            if score >= SCORE_FLOOR
        ]


class PaddleNative:
    """PaddleOCR 3.x ``LayoutDetection`` with its own defaults (MKL-DNN on);
    it reads a numpy array as BGR."""

    def __init__(self, name: str, path: Path | None, threads: int):
        from paddleocr import LayoutDetection

        self.model = LayoutDetection(
            model_name=name,
            model_dir=str(path) if path else None,
            device="cpu",
            cpu_threads=threads,
        )

    def __call__(self, image) -> list[dict]:
        import numpy as np

        bgr = np.ascontiguousarray(np.asarray(image)[:, :, ::-1])
        (result,) = list(self.model.predict(bgr, batch_size=1, threshold=SCORE_FLOOR))
        return [
            {
                "label": box["label"],
                "score": float(box["score"]),
                "px": [float(v) for v in box["coordinate"]],
            }
            for box in result["boxes"]
        ]


class Transformers:
    """A Docling layout model through transformers on torch, as its model
    card runs it: ``RTDetrImageProcessor`` (640x640 bilinear, scaled to 0-1)
    and ``post_process_object_detection``. docling-ibm-models 4.x no longer
    ships a layout predictor."""

    def __init__(self, path: Path, threads: int):
        import torch
        from transformers import AutoModelForObjectDetection, RTDetrImageProcessor

        torch.set_num_threads(threads)
        self.torch = torch
        self.processor = RTDetrImageProcessor.from_pretrained(str(path))
        self.model = AutoModelForObjectDetection.from_pretrained(str(path)).eval()
        self.labels = self.model.config.id2label

    def __call__(self, image) -> list[dict]:
        inputs = self.processor(images=[image], return_tensors="pt")
        with self.torch.inference_mode():
            outputs = self.model(**inputs)
        (result,) = self.processor.post_process_object_detection(
            outputs,
            target_sizes=self.torch.tensor([image.size[::-1]]),
            threshold=SCORE_FLOOR,
        )
        return [
            {
                "label": self.labels[int(label)].lower().replace("-", "_"),
                "score": float(score),
                "px": [float(v) for v in box],
            }
            for score, label, box in zip(
                result["scores"], result["labels"], result["boxes"]
            )
        ]


PACKAGES = {
    "pp-onnx": ["onnxruntime", "numpy", "pillow", "pyyaml"],
    "heron-onnx": ["onnxruntime", "numpy", "pillow"],
    "paddle": [
        "paddlepaddle",
        "paddleocr",
        "paddlex",
        "numpy",
        "opencv-contrib-python",
    ],
    "torch": ["torch", "transformers", "numpy", "pillow"],
}


def versions(backend: str) -> dict[str, str]:
    out = {}
    for name in PACKAGES[backend]:
        try:
            out[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pass
    return out


def detect(args) -> None:
    from PIL import Image

    record: dict = {
        "model": args.model,
        "backend": args.backend,
        "threads": args.threads,
        "platform": platform.platform(),
        "versions": versions(args.backend),
        "loadavg_before": loadavg(),
        "rss_mb": {"imports": rss_mb()},
    }
    wall, cpu = time.perf_counter(), time.process_time()
    path = Path(args.path) if args.path else None
    if args.backend == "pp-onnx":
        model = PaddleOnnx(path, args.threads)
    elif args.backend == "heron-onnx":
        model = HeronOnnx(path, args.threads)
    elif args.backend == "paddle":
        model = PaddleNative(args.model, path, args.threads)
    else:
        model = Transformers(path, args.threads)
    record["load"] = {
        "wall_s": round(time.perf_counter() - wall, 3),
        "cpu_s": round(time.process_time() - cpu, 3),
    }
    record["rss_mb"]["loaded"] = rss_mb()
    pages = []
    for passes in range(args.passes):
        for jpeg in sorted(Path(args.pages).glob("*.jpg")):
            with Image.open(jpeg) as opened:
                image = opened.convert("RGB")
            wall, cpu = time.perf_counter(), time.process_time()
            regions = model(image)
            spent = (time.perf_counter() - wall, time.process_time() - cpu)
            width, height = image.size
            if passes == 0:
                pages.append(
                    {
                        "page": jpeg.stem,
                        "size": [width, height],
                        "wall_s": round(spent[0], 4),
                        "cpu_s": round(spent[1], 4),
                        "regions": [
                            {
                                "label": r["label"],
                                "score": round(r["score"], 4),
                                "box": [
                                    round(r["px"][0] / width * 1000, 1),
                                    round(r["px"][1] / height * 1000, 1),
                                    round(r["px"][2] / width * 1000, 1),
                                    round(r["px"][3] / height * 1000, 1),
                                ],
                            }
                            for r in regions
                        ],
                    }
                )
            else:
                pages.append(
                    {
                        "page": jpeg.stem,
                        "pass": passes,
                        "wall_s": round(spent[0], 4),
                        "cpu_s": round(spent[1], 4),
                    }
                )
            print(f"{jpeg.stem}: {spent[0]:.3f}s wall, {spent[1]:.3f}s cpu", flush=True)
    # The first page after loading is cold; every later one is warm.
    warm = pages[1:]
    record["rss_mb"]["peak"] = rss_mb()
    record["loadavg_after"] = loadavg()
    record["cold_page"] = {"wall_s": pages[0]["wall_s"], "cpu_s": pages[0]["cpu_s"]}
    record["warm_page"] = {
        "wall_s_median": round(statistics.median(p["wall_s"] for p in warm), 4),
        "cpu_s_median": round(statistics.median(p["cpu_s"] for p in warm), 4),
        "wall_s_max": max(p["wall_s"] for p in warm),
        "pages": len(warm),
    }
    record["pages"] = [p for p in pages if "regions" in p]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(record, indent=1))
    print(
        json.dumps(
            {
                k: record[k]
                for k in ("model", "load", "rss_mb", "cold_page", "warm_page")
            }
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("render")
    r.add_argument("--pdfs", type=Path, required=True)
    r.add_argument("--gold", type=Path, help="the gold files' folder (scans)")
    r.add_argument("--digital", type=Path, help="fixtures/digital/figures.json")
    r.add_argument("--pages", type=Path, required=True)
    d = sub.add_parser("detect")
    d.add_argument("--backend", choices=list(PACKAGES), required=True)
    d.add_argument("--model", required=True)
    d.add_argument("--path")
    d.add_argument("--pages", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--threads", type=int, default=8)
    # Later passes time the same pages again, warm, without their regions.
    d.add_argument("--passes", type=int, default=1)
    args = parser.parse_args()
    if args.command == "render":
        render(args.pdfs, args.gold, args.digital, args.pages)
    else:
        detect(args)


if __name__ == "__main__":
    main()
