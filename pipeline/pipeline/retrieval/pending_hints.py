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
from .lang import FUNCTION_WORDS, TS_CONFIG, UND, detect_lang, is_cjk

# Bounds (the Editor, 2026-10-20): a handful of snippets of about 200
# characters, about 400 tokens a message; candidates are capped because a
# workspace with auto processing off keeps every edit pending.
HINT_LIMIT = 5
HINT_CHARS = 200
HINT_TOKENS = 400
CANDIDATES_MAX = 2000
CANDIDATE_CHARS = 500  # read per change for matching (Epo 2026-10-20)

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
    config: str  # its document's language's text search config
    undetermined: bool  # its document's language is not known


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


# How much of a document's pending text one detection reads.
DETECT_CHARS = 4000


def _prepare(hints: list[Hint], indexed: dict[str, str]) -> list[_Prepared]:
    """Tokens and each document's language (Epo 2026-10-20): the dominant
    language of its indexed chunks, else one detection over its pending
    changes together."""
    langs = dict(indexed)
    joined: dict[str, list[str]] = {}
    for hint in hints:
        if hint.doc_id not in langs:
            joined.setdefault(hint.doc_id, []).append(hint.text)
    for doc_id, texts in joined.items():
        langs[doc_id] = detect_lang(" ".join(texts)[:DETECT_CHARS])
    return [
        _Prepared(
            hint,
            tokenize_for_search(hint.text),
            TS_CONFIG[langs[hint.doc_id]],
            langs[hint.doc_id] == UND,
        )
        for hint in hints
    ]


async def _indexed_langs(doc_ids: list[str]) -> dict[str, str]:
    """Each document's dominant language among its indexed chunks of a known
    language; documents with none are left out."""
    if not doc_ids:
        return {}
    db = await store.pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """SELECT doc, lang FROM (
                SELECT doc, c.lang,
                    row_number() OVER (PARTITION BY doc ORDER BY count(*) DESC, c.lang) AS r
                FROM (
                    SELECT file_id AS doc, content_id FROM rag_file_contents WHERE file_id = ANY(%s)
                    UNION ALL
                    SELECT material_id, content_id FROM rag_material_contents WHERE material_id = ANY(%s)
                ) d JOIN rag_chunks c ON c.content_id = d.content_id
                WHERE c.lang <> %s
                GROUP BY doc, c.lang) ranked
            WHERE r = 1""",
            (doc_ids, doc_ids, UND),
        )
        return {row["doc"]: row["lang"] for row in await cur.fetchall()}


async def prepared(sources: Any) -> list[_Prepared]:
    """The turn's candidates with their search tokens and configs, computed
    once per PendingSources (a reload starts over), the tokenizing and
    detection off the event loop: 2,000 texts take about a second."""
    if sources.hint_pool is None:
        hints = candidates(sources)
        indexed = await _indexed_langs(sorted({hint.doc_id for hint in hints}))
        sources.hint_pool = await asyncio.to_thread(_prepare, hints, indexed)
    return sources.hint_pool


async def match(
    query: str, pool: list[_Prepared], limit: int = HINT_LIMIT
) -> list[Hint]:
    """The best lexical matches of ``query`` among ``pool``: the search
    tokenizer (ligature, sub/superscript and CJK folds) on both sides and each
    document's language's text search config. For a document of undetermined
    language the query's words on Postgres's English, French, German and
    Spanish stopword lists are dropped first (Epo 2026-10-20): its ``simple``
    config keeps every word, so "the" would match almost anything."""
    any_of = search_query_terms(query).any_of
    if not pool or not any_of:
        return []
    db = await store.pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """WITH plain AS (
                SELECT coalesce(string_agg(w, ' or '), '') AS q
                FROM unnest(string_to_array(%(any)s, ' or ')) AS w
                WHERE NOT EXISTS (
                    SELECT 1 FROM unnest(ARRAY['english_stem', 'french_stem',
                        'german_stem', 'spanish_stem']::regdictionary[]) AS d
                    WHERE ts_lexize(d, lower(w)) = '{}'::text[])),
            m AS MATERIALIZED (
                SELECT c.ord, to_tsvector(c.cfg, c.t) AS v,
                    websearch_to_tsquery(c.cfg, CASE WHEN c.und THEN plain.q ELSE %(any)s END) AS q
                FROM unnest(%(texts)s::text[], %(cfgs)s::regconfig[], %(und)s::boolean[])
                    WITH ORDINALITY AS c(t, cfg, und, ord)
                CROSS JOIN plain)
            SELECT ord FROM m WHERE v @@ q ORDER BY ts_rank(v, q) DESC, ord LIMIT %(limit)s""",
            {
                "any": any_of,
                "texts": [p.tokens for p in pool],
                "cfgs": [p.config for p in pool],
                "und": [p.undetermined for p in pool],
                "limit": limit,
            },
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


def _probes(query: str) -> list[str]:
    """What locates a query in a hint's text, longest first: whole Latin
    words that are not function words, and each CJK run's bigrams."""
    folded, _ = _folded(query)
    probes: list[str] = []
    for token in re.findall(r"\w+", folded):
        if any(is_cjk(ch) for ch in token):
            probes.extend(token[i : i + 2] for i in range(max(1, len(token) - 1)))
        elif len(token) > 1 and token not in FUNCTION_WORDS:
            probes.append(token)
    return sorted(dict.fromkeys(probes), key=len, reverse=True)


def snippet(hint: Hint, query: str) -> str:
    """At most HINT_CHARS of the hint's text, around the longest query word
    it holds (the earliest among equals), found in the original text."""
    text = re.sub(r"\s+", " ", hint.text)
    if len(text) <= HINT_CHARS:
        return text
    folded, origin = _folded(text)
    found = 0
    probes = _probes(query)
    for size in sorted({len(p) for p in probes}, reverse=True):
        hits = [i for p in probes if len(p) == size for i in [folded.find(p)] if i >= 0]
        if hits:
            found = origin[min(hits)]
            break
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


# One heading for the live message and its replay, true at both times, so a
# replayed request repeats the earlier one word for word (a cached prefix).
MESSAGE_HEADING = (
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
    hints: list[tuple[Hint, str]], *, message_id: str = ""
) -> dict[str, Any] | None:
    """The hint message that follows a user message (None: nothing fits),
    with the hints it shows."""
    block, kept = render(hints, MESSAGE_HEADING)
    if not kept:
        return None
    return {
        "id": message_id,
        "role": "user",
        "content": block,
        "_kind": KIND,
        "_hints": kept,
    }


def for_summary(item: dict[str, Any]) -> dict[str, Any] | None:
    """A message as condensing folds it: hints stay in context until the chat
    is condensed, which drops every one, a search's listed edits included
    (Epo 2026-10-20); a read document's details stay through its read result."""
    if item.get("_kind") == KIND:
        return None
    tail = item.get("_hint_tail")
    if tail:
        # A search result's unindexed edits (tools.limit_tool_result's tail).
        # rpartition: a notice appended after the tail (agent.py's
        # last-with-tools notice) must not keep the edits in.
        head, cut, after = str(item.get("content") or "").rpartition("\n\n" + tail)
        content = head + after if cut else str(item.get("content") or "")
        return {k: v for k, v in item.items() if k != "_hint_tail"} | {
            "content": content
        }
    return item


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


def replayed(hints: list[tuple[Hint, str]]) -> list[tuple[Hint, str]]:
    """Saved hints as they were shown: they stay in context until condensing,
    so earlier requests remain a cached prefix (Epo 2026-10-20)."""
    return [(replace(hint, text=text), text) for hint, text in hints]
