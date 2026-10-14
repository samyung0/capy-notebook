"""Agent-written quiz questions (Epo 2026-10-13; one tool for every kind
since 2026-10-14).

The chat agent never writes the question format itself
(openwiki/question-bank.md, Shared question format). It writes three small
shapes, the fields telling them apart:

- multiple choice: question, options, correct (one option, copied exactly),
  explanation?
- short answer: question, accepted, unit? (accepted then holds plain numbers),
  explanation?
- open: question, marks, markscheme [{text, marks}] adding up to marks,
  model_answer, hints?, explanation?

add_questions takes a list of them, and add_question_media puts a chart or
plot after one question's text. A note's ```quiz fence holds a YAML list of
the same items.

Every problem of a call is named at once, with its path, what was expected and
what was sent; a structural mistake also gets the shape to copy. add_questions
saves the valid questions of a call and names only the rest.

Blank fields (null, blank text, "null", [] or {}) are left out before
checking unless the question's kind needs them, and an accepted answer written
with its unit ("5%" with unit "%") keeps the number (Epo 2026-10-13: leniency
the agent need not be told about). The server fills the rest: ids, one part
per question, 1 mark for a simple question, multiple-choice options in an
order shuffled by the question id (the model tends to put the answer first),
layout paper, labels letters, and the worked solution from the
explanation (empty without one: a quiz part's solution may be empty, only bank
parts need one). The gateway routes and Go's validator take the expanded
questions unchanged.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import random
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import yaml
from jsonschema import Draft202012Validator, ValidationError

from . import contract, embeds


def _schema(name: str) -> dict[str, Any]:
    return contract.DEFINITIONS[name]["inputSchema"]


_ADD = Draft202012Validator(_schema("add_questions"))
_MEDIA_TOOL = Draft202012Validator(_schema("add_question_media"))
_MEDIA = {
    kind: Draft202012Validator(schema) for kind, schema in contract.MEDIA_BLOCKS.items()
}

# The fields each kind takes, and the ones it needs beyond the question.
FIELDS = {
    "mcq": {"question", "options", "correct", "explanation", "replaces"},
    "short": {"question", "accepted", "unit", "explanation", "replaces"},
    "open": {
        "question",
        "marks",
        "markscheme",
        "model_answer",
        "hints",
        "explanation",
        "replaces",
    },
}
NEEDS = {
    "mcq": ("options", "correct"),
    "short": ("accepted",),
    "open": ("marks", "markscheme", "model_answer"),
}
# Each kind's check: the add_questions item narrowed to the kind's fields, so
# another kind's field is named as unknown with what to do instead.
_ITEM = _schema("add_questions")["properties"]["questions"]["items"]
_KINDS = {
    kind: Draft202012Validator(
        {
            **_ITEM,
            "properties": {k: v for k, v in _ITEM["properties"].items() if k in fields},
            "required": ["question", *NEEDS[kind]],
        }
    )
    for kind, fields in FIELDS.items()
}
SHAPES = {
    "mcq": 'A multiple-choice question: {"question": "…", "options": ["…", "…"], '
    '"correct": "<one of the options, copied exactly>", "explanation": "…"}',
    "short": 'A short answer: {"question": "…", "accepted": ["…"], "unit": "<only for '
    'a quantity; accepted then holds plain numbers>", "explanation": "…"}',
    "open": 'An open question: {"question": "…", "marks": 2, "markscheme": [{"text": '
    '"…", "marks": 1}, {"text": "…", "marks": 1}], "model_answer": "…", '
    '"hints": ["…"], "explanation": "…"}',
}
# What a missing field should have held.
EXPECTED = {
    "question": "the question text",
    "options": "a list of 2 or more options",
    "correct": "the one correct option, copied exactly from options",
    "accepted": "a list of accepted answers",
    "marks": "a whole number of marks from 1 to 20",
    "markscheme": 'a list of {"text", "marks"} items whose marks add up to marks',
    "model_answer": "a full-marks answer",
    "text": "what earns the marks",
    "quiz_id": "the id of the quiz to add to (add_questions' result gives a new quiz's id)",
    "question_id": "the question's id",
    "media": "a chart or plot block",
}
# Fields the server fills: the old question format's.
SERVER_FILLED = {"id", "stem", "parts", "layout", "labels", "level", "points"}
# Fields that try to put a figure in a question: the catalog's question-block
# kinds and the other names a model reaches for.
MEDIA_KEYS = {"media", "image", "figure", "table", *embeds.QUESTION_BLOCK_KINDS}

# A value with a unit: a number or a fraction (questions.quantityPattern).
_NUMBER = r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?"
QUANTITY = re.compile(rf"^{_NUMBER}(?:\s*/\s*{_NUMBER})?$")
FIGURE = re.compile(r"!\[[^\]]*\]\(\s*<?figure:")


def question_id(message_id: str, call_id: str, n: int) -> str:
    """The id of a call's n-th new question: derived from the call, so a
    retried call sends the same questions."""
    digest = hashlib.sha256(f"{message_id}\n{call_id}\n{n}".encode()).hexdigest()
    return "q_" + digest[:10]


def _sent(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 80 else text[:77] + "…"


def _at(base: str, parts: Any) -> str:
    out = base
    for part in parts:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out += f".{part}" if out else str(part)
    return out


_TYPES = {
    "string": "text",
    "array": "a list",
    "object": "an object",
    "integer": "a whole number",
    "number": "a number",
    "boolean": "true or false",
}


def _expected_type(schema: dict[str, Any]) -> str:
    if "enum" in schema:
        return "one of " + ", ".join(json.dumps(v) for v in schema["enum"])
    if "const" in schema:
        return json.dumps(schema["const"])
    kind = schema.get("type")
    words = _TYPES.get(kind, str(kind)) if isinstance(kind, str) else "a value"
    items = schema.get("items")
    if kind == "array" and isinstance(items, dict) and items.get("type") == "string":
        words = "a list of texts"
    if kind == "integer" and "minimum" in schema and "maximum" in schema:
        words += f" from {schema['minimum']} to {schema['maximum']}"
    return words


def _unknown(path: str, key: str, value: Any, kind: str | None, *, fence: bool) -> str:
    """A field the shape does not take, with what to do instead. A field sent
    as null is one the model meant to leave empty."""
    hint = (
        "leave out a field that does not apply"
        if value is None
        else _hint(key, kind, fence=fence)
    )
    return f"{_at(path, [key])}: unknown field, sent {_sent(value)}" + (
        f"; {hint}" if hint else ""
    )


def _hint(key: str, kind: str | None, *, fence: bool) -> str:
    """Why a field does not belong, and what does."""
    if key in ("fixedUnit", "fixed_unit", "units"):
        return "the field is unit"
    if key == "solution":
        return "the field is explanation"
    if key in ("prompt", "text", "stem_text"):
        return "the field is question"
    if key in SERVER_FILLED:
        return "the server fills it; send only the fields of the shape"
    if key in MEDIA_KEYS:
        return (
            "add a chart or plot with add_question_media once the question "
            "is added; library figures go into notes only"
        )
    if key == "type":
        return "the fields say the kind; drop type"
    if key in ("title", "chapter_id"):
        return "title and chapter_id go on the call, not on a question"
    if key == "replaces":
        return (
            "a quiz fence writes new questions; rewrite one with add_questions"
            if fence
            else ""
        )
    if kind == "open":
        if key in ("options", "correct"):
            return (
                "an open question has no options; multiple choice is its own "
                "question, worth 1 mark"
            )
        if key == "accepted":
            return "an open question's full-marks answer is model_answer"
        if key == "unit":
            return "an open question has no unit; a quantity is a short answer"
        if key == "answer":
            return "the field is model_answer"
        return ""
    if key == "answer":
        return (
            "multiple choice names its answer in correct; a short answer lists accepted"
        )
    if key == "markscheme":
        return (
            "a multiple-choice or short-answer question has no markscheme; a written "
            "answer marked on one is an open question"
        )
    if key == "marks":
        return (
            "a multiple-choice or short-answer question is worth 1 mark; a question "
            "worth more is an open question"
        )
    if key in ("model_answer", "hints"):
        return f"only an open question has {key}"
    if key in ("accepted", "unit"):
        return "a multiple-choice question names its answer in correct"
    if key in ("options", "correct"):
        return "a short answer lists accepted"
    return ""


def _problem(
    error: ValidationError, base: str, kind: str | None, fence: bool
) -> list[str]:
    """One schema error as problems: path, what was expected, what was sent."""
    path = _at(base, error.absolute_path)
    value = error.instance
    if error.validator == "required":
        missing = [f for f in error.validator_value if f not in value]
        props = error.schema.get("properties", {})
        return [
            f"{_at(path, [f])}: missing; expected "
            + EXPECTED.get(f, _expected_type(props.get(f, {})))
            for f in missing
        ]
    if error.validator == "additionalProperties":
        props = error.schema.get("properties", {})
        return [
            _unknown(path, key, value[key], kind, fence=fence)
            for key in value
            if key not in props
        ]
    if error.validator == "type":
        expected = _expected_type(error.schema)
        if path.endswith(".correct"):
            expected += ", the correct option copied exactly (not its index)"
        elif value is None:
            expected += ", or the field left out"
        return [f"{path}: expected {expected}; sent {_sent(value)}"]
    if error.validator in ("minItems", "maxItems"):
        bound = "at least" if error.validator == "minItems" else "at most"
        return [
            f"{path}: expected {bound} {error.validator_value} items; sent {len(value)}"
        ]
    if error.validator in ("minLength", "maxLength"):
        if error.validator == "minLength" and error.validator_value == 1:
            return [f"{path}: expected text; sent blank"]
        bound = "at least" if error.validator == "minLength" else "at most"
        return [
            f"{path}: expected {bound} {error.validator_value} characters; sent {len(value)}"
        ]
    if error.validator in ("minimum", "maximum"):
        bound = "at least" if error.validator == "minimum" else "at most"
        return [
            f"{path}: expected {bound} {error.validator_value}; sent {_sent(value)}"
        ]
    if error.validator == "enum":
        allowed = ", ".join(json.dumps(v) for v in error.validator_value)
        return [f"{path}: expected one of {allowed}; sent {_sent(value)}"]
    if error.validator == "const":
        return [
            f"{path}: expected {json.dumps(error.validator_value)}; sent {_sent(value)}"
        ]
    return [f"{path}: {error.message[:200]}"]


def _schema_problems(
    validator: Draft202012Validator,
    value: Any,
    base: str,
    kind: str | None,
    *,
    fence: bool,
    skip: Callable[[list[Any]], bool] = lambda _path: False,
) -> list[str]:
    errors = sorted(
        validator.iter_errors(value), key=lambda e: list(map(str, e.absolute_path))
    )
    return [
        problem
        for error in errors
        if not skip(list(error.absolute_path))
        for problem in _problem(error, base, kind, fence)
    ]


def _blanks(value: Any, path: str) -> list[str]:
    """Text that is only whitespace, and library figures, which go into notes
    only."""
    if isinstance(value, str):
        if not value.strip():
            return [f"{path}: expected text; sent blank"]
        if FIGURE.search(value):
            return [
                (
                    f"{path}: library figures go into notes only, not quiz questions; "
                    "describe the figure in words, or add a chart or plot with "
                    "add_question_media"
                )
            ]
        return []
    if isinstance(value, list):
        return [p for i, v in enumerate(value) for p in _blanks(v, f"{path}[{i}]")]
    if isinstance(value, dict):
        return [p for k, v in value.items() for p in _blanks(v, _at(path, [k]))]
    return []


def _semantic(kind: str, item: dict[str, Any], path: str) -> list[str]:
    """What the schema cannot say: the correct option is one of the options, a
    quantity's answers are numbers, an open question's items add up."""
    problems = [
        p for k in FIELDS[kind] if k in item for p in _blanks(item[k], _at(path, [k]))
    ]
    if kind == "mcq":
        options, correct = item.get("options"), item.get("correct")
        if isinstance(options, list) and all(isinstance(o, str) for o in options):
            stripped = [o.strip() for o in options]
            repeated = sorted({o for o in stripped if stripped.count(o) > 1})
            if repeated:
                problems.append(
                    f"{path}.options: expected distinct options; sent "
                    + ", ".join(_sent(o) for o in repeated)
                    + " more than once"
                )
            elif (
                isinstance(correct, str)
                and correct.strip()
                and correct.strip() not in stripped
            ):
                problems.append(
                    f"{path}.correct: expected one of the options, copied exactly: "
                    + ", ".join(_sent(o) for o in options)
                    + f"; sent {_sent(correct)}"
                )
    elif kind == "short" and "unit" in item:
        for i, answer in enumerate(item.get("accepted") or []):
            if isinstance(answer, str) and answer.strip() and not _quantity(answer):
                problems.append(
                    f"{path}.accepted[{i}]: expected a plain number because unit is set "
                    f'(like "9.8", "-70" or "3/4"); sent {_sent(answer)}'
                )
    elif kind == "open":
        items, marks = item.get("markscheme"), item.get("marks")
        if (
            isinstance(items, list)
            and isinstance(marks, int)
            and all(
                isinstance(i, dict) and isinstance(i.get("marks"), int) for i in items
            )
        ):
            total = sum(i["marks"] for i in items)
            if total != marks:
                problems.append(
                    f"{_at(path, ['markscheme'])}: expected item marks adding up to "
                    f"marks ({marks}); sent items adding up to {total}"
                )
    return problems


def _quantity(value: str) -> bool:
    value = value.strip()
    if not QUANTITY.match(value):
        return False
    _, slash, denominator = value.partition("/")
    mantissa = re.split(r"[eE]", denominator.strip())[0]
    return not slash or mantissa.strip("+-.0") != ""


def kind_of(item: dict[str, Any]) -> str | None:
    """The shape an item is written in, from its fields: an item with all of
    an open question's needs is open whatever else it carries."""
    if all(k in item for k in NEEDS["open"]):
        return "open"
    if "options" in item or "correct" in item:
        return "mcq"
    if "accepted" in item or "unit" in item:
        return "short"
    if item.keys() & {"marks", "markscheme", "model_answer", "hints"}:
        return "open"
    return None


