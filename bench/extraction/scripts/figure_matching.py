"""Match a page's named figures to a layout model's boxes in code, with the names
the window calls really write, and find where that goes wrong silently.

The pipeline, per page with named figures (Epo 2026-11-04):

1. PP-DocLayout_plus-L's ``image`` and ``chart`` regions at 0.5 or more, one of
   any pair with an IoU of 0.8 or more (``layout_score.candidates``).
2. Drop a picture box that holds a smaller picture box (at least 90% inside) plus
   ``text`` regions of its own outside that smaller box.
3. As many boxes as named figures: top to bottom, then left to right, in the order
   the windows recorded the figures (``order``).
4. Counts differ: the numbered-box picking call on 1017 (``pick``).
5. No boxes: the box call (``box``).

Compared with always making the picking call on step 1's boxes, as
``layout_match.py`` does. Crops are the box, an adjacent caption and a 1% pad.

    # In a throwaway venv with onnxruntime, numpy, pillow, pyyaml and pymupdf:
    python -I figure_matching.py detect --paper 2023-p2 --pdf <pdf> --model <dir>
    # In the root .venv, after figure_windows.py's variant none jobs:
    python -I figure_matching.py match --saved <study-extraction .results> \
        --detections <pp-plus-l-onnx.json>... --scans <dir> --digital <dir> --env-file <keys>
    python -I figure_matching.py traps ...
    python -I figure_matching.py pages <set> --out <folder>  # for the eye check

The names come from saved 1017 runs and ``figure_windows.py``'s variant none jobs,
the production windows. Everything lands in ``.results/matching/``. Each paid call
adds to ``spend.json``; a run stops before the total passes ``SPEND_CAP``. Picking
and box calls are cached by page, names and boxes, so a rerun costs nothing. Keys
are read into the process only, never printed.
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
import layout_score as ls  # noqa: E402
import run as bench  # noqa: E402  (puts the pipeline on the path)

OUT = bench.RESULTS / "matching"
FIXTURES = HERE.parent / "fixtures" / "matching"
SPEND_CAP = 1.9
THRESHOLD = 0.5
INSIDE = 0.9
PAD = 10
CONCURRENCY = 6
ALIASES = {
    "2023-bio-p4": "igcse-biology-0610-2023-sp4",
    "2023-bio-p4-cover": "igcse-biology-0610-2023-sp4",
}


def stem_of(paper: str, number: int) -> str:
    return f"{paper}-p{number:02d}"


def parse_pages(text: str | None, count: int) -> list[int]:
    if not text:
        return list(range(1, count + 1))
    first, _, last = text.partition("-")
    return list(range(int(first), int(last or first) + 1))


class Spend:
    path = OUT / "spend.json"

    def __init__(self) -> None:
        OUT.mkdir(parents=True, exist_ok=True)
        self.data = (
            json.loads(self.path.read_text())
            if self.path.exists()
            else {"usd": 0.0, "by": {}}
        )

    def add(self, what: str, usd: float) -> None:
        self.data["usd"] = round(self.data["usd"] + usd, 6)
        self.data["by"][what] = round(self.data["by"].get(what, 0.0) + usd, 6)
        self.path.write_text(json.dumps(self.data, indent=1))

    def check(self) -> None:
        if self.data["usd"] > SPEND_CAP:
            raise SystemExit(f"stopping: spent ${self.data['usd']:.3f}")


# ------------------------------------------------------------------- detecting


def detect(args) -> None:
    """Render the pages as the windows see them and run the detector, one page
    at a time, into ``detections/<paper>.json``. Runs in the throwaway venv."""
    import layout_detect
    import pymupdf
    from PIL import Image

    model = layout_detect.PaddleOnnx(Path(args.model), args.threads)
    pages_dir = OUT / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    pages = []
    with pymupdf.open(args.pdf) as doc:
        for number in parse_pages(args.pages, len(doc)):
            page = doc[number - 1]
            scale = layout_detect.PAGE_EDGE / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            stem = stem_of(args.paper, number)
            image.save(
                pages_dir / f"{stem}.jpg", "JPEG", quality=layout_detect.JPEG_QUALITY
            )
            started = time.perf_counter()
            regions = model(image)
            pages.append(
                {
                    "page": stem,
                    "size": [pix.width, pix.height],
                    "wall_s": round(time.perf_counter() - started, 3),
                    "regions": [
                        {
                            "label": r["label"],
                            "score": round(r["score"], 4),
                            "box": [
                                round(r["px"][0] / pix.width * 1000, 1),
                                round(r["px"][1] / pix.height * 1000, 1),
                                round(r["px"][2] / pix.width * 1000, 1),
                                round(r["px"][3] / pix.height * 1000, 1),
                            ],
                        }
                        for r in regions
                    ],
                }
            )
    folder = OUT / "detections"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{args.paper}.json").write_text(json.dumps({"pages": pages}, indent=1))
    walls = sorted(p["wall_s"] for p in pages)
    print(args.paper, len(pages), "pages, median", walls[len(walls) // 2], "s a page")


def load_detections(paths: list[str]) -> dict[str, list[dict]]:
    """Regions by page stem: the layout bench's saved runs, then the Mac's."""
    out: dict[str, list[dict]] = {}
    for path in [*paths, *sorted((OUT / "detections").glob("*.json"))]:
        for page in json.loads(Path(path).read_text())["pages"]:
            out[page["page"]] = page["regions"]
    return out


def _inside(a: list[float], b: list[float]) -> float:
    """The share of a that lies in b."""
    return ls.inter(a, b) / ls.area(a) if ls.area(a) else 0.0


def boxes_of(regions: list[dict]) -> tuple[list[dict], list[dict]]:
    """Step 1's boxes and what step 2 leaves of them, both in reading order."""
    found = ls.candidates(regions, THRESHOLD)
    texts = [
        r["box"] for r in regions if r["label"] == "text" and r["score"] >= THRESHOLD
    ]
    kept = []
    for outer in found:
        dropped = False
        for inner in found:
            if (
                inner is outer
                or ls.area(inner["box"]) >= ls.area(outer["box"])
                or _inside(inner["box"], outer["box"]) < INSIDE
            ):
                continue
            if any(
                _inside(t, outer["box"]) >= 0.5 and _inside(t, inner["box"]) < 0.5
                for t in texts
            ):
                dropped = True
        if not dropped:
            kept.append(outer)
    return found, kept


