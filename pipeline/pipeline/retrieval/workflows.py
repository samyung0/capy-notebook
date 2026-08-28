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

from ..config import cfg
from . import models, store
from .chunking import estimate_tokens
from .locale import response_language_rule
from .search import Passage

log = logging.getLogger("evo.retrieval.workflows")


class InvalidGenerateScope(ValueError):
    """At least one requested file does not belong to the workspace."""


class GenerateNoContent(ValueError):
    """The resolved generation scope has no indexed passages."""


async def gather_context(
    *, workspace_id: str, file_ids: list[str] | None, budget: int | None = None
) -> tuple[str, list[Passage]]:
    """Even coverage of the scope, as numbered passages.

    Documents get an equal share of the budget rather than a share proportional
    to their length: ten pages of lecture notes are as likely to be examinable
    as three hundred pages of reference text, and length is not importance.
    """
    if budget is None:
        budget = cfg.llm_input_budget_tokens
    outline = await store.workspace_outline(workspace_id)
    known_ids = {str(file["id"]) for file in outline["files"]}
    requested = list(dict.fromkeys(file_ids or []))
    if any(file_id not in known_ids for file_id in requested):
        raise InvalidGenerateScope("The requested scope is invalid or unavailable.")
    files = [
        f
        for f in outline["files"]
        if (not requested or f["id"] in set(requested)) and f["chunks"]
    ]
    if not files:
        return "", []
    # ~400 tokens per packed chunk (EVO_CHUNK_CHARS is 1600 latin chars).
    per_file = max(1, budget // (len(files) * 400))
    passages: list[Passage] = []
    for file in files:
        rows = await store.read_file_range(
            workspace_id=workspace_id,
            file_id=file["id"],
            start=0,
            count=max(1, per_file),
        )
        passages.extend(Passage.from_row(row) for row in rows)
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


class GenerateEmpty(ValueError):
    """The model replied, but nothing in that reply can become a material."""

    def __init__(self, kind: str):
        self.kind = kind
        super().__init__(f"The model returned no usable {kind}.")


def require_text(raw: str, kind: str) -> str:
    text = (raw or "").strip()
    if not text:
        raise GenerateEmpty(kind)
    return text


def require_mermaid(raw: str, kind: str) -> str:
    code = strip_fence(raw)
    if not code:
        raise GenerateEmpty(kind)
    return code


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
) -> str:
    system = (
        "You create study materials strictly from the provided source passages. "
        "Do not invent facts that are not in them. Follow the requested output "
        "format exactly, with no commentary around it.\n"
        + response_language_rule(locale)
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


def _wrap_values(raw: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in raw or []:
        if isinstance(item, dict):
            out.append({"value": str(item.get("value") or "")})
        elif isinstance(item, str):
            out.append({"value": item})
    return out


def normalize_questions(data: Any) -> list[dict[str, Any]]:
    """Coerce the model's quiz JSON into the shape the frontend runner expects."""
    import secrets

    questions: list[dict[str, Any]] = []
    for item in data or []:
        if not isinstance(item, dict):
            continue
        item.setdefault("id", f"q_{secrets.token_hex(5)}")
        item.pop("difficulty", None)
        item.setdefault("level", "application")
        if item.get("type") in ("mcq", "multi") and isinstance(
            item.get("options"), list
        ):
            item["options"] = [
                opt if isinstance(opt, dict) else {"value": str(opt), "explanation": ""}
                for opt in item["options"]
            ]
        if item.get("type") in ("short", "open"):
            item["accepted"] = _wrap_values(item.get("accepted"))
        if item.get("type") == "open":
            item["hints"] = _wrap_values(item.get("hints"))
            item["rubrics"] = _wrap_values(item.get("rubrics"))
        questions.append(item)
    return questions
