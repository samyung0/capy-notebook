"""Copy every question first, then solve in parallel (Epo 2026-11-04). Report:
``reports/2026-11-04-copy-first.md``.

Call 1 has every selected page and the layout boxes, reasoning off, and records each
question with ``record_question``, which carries no answers. Each solve call is call 1's
whole conversation plus one message naming a range of questions, reasoning on, and
records ``record_answers`` for them. A map variant starts with the paper map's X, copies
in parallel batches of 16, and each solve batch continues the copy thread that holds its
questions. Around the production ``extraction.run``, through ``paper_map.py`` and
``figure_windows.py``'s patches, as the map bench is.

    python -I copy_first.py run --jobs 2022-p2:copy8:1 2023-p2:mapcopy16:2 \
        --scans <dir> --digital <dir> --detections <pp-plus-l-onnx.json> --env-file <keys>
    python -I copy_first.py run --jobs 2023-p2@2-9:copy8-probe:1 ...   # the cache probe
    python -I copy_first.py report --scans ... --digital ... --detections ...

A job's variant is ``copy<size>`` or ``mapcopy16``, plus ``-probe`` (exactly three solve
batches), ``-low`` (the copy calls at effort low instead of reasoning off) or ``-copyonly``
(no solve calls: what the copy call alone reads). Each run's system
prompt starts with a nonce, so nothing it reads from a cache was written by another run.
Results land in ``.results/copyfirst/``, the spend in its ``spend.json``. Keys are read
into the process only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import copy
import functools
import json
import math
import re
import secrets
import statistics
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import figure_matching as fm  # noqa: E402
import figure_windows as fw  # noqa: E402
import layout_score as ls  # noqa: E402
import paper_map as pm  # noqa: E402
import run as bench  # noqa: E402

OUT = bench.RESULTS / "copyfirst"
REPORT_DIR = HERE.parent / "reports" / "2026-11-04-copy-first"
# No job starts past the first; a model call does not start past the second.
SPEND_CAP = 2.9
HARD_STOP = 3.0
MAX_TOKENS = 48_000
STEPS = 12
REPAIRS = 6

# ---------------------------------------------------------------- the wording, as written

COPY_OPENING = (
    "You copy the questions printed on exam or worksheet pages into a quiz, exactly as "
    "printed. You see all the selected page images at once, each with the page's indexed "
    "text, which may be rough: the image is what counts.\n\n"
    "First you copy every question: give each its own record_question call, in printed "
    "order, from all its pages. Do not work out any answers yet. Later you are asked for "
    "the answers to some questions: give each its own record_answers call. Copy an answer "
    "the page prints; otherwise work it out, and never change the printed question."
)
MAP_OPENING = (
    "You copy the questions printed on exam or worksheet pages into a quiz, exactly as "
    "printed. You see all the selected page images at once, each with the page's indexed "
    "text, which may be rough: the image is what counts.\n\n"
    "First you are asked for a map of the questions, as plain text. Then you are asked to "
    "copy some of them: give each its own record_question call, in printed order, from all "
    "its pages. Do not work out any answers yet. Later you are asked for the answers to "
    "some questions: give each its own record_answers call. Copy an answer the page "
    "prints; otherwise work it out, and never change the printed question."
)
TYPES_AND_MARKS = (
    "- mcq: the options' text in printed order, without their letters A, B, C, D. Keep "
    "that order, and leave the options out of the part's blocks.\n"
    "- short: a single final value or word the learner types, for a part worth 1 mark with "
    "no working to show.\n"
    "- open: anything answered with working, a proof, an explanation or a drawing, and any "
    "part marked for its method or worth more than 1 mark.\n"
    '- marks: the part\'s printed marks. When only the question\'s total is printed ("(3 '
    'marks)" after (a) and (b)), split it across the parts as the work suggests and give '
    "the printed total in total_marks. An item printed without marks has 1."
)
ANSWER_RULES = (
    "Answers, when asked for them:\n"
    "- Give every part its correct answer and a short worked solution. Set key_source to "
    "printed when the page prints it, otherwise to worked_out.\n"
    '- The answer: mcq "correct" (zero-based indexes of the right options); short '
    '"accepted"; open "points", the marking points with their marks, at most 5 adding up '
    'to the part\'s marks, and "accepted", a short model answer.'
)
CLOSING = (
    "Each recorded question is checked at once. Fix what a result names and record that "
    "question again with the same label; an accepted question needs no second call. When "
    "every question or answer asked for is recorded, reply with the single word DONE."
)
COPY_ASK = (
    "Copy every question on these pages now. Give figures for each one, [] when it needs "
    "none."
)

# Tool results with no production wording: the checks only this flow has.
BAD_PAGES = "pages: expected [first, last], the page numbers it is printed on"
NO_FIGURES = "figures: give [] when it needs none"


def not_copied(label: str) -> str:
    return f"Question {label}: no question with this label was copied. Give the label it was copied with."


def no_part(label: str, part: str, parts: list[str]) -> str:
    names = ", ".join(name or '""' for name in parts)
    return f'Question {label}: it has no part "{part}"; its parts are {names}. Fix it and record it again.'


def already_copied(label: str) -> str:
    return f"Question {label}: it is already copied; give its answers with record_answers."


def not_yet(label: str) -> str:
    return f"Question {label}: not yet. Copy every question first; you are asked for the answers later."


_MAP_TOOLS = pm.map_tools


def system_prompt(nonce: str, opening: str) -> str:
    from pipeline.generated import limits
    from pipeline.prompts import extraction as prompts
    from pipeline.prompts.sources import SOURCE_RULE

    assert limits.QUIZ_MARKSCHEME_MAX == 5
    text = prompts.EXTRACT_SYSTEM
    copying = text[text.index("Copying:") : text.index("Answers:")].rstrip()
    return (
        f"Run {nonce}.\n{opening}\n\n{copying}\n{TYPES_AND_MARKS}\n\n{ANSWER_RULES}\n\n"
        f"{pm.FIGURE_RULES}\n\n{CLOSING}\n{SOURCE_RULE}"
    )


def all_tools() -> list[dict]:
    """The same list on every call: the map report's record tool without its answers,
    and a new tool for them, with production's descriptions."""
    from pipeline.prompts import extraction as prompts

    record = _MAP_TOOLS()[0]
    params = record["function"]["parameters"]
    part = params["properties"]["parts"]["items"]
    answer = part["properties"]["answer"]["properties"]
    keys = {name: answer.pop(name) for name in ("correct", "accepted", "points")}
    worked = {name: part["properties"].pop(name) for name in ("key_source", "solution")}
    part["required"] = ["label", "blocks", "answer", "marks"]
    params["properties"]["pages"] = {
        "type": "array",
        "items": {"type": "integer"},
        "minItems": 2,
        "maxItems": 2,
        "description": "The first and last page it is printed on, from its number to its last line, as the page headings give them.",
    }
    params["required"] = ["label", "stem", "parts", "pages", "figures"]
    answers = {
        "type": "function",
        "function": {
            "name": "record_answers",
            "description": "Record the answers to one question.",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": prompts._QUESTION["properties"]["label"],
                    "parts": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": prompts._PART["properties"]["label"],
                                **keys,
                                **worked,
                            },
                            "required": ["label", "key_source", "solution"],
                        },
                        "minItems": 1,
                    },
                },
                "required": ["label", "parts"],
            },
        },
    }
    return copy.deepcopy([record, answers])


