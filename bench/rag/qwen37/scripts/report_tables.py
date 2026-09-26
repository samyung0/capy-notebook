"""Print the report tables and spend from the saved results (no network).

Writes data/qwen37-embedding/summary.json with everything the report cites.
"""

from __future__ import annotations

import gzip
import json
from collections import defaultdict

from common import DATA, PRICE_PER_M, billed_tokens, read_jsonl, write_json

from pipeline.retrieval.chunking import estimate_tokens


def load(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def spend_table(rows):
    out = defaultdict(lambda: {"requests": 0, "errors": 0, "tokens": 0, "usd": 0.0})
    for r in rows:
        for key in (r["provider"], f"{r['provider']}:{r['phase']}"):
            s = out[key]
            s["requests"] += 1
            s["errors"] += "error" in r
            t = billed_tokens(r.get("usage") or {})
            s["tokens"] += t
            s["usd"] += t * PRICE_PER_M[r["provider"]] / 1e6
    return dict(sorted(out.items()))


def token_accounting(rows):
    pub = [json.loads(s)["text"] for s in gzip.open(DATA / "public" / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    pub = list(dict.fromkeys(pub))
    lib = [json.loads(s)["indexed_text"] for s in gzip.open(DATA / "library" / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    lib = list(dict.fromkeys(lib))

    def billed(phase, provider):
        ok = [r for r in rows if r["phase"] == phase and r["provider"] == provider and "error" not in r]
        return sum(billed_tokens(r["usage"]) for r in ok), sum(r["count"] for r in ok)

    t4, n4 = billed("public-docs", "deepinfra")
    t37, n37 = billed("public-docs", "alibaba")
    l37, ln37 = billed("library-docs", "alibaba")
    est_pub = sum(estimate_tokens(t) for t in pub)
    est_lib = sum(estimate_tokens(t) for t in lib)
    return {
        "public": {"texts": len(pub), "deepinfra_billed": t4, "deepinfra_texts": n4, "alibaba_billed": t37, "alibaba_texts": n37,
                   "estimate_tokens": est_pub, "per_text": {"deepinfra": t4 / max(n4, 1), "alibaba": t37 / max(n37, 1), "estimate": est_pub / len(pub)}},
        "library": {"texts": len(lib), "alibaba_billed": l37, "alibaba_texts": ln37, "estimate_tokens": est_lib,
                    "per_text": {"alibaba": l37 / max(ln37, 1), "estimate": est_lib / len(lib)}},
    }


def main():
    rows = read_jsonl(DATA / "requests.jsonl")
    summary = {
        "spend": spend_table(rows),
        "tokens": token_accounting(rows),
        "public_dev": (load(DATA / "public" / "results-dev.json") or {}).get("summary"),
        "public_selection": load(DATA / "public" / "selection.json"),
        "public_main": (load(DATA / "public" / "results-main.json") or {}).get("summary"),
        "library_dense": (load(DATA / "library" / "results-dense.json") or {}).get("summary"),
        "library_pilot": {k: v for k, v in ((load(DATA / "library" / "results-dense.json") or {}).get("pilot") or {}).items() if k != "rows"},
        "library_hybrid": (load(DATA / "library" / "results-hybrid.json") or {}).get("summary"),
        "latency": load(DATA / "latency.json"),
        "probe": load(DATA / "probe.json"),
        "parity": load(DATA / "library" / "parity.json"),
        "throttling": {
            "alibaba_429": sum(1 for r in rows if r["provider"] == "alibaba" and r.get("status") == 429),
            "deepinfra_errors": sum(1 for r in rows if r["provider"] == "deepinfra" and "error" in r),
            "alibaba_other_errors": sorted({r["error"][:120] for r in rows if r["provider"] == "alibaba" and "error" in r and r.get("status") != 429}),
        },
    }
    write_json(DATA / "summary.json", summary)
    for provider in ("deepinfra", "alibaba"):
        s = summary["spend"].get(provider)
        if s:
            print(f"{provider}: {s['requests']} requests, {s['errors']} errors, {s['tokens']:,} tokens, ${s['usd']:.3f}")
    print(json.dumps(summary["tokens"], indent=1))
    print(json.dumps(summary["throttling"], indent=1))


if __name__ == "__main__":
    main()
