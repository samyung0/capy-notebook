"""Freeze the book and page selection into fixtures/native-roles-books-2026-10-13.json.

Held-out: the six blind-review books, the four budget library books and four
more library books drawn here (before any training). Training: 40 other books
inside the upload limits, stratified by producer family and spread over
subjects. 50 random pages per training book, 30 per held-out book, plus the 72
review window pages.
"""

import json
import random
import re
from collections import defaultdict

import pymupdf

from common import BOOKS_JSON, POOL, REPO, REVIEW, book_pdf

SEED = 20261013
TRAIN_BOOKS, TRAIN_PAGES, HELD_PAGES, EXTRA_HOLDOUT = 40, 50, 30, 4
BUDGET = ["introduction-to-basic-legal-citation", "interpretation-of-metal-fab-drawings",
          "open-logic-project", "advanced-waterworks-mathematics"]
# Training quota per producer family; a family short of books gives its rest to "prince"/"latex".
QUOTA = {"prince": 12, "latex": 11, "word": 5, "indesign": 6, "libreoffice": 2, "other": 4}


def family(producer: str, creator: str) -> str:
    s = f"{producer} {creator}".lower()
    for name, pat in [("prince", r"prince"), ("indesign", r"indesign"), ("word", r"microsoft|\bword\b"),
                      ("libreoffice", r"libreoffice|openoffice"), ("latex", r"tex|dvipdf|latex")]:
        if re.search(pat, s):
            return name
    return "other"


def spread(cands, k, rng):
    """k books, one subject at a time, so no subject repeats before all have one."""
    by_subj = defaultdict(list)
    for c in cands:
        by_subj[c["subject"]].append(c)
    for v in by_subj.values():
        rng.shuffle(v)
    subjects = sorted(by_subj)
    rng.shuffle(subjects)
    out = []
    while len(out) < k and any(by_subj.values()):
        for s in subjects:
            if by_subj[s] and len(out) < k:
                out.append(by_subj[s].pop())
    return out


if __name__ == "__main__":
    rng = random.Random(SEED)
    meta = json.loads((POOL / "meta.json").read_text())
    review = json.loads((REVIEW / "sample.json").read_text())["books"]
    review_ids = [b["id"] for b in review]
    pool = [dict(id=k, **v, family=family(v["producer"], v["creator"])) for k, v in sorted(meta.items())]
    pool = [b for b in pool if b["id"] not in review_ids + BUDGET]

    # Untouched holdout first: one book from each of four families, so it is drawn before training.
    holdout = []
    for fam in ["latex", "word", "indesign", "other"]:
        cands = [b for b in pool if b["family"] == fam]
        holdout.append(rng.choice(cands))
    pool = [b for b in pool if b not in holdout]

    train, short = [], 0
    for fam, q in QUOTA.items():
        got = spread([b for b in pool if b["family"] == fam], q, rng)
        short += q - len(got)
        train += got
    rest = [b for b in pool if b not in train and b["family"] in ("prince", "latex")]
    train += spread(rest, short, rng)

    def pages(book_id, k):
        n = pymupdf.open(book_pdf(book_id)).page_count
        return sorted(rng.sample(range(n), min(k, n))), n

    books = []
    for split, group, k in [("train", train, TRAIN_PAGES), ("heldout", holdout, HELD_PAGES)]:
        for b in group:
            pp, n = pages(b["id"], k)
            books.append(dict(id=b["id"], sha256=b["sha256"], producer=b["producer"], creator=b["creator"],
                              family=b["family"], subject=b["subject"], pages=n, split=split,
                              holdout_reason="drawn" if split == "heldout" else None, sample_pages=pp))
    library = {b["id"]: b for b in json.loads((REPO / "lab/knowledge/books.json").read_text())["books"]}
    for book_id, why in [(i, "blind-review") for i in review_ids] + [(i, "budget") for i in BUDGET if i not in review_ids]:
        doc = pymupdf.open(book_pdf(book_id))
        md = doc.metadata or {}
        pp, n = pages(book_id, HELD_PAGES)
        books.append(dict(id=book_id, sha256=library[book_id]["sha256"], producer=md.get("producer", ""),
                          creator=md.get("creator", ""), family=family(md.get("producer", ""), md.get("creator", "")),
                          subject=library[book_id]["subject_id"], pages=n, split="heldout", holdout_reason=why,
                          sample_pages=pp))
    review_pages = [dict(id=b["id"], pages=list(range(b["window"][0] - 1, b["window"][1]))) for b in review]
    BOOKS_JSON.write_text(json.dumps(dict(
        seed=SEED, created="2026-10-13",
        rule="library books <= 30 MiB and <= 1,400 pages; lessons-in-industrial-instrumentation (a review book) exceeds both and is held out anyway",
        books=books, review_pages=review_pages), indent=1))
    fams = defaultdict(lambda: defaultdict(int))
    for b in books:
        fams[b["split"]][b["family"]] += 1
    print({k: dict(v) for k, v in fams.items()}, "subjects in train:", len({b["subject"] for b in books if b["split"] == "train"}))
