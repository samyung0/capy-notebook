"""The answer format (prompts/answer_markdown.txt).

The answer is Markdown with ``[#n]`` citation markers, figure fences (chart,
plot, mermaid, html-embed) and a trailing ``ask`` fence for AskUser questions;
the browser renders it (MarkdownAnswer.tsx). Nothing here can fail to parse:
the text streams through as written and only the markers are read.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable

# [#2] or [#2,5]: the shown passages behind the text before it.
MARKER = re.compile(r"\[#(\d+(?:\s*,\s*\d+)*)\]")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)(.*)$")
# A figure's own sources: JSON "passages" on a chart or plot, an attribute on
# the html-embed line.
EMBED_PASSAGES = re.compile(r'\bpassages="?(\d+(?:\s*,\s*\d+)*)"?')


def _fence_passages(lang: str, info: str, body: str) -> list[int]:
    if lang == "html-embed":
        found = EMBED_PASSAGES.search(info)
        return [int(part) for part in found.group(1).split(",")] if found else []
    if lang not in ("chart", "plot"):
        return []
    try:
        passages = json.loads(body).get("passages")
    except (AttributeError, json.JSONDecodeError):
        return []
    if not isinstance(passages, list):
        return []
    return [n for n in passages if isinstance(n, int)]


def cited(text: str, known: int) -> list[int]:
    """Passage numbers in reading order, each once, those not shown dropped:
    the prose's markers and each closed figure's passages. A code fence's
    text cites nothing."""
    order: list[int] = []

    def add(numbers: Iterable[int]) -> None:
        for n in numbers:
            if 1 <= n <= known and n not in order:
                order.append(n)

    lines = text.split("\n")
    i = 0
    while i < len(lines):
        fence = FENCE.match(lines[i])
        if fence is None:
            for marker in MARKER.finditer(lines[i]):
                add(int(part) for part in marker.group(1).split(","))
            i += 1
            continue
        mark, lang, info = fence.groups()
        close = re.compile(rf"^ {{0,3}}{mark[0]}{{{len(mark)},}}[ \t]*$")
        end = next((j for j in range(i + 1, len(lines)) if close.match(lines[j])), None)
        if end is None:
            break
        add(_fence_passages(lang, info, "\n".join(lines[i + 1 : end])))
        i = end + 1
    return order


class MarkdownRenderer:
    """Every delta is answer text; ``order`` grows as markers complete."""

    def __init__(self, known: Callable[[], int]):
        self.known = known
        self.text = ""
        self.order: list[int] = []

    def push(self, delta: str) -> str:
        self.text += delta
        for n in cited(self.text, self.known()):
            if n not in self.order:
                self.order.append(n)
        return delta

    def reading_order(self) -> list[int]:
        return cited(self.text, self.known())


def ask_fence(asks: list[tuple[str, list[str]]]) -> str:
    """AskUser tool calls as the end of the answer: one JSON line per question
    in an ``ask`` fence, after the prose already streamed."""
    lines = "\n".join(
        json.dumps({"question": q, "choices": c}, ensure_ascii=False) for q, c in asks
    )
    return f"```ask\n{lines}\n```"
