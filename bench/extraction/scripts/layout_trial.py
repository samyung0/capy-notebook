"""Layout-first figure picking end to end: the layout service over HTTP
(``layout/app.py``), the real ``extraction.run``, and the bench's scores.

The service runs in its own venv with the model file (``layout/requirements.in``);
this script runs in the root venv and reaches it through CAPY_LAYOUT_URL and
CAPY_LAYOUT_TOKEN, as retrieval does. The wrappers below only record what the code
did; none changes it.

    python -I layout_trial.py run --tag frozen --parallel 3 \
        --scans <dir> --digital <dir> --env-file <keys> \
        --jobs 2021-p1:1 igcse-maths-0580-2025-sp2:1 igcse-biology-0610-2023-sp4@2-17:1
    python -I layout_trial.py run ... --kill-pid <pid> --kill-after-pages 5
    python -I layout_trial.py run ... --flood 16
    python -I layout_trial.py score --tag frozen --digital <dir>
    python -I layout_trial.py sheet --tag frozen --name 2021-p1-all-w2-1

A job is ``paper[@first-last]:repeat``. Gold papers run with their mark scheme and
get ``run.score``; the rest run with none and get ``run.fidelity``. Results land in
``.results/trial/<tag>/``. A finished job is not run again. Keys are read into the
process only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextvars
import copy
import dataclasses
import functools
import html
import json
import os
import re
import signal
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import figure_matching as fm  # noqa: E402
import layout_score as ls  # noqa: E402
import run as bench  # noqa: E402  (puts the pipeline on the path)

OUT = bench.RESULTS / "trial"
GROUPS = {
    "HKDSE gold scans": ["2021-p1", "2022-p1", "2022-p2", "2024-p1"],
    "IGCSE born-digital": [
        "igcse-biology-0610-2023-sp4",
        "igcse-maths-0580-2025-sp2",
        "igcse-physics-0625-2023-sp2",
    ],
    "HKDSE by eye": ["2021-p2", "2023-p2", "2025-p2"],
}


@dataclasses.dataclass
class State:
    """One job's record."""

    served: list = dataclasses.field(default_factory=list)
    calls: list = dataclasses.field(default_factory=list)
    figures: list = dataclasses.field(default_factory=list)
    names: list = dataclasses.field(default_factory=list)
    chosen: dict = dataclasses.field(default_factory=dict)
    regions: list = dataclasses.field(default_factory=list)
    layout_seconds: float = 0.0
    box_call_pages: int = 0
    scheme_entries: list = dataclasses.field(default_factory=list)
    # The map call's user message, images as <image: page N>.
    sent: list = dataclasses.field(default_factory=list)


def without_images(content: list[dict]) -> list[dict]:
    out, page = [], "?"
    for item in content:
        if item["type"] == "text":
            found = re.search(r"Page image \d+: page (\d+) of", item["text"])
            page = found.group(1) if found else page
            out.append(item["text"])
        else:
            out.append(f"<image: page {page}>")
    return out


STATE: contextvars.ContextVar[State] = contextvars.ContextVar("layout_trial_job")


