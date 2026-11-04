"""A first call X over the whole paper, then parallel batches that all start with X
(Epo 2026-11-04). Report: ``reports/2026-11-04-paper-map-parallel.md``.

X has the system prompt and tool list every batch uses. Its user message holds every
selected page (image and indexed text) and the layout boxes for all pages as JSON,
numbered once across the paper, and asks for a map, one line per question. Each batch
y is X's whole message list, X's reply, and a new user message naming its questions.
All y's are sent at once. A whole question goes to exactly one batch. There is no
``continue_question``, open question or "recorded so far". Figures stay box numbers,
through ``figure_windows.py``'s patches, around the production ``extraction.run``.

    python -I paper_map.py run --jobs 2021-p1:map8:1 2022-p2:map4-noreason:2 \
        --scans <dir> --digital <dir> --detections <pp-plus-l-onnx.json> --env-file <keys>
    python -I paper_map.py report --scans ... --digital ... --detections ... --saved <dir>
    python -I paper_map.py probe --scans ... --detections ... --env-file ...

A job's variant is ``map<size>``, plus ``-noreason`` (X's answer goes back alone), ``-drop``
(a question planted out of the map), ``-parts`` (a part planted off a question's row) or
``-rss`` (no body copies for the measurement, for a memory run in a process of its own). Any
other suffix only keeps a set of runs apart. ``none`` and ``boxes`` are today's and the
window-pick routes, in a process of their own (``--plain``). Each run's system prompt
starts with a nonce, so nothing it reads from a cache was written by another run. Results
land in ``.results/maps/``, the spend in ``.results/maps/spend.json``. Keys are read into
the process only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextvars
import copy
import hashlib
import functools
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import figure_matching as fm  # noqa: E402
import figure_windows as fw  # noqa: E402
import layout_score as ls  # noqa: E402
import run as bench  # noqa: E402

OUT = bench.RESULTS / "maps"
SPEND_CAP = 2.9
# The first 62 runs asked for "label is the question's printed number, with its section
# only when the numbering restarts (A1, B1)": 3 maps then wrote B31 for a printed 31.
# A batch's rounds. The first set of runs had 6, production's WINDOW_STEPS: one thread
# recorded a question a round after its first reply and lost 3 of its 8 to the limit.
STEPS = 12
CALL: contextvars.ContextVar[dict | None] = contextvars.ContextVar(
    "map_call", default=None
)
MERGED = "2023-p1p2"

SYSTEM_OPENING = (
    "You copy the questions printed on exam or worksheet pages into a quiz, exactly as "
    "printed, each with its answer key. You see all the selected page images at once, each "
    "with the page's indexed text, which may be rough: the image is what counts.\n\n"
    "First you are asked for a map of the questions, as plain text. Then you are asked to "
    "record some of them: give each question its own record_question call, in printed "
    "order; one reply may hold several calls. Record the whole question, from all its "
    "pages, and only the questions asked for."
)
FIGURE_RULES = (
    "Figures: a layout model looked for pictures and charts on these pages. After the "
    "pages comes what it found, as JSON: each box's number, page, coordinates [left, top, "
    "right, bottom] on a 0-1000 grid of the page image (0, 0 is the top left corner), label "
    "and score. Boxes are hints from a model, not part of the page. For each diagram, "
    "graph, chart or photo a question needs, give boxes, the numbers of the boxes that hold "
    'it; the part whose text it follows ("" for the text shared by every part); and a few '
    "words on what it shows. A figure split across boxes (a diagram and its key, two shapes "
    "side by side) takes all of them. When boxes overlap, give the one that holds the whole "
    "figure and the least else. Leave out a box that holds no figure of a question. When no "
    "box holds a figure the question needs, give boxes [] and image, the page image it is "
    "on (counted from 1 in the order shown). The figure is cropped from the page into the "
    "quiz, so the blocks never describe it."
)
CLOSING = (
    "Each recorded question is checked at once. Fix what a result names and record that "
    "question again with the same label; an accepted question needs no second call. When "
    "every question asked for is recorded, reply with the single word DONE."
)
MAP_ASK = (
    "Map these pages before recording anything. Call no tool in this reply. Answer with "
    "plain text, one line for each question, in printed order, exactly in this form:\n"
    "<label> | pages <first>-<last> | parts <printed part labels, or none> | figures <box "
    "numbers, or none>\n"
    "label is the question's printed number alone, as in 31, not B31; add a section (A1, "
    "B1) only when two questions on these pages would otherwise share a number. first and "
    "last are the page numbers it is printed on, from its "
    "number to its last line, as the page headings give them. parts lists its printed part "
    "labels in order, separated by commas, with sub-parts written out: a, b(i), b(ii). "
    "figures lists the numbers of the boxes that hold its figures, separated by commas."
)


def system_prompt(nonce: str) -> str:
    """Production's copying and answers rules, with the opening, figures and closing
    for this flow. The nonce keeps each run's cache its own."""
    from pipeline.prompts import extraction as prompts
    from pipeline.prompts.sources import SOURCE_RULE

    text = prompts.EXTRACT_SYSTEM
    rules = text[text.index("Copying:") : text.index("Figures: for each diagram")]
    return f"Run {nonce}.\n{SYSTEM_OPENING}\n\n{rules}{FIGURE_RULES}\n\n{CLOSING}\n{SOURCE_RULE}"


def map_tools() -> list[dict]:
    """The record tool alone, its figures by box number: the same list on every call."""
    from pipeline.prompts import extraction as prompts

    tools = copy.deepcopy(prompts.TOOLS[:1])
    item = tools[0]["function"]["parameters"]["properties"]["figures"]["items"]
    item["properties"] = {
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
        "part": item["properties"]["part"],
        "description": item["properties"]["description"],
    }
    item["required"] = ["boxes", "part", "description"]
    tools[0]["function"]["description"] = "Record one whole question."
    return tools


_LINE = re.compile(
    r"^\s*(?:\*\*)?(?P<label>[^|]+?)(?:\*\*)?\s*\|\s*pages?\s*(?P<first>\d+)(?:\s*-\s*(?P<last>\d+))?"
    r"\s*\|\s*parts?\s*(?P<parts>[^|]*?)\s*\|\s*figures?\s*(?P<figures>.*?)\s*$",
    re.IGNORECASE,
)


