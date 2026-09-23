"""Test an explicit tools-off answer instruction through fresh workspace turns.

Reuse the frozen opening experiment's runtime, corpus, scope checks and runner.
Both arms keep the original catalog and k=5. Only the eighth tools-off request
changes. Provider requests and responses are saved locally without credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import sys
from pathlib import Path

import workspace_opening_agentic as opening

OUT = opening.ROOT / "bench/rag/reports/local/2026-09-22-workspace-terminal"
CASE_IDS = (
    "workspace-opening-mayor",
    "workspace-opening-author-excluded",
    "workspace-opening-gpt2",
    "workspace-opening-gpt20",
    "workspace-opening-resnet-sd",
)
FINAL_INSTRUCTION = (
    "This is the final response for this turn. No tools are available and no "
    "further calls will be executed. Answer the user's request now using only "
    "evidence already shown, in the required OpenUI Lang format. Cite the shown "
    "passages that support each factual claim. If the available evidence is "
    "insufficient, state the precise remaining evidence gap. Do not claim the "
    "entire workspace lacks an answer merely because searches did not find it. "
    "Do not call or propose tools."
)


def cases():
    by_id = {c["id"]: c for c in opening.read(opening.FIXTURE)["cases"]}
    return [by_id[case_id] for case_id in CASE_IDS]


def schedule(selected):
    rows = [(case, 0) for case in selected]
    rows += [(selected[0], repeat) for repeat in (1, 2)]
    return [
        (case, repeat, arm)
        for index, (case, repeat) in enumerate(rows)
        for arm in (
            ("baseline", "terminal") if index % 2 == 0 else ("terminal", "baseline")
        )
    ]


def check():
    selected = cases()
    plan = schedule(selected)
    assert len(plan) == 14
    assert all(
        sum(a == arm for _, _, a in plan) == 7 for arm in ("baseline", "terminal")
    )
    assert selected[1]["scope_source_ids"] == ["rag__es__sesgo-linguistico-digital"]
    manifest = opening.read(opening.LOCAL / "runtime-manifest.json")
    assert all(opening.sha(opening.RUNTIME / p) == h for p, h in manifest.items())
    sources = opening.read(opening.CORPUS / "sources.json")["sources"]
    for source in sources:
        assert (
            opening.sha(opening.CORPUS / source["original"])
            == source["original_sha256"]
        )
        assert opening.sha(opening.CORPUS / source["pdf"]) == source["pdf_sha256"]
    print(
        json.dumps(
            {
                "turns": len(plan),
                "runtime_files": len(manifest),
                "sources": len(sources),
            }
        )
    )


async def run():
    check()
    fixture = {
        "schema": "workspace-terminal-v1",
        "candidate": FINAL_INSTRUCTION,
        "cases": cases(),
    }
    freeze = {
        "wrapper_sha256": opening.sha(Path(__file__)),
        "runner_sha256": opening.sha(Path(opening.__file__)),
        "source_fixture_sha256": opening.sha(opening.FIXTURE),
        "candidate": FINAL_INSTRUCTION,
        "schedule": [
            {"id": c["id"], "repeat": n, "arm": a}
            for c, n, a in schedule(fixture["cases"])
        ],
        "scope": "Fresh whole turns. Original catalog; no opening headings, wider k or reranking.",
        "trace": "Provider request bodies and SSE responses only; authentication headers excluded.",
    }
    if (OUT / "freeze.json").exists():
        assert opening.read(OUT / "freeze.json") == freeze, "Wrapper protocol changed"
        assert opening.read(OUT / "cases.json") == fixture, "Cases changed"
    else:
        opening.save(OUT / "freeze.json", freeze)
        opening.save(OUT / "cases.json", fixture)
    opening.OUT, opening.FIXTURE, opening.schedule = OUT, OUT / "cases.json", schedule
    sys.path[:0] = [
        str(opening.RUNTIME / "lab/playground/scripts"),
        str(opening.RUNTIME / "pipeline"),
    ]
    import playground

    original_events = playground.Turn.events

    async def traced_events(turn):
        from pipeline.elitellm import client

        original_sse = client._stream_sse
        call_number = 0

        async def traced_sse(url, headers, body):
            nonlocal call_number
            call_number += 1
            wire = copy.deepcopy(body)
            terminal = call_number == turn.config["limits"][
                "planning_responses"
            ] and not wire.get("tools")
            applied = terminal and turn.run_dir.name == "terminal"
            if applied:
                wire["messages"].append(
                    {"role": "system", "content": FINAL_INSTRUCTION}
                )
            folder = turn.run_dir / "provider" / str(call_number)
            opening.save(folder / "request.json", wire)
            opening.save(
                folder / "condition.json",
                {"terminal": terminal, "instruction_applied": applied},
            )
            with (folder / "response.jsonl").open("w") as stream:
                async for event in original_sse(url, headers, wire):
                    stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                    yield event

        client._stream_sse = traced_sse
        try:
            async for event in original_events(turn):
                yield event
        finally:
            client._stream_sse = original_sse

    playground.Turn.events = traced_events
    try:
        await opening.run()
    finally:
        playground.Turn.events = original_events
    assert opening.sha(Path(__file__)) == freeze["wrapper_sha256"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "run"))
    args = parser.parse_args()
    if args.mode == "check":
        check()
    else:
        asyncio.run(run())
