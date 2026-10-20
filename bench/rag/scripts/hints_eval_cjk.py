"""The CJK word rule of the hints matcher, measured on Chinese messages (Epo
2026-10-20, after the hints-round review's S3: overlapping pairs let
什么是光合作用 hint notes matching only 什么+么是 or 合作+作用).

Each unit rule turns a message into the words the two-word rule counts, and
production's ``pending_hints.match_units`` matches them against the edits of
bench/rag/fixtures/hints-eval/chinese.json (simple config). Rules:

- pairs: every overlapping pair a word (production before the rule);
- runs-any / runs-all: each CJK run one word, matched by any / all of its pairs
  (the fallback "each run counts once");
- hsk1-all / hsk1-any: HSK 3.0 level-1 words dropped from each run by longest
  match, each piece left one word matched by all / any of its pairs;
- seg-merge: production's ``pending_hints.message_units`` (chosen from this
  run): the run split by longest match over every HSK 3.0 word, level-1 words
  dropped, kept list words their own word and other characters joined to the
  next list word (or their own word after the last);
- seg-words: the same split, each kept list word of two or more characters a
  word, single characters dropped.

The word list is fixtures/hints-eval/hsk-levels.tsv (MIT, licence inside);
production keeps the same list in pipeline/retrieval/hsk_words.tsv. Japanese
and Korean cases only check that a hint still comes through.

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
OTHERS = [
    {
        "lang": "ja",
        "doc": {"id": "m_ja", "name": "光合成ノート", "edits": [
            {"id": "ja-def", "text": "光合成は光のエネルギーを使って糖を作る反応です。"},
            {"id": "ja-other", "text": "明日の予定を確認する。"},
        ]},
        "messages": [{"id": "J01", "text": "光合成とは何ですか？", "relevant": ["ja-def"]}],
    },
    {
        "lang": "ko",
        "doc": {"id": "m_ko", "name": "광합성 노트", "edits": [
            {"id": "ko-def", "text": "광합성은 빛 에너지를 이용해 포도당을 만든다."},
            {"id": "ko-other", "text": "내일 일정을 확인한다."},
        ]},
        "messages": [{"id": "K01", "text": "광합성 에너지는 무엇인가요?", "relevant": ["ko-def"]}],
    },
]


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


def units_by(query: str, split: Callable[[str], list[str]], joiner: str) -> list[str]:
    """The message's Latin words, then each CJK piece ``split`` gives (of two or
    more characters) as its pairs joined by ``joiner``."""
    from pipeline.retrieval.chunking import search_query_terms, tokenize_for_search
    from pipeline.retrieval.lang import CJK_RUN_RE

    words = [w for w in search_query_terms(query).any_of.split(" or ") if w and not CJK_RUN_RE.search(w)]
    pieces = [p for run in CJK_RUN_RE.findall(query) for p in split(run) if len(p) > 1]
    return words + [joiner.join(tokenize_for_search(p).split()) for p in pieces]


def seg_words(run: str) -> list[str]:
    """Each list word of two or more characters above level 1; the rest dropped."""
    levels = hsk_levels()
    return [t for t in segment(run) if len(t) > 1 and levels.get(t) != 1]


def rules() -> dict[str, Callable[[str], list[str]]]:
    from pipeline.retrieval import pending_hints
    from pipeline.retrieval.chunking import search_query_terms

    return {
        "pairs": lambda q: [w for w in search_query_terms(q).any_of.split(" or ") if w],
        "runs-any": lambda q: units_by(q, lambda run: [run], " or "),
        "runs-all": lambda q: units_by(q, lambda run: [run], " "),
        "hsk1-all": lambda q: units_by(q, without_level1, " "),
        "hsk1-any": lambda q: units_by(q, without_level1, " or "),
        "seg-merge": pending_hints.message_units,
        "seg-words": lambda q: units_by(q, seg_words, " "),
    }


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

    data = json.loads((FIXTURES / "chinese.json").read_text(encoding="utf-8"))
    sources = sources_for(data["documents"])
    pool = pending_hints._prepare(pending_hints.candidates(sources), {d["id"]: "zh" for d in data["documents"]})
    out: dict[str, Any] = {"rules": {}, "messages": {}, "others": {}}
    try:
        for name, units_of in rules().items():
            rows = []
            for m in data["messages"]:
                units = units_of(m["text"])
                any_of = search_query_terms(m["text"]).any_of
                hints = await pending_hints.match_units(units, any_of, pool) if units else []
                rows.append({**m, "units": units, "shown": [h.change_id for h in hints]})
            out["rules"][name] = score(rows)
            out["messages"][name] = {r["id"]: {"units": r["units"], "shown": r["shown"]} for r in rows}
        for case in OTHERS:
            o_sources = sources_for([case["doc"]])
            o_pool = pending_hints._prepare(pending_hints.candidates(o_sources), {case["doc"]["id"]: case["lang"]})
            for m in case["messages"]:
                hints = await pending_hints.match(m["text"], o_pool)
                out["others"][m["id"]] = {
                    "units": pending_hints.message_units(m["text"]),
                    "shown": [h.change_id for h in hints],
                    "relevant": m["relevant"],
                }
    finally:
        await store.close_pool()
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
    for name, row in result["rules"].items():
        print(f"{name:10} {json.dumps(row, ensure_ascii=False)}")
    print("\nper message (rule: units -> shown):")
    for mid in result["messages"]["pairs"]:
        print(f"  {mid}")
        for name in result["rules"]:
            m = result["messages"][name][mid]
            print(f"    {name:10} {m['units']} -> {m['shown']}")
    print("\nJapanese / Korean:", json.dumps(result["others"], ensure_ascii=False))


if __name__ == "__main__":
    main()
