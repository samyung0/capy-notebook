"""Ask DeepSeek 1017 which of a layout model's boxes is each figure a window
described, and score the crops that answer gives.

    python -I bench/extraction/scripts/layout_match.py <detections.json> \
        --figures <run.py result>... | --digital --repeat 1 --env-file <keys file>

The page image (the one ``layout_detect.py render`` drew, long side 1,568 px)
gets the model's candidates at the threshold (``layout_score.candidates``)
outlined and numbered, each box in its own colour. One call per page, as the box call
makes it: the page alone, reasoning off, on the extraction slot's route, with
the figures on that page listed by question and description; the reply names
the box numbers that hold each figure. Descriptions come from saved
extraction runs (``--figures``, the window call's own) or, with
``--digital``, from the born-digital fixture.

Each figure's crop is its picked boxes taken together, grown by an adjacent
caption (``layout_score.attach``) and padded by 1% of the page, and is scored
whole/tight against gold. A pick is *right* when it names exactly the boxes
the scorer's oracle takes. The order baseline assigns boxes to figures top to
bottom whenever a page has exactly as many boxes as figures, with no call.

Writes ``.results/layout-match-<name>.json`` and prints the scores.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import layout_score as ls
import run as bench  # puts the pipeline on the path

PAD = 10
MATCH_MAX_TOKENS = 400
MATCH_SYSTEM = (
    "You match figures on a printed exam or worksheet page to numbered boxes. "
    "A layout model outlined each picture or chart on the page image, each box "
    "in its own colour with its number in a tag of that colour at its top left "
    "corner (inside its bottom left corner when boxes share a corner). Answer with "
    'JSON only: {"figures": [[2], [3, 4], []]}, one list for each figure '
    "listed, in the order listed: the numbers of the boxes that hold it. A "
    "figure may be split across several boxes (a diagram and its key, two "
    "shapes side by side): give all of them. When boxes are nested, give the "
    "one that holds the whole figure and the least else, such as answer "
    "options. Give [] when no box holds the figure."
)


COLOURS = [(220, 0, 0), (0, 70, 220), (0, 140, 60), (230, 120, 0), (150, 0, 170)]


def numbered(page_jpeg: Path, boxes: list[list[float]]) -> bytes:
    """The page with each box outlined in its own colour and tagged with its
    number in that colour at its top left corner, or inside its bottom left
    corner when another box's tag is already there (nested boxes)."""
    from PIL import Image, ImageDraw, ImageFont

    image = Image.open(page_jpeg).convert("RGB")
    w, h = image.size
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=26)
    tags: list[tuple[float, float]] = []
    for n, box in enumerate(boxes, 1):
        colour = COLOURS[(n - 1) % len(COLOURS)]
        x0, y0, x1, y1 = (
            v * (w if i % 2 == 0 else h) / 1000 for i, v in enumerate(box)
        )
        draw.rectangle([x0, y0, x1, y1], outline=colour, width=3)
        tx, ty = x0, y0 - 32 if y0 >= 32 else y0
        if any(abs(tx - a) < 40 and abs(ty - b) < 32 for a, b in tags):
            ty = y1 - 32
        tags.append((tx, ty))
        tw = draw.textlength(str(n), font=font) + 12
        draw.rectangle([tx, ty, tx + tw, ty + 32], fill=colour)
        draw.text((tx + 6, ty + 2), str(n), fill=(255, 255, 255), font=font)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=80)
    return buffer.getvalue()


def figure_sets(args) -> list[tuple[str, list[dict]]]:
    """Named lists of figures: page stem, question label, description."""
    if args.digital:
        figures = json.loads(ls.DIGITAL.read_text())["figures"]
        listed = [
            {
                "page": f"{f['paper']}-p{f['page']:02d}",
                "label": f["label"],
                "description": f["description"],
            }
            for f in figures
        ]
        return [(f"digital-{args.repeat}", listed)]
    sets = []
    for path in args.figures:
        result = json.loads(path.read_text())
        listed = [
            {
                "page": f"{result['paper']}-p{f['page']:02d}",
                "label": f["label"],
                "description": f["description"],
            }
            for f in result["figures"]
        ]
        sets.append((path.stem, listed))
    return sets


