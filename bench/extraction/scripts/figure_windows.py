"""The window call picks each figure's box itself: a layout model runs first, and
the window gets the clean page images plus that model's boxes as JSON in the prompt
(Epo 2026-11-04). No second call and no matching step.

Before each window call, PP-DocLayout_plus-L's ``image`` and ``chart`` regions at
0.5 or more on the window's pages (one of any pair with an IoU of 0.8 or more, a
box dropped when it holds a smaller box plus text of its own) are numbered across
the window, and each page's text gets its boxes as JSON: number, page, 0-1000
coordinates, label and score. A figure is recorded by box numbers, with its part
and description. ``boxes: []`` with the page image means no box holds it, and only
that goes to the box call. A page with no boxes keeps today's behaviour. Code crops
the chosen boxes with an adjacent caption and a 1% pad.

Bench only: everything is monkeypatched around the production ``extraction.run``,
per job through a context variable, so one process runs several jobs at once.
``--variant none`` is the production code untouched, box call included. Nothing is
drawn on the page images.

    python -I figure_windows.py run --jobs 2021-p1:boxes:1 igcse-maths-0580-2025-sp2:none:2 \
        2022-p1@6-7:boxes:1 --scans <dir> --digital <dir> \
        --detections <pp-plus-l-onnx.json>... --env-file <keys> --parallel 4
    python -I figure_windows.py score --saved <study-extraction .results> --detections ...

A job is ``paper[@first-last]:variant:repeat``. Gold papers run with their mark
scheme and get ``run.score``; the rest run with none and get ``run.fidelity``.
Results land in ``.results/windows/``.
"""

from __future__ import annotations

import argparse
import asyncio
import contextvars
import copy
import dataclasses
import functools
import json
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import figure_matching as fm  # noqa: E402
import layout_score as ls  # noqa: E402
import run as bench  # noqa: E402

OUT = bench.RESULTS / "windows"
KATEX = Path("/Users/sam/web/capy-notebook/node_modules/katex")
SPEND_CAP = 1.9
AFTER_INSTALL = None

BOX_RULES = (
    "Figures: a layout model looked for pictures and charts on these pages. After "
    "each page's text comes what it found on that page, as JSON: each box's number "
    "(unique among these pages), page, coordinates [left, top, right, bottom] on a "
    "0-1000 grid of the page image (0, 0 is the top left corner), label and score. "
    "Boxes are hints from a model, not part of the page. For each diagram, graph, "
    "chart or photo a question needs, give boxes, the numbers of the boxes that hold "
    'it; the part whose text it follows ("" for the text shared by every part); and '
    "a few words on what it shows. A figure split across boxes (a diagram and its "
    "key, two shapes side by side) takes all of them. When boxes overlap, give the "
    "one that holds the whole figure and the least else. Leave out a box that holds "
    "no figure of a question you record, such as a figure of a question that is not "
    "on these pages. When no box holds a figure the question needs, give boxes [] "
    "and image, the page image it is on (counted from 1 in the order shown). The "
    "figure is cropped from the page into the quiz, so the blocks never describe it."
)


@dataclasses.dataclass
class State:
    """One job's context: what the patches read and fill."""

    variant: str
    paper: str
    det: dict
    served: list = dataclasses.field(default_factory=list)
    calls: list = dataclasses.field(default_factory=list)
    figures: list = dataclasses.field(default_factory=list)
    # The current window's boxes by number: (page number, region).
    window: dict = dataclasses.field(default_factory=dict)
    # The boxes behind each crop, by page and crop.
    chosen: dict = dataclasses.field(default_factory=dict)
    # Each window's boxes, for the report.
    windows: list = dataclasses.field(default_factory=list)
    box_calls: int = 0
    problems: list = dataclasses.field(default_factory=list)
    scheme_entries: list = dataclasses.field(default_factory=list)
    names: list = dataclasses.field(default_factory=list)
    # What another bench's patches keep for the result (paper_map.py).
    extra: dict = dataclasses.field(default_factory=dict)


STATE: contextvars.ContextVar[State] = contextvars.ContextVar("figure_window_job")


def box_json(state: State, number: int) -> str:
    rows = [
        {
            "box": n,
            "page": page,
            "coordinates": [round(v) for v in region["box"]],
            "label": region["label"],
            "score": round(region["score"], 2),
        }
        for n, (page, region) in state.window.items()
        if page == number
    ]
    return "Boxes on this page, as JSON: " + json.dumps(rows)