# ---------------------------------------------------------------------- names


def load_sets(saved: str | None) -> list[dict]:
    """Every run's named figures, grouped by page in the order they were held."""
    sets = []
    for path in sorted(Path(saved).glob("*-v41-1017-*.json")) if saved else []:
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            print("still being written:", path.name)
            continue
        if data.get("figures"):
            # Another bench's runs of the IGCSE Biology paper under its own name.
            paper = ALIASES.get(data["paper"], data["paper"])
            sets.append(
                {
                    "name": path.stem,
                    "paper": paper,
                    "kind": "digital, saved" if paper in ALIASES.values() else "scan",
                    "figures": data["figures"],
                }
            )
    for path in sorted((bench.RESULTS / "windows").glob("*-none-*.json")):
        data = json.loads(path.read_text())
        # A run from before ``names`` was kept, whose box call left names out.
        if data["report"].get("figuresLeftOut") and not data.get("names"):
            continue
        span = data["name"].removeprefix(data["paper"] + "-").split("-none-")[0]
        kind = "digital" if data["paper"].startswith("igcse") else "new"
        sets.append(
            {
                "name": data["name"],
                "paper": data["paper"],
                "kind": kind if span == "all" else "cut",
                "figures": data.get("names") or data["figures"],
                "pages": data["pages"],
            }
        )
    return sets


