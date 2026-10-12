"""Held-out, review-page, figure-region and latency evaluation.

usage:
  evaluate.py roles     # held-out books + 72 review pages vs labels, reviewers, outline and v13
  evaluate.py figures   # _figure_clusters proposals vs teacher figure boxes
  evaluate.py latency   # extraction + features + inference per page, 1 and 4 threads
Writes OUT/eval_*.json.
"""

import json
import os
import pickle
import re
import sys
import time
from collections import Counter, defaultdict

import lightgbm as lgb
import numpy as np
import pymupdf

from common import OUT, REPO, REVIEW, ROLES, book_pdf, load_books
from features import extract_page, featurize, is_running
from train import confusion, page_features, scores

sys.path.insert(0, str(REPO / "parser"))
from odl.furniture import clean_inline, normalized  # noqa: E402
from odl.pictures import VECTOR_MAX_TEXT, VECTOR_MIN_AREA, VECTOR_MIN_SEGMENTS, _figure_clusters  # noqa: E402

norm = lambda s: re.sub(r"\W", "", s.lower())
TOK = re.compile(r"[^\W\d_]+|\d+(?:[.,]\d+)*")


def v13_blocks(book):
    d = REVIEW / "v13/odl/book" / book
    if not d.exists():
        d = OUT / "v13" / book
    blocks = json.loads((d / "content_list.json").read_text())
    furn = set(json.loads((d / "refinement.json").read_text())["furniture"])
    by_page = defaultdict(list)
    for b in blocks:
        if len(b.get("bbox") or []) == 4:
            by_page[b["page_idx"]].append(b)
    return by_page, furn


def v13_role(b, furn):
    t, nt, src = b["type"], b.get("_native_type"), b.get("_source_role")
    if t == "discarded":
        return "furniture"
    if b.get("text_level"):
        return "heading"
    if t == "image" or src == "figure-label":
        return "figure_label"
    if t == "table":
        return "table_cell"
    if t == "equation" or src in ("calculation", "formula-fragment"):  # v13 demotes these to text
        return "formula"
    if t == "list":
        return "list"
    if nt == "caption":
        return "caption"
    if t == "text" and normalized(clean_inline(str(b.get("text") or ""))) in furn:
        return "furniture"
    return "body"


def v13_line_roles(lines, blocks, furn, W, H):
    """Role of the v13 block holding >= 50% of each line, preferring a block whose text
    contains the line, then the smallest; a line in no block was dropped by the parser
    and scores as furniture."""
    texts = [norm(str(b.get("text") or "") + " ".join(map(str, b.get("list_items") or []))) for b in blocks]
    out = []
    for l in lines:
        x0, y0, x1, y1 = l["bbox"]
        a = max((x1 - x0) * (y1 - y0), 1e-6)
        key = norm(l["text"])[:15]
        best = None
        for b, bt in zip(blocks, texts):
            bx0, by0, bx1, by1 = b["bbox"][0] * W / 1000, b["bbox"][1] * H / 1000, b["bbox"][2] * W / 1000, b["bbox"][3] * H / 1000
            ov = max(0, min(x1, bx1) - max(x0, bx0)) * max(0, min(y1, by1) - max(y0, by0))
            if ov / a >= 0.5:
                rank = (not (key and key in bt), (bx1 - bx0) * (by1 - by0))
                if best is None or rank < best[0]:
                    best = (rank, v13_role(b, furn))
        out.append(best[1] if best else "dropped")
    return out


def runs(flags):
    out, cur = [], []
    for i, f in enumerate(flags):
        if f:
            cur.append(i)
        elif cur:
            out.append(cur)
            cur = []
    return out + ([cur] if cur else [])


def heading_match(texts, desc):
    """Lines holding a heading text; a reviewer's trailing "(run-in ...)" note is dropped
    and a run-in heading matches the start of its paragraph line."""
    d = norm(re.sub(r"\s*\([^)]*\)\s*$", "", desc))
    return [i for i, t in enumerate(texts) if (s := norm(t)) and len(d) >= 2 and
            ((s in d and len(s) >= min(3, len(d))) or (d in s and len(s) - len(d) <= 12) or s.startswith(d))]


def formula_match(texts, desc):
    dt = Counter(TOK.findall(desc))
    out = []
    for i, t in enumerate(texts):
        lt = TOK.findall(t)
        if not lt or (len(lt) < 2 and sum(dt.values()) > 3):
            continue
        hit = sum(min(c, dt[k]) for k, c in Counter(lt).items())
        if hit >= 0.7 * len(lt):
            out.append(i)
    return out