@dataclass
class Item:
    """One question of a call or a quiz fence: where it was sent, its kind and
    its problems. A structural problem (a field missing, unknown or of the
    wrong type, or no recognisable kind) also earns the shape to copy."""

    index: int
    path: str
    kind: str | None
    value: Any
    problems: list[str] = field(default_factory=list)
    structural: bool = False


# Schema errors that mean the shape itself is wrong.
STRUCTURAL = {"required", "additionalProperties", "type"}


def check_item(item: Any, index: int, path: str, *, fence: bool) -> Item:
    """One question of add_questions or of a quiz fence, with every problem."""
    if not isinstance(item, dict):
        return Item(
            index,
            path,
            None,
            item,
            [f"{path}: expected a question object; sent {_sent(item)}"],
            True,
        )
    kind = kind_of(item)
    if kind is None:
        sent = ", ".join(sorted(item)) or "none"
        problems = [
            (
                f"{path}: expected a multiple-choice question (options and correct), "
                "a short answer (accepted) or an open question (marks, markscheme, "
                f"model_answer); sent the fields {sent}"
            )
        ]
        problems += [
            f"{_at(path, [k])}: {hint}"
            for k in item
            if k != "question" and (hint := _hint(k, None, fence=fence))
        ]
        return Item(index, path, None, item, problems, True)
    validator = _KINDS[kind]
    problems = _schema_problems(validator, item, path, kind, fence=fence)
    structural = any(e.validator in STRUCTURAL for e in validator.iter_errors(item))
    if fence and "replaces" in item:
        problems.append(
            f"{path}.replaces: a quiz fence writes new questions; rewrite one with "
            "add_questions"
        )
    if kind == "short":
        item = _without_unit(item)
    problems += _semantic(kind, item, path)
    return Item(index, path, kind, item, problems, structural)


