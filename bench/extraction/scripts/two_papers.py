"""Two question files that number their questions alike and hold figures on the same page
numbers, through the finished route (review findings 5 and 6, 2026-11-05). Report:
``reports/2026-11-05-two-papers.md``.

    python -I two_papers.py run --refs <question-bank references> --detections <a.json> <b.json> \
        --env-file deploy/.env.uat --runs 3 --hard-stop 0.6
    python -I two_papers.py score

A box's ``page`` names no file, so a question could take the other paper's figure; and a
label the two papers share would overwrite the earlier copy. Each run records every
``record_question`` call's label, pages and boxes. Nothing is patched but what
``selections.py`` patches. Results stay in the ignored ``.results/twopapers/``; only counts
go in the report.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402
import selections as sel  # noqa: E402

OUT = bench.RESULTS / "twopapers"
PAGES = [6, 7, 8, 10, 13]
PAPERS = ("2023-p2", "2024-p2")
sel.OUT = OUT
sel.JOBS["two-papers"] = sel.Job(
    [(f"{sel.MATHS}/{paper}.pdf", PAGES, paper) for paper in PAPERS]
)


def watch() -> None:
    """Keeps the boxes the map was sent and every call to ``record_question``."""
    from pipeline import elitellm
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import models

    messages = prompts.map_messages

    def map_messages(pages, boxes, answers, *, system):
        sel.STATE.get().boxes = boxes
        return messages(pages, boxes, answers, system=system)

    prompts.map_messages = map_messages
    response = models.complete_response

    async def complete_response(sent, **kwargs):
        reply = await response(sent, **kwargs)
        state = sel.STATE.get()
        message = elitellm.assistant_message_from_obj(
            elitellm.message_from_response(reply)
        )
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            if function.get("name") == "record_question":
                try:
                    args = json.loads(function.get("arguments") or "{}")
                except ValueError:
                    continue
                state.recorded = [
                    *getattr(state, "recorded", []),
                    {
                        "label": str(args.get("label")),
                        "pages": args.get("pages"),
                        "figures": args.get("figures"),
                    },
                ]
        return reply

    models.complete_response = complete_response


async def run_all(args) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    bench.load_env(args.env_file)
    spend = OUT / "spend.json"
    sel.LIVE["usd"] = json.loads(spend.read_text())["usd"] if spend.exists() else 0.0
    sel.LIVE["stop"] = args.hard_stop
    sel.install()
    watch()
    validate = bench.validator(bench.quizcheck())
    provider, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec(provider, slug, name, rates, "low")
    detections: dict = {}
    for path in args.detections:
        for page in json.loads(Path(path).read_text())["pages"]:
            detections[page["page"]] = page["regions"]
    try:
        for repeat in range(1, args.runs + 1):
            path = OUT / f"two-papers-{repeat}.json"
            if path.exists():
                continue
            if sel.LIVE["usd"] > sel.LIVE["stop"] - 0.03:
                print(f"skip {path.name}: at the budget", flush=True)
                continue
            try:
                result = await sel.one(
                    "two-papers", repeat, args, validate, model, detections
                )
            except Exception as exc:  # A run that fails is a finding; the rest go on.
                print(f"FAILED {path.name}: {type(exc).__name__}"[:200], flush=True)
                path.with_suffix(".failed").write_text(repr(exc))
                continue
            state = sel.STATE.get()
            result["boxes"] = getattr(state, "boxes", [])
            result["recorded_calls"] = getattr(state, "recorded", [])
            path.write_text(json.dumps(result, ensure_ascii=False))
            print(
                f"{path.name}: {result['seconds']} s, ${result['billed_usd']:.4f}, "
                f"{len(result['questions'])} questions, total ${sel.LIVE['usd']:.4f}",
                flush=True,
            )
    finally:
        spend.write_text(json.dumps({"usd": round(sel.LIVE["usd"], 5)}))


def box_papers(boxes: list[dict]) -> dict[int, int]:
    """Each box's paper, 0 or 1: boxes run in page order, so the page falling starts the
    second paper."""
    paper, last, out = 0, 0, {}
    for box in boxes:
        if box["page"] < last:
            paper = 1
        last = box["page"]
        out[box["box"]] = paper
    return out


def label_paper(label: str) -> int | None:
    """The paper a map label names: the map adds its own prefix, A or B in every run so far."""
    match = re.match(r"([AB])\d", label)
    return "AB".index(match.group(1)) if match else None


def boxes_of(figures: object) -> list[int]:
    return [
        box
        for figure in (figures if isinstance(figures, list) else [])
        for box in (figure.get("boxes") or [] if isinstance(figure, dict) else [])
    ]


def printed_numbers(refs: str) -> list[list[int]]:
    """The question numbers each paper prints at a line's start on the picked pages."""
    import pymupdf

    out = []
    for paper in PAPERS:
        with pymupdf.open(Path(refs) / sel.MATHS / f"{paper}.pdf") as doc:
            text = "\n".join(doc[n - 1].get_text() for n in PAGES)
        out.append(sorted({int(n) for n in re.findall(r"(?m)^\s*(\d{1,2})\.\s*", text)}))
    return out


def score(args) -> None:
    truth = printed_numbers(args.refs)
    print(f"printed: paper A {len(truth[0])} questions, paper B {len(truth[1])}")
    for path in sorted(OUT.glob("two-papers-*.json")):
        run = json.loads(path.read_text())
        report = run["report"]
        papers = box_papers(run["boxes"])
        calls = run["recorded_calls"]
        counts = collections.Counter(call["label"] for call in calls)
        named = [label_paper(label) for label in report["expected"]]
        crossed, unknown, boxed = 0, 0, 0
        wrong_number = [
            label
            for label in report["expected"]
            if label_paper(label) is None
            or int(re.sub(r"\D", "", label) or 0) not in truth[label_paper(label)]
        ]
        for call in calls:
            owner = label_paper(call["label"])
            for box in boxes_of(call["figures"]):
                if box not in papers:
                    continue
                boxed += 1
                if owner is None:
                    unknown += 1
                elif papers[box] != owner:
                    crossed += 1
        print(
            f"{path.name}: map {len(report['expected'])} "
            f"(paper A {named.count(0)}, B {named.count(1)}, neither {named.count(None)}), "
            f"saved {len(run['questions'])}, missing {len(report['missing'])}, "
            f"copied twice {sum(n > 1 for n in counts.values())}, "
            f"calls with no paper in the label "
            f"{sum(label_paper(call['label']) is None for call in calls)} of {len(calls)}; "
            f"boxes used {boxed} of {len(papers)}, other paper's {crossed}, unknown {unknown}; "
            f"labels not printed in their paper {len(wrong_number)}; "
            f"${run['billed_usd']:.4f}, {run['seconds']} s"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    go = commands.add_parser("run")
    go.add_argument("--refs", required=True)
    go.add_argument("--detections", nargs="+", required=True)
    go.add_argument("--env-file", required=True)
    go.add_argument("--runs", type=int, default=3)
    go.add_argument("--hard-stop", type=float, default=0.6)
    grade = commands.add_parser("score")
    grade.add_argument("--refs", required=True)
    args = parser.parse_args()
    if args.command == "run":
        asyncio.run(run_all(args))
    else:
        score(args)


if __name__ == "__main__":
    main()
