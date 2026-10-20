"""The pending-hints eval workspace (bench/rag/fixtures/hints-eval/).

Turns workspace.json (and optionally busy.json) into what production holds:
- each document's current blocks, with its edits applied;
- its pending effects, in the shapes Go (notes, materialdoc/note_effects.go)
  and Rust (Office, sources/src/effects.rs trim_effect) produce: a replacement
  keeps 40 UTF-16 units of context on each side, '…' marking a cut; an Office
  addition has no before and a removal no after;
- a pipeline PendingSources holding them (files and notes);
- the chunks the index holds, for the database and for each document's
  indexed language.

Pure: no database, no network. Imported by hints_eval_matcher.py and
hints_eval_agent.py.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "hints-eval"
CONTEXT = 40  # EFFECT_CONTEXT_CHARS / NoteEffectContext


def _units(text: str) -> list[int]:
    raw = text.encode("utf-16-le")
    return [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]


def _string(units: list[int]) -> str:
    return b"".join(u.to_bytes(2, "little") for u in units).decode("utf-16-le")


def _low(units: list[int], at: int) -> bool:
    return at < len(units) and 0xDC00 <= units[at] <= 0xDFFF


def _common_ends(a: list[int], b: list[int]) -> tuple[int, int]:
    prefix = 0
    while prefix < len(a) and prefix < len(b) and a[prefix] == b[prefix]:
        prefix += 1
    suffix = 0
    while (
        suffix < len(a) - prefix
        and suffix < len(b) - prefix
        and a[len(a) - 1 - suffix] == b[len(b) - 1 - suffix]
    ):
        suffix += 1
    return prefix, suffix


def trim(before: str, after: str) -> tuple[str, str]:
    """Go's trimChange and Rust's trim_effect: the changed span plus CONTEXT
    units on each side."""
    b, a = _units(before), _units(after)
    prefix, suffix = _common_ends(b, a)

    def cut(text: list[int]) -> str:
        start = max(prefix - CONTEXT, 0)
        end = len(text) - max(suffix - CONTEXT, 0)
        if start > 0 and _low(text, start):
            start -= 1
        if end < len(text) and _low(text, end):
            end += 1
        out = _string(text[start:end])
        return ("…" if start > 0 else "") + out + ("…" if end < len(text) else "")

    return cut(b), cut(a)


@dataclass
class Document:
    id: str
    kind: str  # "file" or "material"
    format: str  # note, xlsx, docx, pptx, text, pdf
    name: str
    chapter: str | None
    blocks: list[dict[str, Any]]  # as indexed
    current: list[dict[str, Any]]  # with the edits applied
    chunks: list[dict[str, Any]]  # {"text", "section_path"} as indexed
    changes: list[dict[str, Any]] = field(default_factory=list)
    edits: dict[str, dict[str, Any]] = field(default_factory=dict)  # change id -> edit


def _apply(blocks: list[dict[str, Any]], edits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    current = [dict(b) for b in blocks]
    for edit in edits:
        ids = [b["id"] for b in current]
        if edit["op"] == "replace":
            current[ids.index(edit["block"])]["text"] = edit["text"]
        elif edit["op"] == "remove":
            current.pop(ids.index(edit["block"]))
        elif edit["op"] == "add":
            block = {"id": edit["block"], "text": edit["text"]}
            if edit.get("type"):
                block["type"] = edit["type"]
            current.insert(ids.index(edit["after"]) + 1, block)
        else:
            raise ValueError(edit)
    return current


def _note_changes(doc: dict[str, Any], current: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """NoteChanges: added and changed blocks in the note's order, then removed
    blocks in the indexed order; labels as blockLabel."""
    before = {b["id"]: b for b in doc["blocks"]}
    by_block = {e["block"]: e for e in doc.get("edits", [])}
    out = []
    for block in current:
        prev = before.get(block["id"])
        if prev is not None and prev["text"] == block["text"]:
            continue
        old, new = trim(prev["text"] if prev else "", block["text"])
        out.append(
            {
                "id": by_block[block["id"]]["id"],
                "kind": "text",
                "operation": "replace" if prev else "add",
                "label": f"{block.get('type') or 'block'} {block['id']}",
                "before": old,
                "after": new,
                "blockId": block["id"],
            }
        )
    kept = {b["id"] for b in current}
    for block in doc["blocks"]:
        if block["id"] not in kept:
            out.append(
                {
                    "id": by_block[block["id"]]["id"],
                    "kind": "text",
                    "operation": "remove",
                    "label": f"{block.get('type') or 'block'} {block['id']}",
                    "before": block["text"],
                    "after": "",
                    "blockId": block["id"],
                }
            )
    return out


def _office_changes(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Office (and text) effects, labelled by their entry (Slide N, Shape;
    Sheet!A1; story, paragraph N; Line N)."""
    before = {b["id"]: b["text"] for b in doc["blocks"]}
    out = []
    for edit in doc.get("edits", []):
        change = {"id": edit["id"], "kind": "text", "label": edit["block"]}
        if edit["op"] == "replace":
            old, new = trim(before[edit["block"]], edit["text"])
            change.update(operation="replace", before=old, after=new)
        elif edit["op"] == "add":
            change.update(operation="add", after=edit["text"])
        else:
            change.update(operation="remove", before=before[edit["block"]])
        out.append(change)
    return out