def _without_unit(item: dict[str, Any]) -> dict[str, Any]:
    """A short answer's accepted answers written as the number followed by its
    unit ("5%" with unit "%") keep the number; repeats are dropped."""
    unit, accepted = item.get("unit"), item.get("accepted")
    if not isinstance(unit, str) or not unit.strip() or not isinstance(accepted, list):
        return item
    unit = unit.strip()
    out: list[Any] = []
    for answer in accepted:
        if isinstance(answer, str):
            number = answer.strip().removesuffix(unit).rstrip()
            if number != answer.strip() and _quantity(number):
                answer = number
        if answer not in out:
            out.append(answer)
    return {**item, "accepted": out}


def expand(kind: str, item: dict[str, Any], qid: str) -> dict[str, Any]:
    """The question format for one checked item: one part, the question's text
    as its blocks, 1 mark unless open, the explanation as the solution."""
    part: dict[str, Any] = {
        "id": f"{qid}-a",
        "blocks": [{"type": "text", "text": item["question"]}],
    }
    if kind == "mcq":
        written = list(item["options"])
        answer = [o.strip() for o in written].index(item["correct"].strip())
        # Seeded by the id, so a retried call writes the same order.
        order = list(range(len(written)))
        random.Random(qid).shuffle(order)
        options = [written[i] for i in order]
        part["answer"] = {
            "type": "mcq",
            "options": options,
            "correct": [order.index(answer)],
        }
        part["marks"] = 1
    elif kind == "short":
        part["answer"] = {"type": "short", "accepted": list(item["accepted"])}
        if "unit" in item:
            part["answer"]["unit"] = item["unit"]
        part["marks"] = 1
    else:
        part["answer"] = {
            "type": "open",
            "accepted": [item["model_answer"]],
            "hints": list(item.get("hints") or []),
        }
        part["marks"] = item["marks"]
        part["markscheme"] = [
            {"text": i["text"], "marks": i["marks"]} for i in item["markscheme"]
        ]
    explanation = item.get("explanation")
    part["solution"] = [{"type": "text", "text": explanation}] if explanation else []
    return {
        "id": qid,
        "stem": [],
        "parts": [part],
        "layout": "paper",
        "labels": "letters",
    }


