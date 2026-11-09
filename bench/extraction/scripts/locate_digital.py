"""The figure box call on born-digital pages, as production makes it:
``extraction.locate_figures`` with each page alone at the windows' resolution,
on the extraction slot's route, reasoning off, the same padding. Scored
against the gold boxes taken from the PDFs (gold_digital.py).

    python -I bench/extraction/scripts/locate_digital.py <references>/born-digital \
        --repeat 1 --env-file <keys file>

Writes ``.results/digital-<n>.json`` and the crops under ``.results/digital-<n>/``.
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # puts the pipeline on the path

FIXTURES = HERE.parent / "fixtures" / "digital"


def _area(b: list[float]) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _overlap(a: list[float], b: list[float]) -> float:
    return _area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def next_question_top(pdf: Path, page: int, below: float) -> float | None:
    """The top, on the 0-1000 grid, of the first question number printed in
    the left margin below ``below``."""
    import pymupdf

    with pymupdf.open(pdf) as doc:
        p = doc[page - 1]
        w, h = p.rect.width, p.rect.height
        tops = [
            word[1] / h * 1000
            for word in p.get_text("words")
            if word[0] < 0.12 * w and word[4].isdigit() and word[1] / h * 1000 > below
        ]
    return min(tops, default=None)


def score(
    fig: dict, box: list[float], others: list[list[float]], next_top: float | None
) -> dict:
    gold = fig["box"]
    inter = _overlap(gold, box)
    return {
        "box": [round(v) for v in box],
        "covered": round(inter / _area(gold), 3),
        "figure_share": round(inter / _area(box), 3) if _area(box) else 0,
        "edges": [round(c - g) for c, g in zip(box, gold)],
        "next_question": next_top is not None and box[3] > next_top,
        "other_figure": any(_overlap(o, box) > 0.05 * _area(o) for o in others),
    }


async def main_async(args) -> dict:
    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, limits

    from pipeline import elitellm

    refs = Path(args.refs)
    figures = json.loads((FIXTURES / "figures.json").read_text())["figures"]
    _, model_slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec("openrouter", model_slug, name, rates, "mid")
    served = bench.pin_openrouter(model_slug, None)
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))

    def pdf_of(paper: str) -> Path:
        return refs / paper / "paper.pdf"

    async def image(pdf: Path, number: int) -> str:
        jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
        return capture.data_url(jpeg)

    async def crop(pdf: Path, number: int, box: list[float]):
        jpeg, _box, size = capture.render(
            pdf, number, box, cfg.capture_max_edge, extraction.FIGURE_PAGE_EDGE
        )
        return jpeg, size

    pages: dict[tuple[str, int], extraction.Page] = {}
    held: dict[tuple[str, str], extraction.Recorded] = {}
    order: list[tuple[extraction.Recorded, int, dict]] = []
    for fig in figures:
        key = (fig["paper"], fig["page"])
        if key not in pages:
            pdf = pdf_of(fig["paper"])
            pages[key] = extraction.Page(
                fig["page"],
                fig["paper"],
                "",
                functools.partial(image, pdf, fig["page"]),
                functools.partial(crop, pdf, fig["page"]),
            )
        q = held.setdefault(
            (fig["paper"], fig["label"]),
            extraction.Recorded(fig["label"], {}, [""], ["printed"]),
        )
        q.figures.append(extraction.Figure(pages[key], "", fig["description"]))
        order.append((q, len(q.figures) - 1, fig))

    # The located box before the pad, by page and the figure's place in its call.
    raw: dict[tuple[int, int], list[float]] = {}
    locate = extraction.locate

    async def recorded_locate(page, listed, *, model):
        boxes = await locate(page, listed, model=model)
        for n, box in enumerate(boxes):
            raw[(id(page), n)] = box
        return boxes

    extraction.locate = recorded_locate
    started = time.monotonic()
    left_out = await extraction.locate_figures(list(held.values()), model=model)
    seconds = time.monotonic() - started

    # Each figure's place in its page's call, as locate_figures lists them.
    place: dict[tuple[int, int], int] = {}
    counts: dict[int, int] = {}
    for q in held.values():
        for i, f in enumerate(q.figures):
            place[(id(q), i)] = counts.get(id(f.page), 0)
            counts[id(f.page)] = counts.get(id(f.page), 0) + 1

    out_dir = bench.RESULTS / f"digital-{args.repeat}"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for q, index, fig in order:
        figure = q.figures[index] if index < len(q.figures) else None
        others = [
            g["box"]
            for g in figures
            if g is not fig and (g["paper"], g["page"]) == (fig["paper"], fig["page"])
        ]
        nxt = next_question_top(pdf_of(fig["paper"]), fig["page"], fig["box"][3])
        row = {k: fig[k] for k in ("paper", "page", "label", "description", "box")}
        row["gold_share_of_page"] = round(_area(fig["box"]) / 1e6, 3)
        row["figures_on_page"] = len(others) + 1
        if figure is None or figure.box is None:
            row["left_out"] = True
            rows.append(row)
            continue
        page = figure.page
        row["raw"] = score(fig, raw[(id(page), place[(id(q), index)])], others, nxt)
        row["padded"] = score(fig, figure.box, others, nxt)
        jpeg, size = await figure.page.crop(figure.box)
        path = (
            out_dir
            / f"{fig['paper'][6:12]}-p{fig['page']:02d}-q{fig['label']}-{index + 1}.jpg"
        )
        path.write_bytes(jpeg)
        row["crop"] = {"file": path.name, "bytes": len(jpeg), "size": list(size)}
        rows.append(row)
    return {
        "repeat": args.repeat,
        "seconds": round(seconds, 1),
        "calls": len(served),
        "providers": sorted({c["provider"] for c in served if c["provider"]}),
        "billed_usd": round(sum(c["cost"] or 0 for c in served), 4),
        "left_out": left_out,
        "figures": rows,
    }


def summary(result: dict) -> dict:
    out = {}
    for kind in ("raw", "padded"):
        scored = [r[kind] for r in result["figures"] if kind in r]
        out[kind] = {
            "figures": len(result["figures"]),
            "whole": sum(1 for s in scored if s["covered"] >= 0.98),
            "tight": sum(1 for s in scored if s["figure_share"] >= 0.7),
            "missed": sum(1 for s in scored if s["covered"] < 0.3),
            "next_question": sum(1 for s in scored if s["next_question"]),
            "other_figure": sum(1 for s in scored if s["other_figure"]),
            "mean_covered": round(sum(s["covered"] for s in scored) / len(scored), 3),
            "mean_share": round(
                sum(s["figure_share"] for s in scored) / len(scored), 3
            ),
        }
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("refs", help="the born-digital references folder")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--env-file")
    args = parser.parse_args()
    bench.load_env(args.env_file)
    result = asyncio.run(main_async(args))
    result["summary"] = summary(result)
    out = bench.RESULTS / f"digital-{args.repeat}.json"
    out.write_text(json.dumps(result, indent=1))
    print(
        json.dumps(
            {
                k: result[k]
                for k in (
                    "seconds",
                    "calls",
                    "providers",
                    "billed_usd",
                    "left_out",
                    "summary",
                )
            },
            indent=1,
        )
    )


if __name__ == "__main__":
    main()
