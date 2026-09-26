"""Score every arm, compare with the baselines, and write review packets.

  python analyze.py            # results.json, tables.md, review/*.md

Arms per protocol.json as amended: hybrid (production), dense, and each
reranker score file over the shared 40-chunk pool (hybrid40 = dense40 = union
for every query). Every arm's chunk order goes through the production library
fold (first_stage.fold). Excerpt level is primary; chunk level counts the
excerpt's displayed hit chunk.

Also computes: order and composition dependence of the scores (sample.json:
the same 40 documents in fused order, and the first 20 for Alibaba), latency
and billed tokens per request, agreement between rerankers (does Alibaba
qwen3-rerank track one DeepInfra size?), pairwise model/instruction deltas,
and the exploratory top-k variant (rerank only the first k candidates).
"""

from __future__ import annotations

import math
import random
import re
import statistics
from collections import defaultdict

import numpy as np
import rr
from first_stage import fold, queries

GROUP_OF = {"mono_en": "monolingual EN", "cross": "cross-lingual", "en_to_es": "cross-lingual", "paraphrase": "paraphrase",
            "mono_es": "monolingual non-EN", "samedoc": "samedoc", "nearmiss": "nearmiss"}
GROUPS = ["monolingual EN", "cross-lingual", "paraphrase", "monolingual non-EN", "samedoc", "nearmiss"]
METRICS = ("mrr10", "hit1", "hit5", "ndcg5")
SEED = 20260925
USD_PER_CNY = 1 / 7.1  # approximate conversion for the cost table only


def scores_of(rank: int | None) -> dict:
    return {
        "rank": rank,
        "mrr10": 1 / rank if rank and rank <= 10 else 0.0,
        "hit1": int(bool(rank) and rank == 1),
        "hit5": int(bool(rank) and rank <= 5),
        "ndcg5": 1 / math.log2(1 + rank) if rank and rank <= 5 else 0.0,
    }


def paired_bootstrap(deltas: dict, strata: dict, n: int = 2000, seed: int = SEED):
    return rr.q37.paired_bootstrap(deltas, strata, seed=seed, n=n)


def cluster_bootstrap(deltas: dict, cluster: dict, n: int = 2000, seed: int = SEED):
    groups = defaultdict(list)
    for k, v in deltas.items():
        groups[cluster[k]].append(v)
    keys = sorted(groups)
    rng = random.Random(seed)
    means = []
    for _ in range(n):
        pick = [rng.choice(keys) for _ in keys]
        vals = [v for g in pick for v in groups[g]]
        means.append(sum(vals) / len(vals))
    means.sort()
    return sum(deltas.values()) / len(deltas), [means[int(0.025 * n) - 1], means[int(0.975 * n) - 1]]