def preview(question: dict[str, Any]) -> str:
    """A question's text, short, for a tool result."""
    parts = question.get("parts") or [{}]
    blocks = [*(question.get("stem") or []), *(parts[0].get("blocks") or [])]
    text = " ".join(str(b.get("text") or "") for b in blocks if b.get("type") == "text")
    text = " ".join(text.split())
    return text if len(text) <= 70 else text[:67] + "…"


# ------------------------------------------------------------------- calls


# The Check name of a note write's quiz fences.
FENCE = "quiz fence"


@dataclass
class Check:
    """A question call checked: problems with the call itself refuse it whole;
    each item's problems leave out that item only (add_questions). A note
    write's quiz fences are checked the same way, refused whole."""

    name: str
    call: list[str] = field(default_factory=list)
    items: list[Item] = field(default_factory=list)
    # What the pipeline repaired or ignored, one line each for the success
    # result, so the model stops repeating the slip.
    notes: list[str] = field(default_factory=list)

    @property
    def valid(self) -> list[Item]:
        return [i for i in self.items if not i.problems]

    @property
    def invalid(self) -> list[Item]:
        return [i for i in self.items if i.problems]

    def problems(self) -> list[str]:
        return [*self.call, *(p for i in self.invalid for p in i.problems)]

    def listing(self) -> str:
        """Every problem, then the shape to copy for each kind written wrong."""
        kinds: list[str] = []
        for item in self.items:
            if item.structural:
                for kind in [item.kind] if item.kind else SHAPES:
                    if kind not in kinds:
                        kinds.append(kind)
        shapes = [SHAPES[k] for k in kinds]
        if shapes and self.name == FENCE:
            shapes.insert(
                0, "A quiz fence lists its questions in YAML, in these shapes:"
            )
        return "\n".join([*(f"- {p}" for p in self.problems()), *shapes])


