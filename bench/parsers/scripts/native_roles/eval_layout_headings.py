"""Rule-based heading recall (parser/odl/layout_headings.py) against the role labels.

usage:
  <parser venv>/bin/python eval_layout_headings.py parse [BOOK...]  # the 12 held-out (or the given) books
  eval_layout_headings.py train          # line rule vs labels on the 40 training books' sampled pages
  eval_layout_headings.py heldout        # parser vs parser + recall_headings (line + element level)
  eval_layout_headings.py heldout train  # the same, line level, on the training books `parse` was given

`parse` imports the parser from PARSER_DIR (default: the repository's parser/),
needs CAPY_RAPIDOCR_MODEL_DIR and writes OUT/current/<book>/{content_list.json,
refinement.json, result.json, parsed.pdf when a repair changed the bytes}.
`heldout` applies the rule offline to those outputs and scores with evaluate.py's
own line mapping (v13_line_roles) and element scoring (element_scores), so the
numbers sit next to eval_roles.json. Writes OUT/eval_layout_headings_train.json
and OUT/eval_layout_headings_<split>_blocks.json.
"""

import json
import os
import shutil
import sys
import time
from pathlib import Path

from common import OUT, REPO, REVIEW, book_pdf, load_books

PARSER_DIR = Path(os.environ.get("PARSER_DIR", REPO / "parser"))
sys.path.insert(0, str(PARSER_DIR))
CURRENT = OUT / "current"


def parse(*ids):
    """The held-out books, or the given (training) books."""
    from odl.refine import parse_pdf

    books = list(ids) or [b["id"] for b in load_books()["books"] if b["split"] == "heldout"]
    # the 3,311-page book last
    books.sort(key=lambda b: book_pdf(b).stat().st_size)
    for book in books:
        d = CURRENT / book
        if (d / "result.json").exists():
            continue
        shutil.rmtree(d, ignore_errors=True)
        (d / "work").mkdir(parents=True)
        t = time.perf_counter()
        p = parse_pdf(book_pdf(book).read_bytes(), d / "work", java_timeout_s=3600)
        (d / "content_list.json").write_text(json.dumps(p.content_list, ensure_ascii=False))
        (d / "refinement.json").write_text(json.dumps({"furniture": p.furniture}))
        if p.parsed_pdf:
            (d / "parsed.pdf").write_bytes(p.parsed_pdf)
        shutil.rmtree(d / "work", ignore_errors=True)
        r = dict(book=book, pages=p.page_count, seconds=round(time.perf_counter() - t, 1), parser=str(PARSER_DIR))
        (d / "result.json").write_text(json.dumps(r))
        print(json.dumps(r), flush=True)


def _labels(split):
    import pickle

    return [r for r in pickle.load((OUT / "labels.pkl").open("rb")) if r["split"] == split and r["sampled"]]


def _book_flags(book, pages):
    """The line rule on ``pages`` of one book, running heads from all its lines;
    {page: (texts, flags)}."""
    import pymupdf
    from odl import layout_headings as lh, page_text

    pdf = book_pdf(book)
    out = {}
    with pymupdf.open(pdf) as doc, page_text.session(pdf):
        facts = lh.census(doc)
        pseudo = []
        for page in doc:
            h, w = page.rect.height, page.rect.width
            for line in lh._lines(page):
                r = line["rect"]
                pseudo.append(dict(text=line["text"], page_idx=page.number,
                                   bbox=[r.x0 / w * 1000, r.y0 / h * 1000, r.x1 / w * 1000, r.y1 / h * 1000]))
        running = lh._running(pseudo)
        for p in pages:
            lines = lh._lines(doc[p])
            out[p] = ([l["text"] for l in lines], lh.heading_lines(doc[p], facts, running, lines))
    return out, facts


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0
    r = tp / (tp + fn) if tp + fn else 0
    return dict(p=round(p, 3), r=round(r, 3), f1=round(2 * p * r / (p + r), 3) if p + r else 0.0, tp=tp, fp=fp, fn=fn)


