"""Structured final answers: claims that name the passages grounding them.

The model's last response is ``{"answer": [{"text": "...", "passages": [n, ...]}, ...]}``
where ``n`` are the numbers passages were shown with. The agent writes the
prose itself: claims joined by blank lines, each followed by ``[k]`` markers
numbered 1..k in order of first appearance, so the user never sees a gap and
the persisted citation list holds only the passages the answer used.

:class:`StreamRenderer` does the same work on the token stream so the prose
still streams: claim text is emitted as it arrives and the markers are
appended when the claim's ``passages`` array closes. The raw JSON never reaches
the browser.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable

MARKER = re.compile(r"\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]")
# A marker cut by a stream boundary: "[", "[1", "[1, ". Held back until it closes.
PARTIAL = re.compile(r"\[[\d,\s]*$")
FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")

JSON_OBJECT = {"type": "json_object"}


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


def passage_number(value: object) -> int | None:
    """A passage entry: an integer, or the digit string a model sometimes
    quotes (``"2"``). Anything else (``2.0``, ``true``, ``"x"``) is invalid;
    the streaming renderer applies the same rule to its tokens."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def parse_structured(raw: str) -> list[dict] | None:
    try:
        obj = json.loads(FENCE.sub("", raw.strip()))
    except json.JSONDecodeError:
        return None
    items = obj.get("answer") if isinstance(obj, dict) else None
    if not isinstance(items, list) or not items:
        return None
    parsed = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            return None
        passages = item.get("passages", [])
        if not isinstance(passages, list):
            return None
        numbers = [passage_number(n) for n in passages]
        if any(n is None for n in numbers):
            return None
        parsed.append({**item, "passages": numbers})
    return parsed


def render_structured(items: list[dict], known: int) -> tuple[str, list[int]]:
    """Prose with our own [k] markers appended per claim, plus the passage order."""
    r = Renumberer(lambda: known)
    parts = []
    for item in items:
        # A stray [n] inside the prose is renumbered with the same map rather
        # than left pointing at the original numbering.
        text = r.rewrite(item["text"].strip())
        marks = "".join(
            f"[{r.number(n)}]" for n in item.get("passages", []) if 1 <= n <= known
        )
        parts.append(f"{text} {marks}".strip() if marks else text)
    return "\n\n".join(p for p in parts if p), r.order


class PlainRenderer:
    """Pass-through renderer for a mode whose answer is prose, not claims.

    Curate turns cite nothing (attribution lives on the created materials), so
    the deltas stream as they arrive and ``order`` stays empty. It presents the
    same surface as :class:`StreamRenderer` so the agent loop has one path.
    """

    def __init__(self) -> None:
        self.raw = ""
        self.text = ""
        self.json_shaped = True
        self.complete = True
        self.invalid = False
        self.order: list[int] = []

    def push(self, delta: str) -> str:
        self.raw += delta
        self.text += delta
        return delta

    def finish(self) -> str:
        return ""


_ESCAPES = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
}


