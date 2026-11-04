"""Write the full Make a quiz prompt into one markdown file, from the real code:
``todo-study-tracking/R6-extraction-prompt.md``.

    python -I prompt_doc.py --window <trial result.json>:<window index>

Nothing here is typed by hand: each prompt and tool schema comes from the call the
code makes, each call's settings from the HTTP body it builds (the transport is
stubbed, so no model is called and no key is read), each tool result string from
driving ``_window`` with scripted replies, and the sample window's user message
from a real trial run. The paper is under copyright, so that window's page text is
cut to a few words and marked; ``--full <ignored path>`` also writes it whole for
reading locally.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402  (puts the pipeline on the path)

OUT = bench.ROOT / "todo-study-tracking" / "R6-extraction-prompt.md"
SHOWN_WORDS = 8
BUDGET = 1_000_000


def cut(text: str) -> str:
    words = text.split()
    if len(words) <= SHOWN_WORDS:
        return text
    return " ".join(words[:SHOWN_WORDS]) + f" … [{len(text)} characters in all]"


def cut_message(items: list[str]) -> list[str]:
    """The page text inside <source> and the open question's blocks, cut."""

    def source(match: re.Match) -> str:
        return f"<source>\n{cut(match.group(1))}\n</source>"

    def cut_blocks(value):
        if isinstance(value, dict):
            return {
                k: cut(v) if k in ("text", "trailing_text") else cut_blocks(v)
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [cut_blocks(v) for v in value]
        return value

    out = []
    for item in items:
        item = re.sub(r"<source>\n(.*)\n</source>", source, item, flags=re.DOTALL)
        head, marker, rest = item.partition("carries on with it:\n")
        if marker:
            item = (
                head
                + marker
                + json.dumps(cut_blocks(json.loads(rest)), ensure_ascii=False)
            )
        out.append(item)
    return out


class Transport:
    """Stands in for OpenRouter: records each request body, answers from a script."""

    def __init__(self) -> None:
        from pipeline.elitellm import client

        self.bodies: list[dict] = []
        self.replies: list[dict] = []
        client._stream_sse = self.stream
        client._post_json = self.post

    def next_reply(self) -> dict:
        return self.replies.pop(0) if self.replies else {"content": "{}"}

    async def stream(self, url, headers, body):
        self.bodies.append(body)
        reply = self.next_reply()
        delta: dict = {"role": "assistant", "content": reply.get("content", "")}
        if "tool_calls" in reply:
            delta["tool_calls"] = [
                {**call, "index": index}
                for index, call in enumerate(reply["tool_calls"])
            ]
        yield {
            "id": "x",
            "model": body["model"],
            "choices": [
                {
                    "index": 0,
                    "delta": delta,
                    "finish_reason": reply.get("finish", "stop"),
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }

    async def post(self, url, headers, body, **kwargs):
        raise AssertionError("the run's calls stream")


def setting(body: dict, name: str) -> str:
    return json.dumps(body[name], ensure_ascii=False) if name in body else "not sent"


def fenced(text: str, kind: str = "text") -> str:
    return f"```{kind}\n{text}\n```"


def call(arguments, name: str = "record_question", n: list = [0]) -> dict:
    n[0] += 1
    return {
        "id": f"call_{n[0]}",
        "type": "function",
        "function": {
            "name": name,
            "arguments": arguments
            if isinstance(arguments, str)
            else json.dumps(arguments),
        },
    }


def question(label: str, **extra) -> dict:
    return {
        "label": label,
        "stem": [],
        "parts": [
            {
                "label": "a",
                "blocks": [{"type": "text", "text": "Find x."}],
                "answer": {"type": "short", "accepted": ["1"]},
                "marks": 1,
                "key_source": "printed",
                "solution": "x is 1.",
            }
        ],
        **extra,
    }


async def tool_results(transport: Transport, model) -> list[tuple[str, str]]:
    """Every string a tool result can hold, from ``_window`` itself: scripted
    replies, one problem each, and what the next call was sent."""
    from pipeline.generated import limits
    from pipeline.retrieval import extraction, layout

    async def image() -> str:
        return "data:image/jpeg;base64,AA=="

    async def crop(box):
        return b"", (1, 1)

    box = layout.Region("image", 0.9, [100.0, 100.0, 200.0, 200.0])
    pages = [
        extraction.Page(5, "paper.pdf", "", image, crop, (box,)),
        extraction.Page(6, "paper.pdf", "", image, crop, (box,)),
    ]
    validate = bench.validator(bench.RESULTS / "quizcheck")

    def recorded(label: str, parts: int = 1) -> extraction.Recorded:
        made = extraction.record(question(label), "AI-written")
        made.question["parts"] = made.question["parts"] * parts
        made.part_labels = ["a"] * parts
        made.sources = ["printed"] * parts
        return made

    run = extraction.Run(validate=validate, ai_label="AI-written", output_budget=BUDGET)
    # A question from earlier pages, and the open question.
    run.order |= {"3": 0, "7": 1}
    run.recorded |= {"3": recorded("3"), "7": recorded("7")}
    run.open_label = "7"
    no_source = question("9")
    del no_source["parts"][0]["key_source"]
    refused = question("10")
    refused["parts"][0]["answer"] = {"type": "mcq", "options": ["a"], "correct": []}
    long_words = "x" * (limits.QUESTION_DESCRIPTION_MAX + 1)
    cases = [
        ("Arguments that are not JSON", call('{"label": "1"')),
        ("Arguments that are not an object", call("[1]")),
        ("A tool that does not exist", call({}, "other_tool")),
        ("No label or no parts", call({"label": "1", "parts": []})),
        ("A label already recorded from earlier pages", call(question("3"))),
        (
            "A figure naming a part the question lacks",
            call(question("11", figures=[{"boxes": [1], "part": "z"}])),
        ),
        (
            "A figure's description too long",
            call(question("11", figures=[{"boxes": [1], "description": long_words}])),
        ),
        (
            "A figure with boxes [] and no page image",
            call(question("11", figures=[{"boxes": []}])),
        ),
        (
            "A figure naming a box that does not exist",
            call(question("11", figures=[{"boxes": [9]}])),
        ),
        (
            "A figure with boxes on two pages",
            call(question("11", figures=[{"boxes": [1, 2]}])),
        ),
        ("A part with no key_source", call(no_source)),
        ("The validator refuses a recorded question (Go's message)", call(refused)),
        ("Recorded", call(question("12"))),
        (
            "Continuing a question that is neither open nor this window's last",
            call({"label": "3", "parts": []}, "continue_question"),
        ),
        (
            "The validator refuses a continued question (Go's message)",
            call(
                {
                    "label": "12",
                    "parts": [
                        {
                            **question("x")["parts"][0],
                            "answer": refused["parts"][0]["answer"],
                        }
                    ],
                },
                "continue_question",
            ),
        ),
        (
            "Continued (the open question, or the last one recorded in this window)",
            call(
                {"label": "12", "parts": [question("x")["parts"][0]]},
                "continue_question",
            ),
        ),
    ]
    # One reply holding every call, as a window may send several at once.
    transport.replies = [
        {"tool_calls": [case[1] for case in cases]},
        {"content": "DONE"},
    ]
    await extraction._window(run, pages, model=model)
    tool_messages = [
        m["content"] for m in transport.bodies[-1]["messages"] if m["role"] == "tool"
    ]
    assert len(tool_messages) == len(cases), (len(tool_messages), len(cases))
    return [(case[0], result) for case, result in zip(cases, tool_messages)]


async def full_strings(model) -> list[tuple[str, str]]:
    """The two results for a full quiz, from the Run methods the window calls."""
    from pipeline.generated import limits
    from pipeline.retrieval import extraction

    async def validate(q):
        return None

    made = extraction.record(question("7"), "AI-written")
    made.question["parts"] = made.question["parts"] * limits.QUIZ_PARTS_MAX
    made.part_labels = ["a"] * limits.QUIZ_PARTS_MAX
    made.sources = ["printed"] * limits.QUIZ_PARTS_MAX
    run = extraction.Run(validate=validate, ai_label="AI-written", output_budget=BUDGET)
    run.order["7"] = 0
    run.recorded["7"] = made
    run.open_label = "7"
    window: set[str] = set()
    return [
        (
            "A recorded question past the quiz's limits",
            await run.add(question("13"), window, []),
        ),
        (
            "A continued question past the quiz's limits",
            await run.extend(
                {"label": "7", "parts": [question("x")["parts"][0]]}, window, []
            ),
        ),
    ]


async def generate(args) -> str:
    from pipeline import elitellm
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import extraction, limits

    os.environ.setdefault("OPENROUTER_API_KEY", "not-a-key-the-transport-is-stubbed")
    transport = Transport()
    _, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec("openrouter", slug, name, rates, "low")
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))

    async def image() -> str:
        return "data:image/jpeg;base64,AA=="

    async def crop(box):
        return b"", (1, 1)

    async def validate(q):
        return None

    page = extraction.Page(5, "paper.pdf", "<the page's indexed text>", image, crop)

    # The four calls, through the real functions.
    transport.replies = [{"content": "DONE"}]
    run = extraction.Run(validate=validate, ai_label="AI-written", output_budget=BUDGET)
    await extraction._window(run, [page], model=model)
    window_body = transport.bodies[-1]
    transport.replies = [{"content": '{"questions": []}'}]
    await extraction.outline([page], model=model)
    outline_body = transport.bodies[-1]
    transport.replies = [{"content": '{"entries": []}'}]
    await extraction.parse_schemes(
        [
            extraction.SchemeFile(
                "answers.pdf", "<the file's indexed text, 12,000 characters a piece>"
            )
        ],
        model=model,
        labels=[("1", [""]), ("3", ["a", "b(i)"])],
    )
    scheme_body = transport.bodies[-1]
    transport.replies = [{"content": '{"boxes": [[1, 1, 2, 2], [3, 3, 4, 4]]}'}]
    await extraction.locate(page, [("3", "A triangle ABC"), ("4", "")], model=model)
    locate_body = transport.bodies[-1]
    # A window reply cut off at the output cap, and what the next call adds.
    transport.replies = [{"finish": "length"}, {"content": "DONE"}]
    await extraction._window(
        extraction.Run(validate=validate, ai_label="AI-written", output_budget=BUDGET),
        [page],
        model=model,
    )
    cut_off = transport.bodies[-1]["messages"][-1]["content"]

    results = await tool_results(transport, model) + await full_strings(model)

    samples = []
    for window in args.window:
        path, _, index = window.rpartition(":")
        sample = json.loads(Path(path).read_text())
        samples.append((sample["name"], int(index), sample["sent"][int(index)]))
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        cwd=bench.ROOT,
        check=True,
    ).stdout.strip()

    def row(what: str, body: dict) -> str:
        return (
            f"| {what} | `{body['model']}` | `{setting(body, 'provider')}` "
            f"| `{setting(body, 'reasoning')}` | {setting(body, 'max_tokens')} "
            f"| {len(body.get('tools') or []) or 'none'} "
            f"| {setting(body, 'tool_choice')} | {setting(body, 'response_format')} "
            f"| {setting(body, 'stream')} |"
        )

    def messages_of(body: dict) -> str:
        out = []
        for message in body["messages"]:
            content = message["content"]
            if isinstance(content, list):
                content = "\n".join(
                    item["text"] if item["type"] == "text" else "<image: the page>"
                    for item in content
                )
            out.append(f"**{message['role']}**\n\n{fenced(content)}")
        return "\n\n".join(out)

    lines = [
        "# Make a quiz: the full prompt",
        "",
        f"Generated from the code at `{commit}` by "
        "`bench/extraction/scripts/prompt_doc.py`. Change the code and run the script; "
        "do not edit this file.",
        "",
        "## Call settings",
        "",
        "From the HTTP body each call builds, with the run's bindings: the extraction "
        "slot's route and thinking `mid`. A reply is read as a stream. The windows "
        f"also stop at {extraction.WINDOW_STEPS} calls a window and "
        f"{extraction.WINDOW_OUTPUT_PER_PAGE:,} output tokens per selected page.",
        "",
        "| Call | Model | Route | Reasoning | Max tokens | Tools | Tool choice | Response format | Stream |",
        "|---|---|---|---|---|---|---|---|---|",
        row("Page window (`extraction_window`)", window_body),
        row("Outline (`extraction_outline`)", outline_body),
        row("Mark scheme (`extraction_scheme`)", scheme_body),
        row("Box call (`extraction_figures`)", locate_body),
        "",
        "## The page window call",
        "",
        "### System prompt",
        "",
        fenced(window_body["messages"][0]["content"]),
        "",
        "### Tools",
        "",
        fenced(json.dumps(window_body["tools"], indent=2, ensure_ascii=False), "json"),
        "",
        "### The user message of real windows",
        "",
        "From trial runs, in order. Each block is one content part of the message, and "
        "images are shown as `<image: page N>`. The papers are under copyright, so "
        "page text, the open question's blocks and held text are cut to a few words "
        "here; everything else is as sent.",
        "",
        *(
            line
            for name, index, sent in samples
            for line in (
                f"`{name}`, window {index + 1}:",
                "",
                *(fenced(item) + "\n" for item in cut_message(sent)),
            )
        ),
        "### A reply cut off at the output cap",
        "",
        "The next call in that window adds this user message.",
        "",
        fenced(cut_off),
        "",
        "## The outline call",
        "",
        messages_of(outline_body),
        "",
        "## The mark scheme call",
        "",
        "One call per piece of each answer file, with the recorded questions' labels.",
        "",
        messages_of(scheme_body),
        "",
        "## The box call",
        "",
        "One call per page holding a figure with no box, with those figures listed.",
        "",
        messages_of(locate_body),
        "",
        "## Every tool result string",
        "",
        "Each from the real code, by driving a window with scripted replies. A tool "
        "result is the only thing the model reads back from a tool call.",
        "",
        "| When | The tool result |",
        "|---|---|",
        *(
            f"| {when} | `{text.replace('|', chr(92) + '|')}` |"
            for when, text in results
        ),
        "",
        "The validator's messages come from Go's quiz check "
        "(`server/internal/materialdoc`, `cmd/quizcheck` here); the two rows above are "
        "real examples of its many messages, each with `Fix it and record it again.` or "
        "`Fix it and continue it again.` after it.",
        "",
    ]
    if args.full:
        Path(args.full).write_text(
            "\n\n".join("\n\n".join(sent) for _, _, sent in samples)
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--window", nargs="+", required=True, help="<trial result.json>:<window index>"
    )
    parser.add_argument("--full", help="an ignored path for the uncut window")
    args = parser.parse_args()
    binary = bench.RESULTS / "quizcheck"
    if not binary.exists():
        bench.quizcheck()
    text = asyncio.run(generate(args))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(text)
    print(OUT, len(text), "characters")


if __name__ == "__main__":
    main()
