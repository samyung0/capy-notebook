#!/usr/bin/env python3
"""Summarizes ladder steps from gateway/.results/<step>/ over each step's
measured window: the generator's verdict, the mean and peak CPU and memory per
container, each core's busy share, Postgres backends by state and wait type,
and the gateway's pool waits. Prints one block per step given."""

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path


def window(step: Path) -> tuple[dict, int, int]:
    summary = json.loads((step / "summary.json").read_text())
    if "from" in summary:
        return summary, summary["from"], summary["to"]
    # Steps recorded before the generator wrote its window.
    times = [s["t"] for s in summary["timeline"]]
    return summary, min(times), max(times)


def rows(path: Path, start: int, end: int):
    with path.open() as f:
        for row in csv.DictReader(f):
            if start <= int(row["time"]) <= end:
                yield row


def report(step: Path) -> None:
    summary, start, end = window(step)
    o = summary["overall"]
    print(f"== {step.name}: {'PASS' if summary['pass'] else 'FAIL ' + summary['fail_reason']}")
    print(
        f"   {o['per_second']:.0f} req/s ({o['per_second'] / summary['users']:.3f} per user), "
        f"p50 {o['p50_ms']:.0f} p95 {o['p95_ms']:.0f} p99 {o['p99_ms']:.0f} max {o['max_ms']:.0f} ms, "
        f"errors {o['error_rate'] * 100:.2f}%, streams {summary['streams']}"
    )
    cpu, mem = defaultdict(list), defaultdict(list)
    for row in rows(step / "containers.csv", start, end):
        cpu[row["service"]].append(float(row["cpu_cores"]))
        mem[row["service"]].append(float(row["memory_mib"]))
    for service in cpu:
        c, m = cpu[service], mem[service]
        print(
            f"   {service:8} cpu mean {sum(c) / len(c):.2f} p95 {sorted(c)[int(0.95 * len(c))]:.2f} cores, "
            f"memory peak {max(m):.0f} MiB"
        )
    cores = defaultdict(list)
    for row in rows(step / "cores.csv", start, end):
        cores[row["core"]].append(float(row["busy"]))
    print("   cores " + ", ".join(f"{k} {sum(v) / len(v):.0%}" for k, v in sorted(cores.items())))
    backends = defaultdict(float)
    seconds = set()
    for row in rows(step / "postgres.csv", start, end):
        backends[(row["state"], row["wait_event_type"] or "-")] += int(row["backends"])
        seconds.add(row["time"])
    if seconds:
        print(
            "   postgres backends (mean) "
            + ", ".join(f"{s}/{w} {n / len(seconds):.1f}" for (s, w), n in sorted(backends.items()))
        )
    waits = wait_ms = windows = full = 0
    for line in (step / "pool-waits.jsonl").read_text().splitlines():
        entry = json.loads(line)
        windows += 1
        waits += entry["waits"]
        wait_ms += entry["wait_ms"]
        full += entry["acquired"] >= entry["max"]
    print(
        f"   pool waits: {waits} acquires waited {wait_ms / 1000:.1f} s in all, "
        f"{windows} windows with waits, {full} with every connection taken at the line"
    )
    problems = (step / "server-problems.jsonl").read_text().splitlines()
    print(f"   gateway warnings and errors: {len(problems)}")
    for line in problems[:3]:
        print("     " + line[:300])
    timeline = summary["timeline"]
    if timeline and "p95_ms" in timeline[0]:
        slow = [s for s in timeline if s["p95_ms"] >= 500]
        print(
            f"   seconds with p95 over 500 ms: {len(slow)} of {len(timeline)}"
            + (f", first at +{slow[0]['t'] - start} s" if slow else "")
        )
    worst = sorted(summary["labels"], key=lambda l: -l["p95_ms"])[:5]
    print("   slowest routes (p95): " + ", ".join(f"{l['label']} {l['p95_ms']:.0f} ms" for l in worst))


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        report(Path(arg))
