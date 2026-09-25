"""What changed between two indexed versions, and the delta-summary prompts.

Two ways to describe a refresh to the summary model:

- chunk mode: the chunks whose indexed_text is new (what index_file already
  embeds as ``missing``) and the published chunks whose indexed_text is gone.
  Reflow after an edit re-splits unchanged text, so these lists carry much
  unchanged prose.
- diff mode: the same two versions reduced to net text changes. Chunk overlap
  is removed (a chunk repeats the trailing blocks of the chunk before it), the
  block sequences are aligned, and inside each changed block range a word diff
  drops text that only moved between blocks or pages.
"""

from __future__ import annotations

import difflib
import re
import sys
import unicodedata
from dataclasses import dataclass

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.prompts.ingest import DESCRIPTOR_WORDS
from pipeline.retrieval.chunking import Chunk, estimate_tokens

# ------------------------------------------------------------------ chunk mode


def chunk_delta(old: list[Chunk], new: list[Chunk]) -> tuple[list[Chunk], list[Chunk]]:
    old_texts = {c.indexed_text() for c in old}
    new_texts = {c.indexed_text() for c in new}
    removed, added, seen = [], [], set()
    for c in old:
        t = c.indexed_text()
        if t not in new_texts and t not in seen:
            removed.append(c)
            seen.add(t)
    seen = set()
    for c in new:
        t = c.indexed_text()
        if t not in old_texts and t not in seen:
            added.append(c)
            seen.add(t)
    return removed, added


# ------------------------------------------------------------------- diff mode


