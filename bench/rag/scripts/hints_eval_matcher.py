"""Part 1 of the pending-hints eval: the matcher's signal and noise, no model.

Runs production pending_hints (candidates, _prepare, match, snippet, message
with its 400-token cap) for every message in
bench/rag/fixtures/hints-eval/messages.json against the fixture's pending
changes, and labels each shown hint relevant, topical or noise from the
message's labels. It also asks Postgres which of the message's words each
candidate matched, which explains the noise and lets candidate rules (fewer
hints, a minimum rank, a matched-words rule, ...) be scored on the same
matches, and it scores two candidate texts production does not use (the
document name, and the name plus the Office label, in front of the change).
Last, it runs query-parser probes (a leading minus, quotes) before and after
stripping websearch operators from the words.

Needs only a Postgres 16 with the stock text search configurations (no
tables are read):

  uv run python bench/rag/scripts/hints_eval_matcher.py \
      --dsn postgres://capy:capy@127.0.0.1:55991/capy \
      --out bench/rag/reports/local/2026-10-20-hints-eval/part1

Writes <out>/<pool>-<candidate text>.json per run and summary.json, and
prints the tables.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
MESSAGES = HERE.parents[0] / "fixtures" / "hints-eval" / "messages.json"

# Chosen before the first run (not tuned on its results): words that ask for
# an action or name a kind of study material rather than a subject.
GENERIC = frozenset(
    """note notes chapter chapters page pages slide slides file files document
    documents sheet spreadsheet explain summary summarise summarize question
    questions answer answers example examples help study revise revision exam
    exams test quiz make write tell show give please thanks thank new now today
    tip tips time date work find get need want know like use using""".split()
)
NUMBER = re.compile(r"^[\d.,%²³/+−-]+$")

# Messages a study app gets that hit websearch_to_tsquery's operators.
PROBES = [
    "What is -5 + 3?",
    "Is the -ve charge on the anion?",
    "Solve x - 3 = 0",
    'What is the "lock and key" model?',
    'What did I write about the "Sleepwalkers book?',
    'Explain "cost-push" inflation',
]

# Production's statement, without its LIMIT, returning the rank too.
ALL_MATCHES = """WITH plain AS (
    SELECT coalesce(string_agg(w, ' or '), '') AS q
    FROM unnest(string_to_array(%(any)s, ' or ')) AS w
    WHERE ts_lexize('english_stem'::regdictionary, lower(w))
        IS DISTINCT FROM '{}'::text[]),
m AS MATERIALIZED (
    SELECT c.ord, to_tsvector(c.cfg, c.t) AS v,
        websearch_to_tsquery(c.cfg, CASE WHEN c.simple THEN plain.q ELSE %(any)s END) AS q
    FROM unnest(%(texts)s::text[], %(cfgs)s::regconfig[], %(simple)s::boolean[])
        WITH ORDINALITY AS c(t, cfg, simple, ord)
    CROSS JOIN plain)
SELECT ord, ts_rank(v, q) AS rank FROM m WHERE v @@ q ORDER BY ts_rank(v, q) DESC, ord"""

# Which single words of the query each candidate matches (same configs, same
# English stopword drop for simple-config documents).
WORD_HITS = """WITH c AS (
    SELECT ord, t, cfg, simple
    FROM unnest(%(texts)s::text[], %(cfgs)s::regconfig[], %(simple)s::boolean[])
        WITH ORDINALITY AS c(t, cfg, simple, ord)),
w AS (
    SELECT word,
        ts_lexize('english_stem'::regdictionary, lower(word)) IS DISTINCT FROM '{}'::text[] AS content
    FROM unnest(%(words)s::text[]) AS u(word))