def options_of(variant: str) -> dict:
    m = re.fullmatch(r"(map)?copy(\d+)((?:-\w+)*)", variant)
    flags = (m[3] or "").split("-")
    return {
        "map": bool(m[1]),
        "size": int(m[2]),
        "solve": 8 if m[1] else int(m[2]),
        "probe": "probe" in flags,
        "low": "low" in flags,
        "copyonly": "copyonly" in flags,
    }


def number_of(label: str) -> int | None:
    digits = re.findall(r"\d+", label)
    return int(digits[-1]) if digits else None


def named(labels: list[str]) -> str:
    if len(labels) == 1:
        return f"question {labels[0]}"
    return f"questions {labels[0]} to {labels[-1]}"


def runs_of(labels: list[str]) -> list[list[str]]:
    """Labels in contiguous runs of their numbers."""
    out: list[list[str]] = []
    for label in labels:
        n = number_of(label)
        last = number_of(out[-1][-1]) if out else None
        if out and n is not None and last is not None and n == last + 1:
            out[-1].append(label)
        else:
            out.append([label])
    return out


def chunks(items: list, size: int) -> list[list]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def keyless(item: dict) -> dict:
    """The copy as code keeps it: anything a copy call sent of a key taken out."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if not isinstance(part, dict):
            continue
        part.pop("solution", None)
        part.pop("key_source", None)
        if isinstance(part.get("answer"), dict):
            for name in ("correct", "accepted", "points"):
                part["answer"].pop(name, None)
    return out


def stand_in(item: dict, source: str) -> dict:
    """The copy with placeholder keys, so the production validator checks what was
    copied and nothing that comes later."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if not isinstance(part, dict) or not isinstance(part.get("answer"), dict):
            continue
        answer = part["answer"]
        kind = answer.get("type")
        if kind == "mcq":
            answer["correct"] = [0]
        elif kind == "short":
            answer["accepted"] = ["0"]
        elif kind == "open":
            answer["accepted"] = []
            answer["points"] = [{"text": "-", "marks": part.get("marks")}]
        part["solution"] = ""
        part["key_source"] = source
    return out


class SpendStop(Exception):
    pass


LIVE = {"usd": 0.0, "base": 0.0}


