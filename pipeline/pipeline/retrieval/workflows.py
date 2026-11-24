"""Deterministic generation workflows for /generate.

Material generation is not a conversation. The scope is already known (the user
picked topics or files), the output shape is fixed, and the caller wants the
whole artifact or nothing. So these are fixed pipelines — gather, then produce —
rather than agent loops: no tool budget to blow, no chance of the model deciding
to answer in prose instead of returning the JSON the gateway must persist.

Coverage matters more than precision here. A quiz built from the single best
passage is a quiz about one paragraph, so context is sampled across the scope's
documents rather than ranked by relevance to a query nobody asked.
"""

from __future__ import annotations

import json
import logging
import re
from bisect import bisect_right
from itertools import accumulate
from typing import Any

from ..config import cfg
from ..generated import limits
from ..prompts import generate as generate_prompts
from ..prompts.sources import source_block
from . import compact, models, store
from .chunking import estimate_tokens
from .search import Passage

log = logging.getLogger("capy.retrieval.workflows")


class InvalidGenerateScope(ValueError):
    """At least one requested item does not belong to the workspace."""


class GenerateNoContent(ValueError):
    """The resolved generation scope has no indexed passages."""


# Go's errScopeNoIndexedContent says the same.
NO_CONTENT = (
    "None of the chosen sources has any text to generate from yet: they are "
    "still being indexed, or they are quizzes or flashcard sets, which hold no "
    "source text."
)


async def generation_context(
    *,
    workspace_id: str,
    file_ids: list[str] | None,
    instruction: str,
    scope: str,
    model: models.ModelConfig,
    locale: str | None,
    instructions: str = "",
) -> tuple[str, list[Passage]]:
    """The scope's indexed passages that fit the model beside the prompt. Only
    indexed text: an unindexed item or an edit since the last index waits for
    its reindex, so no whole file reaches the model (Epo 2026-11-21)."""

    def messages(context: str):
        return generate_prompts.generate_messages(
            instruction=instruction,
            context=context,
            scope=scope,
            locale=locale,
            instructions=instructions,
        )

    remaining = (
        compact.usable_input_limit(model)
        - compact.request_context(messages(""), model).total_tokens
    )
    if remaining < 0:
        raise compact.ContextTooLarge(
            "Generation instructions exceed the selected model's input limit."
        )
    context, passages = await gather_context(
        workspace_id=workspace_id,
        file_ids=file_ids,
        budget=remaining,
    )
    if not passages:
        raise GenerateNoContent(NO_CONTENT)
    if not compact.fits_request(messages(context), model):
        # Passage estimates bound the read. Select the final prefix using the
        # same complete provider request as produce.
        pieces = [passage.as_context(i) for i, passage in enumerate(passages, 1)]
        low, high = 0, len(pieces)
        while low < high:
            middle = (low + high + 1) // 2
            if compact.fits_request(messages("\n\n".join(pieces[:middle])), model):
                low = middle
            else:
                high = middle - 1
        context, passages = "\n\n".join(pieces[:low]), passages[:low]
        if not passages:
            raise compact.ContextTooLarge(
                "Source passages exceed the selected model's input limit."
            )
    return context, passages


