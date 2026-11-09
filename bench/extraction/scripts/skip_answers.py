"""Whether Make a quiz skips an answer it can't get, and only then (Epo 2026-11-05, "skip
the answer if there not enough information/missing information/unreadable"). Report:
``reports/2026-11-05-skip-answers.md``.

    python -I skip_answers.py run --refs <question-bank references> --detections <a.json> \
        --env-file deploy/.env.uat --hard-stop 0.5
    python -I skip_answers.py score

``cited``: a page citing figures it doesn't print, where every answer should be skipped.
``worked``: past-paper pages with everything they need and no answer file, where none
should be. ``scheme``: the same with its mark scheme as text. Results stay in the ignored
``.results/skipanswers/``, and only counts go in the report.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402
import selections as sel  # noqa: E402

OUT = bench.RESULTS / "skipanswers"
CITED = OUT / "files" / "cited.pdf"
RUNS = {"cited": 3, "worked": 3, "scheme": 2}
sel.OUT = OUT
sel.JOBS["cited"] = sel.Job([(str(CITED), [1], "")])
sel.JOBS["worked"] = sel.Job(
    [(f"{sel.MATHS}/2023-p1.pdf", list(range(2, 10)), "2023-p1")]
)
sel.JOBS["scheme"] = sel.Job([], text_paper="2021-p1", answers="2021-ans.txt")
# Words a model might put in a key rather than leave it empty.
EXCUSE = re.compile(
    r"determin|not printed|not shown|not given|not provided|cannot|can't|missing|"
    r"unknown|insufficient|unreadable|not enough|n/a",
    re.I,
)


async def run_all(args) -> None:
    bench.load_env(args.env_file)
    spend = OUT / "spend.json"
    sel.LIVE["usd"] = json.loads(spend.read_text())["usd"] if spend.exists() else 0.0
    sel.LIVE["stop"] = args.hard_stop
    sel.install()
    validate = bench.validator(bench.quizcheck())
    provider, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec(provider, slug, name, rates, "low")
    detections: dict = {}
    for path in args.detections:
        for page in json.loads(Path(path).read_text())["pages"]:
            detections[page["page"]] = page["regions"]
    try:
        for job, runs in RUNS.items():
            for repeat in range(1, runs + 1):
                path = OUT / f"{job}-{repeat}.json"
                if path.exists():
                    continue
                if sel.LIVE["usd"] > sel.LIVE["stop"] - 0.03:
                    print(f"skip {path.name}: at the budget", flush=True)
                    continue
                try:
                    result = await sel.one(job, repeat, args, validate, model, detections)
                except Exception as exc:  # A run that fails is a finding; the rest go on.
                    print(f"FAILED {path.name}: {type(exc).__name__}"[:200], flush=True)
                    path.with_suffix(".failed").write_text(repr(exc))
                    continue
                path.write_text(json.dumps(result, ensure_ascii=False))
                print(
                    f"{path.name}: {result['seconds']} s, ${result['billed_usd']:.4f}, "
                    f"{len(result['questions'])} questions, total ${sel.LIVE['usd']:.4f}",
                    flush=True,
                )
    finally:
        spend.write_text(json.dumps({"usd": round(sel.LIVE["usd"], 5)}))


def score(_args) -> None:
    for path in sorted(OUT.glob("*-[0-9].json")):
        run = json.loads(path.read_text())
        report = run["report"]
        parts = [part for q in run["questions"] for part in q["parts"]]
        excuses = 0
        for part in parts:
            answer = part["answer"]
            keys = [str(v) for v in answer.get("accepted") or []]
            keys += [str(b.get("text", "")) for b in part.get("solution") or []]
            excuses += any(EXCUSE.search(text) for text in keys)
        print(
            f"{path.name}: map {len(report['expected'])}, saved {len(run['questions'])}, "
            f"parts {len(parts)}, skipped {len(report['answersMissing'])} "
            f"{report['answersMissing'][:12]}, missing {len(report['missing'])}, "
            f"keys or solutions with an excuse word {excuses}; "
            f"${run['billed_usd']:.4f}, {run['seconds']} s"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    go = commands.add_parser("run")
    go.add_argument("--refs", required=True)
    go.add_argument("--detections", nargs="+", required=True)
    go.add_argument("--env-file", required=True)
    go.add_argument("--hard-stop", type=float, default=0.5)
    commands.add_parser("score")
    args = parser.parse_args()
    if args.command == "run":
        asyncio.run(run_all(args))
    else:
        score(args)


if __name__ == "__main__":
    main()