def install() -> None:
    """Wrap the production code once; a job with variant none passes through."""
    from pipeline.elitellm import client
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import extraction

    from pipeline import elitellm

    post, stream = client._post_json, client._stream_sse

    async def posted(url, headers, body, **kwargs):
        raw = await post(url, headers, body, **kwargs)
        STATE.get().served.append(
            {
                "provider": raw.get("provider"),
                "cost": (raw.get("usage") or {}).get("cost"),
            }
        )
        return raw

    async def streamed(url, headers, body):
        call = {"provider": None, "cost": None}
        STATE.get().served.append(call)
        async for event in stream(url, headers, body):
            call["provider"] = call["provider"] or event.get("provider")
            call["cost"] = (event.get("usage") or {}).get("cost", call["cost"])
            yield event

    client._post_json, client._stream_sse = posted, streamed

    tools = copy.deepcopy(prompts.TOOLS)
    item = {
        "type": "object",
        "properties": {
            "boxes": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "The numbers of the boxes that hold the figure; [] when no box does.",
            },
            "image": {
                "type": "integer",
                "minimum": 1,
                "description": "Only with boxes []: the page image it is on, counted from 1 in the order shown.",
            },
            "part": prompts._FIGURE["properties"]["part"],
            "description": prompts._FIGURE["properties"]["description"],
        },
        "required": ["boxes", "part", "description"],
    }
    for tool in tools:
        tool["function"]["parameters"]["properties"]["figures"]["items"] = item
    start = prompts.EXTRACT_SYSTEM.index("Figures: for each diagram")
    end = prompts.EXTRACT_SYSTEM.index("Each recorded question is checked at once.")
    system = (
        prompts.EXTRACT_SYSTEM[:start]
        + BOX_RULES
        + "\n\n"
        + prompts.EXTRACT_SYSTEM[end:]
    )

    complete_response = extraction.models.complete_response

    async def complete(messages, **kwargs):
        state = STATE.get()
        window_call = kwargs.get("call_purpose") == "extraction_window"
        if window_call and state.variant == "boxes":
            kwargs["tools"] = tools
        response = await complete_response(messages, **kwargs)
        if window_call:
            reply = elitellm.assistant_message_from_obj(
                elitellm.message_from_response(response)
            )
            state.calls.append(
                {
                    "finish": response.choices[0].finish_reason,
                    "output": response.usage.output_tokens,
                    "tool_calls": len(reply.get("tool_calls") or []),
                    "results": [],
                }
            )
        return response

    extraction.models.complete_response = complete

    page_text, window_messages = prompts.page_text, prompts.window_messages

    def text_with_boxes(image, number, file_name, text):
        state = STATE.get()
        out = page_text(image, number, file_name, text)
        return f"{out}\n{box_json(state, number)}" if state.variant == "boxes" else out

    def messages_with_rules(intro, pages):
        out = window_messages(intro, pages)
        if STATE.get().variant == "boxes":
            out[0]["content"] = system
        return out

    prompts.page_text, prompts.window_messages = text_with_boxes, messages_with_rules

    window = extraction._window

    async def numbered_window(run, pages, *, model):
        state = STATE.get()
        if state.variant == "boxes":
            state.window = {}
            for page in pages:
                regions = state.det.get(fm.stem_of(state.paper, page.number), [])
                for region in fm.boxes_of(regions)[1]:
                    state.window[len(state.window) + 1] = (page.number, region)
            state.windows.append(
                {"pages": [p.number for p in pages], "boxes": len(state.window)}
            )
        await window(run, pages, model=model)

    extraction._window = numbered_window

    read_figures = extraction.read_figures

    def figures_from_boxes(raw, pages, part_labels):
        state = STATE.get()
        if state.variant != "boxes" and not state.variant.startswith(("map", "copy")):
            return read_figures(raw, pages, part_labels)
        read = []
        parts = {extraction.label_key(label) for label in part_labels}
        for index, item in enumerate(raw if isinstance(raw, list) else []):
            name = f"figures[{index}]"
            item = item if isinstance(item, dict) else {}
            part = str(item.get("part") or "").strip()
            if part and extraction.label_key(part) not in parts:
                return [], (
                    f"{name}.part: the question has no part {part}; its parts are "
                    + ", ".join(label for label in part_labels if label)
                )
            description = " ".join(str(item.get("description") or "").split())
            boxes = item.get("boxes")
            boxes = boxes if isinstance(boxes, list) else []
            if not boxes:
                image = extraction._whole(item.get("image"))
                if image is None or not 1 <= image <= len(pages):
                    return [], (
                        f"{name}: with boxes [] give image, "
                        f"{' or '.join(str(n + 1) for n in range(len(pages)))}"
                    )
                read.append(extraction.Figure(pages[image - 1], part, description))
                continue
            unknown = [n for n in boxes if n not in state.window]
            if unknown:
                state.problems.append(f"unknown box {unknown}")
                return [], (
                    f"{name}.boxes: there is no box {unknown[0]} on these pages; the "
                    f"boxes are {', '.join(str(n) for n in state.window) or 'none'}"
                )
            on = {state.window[n][0] for n in boxes}
            if len(on) > 1:
                state.problems.append(f"boxes on two pages {boxes}")
                return [], f"{name}.boxes: a figure's boxes are on one page"
            number = on.pop()
            page = next(p for p in pages if p.number == number)
            regions = state.det[fm.stem_of(state.paper, number)]
            taken = [state.window[n][1]["box"] for n in boxes]
            crop = ls.pad(ls.attach(ls.around(taken), regions, fm.THRESHOLD), fm.PAD)
            state.chosen[(number, tuple(crop))] = {"numbers": boxes, "boxes": taken}
            read.append(extraction.Figure(page, part, description, crop))
        return read, None

    extraction.read_figures = figures_from_boxes

    locate_figures = extraction.locate_figures

    async def locate_the_rest(held, *, model):
        state = STATE.get()
        # What the windows named, before a failed box call leaves any of it out.
        state.names = [
            {
                "label": q.label,
                "page": f.page.number,
                "part": f.part,
                "description": f.description,
            }
            for q in held
            for f in q.figures
        ]
        if state.variant != "boxes" and not state.variant.startswith(("map", "copy")):
            state.box_calls += len({f.page.number for q in held for f in q.figures})
            return await locate_figures(held, model=model)
        # Only figures with no box go to the box call.
        stand_ins = {}
        for q in held:
            missing = [f for f in q.figures if f.box is None]
            if missing:
                stand_ins[id(q)] = dataclasses.replace(q, figures=missing)
        left_out = (
            await locate_figures(list(stand_ins.values()), model=model)
            if stand_ins
            else []
        )
        state.box_calls += len(
            {f.page.number for q in stand_ins.values() for f in q.figures}
        )
        for q in held:
            if id(q) not in stand_ins:
                continue
            located = list(stand_ins[id(q)].figures)
            merged = []
            for f in q.figures:
                if f.box is not None:
                    merged.append(f)
                    continue
                same = next(
                    (
                        g
                        for g in located
                        if g.page.number == f.page.number
                        and g.description == f.description
                        and g.part == f.part
                    ),
                    None,
                )
                if same is not None:
                    located.remove(same)
                    merged.append(same)
            q.figures = merged
        return left_out

    extraction.locate_figures = locate_the_rest

    place = extraction.placed

    async def placed(held, crops):
        out = await place(held, crops)
        state = STATE.get()
        for n, figure in enumerate(held.figures, 1):
            picked = state.chosen.get((figure.page.number, tuple(figure.box or [])))
            state.figures.append(
                {
                    "label": held.label,
                    "id": f"q{extraction.label_key(held.label)}-{n}",
                    "page": figure.page.number,
                    "box": figure.box,
                    "window_box": None,
                    "part": figure.part,
                    "description": figure.description,
                    "numbers": picked["numbers"] if picked else None,
                    "boxes": picked["boxes"] if picked else None,
                    "route": "window" if picked else "box call",
                    "bytes": len(
                        crops.get(f"q{extraction.label_key(held.label)}-{n}", "")
                    )
                    * 3
                    // 4,
                }
            )
        return out

    extraction.placed = placed

    add, extend = extraction.Run.add, extraction.Run.extend

    async def counted_add(self, item, window, pages_):
        result = await add(self, item, window, pages_)
        parts = len(item.get("parts") or []) if isinstance(item, dict) else 0
        STATE.get().calls[-1]["results"].append(
            ["record", bench._outcome(result), parts]
        )
        return result

    async def counted_extend(self, args_, window, pages_):
        result = await extend(self, args_, window, pages_)
        STATE.get().calls[-1]["results"].append(
            ["continue", bench._outcome(result), len(args_.get("parts") or [])]
        )
        return result

    extraction.Run.add, extraction.Run.extend = counted_add, counted_extend

    parse_schemes = extraction.parse_schemes

    async def kept_schemes(files, *, model, labels):
        pieces = await parse_schemes(files, model=model, labels=labels)
        STATE.get().scheme_entries.extend(
            dataclasses.asdict(e) for piece in pieces for e in piece
        )
        return pieces

    extraction.parse_schemes = kept_schemes

    def katex_errors(spans):
        proc = subprocess.run(
            ["node", "-e", bench._KATEX, str(KATEX)],
            input=json.dumps(spans),
            capture_output=True,
            text=True,
            check=True,
        )
        return [tuple(entry) for entry in json.loads(proc.stdout)]

    bench.katex_errors = katex_errors