def install() -> None:
    from pipeline import elitellm
    from pipeline.elitellm import client
    from pipeline.retrieval import extraction

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

    complete_response = extraction.models.complete_response

    async def complete(messages, **kwargs):
        if kwargs.get("call_purpose") == "extraction_map":
            STATE.get().sent.append(without_images(messages[1]["content"]))
        response = await complete_response(messages, **kwargs)
        if kwargs.get("call_purpose") in ("extraction_copy", "extraction_solve"):
            reply = elitellm.assistant_message_from_obj(
                elitellm.message_from_response(response)
            )
            STATE.get().calls.append(
                {
                    "finish": response.choices[0].finish_reason,
                    "output": response.usage.output_tokens,
                    "tool_calls": len(reply.get("tool_calls") or []),
                    "results": [],
                }
            )
        return response

    extraction.models.complete_response = complete

    read_regions = extraction.layout.read_regions

    async def timed_regions(images):
        started = time.monotonic()
        found = await read_regions(images)
        state = STATE.get()
        state.layout_seconds = round(time.monotonic() - started, 2)
        state.regions = found
        return found

    extraction.layout.read_regions = timed_regions

    read_figures = extraction.read_figures

    def figures_with_picks(raw, pages, part_labels, boxes):
        read, problem = read_figures(raw, pages, part_labels, boxes)
        if not problem:
            state = STATE.get()
            for item, figure in zip(raw or [], read):
                if figure.box is not None:
                    numbers = item["boxes"]
                    state.chosen[(figure.page.number, tuple(figure.box))] = {
                        "numbers": numbers,
                        "boxes": [boxes[n][1].box for n in numbers],
                    }
        return read, problem

    extraction.read_figures = figures_with_picks

    locate_figures = extraction.locate_figures

    async def located(held, *, model):
        state = STATE.get()
        # What the windows named, before a failed box call leaves any of it out.
        state.names = [
            {
                "label": q.label,
                "page": f.page.number,
                "part": f.part,
                "description": f.description,
                "picked": f.box is not None,
            }
            for q in held
            for f in q.figures
        ]
        state.box_call_pages += len(
            {id(f.page) for q in held for f in q.figures if f.box is None}
        )
        return await locate_figures(held, model=model)

    extraction.locate_figures = located

    place = extraction.placed

    async def placed(held, crops):
        out = await place(held, crops)
        state = STATE.get()
        for n, figure in enumerate(held.figures, 1):
            picked = state.chosen.get((figure.page.number, tuple(figure.box or [])))
            figure_id = f"q{extraction.label_key(held.label)}-{n}"
            state.figures.append(
                {
                    "label": held.label,
                    "id": figure_id,
                    "page": figure.page.number,
                    "box": figure.box,
                    "part": figure.part,
                    "description": figure.description,
                    "numbers": picked["numbers"] if picked else None,
                    "boxes": picked["boxes"] if picked else None,
                    "route": "window" if picked else "box call",
                    "bytes": len(crops.get(figure_id, "")) * 3 // 4,
                }
            )
        return out

    extraction.placed = placed

    copy_question = extraction.Run.copy_question
    record_answers = extraction.Run.record_answers

    async def counted_copy(self, item, pages_):
        result = await copy_question(self, item, pages_)
        STATE.get().calls[-1]["results"].append(
            ["record", bench._outcome(result), len(item.get("parts") or [])]
        )
        return result

    async def counted_answers(self, args_, pages_):
        result = await record_answers(self, args_, pages_)
        STATE.get().calls[-1]["results"].append(
            ["answers", bench._outcome(result), len(args_.get("parts") or [])]
        )
        return result

    extraction.Run.copy_question = counted_copy
    extraction.Run.record_answers = counted_answers

    parse_schemes = extraction.parse_schemes

    async def kept_schemes(files, *, model, labels):
        pieces = await parse_schemes(files, model=model, labels=labels)
        STATE.get().scheme_entries.extend(
            dataclasses.asdict(e) for piece in pieces for e in piece
        )
        return pieces

    extraction.parse_schemes = kept_schemes


def parse_job(text: str) -> dict:
    head, repeat = text.split(":")
    paper, _, span = head.partition("@")
    return {
        "paper": paper,
        "span": span,
        "repeat": int(repeat),
        "name": f"{paper}-{span or 'all'}-{repeat}",
    }


def gold_of(paper: str) -> dict | None:
    path = bench.GOLD / f"{paper}.json"
    return json.loads(path.read_text()) if path.exists() else None


def pdf_of(paper: str, args) -> tuple[Path, str]:
    """The refs folder and the PDF's name in it."""
    digital = Path(args.digital)
    if (digital / paper / "paper.pdf").exists():
        return digital, f"{paper}/paper.pdf"
    return Path(args.scans), f"{paper}.pdf"