def element_scores(pages, kind):
    """Element-level P/R for headings or formulas on review pages.
    pages: [(texts, gold element line lists, predicted flags, band-repeated flags)]."""
    found = total = tp_runs = fp_runs = fp_running = unmatched = 0
    for texts, gold, pred, repeated in pages:
        unmatched += sum(not g for g in gold)
        if kind == "heading":  # a heading listed by the reviewer and the outline counts once
            merged = []
            for g in gold:
                if g and not any(set(g) & set(m) for m in merged):
                    merged.append(g)
            gold = merged
        gold = [g for g in gold if g]
        gold_lines = set(i for g in gold for i in g)
        total += len(gold)
        found += sum(any(pred[i] for i in g) for g in gold)
        for r in runs(pred):
            if gold_lines & set(r):
                tp_runs += 1
            else:
                fp_runs += 1
                fp_running += any(repeated[i] for i in r)
    p = tp_runs / (tp_runs + fp_runs) if tp_runs + fp_runs else 0
    r = found / total if total else 0
    return dict(kind=kind, gold=total, unmatched_gold=unmatched, found=found, pred_runs=tp_runs + fp_runs, fp_runs=fp_runs,
                fp_running_heads=fp_running, p=round(p, 3), r=round(r, 3),
                f1=round(2 * p * r / (p + r), 3) if p + r else 0.0)


