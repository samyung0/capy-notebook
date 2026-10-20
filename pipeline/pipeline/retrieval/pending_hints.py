"""Unindexed edits stay findable (Epo 2026-10-20).

Pending changes reach the agent only once it reads their document
(``pending.PendingSources.read_ids``), and they are not in the search index
yet. A cheap lexical match of their text keeps them findable: the user's words
pick a few short hints that ride with the user message, and the agent's search
lists matching edits after its passages. Both name the document and the block
or change to read, and say what happened: "added" or "changed" with the new
text, "removed" with the old. No chunking, no vectors, no provider call.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, replace
from typing import Any

from ..prompts.sources import source_block
from . import store
from .chunking import (
    SEARCH_FOLD,
    estimate_tokens,
    search_query_terms,
    tokenize_for_search,
)
from .lang import TS_CONFIG, detect_lang

# Bounds (the Editor, 2026-10-20): a handful of snippets of about 200
# characters, about 400 tokens a message; candidates are capped because a
# workspace with auto processing off keeps every edit pending.
HINT_LIMIT = 5
HINT_CHARS = 200
HINT_TOKENS = 400
CANDIDATES_MAX = 2000
CANDIDATE_CHARS = 2000

_VERBS = {"add": "added", "replace": "changed", "remove": "removed"}

KIND = "pending_hints"  # the hint message's _kind


@dataclass(frozen=True)
class Hint:
    doc_id: str
    kind: str  # "file" or "material"
    name: str
    change_id: str
    where: str  # the change's label or block
    verb: str  # added, changed or removed
    text: str  # the new text, or the old for a removal; the snippet once saved

    @property
    def key(self) -> tuple[str, str]:
        return (self.doc_id, self.change_id)

    def line(self, snippet: str) -> str:
        target = "file_id" if self.kind == "file" else "material_id"
        parts = [json.dumps(self.name, ensure_ascii=False), f"{target}={self.doc_id}"]
        if self.where:
            parts.append(json.dumps(self.where, ensure_ascii=False))
        quoted = f" {json.dumps(snippet, ensure_ascii=False)}" if snippet else ""
        return f"- {', '.join(parts)}: {self.verb}{quoted}"


@dataclass(frozen=True)
class _Prepared:
    hint: Hint
    tokens: str  # the text through the search tokenizer
    config: str  # its language's text search config


def candidates(sources: Any) -> list[Hint]:
    """The turn's captured changes that can be hinted: added, changed and
    removed text, or a placeholder by its label; moves are left out. Taken
    round-robin across documents, so many changes in one file do not starve
    the others, up to CANDIDATES_MAX."""
    per_doc: list[list[Hint]] = []

    def collect(doc_id: str, kind: str, name: str, changes: list, block: bool):
        hints = []
        for change in changes or []:
            verb = _VERBS.get(str(change.get("operation") or ""))
            if verb is None:
                continue
            text = change.get("before") if verb == "removed" else change.get("after")
            label = str(change.get("label") or "")
            where = (
                f"block {change['blockId']}" if block and change.get("blockId") else ""
            )
            if text:
                # A file change names its place by its label; a note's by its block.
                where = where or label
            else:
                text = label  # shown once, as the snippet
            text = str(text)[:CANDIDATE_CHARS].strip()
            if text:
                hints.append(
                    Hint(
                        doc_id,
                        kind,
                        name,
                        str(change.get("id") or ""),
                        where,
                        verb,
                        text,
                    )
                )
        if hints:
            per_doc.append(hints)

    for file in sources.files:
        collect(
            str(file["fileId"]),
            "file",
            str(file.get("name") or ""),
            file.get("changes"),
            False,
        )
    for note in sources.notes:
        collect(
            str(note["materialId"]),
            "material",
            str(note.get("title") or ""),
            note.get("changes"),
            True,
        )
    out: list[Hint] = []
    depth = 0
    while len(out) < CANDIDATES_MAX and any(depth < len(d) for d in per_doc):
        out.extend(d[depth] for d in per_doc if depth < len(d))
        depth += 1
    return out[:CANDIDATES_MAX]


def _prepare(hints: list[Hint]) -> list[_Prepared]:
    return [
        _Prepared(
            hint, tokenize_for_search(hint.text), TS_CONFIG[detect_lang(hint.text)]
        )
        for hint in hints
    ]


async def prepared(sources: Any) -> list[_Prepared]:
    """The turn's candidates with their search tokens and configs, computed
    once per PendingSources (a reload starts over) and off the event loop:
    tokenizing and detecting 2,000 long texts takes seconds."""
    if sources.hint_pool is None:
        sources.hint_pool = await asyncio.to_thread(_prepare, candidates(sources))
    return sources.hint_pool


async def match(
    query: str, pool: list[_Prepared], limit: int = HINT_LIMIT
) -> list[Hint]:
    """The best lexical matches of ``query`` among ``pool``: the search
    tokenizer (ligature, sub/superscript and CJK folds) on both sides and each
    edit's own language's text search config, as search ranks chunks."""
    any_of = search_query_terms(query).any_of
    if not pool or not any_of:
        return []
    db = await store.pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """WITH m AS MATERIALIZED (
                SELECT c.ord, to_tsvector(c.cfg, c.t) AS v, websearch_to_tsquery(c.cfg, %s) AS q
                FROM unnest(%s::text[], %s::regconfig[]) WITH ORDINALITY AS c(t, cfg, ord))
            SELECT ord FROM m WHERE v @@ q ORDER BY ts_rank(v, q) DESC, ord LIMIT %s""",
            (any_of, [p.tokens for p in pool], [p.config for p in pool], limit),
        )
        return [pool[row["ord"] - 1].hint for row in await cur.fetchall()]


def _folded(text: str) -> tuple[str, list[int]]:
    """``text`` casefolded with the search folds, and each folded character's
    position in ``text`` (a ligature folds to two characters)."""
    out: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        folded = ch.translate(SEARCH_FOLD).casefold()
        out.append(folded)
        origin.extend([i] * len(folded))
    return "".join(out), origin


def snippet(hint: Hint, query: str) -> str:
    """At most HINT_CHARS of the hint's text, around its first query word,
    found in the original text (a CJK run, or its first two characters)."""
    text = re.sub(r"\s+", " ", hint.text)
    if len(text) <= HINT_CHARS:
        return text
    folded, origin = _folded(text)
    q, _ = _folded(query)
    words = [w for w in re.findall(r"\w+", q) if len(w) > 1]
    probes = words + [w[:2] for w in words if len(w) > 2]
    hits = [i for i in (folded.find(w) for w in probes) if i >= 0]
    found = origin[min(hits)] if hits else 0
    start = max(0, min(found - HINT_CHARS // 4, len(text) - HINT_CHARS))
    cut = text[start : start + HINT_CHARS - 2]
    return ("…" if start else "") + cut + ("…" if start + len(cut) < len(text) else "")


def render(
    hints: list[tuple[Hint, str]], heading: str
) -> tuple[str, list[tuple[Hint, str]]]:
    """The hint block and the hints it holds: hints are dropped from the end
    until it fits HINT_TOKENS. The lines are source data, in a <source> block."""
    kept = list(hints)
    while kept:
        block = heading + "\n" + source_block("\n".join(h.line(s) for h, s in kept))
        if estimate_tokens(block) <= HINT_TOKENS:
            return block, kept
        kept.pop()
    return "", []


MESSAGE_HEADING = (
    "Unindexed edits matching the user's message above, not in search yet. "
    "Read the document to see them."
)
REPLAY_HEADING = (
    "Unindexed edits that matched the user's message above when it was sent "
    "(not in search then). Read the document to see what they say now."
)
SEARCH_HEADING = (
    "Unindexed edits matching this search, not in the index yet and not "
    "citable. Read the document to see them."
)


async def for_message(
    query: str, sources: Any, *, skip: set[tuple[str, str]]
) -> list[tuple[Hint, str]]:
    """Hints for a user message: unread documents' edits matching its words,
    leaving out those in ``skip`` (hinted before in the conversation)."""
    read = sources.read_ids or set()
    pool = [
        p
        for p in await prepared(sources)
        if p.hint.doc_id not in read and p.hint.key not in skip
    ]
    return [(hint, snippet(hint, query)) for hint in await match(query, pool)]


def message(
    hints: list[tuple[Hint, str]],
    *,
    heading: str = MESSAGE_HEADING,
    read: set[str] | None = None,
    message_id: str = "",
) -> dict[str, Any] | None:
    """The hint message that follows a user message (None: nothing fits). It
    keeps the hints it shows and the documents read since, so compaction can
    drop the hints whose document was never read (``for_summary``)."""
    block, kept = render(hints, heading)
    if not kept:
        return None
    return {
        "id": message_id,
        "role": "user",
        "content": block,
        "_kind": KIND,
        "_hints": kept,
        "_heading": heading,
        "_read": set(read or ()),
    }


def mark_read(messages: list[dict[str, Any]], read: set[str] | None) -> None:
    """Count the documents read so far this turn before a fold."""
    for item in messages:
        if item.get("_kind") == KIND and read:
            item["_read"] = set(item.get("_read") or ()) | read


def for_summary(item: dict[str, Any]) -> dict[str, Any] | None:
    """A message as compaction folds it: a hint message keeps only the hints
    whose document was read (Epo 2026-10-20), or goes."""
    if item.get("_kind") != KIND:
        return item
    read = item.get("_read") or set()
    kept = [(h, s) for h, s in item.get("_hints") or [] if h.doc_id in read]
    if not kept:
        return None
    block, kept = render(kept, item.get("_heading") or MESSAGE_HEADING)
    return {"role": "user", "content": block, "_kind": KIND} if kept else None


_SAVED = {"doc_id": "docId", "change_id": "changeId"}


def pack(hints: list[tuple[Hint, str]]) -> list[dict[str, Any]]:
    """The hints shown with the turn's message, as toolEvidence.pendingHints:
    the snippet only, not the candidate text."""
    out = []
    for hint, text in hints:
        fields = {
            _SAVED.get(name, name): getattr(hint, name)
            for name in Hint.__dataclass_fields__
            if name != "text"
        }
        out.append({**fields, "snippet": text})
    return out


def unpack(saved: list[dict[str, Any]]) -> list[tuple[Hint, str]]:
    out = []
    for item in saved:
        fields = {
            name: str(item.get(_SAVED.get(name, name)) or "")
            for name in Hint.__dataclass_fields__
            if name != "text"
        }
        text = str(item.get("snippet") or "")
        out.append((Hint(**fields, text=text), text))
    return out


def replayed(hints: list[tuple[Hint, str]], sources: Any) -> list[tuple[Hint, str]]:
    """Saved hints still worth replaying: their document is in this turn's
    scope and still has pending changes (not trashed, processed or out of
    scope)."""
    pending = {str(f["fileId"]) for f in sources.files} | {
        str(n["materialId"]) for n in sources.notes
    }
    return [(replace(h, text=s), s) for h, s in hints if h.doc_id in pending]