async def scheme_files(gold: dict, refs: Path) -> list:
    import pymupdf

    from pipeline.retrieval import extraction

    answers = gold["answers"]
    if "pdf" in answers:
        with pymupdf.open(refs / answers["pdf"]) as doc:
            count = len(doc)
        pages = await bench.page_texts(
            refs / answers["pdf"],
            list(range(1, count + 1)),
            answers["pdf"].removesuffix(".pdf"),
        )
        text = "\n\n".join(pages[n] for n in sorted(pages))
        return [extraction.SchemeFile(answers["pdf"], text)]
    lines = [f"{q['label']}. {q['parts'][0]['correct']}" for q in gold["questions"]]
    return [extraction.SchemeFile("answers.txt", "\n".join(lines))]


async def run_job(job: dict, args, out_dir: Path) -> None:
    import pymupdf

    from pipeline import elitellm, obs
    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, limits

    out = out_dir / f"{job['name']}.json"
    if out.exists():
        print("already done", job["name"], flush=True)
        return
    state = State()
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

    layers = extraction.page_layers(pdf, {n: texts[n] for n in numbers})
    pages = [
        extraction.Page(
            n,
            pdf_name,
            texts[n],
            functools.partial(image, n),
            functools.partial(crop, n),
            layer=layers[n],
        )
        for n in numbers
    ]
    schemes = await scheme_files(gold, refs) if gold and not job["span"] else []
    _, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec("openrouter", slug, name, rates, "low")
    # As the service binds them.
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
    crops = out_dir / "crops" / job["name"]
    crops.mkdir(parents=True, exist_ok=True)
    for figure in done["figures"]:
        (crops / f"{figure['id']}.jpg").write_bytes(base64.b64decode(figure["image"]))
    result = {
        "name": job["name"],
        "paper": job["paper"],
        "pages": numbers,
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
        "calls": state.calls,
        "box_call_pages": state.box_call_pages,
        "layout_seconds": state.layout_seconds,
        "sent": state.sent,
        "regions": {
            fm.stem_of(job["paper"], page.number): [
                dataclasses.asdict(region) for region in found
            ]
            for page, found in zip(pages, state.regions)
        },
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
    out_dir.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False))
    routes = [figure["route"] for figure in state.figures]
    print(
        job["name"],
        f"{result['seconds']}s ${result['billed_usd']}",
        "layout",
        state.layout_seconds,
        "questions",
        len(result["report"]["recorded"]),
        "figures",
        len(routes),
        "by box call",
        routes.count("box call"),
        "left out",
        result["report"]["figuresLeftOut"],
        "stopped",
        repr(result["report"]["stopped"]),
        flush=True,
    )


def kill_after(pages: int, pid: int) -> None:
    """The service stops, SIGKILL, once this many pages have answered."""
    from pipeline.retrieval import layout

    real = layout._page
    answered = 0

    async def page(client, jpeg):
        nonlocal answered
        found = await real(client, jpeg)
        answered += 1
        if answered == pages:
            print("killing the layout service after", pages, "pages", flush=True)
            os.kill(pid, signal.SIGKILL)
        return found

    layout._page = page


async def flood(tasks: int, jpeg: bytes, stop: asyncio.Event) -> dict[str, int]:
    """Requests with no pause but a breath, until ``stop``; what they got."""
    import httpx

    from pipeline.config import cfg

    seen: dict[str, int] = {}

    async def one(client: httpx.AsyncClient) -> None:
        while not stop.is_set():
            try:
                response = await client.post(
                    f"{cfg.layout_url}/regions",
                    content=jpeg,
                    headers={"Authorization": f"Bearer {cfg.layout_token}"},
                )
                key = str(response.status_code)
            except httpx.HTTPError as exc:
                key = type(exc).__name__
            seen[key] = seen.get(key, 0) + 1
            await asyncio.sleep(0.05)

    async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
        await asyncio.gather(*(one(client) for _ in range(tasks)))
    return seen