def _key(text: str) -> str:
    """Comparison key: ligatures folded, whitespace ignored. Figure labels and
    ligatures come back from the parser with different spacing or glyphs when
    the page layout moves, without any edit."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def _blocks(chunks: list[Chunk], headings: set[str]) -> list[tuple[str, str]]:
    """(section path, line) in reading order, chunk overlap and retained
    heading lines removed. Heading retention repeats a heading in the chunk
    text depending on where the chunk starts, so heading lines come and go
    with reflow; the section path still carries them."""
    out: list[tuple[str, str]] = []
    previous: list[str] = []
    for chunk in chunks:
        blocks = [b for b in chunk.text.split("\n") if b.strip()]
        carry = 0
        for k in range(min(len(previous), len(blocks)), 0, -1):
            if previous[-k:] == blocks[:k]:
                carry = k
                break
        out.extend(
            (chunk.section_path, b) for b in blocks[carry:] if _key(b) not in headings
        )
        previous = blocks
    return out


def _headings(*versions: list[Chunk]) -> set[str]:
    return {
        _key(part)
        for chunks in versions
        for chunk in chunks
        for part in chunk.section_path.split(" › ")
        if part.strip()
    }


@dataclass
class Change:
    section: str
    removed: str
    added: str

    def tokens(self) -> int:
        return estimate_tokens(self.removed) + estimate_tokens(self.added)


def _merge(ops: list[tuple[int, int, int, int]], gap: int) -> list[list[int]]:
    merged: list[list[int]] = []
    for i1, i2, j1, j2 in ops:
        if merged and i1 - merged[-1][1] <= gap and j1 - merged[-1][3] <= gap:
            merged[-1][1] = i2
            merged[-1][3] = j2
        else:
            merged.append([i1, i2, j1, j2])
    return merged


def text_changes(old: list[Chunk], new: list[Chunk], gap: int = 12) -> list[Change]:
    headings = _headings(old, new)
    a = _blocks(old, headings)
    b = _blocks(new, headings)
    blocks = difflib.SequenceMatcher(
        None, [_key(t) for _, t in a], [_key(t) for _, t in b], autojunk=False
    )
    changes: list[Change] = []
    ranges = [
        (i1, i2, j1, j2)
        for tag, i1, i2, j1, j2 in blocks.get_opcodes()
        if tag != "equal"
    ]
    for i1, i2, j1, j2 in _merge(ranges, 1):
        aw = [(p, w) for p, t in a[i1:i2] for w in t.split()]
        bw = [(p, w) for p, t in b[j1:j2] for w in t.split()]
        words = difflib.SequenceMatcher(
            None,
            [unicodedata.normalize("NFKC", w) for _, w in aw],
            [unicodedata.normalize("NFKC", w) for _, w in bw],
            autojunk=False,
        )
        ops = [
            (x1, x2, y1, y2)
            for tag, x1, x2, y1, y2 in words.get_opcodes()
            if tag != "equal"
        ]
        for x1, x2, y1, y2 in _merge(ops, gap):
            removed = " ".join(w for _, w in aw[x1:x2])
            added = " ".join(w for _, w in bw[y1:y2])
            if _key(removed) == _key(added):
                continue  # only spacing or glyph forms moved
            section = bw[y1][0] if y2 > y1 else aw[x1][0]
            changes.append(Change(section=section, removed=removed, added=added))
    return changes


# --------------------------------------------------------------------- prompts

DELTA_SYSTEM = (
    "You maintain the descriptor and summary of a study document for another "
    "assistant. The document was edited. You get the previous descriptor and "
    "summary, written from the previous version, and the changes since then. "
    "Everything outside the changes is unchanged. Return ONLY JSON: "
    '{"descriptor": "...", "summary": "..."}. Keep what the previous text says '
    "about unchanged parts, in its wording where it still fits. Remove or correct "
    "statements that depend on removed text. Add material from added text only "
    "as far as its share of the whole document warrants: the summary describes "
    "the document, not the edit, and never mentions revisions, versions or "
    "changes. descriptor is one dense sentence of about 50 words naming the "
    "topics covered. summary is a factual overview of the requested length. "
    "Name specific topics, terms and results. No preamble."
)


def _head(
    descriptor: str, summary: str, word_target: int, doc_tokens: int, changed: int
) -> str:
    share = 100 * changed / max(1, doc_tokens)
    return (
        f"Write a descriptor of about {DESCRIPTOR_WORDS} words and a summary of "
        f"about {word_target} words.\n\n"
        f"Previous descriptor:\n{descriptor}\n\nPrevious summary:\n{summary}\n\n"
        f"The document is now about {doc_tokens:,} tokens long; the changes below "
        f"touch about {changed:,} tokens ({share:.1f}%).\n\n"
    )


def chunk_messages(
    descriptor: str,
    summary: str,
    removed: list[Chunk],
    added: list[Chunk],
    word_target: int,
    doc_tokens: int,
) -> list[dict[str, str]]:
    changed = sum(estimate_tokens(c.indexed_text()) for c in removed + added)
    body = _head(descriptor, summary, word_target, doc_tokens, changed)
    body += (
        "Passages removed from the previous version (a passage that was only "
        "re-split can appear in both lists):\n"
    )
    body += (
        "\n\n".join(f"[R{i}] {c.indexed_text()}" for i, c in enumerate(removed, 1))
        or "(none)"
    )
    body += "\n\nPassages added in the new version:\n"
    body += (
        "\n\n".join(f"[A{i}] {c.indexed_text()}" for i, c in enumerate(added, 1))
        or "(none)"
    )
    return [
        {"role": "system", "content": DELTA_SYSTEM},
        {"role": "user", "content": body},
    ]


def diff_messages(
    descriptor: str,
    summary: str,
    changes: list[Change],
    word_target: int,
    doc_tokens: int,
) -> list[dict[str, str]]:
    changed = sum(c.tokens() for c in changes)
    body = _head(descriptor, summary, word_target, doc_tokens, changed)
    body += "Changes, in document order, with the section each belongs to:\n"
    lines = []
    for i, c in enumerate(changes, 1):
        part = [f"[{i}] {c.section or '(no section)'}"]
        if c.removed:
            part.append(f"Removed: {c.removed}")
        if c.added:
            part.append(f"Added: {c.added}")
        lines.append("\n".join(part))
    body += "\n\n".join(lines) or "(none)"
    return [
        {"role": "system", "content": DELTA_SYSTEM},
        {"role": "user", "content": body},
    ]


# ------------------------------------------------------------------ prompt v2
# v1 failures on the chapter chain: deleted mosaic-plot text was summarized as
# if it were new, summaries grew to the 500-word cap and truncation cut the
# closing case study, and a 3% insertion took a fifth of the summary.

DELTA_SYSTEM_V2 = """You maintain the descriptor and summary of a study document for another assistant. The document has been edited. You receive the previous descriptor and summary, written from the previous version, the current outline of the document, and the edits: for each, the section it is in, the text deleted from the document and the text inserted into it. Everything else is unchanged.

