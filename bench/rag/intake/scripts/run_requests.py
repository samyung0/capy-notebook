"""Run the intake comparison's frozen requests through a running playground.

    uv run python bench/rag/intake/scripts/run_requests.py --arm A \
        --url http://127.0.0.1:8765 --library-url <the arm's LIBRARY_DATABASE_URL>

One playground process serves one arm, its flags and library database set in
its environment (lab/playground/README.md, "Intake comparison"); the driver
reads that library once per request to name the sections cited. Each request
posts its turns to ``POST /api/turn`` one at a time; the confirmation turn of a
generic flow carries the first turn's history, checkpoint and stored ledger,
as the playground page sends them. Every dev-split request runs twice.

Output, one file per request run:
bench/rag/reports/local/2026-10-intake-eval/<arm>/<request-id>[-r2].json with
the run ids, answers, materials, write outcomes (the validators refuse a write
the app would not accept) and the protocol's counters. A request whose file
exists is skipped, so a stopped run resumes; delete a file to run it again.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

import psycopg
import yaml

REPO = Path(__file__).resolve().parents[4]
FIXTURES = REPO / "bench/rag/intake/fixtures"
CONFIGS = REPO / "lab/playground/configs"
OUT = REPO / "bench/rag/reports/local/2026-10-intake-eval"
WRITES = ("create_material", "edit_document", "copy_questions")
# A quiz fence in a note, as the playground's check_note reads it.
FENCE = re.compile(r"^```([\w-]*)[^\n]*\n(.*?)^```[ \t]*$", re.M | re.S)


def frozen_requests() -> list[dict[str, Any]]:
    """The requests, refused unless they hash to what the protocol froze."""
    protocol = json.loads((FIXTURES / "protocol.json").read_text(encoding="utf-8"))
    path = REPO / protocol["requests"]["path"]
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != protocol["requests"]["sha256"]:
        raise SystemExit(f"{path} differs from the request hash protocol.json froze")
    return json.loads(raw)["requests"]


def post_turn(url: str, body: dict[str, Any]) -> list[dict[str, Any]]:
    """One turn's server-sent events; an HTTP error stops the run."""
    request = urllib.request.Request(
        f"{url}/api/turn",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    events = []
    with urllib.request.urlopen(request) as response:
        for line in response:
            text = line.decode("utf-8").strip()
            if text.startswith("data: "):
                events.append(json.loads(text[len("data: ") :]))
    return events


def get_run(url: str, run_id: str) -> dict[str, Any]:
    with urllib.request.urlopen(f"{url}/api/runs/{run_id}") as response:
        return json.loads(response.read())


def fence_questions(markdown: str) -> int:
    count = 0
    for match in FENCE.finditer(markdown):
        if match.group(1) == "quiz":
            data = yaml.safe_load(match.group(2))
            count += len(data.get("questions") or []) if isinstance(data, dict) else 0
    return count


def cited_excerpts(runs: list[dict[str, Any]]) -> set[tuple[str, str]]:
    """(book id, excerpt id) for every excerpt a material's provenance credits."""
    return {
        (book["id"], excerpt_id)
        for run in runs
        for m in run["materials"]
        for book in ((m.get("provenance") or {}).get("books") or [])
        for excerpt_id in book.get("excerptIds") or []
    }


def excerpt_paths(library_url: str, ids: set[str]) -> dict[str, tuple[str, str]]:
    """(book id, full section path) of each excerpt id in the arm's library,
    current versions only, in one query."""
    if not ids:
        return {}
    with psycopg.connect(library_url) as conn:
        rows = conn.execute(
            "SELECT e.id, e.book_id, e.section_path FROM library_excerpts e "
            "JOIN rag_file_contents fc ON fc.content_id = e.content_id "
            "AND fc.workspace_id = 'library' WHERE e.id = ANY(%s)",
            (sorted(ids),),
        ).fetchall()
    return {excerpt_id: (book, path) for excerpt_id, book, path in rows}


def counters(
    runs: list[dict[str, Any]], paths: dict[str, tuple[str, str]]
) -> dict[str, Any]:
    """The protocol's counters over every turn of one request; ``paths`` maps
    the cited excerpt ids to (book id, section path)."""
    calls = [c for run in runs for c in run["calls"]]
    reads = [r for run in runs for r in run["ledger"]["reads"]]
    materials = [m for run in runs for m in run["materials"]]
    cited = cited_excerpts(runs)
    copied = sum(
        len(c["args"].get("question_ids") or [])
        for c in calls
        if c["name"] == "copy_questions" and c.get("outcome") == "succeeded"
    )
    quizzes = sum(len(m.get("questions") or []) for m in materials if m["kind"] == "quiz")
    added = sum(
        1
        for m in materials
        for e in m.get("edits") or []
        if isinstance(e, dict) and e.get("type") == "add_question"
    )
    embedded = sum(
        fence_questions(m.get("content") or "") for m in materials if m["kind"] == "note"
    )
    provider = [p for run in runs for p in run["provider_calls"]]
    return {
        "tool_calls": len(calls),
        "tool_calls_by_name": dict(Counter(c["name"] for c in calls)),
        "input_tokens": sum(p["input_tokens"] or 0 for p in provider),
        "cached_tokens": sum(p["cached_read_tokens"] or 0 for p in provider),
        "wall_seconds": round(sum(run["elapsed_seconds"] for run in runs), 2),
        "captures": sum(len(run["captures"]) for run in runs),
        "excerpts_read": len({r["excerpt_id"] for r in reads}),
        "sections_read": len(
            {
                (c["args"].get("book"), c["args"]["section"])
                for c in calls
                if c["name"] == "read_knowledge"
                and c["args"].get("section")
                and c.get("outcome") == "succeeded"
            }
        ),
        "books_cited": sorted(
            {
                book["id"]
                for m in materials
                for book in ((m.get("provenance") or {}).get("books") or [])
            }
        ),
        "sections_cited": sorted(
            {paths[e] for book, e in cited if paths.get(e, ("",))[0] == book}
        ),
        # Credited ids the library does not hold under that book.
        "sections_unmapped": sorted(
            e for book, e in cited if paths.get(e, ("",))[0] != book
        ),
        "questions_copied": copied,
        "questions_written": quizzes - copied + added + embedded,
    }


def run_request(
    url: str, library_url: str, config: dict[str, Any], request: dict[str, Any]
) -> dict[str, Any]:
    history: list[dict[str, Any]] = []
    checkpoint, ledger, next_id = None, None, 1
    turns, runs = [], []
    for question in request["turns"]:
        events = post_turn(
            url,
            {
                "config": config,
                "question": question,
                "history": history,
                "checkpoint": checkpoint,
                "ledger": ledger,
            },
        )
        history.append({"content": question, "id": f"m{next_id}", "role": "user"})
        next_id += 1
        done, error, run_id = None, None, None
        for event in events:
            kind = event.get("type")
            if kind == "checkpoint":
                checkpoint = {
                    k: event[k]
                    for k in (
                        "estimatedTokens",
                        "modelSlug",
                        "modelVersion",
                        "providerSlug",
                        "summary",
                        "throughMessageId",
                    )
                }
                ids = [m["id"] for m in history]
                if event["throughMessageId"] in ids:
                    history = history[ids.index(event["throughMessageId"]) + 1 :]
            elif kind == "done":
                done = event
                if event.get("answer") or event.get("toolEvidence"):
                    history.append(
                        {
                            "content": event.get("answer") or "",
                            "id": f"m{next_id}",
                            "role": "assistant",
                            "toolEvidence": event.get("toolEvidence"),
                        }
                    )
                    next_id += 1
            elif kind == "error":
                error = event
            elif kind == "run_saved":
                run_id = event["id"]
        run = get_run(url, run_id) if run_id else None
        if run is not None:
            runs.append(run)
            ledger = run["ledger"]["stored"]
        turns.append(
            {
                "question": question,
                "run_id": run_id,
                "answer": (done or {}).get("answer", ""),
                "stop_reason": ((done or {}).get("telemetry") or {}).get("stopReason"),
                "error": error,
                "materials": run["materials"] if run else [],
                # A call the stream closed on has no outcome yet; keep it visible as unfinished.
                "writes": [
                    {"name": c["name"], "outcome": c.get("outcome", "unfinished"), "error": c.get("error")}
                    for c in (run["calls"] if run else [])
                    if c["name"] in WRITES
                ],
                "todos": run["ledger"]["todos"] if run else [],
            }
        )
        if error is not None or done is None:
            break  # a confirmation after a failed turn would answer nothing
    paths = excerpt_paths(library_url, {e for _, e in cited_excerpts(runs)})
    return {"turns": turns, "counters": counters(runs, paths)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--arm", required=True, choices=("A", "B", "C"))
    parser.add_argument(
        "--url", required=True, help="the arm's playground, e.g. http://127.0.0.1:8765"
    )
    parser.add_argument(
        "--library-url",
        required=True,
        help="the arm's LIBRARY_DATABASE_URL, to name the cited sections",
    )
    parser.add_argument("--only", nargs="*", help="request ids to run, default all")
    args = parser.parse_args()
    name = f"intake-{args.arm.lower()}"
    config = json.loads((CONFIGS / f"{name}.json").read_text(encoding="utf-8"))
    requests = [
        r for r in frozen_requests() if not args.only or r["id"] in args.only
    ]
    out = OUT / args.arm
    out.mkdir(parents=True, exist_ok=True)
    # First runs of every request, then the dev split's repeats.
    plan = [(r, "") for r in requests] + [
        (r, "-r2") for r in requests if r["split"] == "dev"
    ]
    for request, suffix in plan:
        path = out / f"{request['id']}{suffix}.json"
        if path.exists():
            continue
        print(f"{args.arm} {request['id']}{suffix}", flush=True)
        result = run_request(args.url.rstrip("/"), args.library_url, config, request)
        record = {
            "arm": args.arm,
            "config": name,
            "request_id": request["id"],
            "repeat": 2 if suffix else 1,
            "kind": request["kind"],
            "split": request["split"],
            **result,
        }
        path.write_text(
            json.dumps(record, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        if any(t["error"] for t in result["turns"]):
            print(f"  turn error recorded in {path.name}", flush=True)


if __name__ == "__main__":
    main()