def _chunks(doc: dict[str, Any]) -> list[dict[str, Any]]:
    if doc.get("chunk_texts"):
        return [
            {"text": text, "section_path": text.split("\n", 1)[0]}
            for text in doc["chunk_texts"]
        ]
    by_id = {b["id"]: b for b in doc["blocks"]}
    out = []
    for group in doc["chunks"]:
        blocks = [by_id[i] for i in group]
        heading = next(
            (b["text"] for b in blocks if str(b.get("type", "")).startswith("h")), ""
        )
        out.append(
            {"text": "\n".join(b["text"] for b in blocks), "section_path": heading}
        )
    return out


def _busy_doc(doc: dict[str, Any]) -> dict[str, Any]:
    """busy.json lists its added paragraphs; make them edits."""
    doc = dict(doc)
    edits = []
    last = doc["blocks"][-1]["id"]
    for n, text in enumerate(doc.pop("added"), start=1):
        block = f"a{n}"
        edits.append(
            {"id": f"guide-{n:02d}", "op": "add", "after": last, "block": block, "type": "p", "text": text}
        )
        last = block
    doc["edits"] = edits
    return doc


def load(*, busy: bool = False) -> list[Document]:
    raw = json.loads((FIXTURES / "workspace.json").read_text(encoding="utf-8"))
    docs = list(raw["documents"])
    if busy:
        extra = json.loads((FIXTURES / "busy.json").read_text(encoding="utf-8"))
        docs += [_busy_doc(d) for d in extra["documents"]]
    out = []
    for doc in docs:
        blocks = doc.get("blocks") or []
        edits = doc.get("edits") or []
        current = _apply(blocks, edits)
        if not edits:
            changes = []
        elif doc["format"] == "note":
            changes = _note_changes(doc, current)
        else:
            changes = _office_changes(doc)
        out.append(
            Document(
                id=doc["id"],
                kind=doc["kind"],
                format=doc["format"],
                name=doc["name"],
                chapter=doc.get("chapter"),
                blocks=blocks,
                current=current,
                chunks=_chunks(doc),
                changes=changes,
                edits={e["id"]: e for e in edits},
            )
        )
    return out


def workspace_meta() -> dict[str, Any]:
    raw = json.loads((FIXTURES / "workspace.json").read_text(encoding="utf-8"))
    return {"workspace": raw["workspace"], "chapters": raw["chapters"]}


def pending_sources(docs: list[Document], extra: dict[str, list[dict[str, Any]]] | None = None):
    """A pipeline PendingSources with every document's pending effects, as
    pending.load builds it (files from source_documents, notes from Go).
    ``extra`` adds changes per document id (junk for the agent eval)."""
    from pipeline.retrieval import pending

    extra = extra or {}
    files, notes = [], []
    for doc in docs:
        changes = doc.changes + extra.get(doc.id, [])
        if not changes:
            continue
        if doc.kind == "file":
            files.append(
                {
                    "fileId": doc.id,
                    "name": doc.name,
                    "epoch": 1,
                    "checkpoint": 2,
                    "indexedCheckpoint": 1,
                    "changes": changes,
                }
            )
        else:
            notes.append(
                {"materialId": doc.id, "title": doc.name, "revision": 2, "changes": changes}
            )
    return pending.PendingSources(files, notes=notes)


def indexed_langs(docs: list[Document]) -> dict[str, str]:
    """Each document's dominant language among its indexed chunks of a known
    language (pending_hints._indexed_langs over rag_chunks.lang, which
    indexing sets with detect_lang per chunk)."""
    from collections import Counter

    from pipeline.retrieval.lang import UND, detect_lang

    out = {}
    for doc in docs:
        counts = Counter(detect_lang(c["text"]) for c in doc.chunks)
        counts.pop(UND, None)
        if counts:
            out[doc.id] = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return out


def change_doc(docs: list[Document]) -> dict[str, Document]:
    return {c["id"]: d for d in docs for c in d.changes}