Rewrite the descriptor and summary so they describe the current document:
- Deleted text is no longer in the document. Remove every statement that relies on it (topics, examples, numbers, results). Never take content from deleted text.
- Inserted text is now in the document. Give it space in proportion to its share of the whole document: a small insertion gets at most a short phrase, and minor detail gets nothing.
- Keep what the previous summary says about unchanged parts, in its wording where it still fits.
- Stay within the requested length: when adding, shorten or merge other sentences instead of growing.
- Describe the document, not the edit: never mention edits, revisions, versions, or what was added or removed.

Return ONLY JSON: {"descriptor": "...", "summary": "..."}. descriptor is one dense sentence of about 50 words naming the topics covered. summary is a factual overview of the requested length. Name specific topics, terms and results. No preamble."""


def outline(chunks: list[Chunk], depth: int = 3) -> str:
    """Current headings in reading order, indented by depth."""
    seen: set[tuple[str, ...]] = set()
    lines: list[str] = []
    for chunk in chunks:
        parts = tuple(p for p in chunk.section_path.split(" › ") if p.strip())[:depth]
        for d in range(1, len(parts) + 1):
            if parts[:d] not in seen:
                seen.add(parts[:d])
                lines.append("  " * (d - 1) + parts[d - 1])
    return "\n".join(lines)


def _head_v2(
    descriptor, summary, word_target, doc_tokens, changed, current_outline
) -> str:
    share = 100 * changed / max(1, doc_tokens)
    return (
        f"Write a descriptor of about {DESCRIPTOR_WORDS} words and a summary of "
        f"about {word_target} words (no more).\n\n"
        f"Previous descriptor:\n{descriptor}\n\nPrevious summary:\n{summary}\n\n"
        f"Current outline:\n{current_outline}\n\n"
        f"The document is now about {doc_tokens:,} tokens long. The edits below "
        f"touch about {changed:,} tokens ({share:.1f}%).\n\n"
    )


def diff_messages_v2(
    descriptor, summary, changes, word_target, doc_tokens, current_outline
):
    changed = sum(c.tokens() for c in changes)
    body = _head_v2(
        descriptor, summary, word_target, doc_tokens, changed, current_outline
    )
    body += "Edits in document order:\n"
    lines = []
    for i, c in enumerate(changes, 1):
        part = [f"[{i}] In: {c.section or '(no section)'}"]
        if c.removed:
            part.append(f"Deleted (no longer in the document): {c.removed}")
        if c.added:
            part.append(f"Inserted: {c.added}")
        lines.append("\n".join(part))
    body += "\n\n".join(lines) or "(none)"
    return [
        {"role": "system", "content": DELTA_SYSTEM_V2},
        {"role": "user", "content": body},
    ]


def chunk_messages_v2(
    descriptor, summary, removed, added, word_target, doc_tokens, current_outline
):
    changed = sum(estimate_tokens(c.indexed_text()) for c in removed + added)
    body = _head_v2(
        descriptor, summary, word_target, doc_tokens, changed, current_outline
    )
    body += (
        "Passages of the previous version that are no longer in the document as "
        "written (text that was only re-split between passages also appears among "
        "the inserted passages; only text missing from every inserted passage was "
        "deleted):\n"
    )
    body += (
        "\n\n".join(f"[D{i}] {c.indexed_text()}" for i, c in enumerate(removed, 1))
        or "(none)"
    )
    body += "\n\nInserted passages:\n"
    body += (
        "\n\n".join(f"[I{i}] {c.indexed_text()}" for i, c in enumerate(added, 1))
        or "(none)"
    )
    return [
        {"role": "system", "content": DELTA_SYSTEM_V2},
        {"role": "user", "content": body},
    ]


# ------------------------------------------------------------------ prompt v3
# v2 still kept (and once re-described) deleted mosaic-plot content, and its
# lossy outline (the parser missed 2.1.1) made it drop scatterplots. v3 drops
# the outline, names sections that disappeared or appeared (exact, from the
# section paths), and asks for the dropped topics before the rewrite.

DELTA_SYSTEM_V3 = """You maintain the descriptor and summary of a study document for another assistant. The document has been edited. You receive the previous descriptor and summary, written from the previous version, the sections that no longer exist and the sections that are new, and the edits: for each, the section it is in, the text deleted from the document and the text inserted into it. Everything else is unchanged.