def main():
    chunks, excerpts, books = rr.load_snapshot(verify=False)
    by_id = {c["id"]: c for c in chunks}
    text_of = {c["id"]: c["text"] for c in chunks}
    excerpt_of = {c["id"]: rr.excerpt_key(c) for c in chunks}
    file_of = {b["content_id"]: b["file_id"] for b in books}
    book_file = {c["id"]: file_of[c["content_id"]] for c in chunks}
    pools = rr.read_json(rr.DATA / "pools.json")
    items = queries()
    strata = {q["id"]: q["cohort"] for q in items}
    book_cluster = {q["id"]: q["book_id"] for q in items}
    score_files = {p.stem: rr.read_json(p) for p in sorted((rr.DATA / "scores").glob("*.json"))}

    def order_for(q, arm):
        p = pools[q["id"]]
        hyb = [r["id"] for r in p["hybrid"]]
        den = [d["id"] for d in p["dense"]]
        if arm == "hybrid":
            return hyb
        if arm == "dense":
            return den
        run = arm.split("@", 1)[0]
        s = score_files[run]["scores"].get(q["id"])
        if s is None:
            return None
        # The one shared 40-chunk pool (protocol amendment 1); ties keep the fused order.
        base = {c: i for i, c in enumerate(hyb)}
        return sorted(base, key=lambda c: (-s[c], base[c], c))

    for q in items:
        p = pools[q["id"]]
        assert {r["id"] for r in p["hybrid"]} == {d["id"] for d in p["dense"]} == set(p["union"]), q["id"]
    arms = ["hybrid", "dense"] + [f"{run}@pool40" for run in score_files]
    records = []
    for q in items:
        rel_x, rel_c, wrong = set(q["relevant_excerpts"]), set(q["relevant"]), set(q["wrong"])
        wrong_x = {excerpt_of[w] for w in wrong} - rel_x
        rec = {"id": q["id"], "cohort": q["cohort"], "group": GROUP_OF[q["cohort"]], "lang": q["lang"], "book_id": q["book_id"],
               "subtype": q.get("subtype"), "arms": {}}
        for arm in arms:
            order = order_for(q, arm)
            if order is None:
                rec["arms"][arm] = None
                continue
            folded = fold(order, text_of, excerpt_of, book_file)
            xr = next((i for i, (x, _) in enumerate(folded, 1) if x in rel_x), None)
            cr = next((i for i, (_, c) in enumerate(folded, 1) if c in rel_c), None)
            wr = next((i for i, (x, _) in enumerate(folded, 1) if x in wrong_x), None)
            capped = cap_per_book(folded, by_id)
            xr_cap = next((i for i, (x, _) in enumerate(capped, 1) if x in rel_x), None)
            rec["recall40"] = any(x in rel_x for x, _ in folded) if arm == "hybrid" else rec.get("recall40")
            rec["arms"][arm] = {
                "excerpt": scores_of(xr),
                "chunk": scores_of(cr),
                "capped": scores_of(xr_cap),
                "cap_changed_top5": [x for x, _ in capped[:5]] != [x for x, _ in folded[:5]],
                "distractor_above": bool(wrong_x) and wr is not None and (xr is None and wr <= 10 or xr is not None and wr < xr),
                "top5": [[x, c] for x, c in folded[:5]],
                "top10": [x for x, _ in folded[:10]],
            }
        records.append(rec)

    summary = summarize(records, arms, strata, book_cluster)
    summary["recall40"] = {g: float(np.mean([r["recall40"] for r in records if g == "all" or r["group"] == g]))
                           for g in ["all"] + GROUPS}
    best = pick_best(summary, score_files)
    summary["best_arm"] = best
    summary["replay"] = replay_check(pools)
    summary["operations"] = operations(score_files)
    summary["identity"] = identity(score_files, pools)
    summary["pairs"] = pair_deltas(records, strata, [
        ("ali-qwen3-rerank__learner@pool40", "ali-qwen3-rerank__default@pool40"),
        ("di-8b__default@pool40", "di-4b__default@pool40"),
        ("di-4b__default@pool40", "ali-qwen3-rerank__default@pool40"),
        ("di-8b__default@pool40", "ali-qwen3-rerank__default@pool40"),
        ("di-4b__default@pool40", "di-0.6b__default@pool40"),
    ])
    summary["order_jitter"] = order_jitter(items, pools, text_of, excerpt_of, book_file)
    summary["topk"] = topk(items, pools, score_files, text_of, excerpt_of, book_file, {c["id"]: c["indexed_text"] for c in chunks})
    rr.write_json(rr.DATA / "results.json", {"summary": summary, "records": records})
    write_review(records, best, by_id, excerpts, items)
    write_review(records, best, by_id, excerpts, items, base="dense", suffix="-vs-dense")
    write_review(records, "ali-qwen3-rerank__default@pool40", by_id, excerpts, items, suffix="-alibaba")
    write_tables(summary, arms)
    print("best arm:", best)


def pair_deltas(records, strata, pairs):
    out = {}
    for a, b in pairs:
        ok = [r for r in records if r["arms"].get(a) and r["arms"].get(b)]
        entry = {}
        for name, rows in (("all", ok), ("existing", [r for r in ok if r["cohort"] not in ("samedoc", "nearmiss")]),
                           ("new", [r for r in ok if r["cohort"] in ("samedoc", "nearmiss")])):
            e = {}
            for m in ("mrr10", "hit1", "hit5"):
                d = {r["id"]: r["arms"][a]["excerpt"][m] - r["arms"][b]["excerpt"][m] for r in rows}
                mean, ci = paired_bootstrap(d, strata)
                e[m] = {"delta": mean, "ci95": ci}
            e["hit1_gains"] = sum(r["arms"][a]["excerpt"]["hit1"] > r["arms"][b]["excerpt"]["hit1"] for r in rows)
            e["hit1_losses"] = sum(r["arms"][a]["excerpt"]["hit1"] < r["arms"][b]["excerpt"]["hit1"] for r in rows)
            entry[name] = e
        out[f"{a} - {b}"] = entry
    return out