def parse_job(text: str) -> dict:
    head, variant, repeat = text.split(":")
    paper, _, span = head.partition("@")
    return {
        "paper": paper,
        "span": span,
        "variant": variant,
        "repeat": int(repeat),
        "name": f"{paper}-{span or 'all'}-{variant}-{repeat}",
    }


def gold_of(paper: str) -> dict | None:
    path = bench.GOLD / f"{paper}.json"
    return json.loads(path.read_text()) if path.exists() else None


def pdf_of(paper: str, args) -> tuple[Path, str]:
    """The refs folder and the PDF's name in it."""
    digital = Path(args.digital)
    if (digital / paper / "paper.pdf").exists():
        return digital, f"{paper}/paper.pdf"
    merged = fm.OUT / "merged"
    if (merged / f"{paper}.pdf").exists():
        return merged, f"{paper}.pdf"
    return Path(args.scans), f"{paper}.pdf"


async def run_job(job: dict, args, det: dict, spend: fm.Spend) -> None:
    import pymupdf

    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, limits

    from pipeline import elitellm, obs

    out = OUT / f"{job['name']}.json"
    if out.exists():
        print("already done", job["name"], flush=True)
        return
    spend.check()
    state = State(job["variant"], job["paper"], det)
    STATE.set(state)
    gold = gold_of(job["paper"])
    refs, pdf_name = pdf_of(job["paper"], args)
    pdf = refs / pdf_name
    with pymupdf.open(pdf) as doc:
        count = len(doc)
    if job["span"]:
        numbers = fm.parse_pages(job["span"], count)
    elif gold:
        numbers = gold["pages"]
    else:
        numbers = list(range(1, count + 1))
    texts = await bench.page_texts(pdf, numbers, job["paper"])

    async def image(number: int) -> str:
        jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
        return capture.data_url(jpeg)

    async def crop(number: int, box: list[float]):
        jpeg, _box, size = capture.render(
            pdf, number, box, cfg.capture_max_edge, extraction.FIGURE_PAGE_EDGE
        )
        return jpeg, size

    pages = [
        extraction.Page(
            n,
            pdf_name,
            texts[n],
            functools.partial(image, n),
            functools.partial(crop, n),
        )
        for n in numbers
    ]
    schemes = []
    if gold and not job["span"]:
        answers = gold["answers"]
        if "pdf" in answers:
            with pymupdf.open(refs / answers["pdf"]) as doc:
                scheme_count = len(doc)
            scheme_pages = await bench.page_texts(
                refs / answers["pdf"],
                list(range(1, scheme_count + 1)),
                answers["pdf"].removesuffix(".pdf"),
            )
            schemes = [
                extraction.SchemeFile(
                    answers["pdf"],
                    "\n\n".join(scheme_pages[n] for n in sorted(scheme_pages)),
                )
            ]
        else:
            lines = [
                f"{q['label']}. {q['parts'][0]['correct']}" for q in gold["questions"]
            ]
            schemes = [extraction.SchemeFile("answers.txt", "\n".join(lines))]
    _, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec("openrouter", slug, name, rates, "low")
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
    usage = obs.start_usage()
    validate = bench.validator(bench.RESULTS / "quizcheck")
    recorded: list[dict] = []
    done: dict = {}
    started = time.monotonic()
    async for event in extraction.run(
        pages, schemes, model=model, validate=validate, locale="en"
    ):
        if event["type"] == "questions":
            recorded = copy.deepcopy(event["questions"])
        else:
            done = event
    seconds = time.monotonic() - started
    billed = sum(call["cost"] or 0 for call in state.served)
    spend.add(f"windows {job['variant']}", billed)
    result = {
        "name": job["name"],
        "paper": job["paper"],
        "pages": numbers,
        "variant": job["variant"],
        "repeat": job["repeat"],
        "model": f"openrouter/{slug}",
        "seconds": round(seconds, 1),
        "usage": usage.as_dict(),
        "providers": {
            p: sum(1 for c in state.served if c["provider"] == p)
            for p in sorted({c["provider"] for c in state.served if c["provider"]})
        },
        "billed_usd": round(billed, 4),
        "recorded": recorded,
        "questions": done["questions"],
        "report": done["report"],
        "scheme_entries": state.scheme_entries,
        "figures": state.figures,
        "names": state.names,
        "window_pages": extraction.WINDOW_PAGES,
        "calls": state.calls,
        "windows": state.windows,
        "box_calls": state.box_calls,
        "problems": state.problems,
        **state.extra,
    }
    try:
        if gold and not job["span"]:
            result["scores"] = bench.score(result, gold, refs)
        else:
            stand_in = {
                "paper": job["paper"],
                "pdf": pdf_name,
                "pages": numbers,
                "answers": {},
                "questions": [],
            }
            result["scores"] = {
                "fidelity": bench.fidelity(result, stand_in, refs),
                "window": bench.window_scores(result),
            }
    except Exception as exc:  # noqa: BLE001  (a scoring bug must not lose a paid run)
        result["scores"] = {"error": repr(exc)}
    OUT.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False))
    print(
        job["name"],
        f"{result['seconds']}s ${result['billed_usd']}",
        "questions",
        len(result["report"]["recorded"]),
        "figures",
        len(state.figures),
        "box calls",
        state.box_calls,
        "stopped",
        repr(result["report"]["stopped"]),
        "spent",
        spend.data["usd"],
        flush=True,
    )


