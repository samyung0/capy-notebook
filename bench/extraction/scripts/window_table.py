"""Tables for the window-size bench, from the saved runs
(``.results/<paper>-<model>-<n>-w<size>.json``, made by ``run.py --window-pages``).

    python bench/extraction/scripts/window_table.py [--runs 81,82]

Prints one row per window size summed over its runs, one row per paper and
size, and how replies behave by the questions they record.
"""

from __future__ import annotations

import argparse
import collections
import json
import statistics
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / ".results"
SIZES = ["1", "2", "3", "4", "6", "all"]
PAPERS = ["2021-p1", "2024-p1", "2022-p1", "2022-p2"]


def windows_of(calls: list[dict]) -> list[list[dict]]:
    """A run's window calls, split into windows: a window ends at a reply with
    no tool call that was not cut off, or at its sixth call (WINDOW_STEPS)."""
    out: list[list[dict]] = []
    current: list[dict] = []
    for call in calls:
        current.append(call)
        closing = not call["tool_calls"] and call["finish"] != "length"
        if closing or len(current) == 6:
            out.append(current)
            current = []
    if current:
        out.append(current)
    return out


def ran_out(window: list[dict]) -> bool:
    """Used all six steps with its last reply still recording or cut off."""
    last = window[-1]
    return len(window) == 6 and (last["tool_calls"] > 0 or last["finish"] == "length")


def recorded(call: dict) -> int:
    return sum(1 for _, outcome, _ in call["results"] if outcome == "recorded")


def load(runs: list[str]) -> list[dict]:
    rows = []
    for size in SIZES:
        for paper in PAPERS:
            for run in runs:
                path = RESULTS / f"{paper}-v41-1017-{run}-w{size}.json"
                if path.exists():
                    result = json.loads(path.read_text())
                    rows.append({"size": size, "paper": paper, "run": run, "r": result})
    return rows


def fraction(values: list[str]) -> tuple[int, int]:
    pairs = [tuple(map(int, v.split("/"))) for v in values if v]
    return sum(p[0] for p in pairs), sum(p[1] for p in pairs)


def size_table(rows: list[dict]) -> None:
    print(
        "| Window | Runs | Labels found | Lost | Extra labels | Part structure | Part marks "
        "| MCQ keys worked out | Figures named | Crops whole | Calls | Re-asks | Cut off "
        "| Refused | Continued | Windows out of steps | Busiest window (steps) "
        "| Qs a recording call | Most Qs in a reply | Most parts in a reply "
        "| Output a page (highest run) | Largest reply | Guard fired "
        "| Seconds a run (mean, max) | Billed |"
    )
    print("|" + "---|" * 25)
    for size in SIZES:
        group = [row for row in rows if row["size"] == size]
        if not group:
            continue
        scores = [row["r"]["scores"] for row in group]
        window = [s["window"] for s in scores]
        calls = [c for row in group for c in row["r"]["calls"]]
        windows = [w for row in group for w in windows_of(row["r"]["calls"])]
        gold = sum(s["gold"] for s in scores)
        missing = sum(len(s["missing_labels"]) for s in scores)
        structure = fraction([s["part_structure"] for s in scores])
        marks = fraction([s["part_marks_exact"] for s in scores])
        mcq = fraction([s["mcq_worked_out_key_right"] for s in scores])
        whole = sum(s["boxes"]["whole"] for s in scores)
        matched = sum(s["boxes"]["matched_gold"] for s in scores)
        named = sum(s["figures_boxed_on_gold_figure_questions"] for s in scores)
        figures = sum(s["figures_gold"] for s in scores)
        counts = [recorded(c) for c in calls if recorded(c)]
        seconds = [row["r"]["seconds"] for row in group]
        print(
            f"| {size} | {len(group)} | {gold - missing}/{gold} | {missing} "
            f"| {sum(len(s['extra_labels']) for s in scores)} "
            f"| {structure[0]}/{structure[1]} | {marks[0]}/{marks[1]} "
            f"| {mcq[0]}/{mcq[1]} | {named}/{figures} | {whole}/{matched} "
            f"| {len(calls)} | {sum(w['re_asks'] for w in window)} "
            f"| {sum(w['cut_off'] for w in window)} "
            f"| {sum(w['results'].get('refused', 0) for w in window)} "
            f"| {sum(w['results'].get('continued', 0) for w in window)} "
            f"| {sum(1 for w in windows if ran_out(w))} "
            f"| {max(len(w) for w in windows)} "
            f"| {statistics.mean(counts):.1f} "
            f"| {max(w['most_questions_in_a_call'] for w in window)} "
            f"| {max(w['most_parts_in_a_call'] for w in window)} "
            f"| {max(w['window_output_per_page'] for w in window):,} "
            f"| {max(w['most_output_in_a_call'] for w in window):,} "
            f"| {sum(1 for w in window if w['stopped'] == 'output_limit')} "
            f"| {statistics.mean(seconds):.0f}, {max(seconds):.0f} "
            f"| ${sum(row['r']['billed_usd'] or 0 for row in group):.3f} |"
        )


