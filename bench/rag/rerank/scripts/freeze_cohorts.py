"""Validate and freeze the two new query cohorts before any retrieval.

  python freeze_cohorts.py check    # report problems; writes nothing
  python freeze_cohorts.py freeze   # adds relevance sets, writes the freeze record

Checks on fixtures/cohorts.json, reading only the frozen snapshot text:
  - every target, acceptable, distractor and not_acceptable id is a snapshot chunk;
  - acceptable and distractor lists do not overlap and do not contain the target;
  - a distractor inside the target's excerpt is an error (excerpt-level scoring
    cannot tell them apart): such look-alikes go under same_excerpt_siblings,
    which only the chunk-level metric uses; an acceptable chunk inside the
    target's excerpt is reported for the record;
  - every near-copy of the target in the snapshot (the qwen3.7 rule: character
    5-gram Jaccard >= 0.6 or containment >= 0.8) carries an explicit decision:
    listed under acceptable (the same passage, e.g. the os4/ahss4 or
    R/jamovi forks) or under not_acceptable with a reason (a templated
    look-alike that answers something else).
freeze refuses while any check fails. Relevance is target + acceptable, at
chunk level; relevant_excerpts are the excerpts holding them.

Output: fixtures/cohorts.json (relevant, relevant_excerpts added) and
data/rerank-eval/cohorts-freeze.json (hashes, counts, timestamp).
"""

from __future__ import annotations

import sys
from collections import Counter, defaultdict

import rr

sys.path.insert(0, str(rr.Q37_SCRIPTS))
from freeze_queries import CONTAINMENT, JACCARD, chars, norm, words  # noqa: E402

PATH = rr.FIX / "cohorts.json"


def near_copies(chunks):
    normed = {c["id"]: norm(c["text"]) for c in chunks}
    index = defaultdict(set)
    for cid, text in normed.items():
        for h in words(text):
            index[h].add(cid)
    grams = {}

    def of(target: str) -> list[str]:
        counts = Counter(c for h in words(normed[target]) for c in index[h] if c != target)
        a = grams.setdefault(target, chars(normed[target]))
        out = []
        for cid, shared in counts.items():
            if shared < 3:
                continue
            b = grams.setdefault(cid, chars(normed[cid]))
            inter = len(a & b)
            if inter / len(a | b) >= JACCARD or inter / len(a) >= CONTAINMENT:
                out.append(cid)
        return sorted(out)

    return of


def main(step: str):
    fixture = rr.read_json(PATH)
    chunks, _, _ = rr.load_snapshot()
    by_id = {c["id"]: c for c in chunks}
    copies = near_copies(chunks)
    problems, notes = [], []
    seen_ids = set()
    for q in fixture["queries"]:
        qid, t = q["id"], q["target"]
        if qid in seen_ids:
            problems.append(f"{qid}: duplicate id")
        seen_ids.add(qid)
        same = q.get("same_excerpt_siblings", [])
        ids = [t, *q.get("acceptable", []), *q.get("distractors", []), *same, *[x["id"] for x in q.get("not_acceptable", [])]]
        missing = [i for i in ids if i not in by_id]
        if missing:
            problems.append(f"{qid}: unknown chunk ids {missing}")
            continue
        acc, dis = set(q.get("acceptable", [])), set(q.get("distractors", []))
        if t in acc or t in dis or acc & dis:
            problems.append(f"{qid}: target/acceptable/distractor overlap")
        tex = rr.excerpt_key(by_id[t])
        for d in dis:
            if rr.excerpt_key(by_id[d]) == tex:
                problems.append(f"{qid}: distractor {d} is inside the target's excerpt")
        for a in acc:
            if rr.excerpt_key(by_id[a]) == tex:
                notes.append(f"{qid}: acceptable {a} shares the target's excerpt")
        for s_ in same:
            if rr.excerpt_key(by_id[s_]) != tex:
                problems.append(f"{qid}: same_excerpt_sibling {s_} is not in the target's excerpt")
        decided = acc | dis | set(same) | {x["id"] for x in q.get("not_acceptable", [])}
        for cid in copies(t):
            if cid not in decided:
                c = by_id[cid]
                problems.append(f"{qid}: undecided near-copy {cid} ({c['book_id']} | {c['section_path'][-60:]})")
        for key in ("query", "lang", "cohort"):
            if not q.get(key):
                problems.append(f"{qid}: missing {key}")
    for n in notes:
        print("note:", n)
    for p in problems:
        print("PROBLEM:", p)
    counts = Counter(q["cohort"] for q in fixture["queries"])
    langs = Counter((q["cohort"], q["lang"]) for q in fixture["queries"])
    print(dict(counts), dict(sorted(langs.items())))
    if step == "check" or problems:
        if problems:
            raise SystemExit(f"{len(problems)} problems; nothing frozen")
        return
    for q in fixture["queries"]:
        relevant = sorted({q["target"], *q.get("acceptable", [])})
        q["relevant"] = relevant
        q["relevant_excerpts"] = sorted({rr.excerpt_key(by_id[c]) for c in relevant})
    fixture["frozen_utc"] = rr.utc()
    rr.write_json(PATH, fixture)
    snapshot = rr.read_json(rr.SNAP / "snapshot.json")
    rr.write_json(
        rr.DATA / "cohorts-freeze.json",
        {
            "frozen_utc": fixture["frozen_utc"],
            "fixture_sha256": rr.sha256_file(PATH),
            "snapshot_sha256": snapshot["sha256"],
            "queries": len(fixture["queries"]),
            "by_cohort": dict(counts),
            "rule": {"char5_jaccard": JACCARD, "containment": CONTAINMENT},
        },
    )
    print("frozen", len(fixture["queries"]), "queries")


if __name__ == "__main__":
    main(sys.argv[1])
