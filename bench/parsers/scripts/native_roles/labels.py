"""Extract the selected pages and label every text line.

usage:
  labels.py extract   # OUT/pages/<book>.pkl: book stats from all pages + the selected pages
  labels.py build     # OUT/labels.pkl and OUT/label_stats.json (needs both teacher runs)

Label sources, in priority order:
  1. outline: a PDF outline title found on its target page -> heading, level = outline depth;
  2. repetition: a top/bottom-band line whose key (text with digits folded, size) recurs on
     3 pages of the book, and whose exact text recurs on 3 pages or whose number
     follows the page number -> furniture (features.is_running);
  3. teachers: PP-DocLayoutV3 and Docling Egret-medium must agree (fixtures classmap);
  everything else stays unlabelled and is left out of training and scoring.
Tag trees are not used (see README).
"""

import json
import pickle
import re
import sys
from collections import Counter, defaultdict

import numpy as np
import pymupdf

from common import CLASSMAP_JSON, OUT, book_pdf, load_books, selected_pages
from features import band_of, book_stats, extract_page, is_running


def extract():
    want = defaultdict(set)
    for book, p in selected_pages():
        want[book].add(p)
    (OUT / "pages").mkdir(parents=True, exist_ok=True)
    for book, pages in want.items():
        path = OUT / "pages" / f"{book}.pkl"
        if path.exists():
            continue
        doc = pymupdf.open(book_pdf(book))
        allp = [extract_page(pg) for pg in doc]
        tagged = doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[0] != "null"
        pickle.dump(dict(stats=book_stats(allp), toc=doc.get_toc(), page_count=doc.page_count, tagged=tagged,
                         pages={p: allp[p] for p in pages}), path.open("wb"))
        print(book, doc.page_count, flush=True)


norm = lambda s: re.sub(r"\W", "", s.lower())


def outline_lines(lines, toc_entries, running, bands):
    """{line index: level} for outline titles on this page."""
    out = {}
    nl = [norm(l["text"]) for l in lines]
    for lvl, title, _ in toc_entries:
        t = norm(title)
        if len(t) < 3:
            continue
        cand = [i for i, s in enumerate(nl) if s and i not in out and not running[i] and
                ((s in t and len(s) >= min(3, len(t))) or (t in s and len(s) - len(t) <= 12))]
        runs, run = [], []
        for i in cand:
            if run and i != run[-1] + 1:
                runs.append(run)
                run = []
            run.append(i)
        if run:
            runs.append(run)
        best = None
        for r in runs:
            joined = "".join(nl[i] for i in r)
            cover = 1.0 if t in joined else (len(joined) / len(t) if joined in t else 0)
            size = max(s[0] for i in r for s in lines[i]["spans"])
            # a band copy (a running head naming the section) loses to a body copy
            score = (not any(bands[i] for i in r), cover, size)
            if cover >= 0.6 and (best is None or score > best[0]):
                best = (score, r)
        if best:
            out.update({i: lvl for i in best[1]})
    return out


def region_roles(lines, boxes, cmap):
    """Role of the smallest mapped region holding >= 50% of each line, else None."""
    if not lines:
        return []
    bb = np.array([l["bbox"] for l in lines])
    area = np.maximum((bb[:, 2] - bb[:, 0]) * (bb[:, 3] - bb[:, 1]), 1e-6)
    roles = [None] * len(lines)
    best = np.full(len(lines), np.inf)
    for lab, _, *r in boxes:
        role = cmap.get(lab)
        if role is None:
            continue
        w = np.clip(np.minimum(bb[:, 2], r[2]) - np.maximum(bb[:, 0], r[0]), 0, None)
        h = np.clip(np.minimum(bb[:, 3], r[3]) - np.maximum(bb[:, 1], r[1]), 0, None)
        ra = (r[2] - r[0]) * (r[3] - r[1])
        for i in np.nonzero((w * h / area >= 0.5) & (ra < best))[0]:
            roles[i], best[i] = role, ra
    return roles