def paper_table(rows: list[dict]) -> None:
    print(
        "| Window | Paper | Run | Windows | Labels | Lost | Structure | Marks "
        "| MCQ worked out | Whole | Calls | Cut off | Refused | Out of steps "
        "| Most Qs | Largest reply | Output a page | Seconds | Billed | Served by |"
    )
    print("|" + "---|" * 20)
    for row in rows:
        result, s = row["r"], row["r"]["scores"]
        w = s["window"]
        windows = windows_of(result["calls"])
        print(
            f"| {row['size']} | {row['paper']} | {row['run']} | {w['windows']} "
            f"| {s['gold'] - len(s['missing_labels'])}/{s['gold']} "
            f"| {','.join(s['missing_labels']) or '–'} | {s['part_structure']} "
            f"| {s['part_marks_exact']} | {s['mcq_worked_out_key_right'] or '–'} "
            f"| {s['boxes']['whole']}/{s['boxes']['matched_gold']} | {w['calls']} "
            f"| {w['cut_off']} | {w['results'].get('refused', 0)} "
            f"| {sum(1 for x in windows if ran_out(x))} "
            f"| {w['most_questions_in_a_call']} | {w['most_output_in_a_call']:,} "
            f"| {w['window_output_per_page']:,} | {result['seconds']:.0f} "
            f"| ${result['billed_usd']} | {','.join(result['providers'])} |"
        )


def reply_table(rows: list[dict]) -> None:
    """How replies behave by the questions they record, every paper."""
    print(
        "| Questions in the reply | Replies | Parts (median) | Output tokens (median, max) | Paper 2 replies |"
    )
    print("|---|---|---|---|---|")
    buckets = [(1, 3), (4, 6), (7, 9), (10, 12), (13, 99)]
    for low, high in buckets:
        found = [
            (c, row["paper"])
            for row in rows
            for c in row["r"]["calls"]
            if low <= recorded(c) <= high
        ]
        if not found:
            continue
        outputs = [c["output"] for c, _ in found]
        parts = [
            sum(n for _, outcome, n in c["results"] if outcome == "recorded")
            for c, _ in found
        ]
        name = f"{low}-{high}" if high < 99 else f"{low}+"
        print(
            f"| {name} | {len(found)} | {statistics.median(parts):.0f} "
            f"| {statistics.median(outputs):,.0f}, {max(outputs):,} "
            f"| {sum(1 for _, paper in found if paper == '2022-p2')} |"
        )
    cut = collections.Counter(
        (row["size"], row["paper"])
        for row in rows
        for c in row["r"]["calls"]
        if c["finish"] == "length"
    )
    print()
    print(
        "Replies cut off at the output cap, by window and paper:", dict(cut) or "none"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", default="81,82")
    args = parser.parse_args()
    rows = load(args.runs.split(","))
    size_table(rows)
    print()
    paper_table(rows)
    print()
    reply_table(rows)
    print()
    total = sum(row["r"]["billed_usd"] or 0 for row in rows)
    print(f"{len(rows)} runs, billed ${total:.3f}")


if __name__ == "__main__":
    main()
