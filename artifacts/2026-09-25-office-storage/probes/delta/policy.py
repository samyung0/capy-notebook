"""Replay refresh policies over the edit rounds and score what each serves.

P1 reuse-or-full(T): keep the stored summary while the net text change
accumulated since its last full regeneration stays under T percent of the
document; at or above T, regenerate fully.
P2 reuse/insert/full: under 0.5% reuse; insertion-led change under 10% with
under 0.5% deleted gets the insert-only delta (prompt v4); any other change,
five deltas in a row, or an invalid reply regenerates fully.

Provider cost uses DeepSeek's deepseek-flash list prices (off-peak $0.15/M
input on a cache miss, $0.60/M output; peak doubles), without prefix-cache
discounts, and the token counts measured on this run.
Usage: python policy.py chapter|book
"""

from __future__ import annotations

import json
import sys
from itertools import pairwise
from pathlib import Path

import delta
import judge
import llm
import run
import sizes
import terms

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval.chunking import estimate_tokens

HERE = Path(__file__).resolve().parent
IN_USD, OUT_USD = 0.15e-6, 0.60e-6


def usd(usage: dict) -> float:
    return (
        usage.get("prompt_tokens", 0) * IN_USD
        + usage.get("completion_tokens", 0) * OUT_USD
    )


def changes(doc: str) -> dict[str, dict]:
    rounds = run.DOCS[doc]
    out = {}
    for old, new in pairwise(rounds):
        a, b = sizes.load(f"{old}.docx"), sizes.load(f"{new}.docx")
        ch = delta.text_changes(a, b)
        out[new] = {
            "added": sum(estimate_tokens(c.added) for c in ch if c.added),
            "removed": sum(estimate_tokens(c.removed) for c in ch if c.removed),
            "doc": estimate_tokens("\n\n".join(c.indexed_text() for c in b)),
            "changes": ch,
        }
    return out


def insert_delta(doc: str, round_name: str, previous: dict, ch: dict) -> dict:
    messages = delta.insert_messages(
        previous["descriptor"],
        previous["summary"],
        ch["changes"],
        run.TARGET,
        ch["doc"],
    )
    record = llm.chat(f"delta-insert-{doc}-{round_name}", messages)
    parsed = run.finish(record["content"], run.TARGET)
    ok = (
        record["finish_reason"] == "stop" and parsed["descriptor"] and parsed["summary"]
    )
    return {**parsed, "usage": record["usage"], "valid": bool(ok)}


def replay(doc: str, name: str, results: dict, ch: dict) -> list[dict]:
    rounds = run.DOCS[doc]
    served = results["full"][f"{rounds[0]}-a"]
    drift = deleted = deltas = 0
    rows = []
    for r in rounds[1:]:
        c = ch[r]
        drift += c["added"] + c["removed"]
        deleted += c["removed"]
        share = 100 * drift / c["doc"]
        if name.startswith("P1"):
            limit = float(name.split("-")[1])
            path = "full" if share >= limit else "reuse"
        else:
            if share < 0.5:
                path = "reuse"
            elif 100 * deleted / c["doc"] < 0.5 and share < 10 and deltas < 5:
                path = "delta"
            else:
                path = "full"
        cost = 0.0
        if path == "delta":
            out = insert_delta(doc, r, served, c)
            cost = usd(out["usage"])
            if out["valid"]:
                served, deltas = out, deltas + 1
            else:
                path = "full"
        if path == "full":
            served = results["full"][f"{r}-a"]
            cost += usd(served["usage"])
            drift = deleted = deltas = 0
        rows.append(
            {
                "round": r,
                "path": path,
                "change_pct": round(share, 2),
                "cost_usd": round(cost, 5),
                "served": served,
            }
        )
    return rows


def main() -> None:
    doc = sys.argv[1]
    results = json.loads((HERE / f"results-{doc}.json").read_text(encoding="utf-8"))
    ch = changes(doc)
    report = {}
    judged_path = HERE / f"judged-{doc}.json"
    judged = json.loads(judged_path.read_text(encoding="utf-8"))
    rounds = run.DOCS[doc]
    # A verdict belongs to (round, summary text); reuse any existing one.
    known = {}
    for key, verdict in judged.items():
        r, arm = key.split("/", 1)
        if arm.startswith("full-"):
            s = results["full"].get(f"{r}-{arm[5:]}")
        elif arm == "reuse":
            s = results["full"][f"{rounds[0]}-a"]
        elif arm.startswith("policy-"):
            s = verdict.get("_summary")
        else:
            s = results.get(arm, {}).get(r)
        if s:
            known[(r, s["summary"] if isinstance(s, dict) else s)] = verdict
    always_full = sum(usd(results["full"][f"{r}-a"]["usage"]) for r in rounds[1:])
    for name in ("P1-2", "P1-5", "P1-10", "P2"):
        rows = replay(doc, name, results, ch)
        for row in rows:
            s = row.pop("served")
            key = f"{row['round']}/policy-{name}"
            if key not in judged:
                v = known.get((row["round"], s["summary"]))
                if v is None:
                    v = judge.judge(
                        doc, row["round"], f"{doc}-{row['round']}-policy-{name}", s
                    )
                    v["_summary"] = s["summary"]
                    known[(row["round"], s["summary"])] = v
                judged[key] = v
                judged_path.write_text(
                    json.dumps(judged, indent=1, ensure_ascii=False), encoding="utf-8"
                )
            v = judged[key]
            row["judge"] = {
                k: v.get(k) for k in ("accuracy", "coverage", "balance", "usefulness")
            }
            row["judge_stale"] = len(v.get("stale") or [])
            checks = terms.score(
                doc, row["round"], s["descriptor"] + " " + s["summary"]
            )
            row["checks_failed"] = [k for k, ok in checks.items() if not ok]
            row["summary_words"] = len(s["summary"].split())
        total = sum(r["cost_usd"] for r in rows)
        report[name] = {
            "rounds": rows,
            "cost_usd": round(total, 5),
            "always_full_usd": round(always_full, 5),
        }
        print(f"== {name}  cost ${total:.4f} vs always-full ${always_full:.4f}")
        for row in rows:
            print(
                "  ",
                row["round"],
                row["path"],
                row["change_pct"],
                row["cost_usd"],
                row["judge"],
                row["judge_stale"],
                row["checks_failed"],
            )
    (HERE / f"policy-{doc}.json").write_text(
        json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8"
    )
    print("spent", round(llm.spent(), 4))


if __name__ == "__main__":
    main()