def install_copy() -> None:
    from pipeline.elitellm import client
    from pipeline.prompts import extraction as prompts
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import extraction

    from pipeline import elitellm

    pm.install_map()
    map_call = extraction.outline
    extraction.WINDOW_MAX_TOKENS = MAX_TOKENS
    # The map call builds its first message with these, so X has this flow's prefix.
    TOOLS = all_tools()
    pm.map_tools = lambda: TOOLS
    pm.system_prompt = lambda nonce: system_prompt(nonce, MAP_OPENING)

    stream = client._stream_sse

    async def spending(url, headers, body):
        call = pm.CALL.get()
        if call is not None:
            call["reasoning_sent"] = body.get("reasoning")
            call["max_tokens_sent"] = body.get("max_tokens")
            call["route_sent"] = (body.get("provider") or {}).get("order")
        cost = 0.0
        try:
            async for event in stream(url, headers, body):
                seen = (event.get("usage") or {}).get("cost")
                cost = seen if seen is not None else cost
                yield event
        finally:
            LIVE["usd"] += cost

    client._stream_sse = spending

    async def first_call(pages, *, model):
        state = fw.STATE.get()
        if options_of(state.variant)["map"]:
            return await map_call(pages, model=model)
        extra = state.extra
        extra.setdefault("started", time.monotonic())
        extra.setdefault("in_flight", 0)
        extra.setdefault("peak_in_flight", 0)
        extra.setdefault("call_log", [])
        nonce = extra.setdefault("nonce", secrets.token_hex(6))
        content = await pm.selection(state, pages)
        content.append({"type": "text", "text": COPY_ASK})
        extra["prefix"] = [
            {"role": "system", "content": system_prompt(nonce, COPY_OPENING)},
            {"role": "user", "content": content},
        ]
        extra["tools"] = TOOLS
        return []

    extraction.outline = first_call

    async def flow(run, pages, *, model):
        state = fw.STATE.get()
        extra = state.extra
        options = options_of(state.variant)
        extra["flow_attempts"] = extra.get("flow_attempts", 0) + 1
        run.recorded.clear()
        run.order.clear()
        run.full = False
        items: dict[str, dict] = {}
        spans: dict[str, list[int]] = {}
        answered: set[str] = set()
        refusals: list[dict] = []
        odd: collections.Counter = collections.Counter()
        tools = extra["tools"]
        label_key = extraction.label_key

        async def copied(args: dict) -> str:
            new = extraction.record(stand_in(args, extraction.WORKED_OUT), run.ai_label)
            if not new.label or not new.question["parts"]:
                return (
                    "A question needs its printed label and at least one part, given "
                    "as the call's arguments themselves."
                )
            key = label_key(new.label)
            run.order.setdefault(key, len(run.order))
            sent = args.get("pages")
            numbers = {p.number for p in pages}
            problem = None
            if not (
                isinstance(sent, list)
                and len(sent) == 2
                and all(type(n) is int and n in numbers for n in sent)
                and sent[0] <= sent[1]
            ):
                problem = BAD_PAGES
            elif "figures" not in args:
                problem = NO_FIGURES
            if problem is None:
                new.figures, problem = extraction.read_figures(
                    args.get("figures"), pages, new.part_labels
                )
            problem = problem or await run.validate(new.question)
            if problem:
                return f"Question {new.label}: {problem}. Fix it and record it again."
            if not run._fits(key, new.question):
                run.full = True
                return (
                    f"Question {new.label} was not recorded: a quiz holds at most "
                    f"{extraction.limits.QUIZ_PARTS_MAX} parts and "
                    f"{extraction.limits.QUIZ_OPEN_PARTS_MAX} AI-marked parts. Record "
                    "nothing more."
                )
            held = run.recorded.get(key)
            if held is not None:
                new.question["id"] = held.question["id"]
            run.recorded[key] = new
            kept = keyless(args)
            if kept != args:
                odd["keys in a copy call"] += 1
            items[key] = kept
            spans[key] = sent
            return f"Question {new.label}: recorded."

        async def filled(args: dict) -> str:
            label = str(args.get("label") or "").strip()
            key = label_key(label)
            if key not in items:
                return not_copied(label)
            merged = copy.deepcopy(items[key])
            by_part = {
                label_key(str(p.get("label") or "")): p for p in merged["parts"]
            }
            for given in args.get("parts") or []:
                given = given if isinstance(given, dict) else {}
                name = str(given.get("label") or "")
                part = by_part.get(label_key(name))
                if part is None:
                    return no_part(
                        label,
                        name,
                        [str(p.get("label") or "") for p in merged["parts"]],
                    )
                answer = part.get("answer")
                answer = answer if isinstance(answer, dict) else {}
                part["answer"] = answer
                for field in ("correct", "accepted", "points"):
                    if field in given:
                        value = given[field]
                        answer[field] = value if isinstance(value, list) else [value]
                part["solution"] = given.get("solution")
                part["key_source"] = given.get("key_source")
            result = await run.add(merged, {key}, pages)
            if result.endswith("recorded."):
                answered.add(key)
            return result

        async def handle(name, args, *, solving: bool) -> str:
            if name == "record_question":
                label = str(args.get("label") or "").strip()
                if solving and label_key(label) in items:
                    odd["copy call while solving"] += 1
                    return already_copied(label)
                if solving:
                    odd["new question while solving"] += 1
                result = await copied(args)
                parts = len(args.get("parts") or [])
                state.calls[-1]["results"].append(
                    ["record", bench._outcome(result), parts]
                )
                return result
            if name == "record_answers":
                if not solving:
                    odd["answers while copying"] += 1
                    return not_yet(str(args.get("label") or "").strip())
                return await filled(args)
            return f"There is no tool {name}."

        async def thread(
            start: list[dict], *, stage: str, batch, solving: bool, off: bool
        ) -> list[dict]:
            """Up to STEPS rounds; the whole conversation, its last reply included."""
            messages = list(start)
            prefix = len(messages) - 1
            rounds = 0
            for step in range(STEPS):
                if LIVE["base"] + LIVE["usd"] > HARD_STOP:
                    raise SpendStop(f"${LIVE['base'] + LIVE['usd']:.3f}")
                call = {
                    "stage": stage,
                    "batch": batch,
                    "round": step,
                    "prefix_messages": prefix,
                }
                low = off and options["low"]
                if low:
                    bind_request_llm("low")
                pm.CALL.set(call)
                try:
                    response = await extraction.models.complete_response(
                        messages,
                        model=model,
                        tools=tools,
                        max_tokens=MAX_TOKENS,
                        reasoning=False if off and not low else None,
                        call_purpose="extraction_window",
                    )
                finally:
                    pm.CALL.set(None)
                    if low:
                        bind_request_llm("mid")
                rounds += 1
                run.output_tokens += response.usage.output_tokens
                if run.over_budget:
                    extra["over_budget"] = True
                    break
                if response.choices[0].finish_reason == "length":
                    messages.append({"role": "user", "content": prompts.CUT_OFF})
                    continue
                reply = elitellm.assistant_message_from_obj(
                    elitellm.message_from_response(response)
                )
                messages.append(reply)
                calls = reply.get("tool_calls") or []
                call["tool_calls"] = len(calls)
                call["reply_keys"] = sorted(reply)
                call["reasoning_chars"] = len(reply.get("reasoning") or "")
                accepted = 0
                if not calls:
                    call["text"] = str(reply.get("content") or "")[:40]
                    break
                for tool_call in calls:
                    name, args = extraction._call_args(tool_call)
                    result = (
                        args
                        if isinstance(args, str)
                        else await handle(name, args, solving=solving)
                    )
                    if result.endswith("recorded."):
                        accepted += 1
                    else:
                        refusals.append(
                            {
                                "stage": stage,
                                "batch": batch,
                                "round": step,
                                "result": result[:300],
                            }
                        )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.get("id"),
                            "content": result,
                        }
                    )
                call["accepted"] = accepted
                if run.full:
                    break
            extra.setdefault("thread_rounds", []).append(
                {"stage": stage, "batch": batch, "rounds": rounds}
            )
            return messages

        def user(text: str) -> dict:
            return {"role": "user", "content": text}

        def labels_now() -> list[str]:
            return [run.recorded[key].label for key in items]

        def gaps_now() -> list[str]:
            """Numbers missing inside the copied labels, then the next number when it
            is printed on a page past the last copied question's: a page no row covers."""
            numbers = {number_of(label) for label in labels_now()} - {None}
            if not numbers:
                return []
            gaps = set(range(min(numbers), max(numbers) + 1)) - numbers
            out = [str(n) for n in sorted(gaps)]
            last = max(numbers)
            last_page = max(
                (span[1] for key, span in spans.items()),
                default=pages[0].number,
            )
            next_line = re.compile(rf"(?m)^\W*{last + 1}\s*[.)]?(\s|$)")
            if any(p.number > last_page and next_line.search(p.text) for p in pages):
                out.append(str(last + 1))
            return out

        tried: set[str] = set()

        async def repair_copies(
            conversation: list[dict], *, batch, missing: list[str]
        ) -> list[dict]:
            for labels in runs_of(missing):
                ask = f"Copy {named(labels)} now."
                if ask in tried:
                    continue
                tried.add(ask)
                extra.setdefault("repairs", []).append(ask)
                conversation = await thread(
                    [*conversation, user(ask)],
                    stage="copy",
                    batch=batch,
                    solving=False,
                    off=True,
                )
            return conversation

        def in_order() -> None:
            """Printed order, by number, once repairs may have come late."""
            keys = list(run.order)
            numbers = [number_of(k) for k in keys]
            if None not in numbers and len(set(numbers)) == len(numbers):
                keys.sort(key=lambda k: number_of(k))
            run.order.clear()
            run.order.update({k: n for n, k in enumerate(keys)})

        solve_groups: list[tuple[list[str], list[dict]]] = []
        map_groups: list[list[str]] = []
        if options["map"]:
            rows = extra["map"]
            run.output_tokens += extra["x_output"]
            for n, row in enumerate(rows):
                run.order[label_key(row["label"])] = n
            base = [*extra["prefix"], extra["reply"]]
            map_groups = [
                [r["label"] for r in g] for g in chunks(rows, options["size"])
            ]
            extra["batches"] = map_groups
            threads: dict[int, list[dict]] = {}

            async def copy_batch(index: int, labels: list[str]) -> None:
                threads[index] = await thread(
                    [*base, user(f"Copy {named(labels)} now.")],
                    stage="copybatch",
                    batch=index,
                    solving=False,
                    off=True,
                )

            results = await asyncio.gather(
                *(
                    extraction._attempted(functools.partial(copy_batch, i, g))
                    for i, g in enumerate(map_groups)
                ),
                return_exceptions=True,
            )
            extra["batch_failures"] = [
                {"batch": i, "error": repr(f)[:200]}
                for i, f in enumerate(results)
                if isinstance(f, BaseException)
            ]
            for _ in range(REPAIRS):
                held = {label_key(label) for label in labels_now()}
                missing = [
                    (i, label)
                    for i, labels in enumerate(map_groups)
                    for label in labels
                    if label_key(label) not in held
                ]
                gaps = gaps_now()
                for gap in gaps:
                    n = int(gap)
                    index = next(
                        (
                            i
                            for i, labels in enumerate(map_groups)
                            if max(number_of(x) or 0 for x in labels) >= n
                        ),
                        len(map_groups) - 1,
                    )
                    if not any(label == gap for _, label in missing):
                        missing.append((index, gap))
                if not missing or all(
                    f"Copy question {label} now." in tried for _, label in missing
                ):
                    break
                for index in sorted({i for i, _ in missing}):
                    wanted = sorted(
                        (label for i, label in missing if i == index),
                        key=lambda x: number_of(x) or 0,
                    )
                    threads[index] = await repair_copies(
                        threads.get(index, [*base]), batch=index, missing=wanted
                    )
            for index in sorted(threads):
                held = {label_key(label) for label in labels_now()}
                labels = [
                    label
                    for label in map_groups[index]
                    if label_key(label) in held
                ]
                for group in chunks(labels, options["solve"]):
                    solve_groups.append((group, threads[index]))
        else:
            conversation = await thread(
                extra["prefix"], stage="copy", batch=0, solving=False, off=True
            )
            for _ in range(REPAIRS):
                missing = gaps_now()
                if not missing or all(
                    f"Copy question {label} now." in tried for label in missing
                ):
                    break
                conversation = await repair_copies(
                    conversation, batch="repair", missing=missing
                )
            threads = {0: conversation}
        in_order()
        extra["copy_done_at"] = round(time.monotonic() - extra["started"], 1)
        ordered = [held.label for held in run.held()]
        if not options["map"]:
            size = options["solve"]
            if options["probe"]:
                size = max(1, math.ceil(len(ordered) / 3))
            solve_groups = [(g, threads[0]) for g in chunks(ordered, size)]
        if options["copyonly"]:
            solve_groups = []
        extra["solve_batches"] = [g for g, _ in solve_groups]

        async def solve(batch, labels: list[str], start: list[dict]) -> None:
            ask = f"Give the answers to {named(labels)} now."
            await thread(
                [*start, user(ask)], stage="solve", batch=batch, solving=True, off=False
            )

        results = await asyncio.gather(
            *(
                extraction._attempted(functools.partial(solve, i, g, start))
                for i, (g, start) in enumerate(solve_groups)
            ),
            return_exceptions=True,
        )
        extra.setdefault("batch_failures", []).extend(
            {"batch": f"solve {i}", "error": repr(f)[:200]}
            for i, f in enumerate(results)
            if isinstance(f, BaseException)
        )

        def base_of(label: str) -> list[dict]:
            for labels, start in solve_groups:
                if label in labels:
                    return start
            return threads[0] if 0 in threads else []

        for attempt in range(0 if options["copyonly"] else 2):
            missing = [
                label for label in ordered if label_key(label) not in answered
            ]
            if not missing:
                break
            jobs = []
            for labels in runs_of(missing):
                extra.setdefault("repairs", []).append(
                    f"Give the answers to {named(labels)} now."
                )
                jobs.append(
                    extraction._attempted(
                        functools.partial(
                            solve, f"repair{attempt}-{labels[0]}", labels, base_of(labels[0])
                        )
                    )
                )
            results = await asyncio.gather(*jobs, return_exceptions=True)
            extra["batch_failures"].extend(
                {"batch": f"repair {attempt}", "error": repr(f)[:200]}
                for f in results
                if isinstance(f, BaseException)
            )

        # A copied question with no answers stays in the quiz with empty keys, for the
        # scheme to fill, and counts as not filled.
        for key, item in items.items():
            if key in answered:
                continue
            bare = copy.deepcopy(item)
            for part in bare["parts"]:
                part["key_source"] = extraction.WORKED_OUT
            held = extraction.record(bare, run.ai_label)
            held.figures = run.recorded[key].figures
            held.question["id"] = run.recorded[key].question["id"]
            run.recorded[key] = held

        extra["copied"] = len(items)
        extra["answered"] = len(answered)
        extra["not_answered"] = [
            run.recorded[key].label for key in items if key not in answered
        ]
        extra["refusals"] = refusals
        extra["odd"] = dict(odd)
        extra["copy_rows"] = [
            {
                "label": run.recorded[key].label,
                "first": spans[key][0],
                "last": spans[key][1],
                "parts": run.recorded[key].part_labels,
                "figures": sorted(
                    {
                        n
                        for f in items[key].get("figures") or []
                        if isinstance(f, dict)
                        for n in (f.get("boxes") or [])
                        if type(n) is int
                    }
                ),
                "figures_given": len(items[key].get("figures") or []),
            }
            for key in sorted(
                items, key=lambda k: run.order.get(k, 0)
            )
        ]
        numbers = {number_of(r["label"]) for r in extra["copy_rows"]} - {None}
        covered = {
            n
            for r in extra["copy_rows"]
            for n in range(r["first"], r["last"] + 1)
        }
        extra["map_check"] = {
            "number_gaps": sorted(set(range(min(numbers), max(numbers) + 1)) - numbers)
            if numbers
            else [],
            "pages_no_row_covers": [
                p.number for p in pages if p.number not in covered
            ],
        }
        for key in ("prefix", "tools", "reply", "started", "in_flight"):
            extra.pop(key, None)

    extraction._window = flow