def rank_first(order, rel_x, text_of, excerpt_of, book_file):
    folded = fold(order, text_of, excerpt_of, book_file)
    return next((i for i, (x, _) in enumerate(folded, 1) if x in rel_x), None)


def order_jitter(items, pools, text_of, excerpt_of, book_file):
    """Metrics on the 50 sample queries with scores from the chunk-id-order request
    versus the fused-order request (DeepInfra scores move a little with order)."""
    path = rr.DATA / "sample.json"
    if not path.exists():
        return None
    sample = rr.read_json(path)
    qmap = {q["id"]: q for q in items}
    union = {p.stem.split("__")[0]: rr.read_json(p)["scores"] for p in (rr.DATA / "scores").glob("*__default.json")}
    out = {}
    for key in rr.RERANKERS:
        rows = [r for r in sample["rows"] if r["key"] == key and r["pool"] == "fused40" and "scores" in r]
        res = {"id_order": [], "fused_order": []}
        changed = 0
        for r in rows:
            q = qmap[r["query_id"]]
            hyb = [p["id"] for p in pools[q["id"]]["hybrid"]]
            base = {c: i for i, c in enumerate(hyb)}
            for name, sc in (("id_order", union[key][q["id"]]), ("fused_order", r["scores"])):
                order = sorted(base, key=lambda c: (-sc[c], base[c], c))
                res[name].append(scores_of(rank_first(order, set(q["relevant_excerpts"]), text_of, excerpt_of, book_file)))
            changed += res["id_order"][-1]["rank"] != res["fused_order"][-1]["rank"]
        out[key] = {"queries": len(rows), "target_rank_changed": changed,
                    **{name: {m: float(np.mean([x[m] for x in v])) for m in METRICS} for name, v in res.items()}}
    return out


def topk(items, pools, score_files, text_of, excerpt_of, book_file, indexed_of):
    """Exploratory: rerank only the first k candidates of the fused (or dense) order,
    keeping the rest in that order. Scores come from the 40-document request; for
    the sample queries the actual 20-document responses are checked against it."""
    strata = {q["id"]: q["cohort"] for q in items}
    hybrid_mrr = {q["id"]: scores_of(rank_first([p["id"] for p in pools[q["id"]]["hybrid"]], set(q["relevant_excerpts"]),
                                                text_of, excerpt_of, book_file))["mrr10"] for q in items}
    out = {}
    for run, f in score_files.items():
        if not run.endswith("__default"):
            continue
        entry = {}
        for base_name in ("hybrid", "dense"):
            for k in (10, 20, 30, 40):
                vals = {}
                for q in items:
                    base = [p["id"] for p in pools[q["id"]][base_name]]
                    sc = f["scores"][q["id"]]
                    head = sorted(base[:k], key=lambda c: (-sc[c], base.index(c), c))
                    vals[q["id"]] = scores_of(rank_first(head + base[k:], set(q["relevant_excerpts"]), text_of, excerpt_of, book_file))
                e = {m: float(np.mean([v[m] for v in vals.values()])) for m in METRICS}
                if k == 20:
                    d = {i: vals[i]["mrr10"] - hybrid_mrr[i] for i in vals}
                    mean, ci = paired_bootstrap(d, strata)
                    e["mrr10_vs_hybrid"] = {"delta": mean, "ci95": ci}
                entry[f"{base_name}{k}"] = e
        out[run] = entry
    # Actual 20-document responses (fused top 20) on the sample queries, from the cache.
    sample_path, lat_path = rr.DATA / "sample.json", rr.DATA / "latency.json"
    if sample_path.exists() and lat_path.exists():
        qmap = {q["id"]: q for q in items}
        conn = rr.cache_db()
        check = {}
        for key in rr.RERANKERS:
            same_rank, n = 0, 0
            for qid in rr.read_json(sample_path)["query_ids"]:
                q = qmap[qid]
                cids = [p["id"] for p in pools[qid]["hybrid"]][:20]
                hit = rr.cached(conn, rr.request_key(key, q["query"], [indexed_of[c] for c in cids], rr.instructions()["default"]))
                if hit is None:
                    continue
                actual = dict(zip(cids, hit[0]))
                full = score_files[f"{key}__default"]["scores"][qid]
                hyb = [p["id"] for p in pools[qid]["hybrid"]]
                orders = []
                for sc in (actual, full):
                    head = sorted(cids, key=lambda c: (-sc[c], hyb.index(c), c))
                    orders.append(rank_first(head + hyb[20:], set(q["relevant_excerpts"]), text_of, excerpt_of, book_file))
                same_rank += orders[0] == orders[1]
                n += 1
            check[key] = {"queries": n, "target_rank_identical": same_rank}
        conn.close()
        out["actual_20doc_check"] = check
    rec = {}
    for k in (10, 20, 30, 40):
        rec[str(k)] = float(np.mean([any(x in set(q["relevant_excerpts"]) for x, _ in fold(
            [p["id"] for p in pools[q["id"]]["hybrid"]][:k], text_of, excerpt_of, book_file)) for q in items]))
    out["hybrid_recall_at_k"] = rec
    return out


