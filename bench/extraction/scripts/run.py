"""Run the production extraction (pipeline.retrieval.extraction) over one past
paper and score it against its hand-built gold file.

    uv run --with pymupdf==1.28.2 python bench/extraction/scripts/run.py \
        --paper 2022-p2 --model deepseek \
        --refs <data/question-bank/references/hkdse-math-compulsory> \
        --env-file <file with DEEPSEEK_API_KEY and OPENROUTER_API_KEY>

Pages are rendered with the production capture renderer and the model calls
go through ``models.complete`` with no accounting session bound, as offline
tests do. Each page's indexed text stands in for ingest's: the PDF text layer
when it has 40 characters or more, else the production VLM page read
(``models.read_page`` on the captioning pin, grey 1,280 px), cached under
``bench/extraction/.results/text/`` and not counted in the extraction's cost.
Answers come from the paper's marking-scheme PDF read the same way, or, for a
gold file with ``answers.keys``, from a one-line-per-item answer list built
from the gold keys. Every recorded question goes through Go's quizcheck, the
validator material creation uses.

The OpenRouter models (``--model v41-1017`` and ``v41``) are held on named
providers with fallbacks off, and their results record which provider served
each call and what OpenRouter billed. ``--effort`` sets the map and solve calls'
thinking (mid, as the gateway pins it).

Figures are cropped as production crops them (``FIGURE_PAGE_EDGE``) and written
to ``.results/crops/<paper>-<model>-<n>/<id>.jpg``; the result lists each one's
page, box, part and size. The fidelity check compares each saved question's
text (stem, parts, options, table cells) and each parsed scheme entry with the
page's own text: the PDF text layer where there is one, else both the refs
folder's Tesseract OCR (``<pdf>.txt``) and the cached VLM page read, since the
HKDSE scans have no text layer. It counts numbers and units missing from both
readings (unsupported) or present in both and missing from the extraction
(dropped), LaTeX that KaTeX cannot parse and unpaired $ signs, and scores
gold tables cell by cell.

Writes ``.results/<paper>-<model>-<n>.json`` (questions, report, usage, scores)
and prints the scores. Keys are read into the process only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import copy
import dataclasses
import functools
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))

RESULTS = ROOT / "bench" / "extraction" / ".results"
GOLD = ROOT / "bench" / "extraction" / "fixtures" / "gold"

# Catalog rates in credit micros per token (input, cached input, output), as
# the model_configs rows carry them; 1,000,000 micros is one credit, $0.0005.
MODELS = {
    "deepseek": ("deepseek", "deepseek-flash", "Flash", (600, 12, 2400)),
    "glm": ("zai", "glm-5.3-flash", "GLM-5.3-Flash", (300, 60, 1000)),
}
# 1017 at Epo's price for every use: the highest of its three providers' list
# prices in each column (2026-11-04).
CAPTIONING = ("openrouter", "deepseek/deepseek-v4.1-flash-1017", (200, 20, 1200))
TEXT_LAYER_MIN = 40
# OpenRouter models for the extraction slot (2026-11-03, after 0731 proved
# text-only). 1017 runs on production's routes: the extraction slot's
# (InferenceNet, Cloudflare, Wafer's US endpoint), bound as the service binds
# it. The unpinned V4.1 Flash has no production route, so the bench holds it
# on InferenceNet with fallbacks off (never DeepInfra, Epo 2026-11-04; runs
# 51-52 had it second, and InferenceNet served every call), at InferenceNet's
# list price.
OPENROUTER = {"v41": ["InferenceNet"]}
MODELS |= {
    "v41-1017": (
        "openrouter",
        "deepseek/deepseek-v4.1-flash-1017",
        "V4.1 Flash 1017",
        CAPTIONING[2],
    ),
    "v41": (
        "openrouter",
        "deepseek/deepseek-v4.1-flash",
        "V4.1 Flash",
        (206, 16, 1200),
    ),
}


def load_env(path: str | None) -> None:
    if not path:
        return
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if line.startswith(("DEEPSEEK_API_KEY=", "OPENROUTER_API_KEY=")):
            key, value = line.split("=", 1)
            os.environ.setdefault(key, value.strip().strip('"'))


def pin_openrouter(model_slug: str, order: list[str] | None) -> list[dict]:
    """Route model_slug to order with fallbacks off, when given; the returned
    list fills with each of its calls' serving provider and OpenRouter's billed
    cost."""
    from pipeline.elitellm import client

    if order:
        client.OPENROUTER_ROUTING[model_slug] = {
            "order": order,
            "allow_fallbacks": False,
        }
    post, stream = client._post_json, client._stream_sse
    served: list[dict] = []

    async def posted(url, headers, body, **kwargs):
        raw = await post(url, headers, body, **kwargs)
        if body.get("model") == model_slug:
            served.append(
                {
                    "provider": raw.get("provider"),
                    "cost": (raw.get("usage") or {}).get("cost"),
                }
            )
        return raw

    async def streamed(url, headers, body):
        call = {"provider": None, "cost": None}
        if body.get("model") == model_slug:
            served.append(call)
        async for event in stream(url, headers, body):
            call["provider"] = call["provider"] or event.get("provider")
            call["cost"] = (event.get("usage") or {}).get("cost", call["cost"])
            yield event

    client._post_json, client._stream_sse = posted, streamed
    return served


def spec(
    provider: str, model: str, name: str, rates: tuple[int, int, int], thinking: str
):
    from pipeline.registry import ModelConfig

    return ModelConfig(
        version=1,
        provider_name=provider,
        model_name=name,
        provider_slug=provider,
        model_slug=model,
        thinking_levels=("instant", "low", "mid", "high", "max"),
        default_thinking=thinking,
        micros_per_input_token=rates[0],
        micros_per_cached_input_token=rates[1],
        micros_per_output_token=rates[2],
        context_window_tokens=200_000,
        slots=("chat",),
    )


def quizcheck() -> Path:
    binary = RESULTS / "quizcheck"
    subprocess.run(
        ["go", "build", "-o", str(binary), "./cmd/quizcheck"],
        cwd=ROOT / "server",
        check=True,
    )
    return binary


def validator(binary: Path):
    async def validate(question: dict) -> str | None:
        proc = await asyncio.create_subprocess_exec(
            str(binary),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate(json.dumps([question]).encode())
        if proc.returncode:
            return out.decode().strip() or f"quizcheck exited {proc.returncode}"
        return None

    return validate


async def page_texts(pdf: Path, pages: list[int], tag: str) -> dict[int, str]:
    """Each page's text layer, or its cached VLM read."""
    import pymupdf

    from pipeline.registry import JobPins, set_job_pins
    from pipeline.retrieval import capture, models

    cache = RESULTS / "text"
    cache.mkdir(parents=True, exist_ok=True)
    set_job_pins(
        JobPins(captioning=spec(*CAPTIONING[:2], "1017", CAPTIONING[2], "instant"))
    )
    out: dict[int, str] = {}
    with pymupdf.open(pdf) as doc:
        for number in pages:
            layer = doc[number - 1].get_text().strip()
            if len(layer) >= TEXT_LAYER_MIN:
                out[number] = layer
                continue
            cached = cache / f"{tag}-{number:02d}.txt"
            if not cached.exists():
                page = doc[number - 1]
                scale = 1280 / max(page.rect.width, page.rect.height)
                pix = page.get_pixmap(
                    matrix=pymupdf.Matrix(scale, scale),
                    colorspace=pymupdf.csGRAY,
                    alpha=False,
                )
                read = await models.read_page(
                    capture.data_url(pix.tobytes("jpeg", jpg_quality=80)),
                    credit_micros=0,
                )
                cached.write_text(read or "")
            out[number] = cached.read_text()
    return out