def parse_map(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = _LINE.match(line)
        if not m:
            continue
        parts = m["parts"].strip()
        rows.append(
            {
                "label": m["label"].strip(),
                "first": int(m["first"]),
                "last": int(m["last"] or m["first"]),
                "parts": []
                if parts.lower() in ("none", "-", "")
                else [p.strip() for p in parts.split(",") if p.strip()],
                "figures": [int(n) for n in re.findall(r"\d+", m["figures"])],
            }
        )
    return rows


def options_of(variant: str) -> dict:
    m = re.fullmatch(r"map(\d+)((?:-\w+)*)", variant)
    flags = (m[2] or "").split("-")
    return {
        "size": int(m[1]),
        "reasoning": "noreason" not in flags,
        "wrong": "drop" if "drop" in flags else "parts" if "parts" in flags else "",
    }


def wrong_map(kind: str, text: str, rows: list[dict]) -> tuple[str, list[dict], dict]:
    """The map with a planted error: a question left out, or a part left off."""
    with_parts = [r for r in rows if len(r["parts"]) >= 2]
    row = with_parts[len(with_parts) // 2] if with_parts else rows[len(rows) // 2]
    lines = text.splitlines()
    index = next(
        i
        for i, line in enumerate(lines)
        if (m := _LINE.match(line)) and m["label"].strip() == row["label"]
    )
    if kind == "drop":
        del lines[index]
        rows = [r for r in rows if r is not row]
        return "\n".join(lines), rows, {"kind": kind, "label": row["label"]}
    cut = row["parts"][-1]
    lines[index] = re.sub(r",\s*" + re.escape(cut) + r"(\s*\|)", r"\1", lines[index])
    planted = {"kind": kind, "label": row["label"], "cut": cut}
    row["parts"] = row["parts"][:-1]
    return "\n".join(lines), rows, planted


def _size(value) -> int:
    """About a value's JSON length, without making it."""
    if isinstance(value, str):
        return len(value) + 2
    if isinstance(value, dict):
        return sum(len(k) + 4 + _size(v) for k, v in value.items()) + 2
    if isinstance(value, list):
        return sum(_size(v) + 2 for v in value) + 2
    return 8


async def _rss_mb() -> float:
    proc = await asyncio.create_subprocess_exec(
        "ps", "-o", "rss=", "-p", str(os.getpid()), stdout=asyncio.subprocess.PIPE
    )
    out, _ = await proc.communicate()
    return round(int(out) / 1024, 1)


def ask_text(labels: list[str]) -> str:
    names = ", ".join(labels[:-1]) + (" and " if len(labels) > 1 else "") + labels[-1]
    return f"Record question{'s' if len(labels) > 1 else ''} {names} now."


def install_map() -> None:
    """X as the outline call, and the batches as the one window, so the production
    run's pairing, figures and report follow unchanged."""
    from pipeline.elitellm import client
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import extraction

    from pipeline import elitellm

    stream = client._stream_sse

    async def logged_stream(url, headers, body):
        call = CALL.get()
        if call is not None and "rss" in fw.STATE.get().variant:
            # No copies here: the memory runs measure what the client itself holds.
            call["body_bytes"] = _size(body)
        elif call is not None:
            text = json.dumps(body["messages"], ensure_ascii=False)
            call["body_bytes"] = len(json.dumps(body, ensure_ascii=False))
            call["message_bytes"] = len(text)
            n = call.get("prefix_messages")
            if n:
                call["prefix_sha"] = hashlib.sha256(
                    json.dumps(
                        [body["messages"][:n], body.get("tools")], ensure_ascii=False
                    ).encode()
                ).hexdigest()[:16]
        first = True
        async for event in stream(url, headers, body):
            if call is not None:
                if first:
                    call["first_event_s"] = round(time.monotonic() - call["t0"], 2)
                    first = False
                call["provider"] = call.get("provider") or event.get("provider")
                cost = (event.get("usage") or {}).get("cost")
                if cost is not None:
                    call["cost"] = cost
            yield event

    client._stream_sse = logged_stream

    complete_response = extraction.models.complete_response

    async def logged_complete(messages, **kwargs):
        state = fw.STATE.get()
        call = CALL.get()
        if not state.variant.startswith("map") or call is None:
            return await complete_response(messages, **kwargs)
        call["t0"] = time.monotonic()
        call["at"] = round(call["t0"] - state.extra["started"], 2)
        state.extra["in_flight"] += 1
        state.extra["peak_in_flight"] = max(
            state.extra["peak_in_flight"], state.extra["in_flight"]
        )
        try:
            response = await complete_response(messages, **kwargs)
        except Exception as exc:
            call["error"] = repr(exc)[:200]
            call.pop("t0", None)
            state.extra["call_log"].append(call)
            raise
        finally:
            state.extra["in_flight"] -= 1
            call["seconds"] = (
                round(time.monotonic() - call["t0"], 2) if "t0" in call else None
            )
        usage = response.usage
        call.update(
            input=usage.input_tokens,
            cached=usage.cached_read_tokens,
            output=usage.output_tokens,
            reasoning=usage.reasoning_tokens,
            finish=response.choices[0].finish_reason,
        )
        call.pop("t0", None)
        state.extra["call_log"].append(call)
        return response

    extraction.models.complete_response = logged_complete

    outline = extraction.outline

    async def map_call(pages, *, model):
        state = fw.STATE.get()
        if not state.variant.startswith("map"):
            return await outline(pages, model=model)
        extra = state.extra
        extra.setdefault("started", time.monotonic())
        extra.setdefault("in_flight", 0)
        extra.setdefault("peak_in_flight", 0)
        extra.setdefault("call_log", [])
        options = options_of(state.variant)
        nonce = extra.setdefault("nonce", secrets.token_hex(6))
        state.window = {}
        for page in pages:
            regions = state.det.get(fm.stem_of(state.paper, page.number), [])
            for region in fm.boxes_of(regions)[1]:
                state.window[len(state.window) + 1] = (page.number, region)
        boxes = [
            {
                "box": n,
                "page": page,
                "coordinates": [round(v) for v in region["box"]],
                "label": region["label"],
                "score": round(region["score"], 2),
            }
            for n, (page, region) in state.window.items()
        ]
        content: list[dict] = []
        for index, p in enumerate(pages, 1):
            text = prompts.page_text(
                index, p.number, p.file_name, p.text[: extraction.PAGE_TEXT_CHARS]
            )
            content.append({"type": "text", "text": text})
            content.append({"type": "image_url", "image_url": {"url": await p.image()}})
        content.append(
            {
                "type": "text",
                "text": "Boxes on these pages, as JSON: " + json.dumps(boxes),
            }
        )
        content.append({"type": "text", "text": MAP_ASK})
        extra["prefix"] = [
            {"role": "system", "content": system_prompt(nonce)},
            {"role": "user", "content": content},
        ]
        extra["tools"] = map_tools()
        CALL.set({"stage": "X"})
        response = await extraction.models.complete_response(
            extra["prefix"],
            model=model,
            tools=extra["tools"],
            max_tokens=extraction.WINDOW_MAX_TOKENS,
            call_purpose="extraction_window",
        )
        CALL.set(None)
        reply = elitellm.assistant_message_from_obj(
            elitellm.message_from_response(response)
        )
        if reply.get("tool_calls"):
            extra["x_tool_calls"] = extra.get("x_tool_calls", 0) + 1
            raise elitellm.ProviderError("the map reply called a tool")
        text = reply.get("content") or ""
        rows = parse_map(text)
        if not rows:
            raise elitellm.ProviderError("the map reply held no map lines")
        if options["wrong"]:
            extra["true_map"] = copy.deepcopy(rows)
            text, rows, extra["planted"] = wrong_map(options["wrong"], text, rows)
            reply["content"] = text
        extra["map"] = rows
        extra["map_text"] = text
        extra["x_reply_keys"] = sorted(reply)
        extra["x_reasoning_chars"] = len(reply.get("reasoning") or "")
        extra["x_output"] = response.usage.output_tokens
        extra["reply"] = (
            reply if options["reasoning"] else {"role": "assistant", "content": text}
        )
        return [row["label"] for row in rows]

    extraction.outline = map_call

    window = extraction._window

    async def batches(run, pages, *, model):
        state = fw.STATE.get()
        if not state.variant.startswith("map"):
            await window(run, pages, model=model)
            return
        extra = state.extra
        options = options_of(state.variant)
        rows = extra["map"]
        run.output_tokens += extra["x_output"]
        for n, row in enumerate(rows):
            run.order[extraction.label_key(row["label"])] = n
        size = options["size"]
        groups = [rows[i : i + size] for i in range(0, len(rows), size)]
        base = [*extra["prefix"], extra["reply"]]
        tools = extra["tools"]
        extra["batches"] = [[r["label"] for r in g] for g in groups]

        extra["off_batch"] = []

        async def one(index: int, group: list[dict], taken: set[str]) -> None:
            labels = [r["label"] for r in group]
            asked = {extraction.label_key(label) for label in labels}
            messages = [*base, {"role": "user", "content": ask_text(labels)}]
            for step in range(STEPS):
                call = {
                    "stage": "y",
                    "batch": index,
                    "round": step,
                    "prefix_messages": len(base),
                }
                CALL.set(call)
                try:
                    response = await extraction.models.complete_response(
                        messages,
                        model=model,
                        tools=tools,
                        max_tokens=extraction.WINDOW_MAX_TOKENS,
                        call_purpose="extraction_window",
                    )
                finally:
                    CALL.set(None)
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
                calls = reply.get("tool_calls") or []
                if not calls:
                    break
                messages.append(reply)
                for tool_call in calls:
                    name, args = extraction._call_args(tool_call)
                    if isinstance(args, str):
                        result = args
                    elif name == "record_question":
                        label = str(args.get("label") or "")
                        if extraction.label_key(label) not in asked:
                            extra["off_batch"].append({"batch": index, "label": label})
                        result = await run.add(args, taken, pages)
                        if not result.endswith("recorded."):
                            extra["refusals"] = [
                                *extra.get("refusals", []),
                                {"batch": index, "round": step, "result": result[:300]},
                            ]
                    else:
                        result = f"There is no tool {name}."
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.get("id"),
                            "content": result,
                        }
                    )
                if run.full:
                    break
            extra["batch_rounds"] = {
                **extra.get("batch_rounds", {}),
                str(index): step + 1,
            }

        peak = {"rss": await _rss_mb()}
        at_start = peak["rss"]
        finished = asyncio.Event()

        async def sample() -> None:
            while not finished.is_set():
                peak["rss"] = max(peak["rss"], await _rss_mb())
                await asyncio.sleep(0.25)

        sampler = asyncio.create_task(sample())
        failures = await asyncio.gather(
            *(
                extraction._attempted(functools.partial(one, i, g, set()))
                for i, g in enumerate(groups)
            ),
            return_exceptions=True,
        )
        finished.set()
        await sampler
        extra["batch_failures"] = [
            {"batch": i, "error": repr(f)[:200]}
            for i, f in enumerate(failures)
            if isinstance(f, BaseException)
        ]
        extra["rss_mb"] = {"before_batches": at_start, "peak_in_batches": peak["rss"]}
        # Recorded parts and figures against the map: what code can catch.
        check = []
        for row in rows:
            held = run.recorded.get(extraction.label_key(row["label"]))
            if held is None:
                check.append({"label": row["label"], "problem": "not recorded"})
                continue
            want = [extraction.label_key(p) for p in row["parts"]] or [""]
            have = [extraction.label_key(p) for p in held.part_labels]
            if want != have:
                check.append(
                    {
                        "label": row["label"],
                        "problem": "parts differ",
                        "map": row["parts"],
                        "recorded": held.part_labels,
                    }
                )
        extras = [
            h.label
            for h in run.recorded.values()
            if extraction.label_key(h.label)
            not in {extraction.label_key(r["label"]) for r in rows}
        ]
        numbers = [int(r["label"]) for r in rows if r["label"].isdigit()]
        gaps = (
            sorted(set(range(min(numbers), max(numbers) + 1)) - set(numbers))
            if numbers
            else []
        )
        covered = {n for r in rows for n in range(r["first"], r["last"] + 1)}
        extra["map_check"] = {
            "problems": check,
            "not_in_map": extras,
            "number_gaps": gaps,
            "pages_no_row_covers": [p.number for p in pages if p.number not in covered],
        }
        for key in ("prefix", "tools", "reply", "edit", "started", "in_flight"):
            extra.pop(key, None)

    extraction._window = batches


