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
each call and what OpenRouter billed. ``--effort`` sets the page windows'
thinking (mid, as the gateway pins it).

Writes ``.results/<paper>-<model>-<n>.json`` (questions, report, usage, scores)
and prints the scores. Keys are read into the process only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
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
CAPTIONING = ("openrouter", "deepseek/deepseek-v4.1-flash-1017", (160, 16, 1000))
TEXT_LAYER_MIN = 40
# OpenRouter candidates for the extraction slot (2026-11-03, after 0731 proved
# text-only): each held on the providers named here with fallbacks off, as
# elitellm's production pins are (OPENROUTER_ROUTING; 1017's is production's).
# Rates are the first provider's listed prices.
OPENROUTER = {
    "v41-1017": ["InferenceNet", "Cloudflare"],
    "v41": ["InferenceNet", "DeepInfra"],
}
MODELS |= {
    "v41-1017": (
        "openrouter",
        "deepseek/deepseek-v4.1-flash-1017",
        "V4.1 Flash 1017",
        (160, 16, 1100),
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


def pin_openrouter(model_slug: str, order: list[str]) -> list[dict]:
    """Route model_slug to order with fallbacks off; the returned list fills
    with each of its calls' serving provider and OpenRouter's billed cost."""
    from pipeline.elitellm import client

    client.OPENROUTER_ROUTING[model_slug] = {"order": order, "allow_fallbacks": False}
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


async def run(args) -> dict:
    from pipeline import obs
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

    pages = [
        extraction.Page(
            number, gold["pdf"], texts[number], functools.partial(image, number)
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
    else:
        lines = [f"{q['label']}. {q['parts'][0]['correct']}" for q in gold["questions"]]
        schemes = [extraction.SchemeFile("answers.txt", "\n".join(lines))]

    provider, model_slug, name, rates = MODELS[args.model]
    model = spec(provider, model_slug, name, rates, "low")
    served = (
        pin_openrouter(model_slug, OPENROUTER[args.model])
        if args.model in OPENROUTER
        else []
    )
    # Windows run at mid, as the gateway pins them (Epo 2026-11-03).
    bind_request_llm(args.effort)
    # As the service binds it: a busy model call waits its turn once.
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
    usage = obs.start_usage()
    validate = validator(quizcheck())
    parsed: list = []
    parse_schemes = extraction.parse_schemes

    async def kept(files, *, model, labels):
        entries = await parse_schemes(files, model=model, labels=labels)
        parsed.extend(dataclasses.asdict(entry) for entry in entries)
        return entries

    extraction.parse_schemes = kept
    started = time.monotonic()
    recorded: list[dict] = []
    done: dict = {}
    async for event in extraction.run(
        pages, schemes, model=model, validate=validate, locale="en"
    ):
        if event["type"] == "questions":
            # The page's keys, before the scheme replaces worked-out ones.
            recorded = copy.deepcopy(event["questions"])
            print(f"  window: {len(recorded)} questions so far", flush=True)
        else:
            done = event
    seconds = time.monotonic() - started
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
    }


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


def score(result: dict, gold: dict) -> dict:
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
        "outline_expected": len(result["report"]["expected"]),
        "outline_missing": result["report"]["missing"],
        "figures_gold": figure_gold,
        "figures_boxed_on_gold_figure_questions": figure_found,
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
        help="the page windows' thinking (the gateway pins mid)",
    )
    args = parser.parse_args()
    RESULTS.mkdir(parents=True, exist_ok=True)
    out = RESULTS / f"{args.paper}-{args.model}-{args.repeat}.json"
    if args.score_only:
        result = json.loads(out.read_text())
    else:
        load_env(args.env_file)
        result = asyncio.run(run(args))
    gold = json.loads((GOLD / f"{args.paper}.json").read_text())
    result["scores"] = score(result, gold)
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