async def run_jobs(args) -> None:
    fm.SPEND_CAP = SPEND_CAP
    install()
    if AFTER_INSTALL:
        AFTER_INSTALL()
    det = fm.load_detections(args.detections)
    # A page's boxes from another run of the detector, read after the rest.
    for path in args.override or []:
        for page in json.loads(Path(path).read_text())["pages"]:
            det[page["page"]] = page["regions"]
    spend = fm.Spend()
    binary = bench.RESULTS / "quizcheck"
    if not binary.exists():
        bench.quizcheck()
    jobs = [parse_job(text) for text in args.jobs]
    # Each paper's page reads once, before the jobs share them.
    for paper in sorted({job["paper"] for job in jobs}):
        state = State("none", paper, det)
        STATE.set(state)
        refs, pdf_name = pdf_of(paper, args)
        gold = gold_of(paper)
        count = 0
        import pymupdf

        with pymupdf.open(refs / pdf_name) as doc:
            count = len(doc)
        await bench.page_texts(
            refs / pdf_name, gold["pages"] if gold else list(range(1, count + 1)), paper
        )
        spend.add("page reads", sum(c["cost"] or 0 for c in state.served))
    gate = asyncio.Semaphore(args.parallel)

    async def guarded(job):
        async with gate:
            try:
                await run_job(job, args, det, spend)
            except Exception as exc:  # noqa: BLE001
                print("FAILED", job["name"], repr(exc)[:300], flush=True)

    await asyncio.gather(*(asyncio.create_task(guarded(job)) for job in jobs))