# -------------------------------------------------------------------- the report

BIOLOGY_PAGES = {
    "1": (2, 3),
    "2": (4, 6),
    "3": (7, 10),
    "4": (11, 12),
    "5": (13, 14),
    "6": (15, 17),
}
# Each question's first page, read off the PDFs' text layers (2026-11-04).
IGCSE_FIRST = {
    "igcse-physics-0625-2023-sp2": {
        2: [1, 2, 3, 4],
        3: [5, 6, 7],
        4: [8, 9, 10],
        5: [11, 12, 13, 14],
        6: [15, 16, 17],
        7: [18, 19, 20],
        8: [21, 22, 23],
        9: [24, 25, 26],
        10: [27, 28, 29],
        11: [30, 31, 32],
        12: [33, 34, 35],
        13: [36, 37],
        14: [38, 39, 40],
    },
    "igcse-maths-0580-2025-sp2": {
        3: [1, 2, 3, 4],
        4: [5, 6, 7],
        5: [8, 9],
        6: [10, 11, 12],
        7: [13, 14],
        8: [15],
        9: [16],
        11: [17],
        12: [18],
        13: [19, 20],
        14: [21],
        15: [22, 23],
        16: [24, 25],
        17: [26],
    },
}
GROUPS = {
    "scan": ["2021-p1", "2022-p1", "2022-p2", "2024-p1"],
    "digital": [
        "igcse-biology-0610-2023-sp4",
        "igcse-maths-0580-2025-sp2",
        "igcse-physics-0625-2023-sp2",
    ],
    "new": ["2021-p2", "2023-p2", "2025-p2"],
}
PAPERS = [paper for group in GROUPS.values() for paper in group]
COUNTS = {
    "2022-p2": 45,
    "2021-p2": 45,
    "2023-p2": 45,
    "2025-p2": 45,
    "igcse-physics-0625-2023-sp2": 40,
    "igcse-maths-0580-2025-sp2": 26,
    "igcse-biology-0610-2023-sp4": 6,
}


