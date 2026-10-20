"""The CJK word rules of the hints matcher, measured on Chinese, Japanese and
Korean messages (Epo 2026-10-20, after the hints-round review's S3 and the
re-review's R1-R3: overlapping pairs let 什么是光合作用 hint notes matching only
什么+么是 or 合作+作用; dropping every HSK level-1 word lost 电子 and 沸点;
any-pair matching let です hint).

Each unit rule turns a message into the words the two-word rule counts, and
production's ``pending_hints.match_units`` matches them against the edits of
fixtures/hints-eval/chinese.json and cjk-terms.json (simple config). Rules:

- pairs: every overlapping pair a word (production before the CJK rule);
- runs-any / runs-all: each CJK run one word, matched by any / all of its
  pairs (Epo's fallback, "each run counts once");
- hsk1-all / hsk1-any: HSK 3.0 level-1 words dropped from each run by longest
  match, each piece left one word matched by all / any of its pairs;
- hsk1-merge: the first list rule (bench/hints-eval fb020fadb): the run split
  by longest match over every HSK 3.0 word, level-1 words dropped, kept list
  words their own word and other characters joined to the next list word;
- seg-words: the same split, each kept list word of two or more characters a
  word, single characters dropped;
- hand: production's ``pending_hints.message_units`` (``hint_words``): Chinese
  split over HSK plus a hand-picked list, only function words, question
  words, request verbs, measure words and locatives dropped, a character left
  alone keeping a joinable neighbour (对数, 动能, 中子); Japanese without
  hiragana-only pairs; Korean without its ending and question words, two
  pairs a word.

Japanese and Korean run pairs, any (each run once by any pair, the first
rule for them) and hand.

The word list is fixtures/hints-eval/hsk-levels.tsv (MIT, licence inside);
production keeps the same list in pipeline/retrieval/hsk_words.tsv.

Needs only a Postgres 16 (no tables); run from pipeline/ for its imports:

  uv run python ../bench/rag/scripts/hints_eval_cjk.py --dsn postgres://capy:capy@127.0.0.1:55992/capy
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from functools import cache
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parents[0] / "fixtures" / "hints-eval"


@cache
def hsk_levels() -> dict[str, int]:
    out = {}
    for line in (FIXTURES / "hsk-levels.tsv").read_text(encoding="utf-8").splitlines():
        if line and not line.startswith("#"):
            word, level = line.split("\t")
            out[word] = int(level)
    return out


def segment(run: str) -> list[str]:
    """Longest match over every HSK word; other characters one by one."""
    levels = hsk_levels()
    longest = max(map(len, levels))
    out, i = [], 0
    while i < len(run):
        size = next((n for n in range(min(longest, len(run) - i), 1, -1) if run[i : i + n] in levels), 1)
        out.append(run[i : i + size])
        i += size
    return out


def without_level1(run: str) -> list[str]:
    """The pieces left once level-1 words are dropped by longest match."""
    levels = hsk_levels()
    longest = max(map(len, levels))
    pieces, kept, i = [], "", 0
    while i < len(run):
        size = next((n for n in range(min(longest, len(run) - i), 0, -1) if levels.get(run[i : i + n]) == 1), 0)
        if size:
            pieces.append(kept)
            kept, i = "", i + size
        else:
            kept, i = kept + run[i], i + 1
    return [*pieces, kept]


def level1_merge(run: str) -> list[str]:
    """The first list rule: level 1 dropped, list words end a word, other
    characters join the next list word."""
    levels = hsk_levels()
    pieces, piece, ended = [], "", False
    for token in segment(run):
        if levels.get(token) == 1:
            pieces.append(piece)
            piece, ended = "", False
            continue
        if ended:
            pieces.append(piece)
            piece = ""
        piece, ended = piece + token, len(token) > 1
    return [*pieces, piece]


def seg_words(run: str) -> list[str]:
    """Each list word of two or more characters above level 1; the rest dropped."""
    levels = hsk_levels()
    return [t for t in segment(run) if len(t) > 1 and levels.get(t) != 1]


def units_by(query: str, split: Callable[[str], list[str]], joiner: str) -> list[str]:
    """The message's Latin words, then each CJK piece ``split`` gives (of two or
    more characters) as its pairs joined by ``joiner``."""
    from pipeline.retrieval.chunking import search_query_terms, tokenize_for_search
    from pipeline.retrieval.lang import CJK_RUN_RE

    words = [w for w in search_query_terms(query).any_of.split(" or ") if w and not CJK_RUN_RE.search(w)]
    pieces = [p for run in CJK_RUN_RE.findall(query) for p in split(run) if len(p) > 1]
    return words + [joiner.join(tokenize_for_search(p).split()) for p in pieces]


def rules(lang: str) -> dict[str, Callable[[str], list[str]]]:
    from pipeline.retrieval import pending_hints
    from pipeline.retrieval.chunking import search_query_terms

    def pairs(q: str) -> list[str]:
        return [w for w in search_query_terms(q).any_of.split(" or ") if w]

    def runs_any(q: str) -> list[str]:
        return units_by(q, lambda run: [run], " or ")

    if lang != "zh":
        return {"pairs": pairs, "any": runs_any, "hand": pending_hints.message_units}
    return {
        "pairs": pairs,
        "runs-any": runs_any,
        "runs-all": lambda q: units_by(q, lambda run: [run], " "),
        "hsk1-all": lambda q: units_by(q, without_level1, " "),
        "hsk1-any": lambda q: units_by(q, without_level1, " or "),
        "hsk1-merge": lambda q: units_by(q, level1_merge, " "),
        "seg-words": lambda q: units_by(q, seg_words, " "),
        "hand": pending_hints.message_units,
    }


def sets() -> list[dict[str, Any]]:
    out = [{"name": "chinese", "lang": "zh", **json.loads((FIXTURES / "chinese.json").read_text(encoding="utf-8"))}]
    for s in json.loads((FIXTURES / "cjk-terms.json").read_text(encoding="utf-8"))["sets"]:
        out.append({"name": f"terms-{s['lang']}", **s})
    return out


def sources_for(docs: list[dict[str, Any]]):
    from pipeline.retrieval import pending

    return pending.PendingSources(
        [
            {
                "fileId": d["id"], "name": d["name"], "epoch": 1, "checkpoint": 2, "indexedCheckpoint": 1,
                "changes": [
                    {"id": e["id"], "kind": "text", "operation": "add", "label": "", "after": e["text"]}
                    for e in d["edits"]
                ],
            }
            for d in docs
        ]
    )


def score(rows: list[dict[str, Any]]) -> dict[str, Any]:
    fired = rel = top = noise = rel_total = found = edit_msgs = noisy = 0
    for r in rows:
        shown, relevant, topical = r["shown"], set(r["relevant"]), set(r["topical"])
        n = sum(1 for c in shown if c not in relevant and c not in topical)
        fired += len(shown)
        rel += sum(1 for c in shown if c in relevant)
        top += sum(1 for c in shown if c in topical)
        noise += n
        noisy += n > 0
        rel_total += len(relevant)
        if relevant:
            edit_msgs += 1
            found += any(c in relevant for c in shown)
    return {
        "hints_per_message": round(fired / len(rows), 2),
        "precision": round(rel / fired, 2) if fired else None,
        "precision_lenient": round((rel + top) / fired, 2) if fired else None,
        "recall": round(rel / rel_total, 2) if rel_total else None,
        "messages_found": f"{found}/{edit_msgs}",
        "noise_per_message": round(noise / len(rows), 2),
        "messages_with_noise": f"{noisy}/{len(rows)}",
    }


async def run() -> dict[str, Any]:
    from pipeline.retrieval import pending_hints, store
    from pipeline.retrieval.chunking import search_query_terms

    out: dict[str, Any] = {}
    chinese: dict[str, list] = {}  # rule -> rows of both Chinese sets
    try:
        for s in sets():
            sources = sources_for(s["documents"])
            langs = {d["id"]: s["lang"] for d in s["documents"]}
            pool = pending_hints._prepare(pending_hints.candidates(sources), langs)
            result: dict[str, Any] = {"rules": {}, "messages": {}}
            for name, units_of in rules(s["lang"]).items():
                rows = []
                for m in s["messages"]:
                    units = units_of(m["text"])
                    any_of = search_query_terms(m["text"]).any_of
                    hints = await pending_hints.match_units(units, any_of, pool) if units and any_of else []
                    rows.append({**m, "units": units, "shown": [h.change_id for h in hints]})
                result["rules"][name] = score(rows)
                result["messages"][name] = {r["id"]: {"units": r["units"], "shown": r["shown"]} for r in rows}
                if s["lang"] == "zh":
                    chinese.setdefault(name, []).extend(rows)
            out[s["name"]] = result
    finally:
        await store.close_pool()
    out["chinese-all"] = {"rules": {name: score(rows) for name, rows in chinese.items()}}
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    os.environ["DATABASE_URL"] = args.dsn
    os.environ.setdefault("EMBEDDING_DIM", "2560")
    sys.stdout.reconfigure(encoding="utf-8")
    from pipeline import use_compatible_event_loop

    use_compatible_event_loop()
    result = asyncio.run(run())
    if args.out:
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    for set_name, res in result.items():
        print(f"\n== {set_name}")
        for name, row in res["rules"].items():
            print(f"{name:10} {json.dumps(row, ensure_ascii=False)}")
        for mid in next(iter(res.get("messages", {}).values()), {}):
            print(f"  {mid}")
            for name in res["rules"]:
                m = res["messages"][name][mid]
                print(f"    {name:10} {m['units']} -> {m['shown']}")


if __name__ == "__main__":
    main()