def cap_per_book(folded, by_id, cap=4):
    """The workspace per-file rule (4 of 5, overflow appended) applied to an excerpt list."""
    seen, kept, overflow = defaultdict(int), [], []
    for x, c in folded:
        b = by_id[c]["book_id"]
        if seen[b] < cap:
            seen[b] += 1
            kept.append((x, c))
        else:
            overflow.append((x, c))
    return kept + overflow


def summarize(records, arms, strata, book_cluster):
    out = {"n": len(records), "arms": {}, "vs_hybrid": {}, "vs_dense": {}}
    subsets = {"all": records, "existing": [r for r in records if r["cohort"] not in ("samedoc", "nearmiss")],
               "new": [r for r in records if r["cohort"] in ("samedoc", "nearmiss")]}
    subsets |= {g: [r for r in records if r["group"] == g] for g in GROUPS}
    for arm in arms:
        entry = {}
        for name, rows in subsets.items():
            ok = [r for r in rows if r["arms"][arm] is not None]
            if not ok:
                continue
            entry[name] = {"n": len(ok), "failed": len(rows) - len(ok)}
            for level in ("excerpt", "chunk", "capped"):
                entry[name][level] = {m: float(np.mean([r["arms"][arm][level][m] for r in ok])) for m in METRICS}
            if name in ("samedoc", "nearmiss", "new"):
                entry[name]["distractor_above"] = float(np.mean([r["arms"][arm]["distractor_above"] for r in ok]))
            entry[name]["cap_changed_top5"] = int(sum(r["arms"][arm]["cap_changed_top5"] for r in ok))
        out["arms"][arm] = entry
    for base in ("hybrid", "dense"):
        for arm in arms:
            if arm == base:
                continue
            comp = {}
            for name, rows in subsets.items():
                ok = [r for r in rows if r["arms"][arm] is not None and r["arms"][base] is not None]
                if not ok:
                    continue
                c = {"n": len(ok)}
                for level in ("excerpt", "chunk"):
                    c[level] = {}
                    for m in METRICS:
                        d = {r["id"]: r["arms"][arm][level][m] - r["arms"][base][level][m] for r in ok}
                        mean, ci = paired_bootstrap(d, strata)
                        c[level][m] = {"delta": mean, "ci95": ci}
                for m in ("hit5", "hit1"):
                    c[f"{m}_gains"] = [r["id"] for r in ok if r["arms"][arm]["excerpt"][m] > r["arms"][base]["excerpt"][m]]
                    c[f"{m}_losses"] = [r["id"] for r in ok if r["arms"][arm]["excerpt"][m] < r["arms"][base]["excerpt"][m]]
                if name == "all":
                    d = {r["id"]: r["arms"][arm]["excerpt"]["mrr10"] - r["arms"][base]["excerpt"]["mrr10"] for r in ok}
                    mean, ci = cluster_bootstrap(d, book_cluster)
                    c["book_cluster_mrr10"] = {"delta": mean, "ci95": ci}
                comp[name] = c
            out[f"vs_{base}"][arm] = comp
    return out


def pick_best(summary, score_files):
    cands = []
    for run in score_files:
        if not run.endswith("__default"):
            continue
        arm = f"{run}@pool40"
        m = summary["arms"][arm]["all"]["excerpt"]["mrr10"]
        key = run.split("__")[0]
        spec = rr.RERANKERS[key]
        price_usd = spec["price"] * (USD_PER_CNY if spec["provider"] == "alibaba" else 1)
        cands.append((m, -price_usd, arm))
    cands.sort(reverse=True)
    top = cands[0]
    near = [c for c in cands if top[0] - c[0] <= 0.005]
    return max(near, key=lambda c: c[1])[2]