def by_page(paper: str, figures: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for figure in figures:
        out.setdefault(stem_of(paper, figure["page"]), []).append(figure)
    return out


# ------------------------------------------------------------------- the calls


class Caller:
    """The picking and box calls on 1017, as the service would make them,
    cached by page, names and boxes."""

    path = OUT / "calls.json"

    def __init__(self, args) -> None:
        from pipeline import elitellm
        from pipeline.registry import bind_request_llm
        from pipeline.retrieval import limits

        _, slug, name, rates = bench.MODELS["v41-1017"]
        self.model = bench.spec("openrouter", slug, name, rates, "mid")
        self.served = bench.pin_openrouter(slug, None)
        elitellm.bind_route_slot("extraction")
        bind_request_llm("mid")
        limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
        self.args = args
        self.sem = asyncio.Semaphore(CONCURRENCY)
        self.cache = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.spend = Spend()

    def pdf(self, paper: str) -> Path:
        digital = Path(self.args.digital) / paper / "paper.pdf"
        return digital if digital.exists() else Path(self.args.scans) / f"{paper}.pdf"

    def page(self, paper: str, number: int) -> Path:
        """The page image as the windows see it, rendered once."""
        import layout_detect
        import pymupdf
        from PIL import Image

        path = OUT / "pages" / f"{stem_of(paper, number)}.jpg"
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            with pymupdf.open(self.pdf(paper)) as doc:
                page = doc[number - 1]
                scale = layout_detect.PAGE_EDGE / max(page.rect.width, page.rect.height)
                pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            Image.frombytes("RGB", (pix.width, pix.height), pix.samples).save(
                path, "JPEG", quality=layout_detect.JPEG_QUALITY
            )
        return path

    async def _cached(self, key: list, call) -> dict:
        text = json.dumps(key, ensure_ascii=False)
        if text not in self.cache:
            self.spend.check()
            async with self.sem:
                started = time.monotonic()
                answer = await call()
                seconds = round(time.monotonic() - started, 2)
            self.cache[text] = {"answer": answer, "seconds": seconds}
        return self.cache[text]

    async def pick(
        self, paper: str, number: int, listed: list[dict], boxes: list[list[float]]
    ) -> dict:
        """Which boxes hold each listed figure: a list per figure, or None for a
        reply that is not one, after one retry as production retries."""
        import layout_match as lm

        from pipeline.retrieval import capture, models
        from pipeline.retrieval.extraction import extract_json

        async def call():
            image = capture.data_url(lm.numbered(self.page(paper, number), boxes))
            text = "The figures on this page:\n" + "\n".join(
                f"{n}. Question {f['label']}: {f['description']}"
                for n, f in enumerate(listed, 1)
            )
            for _ in range(2):
                message = await models.complete(
                    [
                        {"role": "system", "content": lm.MATCH_SYSTEM},
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": text},
                                {"type": "image_url", "image_url": {"url": image}},
                            ],
                        },
                    ],
                    model=self.model,
                    response_format={"type": "json_object"},
                    max_tokens=lm.MATCH_MAX_TOKENS,
                    reasoning=False,
                    call_purpose="extraction_figures",
                )
                data = extract_json(getattr(message, "content", "") or "")
                picks = data.get("figures") if isinstance(data, dict) else None
                if isinstance(picks, list) and len(picks) == len(listed):
                    return [
                        sorted(
                            {
                                n
                                for n in pick
                                if isinstance(n, int) and 1 <= n <= len(boxes)
                            }
                        )
                        if isinstance(pick, list)
                        else []
                        for pick in picks
                    ]
            return None

        key = [
            "pick",
            stem_of(paper, number),
            [[f["label"], f["description"]] for f in listed],
            boxes,
        ]
        return await self._cached(key, call)

    async def box(self, paper: str, number: int, listed: list[dict]) -> dict:
        """The box call's padded boxes for a page, as production makes them."""
        from pipeline.config import cfg
        from pipeline.retrieval import capture, extraction

        pdf = self.pdf(paper)

        async def image() -> str:
            jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
            return capture.data_url(jpeg)

        async def call():
            page = extraction.Page(number, pdf.name, "", image, None)
            boxes = await extraction._attempted(
                functools.partial(
                    extraction.locate,
                    page,
                    [(f["label"], f["description"]) for f in listed],
                    model=self.model,
                )
            )
            p = extraction.FIGURE_PAD
            return [
                [
                    max(0.0, b[0] - p[0]),
                    max(0.0, b[1] - p[1]),
                    min(1000.0, b[2] + p[2]),
                    min(1000.0, b[3] + p[3]),
                ]
                for b in boxes
            ]

        key = [
            "box",
            stem_of(paper, number),
            [[f["label"], f["description"]] for f in listed],
        ]
        return await self._cached(key, call)

    def save(self) -> float:
        """Write the cache and add what this process was billed to the spend."""
        billed = sum(call["cost"] or 0 for call in self.served)
        self.spend.add("pick and box calls", billed)
        self.path.write_text(json.dumps(self.cache, ensure_ascii=False, indent=0))
        return billed