SELECT c.ord, w.word
FROM c JOIN w ON (NOT c.simple OR w.content)
WHERE to_tsvector(c.cfg, c.t) @@ websearch_to_tsquery(c.cfg, w.word)"""

# Which of the query's words survive each configuration's stopwords: a word
# whose tsquery is empty is a stopword there.
CONTENT_WORDS = """SELECT cfg::text AS cfg, word
FROM unnest(%(cfgs)s::regconfig[]) AS cfg
CROSS JOIN unnest(%(words)s::text[]) AS word
WHERE numnode(websearch_to_tsquery(cfg, word)) > 0
  AND (cfg::text <> 'simple'
       OR ts_lexize('english_stem'::regdictionary, lower(word)) IS DISTINCT FROM '{}'::text[])"""


def sanitized(any_of: str) -> str:
    """The words without websearch operators: a leading - or ! and quotes."""
    words = [re.sub(r'^[-!]+', "", w).replace('"', "") for w in any_of.split(" or ")]
    return " or ".join(w for w in words if w.strip("-!"))


def candidate_text(kind: str) -> Callable[[Any], str]:
    """What a candidate matches on: production's change text, or the
    document name (and an Office change's label) in front of it."""
    if kind == "change":
        return lambda h: h.text
    if kind == "name":
        return lambda h: f"{h.name}\n{h.text}"
    # A note's where is "block b5", which names nothing.
    return lambda h: f"{h.name}\n{h.where}\n{h.text}" if h.kind == "file" else f"{h.name}\n{h.text}"


def labels(message: dict[str, Any], pool_name: str) -> tuple[set[str], set[str]]:
    relevant = set(message["relevant"])
    topical = set(message["topical"])
    if pool_name == "busy":
        relevant |= set(message.get("relevant_busy", []))
        topical |= set(message.get("topical_busy", []))
    return relevant, topical


def cause(words: list[str], simple: bool) -> str:
    """Why a noise hint fired, from the words it matched (first rule wins)."""
    from pipeline.retrieval.lang import is_cjk

    bare = [w.lower().strip("?!.,'\"") for w in words]
    if any(any(is_cjk(ch) for ch in w) for w in words):
        return "cjk bigram"
    if all(NUMBER.match(w) for w in bare):
        return "number"
    if all(len(re.sub(r"\W", "", w)) <= 2 for w in bare):
        return "one or two letters"
    if all(w in GENERIC for w in bare):
        return "generic word"
    if simple:
        return "english word in a cjk note"
    if len(bare) == 1:
        return "one shared content word"
    return "several shared words"


async def matches_for(db, prepared, text: str, any_of: str) -> list[dict[str, Any]]:
    """Every candidate the message matches, best first, with the words."""
    words = any_of.split(" or ") if any_of else []
    if not words:
        return []
    params = {
        "texts": [p.tokens for p in prepared],
        "cfgs": [p.config for p in prepared],
        "simple": [p.simple for p in prepared],
    }
    async with db.connection() as conn:
        cur = await conn.execute(ALL_MATCHES, {**params, "any": any_of})
        ranked = [(r["ord"], float(r["rank"])) for r in await cur.fetchall()]
        cur = await conn.execute(WORD_HITS, {**params, "words": words})
        hits: dict[int, set[str]] = defaultdict(set)
        for r in await cur.fetchall():
            hits[r["ord"]].add(r["word"])
        cur = await conn.execute(
            CONTENT_WORDS, {"cfgs": sorted(set(params["cfgs"])), "words": words}
        )
        content: dict[str, set[str]] = defaultdict(set)
        for r in await cur.fetchall():
            content[r["cfg"]].add(r["word"])
    out = []
    for ord_, rank in ranked:
        p = prepared[ord_ - 1]
        out.append(
            {
                "change": p.hint.change_id,
                "doc": p.hint.doc_id,
                "rank": rank,
                "simple": p.simple,
                "chars": len(p.hint.text),
                "words": sorted(hits.get(ord_, ())),
                "content_words": len(content.get(p.config, ())),
            }
        )
    return out


async def run_pool(pool_name: str, text_kind: str, messages: list[dict[str, Any]], out: Path) -> dict[str, Any]:
    import hints_eval_fixture as fx

    from pipeline.retrieval import pending_hints, store
    from pipeline.retrieval.chunking import estimate_tokens, search_query_terms, tokenize_for_search

    docs = fx.load(busy=pool_name == "busy")
    sources = fx.pending_sources(docs)
    hints = pending_hints.candidates(sources)
    base = pending_hints._prepare(hints, fx.indexed_langs(docs))
    text_of = candidate_text(text_kind)
    prepared = [
        pending_hints._Prepared(p.hint, tokenize_for_search(text_of(p.hint)), p.config, p.simple)
        for p in base
    ]
    db = await store.pool()
    rows = []
    for message in messages:
        text = message["text"]
        any_of = search_query_terms(text).any_of
        matched = await pending_hints.match(text, prepared)
        rendered = pending_hints.message([(h, pending_hints.snippet(h, text)) for h in matched])
        if text_kind == "change":
            # The same as the agent's path.
            produced = await pending_hints.for_message(text, sources, skip=set())
            assert [h.change_id for h, _ in produced] == [h.change_id for h in matched]
        matches = await matches_for(db, prepared, text, any_of)
        assert [m["change"] for m in matches[: pending_hints.HINT_LIMIT]] == [
            h.change_id for h in matched
        ], message["id"]
        relevant, topical = labels(message, pool_name)
        rows.append(
            {
                "id": message["id"],
                "kind": message["kind"],
                "how": message.get("how", ""),
                "text": text,
                "words": any_of.split(" or ") if any_of else [],
                "relevant": sorted(relevant),
                "topical": sorted(topical),
                "matches": matches,
                "shown": [h.change_id for h, _ in rendered["_hints"]] if rendered else [],
                "block_tokens": estimate_tokens(rendered["content"]) if rendered else 0,
                "block": rendered["content"] if rendered else "",
            }
        )
    result = {"pool": pool_name, "text": text_kind, "candidates": len(prepared), "messages": rows}
    (out / f"{pool_name}-{text_kind}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return result


async def run_probes() -> list[dict[str, Any]]:
    import hints_eval_fixture as fx

    from pipeline.retrieval import pending_hints, store
    from pipeline.retrieval.chunking import search_query_terms

    docs = fx.load()
    prepared = pending_hints._prepare(
        pending_hints.candidates(fx.pending_sources(docs)), fx.indexed_langs(docs)
    )
    db = await store.pool()
    out = []
    for text in PROBES:
        any_of = search_query_terms(text).any_of
        async with db.connection() as conn:
            cur = await conn.execute(
                "SELECT websearch_to_tsquery('english', %s)::text AS q", (any_of,)
            )
            parsed = (await cur.fetchone())["q"]
        now = await matches_for(db, prepared, text, any_of)
        fixed = await matches_for(db, prepared, text, sanitized(any_of))
        out.append(
            {
                "text": text,
                "english_tsquery": parsed,
                "matches": len(now),
                "shown": [m["change"] for m in now[:5]],
                "matches_sanitized": len(fixed),
                "shown_sanitized": [m["change"] for m in fixed[:5]],
            }
        )
    return out


# A rule picks a message's shown changes from its ranked matches; every rule
# then goes through production's token cap (render's 400).
Rule = Callable[[dict[str, Any]], list[dict[str, Any]]]


def top(n: int) -> Rule:
    return lambda row: row["matches"][:n]


def min_rank(threshold: float, n: int = 5) -> Rule:
    return lambda row: [m for m in row["matches"] if m["rank"] >= threshold][:n]


def min_words(k: int, n: int = 5) -> Rule:
    """At least k distinct matched words, or every content word when the
    message has fewer than k."""
    return lambda row: [
        m for m in row["matches"] if len(m["words"]) >= min(k, max(1, m["content_words"]))
    ][:n]


def no_lone(predicate: Callable[[str], bool], n: int = 5) -> Rule:
    """Drop matches whose every matched word satisfies ``predicate``."""
    return lambda row: [
        m for m in row["matches"] if not all(predicate(w) for w in m["words"])
    ][:n]


def generic_or_number(word: str) -> bool:
    bare = word.lower().strip("?!.,'\"")
    return bool(NUMBER.match(bare)) or bare in GENERIC or len(re.sub(r"\W", "", bare)) <= 2


def min_words_specific(k: int, n: int = 5) -> Rule:
    """At least k matched words that are not generic, numbers or one or two
    letters (or every such content word when the message has fewer)."""

    def rule(row):
        out = []
        for m in row["matches"]:
            specific = [w for w in m["words"] if not generic_or_number(w)]
            available = max(1, m["content_words"])
            if specific and len(specific) >= min(k, available):
                out.append(m)
        return out[:n]

    return rule


RULES: dict[str, Rule] = {
    "production (top 5)": top(5),
    "top 3": top(3),
    "top 1": top(1),
    "rank >= 0.02": min_rank(0.02),
    "rank >= 0.03": min_rank(0.03),
    "no lone generic or number": no_lone(generic_or_number),
    ">= 2 matched words": min_words(2),
    ">= 2 matched words, top 3": min_words(2, 3),
    ">= 2 specific words": min_words_specific(2),
}


def capped(row: dict[str, Any], picked: list[dict[str, Any]], pool: dict[str, Any]) -> list[str]:
    from pipeline.retrieval import pending_hints

    hints = [(pool[m["change"]], pending_hints.snippet(pool[m["change"]], row["text"])) for m in picked]
    _, kept = pending_hints.render(hints, pending_hints.MESSAGE_HEADING)
    return [h.change_id for h, _ in kept]


def score(rows: list[dict[str, Any]], shown_of: Callable[[dict[str, Any]], list[str]]) -> dict[str, Any]:
    fired = relevant_fired = topical_fired = noise = relevant_total = 0
    noisy = found = edit_messages = 0
    per_kind: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        shown = shown_of(row)
        rel, top_ = set(row["relevant"]), set(row["topical"])
        n_noise = sum(1 for c in shown if c not in rel and c not in top_)
        fired += len(shown)
        relevant_fired += sum(1 for c in shown if c in rel)
        topical_fired += sum(1 for c in shown if c in top_)
        noise += n_noise
        relevant_total += len(rel)
        noisy += n_noise > 0
        per_kind[row["kind"]].append(n_noise)
        if rel:
            edit_messages += 1
            found += any(c in rel for c in shown)
    n = len(rows)
    return {
        "hints_per_message": round(fired / n, 2),
        "precision": round(relevant_fired / fired, 3) if fired else None,
        "precision_lenient": round((relevant_fired + topical_fired) / fired, 3) if fired else None,
        "recall": round(relevant_fired / relevant_total, 3) if relevant_total else None,
        "messages_found": f"{found}/{edit_messages}",
        "noise_per_message": round(noise / n, 2),
        "noise_by_kind": {k: round(sum(v) / len(v), 2) for k, v in per_kind.items()},
        "messages_with_noise": f"{noisy}/{n}",
    }


def report(result: dict[str, Any]) -> dict[str, Any]:
    import hints_eval_fixture as fx

    from pipeline.retrieval import pending_hints

    docs = fx.load(busy=result["pool"] == "busy")
    pool = {h.change_id: h for h in pending_hints.candidates(fx.pending_sources(docs))}
    rows = result["messages"]
    for row in rows:
        assert capped(row, top(5)(row), pool) == row["shown"], row["id"]
    table = {
        name: score(rows, lambda row, rule=rule: capped(row, rule(row), pool))
        for name, rule in RULES.items()
    }
    causes: Counter = Counter()
    examples: dict[str, list[str]] = defaultdict(list)
    by_words: dict[str, Counter] = defaultdict(Counter)
    misses = []
    for row in rows:
        rel, top_ = set(row["relevant"]), set(row["topical"])
        by_change = {m["change"]: m for m in row["matches"]}
        for change in row["shown"]:
            m = by_change[change]
            label = "relevant" if change in rel else "topical" if change in top_ else "noise"
            by_words["1 word" if len(m["words"]) == 1 else "2+ words"][label] += 1
            if label != "noise":
                continue
            why = cause(m["words"], m["simple"])
            causes[why] += 1
            examples[why].append(f'{row["id"]} "{row["text"]}" -> {change} via {m["words"]}')
        for change in sorted(rel - set(row["shown"])):
            where = "matched, ranked out" if change in by_change else "no lexical match"
            misses.append(f'{row["id"]} "{row["text"]}" misses {change} ({where})')
    tokens = [row["block_tokens"] for row in rows if row["block_tokens"]]
    return {
        "pool": result["pool"],
        "text": result["text"],
        "candidates": result["candidates"],
        "rules": table,
        "shown_by_matched_words": {k: dict(v) for k, v in by_words.items()},
        "noise_causes": dict(causes.most_common()),
        "noise_examples": dict(examples),
        "misses": misses,
        "block_tokens_mean": round(sum(tokens) / len(tokens), 1) if tokens else 0,
        "messages_with_block": f"{len(tokens)}/{len(rows)}",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    os.environ["DATABASE_URL"] = args.dsn
    os.environ.setdefault("EMBEDDING_DIM", "2560")
    from pipeline import use_compatible_event_loop

    use_compatible_event_loop()
    args.out.mkdir(parents=True, exist_ok=True)
    messages = json.loads(MESSAGES.read_text(encoding="utf-8"))["messages"]
    runs = [("base", "change"), ("busy", "change"), ("base", "name"), ("base", "name+label"), ("busy", "name")]

    async def go():
        from pipeline.retrieval import store

        try:
            results = [await run_pool(p, t, messages, args.out) for p, t in runs]
            return results, await run_probes()
        finally:
            await store.close_pool()

    results, probes = asyncio.run(go())
    summary = {"runs": [report(r) for r in results], "probes": probes}
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    for s in summary["runs"]:
        print(
            f"\n== pool {s['pool']}, candidate text {s['text']}: {s['candidates']} candidates; "
            f"a block on {s['messages_with_block']} messages, {s['block_tokens_mean']} tokens mean"
        )
        for name, row in s["rules"].items():
            print(f"  {name:28} {json.dumps(row, ensure_ascii=False)}")
        print("  shown by matched words:", s["shown_by_matched_words"])
        print("  noise causes:", s["noise_causes"])
    print("\n== parser probes (base pool, 40 candidates)")
    for p in probes:
        print(f"  {p['text']!r}: tsquery {p['english_tsquery']!r}; matches {p['matches']} -> {p['matches_sanitized']} sanitized")


if __name__ == "__main__":
    main()
