"""Tables for the report: spend by category, per-arm quality over the chains."""

import collections
import json
from pathlib import Path

import terms

HERE = Path(__file__).resolve().parent

spend = collections.Counter()
calls = collections.Counter()
for line in (HERE / "ledger.jsonl").read_text(encoding="utf-8").splitlines():
    r = json.loads(line)
    tag = r["tag"]
    if tag.startswith("full-"):
        cat = (
            "full summaries ("
            + ("book" if tag.startswith("full-b") else "chapter")
            + ")"
        )
    elif tag.startswith("delta-insert"):
        cat = "insert-only deltas"
    elif tag.startswith("delta-"):
        cat = "delta chains " + tag.split("-")[1]
    elif tag.startswith("judge-"):
        cat = "judge"
    elif tag.startswith("embed"):
        cat = "embeddings"
    else:
        cat = "probes"
    spend[cat] += r["cost_usd"]
    calls[cat] += 1
print("SPEND")
for cat, usd in sorted(spend.items()):
    print(f"  {cat:32s} {calls[cat]:3d} calls  ${usd:.4f}")
print(f"  {'total':32s} {sum(calls.values()):3d} calls  ${sum(spend.values()):.4f}")

for doc in ("chapter", "book"):
    results = json.loads((HERE / f"results-{doc}.json").read_text(encoding="utf-8"))
    judged = json.loads((HERE / f"judged-{doc}.json").read_text(encoding="utf-8"))
    sim = json.loads((HERE / f"similarity-{doc}.json").read_text(encoding="utf-8"))
    rounds = sorted(
        {k.split("-")[0] for k in results["full"]}, key=lambda r: int(r[1:])
    )
    last = rounds[-1]
    print(f"\n{doc.upper()} (rounds {rounds[1]}..{last})")
    arms = ["full-a", "reuse", "diff", "chunk", "diff2", "chunk2", "diff3", "diff3t"]
    for arm in arms:
        acc, use, stale, fails, words = [], [], 0, 0, []
        for r in rounds[1:]:
            v = judged.get(f"{r}/{arm}")
            if not v:
                continue
            acc.append(v.get("accuracy") or 0)
            use.append(v.get("usefulness") or 0)
            stale += len(v.get("stale") or [])
            if arm == "full-a":
                s = results["full"][f"{r}-a"]
            elif arm == "reuse":
                s = results["full"][f"{rounds[0]}-a"]
            else:
                s = results[arm][r]
            words.append(len(s["summary"].split()))
            fails += sum(
                1
                for ok in terms.score(
                    doc, r, s["descriptor"] + " " + s["summary"]
                ).values()
                if not ok
            )
        if not acc:
            continue
        simrow = sim["summary"].get(arm, {})
        print(
            f"  {arm:7s} judge accuracy {sum(acc) / len(acc):.1f} usefulness {sum(use) / len(use):.1f} "
            f"stale claims {stale:2d} term-check failures {fails:2d} "
            f"summary words {min(words)}-{max(words)} last-round cosine {simrow.get(last, '-')}"
        )
    print("  floor full-vs-full summary cosine", sim["summary"]["floor_full_vs_full"])