def train():
    """Line rule vs labels on the training books' sampled pages (labelled lines only)."""
    from collections import defaultdict

    recs = _labels("train")
    by_book = defaultdict(list)
    for r in recs:
        by_book[r["book"]].append(r)
    total = [0, 0, 0]
    per_book, fps, fns = {}, [], []
    for book, rs in sorted(by_book.items()):
        flags, facts = _book_flags(book, [r["page"] for r in rs])
        c = [0, 0, 0]
        for r in rs:
            texts, f = flags[r["page"]]
            assert len(texts) == len(r["roles"]), (book, r["page"], len(texts), len(r["roles"]))
            for i, role in enumerate(r["roles"]):
                if role is None:
                    continue
                gold, pred = role == "heading", f[i]
                if gold and pred:
                    c[0] += 1
                elif pred:
                    c[1] += 1
                    fps.append(f"{book[:26]} p{r['page'] + 1} [{role}] {texts[i][:70]}")
                elif gold:
                    c[2] += 1
                    fns.append(f"{book[:26]} p{r['page'] + 1} [{r['sources'][i]}] {texts[i][:70]}")
        per_book[book] = prf(*c) | dict(body=facts.body, gap=round(facts.gap, 1), heading_styles=len(facts.ranks))
        total = [a + b for a, b in zip(total, c)]
        print(f"{book[:40]:40s} {per_book[book]}", flush=True)
    out = dict(total=prf(*total), per_book=per_book, fp=fps, fn=fns)
    (OUT / "eval_layout_headings_train.json").write_text(json.dumps(out, indent=1))
    print("TOTAL", out["total"])


def _with_rule(book):
    """Current content list of a held-out book and the same after recall_headings,
    with the rule's cold and warm milliseconds per page."""
    import pymupdf
    from odl import page_text
    from odl.layout_headings import recall_headings

    d = CURRENT / book
    if not (d / "result.json").exists():  # fallback: the 2026-10-12 v13 whole-book parse
        d = REVIEW / "v13/odl/book" / book
    blocks = json.loads((d / "content_list.json").read_text())
    pdf = d / "parsed.pdf" if (d / "parsed.pdf").exists() else book_pdf(book)
    with pymupdf.open(pdf) as doc, page_text.session(pdf):
        t = time.perf_counter()
        after = recall_headings(blocks, doc)
        cold = time.perf_counter() - t
        t = time.perf_counter()
        recall_headings(blocks, doc)  # page reads cached up to page_text's span budget
        warm = time.perf_counter() - t
        pages = len(doc)
    furn = set(json.loads((d / "refinement.json").read_text())["furniture"])
    return blocks, after, furn, dict(pages=pages, cold_ms=round(1000 * cold / pages, 2), warm_ms=round(1000 * warm / pages, 2))


