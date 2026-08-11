"""Deterministic generation workflows for /generate.

Material generation is not a conversation. The scope is already known (the user
picked chapters or files), the output shape is fixed, and the caller wants the
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
from typing import Any

from . import models, store
from .search import Passage

log = logging.getLogger("evo.retrieval.workflows")

# Roughly a 30k-character context. Well inside every model we dispatch to, and
# large enough that a chapter's worth of material fits without map-reduce.
_CONTEXT_BUDGET = 30000


async def gather_context(
    *, workspace_id: str, file_ids: list[str] | None, budget: int = _CONTEXT_BUDGET
) -> tuple[str, list[Passage]]:
    """Even coverage of the scope, as numbered passages.

    Documents get an equal share of the budget rather than a share proportional
    to their length: ten pages of lecture notes are as likely to be examinable
    as three hundred pages of reference text, and length is not importance.
    """
    outline = await store.workspace_outline(workspace_id)
    files = [
        f
        for f in outline["files"]
        if (not file_ids or f["id"] in set(file_ids)) and f["chunks"]
    ]
    if not files:
        return "", []
    per_file = max(1, budget // (len(files) * 1200))
    passages: list[Passage] = []
    for file in files:
        rows = await store.read_file_range(
            file_id=file["id"], start=0, count=max(1, per_file)
        )
        passages.extend(Passage.from_row(row) for row in rows)
    body: list[str] = []
    used = 0
    for index, passage in enumerate(passages, start=1):
        piece = passage.as_context(index)
        if used + len(piece) > budget:
            break
        body.append(piece)
        used += len(piece)
    return "\n\n".join(body), passages[: len(body)]


def scope_label(chapters: list[str], file_names: list[str]) -> str:
    parts = []
    if chapters:
        parts.append("chapters " + ", ".join(chapters))
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


def strip_fence(text: str) -> str:
    if not text:
        return ""
    match = re.search(r"```(?:mermaid)?\s*(.+?)\s*```", text, re.DOTALL)
    return (match.group(1) if match else text).strip()


async def produce(
    *, instruction: str, context: str, scope: str, model: str, temperature: float = 0.4
) -> str:
    system = (
        "You create study materials strictly from the provided source passages. "
        "Do not invent facts that are not in them. Follow the requested output "
        "format exactly, with no commentary around it."
    )
    user = instruction
    if scope:
        user += f"\n\nScope: {scope}."
    user += "\n\nSource passages:\n" + (context or "(no indexed content)")
    return await models.complete_text(
        [{"role": "system", "content": system}, {"role": "user", "content": user}],
        model=model,
        temperature=temperature,
    )


async def produce_mapped(
    *, instruction: str, passages: list[Passage], scope: str, model: str, combine: str
) -> str:
    """Map-reduce for scopes too large for one context window.

    Only used when the gathered context overflows: each document is summarized
    against the instruction, then the summaries are combined. It costs more
    calls, so it is not the default path.
    """
    by_file: dict[str, list[Passage]] = {}
    for passage in passages:
        by_file.setdefault(passage.file_id, []).append(passage)
    partials: list[str] = []
    for group in by_file.values():
        context = "\n\n".join(p.as_context(i + 1) for i, p in enumerate(group))[:20000]
        partials.append(
            await produce(
                instruction=instruction, context=context, scope=scope, model=model
            )
        )
    return await models.complete_text(
        [
            {"role": "system", "content": combine},
            {"role": "user", "content": "\n\n---\n\n".join(partials)[:30000]},
        ],
        model=model,
        temperature=0.3,
    )


def normalize_questions(
    data: Any, level_aliases: dict[str, str]
) -> list[dict[str, Any]]:
    """Coerce the model's quiz JSON into the shape the frontend runner expects."""
    import secrets

    questions: list[dict[str, Any]] = []
    for item in data or []:
        if not isinstance(item, dict):
            continue
        item.setdefault("id", f"q_{secrets.token_hex(5)}")
        if "level" not in item and "difficulty" in item:
            item["level"] = level_aliases.get(item.pop("difficulty"), "application")
        item.setdefault("level", "application")
        if item.get("type") in ("mcq", "multi") and isinstance(
            item.get("options"), list
        ):
            item["options"] = [
                opt if isinstance(opt, dict) else {"value": str(opt), "explanation": ""}
                for opt in item["options"]
            ]
        questions.append(item)
    return questions


def overflows(context: str, passages: list[Passage]) -> bool:
    return len(context) >= _CONTEXT_BUDGET and len({p.file_id for p in passages}) > 1