def _outcome(result: str) -> str:
    """A tool result line as a kind."""
    if result.endswith("recorded."):
        return "recorded"
    if result.endswith("continued."):
        return "continued"
    if "Fix it and" in result:
        return "refused"
    if "recorded from earlier pages" in result:
        return "duplicate"
    if "not the open question" in result:
        return "not_open"
    if "at most" in result or "quiz is full" in result:
        return "full"
    return "other"


def run_name(args) -> str:
    name = f"{args.paper}-{args.model}-{args.repeat}"
    return name


async def run(args) -> dict:
    from pipeline import elitellm, obs
    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, limits

    gold = json.loads((GOLD / f"{args.paper}.json").read_text())
    refs = Path(args.refs)
    pdf = refs / gold["pdf"]
    texts = await page_texts(pdf, gold["pages"], gold["paper"])

    async def image(number: int) -> str:
        jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
        return capture.data_url(jpeg)

    async def crop(number: int, box: list[float]) -> tuple[bytes, tuple[int, int]]:
        jpeg, _box, size = capture.render(
            pdf, number, box, cfg.capture_max_edge, extraction.FIGURE_PAGE_EDGE
        )
        return jpeg, size

    layers = extraction.page_layers(pdf, {n: texts[n] for n in gold["pages"]})
    pages = [
        extraction.Page(
            number,
            gold["pdf"],
            texts[number],
            functools.partial(image, number),
            functools.partial(crop, number),
            layer=layers[number],
        )
        for number in gold["pages"]
    ]
    answers = gold["answers"]
    if "pdf" in answers:
        import pymupdf

        with pymupdf.open(refs / answers["pdf"]) as doc:
            count = len(doc)
        scheme_pages = await page_texts(
            refs / answers["pdf"],
            list(range(1, count + 1)),
            answers["pdf"].removesuffix(".pdf"),
        )
        schemes = [
            extraction.SchemeFile(
                answers["pdf"],
                "\n\n".join(scheme_pages[n] for n in sorted(scheme_pages)),
            )
        ]
    elif "keys" in answers:
        lines = [f"{q['label']}. {q['parts'][0]['correct']}" for q in gold["questions"]]
        schemes = [extraction.SchemeFile("answers.txt", "\n".join(lines))]
    else:
        # A paper with no answer file: every key is worked out.
        schemes = []

    provider, model_slug, name, rates = MODELS[args.model]
    model = spec(provider, model_slug, name, rates, "low")
    served = (
        pin_openrouter(model_slug, OPENROUTER.get(args.model))
        if provider == "openrouter"
        else []
    )
    # As the service binds it: the run's calls take the extraction route.
    elitellm.bind_route_slot("extraction")
    # The map and solve calls run at mid, as the gateway pins them (Epo 2026-11-03).
    bind_request_llm(args.effort)
    # As the service binds it: a busy model call waits its turn once.
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
    usage = obs.start_usage()
    validate = validator(quizcheck())
    parsed: list = []
    parse_schemes = extraction.parse_schemes

    async def kept(files, *, model, labels):
        pieces = await parse_schemes(files, model=model, labels=labels)
        parsed.extend(dataclasses.asdict(e) for piece in pieces for e in piece)
        return pieces

    extraction.parse_schemes = kept
    # Each placed figure's page, box and part, as the crops are made.
    figures: list[dict] = []
    place = extraction.placed

    async def placed(held, crops):
        out = await place(held, crops)
        for n, figure in enumerate(held.figures, 1):
            figures.append(
                {
                    "label": held.label,
                    "id": f"q{extraction.label_key(held.label)}-{n}",
                    "page": figure.page.number,
                    "box": figure.box,
                    "window_box": window_boxes.get((held.label, n)),
                    "part": figure.part,
                    "description": figure.description,
                }
            )
        return out

    extraction.placed = placed
    # The window's boxes, before the locate call replaces them.
    window_boxes: dict[tuple[str, int], list[float]] = {}
    locate_figures = extraction.locate_figures

    async def located(held, *, model):
        for question in held:
            for n, figure in enumerate(question.figures, 1):
                if figure.box:
                    window_boxes[(question.label, n)] = list(figure.box)
        return await locate_figures(held, model=model)

    extraction.locate_figures = located
    # What each call that records did: how it finished, its output, its tool calls
    # and their results.
    calls: list[dict] = []
    complete_response = extraction.models.complete_response

    async def counted(messages, **kwargs):
        response = await complete_response(messages, **kwargs)
        if kwargs.get("call_purpose") not in ("extraction_copy", "extraction_solve"):
            return response
        reply = elitellm.assistant_message_from_obj(
            elitellm.message_from_response(response)
        )
        calls.append(
            {
                "finish": response.choices[0].finish_reason,
                "output": response.usage.output_tokens,
                "tool_calls": len(reply.get("tool_calls") or []),
                "results": [],
            }
        )
        return response

    extraction.models.complete_response = counted
    copy_question = extraction.Run.copy_question
    record_answers = extraction.Run.record_answers

    async def counted_copy(self, item, pages_):
        result = await copy_question(self, item, pages_)
        calls[-1]["results"].append(
            ["record", _outcome(result), len(item.get("parts") or [])]
        )
        return result

    async def counted_answers(self, args_, pages_):
        result = await record_answers(self, args_, pages_)
        calls[-1]["results"].append(
            ["answers", _outcome(result), len(args_.get("parts") or [])]
        )
        return result

    extraction.Run.copy_question = counted_copy
    extraction.Run.record_answers = counted_answers
    started = time.monotonic()
    recorded: list[dict] = []
    done: dict = {}
    async for event in extraction.run(
        pages, schemes, model=model, validate=validate, locale="en"
    ):
        if event["type"] == "questions":
            # The questions as copied, with their marks and no answers yet.
            recorded = copy.deepcopy(event["questions"])
            print(f"  copied: {len(recorded)} questions so far", flush=True)
        else:
            done = event
    if not schemes:
        # With no scheme to replace them, these are the keys the model worked out.
        recorded = copy.deepcopy(done["questions"])
    seconds = time.monotonic() - started
    crops = RESULTS / "crops" / run_name(args)
    crops.mkdir(parents=True, exist_ok=True)
    images = {f["id"]: base64.b64decode(f["image"]) for f in done.get("figures", [])}
    sizes = {
        block["image"]["assetId"].removeprefix("figure:"): (
            block["width"],
            block["height"],
        )
        for question in done["questions"]
        for blocks in [question["stem"], *(p["blocks"] for p in question["parts"])]
        for block in blocks
        if block["type"] == "image"
    }
    for figure in figures:
        data = images[figure["id"]]
        (crops / f"{figure['id']}.jpg").write_bytes(data)
        figure["bytes"] = len(data)
        figure["size"] = sizes[figure["id"]]
    micros = (
        (usage.input_tokens - usage.cached_read_tokens) * rates[0]
        + usage.cached_read_tokens * rates[1]
        + usage.output_tokens * rates[2]
    )
    return {
        "paper": args.paper,
        "model": f"{provider}/{model_slug}",
        "seconds": round(seconds, 1),
        "usage": usage.as_dict(),
        "credits": round(micros / 1_000_000, 2),
        "usd": round(micros / 1_000_000 * 0.0005, 4),
        "effort": args.effort,
        # OpenRouter runs: which providers served the calls, and what
        # OpenRouter billed for them.
        "providers": {
            name: sum(1 for call in served if call["provider"] == name)
            for name in sorted({call["provider"] for call in served})
        },
        "billed_usd": round(sum(call["cost"] or 0 for call in served), 4)
        if served
        else None,
        "recorded": recorded,
        "questions": done["questions"],
        "report": done["report"],
        "scheme_entries": parsed,
        "figures": figures,
        "calls": calls,
    }