def agree(a, b, rule):
    if a is None or b is None:
        return None
    if a == b:
        return a
    if a in rule.get(b, []):
        return b
    return None


def build():
    cmap = json.loads(CLASSMAP_JSON.read_text())
    rule = cmap["agreement"]["egret_only"]
    teach = {}
    for m in ("v3", "egret"):
        teach[m] = {json.loads(l)["page"]: json.loads(l)["boxes"] for l in (OUT / "teacher" / f"{m}.jsonl").open()}
    man = load_books()
    split = {b["id"]: b["split"] for b in man["books"]}
    sampled = {(b["id"], p) for b in man["books"] for p in b["sample_pages"]}
    review = {(r["id"], p) for r in man["review_pages"] for p in r["pages"]}
    recs, stats = [], defaultdict(Counter)
    books = {}
    for book, p in selected_pages():
        if book not in books:
            books[book] = pickle.load((OUT / "pages" / f"{book}.pkl").open("rb"))
        B = books[book]
        pg = B["pages"][p]
        lines = pg["lines"]
        key = f"{book}/{p}"
        if key not in teach["v3"] or key not in teach["egret"]:
            continue
        v3 = region_roles(lines, teach["v3"][key], cmap["v3"])
        eg = region_roles(lines, teach["egret"][key], cmap["egret"])
        bands = [band_of(l["bbox"], pg["h"]) for l in lines]
        running = [is_running(B["stats"], l, pg["h"], p, B["page_count"]) for l in lines]
        outl = outline_lines(lines, [e for e in B["toc"] if e[2] == p + 1], running, bands)
        roles, levels, sources = [], [], []
        for i in range(len(lines)):
            if i in outl:
                r, lv, s = "heading", outl[i], "outline"
            elif running[i]:
                r, lv, s = "furniture", None, "repetition"
            else:
                r, lv, s = agree(v3[i], eg[i], rule), None, "teachers"
                if r is None:
                    s = None
            roles.append(r)
            levels.append(lv)
            sources.append(s)
            st = stats[split[book] if (book, p) in sampled else "review"]
            st["lines"] += 1
            st[f"source:{s}"] += 1
            if v3[i] and eg[i]:
                st["both_teachers"] += 1
                st["teachers_disagree"] += agree(v3[i], eg[i], rule) is None
                if agree(v3[i], eg[i], rule) is None:
                    stats["disagree_pairs"][f"{v3[i]}|{eg[i]}"] += 1
            elif v3[i] or eg[i]:
                st["one_teacher"] += 1
            if s == "outline":
                stats["outline_vs_teachers"][f"v3={v3[i]} egret={eg[i]}"] += 1
            if s == "repetition":
                stats["repetition_vs_teachers"][f"v3={v3[i]} egret={eg[i]}"] += 1
            if r:
                stats[f"role:{split[book] if (book, p) in sampled else 'review'}"][r] += 1
        figs = {m: [b[2:] for b in teach[m][key] if cmap[m].get(b[0]) == "figure_label"] for m in teach}
        recs.append(dict(book=book, page=p, split=split[book], sampled=(book, p) in sampled, review=(book, p) in review,
                         roles=roles, levels=levels, sources=sources, v3=v3, egret=eg, figures=figs,
                         texts=[l["text"] for l in lines]))
    pickle.dump(recs, (OUT / "labels.pkl").open("wb"))
    tagged = {b: B["tagged"] for b, B in books.items()}
    out = {k: dict(v.most_common()) for k, v in stats.items()}
    out["tagged_books"] = sum(tagged.values())
    out["books"] = len(tagged)
    (OUT / "label_stats.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in out.items() if not k.endswith("_teachers") and k != "disagree_pairs"}, indent=1))


if __name__ == "__main__":
    {"extract": extract, "build": build}[sys.argv[1]]()