Work in two steps.
1. dropped: list every topic, example, number or result in the previous descriptor or summary that relied on deleted text or on a section that no longer exists. Deleted text is gone from the document; never take content from it.
2. Rewrite the descriptor and summary for the current document: leave out everything in dropped, keep what the previous text says about unchanged parts in its wording where it still fits, and give inserted text space in proportion to its share of the whole document (a small insertion gets at most a short phrase; minor detail gets nothing). Stay within the requested length by shortening or merging sentences instead of growing. Describe the document, not the edit: never mention edits, revisions, versions, or what was added or removed.

Return ONLY JSON: {"dropped": ["..."], "descriptor": "...", "summary": "..."}. descriptor is one dense sentence of about 50 words naming the topics covered. summary is a factual overview of the requested length. Name specific topics, terms and results. No preamble."""


def section_changes(old: list[Chunk], new: list[Chunk]) -> tuple[list[str], list[str]]:
    """Section paths present in only one version, in reading order."""

    def paths(chunks):
        out: list[str] = []
        for c in chunks:
            if c.section_path and c.section_path not in out:
                out.append(c.section_path)
        return out

    old_paths, new_paths = paths(old), paths(new)
    gone = [p for p in old_paths if p not in set(new_paths)]
    fresh = [p for p in new_paths if p not in set(old_paths)]
    return gone, fresh


def diff_messages_v3(
    descriptor, summary, changes, word_target, doc_tokens, gone, fresh
):
    changed = sum(c.tokens() for c in changes)
    share = 100 * changed / max(1, doc_tokens)
    body = (
        f"Write a descriptor of about {DESCRIPTOR_WORDS} words and a summary of "
        f"about {word_target} words (no more).\n\n"
        f"Previous descriptor:\n{descriptor}\n\nPrevious summary:\n{summary}\n\n"
        f"The document is now about {doc_tokens:,} tokens long. The edits below "
        f"touch about {changed:,} tokens ({share:.1f}%).\n\n"
        "Sections that no longer exist:\n"
        + ("\n".join(f"- {p}" for p in gone) or "(none)")
        + "\n\nNew sections:\n"
        + ("\n".join(f"- {p}" for p in fresh) or "(none)")
        + "\n\nEdits in document order:\n"
    )
    lines = []
    for i, c in enumerate(changes, 1):
        part = [f"[{i}] In: {c.section or '(no section)'}"]
        if c.removed:
            part.append(f"Deleted (no longer in the document): {c.removed}")
        if c.added:
            part.append(f"Inserted: {c.added}")
        lines.append("\n".join(part))
    body += "\n\n".join(lines) or "(none)"
    return [
        {"role": "system", "content": DELTA_SYSTEM_V3},
        {"role": "user", "content": body},
    ]


# --------------------------------------------------- prompt v4 (insertions only)
# Used only when the net change since the summary's basis is insertion-led and
# small; deletions and large changes go to full regeneration instead.

INSERT_SYSTEM = """You maintain the descriptor and summary of a study document for another assistant. Text was inserted into the document; nothing else changed. You receive the previous descriptor and summary and the inserted text with the section it is in.

Keep the previous descriptor and summary as they are, except where the inserted material deserves mention. Give it space in proportion to its share of the whole document: a small insertion gets at most a short phrase in the summary and a word or two in the descriptor, and minor detail gets nothing. Do not remove or rewrite anything else. Stay within the requested length. Describe the document, not the edit: never mention insertions, revisions or versions.

Return ONLY JSON: {"descriptor": "...", "summary": "..."}. descriptor is one dense sentence of about 50 words naming the topics covered. summary is a factual overview of the requested length. No preamble."""


def insert_messages(descriptor, summary, changes, word_target, doc_tokens):
    inserted = [c for c in changes if c.added]
    changed = sum(estimate_tokens(c.added) for c in inserted)
    share = 100 * changed / max(1, doc_tokens)
    body = (
        f"Write a descriptor of about {DESCRIPTOR_WORDS} words and a summary of "
        f"about {word_target} words (no more).\n\n"
        f"Previous descriptor:\n{descriptor}\n\nPrevious summary:\n{summary}\n\n"
        f"The document is now about {doc_tokens:,} tokens long; the inserted text is "
        f"about {changed:,} tokens ({share:.1f}%).\n\nInserted text:\n"
    )
    body += "\n\n".join(
        f"[{i}] In: {c.section or '(no section)'}\n{c.added}"
        for i, c in enumerate(inserted, 1)
    )
    return [
        {"role": "system", "content": INSERT_SYSTEM},
        {"role": "user", "content": body},
    ]