# -------------------------------------------------------------------- scoring


def job_rows(result: dict, det: dict, gold: dict, eye: dict) -> dict:
    """Each named figure of a run, scored; and the gold or eye figures on its
    pages that no name claimed."""
    paper = result["paper"]
    rows = []
    claimed: dict[str, set] = {}
    for stem, listed in fm.by_page(paper, result["figures"]).items():
        regions = det.get(stem, [])
        found, kept = fm.boxes_of(regions)
        boxes = [c["box"] for c in kept]
        goldfs = fm.identify(listed, stem, gold)
        for f, g in zip(listed, goldfs, strict=True):
            if g is not None:
                claimed.setdefault(stem, set()).add(id(g))
            chosen = f.get("boxes")
            if chosen:
                row = fm.score_row(
                    f, g, "pick", chosen, found, boxes, regions, stem, gold, eye
                )
                row["route"] = "window"
                row["numbers"] = f.get("numbers")
            else:
                row = fm.score_row(
                    f, g, "box", [f["box"]], found, boxes, regions, stem, gold, eye
                )
                row["route"] = "box call"
            rows.append(row)
    unnamed = []
    for number in result.get("pages") or sorted({f["page"] for f in result["figures"]}):
        stem = fm.stem_of(paper, number)
        for g in gold.get(stem, []):
            if id(g) not in claimed.get(stem, set()):
                unnamed.append(f"{stem} Q{g['label']}")
        names = {fm.question_key(r["label"]) for r in rows if r["page"] == stem}
        for entry in eye.get(stem, []):
            if entry["label"] and fm.question_key(entry["label"]) not in names:
                unnamed.append(f"{stem} Q{entry['label']}")
    return {"rows": rows, "unnamed": unnamed}


def _ratio(text) -> tuple[int, int]:
    if not text:
        return 0, 0
    a, _, b = str(text).partition("/")
    return int(a), int(b or 0)


def reading(result: dict) -> dict:
    """What the bench's checks say about one run's text."""
    s = result.get("scores") or {}
    f = s.get("fidelity") or {}
    w = s.get("window") or {}
    usage = result.get("usage") or {}
    return {
        "labels": f"{len(result['report']['recorded'])}",
        "missing": result["report"].get("missing"),
        "recall": s.get("label_recall"),
        "structure": s.get("part_structure"),
        "marks": s.get("part_marks_exact"),
        "total_marks": s.get("question_marks_total"),
        "mcq_worked": s.get("mcq_worked_out_key_right"),
        "worked_marks": s.get("worked_out_part_marks_right"),
        "mcq_gold": s.get("mcq_key_matches_gold"),
        "disagreements": len(s.get("key_disagreements") or []),
        "marks_differ": len(result["report"].get("marksDiffer") or []),
        "numbers": f.get("numbers"),
        "unsupported": f.get("numbers_unsupported"),
        "dropped": f.get("numbers_dropped"),
        "units_off": (f.get("units_unsupported") or 0) + (f.get("units_dropped") or 0),
        "exact": f"{f.get('questions_exact')}/{f.get('questions_compared')}",
        "worst": f.get("worst"),
        "katex": (f.get("latex") or {}).get("katex_errors"),
        "stray": (f.get("latex") or {}).get("texts_with_a_stray_dollar"),
        "seconds": result.get("seconds"),
        "billed": result.get("billed_usd"),
        "input": usage.get("inputTokens"),
        "cached": usage.get("cachedReadTokens"),
        "output": usage.get("outputTokens"),
        "reasoning": usage.get("reasoningTokens"),
        "calls": usage.get("calls"),
        "window_output_per_page": w.get("window_output_per_page"),
        "re_asks": w.get("re_asks"),
        "cut_off": w.get("cut_off"),
        "refused": (w.get("results") or {}).get("refused", 0),
        "stopped": result["report"].get("stopped"),
    }


