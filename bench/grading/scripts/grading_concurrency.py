"""How many open parts should one submission grade at once?

Simulates 40-part submissions mixed like a past paper: 20 HKDSE maths parts with
working (graded with thinking low) and 20 reading or short open parts (8 IELTS,
8 HKDSE Chinese, 4 contract parts). Each submission takes one answer per part; the
answer kind rotates with the submission's seed, so submissions differ. Grading uses
deepseek_grading.py's round-3 prompt, answer rules and code copy check (IELTS
whole-paragraph rules measured as passage coverage) on
`deepseek/deepseek-v4.1-flash-1017`, routed Wafer (wafer/us) -> InferenceNet ->
Cloudflare with fallbacks off.

  run     N submissions at once, each with K parts in flight; one record per part
          with its start and end time relative to the run, provider, HTTP status,
          usage, cost and awards. Standard library only; no retries; 180 s timeout,
          so slow calls are measured rather than cut (the server's Jev client cuts
          at 30 s).
  report  wall time per submission, per-call p50/p95, errors and providers per run,
          whether each submission would pass the server's any-failure rule, accuracy
          against gold and against the round-3 1017 runs on the same answers, cost.

  python bench/grading/scripts/grading_concurrency.py --check
  python bench/grading/scripts/grading_concurrency.py run --subs 1 --inflight 10 --seed 0 --env deploy/.env.uat --output DIR
  python bench/grading/scripts/grading_concurrency.py report --runs DIR... --reference R3DIR... --output summary.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import deepseek_grading as dg

GRADER = "deepseek-v41-1017-wafer"
TIMEOUT_S = 180
MIX = (("math", 20), ("reading_en", 8), ("reading_zh", 8), ("contract", 4))


def submission(seed):
    """One 40-part submission: the first n parts of each set (contract: every fifth),
    one answer per part, the kind rotating with the seed."""
    cases = dg.apply_rules(dg.load_cases([name for name, _ in MIX]))
    by_part = defaultdict(list)
    for c in cases:
        by_part[(c["set"], c["question_id"], c.get("part") or c["answer_id"].split("/")[1])].append(c)
    out = []
    for name, count in MIX:
        parts = sorted(k for k in by_part if k[0] == name)
        if name == "contract":
            parts = parts[::5]
        for i, key in enumerate(parts[:count]):
            answers = sorted(by_part[key], key=lambda c: c["kind"])
            out.append(answers[(i + seed) % len(answers)])
    assert len(out) == 40, len(out)
    return out


def grade(case, key, run_start):
    thinking = "low" if case["set"] == "math" else "off"
    start = time.perf_counter() - run_start
    row = dg.deepseek_call(case, GRADER, key, thinking, 0, "r3", False, copy_alt=True)
    row["t_start"] = round(start, 3)
    row["t_end"] = round(time.perf_counter() - run_start, 3)
    return row


def run(args):
    if args.output.exists():
        raise SystemExit("--output must name a fresh directory")
    env = dg.load_env(args.env)
    key = env.get("OPENROUTER_API_KEY", "")
    if not key:
        raise SystemExit("No OPENROUTER_API_KEY")
    dg.TIMEOUT_S = TIMEOUT_S
    subs = [submission(args.seed + i) for i in range(args.subs)]
    args.output.mkdir(parents=True)
    manifest = {
        "label": args.label,
        "grader": GRADER,
        "model": dg.GRADERS[GRADER]["model"],
        "routing": dg.GRADERS[GRADER]["routing"],
        "submissions": args.subs,
        "inflight_per_submission": args.inflight,
        "inflight_total": args.subs * args.inflight,
        "seed": args.seed,
        "parts_per_submission": 40,
        "mix": dict(MIX),
        "prompt": "r3",
        "copy_alt": True,
        "timeout_s": TIMEOUT_S,
        "retries": 0,
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "git_head": dg.git_head(),
    }
    run_start = time.perf_counter()

    def one(indexed):
        index, cases = indexed
        with ThreadPoolExecutor(max_workers=args.inflight) as pool:
            rows = list(pool.map(lambda c: grade(c, key, run_start), cases))
        for row in rows:
            row["submission"] = index
        return rows

    with ThreadPoolExecutor(max_workers=args.subs) as outer:
        rows = [r for batch in outer.map(one, enumerate(subs)) for r in batch]
    manifest["finished_utc"] = datetime.now(timezone.utc).isoformat()
    with (args.output / "results.jsonl").open("x", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    clean = all(key[:8] not in p.read_text(encoding="utf-8") for p in args.output.iterdir())
    errors = Counter(r["error"] for r in rows if "error" in r)
    print(
        f"{args.label}: {args.subs} x {args.inflight} in flight, {sum(not r.get('skipped') for r in rows)} calls, "
        f"errors {dict(errors)}, providers {dict(Counter(str(r.get('provider')) for r in rows if not r.get('skipped')))}, "
        f"${sum(r.get('cost_usd') or 0 for r in rows):.4f}; credential marker absent: {clean}"
    )
    return int(not clean)


def summarize(rows, reference):
    calls = [r for r in rows if not r.get("skipped")]
    lat = [r["latency_s"] for r in calls if "error" not in r]
    maths = [r["latency_s"] for r in calls if "error" not in r and r["set"] == "math"]
    other = [r["latency_s"] for r in calls if "error" not in r and r["set"] != "math"]
    subs = defaultdict(list)
    for r in rows:
        subs[r["submission"]].append(r)
    walls = []
    for batch in subs.values():
        start = min(r["t_start"] for r in batch)
        walls.append(round(max(r["t_end"] for r in batch) - start, 2))
    same = compared = 0
    for r in rows:
        ref = reference.get(r["case_id"])
        if ref is None or "error" in ref or "error" in r:
            continue
        for a, b in zip(dg.awards(r), dg.awards(ref)):
            compared += 1
            same += a == b
    score = dg.score(rows)
    ref_rows = [reference[r["case_id"]] for r in rows if r["case_id"] in reference]
    return {
        "submissions": len(subs),
        "calls": len(calls),
        "skipped_by_code_rule": len(rows) - len(calls),
        "wall_s": sorted(walls),
        "wall_s_max": max(walls),
        "latency_s": {
            "p50": round(statistics.median(lat), 2) if lat else None,
            "p95": round(dg.quantile(lat, 0.95), 2) if lat else None,
            "max": round(max(lat), 2) if lat else None,
            "maths_p50": round(statistics.median(maths), 2) if maths else None,
            "maths_p95": round(dg.quantile(maths, 0.95), 2) if maths else None,
            "other_p50": round(statistics.median(other), 2) if other else None,
            "other_p95": round(dg.quantile(other, 0.95), 2) if other else None,
            "over_30s": sum(x > 30 for x in lat),
            "over_60s": sum(x > 60 for x in lat),
        },
        "errors": dict(Counter(r["error"] for r in rows if "error" in r)),
        "http_status": dict(Counter(str(r.get("http_status")) for r in calls)),
        "providers": dict(Counter(str(r.get("provider")) for r in calls)),
        "providers_by_set": {
            name: dict(Counter(str(r.get("provider")) for r in calls if r["set"] == name))
            for name in sorted({r["set"] for r in calls})
        },
        "submissions_failing_any_part": sum(any("error" in r for r in batch) for batch in subs.values()),
        "items": score["items"],
        "items_exact": score["items_exact"],
        "marks_over": score["marks_over"],
        "marks_under": score["marks_under"],
        "reference_items_exact": dg.score(ref_rows)["items_exact"] if ref_rows else None,
        "same_award_as_reference": [same, compared],
        "cost_usd": round(sum(r.get("cost_usd") or 0 for r in rows), 5),
        "cost_usd_per_submission": round(sum(r.get("cost_usd") or 0 for r in rows) / len(subs), 5),
        "tokens": {
            "input": sum((r.get("usage") or {}).get("prompt_tokens", 0) for r in calls),
            "cached": sum(((r.get("usage") or {}).get("prompt_tokens_details") or {}).get("cached_tokens") or 0 for r in calls),
            "output": sum((r.get("usage") or {}).get("completion_tokens", 0) for r in calls),
            "reasoning": sum((((r.get("usage") or {}).get("completion_tokens_details") or {}).get("reasoning_tokens") or 0) for r in calls),
        },
    }


def report(args):
    reference = {}
    for directory in args.reference or []:
        for r in dg.load_rows(directory):
            reference[r["case_id"]] = r
    out = {"runs": {}}
    for directory in args.runs:
        manifest = json.loads((Path(directory) / "manifest.json").read_text(encoding="utf-8"))
        out["runs"][manifest["label"]] = {"manifest": manifest, **summarize(dg.load_rows(directory), reference)}
    Path(args.output).write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("| Run | Subs × in flight | Wall s per submission | Call p50 / p95 s | Maths p50 / p95 s | >30 s | Errors | Providers | Items exact (ref) | Same as ref | $ |")
    print("| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | ---: |")
    for label, e in out["runs"].items():
        m, lat = e["manifest"], e["latency_s"]
        print(
            f"| {label} | {m['submissions']} × {m['inflight_per_submission']} | {', '.join(str(w) for w in e['wall_s'])} | "
            f"{lat['p50']} / {lat['p95']} | {lat['maths_p50']} / {lat['maths_p95']} | {lat['over_30s']} | {e['errors'] or 0} | "
            f"{e['providers']} | {e['items_exact']}/{e['items']} ({e['reference_items_exact']}) | {e['same_award_as_reference'][0]}/{e['same_award_as_reference'][1]} | {e['cost_usd']} |"
        )
    return 0


def check():
    a, b = submission(0), submission(1)
    assert len(a) == len(b) == 40 and Counter(c["set"] for c in a) == Counter(dict(MIX))
    assert [c["case_id"] for c in a] != [c["case_id"] for c in b]
    assert len({c["question_id"] + c["answer_id"] for c in a}) == 40
    assert dg.GRADERS[GRADER]["routing"] == {"order": ["wafer/us", "InferenceNet", "Cloudflare"], "allow_fallbacks": False}
    body = dg.request_body(GRADER, a[0], "low", "r3")
    assert body["model"] == "deepseek/deepseek-v4.1-flash-1017" and body["max_tokens"] == 16000
    rows = [{**c, "submission": 0, "t_start": i, "t_end": i + 2, "latency_s": 2.0, "skipped": False,
             "decisions": [{"final": it["gold"]} for it in c["items"]], "cost_usd": 0.001} for i, c in enumerate(a)]
    rows[0]["error"] = "HTTP429"
    s = summarize(rows, {})
    assert s["wall_s"] == [41] and s["submissions_failing_any_part"] == 1 and s["errors"] == {"HTTP429": 1}
    print("Offline check passed: 40-part submissions (20 maths, 8 IELTS, 8 HKDSE Chinese, 4 contract), seeds differ, Wafer-first route, wall time and any-failure accounting.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    sub = parser.add_subparsers(dest="command")
    r = sub.add_parser("run")
    r.add_argument("--subs", type=int, default=1)
    r.add_argument("--inflight", type=int, required=True)
    r.add_argument("--seed", type=int, default=0)
    r.add_argument("--label", required=True)
    r.add_argument("--env", type=Path, required=True)
    r.add_argument("--output", type=Path, required=True)
    p = sub.add_parser("report")
    p.add_argument("--runs", nargs="+", type=Path, required=True)
    p.add_argument("--reference", nargs="*", type=Path)
    p.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.check:
        check()
        return 0
    if args.command == "run":
        return run(args)
    if args.command == "report":
        return report(args)
    parser.error("give --check, run or report")


if __name__ == "__main__":
    raise SystemExit(main())