# ----------------------------------------------------------------- fidelity

# Page furniture and mark notes, left out of a reference page's text.
_FURNITURE = re.compile(
    r"(?im)^.*(margins will not be marked|DSE-MATH|barcode label|go on to the next"
    r"|page total|confidential|marker.s use|solution\s+marks\s+remarks|section [ab]"
    r"|end of paper).*$"
)
_MARKS_NOTE = re.compile(r"\(\s*\d+\s*marks?\s*\)", re.IGNORECASE)
# Scheme mark codes (1M, 1A, 1M+1A, a column's total ----(3)), on both sides.
_MARK_CODES = re.compile(
    r"\b\d+\s*[MA]\b|-{3,}\s*\(\s*\d+\s*\)|\(\s*\d+\s*\)\s*$", re.MULTILINE
)
_UNIT = re.compile(
    r"(?<=\d)\s*(cm|mm|km|kg|m|g|s)\b|\b(minute|hour|second)s?\b|(%)|(°)"
)


_SCRIPTS = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉", "01234567890123456789")


def plain(text: str) -> str:
    r"""Text or LaTeX as plain text for counting numbers and units: a
    superscript is its digits, ^\circ is °, \text{cm} is cm, 1 000 is 1000."""
    t = text.replace("\\%", "%").replace("\\,", "").replace("\\ ", " ")
    t = re.sub(r"\^\s*\{?\s*\\circ\s*\}?", "°", t)
    # A run of superscript or subscript digits is one number (4²² is 4^22).
    t = re.sub(r"[⁰¹²³⁴-⁹₀-₉]+", lambda m: " " + m.group().translate(_SCRIPTS), t)
    t = t.replace("−", "-").replace("–", "-")
    t = re.sub(r"\\(?:text|mathrm|textrm|mbox)\s*\{([^{}]*)\}", r" \1 ", t)
    t = re.sub(r"\\[a-zA-Z]+", " ", t)
    t = re.sub(r"[{}$^_\\]", " ", t)
    return re.sub(r"(?<=\d) (?=\d{3}(?!\d))", "", t)