def printed_numbers(result: dict, refs: Path, det: dict) -> dict:
    """On a PDF with a text layer whose labels run.fidelity cannot split (the
    IGCSE papers): each question's printed text is the words from its number in
    the left margin to the next one, outside the layout boxes and the page's top
    and bottom, and its numbers are compared with the saved question's."""
    import pymupdf

    from pipeline.retrieval.extraction import label_key

    chunks: dict[str, list[str]] = {}
    current = None
    with pymupdf.open(refs / result["paper"] / "paper.pdf") as doc:
        for number in result["pages"]:
            page = doc[number - 1]
            w, h = page.rect.width, page.rect.height
            kept = fm.boxes_of(det.get(fm.stem_of(result["paper"], number), []))[1]
            lines: dict[tuple, list] = {}
            for word in page.get_text("words"):
                lines.setdefault((word[5], word[6]), []).append(word)
            for line in sorted(lines.values(), key=lambda ws: (ws[0][1], ws[0][0])):
                top = line[0][1] / h * 1000
                if top < 45 or top > 930:
                    continue
                first = line[0]
                if first[0] < 0.12 * w and first[4].isdigit():
                    current = label_key(first[4])
                    chunks.setdefault(current, [])
                    line = line[1:]
                for word in line:
                    mid = [
                        (word[0] + word[2]) / 2 / w * 1000,
                        (word[1] + word[3]) / 2 / h * 1000,
                    ]
                    inside = any(
                        c["box"][0] <= mid[0] <= c["box"][2]
                        and c["box"][1] <= mid[1] <= c["box"][3]
                        for c in kept
                    )
                    if current is not None and not inside:
                        chunks[current].append(word[4])
    unsupported, dropped, compared = {}, {}, 0
    for label, question in zip(
        result["report"]["recorded"], result["questions"], strict=False
    ):
        key = label_key(label)
        if key not in chunks:
            continue
        compared += 1
        printed = bench.numbers(
            re.sub(r"\[\d+\]", " ", bench.plain(" ".join(chunks[key])))
        )
        saved = bench.numbers(bench.plain(bench.question_text(question)))
        extra = sorted((saved - printed).elements())
        lost = sorted((printed - saved).elements())
        if extra:
            unsupported[label] = extra
        if lost:
            dropped[label] = lost
    return {"compared": compared, "unsupported": unsupported, "dropped": dropped}


def compare_text(a: dict, b: dict) -> dict:
    """Two runs of a paper, question by question: labels only one has, and
    questions whose numbers differ."""
    from pipeline.retrieval.extraction import label_key

    def of(result):
        return {
            label_key(label): q
            for label, q in zip(
                result["report"]["recorded"], result["questions"], strict=False
            )
        }

    qa, qb = of(a), of(b)
    differ = []
    for key in sorted(set(qa) & set(qb)):
        if bench.numbers(bench.question_text(qa[key])) != bench.numbers(
            bench.question_text(qb[key])
        ):
            differ.append(key)
    return {
        "only_a": sorted(set(qa) - set(qb)),
        "only_b": sorted(set(qb) - set(qa)),
        "common": len(set(qa) & set(qb)),
        "numbers_differ": differ,
    }


