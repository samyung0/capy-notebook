"""Answer-side citation handling for the playground.

as_is       production: [n] markers point at the numbers passages were shown with,
            so an answer can read "[1][6]" with nothing in between.
renumber    rewrite markers to [1], [2], ... in order of first appearance while the
            answer streams; the final citation list holds only the passages used.
structured  the answer is a JSON list of claims, each naming the passages that
            ground it; the playground writes the prose and numbers citations itself.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

MARKER = re.compile(r"\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]")
# A marker cut by a stream boundary: "[", "[1", "[1, ". Held back until it closes.
PARTIAL = re.compile(r"\[[\d,\s]*$")
FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")

STRUCTURED_ADDON = (
    "\n- Final answer format: a response that calls no tools is the final answer and "
    'must be only a JSON object {"answer": [{"text": "...", "passages": [n, ...]}, ...]}. '
    "Each item is one claim or short paragraph of Markdown in reading order. passages "
    "lists the numbers of the shown passages that support that item, most direct first, "
    "or [] when the sources do not cover it. Put no [n] markers inside text. Text that "
    "accompanies a tool call stays plain prose."
)
REPAIR_PROMPT = (
    "Rewrite your previous reply as the required JSON object with exactly the same "
    "content and passage numbers. Output only the JSON."
)


class Renumberer:
    """Original passage number -> 1..k in first-appearance order, stream-safe."""

    def __init__(self, known: Callable[[], int]):
        self.known = known
        self.order: list[int] = []
        self.pending = ""

    def number(self, original: int) -> int:
        if original not in self.order:
            self.order.append(original)
        return self.order.index(original) + 1

    def rewrite(self, text: str) -> str:
        def sub(match: re.Match[str]) -> str:
            nums = [int(x) for x in match.group(1).split(",")]
            valid = [n for n in nums if 1 <= n <= self.known()]
            if len(valid) != len(nums):
                return match.group(0)
            return "".join(f"[{self.number(n)}]" for n in valid)

        return MARKER.sub(sub, text)

    def push(self, delta: str) -> str:
        text = self.pending + delta
        cut = PARTIAL.search(text)
        if cut:
            self.pending, text = text[cut.start() :], text[: cut.start()]
        else:
            self.pending = ""
        return self.rewrite(text)

    def flush(self) -> str:
        out, self.pending = self.rewrite(self.pending), ""
        return out


def renumber(text: str, known: int) -> tuple[str, list[int]]:
    r = Renumberer(lambda: known)
    out = r.push(text) + r.flush()
    return out, r.order


def parse_structured(raw: str) -> list[dict] | None:
    try:
        obj = json.loads(FENCE.sub("", raw.strip()))
    except json.JSONDecodeError:
        return None
    items = obj.get("answer") if isinstance(obj, dict) else None
    if not isinstance(items, list) or not items:
        return None
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            return None
        if not all(isinstance(n, int) for n in item.get("passages", [])):
            return None
    return items


def render_structured(items: list[dict], known: int) -> tuple[str, list[int]]:
    """Prose with our own [k] markers appended per claim, plus the passage order."""
    r = Renumberer(lambda: known)
    parts = []
    for item in items:
        # A stray [n] inside the prose is renumbered with the same map rather than
        # left pointing at the original numbering.
        text = r.rewrite(item["text"].strip())
        marks = "".join(
            f"[{r.number(n)}]" for n in item.get("passages", []) if 1 <= n <= known
        )
        parts.append(f"{text} {marks}".strip() if marks else text)
    return "\n\n".join(p for p in parts if p), r.order


def check() -> None:
    text, order = renumber("A [6]. B [1][6]. C [1, 3] D [9]", 6)
    assert text == "A [1]. B [2][1]. C [2][3] D [9]" and order == [6, 1, 3], (
        text,
        order,
    )
    r = Renumberer(lambda: 6)
    streamed = (
        "".join(r.push(d) for d in ["see [", "6] and [1", ", 3] then [2", "]"])
        + r.flush()
    )
    assert streamed == "see [1] and [2][3] then [4]", streamed
    assert Renumberer(lambda: 6).push("[") == "" and Renumberer(lambda: 6).flush() == ""
    items = parse_structured(
        '```json\n{"answer":[{"text":"SD is 0.0033.","passages":[6,1]},{"text":"Not covered.","passages":[]}]}\n```'
    )
    assert items and len(items) == 2
    prose, order = render_structured(items, 6)
    assert prose == "SD is 0.0033. [1][2]\n\nNot covered." and order == [6, 1], (
        prose,
        order,
    )
    prose, order = render_structured([{"text": "stray [3] marker", "passages": [6]}], 6)
    assert prose == "stray [1] marker [2]" and order == [3, 6], (prose, order)
    for bad in (
        "not json",
        '{"answer": "text"}',
        '{"answer": [{"text": 1}]}',
        '{"answer": [{"text": "x", "passages": ["1"]}]}',
    ):
        assert parse_structured(bad) is None, bad
    print("citation checks passed")


if __name__ == "__main__":
    check()
