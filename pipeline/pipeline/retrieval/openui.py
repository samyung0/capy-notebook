"""OpenUI Lang answers: the subset parser and the streaming renderer.

An ordinary-chat final answer is a program of ``name = Component(args)``
statements (``prompts/openui_lang.txt``, generated from the frontend
library). The browser renders it with the official parser; this module only
needs to know which argument of each component is its ``passages`` list and
how statements nest, which ``generated/openui_library.json`` supplies. From
that it validates the program, reports the cited passages in reading order
(root first, children in argument order) and produces the plain text the
checkpoint summarizer reads.

:class:`LangRenderer` streams the program text through unchanged, minus a
code fence the model may wrap it in, and re-parses completed statements as
they arrive so the citation list can grow while the answer streams. Passage
numbers stay the model's own; the citation events carry each entry's ``n``
and the browser numbers the markers 1..k from the list order.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from importlib import resources
from typing import Any

PASSAGES = "passages"


def _load_spec() -> tuple[str, dict[str, list[str]]]:
    raw = (
        resources.files("pipeline.generated")
        .joinpath("openui_library.json")
        .read_text("utf-8")
    )
    spec = json.loads(raw)
    return spec["root"], {c["name"]: list(c["props"]) for c in spec["components"]}


ROOT_COMPONENT, COMPONENTS = _load_spec()
# The statement every program starts from; its value must be the root component.
ROOT = "root"


class ParseError(ValueError):
    """The text is not a program of the supported subset."""


@dataclass(frozen=True)
class Ref:
    name: str


@dataclass
class Call:
    name: str
    args: list[Any]

    def prop(self, prop: str) -> Any:
        names = COMPONENTS.get(self.name, [])
        if prop not in names:
            return None
        index = names.index(prop)
        return self.args[index] if index < len(self.args) else None


@dataclass
class Program:
    statements: dict[str, Any] = field(default_factory=dict)
    # True when the text ends inside a statement (still streaming).
    incomplete: bool = False


_TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<comment>//[^\n]*)
  | (?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')
  | (?P<number>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)
  | (?P<ident>[A-Za-z_$][A-Za-z0-9_]*)
  | (?P<punct>[=\[\](),])
    """,
    re.VERBOSE,
)
_STRING_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f"}


def _unquote(token: str) -> str:
    body = token[1:-1]
    try:
        return (
            json.loads('"' + body.replace('"', '\\"') + '"')
            if token[0] == "'"
            else json.loads(token)
        )
    except json.JSONDecodeError:
        return re.sub(
            r"\\(.)", lambda m: _STRING_ESCAPES.get(m.group(1), m.group(1)), body
        )


def _tokenize(text: str) -> tuple[list[tuple[str, str]], bool]:
    """Tokens and whether the text ends inside an unterminated string."""
    tokens: list[tuple[str, str]] = []
    pos = 0
    while pos < len(text):
        match = _TOKEN.match(text, pos)
        if match is None:
            if text[pos] in "\"'" and (text.find("\n", pos) == -1):
                return tokens, True
            raise ParseError(f"unexpected character {text[pos]!r} at {pos}")
        pos = match.end()
        kind = match.lastgroup or ""
        if kind in ("ws", "comment"):
            continue
        tokens.append((kind, match.group(0)))
    return tokens, False


class _Parser:
    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self, kind: str | None = None, value: str | None = None) -> str:
        token = self.peek()
        if token is None:
            raise EOFError
        if (kind and token[0] != kind) or (value and token[1] != value):
            raise ParseError(f"unexpected {token[1]!r}")
        self.pos += 1
        return token[1]

    def statement(self) -> tuple[str, Any]:
        name = self.take("ident")
        self.take("punct", "=")
        return name, self.expr()

    def expr(self) -> Any:
        kind, value = self.peek() or (None, "")
        if kind == "string":
            self.pos += 1
            return _unquote(value)
        if kind == "number":
            self.pos += 1
            return int(value) if re.fullmatch(r"-?\d+", value) else float(value)
        if kind == "punct" and value == "[":
            self.pos += 1
            items: list[Any] = []
            while True:
                if self.peek() == ("punct", "]"):
                    self.pos += 1
                    return items
                items.append(self.expr())
                if self.peek() == ("punct", ","):
                    self.pos += 1
        if kind == "ident":
            self.pos += 1
            if value in ("true", "false"):
                return value == "true"
            if value == "null":
                return None
            if self.peek() == ("punct", "("):
                self.pos += 1
                args: list[Any] = []
                while True:
                    if self.peek() == ("punct", ")"):
                        self.pos += 1
                        return Call(value, args)
                    args.append(self.expr())
                    if self.peek() == ("punct", ","):
                        self.pos += 1
            return Ref(value)
        if kind is None:
            raise EOFError
        raise ParseError(f"unexpected {value!r}")