async def run_jobs(args) -> None:
    from pipeline.retrieval import capture, extraction

    install()
    if args.kill_pid:
        kill_after(args.kill_after_pages, args.kill_pid)
    binary = bench.RESULTS / "quizcheck"
    if not binary.exists():
        bench.quizcheck()
    out_dir = OUT / args.tag
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = [parse_job(text) for text in args.jobs]
    gate = asyncio.Semaphore(args.parallel)

    async def guarded(job):
        async with gate:
            try:
                await run_job(job, args, out_dir)
            except Exception as exc:  # noqa: BLE001
                print("FAILED", job["name"], repr(exc)[:300], flush=True)

    stop = asyncio.Event()
    pounding = None
    if args.flood:
        import pymupdf

        refs, pdf_name = pdf_of(jobs[0]["paper"], args)
        with pymupdf.open(refs / pdf_name) as doc:
            count = len(doc)
        jpeg, _box, _size = capture.render(refs / pdf_name, min(2, count), None, 1568)
        pounding = asyncio.create_task(flood(args.flood, jpeg, stop))
        # The service's queue fills before the run asks.
        await asyncio.sleep(1)
    try:
        await asyncio.gather(*(asyncio.create_task(guarded(job)) for job in jobs))
    finally:
        stop.set()
    if pounding:
        print("the flood got", json.dumps(await pounding), flush=True)


# -------------------------------------------------------------------- scoring


def job_rows(result: dict, gold: dict, eye: dict) -> dict:
    """Each crop of a run scored against gold or the eye fixture, and the gold or
    eye figures on its pages that no name claimed."""
    paper = result["paper"]
    rows = []
    claimed: dict[str, set] = {}
    for stem, listed in fm.by_page(paper, result["figures"]).items():
        regions = result["regions"].get(stem, [])
        found, kept = fm.boxes_of(regions)
        boxes = [c["box"] for c in kept]
        goldfs = fm.identify(listed, stem, gold)
        for f, g in zip(listed, goldfs, strict=True):
            if g is not None:
                claimed.setdefault(stem, set()).add(id(g))
            chosen = f.get("boxes")
            try:
                if chosen:
                    row = fm.score_row(
                        f, g, "pick", chosen, found, boxes, regions, stem, gold, eye
                    )
                    # The crop production made is the crop scored.
                    assert row["crop"] == [round(v, 1) for v in f["box"]], stem
                else:
                    row = fm.score_row(
                        f, g, "box", [f["box"]], found, boxes, regions, stem, gold, eye
                    )
            except ValueError:
                # This run's boxes differ from those the eye fixture was read on.
                row = {
                    "label": f["label"],
                    "page": stem,
                    "description": f["description"],
                    "status": "unchecked",
                    "right": None,
                    "whole": None,
                    "tight": None,
                }
            row["route"] = f["route"]
            row["numbers"] = f.get("numbers")
            rows.append(row)
    unnamed = []
    for number in result["pages"]:
        stem = fm.stem_of(paper, number)
        for g in gold.get(stem, []):
            if id(g) not in claimed.get(stem, set()):
                unnamed.append(f"{stem} Q{g['label']}")
        names = {fm.question_key(r["label"]) for r in rows if r["page"] == stem}
        for entry in eye.get(stem, []):
            if entry["label"] and fm.question_key(entry["label"]) not in names:
                unnamed.append(f"{stem} Q{entry['label']}")
    return {"rows": rows, "unnamed": unnamed}


def load(tag: str) -> list[dict]:
    return [json.loads(path.read_text()) for path in sorted((OUT / tag).glob("*.json"))]