def numbers(text: str) -> collections.Counter:
    return collections.Counter(re.findall(r"\d+(?:\.\d+)?", plain(text)))


def units(text: str) -> collections.Counter:
    found = collections.Counter()
    for match in _UNIT.finditer(plain(text)):
        found[next(g for g in match.groups() if g)] += 1
    return found


def reference_pages(
    refs: Path, pdf: str, pages: list[int]
) -> dict[str, dict[int, str]]:
    """The page texts the check compares with: the text layer where the PDF
    has one, else the refs folder's Tesseract OCR and the cached VLM read."""
    import pymupdf

    ocr_file = refs / pdf.replace(".pdf", ".txt")
    ocr: dict[int, str] = {}
    if ocr_file.exists():
        chunks = re.split(r"(?m)^PAGE (\d+)$", ocr_file.read_text())
        ocr = {int(chunks[i]): chunks[i + 1] for i in range(1, len(chunks) - 1, 2)}
    out: dict[str, dict[int, str]] = {"ocr": {}, "vlm": {}}
    with pymupdf.open(refs / pdf) as doc:
        for number in pages:
            layer = doc[number - 1].get_text().strip()
            if len(layer) >= TEXT_LAYER_MIN:
                out["ocr"][number] = out["vlm"][number] = layer
                continue
            out["ocr"][number] = ocr.get(number, "")
            cached = RESULTS / "text" / f"{pdf.removesuffix('.pdf')}-{number:02d}.txt"
            out["vlm"][number] = cached.read_text() if cached.exists() else ""
    return out


def spans(pages: dict[int, str], labels: list[str]) -> dict[str, str]:
    """Each numbered question's text in the pages, from its label at a line's
    start to the next number's; a label not found has no span."""
    # Without its furniture, a page's last line alone a number is its page
    # number.
    text = "\n".join(
        re.sub(r"\n\s*\d{1,3}\s*$", "\n", _FURNITURE.sub("", pages[n]).rstrip())
        for n in sorted(pages)
    )
    text = _MARKS_NOTE.sub(" ", text)
    out: dict[str, str] = {}
    pos = 0
    for label in labels:
        if not label.isdigit():
            continue
        start = re.compile(rf"(?m)^\W{{0,3}}{label}\s*[.,]").search(text, pos)
        if start is None:
            continue
        after = re.compile(rf"(?m)^\W{{0,3}}{int(label) + 1}\s*[.,]")
        end = after.search(text, start.end())
        out[label] = text[start.end() : end.start() if end else len(text)]
        pos = start.end()
    return out


def best_span(pages: dict[int, str], label: str, mine: str) -> str | None:
    """The text after the occurrence of a numbered label at a line's start
    whose span shares most numbers with ``mine``: an answer file may number
    its instructions, or hold another paper's answers, before the right
    entry."""
    text = "\n".join(_FURNITURE.sub("", pages[n]) for n in sorted(pages))
    after = re.compile(rf"(?m)^\W{{0,3}}{int(label) + 1}\s*[.,]")
    want = numbers(mine)
    best, score = None, -1
    for start in re.finditer(rf"(?m)^\W{{0,3}}{label}\s*[.,]", text):
        end = after.search(text, start.end())
        span = text[start.end() : end.start() if end else start.end() + 6000]
        shared = sum((want & numbers(span)).values())
        if shared > score:
            best, score = span, shared
    return best