def page_truth(paper: str, args) -> dict[str, tuple[int, int]]:
    """Each question's printed pages: forward-only through the page reads (or text
    layer), or the tables above. Printed on one page unless the tables say not."""
    import pymupdf

    if paper == "igcse-biology-0610-2023-sp4":
        return BIOLOGY_PAGES
    if paper in IGCSE_FIRST:
        out = {str(q): (p, p) for p, qs in IGCSE_FIRST[paper].items() for q in qs}
        if "maths" in paper:
            out["16"] = (9, 10)
        return out
    gold = fw.gold_of(paper)
    count = len(gold["questions"]) if gold else COUNTS[paper]
    pages: dict[int, str] = {}
    for path in (bench.RESULTS / "text").glob(f"{paper}-[0-9][0-9].txt"):
        pages[int(path.stem[-2:])] = path.read_text()
    if not pages:
        with pymupdf.open(Path(args.scans) / f"{paper}.pdf") as doc:
            pages = {i + 1: doc[i].get_text() for i in range(len(doc))}
    out, current = {}, 2
    for q in range(1, count + 1):
        for number in sorted(pages):
            if number >= current and re.search(
                rf"(?m)^\W*{q}\s*[.)]?(\s|$)", pages[number]
            ):
                out[str(q)] = (number, number)
                current = number
                break
    if paper == "2022-p1":
        out["10"] = (8, 8)
    return out


def maths_parts(args) -> dict[str, list[str]]:
    """IGCSE Maths' part labels from its text layer, between question numbers."""
    import pymupdf

    out: dict[str, list[str]] = {}
    current, letter = None, ""
    with pymupdf.open(
        Path(args.digital) / "igcse-maths-0580-2025-sp2" / "paper.pdf"
    ) as doc:
        for page in doc:
            lines = {}
            for w in page.get_text("words"):
                lines.setdefault((w[5], w[6]), []).append(w)
            for line in sorted(lines.values(), key=lambda ws: (ws[0][1], ws[0][0])):
                first = line[0]
                if first[1] / page.rect.height * 1000 < 45:
                    continue
                words = [w[4] for w in line]
                if first[0] < 0.12 * page.rect.width and first[4].isdigit():
                    current, letter = first[4], ""
                    out.setdefault(current, [])
                    words = words[1:]
                if current is None:
                    continue
                for word in words[:2]:
                    m = re.fullmatch(r"\(([a-h]|i{1,3}|iv|v)\)", word)
                    if not m:
                        continue
                    mark = m[1]
                    if mark in ("i", "ii", "iii", "iv", "v") and letter:
                        if out[current] and out[current][-1] == letter:
                            out[current].pop()
                        out[current].append(f"{letter}({mark})")
                    else:
                        letter = mark
                        out[current].append(mark)
    return out


def part_truth(paper: str, args) -> dict[str, list[str]] | None:
    if paper == "igcse-maths-0580-2025-sp2":
        return maths_parts(args)
    gold = (
        json.loads((bench.GOLD / "2023-bio-p4.json").read_text())
        if paper == "igcse-biology-0610-2023-sp4"
        else fw.gold_of(paper)
    )
    if gold:
        return {
            q["label"]: [p["label"] for p in q["parts"] if p["label"]]
            for q in gold["questions"]
        }
    return (
        {str(n): [] for n in range(1, COUNTS[paper] + 1)} if paper in COUNTS else None
    )


def credits(usage: dict) -> float:
    uncached = usage["inputTokens"] - usage["cachedReadTokens"]
    return (
        uncached * 200 + usage["cachedReadTokens"] * 20 + usage["outputTokens"] * 1200
    ) / 1e6


def plain(text: str) -> str:
    return re.sub(r"[\s{}$]|\\[a-zA-Z]+", "", text)


def known_failures(result: dict) -> dict:
    """The bench's known failures, in one run."""
    held = {
        label: q
        for label, q in zip(
            result["report"]["recorded"], result["questions"], strict=False
        )
    }
    out: dict = {}

    def text(q: dict) -> str:
        chunks = []
        for blocks in [q["stem"], *(p["blocks"] for p in q["parts"])]:
            chunks += [b.get("text", "") for b in blocks]
            chunks += [c for b in blocks for row in b.get("rows") or [] for c in row]
        for part in q["parts"]:
            chunks += part["answer"].get("options") or []
            chunks.append(part.get("lead_in") or "")
        return "\n".join(chunks)

    if result["paper"] == "igcse-biology-0610-2023-sp4":
        gold = json.loads((bench.GOLD / "2023-bio-p4.json").read_text())
        marks = {
            q["label"]: [p["marks"] for p in q["parts"]] for q in gold["questions"]
        }
        out["labels"] = list(held)
        out["q3_split"] = [label for label in held if label.startswith("3(")]
        out["marks_right"] = sum(
            1
            for label, want in marks.items()
            if label in held and [p["marks"] for p in held[label]["parts"]] == want
        )
        out["q2_monitored"] = "2" in held and "monitored" in text(held["2"])
        out["q1_marks"] = (
            [p["marks"] for p in held["1"]["parts"]] if "1" in held else None
        )
    if result["paper"] == "2022-p2" and "34" in held:
        q34 = plain(text(held["34"]))
        out["q34_number"] = "12B00CD000000E" in q34
        options = held["34"]["parts"][0]["answer"].get("options") or []
        out["q34_options"] = [plain(o) for o in options]
        want = ["4^22", "4^14", "4^24", "4^16"]
        out["q34_exponents"] = all(
            w in "".join(plain(o) for o in options) for w in want
        )
    return out


def map_rows(result: dict, truth_pages, truth_parts) -> dict:
    """A map against the truth: labels, page ranges, parts."""
    from pipeline.retrieval.extraction import label_key

    rows = result.get("true_map") or result["map"]
    out = {
        "rows": len(rows),
        "sections_added": [],
        "labels_extra": [],
        "pages_wrong": [],
        "parts_wrong": [],
    }
    wanted = set(truth_pages) | set(truth_parts or {})

    def bare(label: str) -> str:
        return re.sub(r"^[a-z]\.(?=\d)", "", label_key(label))

    out["labels_missing"] = sorted(
        wanted - {bare(r["label"]) for r in rows}, key=lambda t: (len(t), t)
    )
    for row in rows:
        key = bare(row["label"])
        if key not in wanted:
            out["labels_extra"].append(row["label"])
            continue
        if key != label_key(row["label"]):
            out["sections_added"].append(row["label"])
        if key in truth_pages and (row["first"], row["last"]) != truth_pages[key]:
            out["pages_wrong"].append(
                (row["label"], row["first"], row["last"], truth_pages[key])
            )
        if truth_parts is not None and key in truth_parts:
            want = [label_key(p) for p in truth_parts[key]]
            have = [label_key(p) for p in row["parts"]]
            if want != have:
                out["parts_wrong"].append(
                    (row["label"], row["parts"], truth_parts[key])
                )
    return out


def filled_figures(result: dict, det: dict) -> list[dict]:
    """The recorded figures, and the map's boxes for a question whose batch left its
    figures out: what code could fill in for free."""
    named = {f["label"] for f in result["figures"]}
    return [
        *result["figures"],
        *(f for f in map_figures(result, det) if f["label"] not in named),
    ]