def score(args) -> None:
    det = fm.load_detections(args.detections)
    gold = ls.gold_figures()
    eye = fm.load_eye()
    jobs = [
        json.loads(p.read_text())
        for p in sorted(OUT.glob("*.json"))
        if p.name != "summary.json"
    ]
    jobs = [j for j in jobs if "variant" in j]
    full = [j for j in jobs if f"-all-{j['variant']}-" in j["name"]]
    cuts = [j for j in jobs if j not in full]
    saved = Path(args.saved)
    papers = sorted({j["paper"] for j in full})
    groups = {
        "scan": ["2021-p1", "2022-p1", "2022-p2", "2024-p1"],
        "digital": [p for p in papers if p.startswith("igcse")],
        "new": ["2021-p2", "2023-p2", "2025-p2"],
    }
    baseline: dict[str, list[dict]] = {}
    for paper in papers:
        runs = [j for j in full if j["paper"] == paper and j["variant"] == "none"]
        if not runs:
            for n in ("81-w2", "82-w2"):
                path = saved / f"{paper}-v41-1017-{n}.json"
                if path.exists():
                    data = json.loads(path.read_text())
                    data["pages"] = None
                    runs.append(data)
        baseline[paper] = runs
    summary = {"figures": {}, "jobs": {}, "reading": {}}
    for kind, group in groups.items():
        window_rows, box_rows, unnamed_w, unnamed_b = [], [], [], []
        for paper in group:
            for j in full:
                if j["paper"] == paper and j["variant"] == "boxes":
                    r = job_rows(j, det, gold, eye)
                    window_rows += r["rows"]
                    unnamed_w += r["unnamed"]
                    summary["jobs"][j["name"]] = r
            for j in baseline.get(paper, []):
                r = job_rows(j, det, gold, eye)
                box_rows += r["rows"]
                unnamed_b += r["unnamed"]
        print(f"\n== {kind}")
        print("window picks:", fm.tally(window_rows), "unnamed", len(unnamed_w))
        print(
            "  by route:",
            {
                k: fm.tally([r for r in window_rows if r["route"] == k])
                for k in ("window", "box call")
            },
        )
        print(
            "  scans whole/tight:",
            {
                paper: fm.tally(
                    [r for r in window_rows if r["page"].startswith(paper + "-p")]
                )
                for paper in group
            },
        )
        print("today's box call:", fm.tally(box_rows), "unnamed", len(unnamed_b))
        wrong = {}
        for r in window_rows:
            if (
                r.get("right") is False
                or r.get("whole") is False
                or r.get("tight") is False
                or r.get("right") is None
            ):
                k = (
                    r["page"],
                    r["label"],
                    r["description"][:48],
                    r["route"],
                    r["status"],
                    str(r.get("numbers")),
                    r.get("right"),
                    r.get("whole"),
                    r.get("tight"),
                )
                wrong[k] = wrong.get(k, 0) + 1
        for k, v in sorted(wrong.items(), key=str):
            print("   ", v, "x", k)
        print(
            "   unnamed:",
            sorted(set(unnamed_w)),
            "| baseline unnamed:",
            sorted(set(unnamed_b)),
        )
    print("\n== head to head on the same names, gold and eye crops apart")
    results_path = fm.OUT / "results.json"
    matched = json.loads(results_path.read_text()) if results_path.exists() else {}

    def named_runs(paper: str) -> list[str]:
        names = [f"{paper}-v41-1017-{n}" for n in ("81-w2", "82-w2")]
        names += [f"{paper}-all-none-{n}" for n in (1, 2, 3, 4)]
        return [n for n in names if n in matched]

    for kind, group in groups.items():
        rows: dict[str, list[dict]] = {
            "window": [],
            "box": [],
            "order": [],
            "always": [],
        }
        for paper in group:
            for j in full:
                if j["paper"] == paper and j["variant"] == "boxes":
                    rows["window"] += job_rows(j, det, gold, eye)["rows"]
            for j in baseline.get(paper, []):
                rows["box"] += job_rows(j, det, gold, eye)["rows"]
            for name in named_runs(paper):
                rows["order"] += matched[name]["pipeline"]
                rows["always"] += matched[name]["always"]
        for name, listed in rows.items():
            for status in ("gold", "eye", "extra name", "unchecked", "no box"):
                part = [r for r in listed if r.get("status") == status]
                if part:
                    print(kind, name, status, fm.tally(part))
        order = [r for r in rows["order"] if r.get("branch") == "order"]
        pick = [r for r in rows["order"] if r.get("branch") == "pick"]
        print(kind, "order branch", fm.tally(order), "pick branch", fm.tally(pick))
    print("\n== reading, each run")
    fields = (
        "labels",
        "recall",
        "structure",
        "marks",
        "total_marks",
        "mcq_worked",
        "worked_marks",
        "mcq_gold",
        "disagreements",
        "marks_differ",
        "numbers",
        "unsupported",
        "dropped",
        "units_off",
        "exact",
        "katex",
        "stray",
        "refused",
        "re_asks",
        "cut_off",
        "stopped",
        "seconds",
        "billed",
        "input",
        "cached",
        "output",
        "reasoning",
        "calls",
        "window_output_per_page",
    )
    print("paper variant " + " ".join(fields))
    for paper in papers:
        for label, runs in (
            ("none", baseline.get(paper, [])),
            (
                "boxes",
                [j for j in full if j["paper"] == paper and j["variant"] == "boxes"],
            ),
        ):
            for j in runs:
                r = reading(j)
                print(paper, label, " ".join(str(r[k]) for k in fields))
                if paper.startswith("igcse"):
                    n = printed_numbers(j, Path(args.digital), det)
                    print(
                        "    printed: compared",
                        n["compared"],
                        "unsupported",
                        sum(len(v) for v in n["unsupported"].values()),
                        "dropped",
                        sum(len(v) for v in n["dropped"].values()),
                        json.dumps(n["unsupported"], ensure_ascii=False)[:300],
                        json.dumps(n["dropped"], ensure_ascii=False)[:300],
                    )
                elif r["worst"]:
                    print(
                        "    worst:", json.dumps(r["worst"], ensure_ascii=False)[:500]
                    )
    print(
        "\n== text between runs: labels only one run has, questions whose numbers differ"
    )
    for paper in papers:
        none = baseline.get(paper, [])
        boxes = [j for j in full if j["paper"] == paper and j["variant"] == "boxes"]
        pairs = []
        if len(none) > 1:
            pairs.append(("none-none", none[0], none[1]))
        if len(boxes) > 1:
            pairs.append(("boxes-boxes", boxes[0], boxes[1]))
        pairs += [("none-boxes", a, b) for a in none for b in boxes]
        for name, a, b in pairs:
            c = compare_text(a, b)
            print(
                paper,
                name,
                c["only_a"],
                c["only_b"],
                "of",
                c["common"],
                c["numbers_differ"],
            )
    print("\n== page selections that cut questions")
    for j in sorted(cuts, key=lambda j: j["name"]):
        r = job_rows(j, det, gold, eye)
        print(
            j["name"],
            "recorded",
            j["report"]["recorded"],
            "windows",
            j.get("windows"),
            "problems",
            j.get("problems"),
            "box calls",
            j.get("box_calls"),
        )
        for row in r["rows"]:
            print(
                "   ",
                row["page"],
                "Q" + row["label"],
                row["route"],
                row.get("numbers"),
                row["status"],
                "right",
                row.get("right"),
                "whole",
                row.get("whole"),
                "tight",
                row.get("tight"),
                "|",
                row["description"][:60],
            )
        print("    unnamed:", r["unnamed"])
    (OUT / "summary.json").write_text(
        json.dumps(summary, indent=1, ensure_ascii=False, default=str)
    )