_SPACE = re.compile(r"[ \t\r]*")
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER = re.compile(r"-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_STRING = re.compile(r'"(?:\\[\s\S]|[^"\\])*"')
_ASSIGN = re.compile(r"[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=")
_CLOSER = re.compile(r"[ \t\r]*(?:[,)\]]|$)")


def _is_statement(line: str) -> bool:
    """Does the line read as one ``name = value`` statement of strings,
    numbers, names, arrays and component calls, with commas between items?
    Mirrors ``isStatement`` in the browser's ``chat/answer.ts``."""
    at = 0

    def eat(pattern: re.Pattern[str]) -> str:
        nonlocal at
        found = pattern.match(line, at)
        if found is None:
            return ""
        at = found.end()
        return found.group(0)

    def items(close: str) -> bool:
        nonlocal at
        while True:
            eat(_SPACE)
            if line[at : at + 1] == close:
                at += 1
                return True
            if not value():
                return False
            eat(_SPACE)
            if line[at : at + 1] == ",":
                at += 1
            elif line[at : at + 1] != close:
                return False

    def value() -> bool:
        nonlocal at
        eat(_SPACE)
        if line[at : at + 1] == "[":
            at += 1
            return items("]")
        if eat(_STRING) or eat(_NUMBER):
            return True
        if not eat(_NAME):
            return False
        eat(_SPACE)
        if line[at : at + 1] != "(":
            return True
        at += 1
        return items(")")

    if not (eat(_ASSIGN) and value()):
        return False
    eat(_SPACE)
    return at == len(line)


def _escape_stray_quotes(line: str) -> str:
    """The line with a backslash before each double quote that cannot end its
    string: one not followed by ``,``, ``)``, ``]`` or the line end."""
    out: list[str] = []
    start = 0
    inside = False
    at = 0
    while at < len(line):
        if inside and line[at] == "\\":
            at += 1
        elif line[at] == '"':
            if inside and not _CLOSER.match(line, at + 1):
                out.append(line[start:at] + "\\")
                start = at
            else:
                inside = not inside
        at += 1
    return "".join(out) + line[start:]


def repair_quotes(text: str) -> str:
    """A statement that does not parse because a string holds raw double
    quotes is re-read with those quotes as literal characters (Epo 2026-10-30,
    Q587); the browser repairs alike (``repairQuotes`` in ``chat/answer.ts``).
    A statement that parses never changes, since each of its strings ends
    before ``,``, ``)``, ``]`` or the line end, and one the re-read does not
    fix stays as written. Stored answers keep their text; every parse
    repairs."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        fixed = _escape_stray_quotes(line)
        if fixed != line and _is_statement(fixed):
            lines[index] = fixed
    return "\n".join(lines)


def parse(text: str, *, strict: bool = False) -> Program:
    """The statements of ``text`` after :func:`repair_quotes`. Non-strict
    parsing stops at a trailing partial statement; strict parsing raises
    :class:`ParseError` on any malformed or unfinished input."""
    tokens, open_string = _tokenize(repair_quotes(text))
    if open_string and strict:
        raise ParseError("unterminated string")
    parser = _Parser(tokens)
    program = Program()
    while parser.peek() is not None:
        start = parser.pos
        try:
            name, value = parser.statement()
        except EOFError:
            if strict:
                raise ParseError("unfinished statement") from None
            parser.pos = start
            break
        program.statements[name] = value
    program.incomplete = open_string or parser.pos < len(tokens)
    return program


def is_lang_shaped(text: str) -> bool:
    """Does the text start like a program (optionally inside a code fence)?"""
    return bool(re.match(r"\s*(```[\w-]*\s*\n)?\s*[A-Za-z_]\w*\s*=", text))


def _calls_in(value: Any) -> Iterator[Call]:
    """Every component call nested in a statement value, in argument order."""
    if isinstance(value, Call):
        yield value
        for arg in value.args:
            yield from _calls_in(arg)
    elif isinstance(value, list):
        for item in value:
            yield from _calls_in(item)


def walk(program: Program, start: str = ROOT) -> Iterator[Call]:
    """Component calls reachable from the root, in reading order."""
    seen: set[str] = set()

    def visit(value: Any) -> Iterator[Call]:
        if isinstance(value, Ref):
            if value.name in seen or value.name not in program.statements:
                return
            seen.add(value.name)
            yield from visit(program.statements[value.name])
        elif isinstance(value, Call):
            yield value
            for arg in value.args:
                yield from visit(arg)
        elif isinstance(value, list):
            for item in value:
                yield from visit(item)

    yield from visit(Ref(start))


def _is_passage_number(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _passages(call: Call, known: int) -> list[int]:
    value = call.prop(PASSAGES)
    if not isinstance(value, list):
        return []
    return [n for n in value if _is_passage_number(n) and 1 <= n <= known]


def _first_seen(calls: Iterator[Call], known: int) -> list[int]:
    order: list[int] = []
    for call in calls:
        for n in _passages(call, known):
            if n not in order:
                order.append(n)
    return order


def cited_in_reading_order(program: Program, known: int) -> list[int]:
    return _first_seen(walk(program), known)


def cited_in_statement_order(program: Program, known: int) -> list[int]:
    calls = (call for value in program.statements.values() for call in _calls_in(value))
    return _first_seen(calls, known)


def validate(program: Program) -> str | None:
    """Why the program cannot render, or None."""
    if ROOT not in program.statements:
        return "no root statement"
    root = program.statements[ROOT]
    if not isinstance(root, Call) or root.name != ROOT_COMPONENT:
        return f"root is not {ROOT_COMPONENT}(...)"
    for value in program.statements.values():
        for call in _calls_in(value):
            if call.name not in COMPONENTS:
                return f"unknown component {call.name}"
            passages = call.prop(PASSAGES)
            if passages is not None and (
                not isinstance(passages, list)
                or not all(_is_passage_number(n) for n in passages)
            ):
                return f"{call.name} passages must be a list of integers"
    for call in walk(program):
        for arg in call.args:
            for ref in _refs_in(arg):
                if ref.name not in program.statements:
                    return f"unresolved reference {ref.name}"
    return None


def _refs_in(value: Any) -> Iterator[Ref]:
    if isinstance(value, Ref):
        yield value
    elif isinstance(value, Call):
        for arg in value.args:
            yield from _refs_in(arg)
    elif isinstance(value, list):
        for item in value:
            yield from _refs_in(item)


# Enum-valued arguments are presentation, not content; an HTML embed's html is
# code, summarized by its title.
_SKIPPED_PROPS = {
    "Callout": "kind",
    "Chart": "kind",
    "Plot": "kind",
    "RefLine": "axis",
    "HtmlEmbed": "html",
}


def to_text(program: Program) -> str:
    """Answer text and chart measurements in reading order, for summaries."""
    lines: list[str] = []

    def resolve(value: Any) -> Any:
        seen: set[str] = set()
        while isinstance(value, Ref):
            if value.name in seen:
                return None
            seen.add(value.name)
            value = program.statements.get(value.name)
        return value

    for call in walk(program):
        names = COMPONENTS.get(call.name, [])
        for index, arg in enumerate(call.args):
            if index < len(names) and names[index] == _SKIPPED_PROPS.get(call.name):
                continue
            arg = resolve(arg)
            if isinstance(arg, str) and arg.strip():
                lines.append(arg.strip())
            elif (
                index < len(names)
                and call.name in ("Point", "RefLine")
                and names[index] in ("x", "y", "value")
                and isinstance(arg, (int, float))
                and not isinstance(arg, bool)
            ):
                lines.append(f"{names[index]}: {arg}")
            elif (
                call.name == "Series"
                and index < len(names)
                and names[index] == "values"
                and isinstance(arg, list)
                and all(
                    isinstance(n, (int, float)) and not isinstance(n, bool) for n in arg
                )
            ) or (
                call.name == "Curve"
                and index < len(names)
                and names[index] == "points"
                and isinstance(arg, list)
            ):
                lines.append(json.dumps(arg, ensure_ascii=False))
            elif isinstance(arg, list) and arg and all(isinstance(x, str) for x in arg):
                lines.append(" · ".join(x.strip() for x in arg))
    return "\n".join(lines)


def text_of(answer: str) -> str:
    """Plain text for a stored answer: the program's strings, or the answer
    itself when it is not a program (older prose answers)."""
    if not is_lang_shaped(answer):
        return answer
    try:
        return to_text(parse(answer, strict=True)) or answer
    except ParseError:
        return answer


_ROOT_HEAD = re.compile(r"(?m)^[ \t]*root\s*=\s*Answer\s*\(")
_BARE_ANSWER = re.compile(r"(?<!\w)Answer\s*\(\s*\[")


def with_root(text: str) -> str:
    """The first ``Answer([...])`` is the root when no statement names it
    (Epo 2026-10-25): GLM writes the call bare, alone or glued to prose.
    ``root = `` goes on its own line before it; prose before it stays the
    Markdown preface."""
    if _ROOT_HEAD.search(text):
        return text
    bare = _BARE_ANSWER.search(text)
    if bare is None:
        return text
    head = text[: bare.start()].rstrip()
    if head.endswith("="):
        # Assigned to another name: not a bare root call.
        return text
    return (head + "\n\n" if head else "") + "root = " + text[bare.start() :]


def _source(value: Any) -> str:
    """A parsed value written back as program text."""
    if isinstance(value, Ref):
        return value.name
    if isinstance(value, Call):
        return f"{value.name}({', '.join(_source(arg) for arg in value.args)})"
    if isinstance(value, list):
        return f"[{', '.join(_source(item) for item in value)}]"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return json.dumps(value, ensure_ascii=False)


def asks_line(program: Program) -> str:
    """A root line that also lists the AskUser statements root never reaches,
    or "" when there are none (Epo 2026-10-29): a model that defines its
    questions but leaves them out of root still asks them. Both parsers take
    the later root."""
    root = program.statements.get(ROOT)
    if not (isinstance(root, Call) and root.args and isinstance(root.args[0], list)):
        return ""
    reached = {id(call) for call in walk(program)}
    asks = [
        Ref(name)
        for name, value in program.statements.items()
        if isinstance(value, Call)
        and value.name == "AskUser"
        and id(value) not in reached
    ]
    if not asks:
        return ""
    return f"{ROOT} = {_source(Call(root.name, [root.args[0] + asks, *root.args[1:]]))}"


def _inside_string(text: str) -> bool:
    """Does the text end inside a string literal? A prefix that does not
    tokenize is treated as inside one, so a fence there never closes it."""
    try:
        return _tokenize(repair_quotes(text))[1]
    except ParseError:
        return True


_FENCE_LINE = re.compile(r"`{3,}[\w-]*[ \t]*\n")
# The closing fence and anything the model added after it.
_CLOSING_FENCE = re.compile(r"\s*`{3,}[\s\S]*$")
_PARTIAL_TAIL = re.compile(r"\s*`*$")


class LangRenderer:
    """Stream the answer program through, dropping a wrapping code fence.

    ``answer_shaped`` is None until the first statement head is seen; True
    when the text is a program (streamed as it arrives), False when it is
    plain prose (held back until the caller knows whether it is narration or
    a Markdown answer). ``order`` is the cited passages in statement order so far;
    :meth:`reading_order` is the final list once :meth:`finish` parsed the
    whole program. ``invalid`` is set by :meth:`finish` when the completed text
    does not validate; ``complete`` when it does.
    """

    def __init__(self, known: Callable[[], int]):
        self.known = known
        self.raw = ""
        self.text = ""
        self.answer_shaped: bool | None = None
        self.complete = False
        self.invalid = False
        # Set by finish when it appended asks_line.
        self.asks_added = False
        self.order: list[int] = []
        self.program: Program | None = None
        self._held = ""
        self._tail = ""
        self._parsed_upto = 0
        # Set once an opening fence was stripped; a closing fence then ends
        # the program and anything after it is dropped.
        self._fenced = False
        self._closed = False

    def push(self, delta: str) -> str:
        self.raw += delta
        if self.answer_shaped is not None:
            return self._emit(delta) if self.answer_shaped else ""
        self._held += delta
        body = self._held.lstrip()
        if not body:
            return ""
        if body.startswith("`"):
            fence = _FENCE_LINE.match(body)
            if fence is None:
                if "\n" in body:
                    self.answer_shaped = False
                return ""
            self._fenced = True
            self._held = body[fence.end() :]
            body = self._held.lstrip()
            if not body:
                return ""
        if re.match(r"[A-Za-z_]\w*\s*=", body):
            self.answer_shaped = True
            self._held = ""
            return self._emit(body)
        if re.fullmatch(r"[A-Za-z_]\w*\s*", body):
            return ""
        self.answer_shaped = False
        return ""

    def _emit(self, delta: str) -> str:
        if self._closed:
            return ""
        buffer = self._tail + delta
        if self._fenced:
            for closing in re.finditer(r"(?m)^`{3,}[ \t]*(?=\n|$)", buffer):
                if closing.end() < len(buffer) and not _inside_string(
                    self.text + buffer[: closing.start()]
                ):
                    # An inner Markdown fence cannot hide a later closing fence
                    # arriving in the same provider chunk.
                    self._closed = True
                    buffer = buffer[: closing.start()]
                    break
        # Hold back a trailing backtick run: it may be the closing fence.
        cut = _PARTIAL_TAIL.search(buffer)
        keep = buffer[: cut.start()] if cut and cut.group(0) else buffer
        self._tail = buffer[len(keep) :]
        if not keep:
            return ""
        self.text += keep
        self._track()
        return keep

    def _track(self) -> None:
        end = self.text.rfind("\n")
        if end <= self._parsed_upto:
            return
        self._parsed_upto = end
        try:
            program = parse(self.text[: end + 1])
        except ParseError:
            return
        for n in cited_in_statement_order(program, self.known()):
            if n not in self.order:
                self.order.append(n)

    def finish(self) -> str:
        """Flush held text minus a closing fence; parse and validate the whole."""
        if self.answer_shaped is None:
            self.answer_shaped = is_lang_shaped(self._held)
            if self.answer_shaped:
                self._held = ""
        tail = ""
        if not self.answer_shaped:
            self.raw = with_root(self.raw)
            start = _ROOT_HEAD.search(self.raw)
            if start:
                # Preserve the preface as Markdown, but recover the program's
                # citations locally so the browser can render both parts.
                recovered = LangRenderer(self.known)
                fence = re.search(r"`{3,}[\w-]*[ \t]*\n\s*$", self.raw[: start.start()])
                offset = fence.start() if fence else start.start()
                recovered.push(self.raw[offset:])
                recovered.finish()
                if recovered.asks_added:
                    # The repaired program replaces the fenced one; prose stays.
                    preface = self.raw[:offset].rstrip()
                    self.raw = (preface + "\n\n" if preface else "") + recovered.text
                self.program = recovered.program
                self.order = recovered.order
        if self.answer_shaped:
            fence = _CLOSING_FENCE.search(self._tail)
            if fence:
                # Drop the closing fence and any afterword; keep the newline
                # that ended the program.
                tail = re.match(r"\s*", self._tail).group(0)  # type: ignore[union-attr]
            else:
                tail = self._tail
            self._tail = ""
            if tail:
                self.text += tail
            try:
                self.program = parse(self.text, strict=True)
                problem = validate(self.program)
            except ParseError as exc:
                self.program = None
                problem = str(exc)
            self.invalid = problem is not None
            self.complete = not self.invalid
            line = asks_line(self.program) if self.complete and self.program else ""
            if line:
                added = ("" if self.text.endswith("\n") else "\n") + line + "\n"
                self.text += added
                tail += added
                self.asks_added = True
                self.program = parse(self.text, strict=True)
            if self.program is not None:
                for n in cited_in_statement_order(self.program, self.known()):
                    if n not in self.order:
                        self.order.append(n)
        return tail

    def reading_order(self) -> list[int]:
        """Cited passages in reading order; the stream order until finish."""
        if self.program is None:
            return list(self.order)
        return cited_in_reading_order(self.program, self.known())