def score(args) -> None:
    gold = ls.gold_figures()
    eye = fm.load_eye()
    results = [r for r in load(args.tag) if not args.only or args.only in r["name"]]
    print(
        "| Paper | Labels | Part structure | Part marks | MCQ keys worked out | Named "
        "| Whole | Tight | Both | Not reached | By box call | Layout s | Seconds "
        "| Billed | Output a page | Cut off | Refused | Continued | Left out |"
    )
    print("|" + "---|" * 19)
    totals: dict[str, list[dict]] = {}
    for group, papers in GROUPS.items():
        for paper in papers:
            for r in (x for x in results if x["paper"] == paper):
                s = r["scores"]
                w = s.get("window") or {}
                rows = job_rows(r, gold, eye)
                t = fm.tally(rows["rows"])
                totals.setdefault(group, []).extend(rows["rows"])
                totals.setdefault(group + " unnamed", []).extend(rows["unnamed"])
                print(
                    f"| {r['name']} | {len(r['report']['recorded'])}"
                    f"{'' if not s.get('missing_labels') else ' lost ' + ','.join(s['missing_labels'])} "
                    f"| {s.get('part_structure', '-')} | {s.get('part_marks_exact', '-')} "
                    f"| {s.get('mcq_worked_out_key_right') or '-'} | {t['named']} "
                    f"| {t['whole']} | {t['tight']} | {t['both']} | {len(rows['unnamed'])} "
                    f"| {sum(1 for x in rows['rows'] if x['route'] == 'box call')} "
                    f"| {r['layout_seconds']} | {r['seconds']:.0f} | ${r['billed_usd']} "
                    f"| {w.get('window_output_per_page', '-')} | {w.get('cut_off', '-')} "
                    f"| {(w.get('results') or {}).get('refused', 0)} "
                    f"| {(w.get('results') or {}).get('continued', 0)} "
                    f"| {','.join(r['report']['figuresLeftOut']) or '-'} |"
                )
    print()
    gold_rows, gold_unnamed = [], 0
    for group in GROUPS:
        rows = totals.get(group, [])
        by_status = [r for r in rows if r.get("status") == "gold"]
        print(
            group,
            fm.tally(rows),
            "against gold:",
            fm.tally(by_status),
            "unnamed:",
            sorted(set(totals.get(group + " unnamed", []))),
        )
        gold_rows += by_status
        gold_unnamed += len(
            [
                u
                for u in totals.get(group + " unnamed", [])
                if u.split(" Q")[0] in gold and gold[u.split(" Q")[0]]
            ]
        )
    print(
        "Against gold, all papers:",
        fm.tally(gold_rows),
        "gold figures no name reached:",
        gold_unnamed,
    )
    for row in sorted(
        [
            r
            for group in GROUPS
            for r in totals.get(group, [])
            if not (r.get("whole") and r.get("tight"))
        ],
        key=lambda r: (r["page"], r["label"]),
    ):
        print(
            "  ",
            row["page"],
            "Q" + row["label"],
            row["route"],
            row.get("numbers"),
            row.get("status"),
            "right",
            row.get("right"),
            "whole",
            row.get("whole"),
            "tight",
            row.get("tight"),
            "|",
            row["description"][:60],
        )
    print(
        "Total billed",
        round(sum(r["billed_usd"] for r in results), 4),
        "seconds",
        round(sum(r["seconds"] for r in results)),
        "providers",
        {
            p: sum(r["providers"].get(p, 0) for r in results)
            for p in sorted({p for r in results for p in r["providers"]})
        },
    )