# -------------------------------------------------------------------- scoring


def load_eye() -> dict:
    """Pages with no gold, read by eye: which question each box belongs to."""
    return json.loads((FIXTURES / "eye.json").read_text())["pages"]


def question_key(label: str) -> str:
    """A label's question number: a window that sees only part of a question may
    write 3(b)(i) for question 3."""
    from pipeline.retrieval.extraction import label_key

    return label_key(label).split(".")[0]


def _words(text: str) -> set[str]:
    return {w for w in "".join(c.lower() if c.isalnum() else " " for c in text).split()}


def identify(listed: list[dict], stem: str, gold: dict) -> list[dict | None]:
    """The gold figure each name means: same question on the same page; among a
    question's several figures, the description sharing the most words."""
    free = list(gold.get(stem, []))
    out: list[dict | None] = []
    for f in listed:
        same = [g for g in free if question_key(g["label"]) == question_key(f["label"])]
        if not same:
            out.append(None)
            continue
        chosen = max(
            same,
            key=lambda g: len(
                _words(g.get("description", "")) & _words(f.get("description", ""))
            ),
        )
        free.remove(chosen)
        out.append(chosen)
    return out


def score_row(
    f: dict,
    goldf: dict | None,
    branch: str,
    assigned: list[list[float]] | None,
    found: list[dict],
    shown: list[list[float]],
    regions: list[dict],
    stem: str,
    gold: dict,
    eye: dict,
) -> dict:
    row = {
        "label": f["label"],
        "page": stem,
        "description": f["description"],
        "branch": branch,
        "boxes": assigned,
    }
    if not assigned:
        row.update(right=False, whole=False, tight=False, status="no box")
        if goldf is not None:
            row["status"] = "no box"
        return row
    if branch == "box":
        crop = assigned[0]
    else:
        crop = ls.pad(ls.attach(ls.around(assigned), regions, THRESHOLD), PAD)
    row["crop"] = [round(v, 1) for v in crop]
    if goldf is not None:
        target = goldf["box"]
        best = max(found, key=lambda c: ls.iou(c["box"], target), default=None)
        fit = ls.fit(crop, target)
        if branch == "order":
            right = best is not None and assigned[0] == best["box"]
        elif branch == "pick":
            top = max(shown, key=lambda b: ls.iou(b, target), default=None)
            oracle = {
                n
                for n, b in enumerate(shown)
                if b == top or ls.inter(b, target) >= 0.5 * ls.area(b)
            }
            right = (
                all(b in shown for b in assigned)
                and {shown.index(b) for b in assigned} == oracle
            )
        else:
            right = fit["covered"] >= 0.5
        row.update(
            status="gold",
            right=right,
            whole=fit["whole"],
            tight=fit["tight"],
            covered=fit["covered"],
            share=fit["figure_share"],
        )
    elif stem in gold:
        # The page's figures are all in gold, and this name is none of them.
        taken = [
            g["label"]
            for g in gold[stem]
            if ls.inter(crop, g["box"]) >= 0.5 * ls.area(g["box"])
        ]
        row.update(
            status="extra name", right=False, whole=False, tight=False, took=taken
        )
    elif stem in eye and branch != "box":
        owners = {
            tuple(c["box"]): entry
            for c, entry in zip(boxes_of(regions)[1], eye[stem], strict=True)
        }
        taken = [owners.get(tuple(b)) for b in assigned]
        mine = [
            e
            for e in eye[stem]
            if e["label"] and question_key(e["label"]) == question_key(f["label"])
        ]
        right = bool(mine) and all(e in mine for e in taken)
        row.update(
            status="eye",
            right=right,
            whole=right and all(e.get("whole", True) for e in taken),
            tight=right and all(e.get("tight", True) for e in taken),
            note="; ".join(e["note"] for e in taken if e and e.get("note")),
        )
    else:
        row.update(status="unchecked", right=None, whole=None, tight=None)
    return row


