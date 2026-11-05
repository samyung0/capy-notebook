"""The selections Make a quiz hadn't been run on, through the finished route (step 3 of
Epo's answer files work, 2026-11-05). Report: ``reports/2026-11-05-remaining-selections.md``.

    python -I selections.py run --refs <question-bank references> --detections <a.json> <b.json> \
        --env-file deploy/.env.uat --jobs cut:3 large:2 printed:3 --hard-stop 1.5
    python -I selections.py show --jobs cut

Written before the working rule and the label wording joined production, so a job's
``system_change`` no longer applies. Nothing is patched but the layout boxes (no service here, so saved detections), a nonce on
the system prompt so no run reads another's cache, and, for a job that says so, one wording
change under test. Papers, answers and images stay in the ignored ``.results/selections/``.
Keys go into the process only and are never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import contextvars
import functools
import json
import re
import secrets
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402

OUT = bench.RESULTS / "selections"
FILES = bench.RESULTS / "answerfiles" / "files"
MATHS = "hkdse-math-compulsory"
BIOLOGY = "born-digital/igcse-biology-0610-2023-sp4/paper.pdf"
WORKING_RULE = (
    'Leave out answer lines, boxes for working, working written under a question, "Answers '
    'written in the margins will not be marked", page headers and footers.'
)
WORKING_BEFORE = (
    'Leave out answer lines, boxes for working, "Answers written in the margins will not '
    'be marked", page headers and footers.'
)


@dataclass
class Job:
    """``paper`` is (path under refs or a local image, pages, the stem of its saved
    detections); ``answers`` is a path under refs read as production would send it, or a
    ``.txt`` under the text cache."""

    paper: list[tuple[str, list[int], str]]
    answers: str = ""
    text_paper: str = ""
    system_change: tuple[str, str] | None = None


JOBS = {
    # Starts inside Q1, whose parts run across pages 2 to 4, and ends inside another.
    "cut": Job([(BIOLOGY, [3, 4, 5], "igcse-biology-0610-2023-sp4")]),
    # 40 pages, two papers that both number 1 to 45, and a third.
    "large": Job(
        [
            (f"{MATHS}/2022-p2.pdf", list(range(1, 17)), "2022-p2"),
            (f"{MATHS}/2023-p2.pdf", list(range(1, 16)), "2023-p2"),
            (f"{MATHS}/2022-p1.pdf", list(range(2, 11)), "2022-p1"),
        ]
    ),
    # A worksheet that prints its own answer key on its last pages.
    "printed": Job(
        [("ielts-academic-reading/cam-activity-tt1-multiple-choice.pdf", list(range(1, 7)), "")]
    ),
    # Small type, long passages, born digital.
    "dense": Job(
        [("ielts-cambridge/cambridge-ielts-20-academic.pdf", list(range(11, 17)), "")]
    ),
    # Chinese, born digital, with its Chinese marking scheme.
    "chinese": Job(
        [("hkdse-chinese/pp/p1.pdf", list(range(7, 13)), "")], answers="hkdse-chinese/pp/ans.pdf"
    ),
    "chinese-alone": Job([("hkdse-chinese/pp/p1.pdf", list(range(7, 13)), "")]),
    # A Word, PowerPoint or text paper: only its indexed text. 2021 P1's page reads stand
    # in for what the parser would index.
    "word": Job([], text_paper="2021-p1"),
    "word-scheme": Job([], text_paper="2021-p1", answers="2021-ans.txt"),
    # The working rule, on Epo's whiteboard and worksheet.
    "whiteboard-rule": Job(
        [("local:thumb2.jpg", [1], "")], system_change=(WORKING_BEFORE, WORKING_RULE)
    ),
    "worksheet-rule": Job(
        [("local:thumb1.jpg", [1], "")], system_change=(WORKING_BEFORE, WORKING_RULE)
    ),
}


@dataclass
class State:
    nonce: str
    change: tuple[str, str] | None
    calls: list[dict] = field(default_factory=list)
    map_reply: str = ""
    sent: dict = field(default_factory=dict)
    regions: list = field(default_factory=list)


STATE: contextvars.ContextVar[State] = contextvars.ContextVar("selections_job")
LIVE = {"usd": 0.0, "stop": 1.5}


class SpendStop(Exception):
    pass


def install() -> None:
    from pipeline.elitellm import client
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import extraction, models


    production_messages = prompts.map_messages

    def map_messages(pages, boxes, answers, *, system):
        state = STATE.get()
        if state.change:
            if state.change[0] not in system:
                raise AssertionError("the wording under test does not fit")
            system = system.replace(*state.change, 1)
        messages = production_messages(pages, boxes, answers, system=system)
        messages[0]["content"] = f"Run {state.nonce}.\n{system}"
        state.sent = {
            "system": messages[0]["content"],
            "blocks": [
                b["text"][:400] for b in messages[1]["content"] if b["type"] == "text"
            ],
            "images": sum(b["type"] == "image_url" for b in messages[1]["content"]),
        }
        return messages

    prompts.map_messages = map_messages

    async def read_regions(images):
        return STATE.get().regions

    extraction.layout.read_regions = read_regions
    response = models.complete_response

    async def complete_response(messages, **kwargs):
        reply = await response(messages, **kwargs)
        if kwargs.get("call_purpose") == "extraction_map":
            STATE.get().map_reply = str(reply.choices[0].message.content or "")[:3000]
        return reply

    models.complete_response = complete_response
    stream = client._stream_sse

    async def streamed(url, headers, body):
        state = STATE.get(None)
        if state is None:
            async for event in stream(url, headers, body):
                yield event
            return
        if LIVE["usd"] > LIVE["stop"]:
            raise SpendStop(f"${LIVE['usd']:.3f}")
        started = time.monotonic()
        call = {"bytes": len(json.dumps(body)), "cost": 0.0, "finish": None, "provider": None}
        state.calls.append(call)
        try:
            async for event in stream(url, headers, body):
                call.setdefault("first_event_s", round(time.monotonic() - started, 2))
                call["provider"] = call["provider"] or event.get("provider")
                usage = event.get("usage")
                if usage:
                    call["cost"] = usage.get("cost") or call["cost"]
                    call["input"] = usage.get("prompt_tokens")
                    call["output"] = usage.get("completion_tokens")
                    call["cached"] = (usage.get("prompt_tokens_details") or {}).get(
                        "cached_tokens", 0
                    )
                for choice in event.get("choices") or []:
                    call["finish"] = choice.get("finish_reason") or call["finish"]
                yield event
        finally:
            call["seconds"] = round(time.monotonic() - started, 2)
            LIVE["usd"] += call["cost"] or 0.0

    client._stream_sse = streamed


def _pages(job: Job, args, detections, cfg, capture, extraction, layout) -> tuple[list, list]:
    from PIL import Image

    pages, regions = [], []
    refs = Path(args.refs)
    if job.text_paper:
        import glob

        reads = sorted(glob.glob(str(bench.RESULTS / "text" / f"{job.text_paper}-[0-9]*.txt")))
        text = "\n\n".join(Path(p).read_text() for p in reads)
        return [
            extraction.Page(1, "paper.docx", text, None, None, layer=extraction.BORN_DIGITAL)
        ], []
    for path, numbers, stem in job.paper:
        if path.startswith("local:"):
            local = FILES / path.removeprefix("local:")

            async def image(_number, source=local):
                from io import BytesIO

                with Image.open(source) as picture:
                    picture = picture.convert("RGB")
                    picture.thumbnail((cfg.capture_max_edge, cfg.capture_max_edge))
                    buffer = BytesIO()
                    picture.save(buffer, "JPEG", quality=capture.JPEG_QUALITY)
                return capture.data_url(buffer.getvalue())

            async def crop(_number, box, source=local):
                from io import BytesIO

                with Image.open(source) as picture:
                    w, h = picture.size
                    cut = picture.crop(
                        (box[0] * w // 1000, box[1] * h // 1000, box[2] * w // 1000, box[3] * h // 1000)
                    )
                    buffer = BytesIO()
                    cut.save(buffer, "JPEG", quality=capture.JPEG_QUALITY)
                    return buffer.getvalue(), cut.size

            pages.append(
                extraction.Page(
                    1,
                    local.name,
                    "",
                    functools.partial(image, 1),
                    functools.partial(crop, 1),
                    layer=extraction.SCAN,
                )
            )
            regions.append(())
            continue
        pdf = refs / path

        async def image(number, source=pdf):
            jpeg, _b, _s = capture.render(source, number, None, cfg.capture_max_edge)
            return capture.data_url(jpeg)

        async def crop(number, box, source=pdf):
            jpeg, _b, size = capture.render(
                source, number, box, cfg.capture_max_edge, page_edge=extraction.FIGURE_PAGE_EDGE
            )
            return jpeg, size

        import pymupdf

        with pymupdf.open(pdf) as doc:
            texts = {n: doc[n - 1].get_text() for n in numbers}
        layers = extraction.page_layers(pdf, texts)
        for number in numbers:
            pages.append(
                extraction.Page(
                    number,
                    Path(path).name,
                    texts[number],
                    functools.partial(image, number),
                    functools.partial(crop, number),
                    layer=layers[number],
                )
            )
            regions.append(
                tuple(
                    layout.Region(r["label"], r["score"], r["box"])
                    for r in detections.get(f"{stem}-p{number:02d}", [])
                )
            )
    return pages, regions


def _answers(job: Job, args, extraction, capture, cfg) -> list:
    if not job.answers:
        return []
    if job.answers.endswith(".txt"):
        stem = job.answers.removesuffix(".txt")
        import glob

        reads = sorted(glob.glob(str(bench.RESULTS / "text" / f"{stem}-[0-9]*.txt")))
        return [
            extraction.AnswerFile(job.answers, "\n\n".join(Path(p).read_text() for p in reads))
        ]
    import pymupdf

    pdf = Path(args.refs) / job.answers
    with pymupdf.open(pdf) as doc:
        texts = {n + 1: doc[n].get_text() for n in range(len(doc))}
    layers = extraction.page_layers(pdf, texts)
    pictured = sum(1 for path, numbers, _ in job.paper for _ in numbers)
    if extraction._text_goes(layers, extraction.limits.EXTRACTION_PAGES_MAX - pictured):
        return [extraction.AnswerFile(pdf.name, "\n\n".join(texts.values()))]

    async def image(number):
        jpeg, _b, _s = capture.render(pdf, number, None, cfg.capture_max_edge)
        return capture.data_url(jpeg)

    return [
        extraction.AnswerFile(
            pdf.name,
            images=tuple(
                (n, functools.partial(image, n)) for n in texts if layers[n] != extraction.BLANK
            ),
        )
    ]


async def one(name: str, repeat: int, args, validate, model, detections) -> dict:
    from pipeline import elitellm, obs
    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, layout, limits

    job = JOBS[name]
    state = State(secrets.token_hex(6), job.system_change)
    STATE.set(state)
    pages, state.regions = _pages(job, args, detections, cfg, capture, extraction, layout)
    answers = _answers(job, args, extraction, capture, cfg)
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
    usage = obs.start_usage()
    started = time.monotonic()
    done: dict = {}
    copied: list = []
    async for event in extraction.run(pages, answers, model=model, validate=validate):
        if event["type"] == "questions":
            copied = event["questions"]
        else:
            done = event
    rates = bench.CAPTIONING[2]
    micros = (
        (usage.input_tokens - usage.cached_read_tokens) * rates[0]
        + usage.cached_read_tokens * rates[1]
        + usage.output_tokens * rates[2]
    )
    return {
        "job": name,
        "repeat": repeat,
        "seconds": round(time.monotonic() - started, 1),
        "billed_usd": round(sum(c["cost"] or 0 for c in state.calls), 5),
        "credits": round(micros / 1_000_000, 2),
        "calls": state.calls,
        "sent": state.sent,
        "map_reply": state.map_reply,
        "copied": copied,
        "questions": done["questions"],
        "report": done["report"],
    }


async def run_jobs(args) -> None:
    bench.load_env(args.env_file)
    spend = OUT / "spend.json"
    LIVE["usd"] = json.loads(spend.read_text())["usd"] if spend.exists() else args.spent
    LIVE["stop"] = args.hard_stop
    install()
    validate = bench.validator(bench.quizcheck())
    provider, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec(provider, slug, name, rates, "low")
    detections: dict = {}
    for path in args.detections:
        for page in json.loads(Path(path).read_text())["pages"]:
            detections[page["page"]] = page["regions"]
    gate = asyncio.Semaphore(args.parallel)

    async def guarded(name: str, repeat: int) -> None:
        path = OUT / f"{name}-{repeat}.json"
        if path.exists():
            return
        async with gate:
            if LIVE["usd"] > LIVE["stop"] - 0.03:
                print(f"skip {path.name}: at the budget", flush=True)
                return
            try:
                result = await one(name, repeat, args, validate, model, detections)
            except Exception as exc:  # A run that fails is a finding; the rest go on.
                print(f"FAILED {path.name}: {exc!r}"[:300], flush=True)
                path.with_suffix(".failed").write_text(repr(exc))
                return
            path.write_text(json.dumps(result, ensure_ascii=False))
            print(
                f"{path.name}: {result['seconds']} s, ${result['billed_usd']:.4f}, "
                f"{result['credits']} credits, {len(result['questions'])} questions, "
                f"total ${LIVE['usd']:.4f}",
                flush=True,
            )

    try:
        tasks = []
        for text in args.jobs:
            name, runs = text.split(":")
            tasks += [guarded(name, n) for n in range(1, int(runs) + 1)]
        await asyncio.gather(*tasks)
    finally:
        spend.write_text(json.dumps({"usd": round(LIVE["usd"], 5)}))
    print(f"spent ${LIVE['usd']:.4f}", flush=True)


def _block(block: dict, width: int) -> str:
    if block.get("type") == "text":
        return block["text"][:width].replace("\n", " ")
    return f"<{block.get('type')}>"


def show(args) -> None:
    """Each run's questions as saved, to read against the page. Stays in the terminal."""
    for name in args.jobs:
        for path in sorted(OUT.glob(f"{name}-[0-9]*.json")):
            r = json.loads(path.read_text())
            rep = r["report"]
            print(
                f"\n== {path.stem} {r['seconds']} s ${r['billed_usd']:.4f} {r['credits']} cr, "
                f"{len(r['calls'])} calls, {sum(c['bytes'] for c in r['calls']) / 1e6:.1f} MB, "
                f"finishes {dict(collections.Counter(c['finish'] for c in r['calls']))}"
            )
            print(
                f"  expected {rep['expected']}\n  missing {rep['missing']} no answer "
                f"{rep.get('answersMissing')} figures {rep['figures']} left out "
                f"{rep['figuresLeftOut']} stopped {rep['stopped']!r}"
            )
            if args.brief:
                continue
            for label, q in zip(rep["recorded"], r["questions"]):
                stem = " / ".join(_block(b, args.width) for b in q["stem"])
                print(f"  Q{label} stem: {stem}")
                for p in q["parts"]:
                    text = " / ".join(_block(b, args.width) for b in p["blocks"])
                    answer = p["answer"]
                    key = answer.get("correct", answer.get("accepted"))
                    print(
                        f"    [{p['marks']} {answer['type']}] {text} => "
                        f"{str(key)[:args.width]} pts {len(p.get('markscheme') or [])}"
                    )


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--refs", required=True)
    run.add_argument("--detections", nargs="*", default=[])
    run.add_argument("--env-file", required=True)
    run.add_argument("--jobs", nargs="+", required=True)
    run.add_argument("--parallel", type=int, default=3)
    run.add_argument("--hard-stop", type=float, default=1.5)
    run.add_argument("--spent", type=float, default=0.0)
    shown = sub.add_parser("show")
    shown.add_argument("--jobs", nargs="+", required=True)
    shown.add_argument("--width", type=int, default=90)
    shown.add_argument("--brief", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.command == "run":
        asyncio.run(run_jobs(args))
    else:
        show(args)


if __name__ == "__main__":
    main()