async def gather_context(
    *, workspace_id: str, file_ids: list[str] | None, budget: int | None = None
) -> tuple[str, list[Passage]]:
    """The scoped documents' passages that fit ``budget``, as numbered passages.

    The scope may name any workspace item; one without chunks (a quiz, a
    flashcard set, a note not indexed yet) contributes nothing.
    Shares are max-min, not proportional to length: ten pages of lecture notes
    are as likely to be examinable as three hundred pages of reference text.
    Shortest first, each document is offered an equal split of what is left,
    so one shorter than its share goes in whole and the rest passes to the
    longer ones (Epo 2026-11-21). A document longer than its share is read
    across its sections (``spread``). The plan reads no text: passages are
    costed from their rows, then only the chosen ones are read.
    """
    if budget is None:
        budget = cfg.llm_input_budget_tokens
    outline = await store.workspace_outline(workspace_id)
    known_ids = {str(file["id"]) for file in outline["files"]}
    requested = list(dict.fromkeys(file_ids or []))
    for file_id in requested:
        if file_id not in known_ids:
            raise InvalidGenerateScope(
                f'No workspace item has the id "{file_id}": it may have been '
                "deleted or moved to trash."
            )
    files = [
        f
        for f in outline["files"]
        if (not requested or f["id"] in set(requested)) and f["chunks"]
    ]
    if not files:
        return "", []
    chunks: dict[str, list[dict[str, Any]]] = {f["id"]: [] for f in files}
    for row in await store.chunk_map(workspace_id, list(chunks)):
        chunks[row["file_id"]].append(row)
    costs = {
        f["id"]: [_plan_cost(f["name"], row) for row in chunks[f["id"]]] for f in files
    }
    picked: dict[str, list[int]] = {}
    left = budget
    shortest_first = sorted(files, key=lambda f: sum(costs[f["id"]]))
    for n, file in enumerate(shortest_first):
        file_costs = costs[file["id"]]
        share = left // (len(shortest_first) - n)
        paths = [row["section_path"] or "" for row in chunks[file["id"]]]
        picked[file["id"]] = spread(paths, file_costs, share)
        left -= sum(file_costs[i] for i in picked[file["id"]])
    ids = [chunks[f["id"]][i]["id"] for f in files for i in picked[f["id"]]]
    rows = {row["id"]: row for row in await store.history_passages(workspace_id, ids)}
    passages = [Passage.from_row(rows[i]) for i in ids if i in rows]
    body: list[str] = []
    used = 0
    for index, passage in enumerate(passages, start=1):
        piece = passage.as_context(index)
        cost = estimate_tokens(piece)
        if used + cost > budget:
            break
        body.append(piece)
        used += cost
    return "\n\n".join(body), passages[: len(body)]


# Consecutive passages a window reads, about 1,200 tokens (Epo 2026-11-21).
WINDOW = 3


def _plan_cost(name: str, row: dict[str, Any]) -> int:
    """A passage's tokens as numbered context, from its row: its text's count
    plus a header as long as ``Passage.as_context`` writes, index and pages at
    their widest."""
    header = " › ".join(p for p in (name, row["section_path"], "pp.9999–9999") if p)
    return row["token_count"] + estimate_tokens(source_block(f"[9999] {header}\n")) + 1


def spread(paths: list[str], costs: list[int], share: int) -> list[int]:
    """Which of a document's passages to read within ``share`` tokens, by index
    (Epo 2026-11-21). All of them when they fit. Otherwise windows of WINDOW
    consecutive passages: the sections (runs of one heading path; a document
    without headings is one) share the windows by length, and each section
    reads its first window at its heading and the rest evenly spaced through
    it. The most windows that fit are taken; when not even one does, the
    first window's passages that fit."""
    if sum(costs) <= share:
        return list(range(len(costs)))
    starts = [i for i in range(len(paths)) if i == 0 or paths[i] != paths[i - 1]]
    sections = list(zip(starts, [*starts[1:], len(paths)], strict=True))
    ends = list(accumulate(sum(costs[a:b]) for a, b in sections))

    def windows(count: int) -> list[int]:
        # Each window lands in the section holding the middle of one of
        # `count` equal stretches of the document's tokens.
        per_section = [0] * len(sections)
        for w in range(count):
            middle = (2 * w + 1) * ends[-1] / (2 * count)
            per_section[bisect_right(ends, middle)] += 1
        chosen: set[int] = set()
        for (first, stop), placed in zip(sections, per_section, strict=True):
            for j in range(placed):
                at = first + j * (stop - first) // placed
                chosen.update(range(at, min(at + WINDOW, stop)))
        return sorted(chosen)

    def cost(indices: list[int]) -> int:
        return sum(costs[i] for i in indices)

    low, high = 0, len(costs)
    while low < high:
        middle = (low + high + 1) // 2
        if cost(windows(middle)) <= share:
            low = middle
        else:
            high = middle - 1
    if low:
        return windows(low)
    fitting: list[int] = []
    for i in windows(1):
        if cost(fitting) + costs[i] > share:
            break
        fitting.append(i)
    return fitting