# -------------------------------------------------------------------- the report

PAPERS = ["2022-p2", "2023-p2"]


def load_runs() -> dict[str, dict[str, list[dict]]]:
    runs: dict[str, dict[str, list[dict]]] = {}
    for path in sorted(OUT.glob("*-all-*.json")):
        data = json.loads(path.read_text())
        runs.setdefault(data["variant"], {}).setdefault(data["paper"], []).append(data)
    return runs


def baselines(paper: str) -> dict[str, list[dict]]:
    """The map report's saved runs of a paper."""

    def load(folder: str, names: list[str]) -> list[dict]:
        paths = [bench.RESULTS / folder / f"{paper}-all-{n}.json" for n in names]
        return [json.loads(path.read_text()) for path in paths if path.exists()]

    return {
        "map8": load("maps", ["map8-1", "map8-2"]),
        "map8-label": load("maps", ["map8-label-1", "map8-label-2", "map8-label-3"]),
        "window": load("windows", ["boxes-1", "boxes-2"]),
    }


def spread(values: list[float], places: int = 0) -> str:
    if not values:
        return "-"
    mean = statistics.fmean(values)
    return f"{mean:.{places}f} ({min(values):.{places}f}-{max(values):.{places}f})"


def is_copy(call: dict) -> bool:
    return call.get("stage") in ("copy", "copybatch")


def answered_calls(j: dict, stage) -> list[dict]:
    return [c for c in j["call_log"] if stage(c) and "input" in c]


def batch_labels(j: dict, batch) -> list[str]:
    batches = j.get("solve_batches") or []
    return batches[batch] if isinstance(batch, int) and batch < len(batches) else []


def keys_of(j: dict) -> dict[str, list]:
    from pipeline.retrieval.extraction import label_key

    return {
        label_key(label): q["parts"][0]["answer"].get("correct")
        for label, q in zip(j["report"]["recorded"], j["recorded"], strict=False)
    }


def shape(j: dict) -> dict:
    """On a paper of one-mark multiple choice: one part, mcq, 1 mark."""
    questions = j["questions"]
    return {
        "one_part_mcq": sum(
            1
            for q in questions
            if len(q["parts"]) == 1 and q["parts"][0]["answer"]["type"] == "mcq"
        ),
        "one_mark": sum(1 for q in questions if sum(p["marks"] for p in q["parts"]) == 1),
        "four_options": sum(
            1
            for q in questions
            if len(q["parts"][0]["answer"].get("options") or []) == 4
        ),
    }