def question_text(question: dict) -> str:
    """What a learner reads of a question: its text, table cells and options
    (not a figure's description, which the model writes)."""
    out = []
    for blocks in [question["stem"], *(p["blocks"] for p in question["parts"])]:
        for block in blocks:
            if block["type"] == "text":
                out.append(block["text"])
            elif block["type"] == "table":
                out.extend(cell for row in block.get("rows") or [] for cell in row)
    for part in question["parts"]:
        if part["answer"]["type"] == "mcq":
            out.extend(part["answer"]["options"])
    return "\n".join(out)


def _diff(extracted: str, references: list[str]) -> dict:
    """Numbers and units in the extraction that no reference has (unsupported)
    and ones every reference has that the extraction lacks (dropped)."""
    result = {}
    for kind, count in (("numbers", numbers), ("units", units)):
        mine = count(extracted)
        theirs = [count(ref) for ref in references]
        unsupported = collections.Counter(
            {k: v - max(t[k] for t in theirs) for k, v in mine.items()}
        )
        dropped = collections.Counter(
            {k: min(t[k] for t in theirs) - mine[k] for k in set().union(*theirs)}
        )
        result[kind] = sum(mine.values())
        result[f"{kind}_unsupported"] = sorted((+unsupported).elements())
        result[f"{kind}_dropped"] = sorted((+dropped).elements())
    return result


def math_spans(text: str) -> tuple[list[str], bool]:
    """The $…$ and $$…$$ spans as the app's parseMathText reads them, and
    whether a $ is left unpaired (it then shows as a $ sign)."""
    found, stray, i = [], False, 0
    while i < len(text):
        if text.startswith("\\$", i):
            i += 2
            continue
        if text[i] != "$":
            i += 1
            continue
        delim = "$$" if text.startswith("$$", i) else "$"
        end = i + len(delim)
        while end < len(text):
            if text[end] == "\\":
                end += 2
                continue
            if text.startswith(delim, end) and (
                delim == "$$"
                or (text[end + 1 : end + 2] != "$" and text[end - 1] != "$")
            ):
                break
            end += 1
        if end >= len(text) or end == i + len(delim):
            stray = True
            i += len(delim)
            continue
        found.append(text[i + len(delim) : end])
        i = end + len(delim)
    return found, stray


_KATEX = """const katex = require(process.argv[1]); let data = '';
process.stdin.on('data', (d) => (data += d)).on('end', () => {
  const out = [];
  JSON.parse(data).forEach((tex, i) => {
    try { katex.renderToString(tex, { throwOnError: true, strict: 'ignore' }); }
    catch (e) { out.push([i, String(e.message).slice(0, 140)]); }
  });
  console.log(JSON.stringify(out));
});"""


def katex_errors(spans: list[str]) -> list[tuple[int, str]]:
    proc = subprocess.run(
        ["node", "-e", _KATEX, str(ROOT / "node_modules" / "katex")],
        input=json.dumps(spans),
        capture_output=True,
        text=True,
        check=True,
    )
    return [tuple(item) for item in json.loads(proc.stdout)]


def learner_texts(question: dict) -> list[str]:
    """Every text a learner may see: the question, its solutions, marking
    points and model answers."""
    texts = [question_text(question)]
    for part in question["parts"]:
        texts += [b["text"] for b in part.get("solution") or [] if b["type"] == "text"]
        texts += [item["text"] for item in part.get("markscheme") or []]
        texts += [str(v) for v in part["answer"].get("accepted") or []]
    return texts


def _cell(value: str) -> str:
    value = re.sub(r"\\text\s*\{([^{}]*)\}", r"\1", str(value))
    return (
        re.sub(r"[\s$]", "", value)
        .replace("−", "-")
        .replace("–", "-")
        .replace("—", "-")
        .lower()
    )


def table_scores(question: dict, gold_tables: list[dict]) -> list[dict]:
    """Each gold table against the question's best-matching table block:
    shape, header flag, cells in place, and cells found anywhere in it."""
    found = [
        b
        for blocks in [question["stem"], *(p["blocks"] for p in question["parts"])]
        for b in blocks
        if b["type"] == "table"
    ]
    out = []
    for table in gold_tables:
        gold = [[_cell(c) for c in row] for row in table["rows"]]
        cells = sum(len(row) for row in gold)
        best = None
        for block in found:
            rows = [[_cell(c) for c in row] for row in block.get("rows") or []]
            in_place = sum(
                1
                for i, row in enumerate(gold)
                for j, cell in enumerate(row)
                if i < len(rows) and j < len(rows[i]) and rows[i][j] == cell
            )
            anywhere = sum(
                (
                    collections.Counter(c for row in gold for c in row)
                    & collections.Counter(c for row in rows for c in row)
                ).values()
            )
            score = {
                "shape": f"{len(rows)}x{max((len(r) for r in rows), default=0)}",
                "gold_shape": f"{len(gold)}x{len(gold[0])}",
                "header": bool(block.get("header")) == table["header"],
                "cells_in_place": f"{in_place}/{cells}",
                "cells_anywhere": f"{anywhere}/{cells}",
                "_rank": (anywhere, in_place),
            }
            if best is None or score["_rank"] > best["_rank"]:
                best = score
        if best:
            best.pop("_rank")
        out.append(
            best or {"missing": True, "gold_shape": f"{len(gold)}x{len(gold[0])}"}
        )
    return [dict(t, tables_in_question=len(found)) for t in out]


