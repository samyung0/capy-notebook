"""Single-query embedding latency and a small burst probe, from this machine.

latency: 50 unseen MIRACL English dev questions, each sent once to DeepInfra
(production 4B shape with the instruct prefix) and once to Alibaba (qwen3.7
native, text_type=query, the arm chosen on the dev slice), interleaved and
sequential. No retries; failures are counted, never replaced. Dev-PC network,
not production.

burst: 32 single-query requests at concurrency 16 per provider, to see whether
either returns 429 at a modest burst.

Output: data/qwen37-embedding/latency.json
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import numpy as np
from common import DATA, QWEN3_QUERY_TASK, REPO, ProviderError, Spec, call, client, write_json

sys.path.insert(0, str(REPO / "bench" / "rag" / "broad" / "scripts"))
from fetch_data import stable_key  # noqa: E402


def unseen_questions(n: int) -> list[str]:
    raw = DATA / "public" / "raw"
    topics = dict(line.split("\t", 1) for line in (raw / "miracl-en-topics.tsv").read_text(encoding="utf-8").splitlines())
    used = {q["q"] for part in json.loads((DATA / "public" / "questions.json").read_text(encoding="utf-8"))["questions"].values() for q in part}
    ordered = sorted(topics, key=lambda qid: stable_key("latency:" + qid))
    return [topics[q] for q in ordered if topics[q] not in used][:n]


def dist(values):
    if not values:
        return {"n": 0}
    return {"n": len(values), "p50": float(np.percentile(values, 50)), "p95": float(np.percentile(values, 95)), "max": float(max(values))}


async def main():
    choice = json.loads((DATA / "public" / "selection.json").read_text(encoding="utf-8"))["choice"]
    q37 = Spec("q37", "query", instruct=QWEN3_QUERY_TASK) if choice == "q37i" else Spec("q37", "query")
    specs = {"deepinfra-q4": Spec("q4", "query"), "alibaba-q37": q37}
    texts = unseen_questions(50)
    runs = {name: [] for name in specs}
    async with client(timeout=30.0) as http:
        for text in texts:
            for name, spec in specs.items():
                started = time.perf_counter()
                try:
                    await call(http, spec, [text], phase="latency")
                    runs[name].append({"ms": (time.perf_counter() - started) * 1000})
                except ProviderError as exc:
                    runs[name].append({"ms": (time.perf_counter() - started) * 1000, "error": str(exc)[:200], "status": exc.status})
        burst = {}
        for name, spec in specs.items():
            gate = asyncio.Semaphore(16)

            async def one(i, spec=spec):
                async with gate:
                    t0 = time.perf_counter()
                    try:
                        await call(http, spec, [f"burst probe {i}: {texts[i % len(texts)]}"], phase="burst")
                        return {"ms": (time.perf_counter() - t0) * 1000}
                    except ProviderError as exc:
                        return {"ms": (time.perf_counter() - t0) * 1000, "status": exc.status}

            t0 = time.perf_counter()
            results = await asyncio.gather(*(one(i) for i in range(32)))
            burst[name] = {
                "wall_s": time.perf_counter() - t0,
                "ok": sum("status" not in r for r in results),
                "status_counts": {str(s): sum(r.get("status") == s for r in results) for s in {r.get("status") for r in results if "status" in r}},
                "latency": dist([r["ms"] for r in results if "status" not in r]),
            }
    out = {
        name: {"attempted": len(r), "errors": sum("error" in x for x in r), "latency_ok": dist([x["ms"] for x in r if "error" not in x]), "errors_detail": [x for x in r if "error" in x]}
        for name, r in runs.items()
    }
    write_json(DATA / "latency.json", {"sequential": out, "burst": burst, "q37_variant": q37.variant})
    print(json.dumps({"sequential": {k: v["latency_ok"] | {"errors": v["errors"]} for k, v in out.items()}, "burst": burst}, indent=1))


if __name__ == "__main__":
    asyncio.run(main())