async def run_set(
    s: dict, mode: str, det: dict, gold: dict, eye: dict, caller
) -> list[dict]:
    """One set of names through the pipeline, or always through the picking call."""
    rows: list[dict] = []

    async def page(stem: str, listed: list[dict]) -> None:
        number = int(stem.rsplit("-p", 1)[1])
        regions = det.get(stem)
        if regions is None:
            rows.extend({**f, "page": stem, "branch": "no detection"} for f in listed)
            return
        found, kept = boxes_of(regions)
        shown = found if mode == "always" else kept
        boxes = [c["box"] for c in shown]
        goldfs = identify(listed, stem, gold)
        if not boxes:
            got = await caller.box(s["paper"], number, listed)
            answers = got["answer"] or [None] * len(listed)
            for f, g, b in zip(listed, goldfs, answers, strict=True):
                rows.append(
                    {
                        **score_row(
                            f,
                            g,
                            "box",
                            [b] if b else None,
                            found,
                            boxes,
                            regions,
                            stem,
                            gold,
                            eye,
                        ),
                        "seconds": got["seconds"],
                    }
                )
            return
        if mode == "pipeline" and len(boxes) == len(listed):
            for f, g, b in zip(listed, goldfs, boxes, strict=True):
                rows.append(
                    score_row(
                        f, g, "order", [b], found, boxes, regions, stem, gold, eye
                    )
                )
            return
        got = await caller.pick(s["paper"], number, listed, boxes)
        picks = got["answer"] or [[] for _ in listed]
        for f, g, pick in zip(listed, goldfs, picks, strict=True):
            chosen = [boxes[n - 1] for n in pick]
            if not chosen:
                # The picking call named no box: this figure goes to the box call.
                fallback = await caller.box(s["paper"], number, [f])
                answer = fallback["answer"] or [None]
                row = score_row(
                    f,
                    g,
                    "box",
                    [answer[0]] if answer[0] else None,
                    found,
                    boxes,
                    regions,
                    stem,
                    gold,
                    eye,
                )
                row["from_pick"] = True
            else:
                row = score_row(
                    f, g, "pick", chosen, found, boxes, regions, stem, gold, eye
                )
            rows.append({**row, "seconds": got["seconds"]})

    await asyncio.gather(
        *(page(st, ls_) for st, ls_ in by_page(s["paper"], s["figures"]).items())
    )
    return rows


def tally(rows: list[dict]) -> dict:
    known = [r for r in rows if r.get("right") is not None]
    return {
        "named": len(rows),
        "known": len(known),
        "right": sum(1 for r in known if r["right"]),
        "wrong": sum(1 for r in known if not r["right"]),
        "whole": sum(1 for r in known if r["whole"]),
        "tight": sum(1 for r in known if r["tight"]),
        "both": sum(1 for r in known if r["whole"] and r["tight"]),
        "unchecked": len(rows) - len(known),
    }