def crossing(args) -> None:
    """Questions that cross a page, on the Biology paper at each window offset:
    parts, marks, words kept against its text layer, and Q2(b)'s lead-in."""
    import pymupdf
    import window_crossing as wc

    doc = pymupdf.open(Path(args.digital) / wc.GOLD["pdf"])
    gold = {q["label"]: q for q in wc.GOLD["questions"]}
    print(
        "| Run | Windows from | Parts saved | Right parts and marks | Words kept (lowest) "
        "| Q2(b) sentence | Where | Q2 marks (gold 3,3,3,4,2) | Trailing text given "
        "| Continued | Not open | Refused | Seconds | Billed |"
    )
    print("|" + "---|" * 14)
    results = [r for r in load(args.tag) if r["paper"].startswith("igcse-biology")]
    results.sort(key=lambda r: (r["pages"][0], r["repeat"]))
    for r in results:
        saved = dict(zip(r["report"]["recorded"], r["questions"]))
        parts = right = 0
        kept_all, total_all, lowest = 0, 0, 1.0
        for label, g in gold.items():
            q = saved.get(label)
            want = wc.page_words(doc, g["pages"])
            total_all += sum(want.values())
            if q is None:
                lowest = 0.0
                continue
            parts += len(q["parts"])
            right += [p["marks"] for p in q["parts"]] == [
                p["marks"] for p in g["parts"]
            ]
            kept = sum((want & wc.words(wc.saved_text(q))).values())
            kept_all += kept
            lowest = min(lowest, kept / sum(want.values()))
        where = "-"
        two = saved.get("2")
        gold_marks = [p["marks"] for p in gold["2"]["parts"]]
        two_marks = [p["marks"] for p in two["parts"]] if two else []
        invented = len(two_marks) - len(gold_marks)
        if two:
            for n, part in enumerate(two["parts"]):
                texts = [b.get("text", "") for b in part["blocks"]]
                if any("monitored" in t for t in texts):
                    first = "monitored" in texts[0]
                    where = f"part {n + 1} of {len(two['parts'])}, {'first' if first else 'later'} block"
                    break
            else:
                if any("monitored" in b.get("text", "") for b in two["stem"]):
                    where = "stem"
        w = (r["scores"].get("window") or {}).get("results") or {}
        print(
            f"| {r['name']} | from p{r['pages'][0]} "
            f"| {parts}/{sum(len(g['parts']) for g in gold.values())} | {right}/6 "
            f"| {kept_all / total_all:.0%} ({lowest:.0%}) "
            f"| {'kept' if where != '-' else 'lost'} | {where} "
            f"| {','.join(map(str, two_marks))}{' (a part invented)' if invented > 0 else ''} "
            f"| {len(r.get('trailing') or [])} | {w.get('continued', 0)} "
            f"| {w.get('not_open', 0)} | {w.get('refused', 0)} "
            f"| {r['seconds']:.0f} | ${r['billed_usd']} |"
        )


# Paper 2 Q34 as printed: its long number and its options' exponents.
Q34_ZEROS = 6
Q34_EXPONENTS = [[22, 14], [22, 14], [24, 16], [24, 16]]


def q34(args) -> None:
    """Paper 2 Q34 against the print: the zeros after CD, and the options."""
    print(
        "| Run | Zeros after CD (6 printed) | Options as printed | Key | Repeated options |"
    )
    print("|---|---|---|---|---|")
    right = {"zeros": 0, "options": 0, "runs": 0}
    for r in load(args.tag):
        if r["paper"] != "2022-p2" or "34" not in r["report"]["recorded"]:
            continue
        q = r["questions"][r["report"]["recorded"].index("34")]
        part = q["parts"][0]
        text = " ".join(b.get("text", "") for b in q["stem"] + part["blocks"])
        plain = re.sub(r"\\text\{([^}]*)\}", r"\1", text)
        found = re.search(r"CD(0+)E", plain)
        zeros = len(found.group(1)) if found else None
        exponents = [
            [int(v) for v in re.findall(r"4\^\{(\d+)\}", option)]
            for option in part["answer"]["options"]
        ]
        as_printed = exponents == Q34_EXPONENTS
        right["runs"] += 1
        right["zeros"] += zeros == Q34_ZEROS
        right["options"] += as_printed
        repeated = "299" in text
        print(
            f"| {r['name']} | {zeros} | {'yes' if as_printed else exponents} "
            f"| {part['answer']['correct']} | {'yes' if repeated else 'no'} |"
        )
    print(right)


# ----------------------------------------------------------------- the sheet