def _area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def box_scores(result: dict, gold: dict, key: str = "box") -> dict:
    """Each crop against its gold figure box on the page grid: the share of
    the figure inside the crop (below 1 is clipped) and the share of the crop
    that is figure (below 1 is loose)."""
    from pipeline.retrieval.extraction import label_key

    golds = {
        (label_key(g["label"]), g["page"]): g["box"]
        for g in gold.get("figure_boxes", [])
    }
    rows = []
    for figure in result.get("figures") or []:
        box = golds.get((label_key(figure["label"]), figure["page"]))
        if box is None:
            rows.append(
                {"label": figure["label"], "page": figure["page"], "gold": None}
            )
            continue
        crop = figure.get(key)
        if crop is None:
            continue
        inter = _area(
            [
                max(box[0], crop[0]),
                max(box[1], crop[1]),
                min(box[2], crop[2]),
                min(box[3], crop[3]),
            ]
        )
        rows.append(
            {
                "label": figure["label"],
                "page": figure["page"],
                "covered": round(inter / _area(box), 3),
                "figure_share": round(inter / _area(crop), 3) if _area(crop) else 0,
                "edges": [round(c - b) for c, b in zip(crop, box)],
            }
        )
    matched = [r for r in rows if r.get("gold", True) is not None and "covered" in r]
    return {
        "crops": len(rows),
        "matched_gold": len(matched),
        # Whole: at most 2% of the figure outside the crop.
        "whole": sum(1 for r in matched if r["covered"] >= 0.98),
        # Tight: at least 70% of the crop is the figure.
        "tight": sum(1 for r in matched if r["figure_share"] >= 0.7),
        "rows": rows,
    }


def window_scores(result: dict) -> dict | None:
    """What the calls that record did: calls, cut-offs, tool results and questions
    recorded per call."""
    calls = result.get("calls")
    if calls is None:
        return None
    report = result["report"]
    kinds = collections.Counter(r[1] for c in calls for r in c["results"])
    per_call = [
        sum(1 for kind, outcome, _ in c["results"] if outcome == "recorded")
        for c in calls
    ]
    parts_per_call = [
        sum(n for _, outcome, n in c["results"] if outcome in ("recorded", "continued"))
        for c in calls
    ]
    recording = [n for n in per_call if n]
    output = sum(c["output"] for c in calls)
    with_tools = sum(1 for c in calls if c["tool_calls"])
    return {
        "windows": report["windows"],
        "calls": len(calls),
        # Calls with tool calls after each window's first: re-recording what
        # was refused, continuing, or resending.
        "re_asks": max(0, with_tools - report["windows"]),
        # Replies with no tool call that closed a window ("DONE").
        "closing": sum(
            1 for c in calls if not c["tool_calls"] and c["finish"] != "length"
        ),
        "cut_off": sum(1 for c in calls if c["finish"] == "length"),
        "not_json": sum(c["tool_calls"] - len(c["results"]) for c in calls),
        "results": dict(kinds),
        "questions_per_recording_call": round(sum(recording) / len(recording), 1)
        if recording
        else 0,
        "most_questions_in_a_call": max(per_call, default=0),
        "most_parts_in_a_call": max(parts_per_call, default=0),
        "window_output_tokens": output,
        "window_output_per_page": round(output / report["pages"]),
        "most_output_in_a_call": max((c["output"] for c in calls), default=0),
        "stopped": report["stopped"],
    }