def sheet(args) -> None:
    """The window picks' crops that are not whole or not tight, once each, gold
    box green where there is one and crop red."""
    import io

    from PIL import Image, ImageDraw, ImageFont

    det = fm.load_detections(args.detections)
    gold = ls.gold_figures()
    eye = fm.load_eye()
    seen, tiles = set(), []
    for path in sorted(OUT.glob("*-all-boxes-*.json")):
        job = json.loads(path.read_text())
        for row in job_rows(job, det, gold, eye)["rows"]:
            key = (row["page"], row["label"], tuple(row.get("crop") or []))
            if key in seen or (row["whole"] and row["tight"]):
                continue
            seen.add(key)
            page = Image.open(fm.OUT / "pages" / f"{row['page']}.jpg").convert("RGB")
            w, h = page.size
            draw = ImageDraw.Draw(page)
            goldf = fm.identify([row], row["page"], gold)[0]
            area = list(row["crop"])
            if goldf:
                draw.rectangle(fm_px(goldf["box"], w, h), outline=(0, 170, 0), width=3)
                area = ls.around([area, goldf["box"]])
            draw.rectangle(fm_px(row["crop"], w, h), outline=(220, 0, 0), width=3)
            tile = page.crop([round(v) for v in fm_px(ls.pad(area, 25), w, h)])
            tile.thumbnail((420, 300))
            canvas = Image.new("RGB", (420, 322), "white")
            canvas.paste(tile, (0, 22))
            verdict = (
                ("whole" if row["whole"] else "not whole")
                + ", "
                + ("tight" if row["tight"] else "loose")
            )
            ImageDraw.Draw(canvas).text(
                (4, 4),
                f"{row['page'][-22:]} Q{row['label']}: {verdict}",
                fill="black",
                font=ImageFont.load_default(12),
            )
            tiles.append(canvas)
    rows = (len(tiles) + 2) // 3
    out = Image.new("RGB", (3 * 420, rows * 322), "white")
    for i, t in enumerate(tiles):
        out.paste(t, ((i % 3) * 420, (i // 3) * 322))
    buffer = io.BytesIO()
    out.save(buffer, "JPEG", quality=70)
    Path(args.out).write_bytes(buffer.getvalue())
    print(args.out, len(tiles), "crops", len(buffer.getvalue()), "bytes")


def fm_px(box: list[float], w: int, h: int) -> list[float]:
    return [box[0] * w / 1000, box[1] * h / 1000, box[2] * w / 1000, box[3] * h / 1000]


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run")
    p.add_argument("--jobs", nargs="+", required=True)
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--env-file", required=True)
    p.add_argument("--parallel", type=int, default=4)
    p.add_argument("--override", nargs="*")
    p = sub.add_parser("score")
    p.add_argument("--saved", required=True)
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--digital", required=True)
    p = sub.add_parser("sheet")
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.command == "score":
        score(args)
    elif args.command == "sheet":
        sheet(args)
    else:
        bench.load_env(args.env_file)
        asyncio.run(run_jobs(args))


if __name__ == "__main__":
    main()