def sheet(args) -> None:
    """One run's questions with their crops under them, as the quiz holds them:
    a page with KaTeX from the CDN and the crops inside it."""
    result = json.loads((OUT / args.tag / f"{args.name}.json").read_text())
    crops = OUT / args.tag / "crops" / args.name

    def block_html(block: dict) -> str:
        if block["type"] == "text":
            return f"<p>{html.escape(block['text']).replace(chr(10), '<br>')}</p>"
        if block["type"] == "table":
            rows = "".join(
                "<tr>"
                + "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row)
                + "</tr>"
                for row in block["rows"]
            )
            return f"<table>{rows}</table>"
        figure_id = block["image"]["assetId"].removeprefix("figure:")
        data = base64.b64encode((crops / f"{figure_id}.jpg").read_bytes()).decode()
        route = next(
            (f["route"] for f in result["figures"] if f["id"] == figure_id), "?"
        )
        return (
            f'<figure><img src="data:image/jpeg;base64,{data}" alt="" '
            f'style="max-width:{block["width"]}px">'
            f"<figcaption>{html.escape(block.get('description', ''))} ({route}, "
            f"{block['width']}x{block['height']})</figcaption></figure>"
        )

    cards = []
    for label, question in zip(result["report"]["recorded"], result["questions"]):
        parts = []
        for part in question["parts"]:
            answer = part["answer"]
            options = ""
            if answer["type"] == "mcq":
                options = (
                    "<ol type=A>"
                    + "".join(
                        f"<li{' class=key' if i in answer['correct'] else ''}>"
                        f"{html.escape(o)}</li>"
                        for i, o in enumerate(answer["options"])
                    )
                    + "</ol>"
                )
            parts.append(
                "<section>"
                + "".join(block_html(b) for b in part["blocks"])
                + options
                + f"<small>{part['marks']} mark(s), {answer['type']}</small></section>"
            )
        stem = "".join(block_html(b) for b in question["stem"])
        cards.append(
            f"<article><h2>Q{html.escape(label)}</h2>{stem}{''.join(parts)}</article>"
        )
    page = f"""<!doctype html><meta charset=utf-8><title>Layout-first trial sheet</title>
<link rel=stylesheet href=https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css>
<script defer src=https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js></script>
<script defer src=https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js
 onload="renderMathInElement(document.body,{{delimiters:[{{left:'$',right:'$',display:false}}]}})"></script>
<style>body{{font:15px/1.45 system-ui;margin:24px;background:#fafafa;color:#222}}
main{{columns:3 460px;column-gap:18px}}
article{{break-inside:avoid;background:#fff;border:1px solid #ddd;padding:10px 14px;margin:0 0 18px}}
h1{{font-size:18px}}h2{{font-size:15px;margin:0 0 6px}}p{{margin:4px 0}}
figure{{margin:8px 0;border:1px solid #bbb;padding:4px}}img{{width:100%;height:auto;display:block}}
figcaption{{font-size:12px;color:#555;margin-top:4px}}small{{color:#777}}
li.key{{font-weight:600;background:#e8f5e9}}td{{border:1px solid #ccc;padding:2px 6px}}table{{border-collapse:collapse}}</style>
<h1>{html.escape(result["name"])}: {len(result["questions"])} questions, {len(result["figures"])} crops, each under the text it follows. Green is the saved key.</h1>
<main>{"".join(cards)}</main>"""
    path = OUT / args.tag / f"{args.name}-sheet.html"
    path.write_text(page)
    print(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run")
    p.add_argument("--tag", required=True)
    p.add_argument("--jobs", nargs="+", required=True)
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--env-file", required=True)
    p.add_argument("--parallel", type=int, default=3)
    p.add_argument("--kill-pid", type=int)
    p.add_argument("--kill-after-pages", type=int, default=5)
    p.add_argument("--flood", type=int, default=0)
    p = sub.add_parser("score")
    p.add_argument("--tag", required=True)
    p.add_argument("--only")
    p = sub.add_parser("sheet")
    p.add_argument("--tag", required=True)
    p.add_argument("--name", required=True)
    p = sub.add_parser("crossing")
    p.add_argument("--tag", required=True)
    p.add_argument("--digital", required=True)
    p = sub.add_parser("q34")
    p.add_argument("--tag", required=True)
    args = parser.parse_args()
    if args.command == "score":
        score(args)
    elif args.command == "crossing":
        crossing(args)
    elif args.command == "q34":
        q34(args)
    elif args.command == "sheet":
        sheet(args)
    else:
        bench.load_env(args.env_file)
        asyncio.run(run_jobs(args))


if __name__ == "__main__":
    main()