def roles():
    recs = pickle.load((OUT / "labels.pkl").open("rb"))
    feats = page_features(recs)
    model = lgb.Booster(model_file=str(OUT / "model.txt"))
    pagecache = {}

    def page(book, p):
        if book not in pagecache:
            pagecache[book] = pickle.load((OUT / "pages" / f"{book}.pkl").open("rb"))
        return pagecache[book]["pages"][p], pagecache[book]

    v13 = {}
    for r in recs:
        if r["split"] != "heldout":
            continue
        pg, B = page(r["book"], r["page"])
        r["pred"] = [ROLES[i] for i in model.predict(feats[(r["book"], r["page"])]).argmax(1)] if pg["lines"] else []
        r["repeated"] = [is_running(B["stats"], l, pg["h"], r["page"], B["page_count"]) for l in pg["lines"]]
        if r["book"] not in v13:
            v13[r["book"]] = v13_blocks(r["book"])
        blocks, furn = v13[r["book"]]
        r["v13"] = v13_line_roles(pg["lines"], blocks.get(r["page"], []), furn, pg["w"], pg["h"])

    out = {}
    # (b) held-out sampled pages vs labels, model and v13
    held = [r for r in recs if r["split"] == "heldout" and r["sampled"]]
    g, pm, pv, bk = [], [], [], []
    for r in held:
        for i, role in enumerate(r["roles"]):
            if role:
                g.append(ROLES.index(role))
                pm.append(ROLES.index(r["pred"][i]))
                v = r["v13"][i]
                pv.append(ROLES.index("furniture" if v == "dropped" else v))
                bk.append(r["book"])
    g, pm, pv, bk = map(np.array, (g, pm, pv, bk))
    out["heldout"] = dict(lines=len(g), model=scores(g, pm), v13=scores(g, pv), confusion=confusion(g, pm),
                          v13_confusion=confusion(g, pv), per_book={})
    for b in sorted(set(bk)):
        s = bk == b
        out["heldout"]["per_book"][b] = {
            c: dict(n=int((g[s] == ROLES.index(c)).sum()), model=scores(g[s], pm[s])[c]["f1"], v13=scores(g[s], pv[s])[c]["f1"])
            for c in ("heading", "furniture", "formula", "figure_label", "body", "list", "code")}
    # running headers promoted to heading
    out["heldout"]["repeated_as_heading"] = dict(
        model=sum(1 for r in held for i, f in enumerate(r["repeated"]) if f and r["pred"][i] == "heading"),
        v13=sum(1 for r in held for i, f in enumerate(r["repeated"]) if f and r["v13"][i] == "heading"),
        repeated_lines=sum(sum(map(bool, r["repeated"])) for r in held))
    # dropped-by-v13 lines that the labels call content
    out["heldout"]["v13_dropped_content"] = Counter(r["roles"][i] for r in held for i, v in enumerate(r["v13"]) if v == "dropped" and r["roles"][i] not in (None, "furniture"))

    # outline headings on held-out pages (teacher-independent)
    oh = [(r["pred"][i], r["v13"][i]) for r in held for i, s in enumerate(r["sources"]) if s == "outline"]
    out["heldout"]["outline_heading_recall"] = dict(n=len(oh), model=round(sum(p == "heading" for p, _ in oh) / max(1, len(oh)), 3),
                                                    v13=round(sum(v == "heading" for _, v in oh) / max(1, len(oh)), 3))

    # (c) review pages: reviewer element lists + outline
    rev = [r for r in recs if r["review"]]
    reviews = {}
    for f in (REVIEW / "review").glob("*.json"):
        for e in json.loads(f.read_text()):
            reviews[(f.stem, e["page"] - 1)] = e
    H, F = defaultdict(list), defaultdict(list)
    toc_cache = {}
    for r in rev:
        e = reviews.get((r["book"], r["page"]))
        if e is None:
            continue
        texts = r["texts"]
        if r["book"] not in toc_cache:
            toc_cache[r["book"]] = pymupdf.open(book_pdf(r["book"])).get_toc()
        outl = [heading_match(texts, t) for _, t, p in toc_cache[r["book"]] if p == r["page"] + 1]
        heads = [heading_match(texts, h["desc"]) for h in e.get("headings", [])] + outl
        # run-in headings sit inside a paragraph line: no line role can mark them
        heads_block = [heading_match(texts, h["desc"]) for h in e.get("headings", []) if "run-in" not in h["desc"]] + outl
        forms = [formula_match(texts, f["desc"]) for f in e.get("formulas", [])]
        rep = r["repeated"]
        for who in ("pred", "v13", "roles"):  # "roles" = the training labels themselves
            roles_ = r[who]
            H[who].append((texts, heads, [x == "heading" for x in roles_], rep))
            F[who].append((texts, forms, [x == "formula" for x in roles_], rep))
            H[who + ":no_runin"].append((texts, heads_block, [x == "heading" for x in roles_], rep))
            H[who + ":outline"].append((texts, outl, [x == "heading" for x in roles_], rep))
            H[f"{who}:{r['book']}"].append((texts, heads, [x == "heading" for x in roles_], rep))
            F[f"{who}:{r['book']}"].append((texts, forms, [x == "formula" for x in roles_], rep))
    out["review"] = dict(
        pages=len(H["pred"]),
        heading={k: element_scores(v, "heading") for k, v in H.items()},
        formula={k: element_scores(v, "formula") for k, v in F.items()},
    )
    # review pages vs labels (furniture has no reviewer list)
    g, pm, pv = [], [], []
    for r in rev:
        for i, role in enumerate(r["roles"]):
            if role:
                g.append(ROLES.index(role))
                pm.append(ROLES.index(r["pred"][i]))
                pv.append(ROLES.index("furniture" if r["v13"][i] == "dropped" else r["v13"][i]))
    out["review"]["vs_labels"] = dict(lines=len(g), model=scores(np.array(g), np.array(pm)), v13=scores(np.array(g), np.array(pv)))

    # failure examples on held-out pages
    ex = defaultdict(list)
    rng = np.random.default_rng(5)
    for r in rng.permutation(np.array(held, dtype=object)):
        for i, role in enumerate(r["roles"]):
            p = r["pred"][i]
            for c in ("heading", "furniture", "formula", "list", "code", "caption"):
                kind = f"{c}:fn" if role == c and p != c else f"{c}:fp" if p == c and role and role != c else None
                if kind and len(ex[kind]) < 8:
                    ex[kind].append(f"{r['book'][:28]} p{r['page'] + 1} [{role}->{p}, {r['sources'][i]}] {r['texts'][i][:70]}")
    out["examples"] = ex
    (OUT / "eval_roles.json").write_text(json.dumps(out, indent=1, default=int))
    pickle.dump([{k: r.get(k) for k in ("book", "page", "split", "sampled", "review", "roles", "sources", "pred", "v13", "texts", "levels")}
                 for r in recs if r["split"] == "heldout"], (OUT / "heldout_pred.pkl").open("wb"))
    for k in ("heading", "furniture", "formula", "list", "code", "caption", "footnote", "figure_label", "table_cell", "body"):
        a, b = out["heldout"]["model"][k], out["heldout"]["v13"][k]
        print(f"{k:12s} n={a['n']:5d} model P/R/F1={a['p']:.2f}/{a['r']:.2f}/{a['f1']:.2f}  v13={b['p']:.2f}/{b['r']:.2f}/{b['f1']:.2f}")
    print(json.dumps({k: v for k, v in out["review"]["heading"].items() if ":" not in k or "outline" in k or "runin" in k}, indent=0))
    print(json.dumps({k: v for k, v in out["review"]["formula"].items() if ":" not in k}, indent=0))