def heldout(split="heldout"):
    """Current parser vs current + recall_headings on the held-out books: line level
    on the sampled pages, element level on the 72 review pages, as evaluate.py roles.
    With "train", the training books that `parse` was given (line level only)."""
    import pickle
    from collections import defaultdict

    import numpy as np
    import pymupdf

    from common import ROLES
    from evaluate import element_scores, heading_match, v13_line_roles
    from features import is_running
    from train import scores

    recs = [r for r in pickle.load((OUT / "labels.pkl").open("rb")) if r["split"] == split]
    have = lambda b: (CURRENT / b / "result.json").exists() or (split == "heldout" and (REVIEW / "v13/odl/book" / b).exists())
    recs = [r for r in recs if have(r["book"])]
    variants = {}
    latency = {}
    for book in sorted({r["book"] for r in recs}):
        before, after, furn, latency[book] = _with_rule(book)
        latency[book]["source"] = "current" if (CURRENT / book / "result.json").exists() else "v13-2026-10-12"
        variants[book] = {}
        for name, blocks in (("current", before), ("rule", after)):
            by_page = defaultdict(list)
            for b in blocks:
                if len(b.get("bbox") or []) == 4:
                    by_page[b["page_idx"]].append(b)
            variants[book][name] = (by_page, furn)
        promoted = sum(b.get("_source_role") == "layout-heading" for b in after)
        print(book, latency[book], "promoted", promoted, flush=True)

    pages = {}
    for r in recs:
        if r["book"] not in pages:
            pages[r["book"]] = pickle.load((OUT / "pages" / f"{r['book']}.pkl").open("rb"))
        B = pages[r["book"]]
        pg = B["pages"][r["page"]]
        r["repeated"] = [is_running(B["stats"], l, pg["h"], r["page"], B["page_count"]) for l in pg["lines"]]
        for name in ("current", "rule"):
            by_page, furn = variants[r["book"]][name]
            r[name] = v13_line_roles(pg["lines"], by_page.get(r["page"], []), furn, pg["w"], pg["h"])

    idx = lambda v: ROLES.index("furniture" if v == "dropped" else v)
    out = {"latency": latency}
    held = [r for r in recs if r["sampled"]]
    g, bk, pred = [], [], {"current": [], "rule": []}
    fps, fns = [], []
    for r in held:
        for i, role in enumerate(r["roles"]):
            if not role:
                continue
            g.append(ROLES.index(role))
            bk.append(r["book"])
            for name in pred:
                pred[name].append(idx(r[name][i]))
            new = r["rule"][i] == "heading" and r["current"][i] != "heading"
            line = f"{r['book'][:28]} p{r['page'] + 1} [{role}] {r['texts'][i][:70]}"
            if new and role != "heading":
                fps.append(line)
            if role == "heading" and r["rule"][i] != "heading":
                fns.append(line + f" -> {r['rule'][i]}")
    g, bk = np.array(g), np.array(bk)
    pred = {k: np.array(v) for k, v in pred.items()}
    out["heldout"] = {k: scores(g, v)["heading"] for k, v in pred.items()}
    out["heldout"]["per_book"] = {
        b: dict(n=int((g[bk == b] == ROLES.index("heading")).sum()),
                **{k: scores(g[bk == b], v[bk == b])["heading"]["f1"] for k, v in pred.items()})
        for b in sorted(set(bk))}
    out["heldout"]["repeated_as_heading"] = {
        k: sum(1 for r in held for i, f in enumerate(r["repeated"]) if f and r[k][i] == "heading") for k in pred}

    reviews = {}
    for f in (REVIEW / "review").glob("*.json"):
        for e in json.loads(f.read_text()):
            reviews[(f.stem, e["page"] - 1)] = e
    H = defaultdict(list)
    tocs = {}
    for r in recs:
        e = reviews.get((r["book"], r["page"])) if r["review"] else None
        if e is None:
            continue
        texts = r["texts"]
        if r["book"] not in tocs:
            tocs[r["book"]] = pymupdf.open(book_pdf(r["book"])).get_toc()
        outl = [heading_match(texts, t) for _, t, p in tocs[r["book"]] if p == r["page"] + 1]
        heads = [heading_match(texts, h["desc"]) for h in e.get("headings", [])] + outl
        block = [heading_match(texts, h["desc"]) for h in e.get("headings", []) if "run-in" not in h["desc"]] + outl
        for name in ("current", "rule"):
            flags = [x == "heading" for x in r[name]]
            H[name].append((texts, heads, flags, r["repeated"]))
            H[name + ":no_runin"].append((texts, block, flags, r["repeated"]))
            H[f"{name}:{r['book']}"].append((texts, block, flags, r["repeated"]))
    out["review"] = {k: element_scores(v, "heading") for k, v in H.items()}
    out["examples"] = dict(new_fp=fps, missed=fns)
    (OUT / f"eval_layout_headings_{split}_blocks.json").write_text(json.dumps(out, indent=1, default=int))
    for k in ("current", "rule"):
        a = out["heldout"][k]
        print(f"{k:8s} line P/R/F1={a['p']:.3f}/{a['r']:.3f}/{a['f1']:.3f}", end="")
        if out["review"]:
            e1, e2 = out["review"][k + ":no_runin"], out["review"][k]
            print(f"  review={e1['p']:.3f}/{e1['r']:.3f}/{e1['f1']:.3f}  review+run-in={e2['p']:.3f}/{e2['r']:.3f}/{e2['f1']:.3f}", end="")
        print()
    print(json.dumps(out["heldout"]["per_book"], indent=0))
    print("new FP", len(fps), "missed", len(fns))


if __name__ == "__main__":
    {"parse": parse, "train": train, "heldout": heldout}[sys.argv[1]](*sys.argv[2:])