def replay_check(pools):
    path = rr.DATA / "sample.json"
    if not path.exists():
        return None
    sample = rr.read_json(path)
    # The scored request sent the 40 documents in chunk-id order; the sample sent
    # them in fused order (fused40) and the first 20 of them (fused20).
    union = {p.stem.split("__")[0]: rr.read_json(p)["scores"] for p in (rr.DATA / "scores").glob("*__default.json")}
    out = defaultdict(lambda: {"requests": 0, "same_order": 0, "same_top5": 0, "max_abs_diff": 0.0, "kendall_min": 1.0})
    for row in sample["rows"]:
        if "scores" not in row or row["key"] not in union or row["query_id"] not in union[row["key"]]:
            continue
        u = union[row["key"]][row["query_id"]]
        ids = list(row["scores"])
        direct = sorted(ids, key=lambda c: (-row["scores"][c], c))
        replay = sorted(ids, key=lambda c: (-u[c], c))
        s = out[f"{row['key']}@{row['pool']}"]
        s["requests"] += 1
        s["same_order"] += direct == replay
        s["same_top5"] += direct[:5] == replay[:5]
        s["max_abs_diff"] = max(s["max_abs_diff"], max(abs(row["scores"][c] - u[c]) for c in ids))
        s["kendall_min"] = min(s["kendall_min"], kendall([row["scores"][c] for c in ids], [u[c] for c in ids]))
    return dict(out)


def kendall(a, b):
    n, conc, disc = len(a), 0, 0
    for i in range(n):
        for j in range(i + 1, n):
            s = (a[i] - a[j]) * (b[i] - b[j])
            conc += s > 0
            disc += s < 0
    return (conc - disc) / max(1, conc + disc)


def operations(score_files):
    out = {}
    path = rr.DATA / "sample.json"
    sample = rr.read_json(path) if path.exists() else {"rows": []}
    for key, spec in rr.RERANKERS.items():
        rows = [r for r in sample["rows"] if r["key"] == key and r["pool"] == "fused40" and "scores" in r and not r.get("cached")]
        lat = [r["latency_ms"] for r in rows if r.get("latency_ms")]
        tok = [r["tokens"] for r in rows if r.get("tokens")]
        errors = [r for r in sample["rows"] if r["key"] == key and "error" in r]
        price = spec["price"]
        cur = rr.CURRENCY[spec["provider"]]
        per_search = statistics.median(tok) * price / 1e6 if tok else None
        out[key] = {
            "sample_requests": len(rows), "sample_errors": len(errors),
            "latency_ms": {"p50": float(np.percentile(lat, 50)), "p95": float(np.percentile(lat, 95)), "max": max(lat)} if lat else None,
            "tokens_per_40doc": {"median": statistics.median(tok), "p95": float(np.percentile(tok, 95))} if tok else None,
            "list_cost_per_search": per_search, "currency": cur,
            "list_cost_per_search_usd": per_search * (USD_PER_CNY if cur == "CNY" else 1) if per_search else None,
        }
    log = rr.read_jsonl(rr.REQUEST_LOG)
    statuses = defaultdict(lambda: defaultdict(int))
    for r in log:
        statuses[r.get("key", r.get("model"))][str(r.get("status"))] += 1
    out["status_counts"] = {k: dict(v) for k, v in statuses.items()}
    out["spend"] = rr.spend()
    out["union_runs"] = {run: {"scored": len(f["scores"]), "failures": len(f["failures"]),
                               "tokens_total": sum(u["tokens"] for u in f["usage"].values()),
                               "docs_total": sum(u["n_docs"] for u in f["usage"].values())} for run, f in score_files.items()}
    return out