def report(args) -> None:
    from pipeline.retrieval.extraction import label_key

    det = fm.load_detections(args.detections)
    gold = ls.gold_figures()
    eye = fm.load_eye()
    runs = load_runs()
    order = sorted(runs)
    solving = [v for v in order if not options_of(v)["copyonly"]]

    print("== cost and time, mean (lowest-highest)")
    for paper in PAPERS:
        for name, listed in [
            *((v, runs[v].get(paper, [])) for v in order),
            *baselines(paper).items(),
        ]:
            if not listed:
                continue
            print(
                paper,
                name,
                f"runs {len(listed)}",
                "wall",
                spread([j["seconds"] for j in listed]),
                "copied by",
                spread([j["copy_done_at"] for j in listed if "copy_done_at" in j]),
                "$",
                spread([j["billed_usd"] for j in listed], 4),
                "credits",
                spread([pm.credits(j["usage"]) for j in listed], 1),
                "calls",
                spread([j["usage"]["calls"] for j in listed], 1),
                "peak",
                [j.get("peak_in_flight") for j in listed],
                "MB",
                spread(
                    [
                        sum(c.get("body_bytes", 0) for c in j.get("call_log", [])) / 1e6
                        for j in listed
                    ],
                    1,
                ),
                "input",
                spread([j["usage"]["inputTokens"] for j in listed]),
                "cached",
                spread([j["usage"]["cachedReadTokens"] for j in listed]),
                "output",
                spread([j["usage"]["outputTokens"] for j in listed]),
                "reasoning",
                spread([j["usage"].get("reasoningTokens", 0) for j in listed]),
            )

    print("\n== the copy stage, each run")
    for variant in order:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                copies = answered_calls(j, is_copy)
                failed = [c for c in j["call_log"] if is_copy(c) and "input" not in c]
                x = next((c for c in j["call_log"] if c["stage"] == "X"), None)
                count = j.get("copied") or 0
                output = sum(c["output"] for c in copies)
                threads = [
                    t["rounds"]
                    for t in j.get("thread_rounds", [])
                    if t["stage"] in ("copy", "copybatch")
                ]
                print(
                    j["name"],
                    "copied",
                    count,
                    "rounds per thread",
                    threads,
                    "tool calls a reply",
                    [c.get("tool_calls") for c in copies],
                    "output",
                    output,
                    "per question",
                    round(output / count) if count else None,
                    "reasoning",
                    sum(c["reasoning"] for c in copies),
                    "largest reply",
                    max((c["output"] for c in copies), default=0),
                    "cut off",
                    sum(1 for c in copies if c["finish"] == "length"),
                    "failed",
                    [(c.get("error") or "")[:70] for c in failed],
                    "failed cost",
                    round(sum(c.get("cost") or 0 for c in failed), 5),
                    "flow attempts",
                    j.get("flow_attempts"),
                    "questions naming figures",
                    sum(1 for r in j.get("copy_rows", []) if r["figures_given"]),
                    "copy share first rounds",
                    [
                        round(c["cached"] / c["input"], 3)
                        for c in copies
                        if c["round"] == 0
                    ],
                    "X",
                    (x["output"], x["reasoning"], x["seconds"]) if x and "output" in x else None,
                )

    print("\n== the solve stage, each run")
    for variant in solving:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                solves = answered_calls(j, lambda c: c.get("stage") == "solve")
                first = [c for c in solves if c["round"] == 0]
                later = [c for c in solves if c["round"] > 0]
                top = max(solves, key=lambda c: c["output"], default=None)
                longest = max(solves, key=lambda c: c["seconds"] or 0, default=None)
                threads = [
                    t["rounds"]
                    for t in j.get("thread_rounds", [])
                    if t["stage"] == "solve"
                ]
                named_batch = {}
                for c in first:
                    labels = batch_labels(j, c["batch"])
                    if labels and labels[0] == "17":
                        named_batch = {
                            "labels": f"{labels[0]}-{labels[-1]}",
                            "output": c["output"],
                            "reasoning": c["reasoning"],
                            "seconds": c["seconds"],
                            "finish": c["finish"],
                            "tool_calls": c.get("tool_calls"),
                        }
                print(
                    j["name"],
                    "first share min/mean",
                    round(min((c["cached"] / c["input"] for c in first), default=0), 3),
                    round(
                        statistics.fmean(c["cached"] / c["input"] for c in first), 3
                    )
                    if first
                    else None,
                    "later min/mean",
                    round(min((c["cached"] / c["input"] for c in later), default=0), 3),
                    round(
                        statistics.fmean(c["cached"] / c["input"] for c in later), 3
                    )
                    if later
                    else None,
                    "largest reply",
                    (top["output"], top["reasoning"], top["seconds"]) if top else None,
                    "longest s",
                    longest["seconds"] if longest else None,
                    "first-round outputs",
                    [c["output"] for c in first],
                    "over 24000",
                    sum(1 for c in solves if c["output"] > 24_000),
                    "cut off",
                    sum(1 for c in solves if c["finish"] == "length"),
                    "rounds",
                    threads,
                    "Q17 batch",
                    named_batch,
                    "failed",
                    [
                        (c.get("error") or "")[:70]
                        for c in j["call_log"]
                        if c.get("stage") == "solve" and "input" not in c
                    ],
                    "sha sets",
                    len(
                        {
                            c.get("prefix_sha")
                            for c in first
                        }
                    ),
                )

    print("\n== questions, answers, checks, each run")
    truth = {
        paper: (pm.page_truth(paper, args), pm.part_truth(paper, args))
        for paper in PAPERS
    }
    for variant in order:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                pages_truth, parts_truth = truth[paper]
                rows = pm.map_rows(
                    {
                        "map": [
                            {**r, "parts": [name for name in r["parts"] if name]}
                            for r in j.get("copy_rows") or []
                        ]
                    },
                    pages_truth,
                    parts_truth,
                )
                map_rows = (
                    pm.map_rows(j, pages_truth, parts_truth) if "map" in j else None
                )
                print(
                    j["name"],
                    "recorded",
                    len(j["report"]["recorded"]),
                    "answered",
                    j.get("answered"),
                    "not answered",
                    j.get("not_answered"),
                    "repairs",
                    j.get("repairs"),
                    "check",
                    j.get("map_check"),
                    "refusals",
                    len(j.get("refusals") or []),
                    sorted(
                        collections.Counter(
                            re.sub(r"\d+", "N", r["result"])[:70]
                            for r in j.get("refusals") or []
                        ).items()
                    ),
                    "odd",
                    j.get("odd"),
                    "failures",
                    j.get("batch_failures"),
                    "stopped",
                    repr(j["report"]["stopped"]),
                    "over budget",
                    j.get("over_budget"),
                    "pages wrong",
                    rows["pages_wrong"],
                    "parts wrong",
                    rows["parts_wrong"],
                    "labels missing",
                    rows["labels_missing"],
                    "extra",
                    rows["labels_extra"],
                    "map",
                    {
                        k: len(map_rows[k])
                        for k in ("labels_missing", "labels_extra", "pages_wrong", "parts_wrong")
                    }
                    if map_rows
                    else None,
                    "shape",
                    shape(j),
                )

    print("\n== figures against gold, sums over a set's runs")

    def figure_line(paper: str, name: str, listed: list[dict], *, fill: bool = False) -> None:
        rows, unnamed = [], []
        wanted = sum(len(gold.get(fm.stem_of(paper, n), [])) for n in listed[0]["pages"])
        for j in listed:
            pseudo = j
            if fill and "map" in j:
                pseudo = {
                    "paper": paper,
                    "pages": j["pages"],
                    "figures": pm.filled_figures(j, det),
                }
            scored = fw.job_rows(pseudo, det, gold, eye)
            rows += scored["rows"]
            unnamed += scored["unnamed"]
        for status in ("gold", "eye"):
            t = fm.tally([r for r in rows if r.get("status") == status])
            if status == "gold" and not wanted:
                continue
            if status == "eye" and not t["named"] and wanted:
                continue
            print(
                paper,
                name + (" filled" if fill else ""),
                status,
                f"gold per run {wanted}, {len(listed)} runs",
                "whole",
                t["whole"],
                "tight",
                t["tight"],
                "both",
                t["both"],
                "named",
                t["named"],
                "wrong",
                t["wrong"],
                "unchecked",
                t["unchecked"],
                "never named",
                len(unnamed),
                sorted(collections.Counter(unnamed).items()),
                "extra names",
                sum(1 for r in rows if r.get("status") == "extra name"),
            )
        wrong = collections.Counter(
            (r["page"], r["label"], r.get("whole"), r.get("tight"), str(r.get("numbers")))
            for r in rows
            if r.get("status") in ("gold", "eye")
            and (r.get("whole") is False or r.get("tight") is False or r.get("right") is False)
        )
        for k, v in sorted(wrong.items(), key=str):
            print("    ", v, "x", k)
        print(
            "     questions naming figures, each run:",
            [sorted({f["label"] for f in j["figures"]}, key=len) for j in listed][:1],
            [len(j["figures"]) for j in listed],
        )

    for paper in PAPERS:
        for variant in order:
            if runs[variant].get(paper):
                figure_line(paper, variant, runs[variant][paper])
                if options_of(variant)["map"]:
                    figure_line(paper, variant, runs[variant][paper], fill=True)
        for name, listed in baselines(paper).items():
            if listed:
                figure_line(paper, name, listed)

    print("\n== reading, each run and the sums")
    fields = (
        "labels",
        "structure",
        "marks",
        "total_marks",
        "mcq_worked",
        "worked_marks",
        "mcq_gold",
        "disagreements",
        "numbers",
        "unsupported",
        "dropped",
        "units_off",
        "exact",
        "katex",
        "stray",
        "refused",
        "stopped",
    )
    print("paper set " + " ".join(fields))
    for paper in PAPERS:
        sets = [
            *((v, runs[v].get(paper, [])) for v in order),
            *baselines(paper).items(),
        ]
        for name, listed in sets:
            totals = {"unsupported": 0, "dropped": 0, "exact": [0, 0], "units_off": 0}
            for j in listed:
                r = fw.reading(j)
                print(paper, name, " ".join(str(r[k]) for k in fields))
                totals["unsupported"] += r["unsupported"] or 0
                totals["dropped"] += r["dropped"] or 0
                totals["units_off"] += r["units_off"] or 0
                a, _, b = r["exact"].partition("/")
                if a.isdigit() and b.isdigit():
                    totals["exact"][0] += int(a)
                    totals["exact"][1] += int(b)
            if listed:
                n = len(listed)
                print(
                    paper,
                    name,
                    "MEAN a run",
                    "unsupported",
                    round(totals["unsupported"] / n, 1),
                    "dropped",
                    round(totals["dropped"] / n, 1),
                    "units off",
                    round(totals["units_off"] / n, 1),
                    "exact",
                    round(totals["exact"][0] / n, 1),
                    "of",
                    round(totals["exact"][1] / n, 1),
                )

    print("\n== 2022 P2: wrong worked-out keys against gold, and Q34")
    gold_keys = {
        label_key(q["label"]): ord(q["parts"][0]["correct"]) - ord("A")
        for q in fw.gold_of("2022-p2")["questions"]
    }
    for name, listed in [
        *((v, runs[v].get("2022-p2", [])) for v in solving),
        *baselines("2022-p2").items(),
    ]:
        for j in listed:
            keys = keys_of(j)
            wrong = sorted(
                (k for k, want in gold_keys.items() if keys.get(k) != [want]),
                key=lambda k: (len(k), k),
            )
            known = pm.known_failures(j)
            print(
                name,
                j["name"],
                "wrong keys",
                wrong,
                "q34 number",
                known.get("q34_number"),
                "q34 exponents",
                known.get("q34_exponents"),
            )

    print("\n== 2023 P2: keys across runs")
    sets = [
        *((v, runs[v].get("2023-p2", [])) for v in solving),
        *baselines("2023-p2").items(),
    ]
    every = [(name, keys_of(j)) for name, listed in sets for j in listed]
    labels = sorted({k for _, keys in every for k in keys}, key=lambda k: (len(k), k))
    majority = {}
    split = []
    for k in labels:
        votes = collections.Counter(str(keys.get(k)) for _, keys in every)
        majority[k] = votes.most_common(1)[0][0]
        if len(votes) > 1:
            split.append(k)
            print("Q" + k, dict(votes))
    print("questions with any split", len(split), "of", len(labels))
    for name, listed in sets:
        if not listed:
            continue
        keys = [keys_of(j) for j in listed]
        inside = [k for k in labels if len({str(m.get(k)) for m in keys}) > 1]
        off = [
            sum(1 for k in labels if str(m.get(k)) != majority[k]) for m in keys
        ]
        print(
            name,
            "runs",
            len(listed),
            "questions its runs disagree on",
            len(inside),
            inside,
            "keys off the all-run majority, each run",
            off,
        )

    print("\n== text across runs: questions a set's runs read differently from all runs' commonest")
    for paper in PAPERS:
        sets = [
            *((v, runs[v].get(paper, [])) for v in order),
            *baselines(paper).items(),
        ]

        def texts(j: dict) -> dict[str, str]:
            return {
                label_key(label): pm.plain(bench.question_text(q))
                for label, q in zip(j["report"]["recorded"], j["questions"], strict=False)
            }

        def numbers_of(j: dict) -> dict[str, tuple]:
            return {
                label_key(label): tuple(
                    sorted(bench.numbers(bench.question_text(q)).elements())
                )
                for label, q in zip(j["report"]["recorded"], j["questions"], strict=False)
            }

        every = [j for _, listed in sets for j in listed]
        for kind, read in (("numbers", numbers_of), ("spacing-free text", texts)):
            all_runs = [read(j) for j in every]
            keys = sorted({k for r in all_runs for k in r}, key=lambda k: (len(k), k))
            common = {
                k: collections.Counter(r[k] for r in all_runs if k in r).most_common(1)[0][0]
                for k in keys
            }
            split = [
                k for k in keys if len({r[k] for r in all_runs if k in r}) > 1
            ]
            print(paper, kind, "questions any run differs on", len(split), split[:30])
            for name, listed in sets:
                if listed:
                    off = [
                        [k for k in keys if k in read(j) and read(j)[k] != common[k]]
                        for j in listed
                    ]
                    print(
                        paper,
                        kind,
                        name,
                        "off the commonest, each run",
                        [len(o) for o in off],
                        off if kind == "numbers" else "",
                    )

    print("\n== 2022 P2 Q34: zeros after CD in each run's number, and the indexed text")
    q34 = re.compile(r"12B00CD(0+)E")
    for path in sorted((bench.RESULTS / "text").glob("2022-p2-[0-9][0-9].txt")):
        found = q34.findall(pm.plain(path.read_text()))
        if found:
            print(path.stem, "indexed text zeros", [len(z) for z in found])
    for name, listed in [
        *((v, runs[v].get("2022-p2", [])) for v in order),
        *baselines("2022-p2").items(),
    ]:
        for j in listed:
            held = dict(zip(j["report"]["recorded"], j["questions"], strict=False))
            found = q34.findall(pm.plain(bench.question_text(held["34"])))
            spent = [
                c["reasoning"]
                for c in j.get("call_log", [])
                if is_copy(c) and "input" in c
            ]
            print(
                name,
                j["name"],
                "zeros",
                [len(z) for z in found],
                "copy-stage reasoning",
                sum(spent),
            )

    print("\n== math written \\( \\) instead of $, which parseMathText shows as raw text")
    indexed = "".join(
        path.read_text() for path in (bench.RESULTS / "text").glob("2022-p2-[0-9][0-9].txt")
    )
    print("2022-p2 indexed text: \\( count", indexed.count("\\("), "$ count", indexed.count("$"))
    for paper in PAPERS:
        for name, listed in [
            *((v, runs[v].get(paper, [])) for v in order),
            *baselines(paper).items(),
        ]:
            print(
                paper,
                name,
                "questions with it, each run",
                [
                    sum("\\(" in bench.question_text(q) for q in j["questions"])
                    for j in listed
                ],
            )

    print("\n== where the reasoning went, each run")
    for variant in solving:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                copies = answered_calls(j, is_copy)
                solves = answered_calls(j, lambda c: c.get("stage") == "solve")
                print(
                    j["name"],
                    "copy reasoning",
                    sum(c["reasoning"] for c in copies),
                    "solve reasoning",
                    sum(c["reasoning"] for c in solves),
                    "copy replies over 5000 output",
                    [
                        (c["round"], c["output"], c["reasoning"], c.get("tool_calls"))
                        for c in copies
                        if c["output"] > 5000
                    ],
                    "copied by",
                    j["copy_done_at"],
                    "slowest solve s",
                    max((c["seconds"] for c in solves), default=None),
                    "wall",
                    j["seconds"],
                )

    print("\n== the cache, over all solve calls")
    first_all, later_all = [], []
    for variant in solving:
        first, later = [], []
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                solves = answered_calls(j, lambda c: c.get("stage") == "solve")
                first += [c["cached"] / c["input"] for c in solves if c["round"] == 0]
                later += [c["cached"] / c["input"] for c in solves if c["round"] > 0]
        first_all += first
        later_all += later
        print(
            variant,
            "first rounds",
            len(first),
            round(min(first), 3),
            round(statistics.fmean(first), 3),
            "later rounds",
            len(later),
            round(min(later), 3),
            round(statistics.fmean(later), 3),
        )
    print(
        "ALL first rounds",
        len(first_all),
        round(min(first_all), 3),
        round(statistics.fmean(first_all), 3),
        "later",
        len(later_all),
        round(min(later_all), 3),
        round(statistics.fmean(later_all), 3),
    )
    providers: collections.Counter = collections.Counter()
    sent: collections.Counter = collections.Counter()
    for variant in order:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                for c in j["call_log"]:
                    providers[c.get("provider") or "failed"] += 1
                    sent[(c["stage"], json.dumps(c.get("reasoning_sent")), c.get("max_tokens_sent"))] += 1
    print("providers", dict(providers))
    print("settings sent", sorted(sent.items(), key=str))

    print("\n== a run with a failed call")
    for variant in order:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                if (j.get("flow_attempts") or 1) > 1 or any(
                    "input" not in c for c in j["call_log"]
                ):
                    for c in sorted(j["call_log"], key=lambda c: c.get("at") or 0):
                        print(
                            j["name"],
                            c["stage"],
                            c.get("batch"),
                            c.get("round"),
                            "at",
                            c.get("at"),
                            "took",
                            c.get("seconds"),
                            "in",
                            c.get("input"),
                            "cached",
                            c.get("cached"),
                            "out",
                            c.get("output"),
                            "reasoning",
                            c.get("reasoning"),
                            "cost",
                            c.get("cost"),
                            "error",
                            (c.get("error") or "")[:70],
                        )

    print("\n== InferenceNet's rates, fitted over every call")
    samples = []
    for variant in order:
        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                samples += [
                    c
                    for c in j["call_log"]
                    if c.get("cost") and "input" in c and c.get("provider") == "InferenceNet"
                ]
    rows = [
        [c["input"] - c["cached"], c["cached"], c["output"], c["cost"]] for c in samples
    ]
    a = [[sum(r[i] * r[j] for r in rows) for j in range(3)] for i in range(3)]
    b = [sum(r[i] * r[3] for r in rows) for i in range(3)]
    for i in range(3):
        for k in range(i + 1, 3):
            f = a[k][i] / a[i][i]
            a[k] = [x - f * y for x, y in zip(a[k], a[i])]
            b[k] -= f * b[i]
    rates = [0.0, 0.0, 0.0]
    for i in (2, 1, 0):
        rates[i] = (b[i] - sum(a[i][j] * rates[j] for j in range(i + 1, 3))) / a[i][i]
    print(
        "calls",
        len(samples),
        "$ per million: uncached, cached, output",
        [round(x * 1e6, 4) for x in rates],
    )
    print(
        "upload body MB by stage, lowest and highest",
        {
            stage: (
                round(min(c.get("body_bytes", 0) for c in samples if c["stage"] == stage) / 1e6, 2),
                round(max(c.get("body_bytes", 0) for c in samples if c["stage"] == stage) / 1e6, 2),
            )
            for stage in sorted({c["stage"] for c in samples})
        },
        "first event s, median and highest",
        round(statistics.median(c.get("first_event_s") or 0 for c in samples), 2),
        max(c.get("first_event_s") or 0 for c in samples),
    )

    print("\n== each stage's cost and time, mean over a set's runs")
    for paper in PAPERS:
        for variant in order:
            listed = runs[variant].get(paper, [])
            if not listed:
                continue

            def stage_sum(j: dict, test, field: str) -> float:
                return sum(c.get(field) or 0 for c in j["call_log"] if test(c))

            print(
                paper,
                variant,
                "X $",
                round(
                    statistics.fmean(
                        stage_sum(j, lambda c: c["stage"] == "X", "cost") for j in listed
                    ),
                    4,
                ),
                "copy $",
                round(statistics.fmean(stage_sum(j, is_copy, "cost") for j in listed), 4),
                "solve $",
                round(
                    statistics.fmean(
                        stage_sum(j, lambda c: c["stage"] == "solve", "cost") for j in listed
                    ),
                    4,
                ),
                "other $ (scheme)",
                round(
                    statistics.fmean(
                        j["billed_usd"] - stage_sum(j, lambda c: True, "cost") for j in listed
                    ),
                    4,
                ),
                "copy output",
                round(statistics.fmean(stage_sum(j, is_copy, "output") for j in listed)),
                "solve output",
                round(
                    statistics.fmean(
                        stage_sum(j, lambda c: c["stage"] == "solve", "output") for j in listed
                    )
                ),
                "solve first-round input",
                round(
                    statistics.fmean(
                        c["input"]
                        for j in listed
                        for c in j["call_log"]
                        if c["stage"] == "solve" and c["round"] == 0 and "input" in c
                    )
                )
                if variant in solving
                else None,
                "solve batches",
                len((listed[0].get("solve_batches") or [])),
            )

    print("\n== the map report's runs on these papers: replies and cut-offs")
    for paper in PAPERS:
        names = ["map8-1", "map8-2", "map8-label-1", "map8-label-2", "map8-label-3"]
        if paper == "2023-p2":
            names += ["map8-steps-1", "map8-steps-2"]
        for name in names:
            path = bench.RESULTS / "maps" / f"{paper}-all-{name}.json"
            j = json.loads(path.read_text())
            ys = [c for c in j["call_log"] if c["stage"] == "y" and "input" in c]
            top = max(ys, key=lambda c: c["output"])
            q17 = next(
                (
                    max(
                        (c for c in ys if c["batch"] == i and c["round"] == 0),
                        key=lambda c: c["output"],
                        default=None,
                    )
                    for i, b in enumerate(j["batches"])
                    if b[0] == "17"
                ),
                None,
            )
            print(
                j["name"],
                "wall",
                j["seconds"],
                "largest reply",
                (top["output"], top["reasoning"], top["seconds"]),
                "Q17-24 first reply",
                (q17["output"], q17["reasoning"], q17["seconds"], q17["finish"]) if q17 else None,
                "cut off",
                sum(1 for c in ys if c["finish"] == "length"),
                "recorded",
                len(j["report"]["recorded"]),
                "rounds",
                sorted((j.get("batch_rounds") or {}).values()),
                "figures",
                len(j["figures"]),
            )

    print("\n== Q17 to Q24 by name, first reply: tokens, reasoning, seconds")
    for paper in PAPERS:
        for variant in solving:
            print(
                paper,
                variant,
                [
                    (
                        f"{labels[0]}-{labels[-1]}",
                        c["output"],
                        c["reasoning"],
                        c["seconds"],
                    )
                    for j in runs[variant].get(paper, [])
                    for c in j["call_log"]
                    if c["stage"] == "solve" and c["round"] == 0 and "input" in c
                    for labels in [batch_labels(j, c["batch"])]
                    if labels and labels[0] == "17"
                ],
            )

    print("\n== the probes")
    for path in sorted(OUT.glob("*-probe-*.json")):
        j = json.loads(path.read_text())
        r = fw.reading(j)
        copies = answered_calls(j, is_copy)
        print(
            j["name"],
            f"{j['seconds']}s ${j['billed_usd']}",
            "copied by",
            j.get("copy_done_at"),
            "tool calls a reply",
            [c.get("tool_calls") for c in copies],
            "copy output",
            sum(c["output"] for c in copies),
            "reasoning",
            sum(c["reasoning"] for c in copies),
            "unsupported",
            r["unsupported"],
            "dropped",
            r["dropped"],
            "exact",
            r["exact"],
            "figures",
            len(j["figures"]),
            "solve first share",
            [
                (c["cached"], c["input"])
                for c in j["call_log"]
                if c.get("stage") == "solve" and c.get("round") == 0
            ],
        )

    lines = [
        "# Every call of the copy-first runs",
        "",
        "Generated by `scripts/copy_first.py report`. `1.0` is call 1's first round, `X` the map",
        "call, `c2.0` copy batch 2's first round, `s3.1` solve batch 3's second round. Asked is",
        "the batch's questions. Start is seconds into the run. MB is the request body. Numbers",
        "are per call.",
        "",
        "| Run | Call | Asked | Start s | Took s | Input | Cached | Share | Output | Reasoning | Finish | Sent | Provider | MB |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    names = {"copy": "1", "copybatch": "c", "solve": "s"}
    for path in sorted(OUT.glob("*.json")):
        if path.name == "spend.json":
            continue
        j = json.loads(path.read_text())
        for c in sorted(j["call_log"], key=lambda c: c.get("at") or 0):
            if c["stage"] == "X":
                name = "X"
            elif c["stage"] == "copy" and not options_of(j["variant"])["map"]:
                name = f"1.{c['round']}" if c["batch"] == 0 else f"1r.{c['round']}"
            else:
                name = f"{names.get(c['stage'], '?')}{c['batch']}.{c['round']}"
            labels = batch_labels(j, c.get("batch")) if c["stage"] == "solve" else []
            if c["stage"] == "copybatch":
                labels = (j.get("batches") or [[]])[c["batch"]]
            asked = f"{labels[0]}-{labels[-1]}" if labels else ""
            sent = c.get("reasoning_sent") or {}
            sent = sent.get("effort") or ("off" if sent.get("enabled") is False else "")
            if "input" not in c:
                lines.append(
                    f"| {j['name']} | {name} | {asked} | {c.get('at')} | {c.get('seconds')} | failed: {(c.get('error') or '')[:60]} | | | | | | {sent} | | |"
                )
                continue
            lines.append(
                f"| {j['name']} | {name} | {asked} | {c['at']} | {c['seconds']} | {c['input']} | {c['cached']} | "
                f"{c['cached'] / c['input']:.3f} | {c['output']} | {c['reasoning']} | {c['finish']} | {sent} | "
                f"{c.get('provider')} | {c.get('body_bytes', 0) / 1e6:.2f} |"
            )
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "per-call.md").write_text("\n".join(lines) + "\n")