def fidelity(result: dict, gold: dict, refs: Path) -> dict:
    from pipeline.retrieval.extraction import label_key

    labels = result["report"]["recorded"]
    pages = reference_pages(refs, gold["pdf"], gold["pages"])
    by_ref = {name: spans(texts, labels) for name, texts in pages.items()}
    rows, unsegmented = [], []
    for label, question in zip(labels, result["questions"]):
        references = [by_ref[name].get(label) for name in by_ref]
        if any(ref is None for ref in references):
            unsegmented.append(label)
            continue
        rows.append({"label": label, **_diff(question_text(question), references)})

    def total(key: str) -> int:
        return sum(len(r[key]) for r in rows)

    worst = sorted(
        rows,
        key=lambda r: (
            -(
                len(r["numbers_unsupported"])
                + len(r["numbers_dropped"])
                + len(r["units_unsupported"])
                + len(r["units_dropped"])
            )
        ),
    )
    out = {
        "questions_compared": len(rows),
        "unsegmented": unsegmented,
        "numbers": sum(r["numbers"] for r in rows),
        "numbers_unsupported": total("numbers_unsupported"),
        "numbers_dropped": total("numbers_dropped"),
        "units": sum(r["units"] for r in rows),
        "units_unsupported": total("units_unsupported"),
        "units_dropped": total("units_dropped"),
        "questions_exact": sum(
            1
            for r in rows
            if not (
                r["numbers_unsupported"]
                or r["numbers_dropped"]
                or r["units_unsupported"]
                or r["units_dropped"]
            )
        ),
        "worst": [
            {k: v for k, v in r.items() if k not in ("numbers", "units")}
            for r in worst[:6]
            if r["numbers_unsupported"]
            or r["numbers_dropped"]
            or r["units_unsupported"]
            or r["units_dropped"]
        ],
    }
    # The scheme entries as parsed, against the scheme's own text: only
    # unsupported numbers, since alternatives and comments are left out on
    # purpose.
    answers = gold["answers"]
    if "pdf" in answers and result.get("scheme_entries"):
        import pymupdf

        with pymupdf.open(refs / answers["pdf"]) as doc:
            count = len(doc)
        scheme = reference_pages(refs, answers["pdf"], list(range(1, count + 1)))
        # The solutions start on the first page with the Solution / Marks /
        # Remarks table; the numbered general instructions before it are not
        # questions.
        for name, texts in scheme.items():
            first = min(
                (n for n, t in texts.items() if re.search(r"(?i)\bremarks\b", t)),
                default=1,
            )
            scheme[name] = {n: t for n, t in texts.items() if n >= first}
        entries: dict[str, list[str]] = collections.defaultdict(list)
        recorded = {label_key(label) for label in labels}
        for entry in result["scheme_entries"]:
            # Entries paired with a recorded question; unpaired ones are
            # another question's and never reach the quiz.
            if label_key(entry["question"]) not in recorded:
                continue
            entries[entry["question"]].extend(
                [
                    entry["answer"],
                    entry["solution"],
                    *(p["text"] for p in entry["points"]),
                ]
            )
        srows = []
        for label, texts in entries.items():
            if not label.isdigit():
                continue
            mine = _MARK_CODES.sub(" ", "\n".join(texts))
            references = [best_span(texts_, label, mine) for texts_ in scheme.values()]
            if any(ref is None for ref in references):
                continue
            # An entry repeats its final value in its answer, solution and
            # points, so a number counts once: present in a reading or not.
            theirs = set().union(
                *(numbers(_MARK_CODES.sub(" ", r)) for r in references)
            )
            found = set(numbers(mine))
            srows.append(
                {
                    "label": label,
                    "numbers": len(found),
                    "unsupported": sorted(found - theirs),
                }
            )
        out["scheme"] = {
            "questions_compared": len(srows),
            "numbers": sum(r["numbers"] for r in srows),
            "numbers_unsupported": sum(len(r["unsupported"]) for r in srows),
            "worst": sorted(
                [r for r in srows if r["unsupported"]],
                key=lambda r: -len(r["unsupported"]),
            )[:5],
        }
    texts = [t for q in result["questions"] for t in learner_texts(q)]
    found = [(t, math_spans(t)) for t in texts]
    tex = [span for _, (spans_, _) in found for span in spans_]
    errors = katex_errors(tex)
    out["latex"] = {
        "spans": len(tex),
        "katex_errors": len(errors),
        "examples": [(tex[i][:120], message) for i, message in errors[:8]],
        "texts_with_a_stray_dollar": sum(1 for _, (_, stray) in found if stray),
    }
    gold_q = {label_key(q["label"]): q for q in gold["questions"]}
    tables = {}
    for label, question in zip(labels, result["questions"]):
        g = gold_q.get(label_key(label))
        if g and g.get("tables"):
            tables[label] = table_scores(question, g["tables"])
    if tables:
        out["tables"] = tables
    return out


# ------------------------------------------------------------------ scoring

_SUBS = [
    (r"\\leqslant|\\leq|\\le(?![a-z])|≤", " ≤ "),
    (r"\\geqslant|\\geq|\\ge(?![a-z])|≥", " ≥ "),
    (r"\\lt(?![a-z])", " < "),
    (r"\\gt(?![a-z])", " > "),
    (r"[−–]|\\minus", "-"),
    (r"²", "^2"),
    (r"³", "^3"),
    (r"\\sin", " sin "),
    (r"\\cos", " cos "),
    (r"\\tan", " tan "),
    (r"\\[a-zA-Z]+", " "),
    (r"(\d)(?:\s|\\,|\\ |~|\{,\})+(?=\d{3}(?!\d))", r"\1"),
]
_TOKEN = re.compile(r"\d+(?:\.\d+)?|[<>≤≥=+\-]|\b(?:III|II|IV|I)\b|sin|cos|tan")


def signature(text: str) -> str:
    for pattern, repl in _SUBS:
        text = re.sub(pattern, repl, text)
    return " ".join(_TOKEN.findall(text))


