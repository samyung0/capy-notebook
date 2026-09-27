"""Replay the archived Jev requests on CPU Laya, with paired scores and resource logs.

prepare needs the six original typesafe-*.jsonl files, not a new hosted API run.
run needs the pinned Laya runtime and checkpoint. Run each configuration in a
fresh process; download weights before measuring load time. See the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import statistics
import time
from pathlib import Path


def read_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download(output, revision):
    from huggingface_hub import snapshot_download

    snapshot_download(
        "convaiinnovations/laya",
        revision=revision,
        local_dir=output,
        allow_patterns=[
            prefix + name
            for prefix in ("", "multilingual/", "typed-decisions/")
            for name in (
                "rl_agent_config.json",
                "model.safetensors",
                "encoder/*",
                "tokenizer/*",
            )
        ],
        max_workers=2,
    )
    files = {
        str(p.relative_to(output)): {"bytes": p.stat().st_size, "sha256": digest(p)}
        for p in output.rglob("*")
        if p.is_file() and ".cache" not in p.parts
    }
    output.with_suffix(".manifest.json").write_text(
        json.dumps(
            {"repo": "convaiinnovations/laya", "revision": revision, "files": files},
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {"files": len(files), "bytes": sum(f["bytes"] for f in files.values())}
        )
    )


def award(flags):
    return 1 if all(flags) else 0.5 if any(flags) else 0


def prepare(baseline, output):
    import typesafe_math as jev

    jobs, sources = [], {}
    math_cases = json.loads(jev.FIXTURE.read_text(encoding="utf-8"))["cases"]
    by_case = {c["id"]: c for c in math_cases}
    for suite in ("rubric", "route", "math", "equiv", "units", "algebra"):
        path = baseline / f"typesafe-{suite}.jsonl"
        sources[str(path.name)] = digest(path)
        for i, row in enumerate(read_rows(path)):
            job = {"id": f"{suite}:{i}", "suite": suite, "baseline": row}
            if suite == "rubric":
                job.update(
                    state={"question": row["question"], "user_answer": row["text"]},
                    questions={
                        f"r{j}": jev.rubric_question(r)
                        for j, r in enumerate(row["rubrics"])
                    },
                    keys=[f"r{j}" for j in range(len(row["rubrics"]))],
                    truth=row["met"],
                    jev=row["noul"],
                )
            elif suite == "route":
                if row["cond"] != "q_only":
                    continue
                job.update(
                    state={"question": row["question"]},
                    questions=jev.ROUTE_QUESTIONS,
                    keys=["compute"],
                    truth=[row["compute"]],
                    jev=[row["compute_noul"]],
                )
            elif suite == "math":
                case = by_case[row["case"]]
                answer = next(a for a in case["answers"] if a["label"] == row["label"])
                state = {"question": case["question"], "user_answer": answer["text"]}
                if row["cond"] == "final_ref":
                    state["correct_answer"] = case["final"]
                elif row["cond"] == "with_ref":
                    state["correct_answer"] = case["reference"]
                job.update(
                    state=state,
                    questions=jev.QUESTIONS,
                    keys=["correct"],
                    truth=[row["expected"] == "correct"],
                    jev=[row["correct"]],
                )
            else:
                job.update(
                    state={
                        "question": row["question"],
                        "correct_answer": row["correct"],
                        "user_answer": row["user"],
                    },
                    questions=jev.ALGEBRA_QUESTIONS
                    if suite == "algebra"
                    else jev.EQUIV_QUESTIONS,
                    keys=["same"],
                    truth=[row["expected"] == "eq"],
                    jev=[row["same"]],
                )
            assert len(job["truth"]) == len(job["jev"]) == len(job["keys"])
            jobs.append(job)
    assert len({j["id"] for j in jobs}) == len(jobs)
    rubric = [j for j in jobs if j["suite"] == "rubric"]
    assert len(rubric) == 1688
    for group, exact in (("seed", 1544), ("essay", 86)):
        subset = [j for j in rubric if j["baseline"]["set"] == group]
        assert (
            sum(
                award(j["truth"]) == award([v >= 0.5 for v in j["jev"]]) for j in subset
            )
            == exact
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as handle:
        for job in jobs:
            handle.write(json.dumps(job, ensure_ascii=False) + "\n")
    sources["typesafe_math.py"] = digest(Path(jev.__file__))
    sources[jev.FIXTURE.name] = digest(jev.FIXTURE)
    output.with_suffix(".sources.json").write_text(json.dumps(sources, indent=2) + "\n")
    print(
        json.dumps(
            {
                s: sum(j["suite"] == s for j in jobs)
                for s in sorted({j["suite"] for j in jobs})
            }
        )
    )


def memory():
    """Linux process RSS and high-water mark, plus the transient unit's peak."""
    values = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        if line.split(":")[0] in ("VmRSS", "VmHWM", "VmSwap"):
            key, value = line.split(":")
            values[key + "_mib"] = int(value.split()[0]) / 1024
    group = Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1]
    for name in ("memory.peak", "memory.current", "cpu.stat", "memory.events"):
        path = Path("/sys/fs/cgroup") / group.lstrip("/") / name
        if path.exists():
            values[name] = path.read_text().strip()
    return values


