"""Full regeneration versus delta updates over the cumulative edit rounds.

For each document (chapter c0..c5, book b0..b6):
- full-<round>-a: the production summary call over every chunk of that round
  (pipeline.prompts.ingest.summary_messages, parse and truncation from
  indexing.py). Round 0 is re-rolled twice more (-b, -c) and the last round
  once (-b) to measure how much two full runs differ on the same input.
- delta chains in chunk mode and diff mode: round k is updated from round
  k-1's delta summary plus the changes between the two versions. Round 0 of
  each chain is full-<round0>-a.

The chapter crosses the 100k-character word-target boundary between rounds
(500 -> 300 -> 500 words); every call on it uses 500 words so the arms stay
comparable. The book is 500 words in every round anyway.
Usage: python run.py chapter|book [--modes=diff,chunk,diff2,chunk2]
"""

from __future__ import annotations

import json
import sys
from itertools import pairwise
from pathlib import Path

import delta
import llm
import sizes

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.prompts.ingest import DESCRIPTOR_WORDS, summary_messages
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.indexing import (
    _parse_summary_payload,
    _truncate_words,
)

HERE = Path(__file__).resolve().parent
DOCS = {
    "chapter": [f"c{i}" for i in range(6)],
    "book": [f"b{i}" for i in range(7)],
}
TARGET = 500


def finish(raw: str, target: int) -> dict:
    descriptor, summary = _parse_summary_payload(raw)
    return {
        "descriptor": _truncate_words(descriptor, DESCRIPTOR_WORDS),
        "summary": _truncate_words(summary, target),
    }


def full(round_name: str, suffix: str) -> dict:
    chunks = sizes.load(f"{round_name}.docx")
    body = "\n\n".join(c.indexed_text() for c in chunks)
    record = llm.chat(f"full-{round_name}-{suffix}", summary_messages(body, TARGET))
    return {
        **finish(record["content"], TARGET),
        "usage": record["usage"],
        "cost": record["cost_usd"],
    }


def chain(doc: str, mode: str, start: dict) -> dict[str, dict]:
    rounds = DOCS[doc]
    out = {rounds[0]: start}
    previous = start
    for old, new in pairwise(rounds):
        old_chunks = sizes.load(f"{old}.docx")
        new_chunks = sizes.load(f"{new}.docx")
        doc_tokens = estimate_tokens("\n\n".join(c.indexed_text() for c in new_chunks))
        current = delta.outline(new_chunks)
        if mode == "chunk":
            removed, added = delta.chunk_delta(old_chunks, new_chunks)
            messages = delta.chunk_messages(
                previous["descriptor"],
                previous["summary"],
                removed,
                added,
                TARGET,
                doc_tokens,
            )
        elif mode == "diff":
            changes = delta.text_changes(old_chunks, new_chunks)
            messages = delta.diff_messages(
                previous["descriptor"], previous["summary"], changes, TARGET, doc_tokens
            )
        elif mode == "chunk2":
            removed, added = delta.chunk_delta(old_chunks, new_chunks)
            messages = delta.chunk_messages_v2(
                previous["descriptor"],
                previous["summary"],
                removed,
                added,
                TARGET,
                doc_tokens,
                current,
            )
        elif mode == "diff2":
            changes = delta.text_changes(old_chunks, new_chunks)
            messages = delta.diff_messages_v2(
                previous["descriptor"],
                previous["summary"],
                changes,
                TARGET,
                doc_tokens,
                current,
            )
        else:  # diff3, diff3t (thinking on)
            changes = delta.text_changes(old_chunks, new_chunks)
            gone, fresh = delta.section_changes(old_chunks, new_chunks)
            messages = delta.diff_messages_v3(
                previous["descriptor"],
                previous["summary"],
                changes,
                TARGET,
                doc_tokens,
                gone,
                fresh,
            )
        extra = {"reasoning_effort": "low"} if mode.endswith("t") else None
        record = llm.chat(
            f"delta-{mode}-{new}",
            messages,
            extra=extra,
            max_tokens=8000 if extra else 4000,
        )
        previous = {
            **finish(record["content"], TARGET),
            "usage": record["usage"],
            "cost": record["cost_usd"],
            "input_tokens_est": estimate_tokens(messages[1]["content"]),
        }
        out[new] = previous
        print(
            mode,
            new,
            record["usage"].get("prompt_tokens"),
            round(record["cost_usd"], 5),
            flush=True,
        )
    return out


def main() -> None:
    doc = sys.argv[1]
    modes = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--modes=")]
    modes = modes[0].split(",") if modes else ["diff", "chunk"]
    rounds = DOCS[doc]
    results_path = HERE / f"results-{doc}.json"
    results = (
        json.loads(results_path.read_text(encoding="utf-8"))
        if results_path.exists()
        else {}
    )
    fulls = results.setdefault("full", {})
    for r in rounds:
        fulls[f"{r}-a"] = full(r, "a")
        print(
            "full",
            r,
            fulls[f"{r}-a"]["usage"].get("prompt_tokens"),
            round(fulls[f"{r}-a"]["cost"], 5),
            flush=True,
        )
    for suffix in ("b", "c"):
        fulls[f"{rounds[0]}-{suffix}"] = full(rounds[0], suffix)
    fulls[f"{rounds[-1]}-b"] = full(rounds[-1], "b")
    results_path.write_text(
        json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8"
    )
    for mode in modes:
        results[mode] = chain(doc, mode, fulls[f"{rounds[0]}-a"])
        results_path.write_text(
            json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8"
        )
    print("spent", round(llm.spent(), 4))


if __name__ == "__main__":
    main()
