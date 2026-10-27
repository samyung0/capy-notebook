"""Office pictures and charts in the playground (Q240 phase B, plan step 6).

Q&A turns and deliberately wrong-argument turns on lecture.pptx,
exchange-plan.docx and course-guide.xlsx (e2e/fixtures/files/rich-content),
on the chat models we serve, through production's agent and tools with the
playground's Office engine (office.py). The three fixtures are files of a
fixture workspace: their rows, blobs, outline and page sources are answered
here, and nothing is written to any database. The results say which repairs
the models' wrong calls need (Epo 2026-10-24, Q277: a malformed call whose
meaning is clear gets repaired, not refused).

Provider calls run on the UAT host, never on the developer PC (Epo
2026-10-23); the harness STATE gives the docker command. There:

  python lab/playground/scripts/office_pictures.py run --env \\
      --models zai:glm-5.3-flash:1,openrouter:minimax/minimax-m3.1-flash:1

``--env`` takes DATABASE_URL, the provider and B2 keys and OFFICE_SERVICE_BIN
from the environment instead of the playground's tunnel. ``check`` runs every
fixture read and by-id read through production's tools and the engine with no
model and no database, so it is safe anywhere:

  python lab/playground/scripts/office_pictures.py check

Results: local/office-pictures/<stamp>.json and .md, each turn's run under
local/runs/.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import LOCAL, REPO

WORKSPACE = "ws_pg_office_pictures"
FIXTURES = REPO / "e2e/fixtures/files/rich-content"
# file id -> (name, the files row's kind)
FILES = {
    "f_pg_lecture": ("lecture.pptx", "slides"),
    "f_pg_plan": ("exchange-plan.docx", "doc"),
    "f_pg_guide": ("course-guide.xlsx", "sheet"),
}
OUT = LOCAL / "office-pictures"

# What a turn asks, and what a good turn does (the report's reading aid).
CASES = [
    {
        "id": "pptx-picture",
        "question": "What is written on the picture on slide 4 of lecture.pptx?",
        "good": "reads the slide, then inspect_office_document ids attaches the picture",
    },
    {
        "id": "docx-picture",
        "question": "What does Figure 2 in exchange-plan.docx show? Look at the picture itself.",
        "good": "reads the document, then ids attaches the picture",
    },
    {
        "id": "docx-chart",
        "question": "List every item of the 交流團預計支出 chart in exchange-plan.docx with its amount.",
        "good": "the chart's points from a read, or ids for every point",
    },
    {
        "id": "xlsx-chart",
        "question": "What does the chart in course-guide.xlsx plot, and what is its value for each area?",
        "good": "the sheet list's chart series and the Summary cells",
    },
    {
        "id": "docx-capture-page",
        "question": "Use capture_page to show me page 3 of exchange-plan.docx and describe it.",
        "good": "capture_page refused (no page view), then inspect_office_document",
    },
    {
        "id": "xlsx-capture-page",
        "question": "Capture page 1 of course-guide.xlsx and tell me what its chart shows.",
        "good": "capture_page refused, then the sheet list's chart",
    },
    {
        "id": "pptx-wrong-id",
        "question": (
            "In lecture.pptx, read the picture with id slide:3:999:shape:7 and "
            "describe it."
        ),
        "good": "the notice names the id as not found; a read finds the real ids",
    },
    {
        "id": "pptx-slide-past-end",
        "question": "What pictures are on slide 25 of lecture.pptx?",
        "good": "the slide read is refused past the last slide; the answer says so",
    },
    {
        "id": "docx-guessed-ids",
        "question": (
            "Without reading exchange-plan.docx first, fetch its first picture by id "
            "and describe it."
        ),
        "good": "a guessed id is named as malformed or not found; a read then finds it",
    },
]


def inject() -> None:
    """Serve the fixtures as files of WORKSPACE: the outline, the file rows
    office.py and capture_page read, and their blobs. Every other workspace
    and file goes where it went before."""
    import office
    from pipeline.retrieval import store
    from pipeline.store import blobstore

    blobs = {f"pg-fixture/{name}": FIXTURES / name for name, _ in FILES.values()}
    rows = {
        fid: {
            "id": fid,
            "name": name,
            "kind": kind,
            "blob_path": f"pg-fixture/{name}",
            "chapter_id": None,
            "parse_mode": "standard",
            "ever_parsed_successfully": True,
        }
        for fid, (name, kind) in FILES.items()
    }
    outline, page_source = store.workspace_outline, store.file_page_source
    read_bytes, published = blobstore.read_bytes, office._published

    async def workspace_outline(workspace_id: str) -> dict[str, Any]:
        if workspace_id != WORKSPACE:
            return await outline(workspace_id)
        files = [
            {
                "id": fid,
                "name": row["name"],
                "chapter_id": None,
                "status": "ready",
                "descriptor": "",
                "chunks": 0,
            }
            for fid, row in rows.items()
        ]
        return {"chapters": [], "files": files}

    async def file_page_source(workspace_id: str, file_id: str):
        if workspace_id == WORKSPACE:
            return rows.get(file_id)
        return await page_source(workspace_id, file_id)

    async def published_row(workspace_id: str, file_id: str):
        if workspace_id == WORKSPACE:
            return rows.get(file_id)
        return await published(workspace_id, file_id)

    def fixture_bytes(path: str, *args: Any, **kwargs: Any) -> bytes:
        if path in blobs:
            return blobs[path].read_bytes()
        return read_bytes(path, *args, **kwargs)

    store.workspace_outline = workspace_outline
    store.file_page_source = file_page_source
    office._published = published_row
    blobstore.read_bytes = fixture_bytes


def environment(use_env: bool, target: str) -> None:
    """The playground's environment, or with ``use_env`` the process's own
    (the UAT host's throwaway container), before pipeline imports."""
    import playground

    if use_env:
        missing = [
            k for k in ("DATABASE_URL", "OFFICE_SERVICE_BIN") if not os.environ.get(k)
        ]
        if missing:
            raise SystemExit(f"--env needs {', '.join(missing)} in the environment")
        os.environ.setdefault("CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S", "60")
        playground.prepare_environment = lambda _target: os.environ["DATABASE_URL"]
    else:
        playground.prepare_environment(target)
        playground.prepare_environment = lambda _target: os.environ["DATABASE_URL"]
    sys.path.insert(0, str(REPO / "pipeline"))


def serve(args: argparse.Namespace) -> None:
    import playground

    environment(args.env, args.target)
    inject()
    sys.argv = ["playground.py", "--target", args.target, "--port", str(args.port)]
    playground.main()


def _model(text: str) -> dict[str, Any]:
    provider, _, rest = text.partition(":")
    slug, _, version = rest.rpartition(":")
    return {
        "provider_slug": provider,
        "model_slug": slug,
        "version": int(version),
        "thinking": "high",
        "transport": None,
    }


def _turn(port: int, config: dict[str, Any], question: str) -> dict[str, Any]:
    """One playground turn; its saved run's tool calls and answer."""
    body = {"config": config, "question": question, "history": []}
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/turn",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    run_id, error = None, None
    with urllib.request.urlopen(request, timeout=1800) as response:
        for raw in response:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            if event.get("type") == "error":
                error = event.get("detail") or event.get("message")
            if event.get("type") == "run_saved":
                run_id = event["id"]
    if run_id is None:
        return {"error": error or "no run saved", "calls": [], "answer": ""}
    run = json.loads((LOCAL / "runs" / run_id / "run.json").read_text("utf-8"))
    calls = [
        {
            "name": call.get("name"),
            "args": call.get("arguments") or call.get("args"),
            "outcome": call.get("outcome"),
            "error": call.get("error"),
            "text": (call.get("text_sent_to_model") or "")[:1500],
        }
        for call in run.get("calls") or []
    ]
    return {
        "run": run_id,
        "error": error,
        "calls": calls,
        "answer": (run.get("answer") or "")[:1500],
        "usage": run.get("usage"),
    }


def _summary(rows: list[dict[str, Any]]) -> str:
    lines = ["# Office pictures playground turns", ""]
    for row in rows:
        lines += [
            f"## {row['case']} on {row['model']}",
            f"Good turn: {row['good']}",
            f"Run: {row.get('run')}  error: {row.get('error')}",
        ]
        for call in row["calls"]:
            args = json.dumps(call["args"], ensure_ascii=False)[:300]
            error = (
                json.dumps(call["error"], ensure_ascii=False)[:300]
                if call["error"]
                else ""
            )
            lines.append(f"- {call['name']} {args} -> {call['outcome']} {error}")
        lines += [f"Answer: {row['answer'][:600]!r}", ""]
    return "\n".join(lines)


def turns(args: argparse.Namespace) -> None:
    models = [_model(m) for m in args.models.split(",") if m]
    cases = [c for c in CASES if not args.cases or c["id"] in args.cases.split(",")]
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rows: list[dict[str, Any]] = []
    for model in models:
        config = {"workspace_id": WORKSPACE, "workspace_only": True, "model": model}
        for case in cases:
            label = f"{model['provider_slug']}:{model['model_slug']}"
            print(f"== {case['id']} on {label}", flush=True)
            try:
                result = _turn(args.port, config, case["question"])
            except Exception as exc:  # noqa: BLE001 - keep going, record it
                result = {
                    "error": f"{type(exc).__name__}: {exc}",
                    "calls": [],
                    "answer": "",
                }
            rows.append(
                {"case": case["id"], "model": label, "good": case["good"], **result}
            )
            names = [c["name"] for c in result["calls"]]
            print(f"   calls={names} error={result.get('error')}", flush=True)
            (OUT / f"{stamp}.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=1), "utf-8"
            )
    (OUT / f"{stamp}.md").write_text(_summary(rows), "utf-8")
    print(f"saved {OUT / stamp}.json and .md")


def run(args: argparse.Namespace) -> None:
    """serve in a child process, the turns against it, then stop it."""
    command = [
        sys.executable,
        __file__,
        "serve",
        "--target",
        args.target,
        "--port",
        str(args.port),
    ]
    server = subprocess.Popen([*command, *(["--env"] if args.env else [])])
    try:
        deadline = time.monotonic() + 180
        while True:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", args.port)) == 0:
                    break
            if server.poll() is not None or time.monotonic() > deadline:
                raise SystemExit("the playground server did not start")
            time.sleep(1)
        turns(args)
    finally:
        server.terminate()
        server.wait(timeout=30)


def check(_args: argparse.Namespace) -> None:
    """Every fixture read and a by-id read of its first pictures and chart,
    through production's tools and the engine; no model, no database."""
    if not os.environ.get("OFFICE_SERVICE_BIN"):
        raise SystemExit("check needs OFFICE_SERVICE_BIN (office.py)")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.path.insert(0, str(REPO / "pipeline"))
    import re

    import office
    from pipeline.config import cfg
    from pipeline.retrieval import skills, tools

    cfg.gateway_url = cfg.gateway_url or "http://playground.invalid"
    cfg.pipeline_secret = cfg.pipeline_secret or "playground"
    inject()
    state: dict[str, Any] = {"run_dir": OUT / "check", "extra": []}

    async def main() -> None:
        ctx = tools.ToolContext(
            workspace_id=WORKSPACE,
            user_id="playground",
            operations=frozenset({"source.read", "material.read"}),
            office_tools=True,
            skills_read={skills.OFFICE_BUILDING},
        )
        reads = [
            ("f_pg_lecture", {"slide": 4}),
            ("f_pg_lecture", {"count": 6}),
            ("f_pg_plan", {"count": 200}),
            ("f_pg_guide", {}),
        ]
        with office.local_gateway(state):
            for n, (fid, query) in enumerate(reads):
                args = {"file_id": fid, **query, "_tool_call_id": f"r{n}"}
                read = await tools.run("inspect_office_document", args, ctx)
                text = read.text()
                # Ids hold a colon or a hash; the head's "[id] picture" does not.
                ids = re.findall(r"\[([^\]\s]*[:#][^\]\s]*)\] (?:picture|chart)", text)[
                    :4
                ]
                print(f"== {FILES[fid][0]} {query}: {len(text)} chars, objects {ids}")
                print(
                    "\n".join(
                        line
                        for line in text.splitlines()
                        if re.search(r"picture|chart|series|equation|drawing", line)
                    )[:1500]
                )
                if not ids:
                    continue
                by_id = await tools.run(
                    "inspect_office_document",
                    {"file_id": fid, "ids": ids, "_tool_call_id": f"b{n}"},
                    ctx,
                )
                print(f"-- ids {ids}:\n{by_id.text()[:1500]}")
            refused = await tools.run(
                "capture_page",
                {"file_id": "f_pg_plan", "page": 3, "_tool_call_id": "cap"},
                ctx,
            )
            print(f"-- capture_page on the DOCX: {refused.text()}")
        print(f"images attached: {list(ctx.pending_images)}")
        print(
            f"capture records: {[(r['callId'], r.get('picture'), r['pixels']) for r in ctx.captures]}"
        )

    try:
        asyncio.run(main())
    finally:
        office.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("serve", "turns", "run", "check"):
        sub = commands.add_parser(name)
        sub.add_argument("--port", type=int, default=18799)
        sub.add_argument("--target", default="uat")
        sub.add_argument("--env", action="store_true")
        sub.add_argument("--models", default="zai:glm-5.3-flash:1")
        sub.add_argument("--cases", default="")
    args = parser.parse_args()
    {"serve": serve, "turns": turns, "run": run, "check": check}[args.command](args)


if __name__ == "__main__":
    main()
