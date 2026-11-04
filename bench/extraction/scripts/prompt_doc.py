"""Write the full Make a quiz prompt into one markdown file, from the real code:
``todo-study-tracking/R6-extraction-prompt.md``.

    python -I prompt_doc.py

Nothing here is typed by hand: each prompt and tool schema comes from the call the
code makes, each call's settings from the HTTP body it builds (the transport is
stubbed, so no model is called and no key is read), and each tool result string from
driving ``extraction.run`` with scripted replies. A page's text stays a placeholder.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402  (puts the pipeline on the path)

OUT = bench.ROOT / "todo-study-tracking" / "R6-extraction-prompt.md"
BUDGET = 1_000_000


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
                "solution": "x is 1.",
            }
        ],
        **extra,
    }


def copied(label: str, **extra) -> dict:
    """A record_question call."""
    item = question(label)
    part = item["parts"][0]
    del part["solution"]
    part["answer"] = {"type": "short"}
    return {"pages": [5, 5], "figures": [], **item, **extra}


def answers(label: str, **extra) -> dict:
    """A record_answers call."""
    return {
        "label": label,
        "parts": [
            {
                "label": "a",
                "accepted": ["1"],
                "solution": "x is 1.",
                **extra,
            }
        ],
    }


async def generate(args) -> str:
    from pipeline.generated import limits as generated
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import extraction, layout, limits

    from pipeline import elitellm, registry

    os.environ.setdefault("OPENROUTER_API_KEY", "not-a-key-the-transport-is-stubbed")
    transport = Transport()
    _, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec("openrouter", slug, name, rates, "low")
    elitellm.bind_route_slot("extraction")
    registry.bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))

    async def image() -> str:
        return "data:image/jpeg;base64,AA=="

    async def crop(box):
        return b"", (1, 1)

    box = layout.Region("image", 0.9, [100.0, 100.0, 200.0, 200.0])

    async def read_regions(images):
        return [(box,) for _ in images]

    layout.read_regions = read_regions
    pages = [
        extraction.Page(
            5,
            "paper.pdf",
            "<the page's indexed text>",
            image,
            crop,
            layer=extraction.BORN_DIGITAL,
        ),
        extraction.Page(6, "paper.pdf", "", image, crop, layer=extraction.BORN_DIGITAL),
    ]
    validate = bench.validator(bench.RESULTS / "quizcheck")
    long_words = "x" * (generated.QUESTION_DESCRIPTION_MAX + 1)
    keyed = copied("11")
    keyed["parts"][0]["answer"] = {"type": "mcq", "options": ["a"]}
    open_part = copied("13")
    open_part["parts"][0]["answer"] = {"type": "open"}
    open_part["parts"][0]["marks"] = 2
    copy_cases = [
        ("Arguments that are not JSON", call('{"label": "1"')),
        ("Arguments that are not an object", call("[1]")),
        ("A tool that does not exist", call({}, "other_tool")),
        ("No label or no parts", call({"label": "1", "parts": []})),
        ("No first and last page", call({**copied("12"), "pages": []})),
        (
            "No figures",
            call({k: v for k, v in copied("12").items() if k != "figures"}),
        ),
        (
            "A figure naming a part the question lacks",
            call(copied("12", figures=[{"boxes": [1], "part": "z"}])),
        ),
        (
            "A figure's description too long",
            call(copied("12", figures=[{"boxes": [1], "description": long_words}])),
        ),
        (
            "A figure with boxes [] and no page image",
            call(copied("12", figures=[{"boxes": []}])),
        ),
        (
            "A figure naming a box that does not exist",
            call(copied("12", figures=[{"boxes": [9]}])),
        ),
        (
            "A figure with boxes on two pages",
            call(copied("12", figures=[{"boxes": [1, 2]}])),
        ),
        ("The validator refuses a copied question (Go's message)", call(keyed)),
        ("Answers while copying", call(answers("12"), "record_answers")),
        ("Copied", call(copied("12"))),
    ]
    solve_cases = [
        ("A question already copied", call(copied("12"))),
        ("Answers for a label not copied", call(answers("7"), "record_answers")),
        (
            "Answers for a part the question lacks",
            call(
                {"label": "12", "parts": [{**answers("12")["parts"][0], "label": "z"}]},
                "record_answers",
            ),
        ),
        (
            "An open part with no model answer",
            call(
                {
                    "label": "13",
                    "parts": [
                        {
                            "label": "a",
                            "accepted": [],
                            "points": [{"text": "1A", "marks": 2}],
                            "solution": "x is 1.",
                        }
                    ],
                },
                "record_answers",
            ),
        ),
        (
            "The validator refuses answers (Go's message)",
            call(
                {
                    "label": "13",
                    "parts": [
                        {
                            "label": "a",
                            "accepted": ["1"],
                            "points": [{"text": "1A", "marks": 1}],
                            "solution": "x is 1.",
                        }
                    ],
                },
                "record_answers",
            ),
        ),
        ("Answers recorded", call(answers("12"), "record_answers")),
    ]
    extras = [
        {
            "tool_calls": [
                call(open_part),
                *(case[1] for case in copy_cases),
            ]
        },
        {"finish": "length"},
    ]
    transport.replies = [
        {
            "content": "12 | pages 5-5 | parts a | figures none\n"
            "13 | pages 5-5 | parts a | figures none"
        },
        *extras,
        {"content": "DONE"},
        {"tool_calls": [case[1] for case in solve_cases]},
        {"content": "DONE"},
        {"tool_calls": [call(answers("13") | {"parts": []}, "record_answers")]},
        {"content": "DONE"},
    ]
    answer_files = [
        extraction.AnswerFile("answers.docx", "<the file's indexed text>"),
        extraction.AnswerFile("answers.jpg", images=((1, pages[0].image),)),
    ]
    async for _ in extraction.run(
        pages,
        answer_files,
        model=model,
        validate=validate,
    ):
        pass
    bodies = {}
    for body in transport.bodies:
        last = next(m for m in reversed(body["messages"]) if m["role"] == "user")
        ask = last["content"] if isinstance(last["content"], str) else "map"
        bodies.setdefault(ask, body)
    map_body = bodies["map"]
    copy_ask = next(a for a in bodies if a.startswith("Copy "))
    solve_ask = next(a for a in bodies if a.startswith("Give "))
    copy_body = bodies[copy_ask]
    solve_body = bodies[solve_ask]
    cut_off = next(
        m["content"]
        for body in transport.bodies
        for m in body["messages"]
        if m["role"] == "user" and str(m["content"]).startswith("Your last reply")
    )

    def tool_messages(ask: str) -> list[str]:
        """The tool results a thread's last call was sent."""
        last = [
            body
            for body in transport.bodies
            if next(m for m in reversed(body["messages"]) if m["role"] == "user")[
                "content"
            ]
            == ask
        ][-1]
        return [m["content"] for m in last["messages"] if m["role"] == "tool"]

    copy_results = tool_messages(copy_ask)[1:]
    solve_results = tool_messages(solve_ask)[-len(solve_cases) :]
    assert len(copy_results) == len(copy_cases), (len(copy_results), len(copy_cases))
    results = [
        *((case[0], result) for case, result in zip(copy_cases, copy_results)),
        *((case[0], result) for case, result in zip(solve_cases, solve_results)),
        *await full_strings(extraction),
    ]

    transport.replies = [{"content": '{"boxes": [[1, 1, 2, 2], [3, 3, 4, 4]]}'}]
    await extraction.locate(pages[0], [("3", "A triangle ABC"), ("4", "")], model=model)
    locate_body = transport.bodies[-1]
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

    map_user = "\n\n".join(
        fenced(item["text"] if item["type"] == "text" else "<image: the page>")
        for item in map_body["messages"][1]["content"]
    )
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
        "slot's route and thinking `mid`, which the copy calls bind to `low`. A reply is "
        f"read as a stream. Copy batches hold {extraction.COPY_BATCH} questions and solve "
        f"batches {extraction.SOLVE_BATCH}. A thread stops at {extraction.THREAD_ROUNDS} "
        f"calls, and a run at {extraction.OUTPUT_PER_PAGE:,} output tokens per selected "
        "page.",
        "",
        "| Call | Model | Route | Reasoning | Max tokens | Tools | Tool choice | Response format | Stream |",
        "|---|---|---|---|---|---|---|---|---|",
        row("Map (`extraction_map`)", map_body),
        row("Copy batch (`extraction_copy`)", copy_body),
        row("Solve batch (`extraction_solve`)", solve_body),
        row("Box call (`extraction_figures`)", locate_body),
        "",
        "## The map, copy and solve calls",
        "",
        "### System prompt",
        "",
        "The same on all three.",
        "",
        fenced(map_body["messages"][0]["content"]),
        "",
        "### Tools",
        "",
        "The same on all three.",
        "",
        fenced(json.dumps(map_body["tools"], indent=2, ensure_ascii=False), "json"),
        "",
        "### The map's user message",
        "",
        "On a born-digital paper. Each block is one content part of the message: each "
        "page's text and image, then all the boxes, numbered once across the selection, "
        "then the answer files, then the ask. An answer file goes as its indexed text when "
        "it is a born-digital PDF, Word, PowerPoint or text file, and as page images, under "
        "their own count, when it is a scan or an image. At most "
        f"{extraction.limits.EXTRACTION_PAGES_MAX} page images a run, paper and answer "
        "pages together. Here one of each.",
        "",
        map_user,
        "",
        "### A scan or an image: no page text",
        "",
        "A run sends page text only when no selected page of the question paper is a scan "
        "and at least one is born digital, read from the stored PDF at the start "
        "(`extraction.page_layer`). An answer file has no say. "
        f"Born digital: at least {extraction.VISIBLE_CHARS} characters "
        "the page shows, not in render mode 3 or at zero opacity, and no image covering "
        f"{extraction.IMAGE_COVERS_PAGE:.0%} of it. Blank, with no say: fewer, no image and "
        f"under {extraction.VISIBLE_CHARS} characters of indexed text. Anything else is a "
        "scan, and so are an image upload and whatever is not known. With no page text the "
        "system prompt's first paragraph is this, and each page goes as this heading then "
        "its image. Nothing else changes.",
        "",
        fenced(prompts.SYSTEM_NO_PAGE_TEXT.split("\n\n")[0]),
        "",
        fenced(prompts.page_heading(1, 2, "<file name>")),
        "",
        "### A copy batch",
        "",
        "The map's messages and its reply with its reasoning, then this. Questions 1 to "
        "16 read `Copy questions 1 to 16 now.`",
        "",
        fenced(copy_ask),
        "",
        "### A solve batch",
        "",
        "The whole copy thread that holds its questions, replies with their reasoning "
        "and tool results, then this. Questions 17 to 24 read "
        "`Give the answers to questions 17 to 24 now.`",
        "",
        fenced(solve_ask),
        "",
        "### Repairs",
        "",
        "A question a batch left out, in the same thread, by the same asks: "
        "`Copy question 8 now.`, `Give the answers to question 8 now.`, and "
        "`Copy questions 8 to 10 now.` for several in a row.",
        "",
        "### A reply cut off at the output cap",
        "",
        "The next call in that thread adds this user message.",
        "",
        fenced(cut_off),
        "",
        "## The box call",
        "",
        "One call per page holding a figure with no box, with those figures listed.",
        "",
        messages_of(locate_body),
        "",
        "## Every tool result string",
        "",
        "Each from the real code, by driving a run with scripted replies. A tool result "
        "is the only thing the model reads back from a tool call.",
        "",
        "| When | The tool result |",
        "|---|---|",
        *(
            f"| {when} | `{text.replace('|', chr(92) + '|')}` |"
            for when, text in results
        ),
        "",
        "The validator's messages come from Go's quiz check "
        "(`server/internal/materialdoc`, `cmd/quizcheck` here); the rows above are real "
        "examples of its many messages, each with `Fix it and record it again.` after it.",
        "",
    ]
    return "\n".join(lines)


async def full_strings(extraction) -> list[tuple[str, str]]:
    """The result for a full quiz, from the Run method the threads call."""
    from pipeline.generated import limits

    async def validate(q):
        return None

    made = extraction.record(question("7"))
    made.question["parts"] = made.question["parts"] * limits.QUIZ_PARTS_MAX
    made.part_labels = ["a"] * limits.QUIZ_PARTS_MAX
    run = extraction.Run(validate=validate, output_budget=BUDGET)
    run.order["7"] = 0
    run.recorded["7"] = made

    async def image() -> str:
        return ""

    async def crop(box):
        return b"", (1, 1)

    page = extraction.Page(5, "paper.pdf", "", image, crop)
    return [
        (
            "A question past the quiz's limits",
            await run.copy_question(copied("13"), [page]),
        ),
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
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
