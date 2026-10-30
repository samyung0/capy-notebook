"""The Markdown answer format (prompts/answer_markdown.txt), the alternative to
the OpenUI Lang program (``openui.py``) the playground compares it against.

The answer is Markdown with ``[#n]`` citation markers, figure fences (chart,
plot, mermaid, html-embed) and a trailing ``ask`` fence for AskUser questions;
the browser renders it (MarkdownAnswer.tsx). Nothing here can fail to parse:
the text streams through as written and only the markers are read.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

OPENUI = "openui"
MARKDOWN = "markdown"
FORMATS = (OPENUI, MARKDOWN)

# [#2] or [#2,5]: the shown passages behind the text before it.
MARKER = re.compile(r"\[#(\d+(?:\s*,\s*\d+)*)\]")


def cited(text: str, known: int) -> list[int]:
    """Passage numbers in first-seen order, those not shown dropped."""
    order: list[int] = []
    for marker in MARKER.finditer(text):
        for part in marker.group(1).split(","):
            n = int(part)
            if 1 <= n <= known and n not in order:
                order.append(n)
    return order


class MarkdownRenderer:
    """``openui.LangRenderer``'s interface for a Markdown answer: every delta
    is answer text, and ``order`` grows as markers complete."""

    def __init__(self, known: Callable[[], int]):
        self.known = known
        self.raw = ""
        self.text = ""
        self.answer_shaped = True
        self.complete = False
        self.invalid = False
        self.asks_added = False
        self.program = None
        self.order: list[int] = []

    def push(self, delta: str) -> str:
        self.raw += delta
        self.text += delta
        for n in cited(self.text, self.known()):
            if n not in self.order:
                self.order.append(n)
        return delta

    def finish(self) -> str:
        self.complete = True
        return ""

    def reading_order(self) -> list[int]:
        return cited(self.text, self.known())


def ask_fence(asks: list[tuple[str, list[str]]]) -> str:
    """AskUser tool calls as the end of the answer: one JSON line per question
    in an ``ask`` fence, after the prose already streamed."""
    lines = "\n".join(
        json.dumps({"question": q, "choices": c}, ensure_ascii=False) for q, c in asks
    )
    return f"```ask\n{lines}\n```"
