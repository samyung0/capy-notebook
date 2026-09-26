"""Count agent tool calls in saved lab turns (read-only over bench artifacts)."""

import collections
import json
from pathlib import Path

ROOT = Path(r"C:\WEB\capy-notebook")


def count_jsonl(root: Path) -> None:
    seen: dict[str, dict] = {}
    tot = collections.Counter()
    turns_with = collections.Counter()
    by_snap: dict[str, collections.Counter] = collections.defaultdict(
        collections.Counter
    )
    files = list(root.rglob("answers.jsonl"))
    for p in files:
        snap = p.relative_to(root).parts[0]
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            tid = r.get("turn_id")
            if not tid or tid in seen:
                continue
            tc = (r.get("telemetry") or {}).get("toolCallsByName") or {}
            seen[tid] = tc
            by_snap[snap]["turns"] += 1
            for k, v in tc.items():
                tot[k] += v
                if v:
                    turns_with[k] += 1
                    by_snap[snap][k] += 1
    print(root.name, "files", len(files), "turns", len(seen))
    print(" calls", dict(tot))
    print(" turns using", dict(turns_with))
    for s, c in by_snap.items():
        print(" ", s, dict(c))


def count_playground_runs(root: Path) -> None:
    tot = collections.Counter()
    n = 0
    for p in root.rglob("run.json"):
        n += 1
        text = p.read_text(encoding="utf-8")
        for name in (
            "list_sources",
            "describe_documents",
            "search_workspace",
            "read_document",
        ):
            tot[name] += text.count(f'"name": "{name}"') + text.count(
                f'"name":"{name}"'
            )
    print(root, "runs", n, dict(tot))


if __name__ == "__main__":
    count_jsonl(ROOT / "bench/rag/reports/local/2026-09-09-odl-agentic/snapshots")
    count_playground_runs(ROOT / "lab/playground/local/runs")
