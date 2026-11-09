"""Score layout-model detections (``layout_detect.py``) against the gold
figure boxes, the way ``run.py`` scores the box call's crops: a figure is
*whole* when at most 2% of its gold box falls outside the box, and *tight*
when at least 70% of the box is figure.

    python bench/extraction/scripts/layout_score.py <detections.json>... \
        [--threshold 0.5] [--box-call <run.py result>...] [--overlays <dir>]

A model's figure regions (``image`` and ``chart`` for PaddlePaddle's models,
``picture`` for Docling's) at or above the threshold are its candidates; two
with an IoU of 0.8 or more count once, the higher score kept. Each gold
figure is scored, as is and padded by 1% and 2% of the page all round, on:

- *best*: the candidate that overlaps it most (IoU);
- *crop*: the box a crop would take once the right candidates are picked: the
  best one with every other candidate at least half inside the figure (a
  figure split into pieces), grown to take in a figure title or caption the
  model found just above or below it (``attach``).

A candidate that is no figure's best and lies less than half inside every gold
figure on its page is a false positive. ``--box-call`` scores saved
extraction runs' padded boxes with the same code, for the comparison row. ``--overlays`` draws gold (green) and
candidates (red, numbered) on each page image from the ``pages/`` folder
beside the detections' folder.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GOLD = ROOT / "bench" / "extraction" / "fixtures" / "gold"
DIGITAL = ROOT / "bench" / "extraction" / "fixtures" / "digital" / "figures.json"
FIGURE_LABELS = {"image", "chart", "picture"}
CAPTION_LABELS = {"figure_title", "chart_title", "caption"}
# A caption at most this far above or below a figure (2.5% of the page)
# belongs to it.
CAPTION_GAP = 25
PADS = (0, 10, 20)


def area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def inter(a: list[float], b: list[float]) -> float:
    return area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def iou(a: list[float], b: list[float]) -> float:
    shared = inter(a, b)
    return shared / (area(a) + area(b) - shared) if shared else 0.0


def pad(box: list[float], by: float) -> list[float]:
    return [
        max(0.0, box[0] - by),
        max(0.0, box[1] - by),
        min(1000.0, box[2] + by),
        min(1000.0, box[3] + by),
    ]


def around(boxes: list[list[float]]) -> list[float]:
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def fit(box: list[float], gold: list[float]) -> dict:
    shared = inter(box, gold)
    covered = shared / area(gold)
    share = shared / area(box) if area(box) else 0.0
    return {
        "covered": round(covered, 3),
        "figure_share": round(share, 3),
        "whole": covered >= 0.98,
        "tight": share >= 0.7,
        "edges": [round(c - g) for c, g in zip(box, gold)],
    }


def candidates(regions: list[dict], threshold: float) -> list[dict]:
    kept: list[dict] = []
    for region in sorted(regions, key=lambda r: -r["score"]):
        if region["label"] not in FIGURE_LABELS or region["score"] < threshold:
            continue
        # The same region under two labels counts once; a box nested in
        # another stays, as a tighter choice (2022 P2 Q14 with and without
        # its options).
        if any(iou(region["box"], k["box"]) >= 0.8 for k in kept):
            continue
        kept.append(region)
    # Top to bottom, then left to right, as the numbers on an overlay read.
    return sorted(kept, key=lambda r: (round(r["box"][1] / 20), r["box"][0]))


def attach(box: list[float], regions: list[dict], threshold: float) -> list[float]:
    """The box grown to take in each caption the model found within
    ``CAPTION_GAP`` above or below it whose middle is over it."""
    grown = [box]
    for r in regions:
        c = r["box"]
        if r["label"] not in CAPTION_LABELS or r["score"] < threshold:
            continue
        middle = (c[0] + c[2]) / 2
        gap = max(c[1] - box[3], box[1] - c[3])
        if box[0] <= middle <= box[2] and gap <= CAPTION_GAP:
            grown.append(c)
    return around(grown)


def gold_figures() -> dict[str, list[dict]]:
    """Gold figure boxes by page stem (``2022-p2-p07``): every page of the
    scanned papers' gold files, and the born-digital figures' pages."""
    out: dict[str, list[dict]] = {}
    for path in sorted(GOLD.glob("*.json")):
        paper = json.loads(path.read_text())
        for number in paper["pages"]:
            out.setdefault(f"{paper['paper']}-p{number:02d}", [])
        for figure in paper.get("figure_boxes", []):
            stem = f"{paper['paper']}-p{figure['page']:02d}"
            out[stem].append({"label": figure["label"], "box": figure["box"]})
    for figure in json.loads(DIGITAL.read_text())["figures"]:
        stem = f"{figure['paper']}-p{figure['page']:02d}"
        out.setdefault(stem, []).append(
            {
                "label": figure["label"],
                "box": figure["box"],
                "description": figure["description"],
            }
        )
    return out


def score(detections: dict, threshold: float) -> dict:
    golds = gold_figures()
    figures, false_positives = [], []
    for page in detections["pages"]:
        found = candidates(page["regions"], threshold)
        on_page = golds.get(page["page"], [])
        # A box that is some figure's best match is that figure's, however loose.
        bests = [
            max(found, key=lambda c: iou(c["box"], g["box"]), default=None)
            for g in on_page
        ]
        for n, c in enumerate(found, 1):
            if not any(c is b for b in bests) and all(
                inter(c["box"], g["box"]) < 0.5 * area(c["box"]) for g in on_page
            ):
                false_positives.append({"page": page["page"], "number": n, **c})
        for g in on_page:
            row = {"page": page["page"], "label": g["label"], "gold": g["box"]}
            best = max(found, key=lambda c: iou(c["box"], g["box"]), default=None)
            if best is None or iou(best["box"], g["box"]) == 0:
                row["missed"] = True
                figures.append(row)
                continue
            picked = [
                c
                for c in found
                if c is best or inter(c["box"], g["box"]) >= 0.5 * area(c["box"])
            ]
            crop = attach(
                around([c["box"] for c in picked]), page["regions"], threshold
            )
            row["numbers"] = [found.index(c) + 1 for c in picked]
            row["best"] = {
                "label": best["label"],
                "score": best["score"],
                "iou": round(iou(best["box"], g["box"]), 3),
                **{f"pad{p}": fit(pad(best["box"], p), g["box"]) for p in PADS},
            }
            row["crop"] = {
                "box": crop,
                **{f"pad{p}": fit(pad(crop, p), g["box"]) for p in PADS},
            }
            figures.append(row)
    pages = len(detections["pages"])

    def tally(kind: str, p: int) -> dict:
        fits = [f[kind][f"pad{p}"] for f in figures if kind in f]
        return {
            "whole": sum(f["whole"] for f in fits),
            "tight": sum(f["tight"] for f in fits),
            "both": sum(f["whole"] and f["tight"] for f in fits),
        }

    return {
        "model": detections["model"],
        "backend": detections["backend"],
        "threshold": threshold,
        "figures": len(figures),
        "missed": sum(1 for f in figures if f.get("missed")),
        **{f"{k}_pad{p}": tally(k, p) for k in ("best", "crop") for p in PADS},
        "false_positives": len(false_positives),
        "pages": pages,
        "rows": figures,
        "false_positive_rows": false_positives,
    }


def box_call(paths: list[Path]) -> dict:
    """Saved box-call results' padded boxes, scored as one batch of crops:
    ``run.py`` results (scans) or ``locate_digital.py`` results."""
    golds = gold_figures()
    rows = []
    for path in paths:
        result = json.loads(path.read_text())
        for figure in result["figures"]:
            paper = figure.get("paper", result.get("paper"))
            on_page = golds.get(f"{paper}-p{figure['page']:02d}", [])
            g = next(
                (
                    g["box"]
                    for g in on_page
                    if g["label"] == figure["label"]
                    # Two born-digital figures may share a question and page.
                    and g.get("description", figure.get("description"))
                    == figure.get("description")
                ),
                None,
            )
            box = figure["padded"]["box"] if "padded" in figure else figure["box"]
            if g is not None:
                rows.append({"run": path.stem, "label": figure["label"], **fit(box, g)})
    return {
        "crops": len(rows),
        "whole": sum(r["whole"] for r in rows),
        "tight": sum(r["tight"] for r in rows),
        "both": sum(r["whole"] and r["tight"] for r in rows),
        "rows": rows,
    }


def overlays(detections: dict, threshold: float, pages: Path, out: Path) -> None:
    from PIL import Image, ImageDraw

    golds = gold_figures()
    out.mkdir(parents=True, exist_ok=True)
    for page in detections["pages"]:
        found = candidates(page["regions"], threshold)
        if not found and not golds.get(page["page"]):
            continue
        image = Image.open(pages / f"{page['page']}.jpg").convert("RGB")
        w, h = image.size
        draw = ImageDraw.Draw(image)

        def px(box, w=w, h=h):
            return [b * (w if i % 2 == 0 else h) / 1000 for i, b in enumerate(box)]

        for g in golds.get(page["page"], []):
            draw.rectangle(px(g["box"]), outline=(0, 160, 0), width=3)
        for n, c in enumerate(found, 1):
            box = px(c["box"])
            draw.rectangle(box, outline=(220, 0, 0), width=2)
            draw.text(
                (box[0] + 4, box[1] + 2),
                f"{n} {c['label']} {c['score']:.2f}",
                fill=(220, 0, 0),
            )
        image.save(out / f"{page['page']}.jpg", quality=80)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("detections", nargs="*", type=Path)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--box-call", nargs="*", type=Path, default=[])
    parser.add_argument("--overlays", type=Path)
    parser.add_argument("--out", type=Path, help="write every score as JSON")
    args = parser.parse_args()
    results = {}
    if args.box_call:
        call = box_call(args.box_call)
        results["box_call"] = call
        print(
            f"box call: {call['crops']} crops, whole {call['whole']}, "
            f"tight {call['tight']}, both {call['both']}"
        )
    print(
        "model | missed | best whole/tight/both, pad 0 1% 2% "
        "| crop whole/tight/both, pad 0 1% 2% | false positives"
    )
    for path in args.detections:
        detections = json.loads(path.read_text())
        s = score(detections, args.threshold)
        results[path.stem] = s
        cells = [
            "  ".join(
                "/".join(
                    str(s[f"{kind}_pad{p}"][k]) for k in ("whole", "tight", "both")
                )
                for p in PADS
            )
            for kind in ("best", "crop")
        ]
        print(
            f"{path.stem} | {s['missed']}/{s['figures']} | {cells[0]} | {cells[1]} "
            f"| {s['false_positives']} on {s['pages']} pages"
        )
        if args.overlays:
            overlays(
                detections,
                args.threshold,
                path.parent.parent / "pages",
                args.overlays / path.stem,
            )
    if args.out:
        args.out.write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