class StreamRenderer:
    """Turn the streamed JSON answer into prose deltas, claim by claim.

    The output of ``push``/``finish`` concatenated equals
    :func:`render_structured` of the parsed object, so the persisted answer is
    what the browser streamed. ``json_shaped`` is False when the first
    non-space character is not ``{`` (or a code fence): the model answered in
    plain prose and the caller falls back to a repair call. ``invalid`` is set
    on an invalid passage entry or a completed object rejected by
    :func:`parse_structured`; the caller replaces the prose with a repair.
    """

    def __init__(self, known: Callable[[], int]):
        self.renumberer = Renumberer(known)
        self.known = known
        self.raw = ""
        self.text = ""
        self.json_shaped: bool | None = None
        self.complete = False
        self.invalid = False
        self._state = "prefix"
        self._depth = 0
        self._key = ""
        self._after_key = False
        self._in_text = False
        self._text_escape = ""
        self._leading = True
        self._claim_started = False
        self._claim_emitted = False
        self._marks: list[int] | None = None
        self._passages_buffer = ""
        self._item_text_done = False
        self._pending_marks: list[int] = []
        self._holdback = ""
        self._fence = ""

    # -- public ---------------------------------------------------------

    def push(self, delta: str) -> str:
        self.raw += delta
        out: list[str] = []
        for ch in delta:
            out.append(self._feed(ch))
        return "".join(out)

    def finish(self) -> str:
        """Flush held-back text; ``complete`` says whether the object closed."""
        if self.complete and parse_structured(self.raw) is None:
            self.invalid = True
        if self.invalid:
            return ""
        if self._in_text:
            return ""
        tail = ""
        if self._claim_started and not self._item_text_done:
            tail += self._finish_claim_text()
        return tail

    @property
    def order(self) -> list[int]:
        return self.renumberer.order

    # -- internals ------------------------------------------------------

    def _emit(self, text: str) -> str:
        self.text += text
        return text

    def _feed(self, ch: str) -> str:
        if self.invalid:
            return ""
        if self._state == "prefix":
            if ch.isspace():
                return ""
            if ch == "`":
                self._fence += ch
                return ""
            if self._fence:
                # Inside a ```json fence: skip the language tag until the brace.
                if ch == "{":
                    self._fence = ""
                else:
                    return ""
            if ch != "{":
                self.json_shaped = False
                self._state = "prose"
                return ""
            self.json_shaped = True
            self._state = "object"
            self._depth = 1
            return ""
        if self._state == "prose":
            return ""
        if self._state == "done":
            return ""
        if self._in_text:
            return self._feed_text(ch)
        if self._state == "key":
            if ch == '"' and not self._text_escape:
                self._state = "object"
                self._after_key = True
                return ""
            if self._text_escape:
                self._text_escape = ""
            elif ch == "\\":
                self._text_escape = "\\"
            else:
                self._key += ch
            return ""
        if self._state == "passages":
            return self._feed_passages(ch)
        if self._state == "string":
            # A string value we do not render (unknown key).
            if self._text_escape:
                self._text_escape = ""
            elif ch == "\\":
                self._text_escape = "\\"
            elif ch == '"':
                self._state = "object"
            return ""
        # state == "object": structural characters between values
        if ch == '"':
            if self._after_key and self._key:
                # A string value: render only "text" inside an answer item.
                self._after_key = False
                if self._key == "text" and self._depth == 3:
                    self._start_text()
                    self._key = ""
                    return ""
                self._key = ""
                self._state = "string"
                return ""
            self._key = ""
            self._after_key = False
            self._state = "key"
            return ""
        if ch == ":":
            return ""
        if ch == "[":
            if self._after_key and self._key == "passages" and self._depth == 3:
                self._after_key = False
                self._key = ""
                self._marks = []
                self._passages_buffer = ""
                self._state = "passages"
                return ""
            self._after_key = False
            self._key = ""
            self._depth += 1
            return ""
        if ch == "{":
            self._after_key = False
            self._key = ""
            self._depth += 1
            if self._depth == 3:
                self._begin_item()
            return ""
        if ch in "}]":
            out = ""
            if ch == "}" and self._depth == 3:
                out = self._end_item()
            self._depth -= 1
            if self._depth == 0:
                self._state = "done"
                self.complete = True
            return out
        return ""

    def _begin_item(self) -> None:
        self._claim_started = False
        self._claim_emitted = False
        self._item_text_done = False
        self._pending_marks = []
        self._holdback = ""

    def _end_item(self) -> str:
        out = ""
        if self._claim_started and not self._item_text_done:
            out += self._finish_claim_text()
        if self._item_text_done and self._pending_marks:
            out += self._emit_marks(self._pending_marks)
            self._pending_marks = []
        return out

    def _start_text(self) -> None:
        self._in_text = True
        self._text_escape = ""
        self._claim_started = True
        self._leading = True
        self._holdback = ""

    def _feed_text(self, ch: str) -> str:
        if self._text_escape:
            self._text_escape += ch
            if self._text_escape[1] == "u":
                if len(self._text_escape) < 6:
                    return ""
                try:
                    decoded = chr(int(self._text_escape[-4:], 16))
                except ValueError:
                    decoded = ""
                self._text_escape = ""
                return self._text_chunk(decoded)
            decoded = _ESCAPES.get(self._text_escape[1], self._text_escape[1])
            self._text_escape = ""
            return self._text_chunk(decoded)
        if ch == "\\":
            self._text_escape = "\\"
            return ""
        if ch == '"':
            self._in_text = False
            self._state = "object"
            return self._finish_claim_text()
        return self._text_chunk(ch)

    def _text_chunk(self, piece: str) -> str:
        # Mirror ``item["text"].strip()``: drop leading whitespace, hold back
        # trailing whitespace until more text proves it is interior.
        if self._leading:
            piece = piece.lstrip()
            if not piece:
                return ""
            self._leading = False
            # The claim separator goes out with the first real character.
            prefix = "\n\n" if self.text else ""
            self._claim_emitted = True
            return self._emit(prefix) + self._emit_text(piece)
        return self._emit_text(piece)

    def _emit_text(self, piece: str) -> str:
        text = self._holdback + piece
        stripped = text.rstrip()
        self._holdback = text[len(stripped) :]
        return self._emit(self.renumberer.push(stripped))

    def _finish_claim_text(self) -> str:
        self._item_text_done = True
        self._holdback = ""
        out = self._emit(self.renumberer.flush())
        if self._marks is None and self._pending_marks:
            out += self._emit_marks(self._pending_marks)
            self._pending_marks = []
        return out

    def _feed_passages(self, ch: str) -> str:
        if ch == "]":
            if self._passages_buffer.strip():
                self._add_passage(self._passages_buffer)
            elif self._marks:
                self.invalid = True  # trailing comma
            marks = self._marks or []
            self._marks = None
            self._state = "object"
            if self.invalid:
                return ""
            if self._item_text_done:
                return self._emit_marks(marks)
            self._pending_marks = marks
            return ""
        if ch == ",":
            self._add_passage(self._passages_buffer)
            self._passages_buffer = ""
            return ""
        self._passages_buffer += ch
        return ""

    def _add_passage(self, token: str) -> None:
        token = token.strip()
        quoted = len(token) >= 2 and token[0] == token[-1] == '"'
        number = passage_number(token[1:-1] if quoted else token)
        if number is None or (not quoted and not token.isdigit()):
            self.invalid = True
            return
        if self._marks is not None:
            self._marks.append(number)

    def _emit_marks(self, numbers: list[int]) -> str:
        known = self.known()
        marks = "".join(
            f"[{self.renumberer.number(n)}]" for n in numbers if 1 <= n <= known
        )
        if not marks:
            return ""
        # ``f"{text} {marks}".strip()``: a claim with empty text carries bare
        # marks as its own paragraph.
        if self._claim_emitted:
            return self._emit(" " + marks)
        self._claim_emitted = True
        return self._emit(("\n\n" if self.text else "") + marks)
