"""Run fixture questions through a running playground server, one after another.

  uv run python lab/playground/scripts/batch.py --config chat --ids odl-agentic-051,odl-agentic-stress-002
  uv run python lab/playground/scripts/batch.py --config chat --split heldout

Writes local/batches/<config>-<stamp>.json with each question's required claims,
the answer, the run id and timing. Grading stays manual: the claims are shown
next to the answer for a reader to judge.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIGS, LOCAL, REPO

FIXTURES = [
    REPO / "bench/rag/fixtures/odl-agentic-questions.json",
    REPO / "bench/rag/fixtures/odl-agentic-stress-questions.json",
]


def questions() -> list[dict]:
    out = []
    for path in FIXTURES:
        data = json.loads(path.read_text())
        out.extend(data["questions"] if isinstance(data, dict) else data)
    return out


def scope(question: dict, workspace: dict) -> list[str] | None:
    ids = question.get("scope_source_ids")
    return [workspace["files"][s] for s in ids] if ids else None


def turn(server: str, config: dict, question: str) -> dict:
    req = urllib.request.Request(
        f"{server}/api/turn",
        data=json.dumps(
            {"config": config, "question": question, "history": []}
        ).encode(),
        headers={"content-type": "application/json"},
    )
    result = {"answer": "", "run_id": None, "citations": [], "error": None, "calls": []}
    with urllib.request.urlopen(req, timeout=1800) as response:
        for line in response:
            line = line.decode()
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            kind = event["type"]
            if kind == "tool_start":
                result["calls"].append(event["name"])
            elif kind == "citations" and event.get("final"):
                result["citations"] = [
                    (c["fileName"], c.get("pageStart")) for c in event["citations"]
                ]
            elif kind == "done":
                result["answer"] = event.get("answer", "")
                result["stop"] = (event.get("telemetry") or {}).get("stopReason")
            elif kind == "error":
                result["error"] = event.get("detail") or event.get("message")
            elif kind == "run_saved":
                result["run_id"], result["elapsed_seconds"] = (
                    event["id"],
                    event["elapsed_seconds"],
                )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--ids")
    parser.add_argument("--split", choices=("development", "heldout"))
    parser.add_argument("--server", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    config = json.loads((CONFIGS / f"{args.config}.json").read_text())
    workspaces = json.loads(
        (
            REPO / "bench/rag/fixtures/local/2026-09-09-odl-agentic/workspaces.json"
        ).read_text()
    )["arms"]
    workspace = next(
        (
            w
            for w in workspaces.values()
            if w["workspace_id"] == config.get("workspace_id")
        ),
        None,
    )
    wanted = set(args.ids.split(",")) if args.ids else None
    selected = [
        q
        for q in questions()
        if (wanted and q["id"] in wanted)
        or (args.split and q.get("split") == args.split)
    ]
    if not selected:
        raise SystemExit("no questions selected")
    out = LOCAL / "batches" / f"{args.config}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for q in selected:
        cfg = dict(config)
        if workspace is not None:
            cfg["scope_file_ids"] = scope(q, workspace)
        print(f"== {q['id']} {q['question'][:90]}", flush=True)
        try:
            result = turn(args.server, cfg, q["question"])
        except Exception as exc:  # noqa: BLE001 - keep going, record the failure
            result = {"error": f"{type(exc).__name__}: {exc}", "answer": ""}
        rows.append(
            {
                "id": q["id"],
                "question": q["question"],
                "required_claims": q.get("required_claims"),
                **result,
            }
        )
        print(
            f"   run={result.get('run_id')} {result.get('elapsed_seconds')}s calls={result.get('calls')} error={result.get('error')}"
        )
        print("   answer:", result["answer"][:500].replace("\n", " "), flush=True)
        print("   claims:", q.get("required_claims"), flush=True)
        out.write_text(
            json.dumps(
                {"config": args.config, "rows": rows}, ensure_ascii=False, indent=1
            )
        )
    print(f"saved {out}")


if __name__ == "__main__":
    main()