def drop_blanks(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """A question call without its blank fields (contract.blank): the call's
    unless its tool requires them, each question's unless its kind needs them,
    and media's unless its block requires them."""
    required = _schema(name).get("required", ())
    clean = {k: v for k, v in args.items() if k in required or not contract.blank(v)}
    if isinstance(clean.get("questions"), list):
        clean["questions"] = [drop_question_blanks(q) for q in clean["questions"]]
    media = clean.get("media")
    if isinstance(media, dict):
        block = contract.MEDIA_BLOCKS.get(str(media.get("type")), {})
        clean["media"] = contract.drop_blanks(block, media)
    return clean


def drop_question_blanks(item: Any) -> Any:
    """A question without its blank fields, except the question and the fields
    its kind needs (the kind read from the fields that are not blank), so a
    blank answer still gets its own message."""
    if not isinstance(item, dict):
        return item
    filled = {k: v for k, v in item.items() if not contract.blank(v)}
    kind = kind_of(filled) or kind_of(item)
    keep = {"question", *(NEEDS[kind] if kind else ())}
    return {k: v for k, v in item.items() if k in keep or not contract.blank(v)}


def _target_problems(args: dict[str, Any]) -> list[str]:
    """A question call writes to one quiz: an existing one or a new one."""
    quiz_id, title = args.get("quiz_id"), args.get("title")
    problems = []
    if bool(quiz_id) == bool(title):
        sent = "both" if quiz_id else "neither"
        problems.append(
            "quiz_id, title: expected exactly one, quiz_id to add to a quiz or title "
            f"to create one; sent {sent}"
        )
    if "after_question_id" in args and not quiz_id:
        problems.append(
            "after_question_id: places questions in an existing quiz; it goes with quiz_id"
        )
    if "chapter_id" in args and not title and not quiz_id:
        problems.append(
            "chapter_id: files a new quiz, so it goes with title; adding to a quiz "
            "takes quiz_id alone"
        )
    return problems


def check(args: dict[str, Any]) -> Check:
    """Every problem of an add_questions call that needs no quiz to see."""
    result = Check("add_questions")
    result.call = _schema_problems(
        _ADD,
        args,
        "",
        None,
        fence=False,
        skip=lambda p: len(p) > 1 and p[0] == "questions",
    )
    questions = args.get("questions")
    for i, value in enumerate(questions if isinstance(questions, list) else []):
        item = check_item(value, i, f"questions[{i}]", fence=False)
        if args.get("title") and isinstance(value, dict) and "replaces" in value:
            item.problems.append(
                f"{item.path}.replaces: a new quiz has no question to replace"
            )
        result.items.append(item)
    result.call += _target_problems(args)
    quiz_id = args.get("quiz_id")
    if quiz_id and "chapter_id" in args and not args.get("title"):
        result.notes.append(f"chapter_id ignored: quiz {quiz_id} keeps its chapter.")
    return result


def _listed(ids: list[str]) -> str:
    return ", ".join(ids[:30]) + (" …" if len(ids) > 30 else "") or "none yet"


def find(
    check_: Check, quiz: list[dict[str, Any]], question_id: str
) -> dict[str, Any] | None:
    """The quiz's question by id, or None with the problem noted."""
    question = next((q for q in quiz if q.get("id") == question_id), None)
    if question is None:
        listed = _listed([str(q.get("id")) for q in quiz])
        check_.call.append(
            f"question_id: expected a question id of this quiz ({listed}); sent {_sent(question_id)}"
        )
    return question


def check_ids(check_: Check, args: dict[str, Any], quiz: list[dict[str, Any]]) -> None:
    """The ids a call names must be the quiz's questions."""
    ids = [str(q.get("id")) for q in quiz]
    listed = _listed(ids)
    after = args.get("after_question_id")
    if after is not None and after not in ids:
        check_.call.append(
            f"after_question_id: expected a question id of this quiz ({listed}); sent {_sent(after)}"
        )
    seen: set[str] = set()
    for item in check_.items:
        value = item.value if isinstance(item.value, dict) else {}
        replaces = value.get("replaces")
        if not isinstance(replaces, str):
            continue
        if replaces not in ids:
            item.problems.append(
                f"{item.path}.replaces: expected a question id of this quiz ({listed}); "
                f"sent {_sent(replaces)}"
            )
        elif replaces in seen:
            item.problems.append(
                f"{item.path}.replaces: {replaces} is already rewritten by an earlier "
                "question of this call"
            )
        seen.add(replaces)


@dataclass
class Built:
    """What a checked call writes: the new quiz's questions, or the edit
    commands for an existing one, and each question saved with its item."""

    questions: list[dict[str, Any]] = field(default_factory=list)
    commands: list[dict[str, Any]] = field(default_factory=list)
    saved: list[tuple[Item, dict[str, Any]]] = field(default_factory=list)
    # The question the first item left out would have followed.
    anchor: str | None = None


def build(
    check_: Check,
    quiz: list[dict[str, Any]] | None,
    after: str | None,
    new_id: Callable[[], str],
) -> Built:
    """The call's valid questions in the question format, placed in order
    after ``after`` (the quiz's last question when None) or replacing the
    questions they name."""
    built = Built()
    place = after if after is not None else (str(quiz[-1]["id"]) if quiz else None)
    for item in check_.items:
        if item.problems:
            if built.anchor is None:
                built.anchor = place
            continue
        value = item.value
        replaces = value.get("replaces")
        qid = replaces or new_id()
        question = expand(item.kind or "open", value, qid)
        built.saved.append((item, question))
        if quiz is None:
            built.questions.append(question)
        elif replaces:
            built.commands.append(
                {
                    "type": "replace_question",
                    "question_id": replaces,
                    "question": question,
                }
            )
        else:
            built.commands.append(
                {
                    "type": "add_question",
                    "question": question,
                    "after_question_id": place,
                }
            )
            place = qid
    return built


def media_check(args: dict[str, Any]) -> Check:
    """Every problem of an add_question_media call that needs no quiz to see."""
    found = Check("add_question_media")
    found.call = _media_problems(args)
    return found


def _media_problems(args: dict[str, Any]) -> list[str]:
    problems = _schema_problems(_MEDIA_TOOL, args, "", None, fence=False)
    media = args.get("media")
    if not isinstance(media, dict):
        return problems
    kind = media.get("type")
    if kind not in _MEDIA:
        figure = (
            " (library figures go into notes only)"
            if kind in ("figure", "image")
            else ""
        )
        return problems + [
            f'media.type: expected "chart" or "plot"{figure}; sent {_sent(kind)}'
        ]
    problems += _schema_problems(_MEDIA[kind], media, "media", None, fence=False)
    if kind == "chart":
        problems += _chart_problems(media)
    return problems


def _chart_problems(chart: dict[str, Any]) -> list[str]:
    """A chart's values line up with its labels; a pie or stacked chart has one
    series of values 0 or more with a positive total."""
    labels, series = chart.get("labels"), chart.get("series")
    if not isinstance(labels, list) or not isinstance(series, list):
        return []
    values = [s.get("values") if isinstance(s, dict) else None for s in series]
    problems = [
        f"media.series[{i}].values: expected one number per label ({len(labels)}); "
        f"sent {len(v)}"
        for i, v in enumerate(values)
        if isinstance(v, list) and len(v) != len(labels)
    ]
    kind = chart.get("kind")
    if kind in ("pie", "stacked"):
        if len(series) != 1:
            problems.append(
                f"media.series: expected 1 series for a {kind} chart; sent {len(series)}"
            )
        elif (
            isinstance(values[0], list)
            and all(isinstance(v, int | float) for v in values[0])
            and (any(v < 0 for v in values[0]) or not any(v > 0 for v in values[0]))
        ):
            problems.append(
                f"media.series[0].values: expected values of 0 or more with a positive "
                f"total for a {kind} chart; sent {_sent(values[0])}"
            )
    return problems


def with_media(question: dict[str, Any], media: dict[str, Any]) -> dict[str, Any]:
    """The question with the media block after its text: after the stem when it
    has one, else after its first part's blocks."""
    out = copy.deepcopy(question)
    blocks = out["stem"] if out.get("stem") else out["parts"][0]["blocks"]
    blocks.append(media)
    return out


def editable(question: dict[str, Any]) -> bool:
    """A question read with its answers: a learner's view drops each part's
    worked solution, and writing it back would drop the key."""
    return all("solution" in p for p in question.get("parts") or [])


def result_text(
    check_: Check,
    built: Built,
    resource: dict[str, Any],
    created: bool,
) -> str:
    """What a question call wrote, with each question's id, and what it left
    out with how to resend it."""
    rid, title = resource.get("id"), resource.get("title")
    rewrote = sum(1 for item, _ in built.saved if item.value.get("replaces"))
    added = len(built.saved) - rewrote
    if created:
        head = f"Created quiz '{title}' (id {rid}) with {added} question(s):"
    else:
        did = [f"added {added} question(s)"] if added else []
        did += [f"rewrote {rewrote}"] if rewrote else []
        head = f"In quiz '{title}' (id {rid}), {' and '.join(did)}:"
    lines = [head, *(f"- {q['id']}: {preview(q)}" for _, q in built.saved)]
    if check_.invalid:
        place = f", after_question_id {built.anchor}" if built.anchor else ""
        lines.append(
            f"\nNot added: fix only these and send them again with quiz_id {rid}{place}:"
        )
        lines.append(check_.listing())
    elif not created:
        lines.append("The user can undo this from the chat result.")
    lines.extend(check_.notes)
    return "\n".join(lines)


def refusal(check_: Check) -> tuple[str, str]:
    """A refused question call: a short error, and every problem for the model."""
    count = len(check_.problems())
    return (
        (
            f"Not applied: {count} problem{'s' if count != 1 else ''}, listed below; "
            "fix them all and send the call again."
        ),
        check_.listing(),
    )


# ---------------------------------------------------------------- note fences

# A fenced block with a language; it closes on a run of the opening's
# character at least as long as the opening's, so a longer fence holding a
# shorter one is consumed whole.
NOTE_FENCE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<fence>(?P<char>[`~])(?P=char){2,})(?P<lang>[\w-]+)[ \t]*\n"
    r"(?P<body>.*?)^(?P=indent)(?P=fence)(?P=char)*[ \t]*$",
    re.MULTILINE | re.DOTALL,
)
# A chart fence whose type names a chart kind means that kind.
_CHART_KINDS = contract.MEDIA_BLOCKS["chart"]["properties"]["kind"]["enum"]


def _whole_numbers(value: Any) -> Any:
    """YAML read without interpreting scalars keeps every answer as written;
    marks are the one number a question carries."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == "marks" and isinstance(v, str) and v.strip().isdigit():
                out[k] = int(v)
            elif k == "markscheme" and isinstance(v, list):
                out[k] = [_whole_numbers(i) for i in v]
            else:
                out[k] = v
        return out
    return value


def note_fences(
    texts: list[str], where: Callable[[int], str], new_id: Callable[[], str]
) -> tuple[list[str], Check]:
    """A note write's markdown texts with each ```quiz fence's questions
    expanded into the question format, each ```flashcards, ```chart and
    ```plot fence's body repaired where it can mean one thing and re-emitted
    as JSON, and every problem in them. ``where`` names the i-th text in a
    problem's path. Agent writes only: the editor, paste and the converter
    stay strict (Epo 2026-10-13)."""
    found = Check(FENCE)
    out = []
    for n, markdown in enumerate(texts):
        label, counts = where(n), Counter[str]()

        def repaired(
            match: re.Match[str], label: str = label, counts: Counter[str] = counts
        ) -> str:
            lang = match["lang"]
            counts[lang] += 1
            at = f"{label} {lang} fence {counts[lang]}"
            if lang == "quiz":
                return _fence(match, at, found, new_id)
            if lang == "flashcards":
                body = _cards(_body(match), at, found)
            elif lang in contract.MEDIA_BLOCKS:
                body = _media(lang, _body(match), at, found)
            else:
                return match[0]
            return match[0] if body is None else _emit(match, body)

        out.append(NOTE_FENCE.sub(repaired, markdown))
    return out, found


def _body(match: re.Match[str]) -> str:
    indent = match["indent"]
    return "".join(
        line.removeprefix(indent) for line in match["body"].splitlines(keepends=True)
    )


def _emit(match: re.Match[str], body: str) -> str:
    indent, fence = match["indent"], match["fence"]
    return f"{indent}{fence}{match['lang']}\n{indent}{body}\n{indent}{fence}"


def _fence(
    match: re.Match[str], at: str, found: Check, new_id: Callable[[], str]
) -> str:
    """One quiz fence expanded, or left as written with its problems noted."""
    try:
        data, fixed = _yaml(_body(match))
    except yaml.YAMLError as exc:
        found.call.append(f"{at}: expected YAML; {str(exc).splitlines()[0]}")
        return match[0]
    items = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(items, list) or not items:
        found.call.append(
            f"{at}: expected a YAML questions: list of 1 or more questions"
        )
        return match[0]
    checked = [
        check_item(
            _whole_numbers(drop_question_blanks(v)),
            i,
            f"{at} questions[{i}]",
            fence=True,
        )
        for i, v in enumerate(items)
    ]
    found.items.extend(checked)
    if any(item.problems for item in checked):
        return match[0]
    if fixed:
        found.notes.append(_repair_note(at, fixed))
    questions = [expand(i.kind or "open", i.value, new_id()) for i in checked]
    return _emit(match, json.dumps({"questions": questions}, ensure_ascii=False))


def _cards(body: str, at: str, found: Check) -> str | None:
    """A flashcards fence's body as JSON (which the converter's YAML reader
    takes) once it holds cards with a front and a back each, other card fields
    kept as sent; None leaves the fence as written for the converter to name
    its problem."""
    try:
        data, fixed = _yaml(body)
    except yaml.YAMLError:
        return None
    cards = data.get("cards") if isinstance(data, dict) else None
    if (
        not isinstance(cards, list)
        or not cards
        or not all(
            isinstance(card, dict)
            and all(
                isinstance(card.get(k), str) and card[k].strip()
                for k in ("front", "back")
            )
            for card in cards
        )
    ):
        return None
    if fixed:
        found.notes.append(_repair_note(at, fixed))
    return json.dumps(data, ensure_ascii=False)


def _media(lang: str, body: str, at: str, found: Check) -> str | None:
    """A chart or plot fence's body as compact JSON: read as YAML when it is
    not JSON and does not open as JSON ({), its type set to the fence's name
    when missing, and a chart kind sent as a chart fence's type moved to kind.
    None leaves the fence as written for the converter to name its problem,
    as for YAML whose escapes made control characters ("$\\alpha$")."""
    fixed = []
    try:
        data = json.loads(body)
    except ValueError:
        if body.lstrip().startswith("{"):
            return None
        try:
            data = yaml.safe_load(body)
        except yaml.YAMLError:
            return None
        if any(_CONTROL.search(text) for text in _texts(data)):
            return None
        fixed.append(f"read it from YAML; a {lang} fence is JSON")
    if not isinstance(data, dict):
        return None
    if "type" not in data:
        data = {"type": lang, **data}
        fixed.append(f'added "type": "{lang}"')
    elif lang == "chart" and data["type"] in _CHART_KINDS and "kind" not in data:
        fixed.append(f'"type": "{data["type"]}" is a chart kind, so it went to kind')
        data = {**data, "type": "chart", "kind": data["type"]}
    if fixed:
        found.notes.append(f"Repaired {at}: {'; '.join(fixed)}.")
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)


# C0 controls other than tab and newline, NEL and the Unicode line and
# paragraph separators: what YAML escapes such as \a, \N, \L and \P make.
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x85\u2028\u2029]")


def _texts(value: Any) -> list[str]:
    """Every key and string in a parsed body."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [t for k, v in value.items() for t in (str(k), *_texts(v))]
    if isinstance(value, list):
        return [t for v in value for t in _texts(v)]
    return []


# Repairs tried on a quiz or flashcards fence only after it fails to parse,
# with what the model should write instead.
_REPAIRS = {
    "trailing commas": "a YAML line ends without a comma",
    "values holding ': ' quoted": 'quote a YAML value holding ": "',
    "LaTeX backslashes": "in YAML double quotes write \\\\ for a backslash",
}
_TRAILING_COMMA = re.compile(r"([\]}])[ \t]*,[ \t]*$", re.MULTILINE)
# A single-line value after a text key; a list item.
_TEXT_VALUE = re.compile(
    r"^(?P<lead>[ \t]*(?:-[ \t]+)?(?:question|explanation|correct|model_answer"
    r"|text|front|back):[ \t]+)(?P<value>\S.*?)[ \t]*$"
)
_LIST_KEY = re.compile(r"^(?P<lead>[ \t]*(?:-[ \t]+)?)(?:options|accepted):[ \t]*$")
_LIST_ITEM = re.compile(r"^(?P<lead>(?P<dash>[ \t]*)-[ \t]+)(?P<value>\S.*?)[ \t]*$")
# Where a value starts: after a key or a list item's dash.
_VALUE = re.compile(r"^(?P<lead>[ \t]*(?:-[ \t]+)?(?:[\w-]+:[ \t]+)?)(?P<value>.*)$")
_DOUBLE_QUOTED = re.compile(r'"(?:[^"\\\n]|\\.)*"')
_FLOW_PLAIN = re.compile(r"[^,\]]*")
_ESCAPE = re.compile(r"\\(.)")


def _yaml(body: str) -> tuple[Any, list[str]]:
    """A quiz or flashcards fence's body read with BaseLoader, which keeps
    every scalar as written (no Yes/No booleans, no 0.50 turned into 0.5) and
    builds no objects. When that fails, it is read once more after the repairs
    that change it, named in the result; when that fails too, the first error
    is raised."""
    try:
        return yaml.load(body, Loader=yaml.BaseLoader), []
    except yaml.YAMLError:
        text, fixed = _repair_yaml(body)
        if fixed:
            with contextlib.suppress(yaml.YAMLError):
                return yaml.load(text, Loader=yaml.BaseLoader), fixed
        raise


def _repair_yaml(body: str) -> tuple[str, list[str]]:
    """The body with trailing commas after a closing ] or } removed (not in a
    JSON body, whose commas end lines), a plain value holding ": " after a text
    key or as an options/accepted item quoted, and a backslash before a letter
    doubled in a double-quoted value (LaTeX); with the names of the repairs
    that changed it."""
    fixed = []
    json_body = body.lstrip().startswith(("{", "["))
    text = body if json_body else _TRAILING_COMMA.sub(r"\1", body)
    if text != body:
        fixed.append("trailing commas")
    lines, under = [], None  # under: the column of an options/accepted key
    for line in text.split("\n"):
        item = _LIST_ITEM.match(line)
        if under is not None and item and len(item["dash"]) >= under:
            line = _quoted(item)
        else:
            key = _LIST_KEY.match(line)
            if key:
                under = len(key["lead"])
            elif line.strip():
                under = None
            value = _TEXT_VALUE.match(line)
            line = _quoted(value) if value else line
        lines.append(line)
    quoted = "\n".join(lines)
    if quoted != text:
        fixed.append("values holding ': ' quoted")
    escaped = "\n".join(_escaped(line) for line in quoted.split("\n"))
    if escaped != quoted:
        fixed.append("LaTeX backslashes")
    return escaped, fixed


def _escaped(line: str) -> str:
    """The line with a backslash before a letter doubled in the double-quoted
    scalars that open its value (after a key or a dash) or are items of a flow
    list there; a quoted phrase inside a plain or single-quoted scalar is left
    alone, its backslashes being literal already."""
    match = _VALUE.match(line)
    lead, value = match["lead"], match["value"]
    if not lead.strip():
        return line
    spans = []
    if value.startswith('"'):
        spans.append(_DOUBLE_QUOTED.match(value))
    elif value.startswith("["):
        at = 1
        while at < len(value):
            while at < len(value) and value[at] in " \t":
                at += 1
            span = _DOUBLE_QUOTED.match(value, at) or _FLOW_PLAIN.match(value, at)
            if span.re is _DOUBLE_QUOTED:
                spans.append(span)
            at = span.end()
            if at >= len(value) or value[at] != ",":
                break
            at += 1
    out, at = [], 0
    for span in spans:
        if span is not None:
            out += [value[at : span.start()], _ESCAPE.sub(_double, span[0])]
            at = span.end()
    return lead + "".join(out) + value[at:]


def _double(escape: re.Match[str]) -> str:
    letter = escape[1]
    return "\\\\" + letter if letter.isascii() and letter.isalpha() else escape[0]


def _quoted(match: re.Match[str]) -> str:
    """A plain value holding ": " in double quotes; any other as is. (" #" is
    not quoted: on a line that parses it starts a comment.)"""
    value = match["value"]
    if value[0] in "\"'|>[{" or ": " not in value:
        return match.string
    return match["lead"] + json.dumps(value, ensure_ascii=False)


def _repair_note(at: str, fixed: list[str]) -> str:
    return (
        f"Repaired {at} ({', '.join(fixed)}); "
        + "; ".join(_REPAIRS[f] for f in fixed)
        + "."
    )