def map_figures(result: dict, det: dict) -> list[dict]:
    """The map's figures as the crops they would give, for the same scoring."""
    numbered: dict[int, tuple[int, dict]] = {}
    for page in result["pages"]:
        for region in fm.boxes_of(det.get(fm.stem_of(result["paper"], page), []))[1]:
            numbered[len(numbered) + 1] = (page, region)
    out = []
    for row in result.get("true_map") or result["map"]:
        pages: dict[int, list] = {}
        for n in row["figures"]:
            if n in numbered:
                pages.setdefault(numbered[n][0], []).append(numbered[n][1]["box"])
        for page, boxes in pages.items():
            out.append(
                {
                    "label": row["label"],
                    "page": page,
                    "boxes": boxes,
                    "description": "",
                    "box": boxes[0],
                }
            )
    return out


def report(args) -> None:
    det = fm.load_detections(args.detections)
    gold = ls.gold_figures()
    eye = fm.load_eye()
    saved = Path(args.saved)
    runs: dict[str, dict[str, list[dict]]] = {}
    for path in sorted(OUT.glob("*.json")):
        if path.name in ("spend.json", "summary.json"):
            continue
        data = json.loads(path.read_text())
        if "variant" in data:
            runs.setdefault(data["variant"], {}).setdefault(data["paper"], []).append(
                data
            )
    for path in sorted((bench.RESULTS / "windows").glob("*-all-boxes-[12].json")):
        data = json.loads(path.read_text())
        runs.setdefault("window", {}).setdefault(data["paper"], []).append(data)
    for paper in PAPERS:
        today = []
        for n in ("all-none-1", "all-none-2"):
            path = bench.RESULTS / "windows" / f"{paper}-{n}.json"
            if path.exists():
                today.append(json.loads(path.read_text()))
        if not today:
            for n in ("81-w2", "82-w2"):
                path = saved / f"{paper}-v41-1017-{n}.json"
                if path.exists():
                    data = json.loads(path.read_text())
                    data["pages"] = None
                    today.append(data)
        runs.setdefault("today", {})[paper] = today
    pages_truth = {paper: page_truth(paper, args) for paper in PAPERS}
    parts_truth = {paper: part_truth(paper, args) for paper in PAPERS}

    print("\n== cost and time per paper: mean of the runs")
    for variant, papers in sorted(runs.items()):
        total = {
            "s": 0.0,
            "usd": 0.0,
            "credits": 0.0,
            "input": 0,
            "cached": 0,
            "output": 0,
            "reasoning": 0,
            "calls": 0.0,
        }
        for paper, listed in sorted(papers.items()):
            if not listed:
                continue
            n = len(listed)
            mean = {
                "s": sum(j["seconds"] for j in listed) / n,
                "usd": sum(j["billed_usd"] for j in listed) / n,
                "credits": sum(credits(j["usage"]) for j in listed) / n,
                "input": sum(j["usage"]["inputTokens"] for j in listed) / n,
                "cached": sum(j["usage"]["cachedReadTokens"] for j in listed) / n,
                "output": sum(j["usage"]["outputTokens"] for j in listed) / n,
                "reasoning": sum(j["usage"]["reasoningTokens"] for j in listed) / n,
                "calls": sum(j["usage"]["calls"] for j in listed) / n,
            }
            if paper in PAPERS:
                for k, v in mean.items():
                    total[k] += v
            peak = [j.get("peak_in_flight") for j in listed]
            print(
                variant,
                paper,
                f"runs {n}",
                f"{mean['s']:.0f}s",
                f"${mean['usd']:.4f}",
                f"credits {mean['credits']:.2f}",
                f"in {mean['input']:.0f} cached {mean['cached']:.0f}",
                f"out {mean['output']:.0f} reason {mean['reasoning']:.0f} calls {mean['calls']:.1f} peak {peak}",
            )
        print(variant, "SUM ten papers", {k: round(v, 3) for k, v in total.items()})

    print("\n== cache per run: X, then y first rounds and later rounds")
    for variant, papers in sorted(runs.items()):
        if not variant.startswith("map"):
            continue
        first_share, later_share, beyond = [], [], 0
        count = 0
        providers: dict[str, int] = {}
        for listed in dict(sorted(papers.items())).values():
            for j in listed:
                x = next(c for c in j["call_log"] if c["stage"] == "X")
                ys = [c for c in j["call_log"] if c["stage"] == "y" and "input" in c]
                first = [c for c in ys if c["round"] == 0]
                later = [c for c in ys if c["round"] > 0]
                for c in j["call_log"]:
                    providers[c.get("provider") or "?"] = (
                        providers.get(c.get("provider") or "?", 0) + 1
                    )
                first_share += [c["cached"] / c["input"] for c in first]
                later_share += [c["cached"] / c["input"] for c in later]
                beyond += sum(1 for c in first if c["cached"] > x["input"])
                count += len(first)
                print(
                    j["name"],
                    "X in",
                    x["input"],
                    "out",
                    x["output"],
                    "reason",
                    x["reasoning"],
                    x.get("provider"),
                    "| y1 in/cached",
                    [
                        (c["input"], c["cached"], (c.get("provider") or "?")[:6])
                        for c in first
                    ],
                    "| later min share",
                    round(min((c["cached"] / c["input"] for c in later), default=1), 3),
                    "| errors",
                    [c["error"][:60] for c in j["call_log"] if "error" in c],
                    "| length",
                    sum(1 for c in ys if c["finish"] == "length"),
                    "| x retries",
                    j.get("x_tool_calls", 0),
                    "| sha",
                    len({c.get("prefix_sha") for c in ys}),
                )
        print(
            variant,
            "first rounds",
            count,
            "cached share min/mean",
            round(min(first_share, default=0), 3),
            round(sum(first_share) / max(len(first_share), 1), 3),
            "later min/mean",
            round(min(later_share, default=0), 3),
            round(sum(later_share) / max(len(later_share), 1), 3),
            "first rounds whose hit reaches into X's reply",
            beyond,
            "providers",
            providers,
        )

    print("\n== figures, gold crops by group, then eye pages")
    for variant, papers in sorted(runs.items()):
        all_rows, unnamed = [], []
        for group, members in GROUPS.items():
            rows = []
            for paper in members:
                for j in papers.get(paper, []):
                    r = fw.job_rows(j, det, gold, eye)
                    rows += r["rows"]
                    unnamed += r["unnamed"]
            all_rows += rows
            print(
                variant,
                group,
                "gold",
                fm.tally([r for r in rows if r.get("status") == "gold"]),
                "eye",
                fm.tally([r for r in rows if r.get("status") == "eye"]),
            )
        golds = [r for r in all_rows if r.get("status") == "gold"]
        print(
            variant,
            "ALL gold",
            fm.tally(golds),
            "extra",
            fm.tally([r for r in all_rows if r.get("status") == "extra name"]),
            "unnamed",
            len(unnamed),
            sorted(set(unnamed)),
        )
        wrong = {}
        for r in all_rows:
            if (
                r.get("right") is False
                or r.get("whole") is False
                or r.get("tight") is False
            ):
                k = (
                    r["page"],
                    r["label"],
                    r["description"][:40],
                    r["status"],
                    r.get("right"),
                    r.get("whole"),
                    r.get("tight"),
                )
                wrong[k] = wrong.get(k, 0) + 1
        for k, v in sorted(wrong.items(), key=str):
            print("   ", v, "x", k)

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
        "stopped",
    )
    print("paper variant " + " ".join(fields))
    for paper in PAPERS:
        for variant in sorted(runs):
            for j in runs[variant].get(paper, []):
                r = fw.reading(j)
                line = " ".join(str(r[k]) for k in fields)
                if paper.startswith("igcse"):
                    n = fw.printed_numbers(j, Path(args.digital), det)
                    line += f" | printed compared {n['compared']} unsupported {sum(len(v) for v in n['unsupported'].values())} dropped {sum(len(v) for v in n['dropped'].values())}"
                print(paper, variant, line)

    print("\n== reading, each variant over its runs of the ten papers")
    for variant in sorted(runs):
        sums: dict[str, list[int]] = {}
        totals = {
            "unsupported": 0,
            "dropped": 0,
            "disagreements": 0,
            "marks_differ": 0,
            "refused": 0,
            "katex": 0,
            "stray": 0,
            "printed_unsupported": 0,
            "printed_dropped": 0,
            "runs": 0,
            "questions": 0,
        }

        def add(key: str, text, sums: dict[str, list[int]] = sums) -> None:
            a, _, b = str(text or "").partition("/")
            if a.isdigit() and b.isdigit():
                entry = sums.setdefault(key, [0, 0])
                entry[0] += int(a)
                entry[1] += int(b)

        for paper in PAPERS:
            for j in runs[variant].get(paper, []):
                r = fw.reading(j)
                totals["runs"] += 1
                totals["questions"] += len(j["report"]["recorded"])
                for key in (
                    "structure",
                    "marks",
                    "total_marks",
                    "mcq_worked",
                    "worked_marks",
                    "mcq_gold",
                    "exact",
                ):
                    add(key, r[key])
                for key in (
                    "unsupported",
                    "dropped",
                    "disagreements",
                    "marks_differ",
                    "refused",
                    "katex",
                    "stray",
                ):
                    totals[key] += r[key] or 0
                if paper.startswith("igcse"):
                    n = fw.printed_numbers(j, Path(args.digital), det)
                    totals["printed_unsupported"] += sum(
                        len(v) for v in n["unsupported"].values()
                    )
                    totals["printed_dropped"] += sum(
                        len(v) for v in n["dropped"].values()
                    )
        print(variant, sums, totals)

    print("\n== known failures")
    for paper in ("igcse-biology-0610-2023-sp4", "2022-p2"):
        for variant in sorted(runs):
            for j in runs[variant].get(paper, []):
                print(paper, variant, json.dumps(known_failures(j), ensure_ascii=False))

    print("\n== the map against the truth")
    for variant, papers in sorted(runs.items()):
        if not variant.startswith("map"):
            continue
        tally = {
            "rows": 0,
            "missing": 0,
            "extra": 0,
            "sections_added": 0,
            "pages": 0,
            "parts": 0,
        }
        for paper, listed in sorted(papers.items()):
            if paper not in pages_truth:
                continue
            for j in listed:
                m = map_rows(j, pages_truth[paper], parts_truth[paper])
                tally["rows"] += m["rows"]
                tally["missing"] += len(m["labels_missing"])
                tally["extra"] += len(m["labels_extra"])
                tally["sections_added"] += len(m["sections_added"])
                tally["pages"] += len(m["pages_wrong"])
                tally["parts"] += len(m["parts_wrong"])
                print(j["name"], json.dumps(m, ensure_ascii=False)[:700])
                print(
                    "   check:",
                    json.dumps(j["map_check"], ensure_ascii=False)[:500],
                    "off batch",
                    j.get("off_batch"),
                    "failures",
                    j.get("batch_failures"),
                    "planted",
                    j.get("planted"),
                )
        print(variant, "TOTAL", tally)
        rows = []
        for paper in PAPERS:
            for j in papers.get(paper, []):
                pseudo = {
                    "paper": paper,
                    "pages": j["pages"],
                    "figures": map_figures(j, det),
                }
                rows += fw.job_rows(pseudo, det, gold, eye)["rows"]
        print(
            variant,
            "figures as the map gave them: gold",
            fm.tally([r for r in rows if r.get("status") == "gold"]),
            "eye",
            fm.tally([r for r in rows if r.get("status") == "eye"]),
        )
        rows, unnamed = [], []
        for paper in PAPERS:
            for j in papers.get(paper, []):
                pseudo = {
                    "paper": paper,
                    "pages": j["pages"],
                    "figures": filled_figures(j, det),
                }
                r = fw.job_rows(pseudo, det, gold, eye)
                rows += r["rows"]
                unnamed += r["unnamed"]
        print(
            variant,
            "recorded, else the map: gold",
            fm.tally([r for r in rows if r.get("status") == "gold"]),
            "eye",
            fm.tally([r for r in rows if r.get("status") == "eye"]),
            "unnamed",
            sorted(set(unnamed)),
        )
        disagree = {"rows": 0, "same": 0, "map_only": 0, "recorded_only": 0, "other": 0}
        for paper in PAPERS:
            for j in papers.get(paper, []):
                recorded: dict[str, set] = {}
                for f in j["figures"]:
                    recorded.setdefault(f["label"], set()).update(
                        f.get("numbers") or []
                    )
                for row in j.get("true_map") or j["map"]:
                    a, b = set(row["figures"]), recorded.get(row["label"], set())
                    if a or b:
                        disagree["rows"] += 1
                        kind = (
                            "same"
                            if a == b
                            else "map_only"
                            if a and not b
                            else "recorded_only"
                            if b and not a
                            else "other"
                        )
                        disagree[kind] += 1
        print(variant, "map figures against recorded, rows with any:", disagree)

    print("\n== refusals and rounds")
    for variant, papers in sorted(runs.items()):
        if variant.startswith("map"):
            for listed in dict(sorted(papers.items())).values():
                for j in listed:
                    print(
                        j["name"],
                        "batches",
                        [len(b) for b in j["batches"]],
                        "rounds",
                        j.get("batch_rounds"),
                        "refusals",
                        len(j.get("refusals") or []),
                        [r["result"][:90] for r in (j.get("refusals") or [])][:3],
                    )

    lines = [
        "# Every call of the paper-map runs",
        "",
        "Generated by `scripts/paper_map.py report`. `y2.0` is batch 2's first round. Start is",
        "seconds into the run. MB is the request body. Numbers are per call.",
        "",
        "| Run | Call | Start s | Took s | Input | Cached | Share | Output | Reasoning | Provider | MB |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for variant, papers in sorted(runs.items()):
        if not variant.startswith("map"):
            continue
        for listed in dict(sorted(papers.items())).values():
            for j in listed:
                ordered = sorted(j["call_log"], key=lambda c: c.get("at") or 0)
                for c in ordered:
                    name = "X" if c["stage"] == "X" else f"y{c['batch']}.{c['round']}"
                    if "input" not in c:
                        lines.append(
                            f"| {j['name']} | {name} | {c.get('at')} | {c.get('seconds')} | failed: {c.get('error', '')[:60]} | | | | | | |"
                        )
                        continue
                    lines.append(
                        f"| {j['name']} | {name} | {c['at']} | {c['seconds']} | {c['input']} | {c['cached']} | "
                        f"{c['cached'] / c['input']:.3f} | {c['output']} | {c['reasoning']} | {c.get('provider')} | "
                        f"{c.get('body_bytes', 0) / 1e6:.2f} |"
                    )
    (HERE.parent / "reports" / "2026-11-04-paper-map-parallel").mkdir(exist_ok=True)
    (
        HERE.parent / "reports" / "2026-11-04-paper-map-parallel" / "per-call.md"
    ).write_text("\n".join(lines) + "\n")

    print("\n== the merged selection")
    for variant, papers in sorted(runs.items()):
        for j in papers.get(MERGED, []):
            print(
                variant,
                j["name"],
                f"{j['seconds']}s ${j['billed_usd']}",
                "credits",
                round(credits(j["usage"]), 2),
                "usage",
                j["usage"],
                "recorded",
                len(j["report"]["recorded"]),
                j["report"]["recorded"][:70],
                "missing",
                j["report"].get("missing"),
                "figures",
                len(j["figures"]),
                "stopped",
                j["report"].get("stopped"),
                "providers",
                j.get("providers"),
            )
            if "map" in j:
                print(
                    "   check",
                    json.dumps(j["map_check"])[:600],
                    "batches",
                    [len(b) for b in j["batches"]],
                    "off",
                    j.get("off_batch"),
                    "fail",
                    j.get("batch_failures"),
                    "peak",
                    j.get("peak_in_flight"),
                )
    print("\n== bytes and memory")
    for variant, papers in sorted(runs.items()):
        if not variant.startswith("map"):
            continue
        for listed in dict(sorted(papers.items())).values():
            for j in listed:
                ys = [c for c in j["call_log"] if c["stage"] == "y"]
                first = [
                    c["body_bytes"] for c in ys if c["round"] == 0 and "body_bytes" in c
                ]
                total = sum(c.get("body_bytes", 0) for c in j["call_log"])
                x = next(c for c in j["call_log"] if c["stage"] == "X")
                print(
                    j["name"],
                    "pages",
                    len(j["pages"]),
                    "X MB",
                    round(x["body_bytes"] / 1e6, 2),
                    "y first MB",
                    round(min(first, default=0) / 1e6, 2),
                    round(max(first, default=0) / 1e6, 2),
                    "largest",
                    round(max(c.get("body_bytes", 0) for c in j["call_log"]) / 1e6, 2),
                    "calls",
                    len(j["call_log"]),
                    "run total MB",
                    round(total / 1e6, 1),
                    "rss",
                    j.get("rss_mb"),
                    "peak",
                    j.get("peak_in_flight"),
                )


# ---------------------------------------------------------- can it avoid re-uploading

PUBLIC_IMAGES = [
    "https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/b/b6/Image_created_with_a_mobile_phone.png",
    "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
]
ROUTE = {"order": ["InferenceNet", "Cloudflare", "wafer/us"], "allow_fallbacks": False}


async def probe(args) -> None:
    """Page images by URL, a stored response, and how big a body the route takes."""
    import httpx

    from pipeline.config import cfg
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import capture

    bench.load_env(args.env_file)
    headers = {"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"]}
    slug = bench.MODELS["v41-1017"][1]
    base = "https://openrouter.ai/api/v1"
    results: dict = {}
    spent = 0.0

    async with httpx.AsyncClient(timeout=600) as http:

        async def chat(messages, provider=ROUTE, max_tokens=64) -> dict:
            nonlocal spent
            body = {
                "model": slug,
                "messages": messages,
                "max_tokens": max_tokens,
                "provider": provider,
                "reasoning": {"effort": "low"},
                "usage": {"include": True},
            }
            size = len(json.dumps(body, ensure_ascii=False))
            t0 = time.monotonic()
            r = await http.post(f"{base}/chat/completions", json=body, headers=headers)
            out = {
                "status": r.status_code,
                "mb": round(size / 1e6, 2),
                "seconds": round(time.monotonic() - t0, 1),
            }
            try:
                data = r.json()
            except ValueError:
                out["error"] = r.text[:300]
                return out
            if "error" in data or not data.get("choices"):
                out["error"] = json.dumps(
                    data.get("error") or data, ensure_ascii=False
                )[:400]
                return out
            usage = data.get("usage") or {}
            spent += float(usage.get("cost") or 0)
            out |= {
                "provider": data.get("provider"),
                "input": usage.get("prompt_tokens"),
                "cached": (usage.get("prompt_tokens_details") or {}).get(
                    "cached_tokens"
                ),
                "output": usage.get("completion_tokens"),
                "cost": usage.get("cost"),
                "message": data["choices"][0]["message"],
            }
            return out

        if args.compare:
            # The same images by URL and as data URLs: per-call time and the cache.
            urls = PUBLIC_IMAGES
            inline = []
            for url in urls:
                got = await http.get(url, headers={"User-Agent": "capy-bench/1.0"})
                got.raise_for_status()
                results.setdefault("sizes_kb", []).append(len(got.content) // 1024)
                kind = got.headers["content-type"].split(";")[0]
                inline.append(
                    f"data:{kind};base64," + base64.b64encode(got.content).decode()
                )
            for name, images in (("by_url", urls), ("data_url", inline)):
                for attempt in (1, 2):
                    messages = [
                        {
                            "role": "system",
                            "content": f"Run {secrets.token_hex(6)}.\n{prompts.EXTRACT_SYSTEM}",
                        },
                        {
                            "role": "user",
                            "content": [
                                *(
                                    {"type": "image_url", "image_url": {"url": u}}
                                    for u in images
                                ),
                                {
                                    "type": "text",
                                    "text": "Say in five words what the images show.",
                                },
                            ],
                        },
                    ]
                    first = await chat(messages, max_tokens=300)
                    entry = {"x": {k: v for k, v in first.items() if k != "message"}}
                    if "message" in first:
                        thread = [
                            *messages,
                            {
                                "role": "assistant",
                                "content": first["message"].get("content") or "",
                                "reasoning": first["message"].get("reasoning") or "",
                            },
                        ]
                        ys = await asyncio.gather(
                            *(
                                chat(
                                    [*thread, {"role": "user", "content": f"Say {w}."}]
                                )
                                for w in ("one", "two", "three")
                            )
                        )
                        entry["y"] = [
                            {k: v for k, v in y.items() if k != "message"} for y in ys
                        ]
                    results[f"{name}_{attempt}"] = entry
            results["spent"] = spent
            fm.Spend().add("probes", spent)
            (OUT / "probes-url.json").write_text(json.dumps(results, indent=1))
            print(json.dumps(results, indent=1))
            return

        # 1. Images by URL: X, then two y's in parallel, as the route would send them.
        nonce = secrets.token_hex(6)
        by_url = [
            {"role": "system", "content": f"Run {nonce}.\n{prompts.EXTRACT_SYSTEM}"},
            {
                "role": "user",
                "content": [
                    *(
                        {"type": "image_url", "image_url": {"url": url}}
                        for url in PUBLIC_IMAGES
                    ),
                    {
                        "type": "text",
                        "text": "Say in five words each what the images show.",
                    },
                ],
            },
        ]
        first = await chat(by_url, max_tokens=400)
        results["url_x"] = {k: v for k, v in first.items() if k != "message"}
        if "message" in first:
            reply = {
                "role": "assistant",
                "content": first["message"].get("content") or "",
                "reasoning": first["message"].get("reasoning") or "",
            }
            thread = [*by_url, reply]
            ys = await asyncio.gather(
                *(
                    chat([*thread, {"role": "user", "content": f"Say {word}."}])
                    for word in ("one", "two")
                )
            )
            results["url_y"] = [
                {k: v for k, v in y.items() if k != "message"} for y in ys
            ]
        # Each provider on the route, alone.
        for name in ROUTE["order"]:
            one = await chat(
                [
                    *by_url[:1],
                    {
                        **by_url[1],
                        "content": [by_url[1]["content"][0], by_url[1]["content"][-1]],
                    },
                ],
                provider={"only": [name], "allow_fallbacks": False},
            )
            results[f"url_only_{name}"] = {
                k: v for k, v in one.items() if k != "message"
            }

        # The cache on each provider, and across providers: X on one, y's after it.
        pdf = fm.OUT / "merged" / f"{MERGED}.pdf"
        some = []
        for number in range(1, 9):
            jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
            some.append(capture.data_url(jpeg))

        def eight_pages(run: str) -> list[dict]:
            return [
                {"role": "system", "content": f"Run {run}.\n{prompts.EXTRACT_SYSTEM}"},
                {
                    "role": "user",
                    "content": [
                        *({"type": "image_url", "image_url": {"url": u}} for u in some),
                        {
                            "type": "text",
                            "text": "List the question numbers on these pages.",
                        },
                    ],
                },
            ]

        for name in ROUTE["order"]:
            only = {"only": [name], "allow_fallbacks": False}
            messages = eight_pages(secrets.token_hex(6))
            first = await chat(messages, provider=only, max_tokens=300)
            entry = {"x": {k: v for k, v in first.items() if k != "message"}}
            if "message" in first:
                reply = {
                    "role": "assistant",
                    "content": first["message"].get("content") or "",
                    "reasoning": first["message"].get("reasoning") or "",
                }
                thread = [*messages, reply]
                ys = await asyncio.gather(
                    *(
                        chat(
                            [*thread, {"role": "user", "content": f"Say {w}."}],
                            provider=only,
                        )
                        for w in ("one", "two", "three")
                    )
                )
                entry["y_same_provider"] = [
                    {k: v for k, v in y.items() if k != "message"} for y in ys
                ]
                for other in ROUTE["order"]:
                    if other != name:
                        y = await chat(
                            [*thread, {"role": "user", "content": "Say four."}],
                            provider={"only": [other], "allow_fallbacks": False},
                        )
                        entry[f"y_on_{other}"] = {
                            k: v for k, v in y.items() if k != "message"
                        }
            results[f"cache_{name}"] = entry
            print(name, json.dumps(entry)[:600], "spent", round(spent, 4), flush=True)

        # 2. A server-side conversation reference.
        r = await http.post(
            f"{base}/responses",
            headers=headers,
            json={
                "model": slug,
                "input": "Say one.",
                "previous_response_id": "resp_0000000000000000",
                "max_output_tokens": 16,
            },
        )
        results["previous_response_id"] = {
            "status": r.status_code,
            "body": r.text[:300],
        }

        # 3. How big a body: the 39 pages' real images, repeated.
        pages = []
        for number in range(1, 40):
            jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
            pages.append(capture.data_url(jpeg))
        one_set = sum(len(u) for u in pages)
        results["page_set_mb"] = round(one_set / 1e6, 2)
        for target in args.sizes:
            copies = max(1, round(target * 1e6 / one_set))
            content = [
                {"type": "image_url", "image_url": {"url": u}}
                for _ in range(copies)
                for u in pages
            ]
            content.append({"type": "text", "text": "Say one."})
            out = await chat(
                [{"role": "user", "content": content}],
                provider={"only": ["InferenceNet"], "allow_fallbacks": False},
                max_tokens=8,
            )
            out.pop("message", None)
            out["images"] = len(content) - 1
            results[f"body_{target}mb"] = out
            print(target, out, "spent", round(spent, 4), flush=True)
            if out["status"] != 200 or spent > 0.12:
                break
    results["spent"] = spent
    fm.Spend().add("probes", spent)
    (OUT / "probes.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    print(json.dumps(results, indent=1, ensure_ascii=False))


def merged_paper(args) -> None:
    """2023 Paper 1 and Paper 2 as one 39-page file, for the about-40-page selection,
    with each page's saved detections. It stays in the ignored results."""
    import pymupdf

    folder = fm.OUT / "merged"
    folder.mkdir(parents=True, exist_ok=True)
    out = folder / f"{MERGED}.pdf"
    if not out.exists():
        doc = pymupdf.open()
        for name in ("2023-p1", "2023-p2"):
            with pymupdf.open(Path(args.scans) / f"{name}.pdf") as src:
                doc.insert_pdf(src)
        doc.save(out)
    det = fm.load_detections(args.detections)
    pages = []
    for n in range(1, 40):
        stem = fm.stem_of("2023-p1", n) if n <= 24 else fm.stem_of("2023-p2", n - 24)
        pages.append({"page": fm.stem_of(MERGED, n), "regions": det.get(stem, [])})
    (fm.OUT / "detections" / f"{MERGED}.json").write_text(json.dumps({"pages": pages}))


def setup(args) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    fw.OUT = OUT
    fm.Spend.path = OUT / "spend.json"
    fw.SPEND_CAP = SPEND_CAP
    fm.SPEND_CAP = SPEND_CAP
    fw.KATEX = Path("/Users/sam/web/capy-notebook/node_modules/katex")
    merged_paper(args)


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
    p.add_argument("--plain", action="store_true", help="none and boxes jobs")
    p = sub.add_parser("probe")
    p.add_argument("--scans", required=True)
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--env-file", required=True)
    p.add_argument("--sizes", type=int, nargs="*", default=[15, 30, 60])
    p.add_argument(
        "--compare", action="store_true", help="by URL against data URLs only"
    )
    p = sub.add_parser("report")
    p.add_argument("--scans", required=True)
    p.add_argument("--digital", required=True)
    p.add_argument("--detections", nargs="*", default=[])
    p.add_argument("--saved", required=True)
    args = parser.parse_args()
    setup(args)
    if args.command == "report":
        report(args)
        return
    if args.command == "probe":
        asyncio.run(probe(args))
        return
    bench.load_env(args.env_file)
    if not args.plain:
        from pipeline.retrieval import extraction

        extraction.WINDOW_PAGES = 100_000
        fw.AFTER_INSTALL = install_map
    asyncio.run(fw.run_jobs(args))


if __name__ == "__main__":
    main()