def scope_label(topics: list[str], file_names: list[str]) -> str:
    parts = []
    if topics:
        parts.append("topics " + ", ".join(topics))
    if file_names:
        parts.append("documents " + ", ".join(file_names[:12]))
    return "; ".join(parts)


def extract_json(text: str) -> Any:
    """Pull the first JSON value out of a reply, tolerating prose and fences."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    match = re.search(r"(\{.*\}|\[.*\])", candidate, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


class GenerateEmpty(ValueError):
    """The model replied, but nothing in that reply can become a material."""

    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(f"The model returned no usable {kind}.")


def require_json_list(raw: str, kind: str) -> list[Any]:
    data = extract_json(raw)
    if not isinstance(data, list) or not data:
        raise GenerateEmpty(kind)
    return data


async def produce(
    *,
    instruction: str,
    context: str,
    scope: str,
    model: models.ModelConfig,
    temperature: float = 0.4,
    locale: str | None = None,
    instructions: str = "",
) -> str:
    messages = generate_prompts.generate_messages(
        instruction=instruction,
        context=context,
        scope=scope,
        locale=locale,
        instructions=instructions,
    )
    if not compact.fits_request(messages, model):
        raise compact.ContextTooLarge(
            "Source context exceeds the selected model's input limit."
        )
    return await models.complete_text(
        messages,
        model=model,
        temperature=temperature,
    )


def _whole_marks(value: object) -> bool:
    """Marks are positive whole numbers; bool is an int subclass, so not marks."""
    return type(value) is int and value >= 1


def _markscheme_fits(part: dict[str, Any]) -> bool:
    """Only open parts have a markscheme, and its item marks add up to the part's."""
    if part["answer"]["type"] != "open":
        return "markscheme" not in part
    items = part.get("markscheme")
    return (
        isinstance(items, list)
        and bool(items)
        and all(
            isinstance(item, dict)
            and set(item) == {"text", "marks"}
            and isinstance(item["text"], str)
            and bool(item["text"].strip())
            and _whole_marks(item["marks"])
            for item in items
        )
        and sum(item["marks"] for item in items) == part["marks"]
    )


def normalize_questions(data: Any) -> list[dict[str, Any]]:
    """Assign fresh UUIDs to canonical generated questions; reject legacy shapes.

    The gateway's shared question validator checks block and answer constraints
    before persistence. This boundary never repairs malformed or legacy content.
    """
    import copy
    import uuid

    if not isinstance(data, list) or not data:
        raise GenerateEmpty("quiz")
    questions = copy.deepcopy(data)
    for question in questions:
        if (
            not isinstance(question, dict)
            or set(question) - {"id", "stem", "parts", "layout", "labels", "level"}
            or not isinstance(question.get("stem"), list)
            or not isinstance(question.get("parts"), list)
            or not question["parts"]
            or question.get("layout") not in ("paper", "split")
            or question.get("labels") not in ("letters", "numbers")
            or (
                "level" in question
                and question["level"] not in ("recall", "application", "analysis")
            )
        ):
            raise GenerateEmpty("quiz")
        question["id"] = str(uuid.uuid4())
        for part in question["parts"]:
            if (
                not isinstance(part, dict)
                or set(part)
                - {"id", "blocks", "answer", "marks", "markscheme", "solution"}
                or not isinstance(part.get("blocks"), list)
                or not part["blocks"]
                or not isinstance(part.get("solution"), list)
                or not isinstance(part.get("answer"), dict)
                or part["answer"].get("type")
                not in (
                    "mcq",
                    "boolean",
                    "short",
                    "matching",
                    "ordering",
                    "open",
                )
                or not _whole_marks(part.get("marks"))
                or part["marks"] > limits.QUESTION_MARKS_MAX
                or not _markscheme_fits(part)
            ):
                raise GenerateEmpty("quiz")
            part["id"] = str(uuid.uuid4())
    return questions