def spearman(a, b):
    ra = np.argsort(np.argsort(a))
    rb = np.argsort(np.argsort(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def identity(score_files, pools):
    """How closely do the rerankers' union scores agree, per query?"""
    runs = {k.split("__")[0]: f["scores"] for k, f in score_files.items() if k.endswith("__default")}
    keys = sorted(runs)
    out = {}
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            rho, tau, top1, top5, mad = [], [], 0, [], []
            qs = [q for q in runs[a] if q in runs[b]]
            for q in qs:
                ids = sorted(runs[a][q])
                x = np.array([runs[a][q][c] for c in ids])
                y = np.array([runs[b][q][c] for c in ids])
                rho.append(spearman(x, y))
                tau.append(kendall(list(x), list(y)))
                oa = [ids[j] for j in np.argsort(-x, kind="stable")]
                ob = [ids[j] for j in np.argsort(-y, kind="stable")]
                top1 += oa[0] == ob[0]
                top5.append(len(set(oa[:5]) & set(ob[:5])))
                mad.append(float(np.mean(np.abs(x - y))))
            out[f"{a} vs {b}"] = {"queries": len(qs), "spearman_median": float(np.median(rho)), "kendall_median": float(np.median(tau)),
                                  "top1_agree": top1 / max(1, len(qs)), "top5_overlap_mean": float(np.mean(top5)),
                                  "mean_abs_score_diff": float(np.mean(mad))}
    return out


def write_review(records, best, by_id, excerpts, items, base="hybrid", suffix=""):
    """Exact texts for the best arm's lost and gained hits and its known-wrong promotions."""
    qmap = {q["id"]: q for q in items}
    (rr.DATA / "review").mkdir(exist_ok=True)
    kinds = (
        ("lost-hit5", lambda b, h: h["excerpt"]["hit5"] and not b["excerpt"]["hit5"]),
        ("gained-hit5", lambda b, h: b["excerpt"]["hit5"] and not h["excerpt"]["hit5"]),
        ("lost-hit1", lambda b, h: h["excerpt"]["hit1"] and not b["excerpt"]["hit1"]),
        ("distractor-above", lambda b, h: b["distractor_above"]),
    )
    for kind, cond in kinds:
        lines = [f"# {kind}: {best} against {base}\n"]
        for r in records:
            b, h = r["arms"][best], r["arms"][base]
            if b is None or not cond(b, h):
                continue
            q = qmap[r["id"]]
            lines.append(f"## {r['id']} ({r['cohort']}, {r['lang']}) {base} rank {h['excerpt']['rank']} -> arm rank {b['excerpt']['rank']}\n")
            lines.append(f"**Query:** {q['query']}\n")
            for c in q["relevant"]:
                x = by_id[c]
                lines.append(f"**Relevant** `{c}` ({x['book_id']} | {x['section_path']})\n\n> {clip(x['text'])}\n")
            if q["wrong"]:
                lines.append("Known wrong: " + ", ".join(f"`{w}`" for w in q["wrong"]) + "\n")
            lines.append("**Best arm top 5:**\n")
            for n, (xk, c) in enumerate(b["top5"], 1):
                x = by_id[c]
                tag = " (known wrong)" if c in q["wrong"] else ""
                lines.append(f"{n}. `{c}`{tag} ({x['book_id']} | {x['section_path']})\n\n> {clip(x['text'])}\n")
            lines.append(f"**{base} top 5 ids:** " + ", ".join(f"`{c}`" for _, c in h["top5"]) + "\n")
        (rr.DATA / "review" / f"{kind}{suffix}.md").write_text("\n".join(lines), encoding="utf-8")


def clip(text, n=900):
    t = re.sub(r"\s+", " ", text).strip()
    return t if len(t) <= n else t[:n] + " […]"


def write_tables(summary, arms):
    lines = []
    head = ["arm", "group", "n", "MRR@10", "hit@1", "hit@5", "nDCG@5", "dMRR vs hybrid (95% CI)", "dMRR vs dense (95% CI)"]
    lines.append("| " + " | ".join(head) + " |")
    lines.append("|" + "---|" * len(head))
    for arm in arms:
        for g in ["all", "existing", "new"] + GROUPS:
            e = summary["arms"][arm].get(g)
            if not e:
                continue
            x = e["excerpt"]
            vh = summary["vs_hybrid"].get(arm, {}).get(g, {}).get("excerpt", {}).get("mrr10")
            vd = summary["vs_dense"].get(arm, {}).get(g, {}).get("excerpt", {}).get("mrr10")
            fmt = lambda v: f"{v['delta']:+.3f} ({v['ci95'][0]:+.3f}, {v['ci95'][1]:+.3f})" if v else ""
            lines.append(f"| {arm} | {g} | {e['n']} | {x['mrr10']:.3f} | {x['hit1']:.3f} | {x['hit5']:.3f} | {x['ndcg5']:.3f} | {fmt(vh)} | {fmt(vd)} |")
    (rr.DATA / "tables.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