def score(result: dict, gold: dict, refs: Path) -> dict:
    from pipeline.retrieval.extraction import label_key

    gold_q = {label_key(q["label"]): q for q in gold["questions"]}
    rec = result["report"]["recorded"]
    rec_keys = [label_key(label) for label in rec]
    found = [k for k in rec_keys if k in gold_q]
    # Saved questions carry no label; every recorded question is saved, in
    # recorded order.
    saved = dict(zip(rec_keys, result["questions"]))
    by_recorded = dict(zip(rec_keys, result["recorded"]))
    structure = marks_total = marks_parts = 0
    mcq = mcq_order = mcq_elsewhere = 0
    worked_mcq = worked_mcq_right = 0
    worked_marks = worked_marks_right = 0
    figure_gold = figure_found = 0
    for key in found:
        g = gold_q[key]
        question = saved[key]
        parts = question["parts"]
        # The model's own keys and marks, before the scheme replaced them.
        for p, gp in zip(by_recorded[key]["parts"], g["parts"]):
            if gp["type"] == "mcq" and p["answer"]["type"] == "mcq":
                worked_mcq += 1
                worked_mcq_right += p["answer"]["correct"] == [
                    ord(gp["correct"]) - ord("A")
                ]
            worked_marks += 1
            worked_marks_right += p["marks"] == gp["marks"]
        if len(parts) == len(g["parts"]) and all(
            p["answer"]["type"] == gp["type"] for p, gp in zip(parts, g["parts"])
        ):
            structure += 1
            if [p["marks"] for p in parts] == [gp["marks"] for gp in g["parts"]]:
                marks_parts += 1
        if sum(p["marks"] for p in parts) == g["total"]:
            marks_total += 1
        for p, gp in zip(parts, g["parts"]):
            if gp["type"] == "mcq" and p["answer"]["type"] == "mcq":
                mcq += 1
                options = [signature(o) for o in p["answer"]["options"]]
                index = ord(gp["correct"]) - ord("A")
                if index < len(options) and options[index] == gp["signature"]:
                    mcq_order += 1
                elif gp["signature"] in options:
                    mcq_elsewhere += 1
    for g in gold["questions"]:
        if g.get("figure"):
            figure_gold += 1
    keyed = 0
    for key, question in saved.items():
        g = gold_q.get(key)
        if not g:
            continue
        for p, gp in zip(question["parts"], g["parts"]):
            if (
                gp["type"] == "mcq"
                and p["answer"]["type"] == "mcq"
                and p["answer"]["correct"] == [ord(gp["correct"]) - ord("A")]
            ):
                keyed += 1
    figure_found = sum(
        1
        for label in result["report"]["figures"]
        if gold_q.get(label_key(label), {}).get("figure")
    )
    return {
        "gold": len(gold_q),
        "recorded": len(rec),
        "label_recall": round(len(set(found)) / len(gold_q), 3),
        "label_precision": round(len(set(found)) / len(rec), 3) if rec else 0,
        "extra_labels": [label for label in rec if label_key(label) not in gold_q],
        "missing_labels": [
            g["label"]
            for g in gold["questions"]
            if label_key(g["label"]) not in set(found)
        ],
        "part_structure": f"{structure}/{len(found)}",
        "part_marks_exact": f"{marks_parts}/{len(found)}",
        "question_marks_total": f"{marks_total}/{len(found)}",
        "mcq_key_on_printed_option": f"{mcq_order}/{mcq}" if mcq else None,
        "mcq_correct_option_elsewhere": mcq_elsewhere if mcq else None,
        "mcq_key_matches_gold": f"{keyed}/{mcq}" if mcq else None,
        "saved": len(result["questions"]),
        "mcq_worked_out_key_right": f"{worked_mcq_right}/{worked_mcq}"
        if worked_mcq
        else None,
        "worked_out_part_marks_right": f"{worked_marks_right}/{worked_marks}",
        "keys_worked_out_left": len(result["report"]["keysWorkedOut"]),
        "key_disagreements": result["report"]["keyDisagreements"],
        "scheme_refused": result["report"]["schemeRefused"],
        "marks_differ": result["report"]["marksDiffer"],
        "unpaired_scheme_labels": len(result["report"]["unpaired"]),
        "scheme_repeats": result["report"].get("schemeRepeats"),
        "outline_expected": len(result["report"]["expected"]),
        "outline_missing": result["report"]["missing"],
        "figures_gold": figure_gold,
        "figures_boxed_on_gold_figure_questions": figure_found,
        "figures_extra_questions": [
            label
            for label in result["report"]["figures"]
            if not gold_q.get(label_key(label), {}).get("figure")
        ],
        "window": window_scores(result),
        "boxes": box_scores(result, gold),
        "window_boxes": box_scores(result, gold, "window_box"),
        "crops": len(result.get("figures") or []),
        "crop_bytes": sorted(f["bytes"] for f in result.get("figures") or []),
        "fidelity": fidelity(result, gold, refs),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--paper", required=True, help="a gold file name, e.g. 2022-p2")
    parser.add_argument("--model", required=True, choices=sorted(MODELS))
    parser.add_argument(
        "--refs", required=True, help="the folder holding the paper PDFs"
    )
    parser.add_argument("--env-file", help="read the two provider keys from this file")
    parser.add_argument(
        "--repeat", type=int, default=1, help="the run's number, kept in the file name"
    )
    parser.add_argument(
        "--score-only", action="store_true", help="rescore a saved result"
    )
    parser.add_argument(
        "--effort",
        default="mid",
        choices=["low", "mid", "high"],
        help="the map and solve calls' thinking (the gateway pins mid)",
    )
    args = parser.parse_args()
    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / f"{run_name(args)}.json"
    if args.score_only:
        result = json.loads(out.read_text())
    else:
        load_env(args.env_file)
        result = asyncio.run(run(args))
    gold = json.loads((GOLD / f"{args.paper}.json").read_text())
    result["scores"] = score(result, gold, Path(args.refs))
    out.write_text(json.dumps(result, indent=1, ensure_ascii=False))
    summary = {
        k: result.get(k)
        for k in (
            "paper",
            "model",
            "seconds",
            "credits",
            "usd",
            "billed_usd",
            "providers",
        )
    }
    summary["usage"] = result["usage"]
    print(json.dumps({**summary, **result["scores"]}, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
