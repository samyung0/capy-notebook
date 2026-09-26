"""Seeded candidates for the two new query cohorts, written before any retrieval.

Reads only the frozen snapshot text; no query exists yet and no retriever or
reranker runs. The query author walks each list in order and either writes a
query for the target or records a skip reason.

samedoc (same-document competition): families of look-alike chunks inside one
book, in three kinds:
  numbered  chunks labelled with the same kind of numbered item
            (EXAMPLE 3.4, GUIDED PRACTICE 3.8, Exercise 12, Task B, ...)
  exercises chunks of end-of-section exercise lists (several numbered
            exercises per chunk, many such chunks per book)
  parallel  sibling subsections under one parent heading (3+ leaves)
One target per family (lowest seeded hash among eligible members), shown
with its most similar siblings (TF-IDF inside the family) so the question can
single the target out. Kinds are drawn by quota (55 numbered, 35 exercises,
60 parallel) and interleaved; a family needs a look-alike sibling (TF-IDF at
least 0.15, or 0.25 for parallel sections); at most two candidates per book
and kind, four per book.

nearmiss (closely related but wrong passage): seeded targets across the
subset, at most three per book, each shown with its two nearest chunks from
other excerpts by TF-IDF cosine in [0.30, 0.85] that are not near-copies.
TF-IDF is used instead of the stored embeddings so the nomination is not the
first-stage retriever's own notion of similarity.

About one candidate in five is pre-assigned a non-English query language
(seeded, fixed before reading the candidate), so translation is not chosen by
difficulty.

Output: data/rerank-eval/candidates/{samedoc,nearmiss}.txt and candidates.json
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict

import numpy as np
import rr
from sklearn.feature_extraction.text import TfidfVectorizer

SEED = "capy-rerank-20260925"
OUT = rr.DATA / "candidates"
LANGS = ["zh-Hans", "ja", "es", "fr", "de", "ko", "zh-Hant"]
ITEM = re.compile(
    r"\b(EXAMPLE|Example|GUIDED PRACTICE|Guided Practice|Exercise|EXERCISE|Problem|PROBLEM|Task|TASK|Activity|"
    r"Case Study|Question|Try It|Check Your Understanding|Worked Example|Practice Problem|Self-Check|Figure|Table)"
    r"\s+([0-9]+(?:\.[0-9]+)*[a-z]?|[A-Z])\b"
)
EXERCISE_LEAF = re.compile(r"\b(exercises|problems|review questions|practice questions|check your understanding|self-check)\b", re.I)
SEP = " › "


def h(value: str) -> str:
    return hashlib.sha256((SEED + ":" + value).encode()).hexdigest()


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower())).strip()


def char_grams(text: str, n: int = 5) -> set[str]:
    return {text[i : i + n] for i in range(max(1, len(text) - n + 1))}


def near_copy(a: str, b: str) -> bool:
    ga, gb = char_grams(norm(a)), char_grams(norm(b))
    inter = len(ga & gb)
    return inter / len(ga | gb) >= 0.6 or inter / min(len(ga), len(gb)) >= 0.8


def eligible(c: dict) -> bool:
    text = c["text"]
    letters = sum(ch.isalpha() for ch in text)
    return (
        c["lang"] in ("en", "es")
        and not c["reference"]
        and 250 <= len(text) <= 3500
        and letters / max(1, len(text)) >= 0.6
    )


def query_lang(chunk_id: str, cohort: str) -> str:
    key = int(h(f"lang:{cohort}:{chunk_id}"), 16)
    return LANGS[(key // 5) % len(LANGS)] if key % 5 == 0 else "en"


def leaf(path: str) -> str:
    return path.split(SEP)[-1].strip() if path else ""


def parent(path: str) -> str:
    return SEP.join(path.split(SEP)[:-1]) if path else ""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    chunks, _, _ = rr.load_snapshot()
    ok = [c for c in chunks if eligible(c)]
    index = {c["id"]: i for i, c in enumerate(ok)}
    vec = TfidfVectorizer(sublinear_tf=True, min_df=2, max_df=0.5, stop_words="english",
                          token_pattern=r"(?u)\b\w[\w.]*\b", dtype=np.float32)
    X = vec.fit_transform([c["text"] for c in ok])

    # --- samedoc families -------------------------------------------------------
    families: dict[tuple, set[str]] = defaultdict(set)
    for c in ok:
        head = leaf(c["section_path"]) + " || " + c["text"][:240]
        for m in ITEM.finditer(head):
            families[("numbered", c["book_id"], m.group(1).lower())].add(c["id"])
        if EXERCISE_LEAF.search(leaf(c["section_path"])):
            # One family per chapter; siblings are ranked over the whole book's exercise chunks below.
            families[("exercises", c["book_id"], c["section_path"].split(SEP)[0])].add(c["id"])
    by_parent: dict[tuple, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for c in ok:
        if c["section_path"].count(SEP) >= 1:
            by_parent[(c["book_id"], parent(c["section_path"]))][leaf(c["section_path"])].append(c["id"])
    for (book, par), leaves in by_parent.items():
        if len(leaves) >= 3:
            families[("parallel", book, par)] = {cid for ids in leaves.values() for cid in ids}
    families = {k: v for k, v in families.items() if len(v) >= 3}
    # Each kind is walked in its own seeded order and the kinds are interleaved
    # by quota, so the many generic parallel sections cannot crowd out numbered
    # items and exercise lists. A family qualifies only when some sibling is a
    # look-alike (TF-IDF above the kind's floor); per book at most two
    # candidates per kind and four overall.
    quotas = {"numbered": 55, "exercises": 35, "parallel": 60}
    floors = {"numbered": 0.15, "exercises": 0.15, "parallel": 0.25}
    queues = {kind: sorted((k for k in families if k[0] == kind), key=lambda k: h("family:" + "|".join(k))) for kind in quotas}
    per_book: dict[str, int] = defaultdict(int)
    per_book_kind: dict[tuple, int] = defaultdict(int)
    used: set[str] = set()
    picked = {kind: [] for kind in quotas}
    for kind, queue in queues.items():
        for key in queue:
            _, book, label = key
            if len(picked[kind]) == quotas[kind]:
                break
            if per_book[book] >= 4 or per_book_kind[(book, kind)] >= 2:
                continue
            members = sorted(families[key] - used, key=lambda cid: h("target:" + cid))
            if not members:
                continue
            target = members[0]
            pool = families[key]
            if kind == "exercises":
                pool = set().union(*(v for k, v in families.items() if k[0] == "exercises" and k[1] == book))
            others = [cid for cid in sorted(pool) if cid != target]
            t = index[target]
            sims = (X[[index[o] for o in others]] @ X[t].T).toarray().ravel()
            if sims.max() < floors[kind]:
                continue
            top = np.argsort(-sims, kind="stable")[:3]
            picked[kind].append({"kind": kind, "book_id": book, "family": label, "size": len(families[key]), "target": target,
                                 "siblings": [others[i] for i in top], "sibling_sims": [round(float(sims[i]), 3) for i in top],
                                 "lang": query_lang(target, "samedoc")})
            used.add(target)
            per_book[book] += 1
            per_book_kind[(book, kind)] += 1
    # Interleave in quota proportion: numbered, exercises, parallel, numbered, parallel, ...
    samedoc = []
    cursors = {kind: 0 for kind in quotas}
    pattern = ["numbered", "parallel", "exercises", "numbered", "parallel"]
    while any(cursors[k] < len(picked[k]) for k in quotas):
        for kind in pattern:
            if cursors[kind] < len(picked[kind]):
                samedoc.append(picked[kind][cursors[kind]])
                cursors[kind] += 1

    # --- nearmiss pairs ---------------------------------------------------------
    per_book = defaultdict(int)
    nearmiss = []
    for c in sorted(ok, key=lambda c: h("nearmiss:" + c["id"])):
        if per_book[c["book_id"]] >= 3 or c["id"] in used:
            continue
        sims = (X @ X[index[c["id"]]].T).toarray().ravel()
        picks = []
        for j in np.argsort(-sims, kind="stable")[:60]:
            o = ok[j]
            s = float(sims[j])
            if o["id"] == c["id"] or rr.excerpt_key(o) == rr.excerpt_key(c) or not 0.30 <= s <= 0.85:
                continue
            if near_copy(o["text"], c["text"]):
                continue
            picks.append((o["id"], round(s, 3)))
            if len(picks) == 2:
                break
        if not picks:
            continue
        nearmiss.append({"book_id": c["book_id"], "target": c["id"], "neighbours": picks, "lang": query_lang(c["id"], "nearmiss")})
        used.add(c["id"])
        per_book[c["book_id"]] += 1
        if len(nearmiss) == 130:
            break

    rr.write_json(OUT / "candidates.json", {"seed": SEED, "samedoc": samedoc, "nearmiss": nearmiss})
    by_id = {c["id"]: c for c in chunks}

    def show(c, limit=None):
        text = re.sub(r"[ \t]+", " ", c["text"]).strip()
        return text if limit is None or len(text) <= limit else text[:limit] + " […]"

    with (OUT / "samedoc.txt").open("w", encoding="utf-8") as f:
        for n, cand in enumerate(samedoc):
            t = by_id[cand["target"]]
            f.write(f"##### samedoc #{n} [{cand['kind']}:{cand['family']}] size={cand['size']} lang={cand['lang']}\n")
            f.write(f"TARGET {t['id']} | {t['book_id']} | {t['section_path']} | p{t['page_start']}\n{show(t)}\n")
            for sid, s in zip(cand["siblings"], cand["sibling_sims"]):
                o = by_id[sid]
                f.write(f"--- sibling {sid} (tfidf {s}) | {o['section_path']} | p{o['page_start']}\n{show(o, 700)}\n")
            f.write("\n")
    with (OUT / "nearmiss.txt").open("w", encoding="utf-8") as f:
        for n, cand in enumerate(nearmiss):
            t = by_id[cand["target"]]
            f.write(f"##### nearmiss #{n} lang={cand['lang']}\n")
            f.write(f"TARGET {t['id']} | {t['book_id']} | {t['section_path']} | p{t['page_start']}\n{show(t)}\n")
            for sid, s in cand["neighbours"]:
                o = by_id[sid]
                f.write(f"--- neighbour {sid} (tfidf {s}) | {o['book_id']} | {o['section_path']} | p{o['page_start']}\n{show(o, 1200)}\n")
            f.write("\n")
    print("samedoc", len(samedoc), "nearmiss", len(nearmiss), "eligible", len(ok))


if __name__ == "__main__":
    main()
