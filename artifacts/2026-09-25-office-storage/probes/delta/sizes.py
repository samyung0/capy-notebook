"""Delta input sizes per refresh, without model calls.

For every (published, candidate) pair: tokens a full summary reads today, the
chunk-mode delta (removed + added chunk text), the diff-mode delta (net text
changes), and the share of the document each represents.
"""

from __future__ import annotations

import json
import pickle
import sys
import time
from pathlib import Path

import chunks as chunkmod
import delta

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.indexing import _summary_word_target

HERE = Path(__file__).resolve().parent
PICKLES = HERE / "chunk-cache"

PAIRS = [
    # Cumulative content rounds built for this probe.
    *[(f"c{i}.docx", f"c{i + 1}.docx") for i in range(5)],
    *[(f"b{i}.docx", f"b{i + 1}.docx") for i in range(6)],
    # The reparse probe's BetterOffice exports (first refresh, trivial edits).
    ("book.docx", "book-noedit.docx"),
    ("book-noedit.docx", "book-small.docx"),
    ("book-noedit.docx", "book-section.docx"),
    ("book-noedit.docx", "book-scattered.docx"),
    ("chapter.docx", "chapter-noedit.docx"),
    ("chapter-noedit.docx", "chapter-small.docx"),
    ("chapter-noedit.docx", "chapter-section.docx"),
    ("chapter-noedit.docx", "chapter-scattered.docx"),
]


def load(name: str):
    PICKLES.mkdir(exist_ok=True)
    cache = PICKLES / f"{name}.pkl"
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    chunks = chunkmod.chunks_for(chunkmod.source(name))
    cache.write_bytes(pickle.dumps(chunks))
    return chunks


def body(chunks) -> str:
    return "\n\n".join(c.indexed_text() for c in chunks)


def measure(old_name: str, new_name: str) -> dict:
    old, new = load(old_name), load(new_name)
    removed, added = delta.chunk_delta(old, new)
    t = time.perf_counter()
    changes = delta.text_changes(old, new)
    diff_s = time.perf_counter() - t
    text = body(new)
    full = estimate_tokens(text)
    chunk_tokens = sum(estimate_tokens(c.indexed_text()) for c in removed + added)
    diff_tokens = sum(c.tokens() for c in changes)
    return {
        "pair": f"{old_name} -> {new_name}",
        "chunks_new": len(new),
        "full_tokens": full,
        "word_target": _summary_word_target(len(text)),
        "removed_chunks": len(removed),
        "added_chunks": len(added),
        "chunk_delta_tokens": chunk_tokens,
        "chunk_delta_share": round(100 * chunk_tokens / full, 1),
        "diff_changes": len(changes),
        "diff_tokens": diff_tokens,
        "diff_share": round(100 * diff_tokens / full, 2),
        "diff_seconds": round(diff_s, 2),
    }


if __name__ == "__main__":
    rows = [measure(a, b) for a, b in PAIRS if all(chunkmod.source(x) for x in (a, b))]
    for row in rows:
        print(json.dumps(row))
    (HERE / "sizes.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