async def main_async(args) -> dict:
    from pipeline import elitellm
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, limits, models
    from pipeline.retrieval.extraction import extract_json

    detections = json.loads(args.detections.read_text())
    pages_dir = args.detections.parent.parent / "pages"
    regions = {p["page"]: p["regions"] for p in detections["pages"]}
    golds = ls.gold_figures()
    _, model_slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec("openrouter", model_slug, name, rates, "mid")
    served = bench.pin_openrouter(model_slug, None)
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))

    def gold_of(figure: dict) -> dict:
        return next(
            g
            for g in golds[figure["page"]]
            if g["label"] == figure["label"]
            and g.get("description", figure["description"]) == figure["description"]
        )

    async def one(page: str, listed: list[dict]) -> list[dict]:
        found = ls.candidates(regions[page], args.threshold)
        boxes = [c["box"] for c in found]
        rows = [{**f, "candidates": len(found)} for f in listed]
        # The oracle's boxes for each figure, as layout_score picks them.
        for row in rows:
            gold = gold_of(row)["box"]
            best = max(found, key=lambda c: ls.iou(c["box"], gold), default=None)
            row["oracle"] = (
                [
                    n
                    for n, c in enumerate(found, 1)
                    if c is best or ls.inter(c["box"], gold) >= 0.5 * ls.area(c["box"])
                ]
                if best is not None and ls.iou(best["box"], gold) > 0
                else []
            )
        if not found:
            for row in rows:
                row["fallback"] = "no boxes on the page"
            return rows
        image = capture.data_url(numbered(pages_dir / f"{page}.jpg", boxes))
        text = "The figures on this page:\n" + "\n".join(
            f"{n}. Question {f['label']}: {f['description']}"
            for n, f in enumerate(listed, 1)
        )
        message = await models.complete(
            [
                {"role": "system", "content": MATCH_SYSTEM},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": text},
                        {"type": "image_url", "image_url": {"url": image}},
                    ],
                },
            ],
            model=model,
            response_format={"type": "json_object"},
            max_tokens=MATCH_MAX_TOKENS,
            reasoning=False,
            call_purpose="extraction_figures",
        )
        data = extract_json(getattr(message, "content", "") or "")
        picks = data.get("figures") if isinstance(data, dict) else None
        if not isinstance(picks, list) or len(picks) != len(listed):
            for row in rows:
                row["fallback"] = "reply was not one list a figure"
            return rows
        for row, pick in zip(rows, picks):
            numbers = sorted(
                {n for n in pick if isinstance(n, int) and 1 <= n <= len(found)}
            )
            row["picked"] = numbers
            if not numbers:
                row["fallback"] = "no box picked"
                continue
            crop = ls.attach(
                ls.around([boxes[n - 1] for n in numbers]),
                regions[page],
                args.threshold,
            )
            row["crop"] = ls.fit(ls.pad(crop, PAD), gold_of(row)["box"])
        return rows

    def by_order(page: str, listed: list[dict]) -> list[bool]:
        """Boxes given to figures top to bottom, when the counts agree."""
        found = ls.candidates(regions[page], args.threshold)
        if len(found) != len(listed):
            return [False] * len(listed)
        ordered = sorted(range(len(found)), key=lambda i: found[i]["box"][1])
        out = []
        for f, i in zip(listed, ordered):
            gold = gold_of(f)["box"]
            box = ls.pad(ls.attach(found[i]["box"], regions[page], args.threshold), PAD)
            fit = ls.fit(box, gold)
            out.append(fit["whole"] and fit["tight"])
        return out

    out = {}
    started = time.monotonic()
    for name_, listed in figure_sets(args):
        pages: dict[str, list[dict]] = {}
        for f in listed:
            pages.setdefault(f["page"], []).append(f)
        results = await asyncio.gather(*(one(p, fs) for p, fs in pages.items()))
        rows = [r for rs in results for r in rs]
        order_ok = [ok for p, fs in pages.items() for ok in by_order(p, fs)]
        out[name_] = {
            "figures": len(rows),
            "pages": len(pages),
            "right_pick": sum(1 for r in rows if r.get("picked") == r["oracle"]),
            "fallback": sum(1 for r in rows if "fallback" in r),
            "whole": sum(1 for r in rows if r.get("crop", {}).get("whole")),
            "tight": sum(1 for r in rows if r.get("crop", {}).get("tight")),
            "both": sum(
                1 for r in rows if r.get("crop", {}).get("whole") and r["crop"]["tight"]
            ),
            "order_baseline_both": sum(order_ok),
            "rows": rows,
        }
    return {
        "detections": args.detections.name,
        "threshold": args.threshold,
        "seconds": round(time.monotonic() - started, 1),
        "calls": len(served),
        "providers": sorted({c["provider"] for c in served if c["provider"]}),
        "billed_usd": round(sum(c["cost"] or 0 for c in served), 4),
        "sets": out,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("detections", type=Path)
    parser.add_argument("--figures", nargs="*", type=Path, default=[])
    parser.add_argument("--digital", action="store_true")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--name", required=True)
    parser.add_argument("--env-file")
    args = parser.parse_args()
    bench.load_env(args.env_file)
    result = asyncio.run(main_async(args))
    bench.RESULTS.mkdir(parents=True, exist_ok=True)
    out = bench.RESULTS / f"layout-match-{args.name}.json"
    out.write_text(json.dumps(result, indent=1))
    print(
        json.dumps(
            {
                **{
                    k: result[k]
                    for k in ("seconds", "calls", "providers", "billed_usd")
                },
                "sets": {
                    k: {kk: vv for kk, vv in v.items() if kk != "rows"}
                    for k, v in result["sets"].items()
                },
            },
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