def token_audit(agent, job):
    # Mirror the pinned runtime's packing to count lost state/instruction tokens.
    from laya.common import build_sequence, encode_text, render_options, serialize_state

    tok = agent.tok
    max_len, head_max = agent.cfg["max_len"], agent.cfg["head_max_len"]
    state_ids = encode_text(
        tok,
        serialize_state(job["state"]).replace(tok.mask_token, " "),
        add_special_tokens=False,
    )["input_ids"]
    audit = []
    for definition in job["questions"].values():
        internal = agent._to_internal(definition)
        empty, _ = build_sequence(tok, "", internal, max_len, head_max, state_ids=[])
        room = max_len - len(empty)
        options = [
            encode_text(
                tok, " " + o.replace(tok.mask_token, " "), add_special_tokens=False
            )["input_ids"]
            for o in render_options(internal)
        ]
        option_sizes = [min(48, len(o)) + 1 for o in options]
        budget = head_max - sum(option_sizes)
        if budget < 16:
            per = max(4, (head_max - 16) // len(option_sizes))
            budget = head_max - sum(min(per, n) for n in option_sizes)
        instruction = encode_text(
            tok,
            f"{internal['t']} question: {internal['ins']}".replace(tok.mask_token, " "),
            add_special_tokens=False,
        )["input_ids"]
        audit.append(
            {
                "sequence_tokens": len(empty) + min(room, len(state_ids)),
                "state_tokens_lost": max(0, len(state_ids) - room),
                "instruction_tokens_lost": max(0, len(instruction) - max(8, budget)),
                "option_tokens_lost": sum(max(0, len(o) - 48) for o in options),
            }
        )
    return audit


def select(jobs, suite, pilot, limit):
    if suite:
        jobs = [j for j in jobs if j["suite"] == suite]
    if pilot:
        families, selected = {}, []
        for job in jobs:
            row = job["baseline"]
            if job["suite"] != "rubric":
                continue
            if row["set"] == "seed":
                seen = families.setdefault(row["domain"], [])
                if row["question"] not in seen and len(seen) < 2:
                    seen.append(row["question"])
                if row["question"] not in seen:
                    continue
            selected.append(job)
        jobs = selected
    return jobs[:limit] if limit else jobs


def run(args):
    import importlib.metadata

    import torch
    from laya import Agent

    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    os.environ["LAYA_CPU_AMP"] = "bf16" if args.dtype == "bf16" else "off"
    jobs = select(read_rows(args.dataset), args.suite, args.pilot, args.limit)
    if args.opaque_labels:
        jobs = [
            {
                **job,
                "questions": {
                    key: {**question, "labels": {"false": "B", "true": "A"}}
                    if question["type"] == "noul"
                    else question
                    for key, question in job["questions"].items()
                },
            }
            for job in jobs
        ]
    if not jobs:
        raise ValueError("No requests selected")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", buffering=1) as handle:
        meta = {
            "type": "manifest",
            "model": args.model,
            "revision": args.revision,
            "threads": args.threads,
            "dtype": args.dtype,
            "opaque_labels": args.opaque_labels,
            "planned": len(jobs),
            "dataset_sha256": digest(args.dataset),
            "script_sha256": digest(Path(__file__)),
            "python": platform.python_version(),
            "host": platform.node(),
            "packages": {
                p: importlib.metadata.version(p)
                for p in ("torch", "transformers", "laya", "huggingface-hub")
            },
            "before_load": memory(),
        }
        start = time.perf_counter()
        agent = Agent(str(args.checkpoint), device="cpu")
        meta.update(
            load_s=time.perf_counter() - start,
            config=agent.cfg,
            after_load=memory(),
            parameters=sum(p.numel() for p in agent.model.parameters()),
            model_bytes=sum(
                p.numel() * p.element_size() for p in agent.model.parameters()
            ),
            checkpoint_bytes=sum(
                p.stat().st_size for p in args.checkpoint.rglob("*") if p.is_file()
            ),
        )
        first = time.perf_counter()
        agent.predict(jobs[0]["state"], jobs[0]["questions"])
        meta["first_inference_s"] = time.perf_counter() - first
        agent.predict(jobs[0]["state"], jobs[0]["questions"])
        handle.write(json.dumps(meta) + "\n")
        print(
            json.dumps(
                {
                    k: meta[k]
                    for k in (
                        "model",
                        "planned",
                        "load_s",
                        "first_inference_s",
                        "after_load",
                    )
                }
            ),
            flush=True,
        )
        for i, job in enumerate(jobs, 1):
            audit = token_audit(agent, job)
            start, cpu = time.perf_counter(), time.process_time()
            try:
                response = agent.predict(job["state"], job["questions"])
                elapsed, cpu_s = time.perf_counter() - start, time.process_time() - cpu
                scores = [response["answers"][k]["noul"] for k in job["keys"]]
                if not all(math.isfinite(v) and 0 <= v <= 1 for v in scores):
                    raise ValueError("Invalid probability")
                result = {
                    "type": "result",
                    "id": job["id"],
                    "scores": scores,
                    "response": response,
                    "latency_s": elapsed,
                    "cpu_s": cpu_s,
                    "tokens": audit,
                }
            except Exception as error:  # noqa: BLE001 - preserve failed requests as failures.
                result = {
                    "type": "result",
                    "id": job["id"],
                    "error": repr(error),
                    "latency_s": time.perf_counter() - start,
                    "tokens": audit,
                }
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")
            if i % 100 == 0:
                print(
                    json.dumps({"done": i, "total": len(jobs), "memory": memory()}),
                    flush=True,
                )
        handle.write(
            json.dumps({"type": "complete", "completed": len(jobs), "memory": memory()})
            + "\n"
        )


def metrics(pairs, threshold, source):
    valid = [(job, row) for job, row in pairs if source == "jev" or "error" not in row]
    errors = len(pairs) - len(valid)
    points = [
        (bool(t), v >= threshold)
        for job, row in valid
        for t, v in zip(
            job["truth"], job["jev"] if source == "jev" else row["scores"], strict=True
        )
    ]
    exact = sum(
        award(job["truth"])
        == award(
            [v >= threshold for v in (job["jev"] if source == "jev" else row["scores"])]
        )
        for job, row in valid
    )
    return {
        "n": len(pairs),
        "failures": errors,
        "award_exact": exact,
        "award_accuracy": exact / len(pairs),
        "points": len(points),
        "point_accuracy": sum(t == p for t, p in points) / len(points)
        if points
        else None,
        "met_missed": sum(t and not p for t, p in points),
        "met": sum(t for t, _ in points),
        "unmet_credited": sum(not t and p for t, p in points),
        "unmet": sum(not t for t, _ in points),
    }


def report(dataset, path, candidate_label="laya"):
    jobs = {j["id"]: j for j in read_rows(dataset)}
    records = read_rows(path)
    meta = records[0]
    assert meta["type"] == "manifest" and meta["dataset_sha256"] == digest(dataset)
    rows = [r for r in records if r["type"] == "result"]
    assert len({r["id"] for r in rows}) == len(rows)
    pairs = [(jobs[r["id"]], r) for r in rows]
    groups = {}
    for job, row in pairs:
        base = job["baseline"]
        group = job["suite"]
        if group == "rubric":
            group += "/" + base["set"]
        elif group == "math":
            group += "/" + base["cond"]
        if not base.get("arguable"):
            groups.setdefault(group, []).append((job, row))
            if job["suite"] == "rubric":
                groups.setdefault(group + "/domain/" + base["domain"], []).append(
                    (job, row)
                )
                groups.setdefault(group + "/label/" + base["label"], []).append(
                    (job, row)
                )
    summary = {
        "manifest": meta,
        "complete": records[-1]["type"] == "complete" and len(rows) == meta["planned"],
        "completed": len(rows),
        "groups": {},
    }
    for name, group in groups.items():
        summary["groups"][name] = {
            source: {
                str(t): metrics(group, t, source) for t in (0.3, 0.5, 0.6, 0.65, 0.7)
            }
            for source in ("jev", candidate_label)
        }
        valid = [r for _, r in group if "error" not in r]
        latency = sorted(r["latency_s"] for r in valid)
        summary["groups"][name]["performance"] = {
            "p50_s": statistics.median(latency) if latency else None,
            "p95_s": latency[max(0, math.ceil(0.95 * len(latency)) - 1)]
            if latency
            else None,
            "cpu_s_per_request": statistics.mean(r["cpu_s"] for r in valid)
            if valid and all("cpu_s" in r for r in valid)
            else None,
            "truncated_requests": sum(
                any(
                    t["state_tokens_lost"]
                    or t["instruction_tokens_lost"]
                    or t["option_tokens_lost"]
                    for t in r["tokens"]
                )
                for _, r in group
            )
            if all("tokens" in r for _, r in group)
            else None,
        }
    summary["final_memory"] = records[-1].get("memory")
    target = path.with_suffix(".summary.json")
    target.write_text(json.dumps(summary, indent=2) + "\n")
    print(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--baseline", type=Path, required=True)
    prep.add_argument("--output", type=Path, required=True)
    downloader = commands.add_parser("download")
    downloader.add_argument("--output", type=Path, required=True)
    downloader.add_argument("--revision", required=True)
    runner = commands.add_parser("run")
    runner.add_argument("--dataset", type=Path, required=True)
    runner.add_argument("--output", type=Path, required=True)
    runner.add_argument("--checkpoint", type=Path, required=True)
    runner.add_argument("--model", required=True)
    runner.add_argument("--revision", required=True)
    runner.add_argument("--threads", type=int, choices=(1, 2, 4, 8), required=True)
    runner.add_argument("--dtype", choices=("fp32", "bf16"), required=True)
    runner.add_argument(
        "--suite", choices=("rubric", "route", "math", "equiv", "units", "algebra")
    )
    runner.add_argument("--pilot", action="store_true")
    runner.add_argument("--opaque-labels", action="store_true")
    runner.add_argument("--limit", type=int)
    scorer = commands.add_parser("report")
    scorer.add_argument("--dataset", type=Path, required=True)
    scorer.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.baseline, args.output)
    elif args.command == "download":
        download(args.output, args.revision)
    elif args.command == "run":
        run(args)
    else:
        report(args.dataset, args.path)


if __name__ == "__main__":
    main()
