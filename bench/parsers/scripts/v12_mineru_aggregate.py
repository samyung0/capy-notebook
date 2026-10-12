"""Unblind the page reviews and tally grades per parser."""
import json, sys, collections
from pathlib import Path
out = Path(sys.argv[1])
key = json.loads((out / "blind_key.json").read_text())
sample = json.loads((out / "sample.json").read_text())
SCORE = {"good": 1.0, "partial": 0.5, "bad": 0.0, "none": 0.0}
tot = {p: collections.defaultdict(collections.Counter) for p in ("shipped", "mineru")}
perbook = {}
examples = collections.defaultdict(list)
for b in sample["books"]:
    f = out / "review" / f"{b['id']}.json"
    if not f.exists(): print("missing", b["id"]); continue
    pb = {p: collections.defaultdict(collections.Counter) for p in ("shipped", "mineru")}
    for page in json.loads(f.read_text()):
        m = key[f"{b['id']}:{page['page']}"]
        for kind in ("formulas", "tables", "figures", "headings"):
            for el in page.get(kind, []):
                for lab in "AB":
                    g = el.get(lab)
                    if g in SCORE:
                        tot[m[lab]][kind][g] += 1; pb[m[lab]][kind][g] += 1
        for lab in "AB":
            s = page.get(lab, {}); p = m[lab]
            for fld in ("section_path", "text"):
                if s.get(fld) in SCORE:
                    tot[p][fld][s[fld]] += 1; pb[p][fld][s[fld]] += 1
            tot[p]["false"]["headings"] += s.get("false_headings", 0) or 0
            tot[p]["false"]["tables"] += s.get("false_tables", 0) or 0
            pb[p]["false"]["headings"] += s.get("false_headings", 0) or 0
            pb[p]["false"]["tables"] += s.get("false_tables", 0) or 0
            for e in s.get("false_heading_examples", []) or []:
                examples[p].append(f"{b['id'][:20]} p{page['page']}: {e}")
    perbook[b["id"]] = pb

def score(c):
    n = sum(c[g] for g in SCORE)
    return (sum(SCORE[g] * c[g] for g in SCORE) / n if n else None), n

rows = {}
for kind in ("formulas", "tables", "figures", "headings", "section_path", "text"):
    rows[kind] = {}
    for p in ("shipped", "mineru"):
        s, n = score(tot[p][kind])
        rows[kind][p] = {"score": s, "n": n, **dict(tot[p][kind])}
summary = {"overall": rows, "false": {p: dict(tot[p]["false"]) for p in tot},
           "per_book": {bk: {p: {k: score(v[p][k])[0] for k in ("formulas", "tables", "figures", "headings", "section_path", "text")} | {"false": dict(v[p]["false"])} for p in v} for bk, v in perbook.items()},
           "false_heading_examples": examples}
(out / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False))
for kind, r in rows.items():
    print(f"{kind:13s} " + "  ".join(f"{p}: {r[p]['score'] if r[p]['score'] is None else round(r[p]['score'],2)} (n={r[p]['n']}, g{r[p].get('good',0)}/p{r[p].get('partial',0)}/b{r[p].get('bad',0)}{'/none'+str(r[p].get('none')) if r[p].get('none') else ''})" for p in r))
print("false", summary["false"])
for bk, v in summary["per_book"].items():
    print(bk[:28], {p: {k: (round(x, 2) if isinstance(x, float) else x) for k, x in v[p].items()} for p in v})
