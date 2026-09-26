"""Seeded target sampling for the library known-item query set.

Draws candidate chunks per cohort from the frozen snapshot, in a fixed order,
and writes them out for query writing. The query author walks each list in
order and either writes a query or records a skip reason, reading only the
chunk (no retrieval result of either arm exists at that point).

Cohorts and quotas (by subset group):
  mono_en     English query, English chunk        30 multilingual / 20 statistics / 40 spread
  cross       zh/ja/ko/es/fr/de query, English    25 / 20 / 45, languages assigned in seeded order
  paraphrase  English query avoiding key terms    8 / 12 / 20
  mono_es     Spanish query, Spanish chunk        every distinct genuine Spanish passage
  en_to_es    English query, Spanish chunk        first 6 of those (replaced while writing by the
                                                  Spanish-only passages: three of the first six carry
                                                  English commentary or an English translation)

Output: data/qwen37-embedding/library/candidates.json and candidates-<cohort>.txt
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re

from common import DATA, write_json

LIB = DATA / "library"
SEED = "capy-qwen37-20260925"
QUOTAS = {
    "mono_en": {"multilingual": 30, "statistics": 20, "english_spread": 40},
    "cross": {"multilingual": 25, "statistics": 20, "english_spread": 45},
    "paraphrase": {"multilingual": 8, "statistics": 12, "english_spread": 20},
}
CROSS_LANGS = {"zh-Hans": 20, "zh-Hant": 20, "ja": 14, "es": 12, "ko": 8, "fr": 8, "de": 8}
# Words that mark genuine Spanish prose (lang detection alone also fires on
# tables, formulas and glossed examples).
SPANISH = re.compile(r"\b(el|los|las|una|que|del|por|para|como|pero|entre|sus)\b", re.I)


def key(value: str) -> str:
    return hashlib.sha256((SEED + ":" + value).encode()).hexdigest()


def suitable(c: dict) -> bool:
    return (
        c["lang"] == "en"
        and not c["reference"]
        and 500 <= len(c["text"]) <= 3500
    )


def main():
    chunks = [json.loads(s) for s in gzip.open(LIB / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    used_excerpts: set[str] = set()
    out = {}
    for cohort, quota in QUOTAS.items():
        out[cohort] = []
        for group, n in quota.items():
            pool = sorted(
                (c for c in chunks if c["group"] == group and suitable(c)),
                key=lambda c: key(cohort + ":" + c["id"]),
            )
            picked, per_book = [], {}
            for c in pool:
                if c["excerpt_id"] in used_excerpts or per_book.get(c["book_id"], 0) >= 4:
                    continue
                picked.append(c)
                used_excerpts.add(c["excerpt_id"])
                per_book[c["book_id"]] = per_book.get(c["book_id"], 0) + 1
                if len(picked) == 2 * n:  # twice the quota leaves room for skips
                    break
            out[cohort] += [{"id": c["id"], "group": group, "book_id": c["book_id"]} for c in picked]
    # Deterministic interleave: order each language's slots by a seeded key.
    slots = [(lang, i) for lang, n in CROSS_LANGS.items() for i in range(n)]
    langs = [lang for lang, i in sorted(slots, key=lambda s: key(f"slot:{s[0]}:{s[1]}"))]
    spanish = sorted(
        (
            c
            for c in chunks
            if c["lang"] == "es" and len(SPANISH.findall(c["text"])) >= 5 and len(c["text"]) >= 400
        ),
        key=lambda c: key("es:" + c["id"]),
    )
    out["mono_es"] = [{"id": c["id"], "group": c["group"], "book_id": c["book_id"]} for c in spanish]
    out["en_to_es"] = out["mono_es"][:6]
    write_json(LIB / "candidates.json", {"seed": SEED, "cross_langs_in_order": langs, "cohorts": out})
    by_id = {c["id"]: c for c in chunks}
    for cohort, items in out.items():
        with (LIB / f"candidates-{cohort}.txt").open("w", encoding="utf-8") as f:
            for n, item in enumerate(items):
                c = by_id[item["id"]]
                f.write(f"### {cohort} #{n} {c['id']} | {c['book_id']} | {c['section_path']}\n")
                f.write(re.sub(r"[ \t]+", " ", c["text"]).strip() + "\n\n")
        print(cohort, len(items))


if __name__ == "__main__":
    main()