async def match(args) -> None:
    det = load_detections(args.detections)
    gold = ls.gold_figures()
    eye = load_eye()
    sets = load_sets(args.saved)
    caller = Caller(args)
    out = {}
    try:
        for s in sets:
            for mode in ("pipeline", "always"):
                entry = out.setdefault(
                    s["name"], {"paper": s["paper"], "kind": s["kind"]}
                )
                entry[mode] = await run_set(s, mode, det, gold, eye, caller)
    finally:
        billed = caller.save()
    (OUT / "results.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print("billed this process", round(billed, 4), "cached calls", len(caller.cache))
    summarise(out)


def summarise(out: dict) -> None:
    print(
        "| Run | Named | Order: figures, right, wrong | Pick: figures, right | Box | Pipeline whole, tight, both | Always pick whole, tight, both | Calls saved |"
    )
    print("|---|---|---|---|---|---|---|---|")
    totals: dict[str, list[dict]] = {}
    for name, entry in out.items():
        rows, always = entry["pipeline"], entry["always"]
        order = [r for r in rows if r["branch"] == "order"]
        pick = [r for r in rows if r["branch"] == "pick"]
        box = [r for r in rows if r["branch"] == "box"]
        t, o, q = tally(rows), tally(order), tally(pick)
        a = tally(always)
        calls_p = len({r["page"] for r in rows if r["branch"] != "order"})
        calls_a = len({r["page"] for r in always})
        print(
            f"| {name} | {t['named']} | {o['named']}, {o['right']}, {o['wrong']} "
            f"| {q['named']}, {q['right']} | {len(box)} | {t['whole']}, {t['tight']}, {t['both']} "
            f"| {a['whole']}, {a['tight']}, {a['both']} | {calls_a - calls_p} of {calls_a} |"
        )
        totals.setdefault(entry["kind"], []).append(entry)
    for kind, entries in totals.items():
        rows = [r for e in entries for r in e["pipeline"]]
        always = [r for e in entries for r in e["always"]]
        print(
            kind, "runs", len(entries), "pipeline", tally(rows), "always", tally(always)
        )
        for branch in ("order", "pick", "box"):
            print("  ", branch, tally([r for r in rows if r["branch"] == branch]))
        silent = [r for r in rows if r["branch"] == "order" and r.get("right") is False]
        print("   silent wrong in order:", len(silent))
        seen = {}
        for r in silent:
            k = (r["page"], r["label"], r["description"][:50], r["status"])
            seen[k] = seen.get(k, 0) + 1
        for k, v in sorted(seen.items()):
            print("     ", v, "x", k)


# ---------------------------------------------------------------------- traps

FAKE = {"label": "99", "description": "a diagram", "fake": True}


async def traps(args) -> None:
    """Window mistakes put on real names, one at a time, and what the pipeline
    does: a name left out, a name for something that is no figure, a name moved
    to the next or previous page, one name replaced by another, a page's names
    recorded out of order. A real name is right when it gets the boxes its
    unperturbed, checked run gave it. Counts that differ go to a real picking
    call. Counts that match are the failure nothing flags."""
    results = json.loads((OUT / "results.json").read_text())
    det = load_detections(args.detections)
    sets = {s["name"]: s for s in load_sets(args.saved)}
    caller = Caller(args)
    chosen = args.sets or [
        n
        for n, s in sets.items()
        if (n.endswith("-v41-1017-73") and s["kind"] == "scan")
        or n.endswith("-all-none-1")
        or n == "igcse-physics-0625-2023-sp2-all-none-3"
    ]
    cases: list[dict] = []
    jobs = []

    def case(s, kind, stem, listed, truth, about):
        async def run() -> None:
            number = int(stem.rsplit("-p", 1)[1])
            _, kept = boxes_of(det[stem])
            boxes = [c["box"] for c in kept]
            row = {"set": s["name"], "kind": kind, "page": stem, "about": about}
            if not boxes:
                row["route"] = "box"
                cases.append(row)
                return
            if len(boxes) == len(listed):
                row["route"] = "order"
                given = [[b] for b in boxes]
            else:
                row["route"] = "pick"
                got = await caller.pick(s["paper"], number, listed, boxes)
                picks = got["answer"] or [[] for _ in listed]
                given = [[boxes[n - 1] for n in pick] for pick in picks]
            wrong = []
            for f, boxes_given in zip(listed, given, strict=True):
                key = (stem, f["label"], f["description"])
                want = truth.get(key)
                if f.get("fake"):
                    if boxes_given:
                        wrong.append("the false name took a box")
                elif want is None:
                    if boxes_given:
                        wrong.append(f"Q{f['label']} took a box on the wrong page")
                elif boxes_given != want:
                    wrong.append(f"Q{f['label']} got the wrong box")
            row["wrong"] = wrong
            cases.append(row)

        jobs.append(run())

    for name in chosen:
        s = sets[name]
        truth = {
            (r["page"], r["label"], r["description"]): r["boxes"]
            for r in results[name]["pipeline"]
            if r.get("right")
        }
        pages = by_page(s["paper"], s["figures"])
        for stem, listed in pages.items():
            number = int(stem.rsplit("-p", 1)[1])
            if stem not in det:
                continue
            if len(listed) > 1:
                case(s, "out of order", stem, listed[::-1], truth, "")
            case(s, "extra name, first", stem, [FAKE, *listed], truth, "")
            case(s, "extra name, last", stem, [*listed, FAKE], truth, "")
            for i, f in enumerate(listed):
                rest = listed[:i] + listed[i + 1 :]
                if rest:
                    case(s, "left out", stem, rest, truth, f["label"])
                case(
                    s,
                    "replaced",
                    stem,
                    [*listed[:i], FAKE, *listed[i + 1 :]],
                    truth,
                    f["label"],
                )
                for step in (-1, 1):
                    other = stem_of(s["paper"], number + step)
                    if other in det:
                        here = pages.get(other, [])
                        moved = sorted(
                            [*here, f],
                            key=lambda g: s["figures"].index(g),
                        )
                        case(
                            s,
                            f"on the {'previous' if step < 0 else 'next'} page",
                            other,
                            moved,
                            truth,
                            f["label"],
                        )
    try:
        await asyncio.gather(*jobs)
    finally:
        billed = caller.save()
    (OUT / "traps.json").write_text(json.dumps(cases, indent=1, ensure_ascii=False))
    print("billed", round(billed, 4), "cases", len(cases))
    kinds = sorted({c["kind"] for c in cases})
    print(
        "| Mistake | Cases | Counts match | Of those wrong, nothing flags | Counts differ, picking call | Of those wrong | Box call |"
    )
    print("|---|---|---|---|---|---|---|")
    for kind in kinds:
        rows = [c for c in cases if c["kind"] == kind]
        order = [c for c in rows if c["route"] == "order"]
        pick = [c for c in rows if c["route"] == "pick"]
        print(
            f"| {kind} | {len(rows)} | {len(order)} | {sum(1 for c in order if c['wrong'])} "
            f"| {len(pick)} | {sum(1 for c in pick if c['wrong'])} "
            f"| {sum(1 for c in rows if c['route'] == 'box')} |"
        )
    print("silent, by page:")
    seen: dict = {}
    for c in cases:
        if c["route"] == "order" and c["wrong"]:
            seen.setdefault((c["kind"], c["page"]), set()).update(c["wrong"])
    for k, v in sorted(seen.items()):
        print("  ", k, sorted(v))


# ------------------------------------------------------------------ eye checks


def draw_pages(args) -> None:
    """Each page of a set with its assignments drawn: red boxes tagged with the
    question each was given, the branch beside it, and in grey the boxes nobody
    got. Six pages a sheet, for checking every crop against its question by eye."""
    from PIL import Image, ImageDraw, ImageFont

    results = json.loads((OUT / "results.json").read_text())
    det = load_detections(args.detections)
    entry = results[args.set]
    rows = entry["pipeline"]
    stems = sorted({r["page"] for r in rows})
    if args.only:
        stems = [st for st in stems if st in args.only]
    font = ImageFont.load_default(size=20)
    small = ImageFont.load_default(size=14)
    colours = [(220, 0, 0), (0, 70, 220), (0, 140, 60), (230, 120, 0), (150, 0, 170)]
    tiles = []
    for stem in stems:
        path = OUT / "pages" / f"{stem}.jpg"
        page = Image.open(path).convert("RGB")
        w, h = page.size
        draw = ImageDraw.Draw(page)
        _, kept = boxes_of(det.get(stem, []))
        used = []
        here = [r for r in rows if r["page"] == stem]
        for n, r in enumerate(here):
            colour = colours[n % len(colours)]
            target = r.get("crop")
            if not target:
                continue
            for b in r.get("boxes") or []:
                used.append(b)
            x0, y0, x1, y1 = ls.pad(target, 0)
            box = [x0 * w / 1000, y0 * h / 1000, x1 * w / 1000, y1 * h / 1000]
            draw.rectangle(box, outline=colour, width=4)
            tag = f"Q{r['label']} {r['branch']}"
            tw = draw.textlength(tag, font=font) + 10
            draw.rectangle([box[0], box[1], box[0] + tw, box[1] + 24], fill=colour)
            draw.text((box[0] + 5, box[1] + 1), tag, fill="white", font=font)
        for c in kept:
            if c["box"] not in used:
                b = c["box"]
                draw.rectangle(
                    [
                        b[0] * w / 1000,
                        b[1] * h / 1000,
                        b[2] * w / 1000,
                        b[3] * h / 1000,
                    ],
                    outline=(120, 120, 120),
                    width=3,
                )
        canvas = Image.new("RGB", (w, h + 60), "white")
        canvas.paste(page, (0, 60))
        line = (
            stem
            + "  names: "
            + "; ".join(f"Q{r['label']}: {r['description'][:44]}" for r in here)
        )
        d = ImageDraw.Draw(canvas)
        d.text((4, 2), line[:170], fill="black", font=small)
        d.text((4, 22), line[170:340], fill="black", font=small)
        canvas.thumbnail((720, 1040))
        tiles.append(canvas)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    per = 6
    for i in range(0, len(tiles), per):
        group = tiles[i : i + per]
        sheet = Image.new("RGB", (3 * 720, 2 * 1040), "white")
        for j, t in enumerate(group):
            sheet.paste(t, ((j % 3) * 720, (j // 3) * 1040))
        sheet.save(out / f"{args.set}-{i // per + 1}.jpg", "JPEG", quality=75)
    print(args.set, len(stems), "pages")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("detect")
    p.add_argument("--paper", required=True)
    p.add_argument("--pdf", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--pages")
    p.add_argument("--threads", type=int, default=4)
    p = sub.add_parser("match")
    p.add_argument("--saved")
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--env-file", required=True)
    p = sub.add_parser("traps")
    p.add_argument("--saved")
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--env-file", required=True)
    p.add_argument("--sets", nargs="*")
    p = sub.add_parser("pages")
    p.add_argument("set")
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--only", nargs="*")
    p.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.command == "detect":
        detect(args)
    elif args.command == "pages":
        draw_pages(args)
    elif args.command == "traps":
        bench.load_env(args.env_file)
        asyncio.run(traps(args))
    else:
        bench.load_env(args.env_file)
        asyncio.run(match(args))


if __name__ == "__main__":
    main()