def iou(a, b):
    w = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = w * h
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0


def proposals(page):
    """The parser's vector-figure gate without the ODL block checks."""
    area = page.rect.width * page.rect.height
    imgs = [pymupdf.Rect(i["bbox"]) for i in page.get_image_info()]
    words = [pymupdf.Rect(w[:4]) for w in page.get_text("words")]
    out = []
    for rect, segs, _ in _figure_clusters(page):
        if segs < VECTOR_MIN_SEGMENTS or rect.width * rect.height < VECTOR_MIN_AREA * area:
            continue
        if any(abs(rect & t) > 0.5 * min(abs(rect), abs(t)) for t in imgs if abs(t)):
            continue
        if sum(abs(w & rect) for w in words) > VECTOR_MAX_TEXT * abs(rect):
            continue
        out.append(tuple(rect))
    return out


def figures():
    recs = pickle.load((OUT / "labels.pkl").open("rb"))
    res = defaultdict(Counter)
    docs = {}
    for r in recs:
        doc = docs.setdefault(r["book"], pymupdf.open(book_pdf(r["book"])))
        page = doc[r["page"]]
        props = proposals(page)
        imgs = [i["bbox"] for i in page.get_image_info()]
        draws = [d["rect"] for d in page.get_cdrawings()]
        v3, eg = r["figures"]["v3"], r["figures"]["egret"]
        gold = []
        for a in v3:
            if not any(iou(a, b) >= 0.5 for b in eg):
                continue
            ar = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
            raster = sum(max(0, min(a[2], i[2]) - max(a[0], i[0])) * max(0, min(a[3], i[3]) - max(a[1], i[1])) for i in imgs) / ar
            inside = sum(1 for d in draws if d[0] >= a[0] - 2 and d[1] >= a[1] - 2 and d[2] <= a[2] + 2 and d[3] <= a[3] + 2)
            if raster < 0.5 and inside >= 3:
                gold.append(a)
        anyfig = v3 + eg
        for key in ("all", r["split"] if r["sampled"] else "review"):
            c = res[key]
            c["pages"] += 1
            c["gold"] += len(gold)
            c["proposals"] += len(props)
            for t in (0.5, 0.3):
                c[f"recall@{t}"] += sum(any(iou(g, p) >= t for p in props) for g in gold)
                c[f"precision@{t}"] += sum(any(iou(p, g) >= t for g in anyfig) for p in props)
    out = {}
    for k, c in res.items():
        out[k] = dict(c) | {f"R@{t}": round(c[f"recall@{t}"] / max(1, c["gold"]), 3) for t in (0.5, 0.3)} | \
            {f"P@{t}": round(c[f"precision@{t}"] / max(1, c["proposals"]), 3) for t in (0.5, 0.3)}
    (OUT / "eval_figures.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))


def latency():
    model = lgb.Booster(model_file=str(OUT / "model.txt"))
    man = load_books()
    out = {"load_before": os.getloadavg()}
    for threads in (1, 4, 1, 4):
        ex, fe, pr = [], [], []
        for b in man["books"]:
            if b["split"] != "heldout":
                continue
            B = pickle.load((OUT / "pages" / f"{b['id']}.pkl").open("rb"))
            doc = pymupdf.open(book_pdf(b["id"]))
            for p in b["sample_pages"]:
                t0 = time.perf_counter()
                pg = extract_page(doc[p])
                t1 = time.perf_counter()
                X = featurize(pg, B["stats"], B["page_count"])
                t2 = time.perf_counter()
                if len(X):
                    model.predict(X, num_threads=threads)
                t3 = time.perf_counter()
                ex.append(t1 - t0)
                fe.append(t2 - t1)
                pr.append(t3 - t2)
        tot = np.array(ex) + np.array(fe) + np.array(pr)
        q = lambda a: [round(float(np.percentile(np.array(a) * 1000, x)), 2) for x in (50, 90, 99)]
        out.setdefault(f"threads={threads}", []).append(dict(pages=len(tot), extract=q(ex), features=q(fe), predict=q(pr), total=q(tot),
                                                              load=os.getloadavg()))
        print(threads, out[f"threads={threads}"][-1], flush=True)
    (OUT / "eval_latency.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    {"roles": roles, "figures": figures, "latency": latency}[sys.argv[1]]()