def setup(args) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    fw.OUT = OUT
    fm.Spend.path = OUT / "spend.json"
    fw.SPEND_CAP = SPEND_CAP
    fm.SPEND_CAP = SPEND_CAP
    fw.KATEX = Path("/Users/sam/web/capy-notebook/node_modules/katex")


def run_all(args) -> None:
    from pipeline.retrieval import extraction

    bench.load_env(args.env_file)
    extraction.WINDOW_PAGES = 100_000
    fw.AFTER_INSTALL = install_copy
    LIVE["base"] = fm.Spend().data["usd"]
    try:
        asyncio.run(fw.run_jobs(args))
    finally:
        spend = fm.Spend()
        lost = LIVE["base"] + LIVE["usd"] - spend.data["usd"]
        if lost > 1e-6:
            spend.add("calls of runs that did not finish", lost)
        print("spent", round(spend.data["usd"], 4), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run")
    p.add_argument("--jobs", nargs="+", required=True)
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--env-file", required=True)
    p.add_argument("--parallel", type=int, default=3)
    p.add_argument("--override", nargs="*")
    p = sub.add_parser("report")
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--detections", nargs="*", default=[])
    args = parser.parse_args()
    setup(args)
    if args.command == "report":
        report(args)
        return
    run_all(args)


if __name__ == "__main__":
    main()
