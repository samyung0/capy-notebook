"""Typed answers four parts to a call against one a call (Epo 2026-11-23:
"test first, small test should be enough, assignment only").

    python bench/grading/scripts/online_batching.py <env file> <out dir>

The production prompt and code are read from pipeline/pipeline/retrieval/
grading.py (its SYSTEM_PROMPT, user message, working test and reply decoding),
so the one-a-call mode is what assignment marking sends today. The batch mode
adds BATCH_SECTION (drafted, not yet approved) and sends four parts of
different questions in <parts>, as one student's answers to an assignment.
Thinking parts (working) batch apart from plain ones, as production would.

The sample is fixed: the 20 LaTeX working parts, and 48 written parts from the
contract, held-out, zh-Hant and injection sets. Copy-check cases are left out
(code scores them before any call in both modes). The model is the grading pin
on its production route. Four workers, no retries; keys are read from the env
file and never written. Raw replies go to <out dir>/rows.jsonl.
"""

from __future__ import annotations

import ast
import json
import random
import re
import statistics
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
import deepseek_grading as dg  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
GRADING = ROOT / "pipeline/pipeline/retrieval/grading.py"
MODEL = "deepseek/deepseek-v4.1-flash-1017"
ROUTE = {"order": ["wafer/us", "InferenceNet", "Cloudflare"], "allow_fallbacks": False}
BATCH = 4
SEED = 20261123

BATCH_SECTION = """

Several parts: this time you mark every part listed in <parts> at once. Each <part> holds its own <question>, <marking_items> and <student_answer> or drawing. Everything above applies to each part on its own.
- Mark each part only on its own answer; what the student wrote for one part earns nothing in another.
Reply with JSON only, one entry per part in the given order: {"parts": [{"part": "p1", "steps": [], "vocabulary_only": false, "injection_suspected": false, "comment": "", "items": [{"id": "m0", "quote": "", "reason": "", "choice": "full"}]}]}"""

_KEEP = {
    "SYSTEM_PROMPT", "_MAX_TOKENS", "_TIMEOUT_S", "_SHARES", "_COMMENT_MAX", "_WORKING",
    "_TAG", "_NOT_WORD", "_LATEX_COMMAND", "_COPY_RUN", "_COPY_SHARE", "_CJK", "_TOKEN",
    "_COPIED_COMMENT", "_INSTRUCTIONS_COMMENT", "_language", "has_working", "_copy_tokens",
    "_copied_share", "_escape", "_loose", "_question_and_items", "user_message", "decode",
}


class ProviderError(Exception):
    pass


def production() -> dict[str, Any]:
    """grading.py's prompt and pure functions, run here without the pipeline."""
    tree = ast.parse(GRADING.read_text(encoding="utf-8"))
    nodes = []
    for node in tree.body:
        names = (
            [node.name] if isinstance(node, ast.FunctionDef)
            else [t.id for t in node.targets if isinstance(t, ast.Name)] if isinstance(node, ast.Assign)
            else [node.target.id] if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
            else []
        )
        if _KEEP & set(names):
            nodes.append(node)
    space: dict[str, Any] = {
        "re": re, "unicodedata": unicodedata, "json": json, "Any": Any,
        "elitellm": type("elitellm", (), {"ProviderError": ProviderError}),
    }
    exec(compile(ast.Module(nodes, []), str(GRADING), "exec"), space)  # noqa: S102
    return space


P = production()


def sample() -> tuple[list[dict], list[dict]]:
    rnd = random.Random(SEED)
    thinking = dg.load_cases(["latex"])
    plain: list[dict] = []
    for name, n in (("contract", 16), ("heldout_pc", 8), ("heldout_rubric", 8), ("zh_hant", 8), ("injection", 8)):
        pool = [
            c for c in dg.load_cases([name])
            if P["_copied_share"](c["question"], c["answer"]) < P["_COPY_SHARE"]
        ]
        plain += rnd.sample(pool, n)
    assert all(P["has_working"](c["question"], c["items"]) for c in thinking)
    assert not any(P["has_working"](c["question"], c["items"]) for c in plain)
    return thinking, plain


def batches(cases: list[dict]) -> list[list[dict]]:
    """Four at a time, each from a different question where the pool allows."""
    rnd = random.Random(SEED)
    left = cases[:]
    rnd.shuffle(left)
    out = []
    while left:
        batch: list[dict] = []
        for case in left[:]:
            if len(batch) < BATCH and case["question_id"] not in {c["question_id"] for c in batch}:
                batch.append(case)
                left.remove(case)
        while len(batch) < BATCH and left:
            batch.append(left.pop())
        out.append(batch)
    return out


def items_of(case):
    return [{"text": i["text"], "marks": i["marks"]} for i in case["items"]]


def body(system: str, user: Any, kind: str, parts: int) -> dict[str, Any]:
    out: dict[str, Any] = {
        "model": MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "max_tokens": min(P["_MAX_TOKENS"][kind] * parts, 32000),
        "provider": ROUTE,
        "usage": {"include": True},
    }
    if kind == "plain":
        out.update(reasoning={"enabled": False}, temperature=0)
    else:
        out.update(reasoning={"effort": "low"})
    return out


def batch_message(batch: list[dict]) -> str:
    blocks = "\n\n".join(
        f'<part id="p{n}">\n{P["user_message"](c["question"], items_of(c), c["answer"])}\n</part>'
        for n, c in enumerate(batch, 1)
    )
    return f"<parts>\n{blocks}\n</parts>"


def call(key: str, payload: dict[str, Any]) -> tuple[dict | None, str, float]:
    start = time.monotonic()
    try:
        status, raw = dg.post("openrouter.ai", "/api/v1/chat/completions", key, payload)
    except Exception as error:  # noqa: BLE001 - a failure is a row, never a retry
        return None, f"{type(error).__name__}: {error}", time.monotonic() - start
    seconds = time.monotonic() - start
    if status != 200:
        return None, f"HTTP {status}: {raw[:300]!r}", seconds
    return json.loads(raw), "", seconds


def shares(content: str, case: dict) -> list[float]:
    return P["decode"](content, items_of(case), case["answer"])["shares"]


def run_single(key: str, case: dict, kind: str) -> dict:
    payload = body(
        P["SYSTEM_PROMPT"],
        P["user_message"](case["question"], items_of(case), case["answer"]),
        kind, 1,
    )
    reply, error, seconds = call(key, payload)
    row = {"mode": "single", "kind": kind, "cases": [case["case_id"]], "seconds": seconds, "error": error}
    if reply:
        row["usage"] = reply.get("usage")
        content = reply["choices"][0]["message"].get("content")
        row["content"] = content
        try:
            row["shares"] = {case["case_id"]: shares(content, case)}
        except ProviderError as exc:
            row["error"] = str(exc)
    return row


def run_batch(key: str, batch: list[dict], kind: str) -> dict:
    payload = body(P["SYSTEM_PROMPT"] + BATCH_SECTION, batch_message(batch), kind, len(batch))
    reply, error, seconds = call(key, payload)
    row = {"mode": "batch", "kind": kind, "cases": [c["case_id"] for c in batch], "seconds": seconds, "error": error}
    if reply:
        row["usage"] = reply.get("usage")
        content = reply["choices"][0]["message"].get("content")
        row["content"] = content
        row["shares"] = {}
        try:
            entries = {str(e.get("part")): e for e in json.loads(content).get("parts", []) if isinstance(e, dict)}
        except (TypeError, json.JSONDecodeError, AttributeError):
            row["error"] = "the batch reply is not JSON with parts"
            return row
        for n, case in enumerate(batch, 1):
            entry = entries.get(f"p{n}")
            try:
                if entry is None:
                    raise ProviderError("missing part")
                row["shares"][case["case_id"]] = shares(json.dumps(entry), case)
            except ProviderError as exc:
                row.setdefault("part_errors", {})[case["case_id"]] = str(exc)
    return row


def summary(rows: list[dict], cases: dict[str, dict]) -> dict:
    out = {}
    for mode in ("single", "batch"):
        got: dict[str, list[float]] = {}
        for row in rows:
            if row["mode"] == mode:
                got.update(row.get("shares", {}))
        items = matched = 0
        unearned = missed = 0.0
        for cid, case in cases.items():
            values = got.get(cid)
            for i, item in enumerate(case["items"]):
                items += 1
                if values is None:
                    continue
                matched += values[i] == item["gold"]
                diff = (values[i] - item["gold"]) * item["marks"]
                unearned += max(diff, 0)
                missed += max(-diff, 0)
        mine = [r for r in rows if r["mode"] == mode]
        usage = [r.get("usage") or {} for r in mine]
        out[mode] = {
            "calls": len(mine),
            "failed_calls": sum(1 for r in mine if r.get("error")),
            "parts_graded": sum(1 for cid in cases if cid in got),
            "items": items,
            "items_matched": matched,
            "unearned_marks": unearned,
            "missed_marks": missed,
            "prompt_tokens": sum(u.get("prompt_tokens", 0) for u in usage),
            "completion_tokens": sum(u.get("completion_tokens", 0) for u in usage),
            "cost_usd": round(sum(u.get("cost", 0) or 0 for u in usage), 5),
            "seconds_median": round(statistics.median([r["seconds"] for r in mine]), 1),
            "seconds_max": round(max(r["seconds"] for r in mine), 1),
            "by_kind": {
                kind: round(statistics.median([r["seconds"] for r in mine if r["kind"] == kind]), 1)
                for kind in ("plain", "thinking")
            },
        }
    single = {k: v for r in rows if r["mode"] == "single" for k, v in r.get("shares", {}).items()}
    batch = {k: v for r in rows if r["mode"] == "batch" for k, v in r.get("shares", {}).items()}
    both = [cid for cid in cases if cid in single and cid in batch]
    out["agreement"] = {
        "parts_in_both": len(both),
        "items_same": sum(a == b for cid in both for a, b in zip(single[cid], batch[cid])),
        "items_in_both": sum(len(single[cid]) for cid in both),
        "parts_differing": [cid for cid in both if single[cid] != batch[cid]],
    }
    return out


def main() -> None:
    env_file, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    key = dg.load_env(env_file).get("OPENROUTER_API_KEY", "")
    if not key:
        raise SystemExit(f"No OPENROUTER_API_KEY in {env_file}")
    # One connection timeout for every call: the thinking limit (180 s).
    dg.TIMEOUT_S = P["_TIMEOUT_S"]["thinking"]
    thinking, plain = sample()
    cases = {c["case_id"]: c for c in thinking + plain}
    jobs = [("single", [c], "thinking") for c in thinking] + [("single", [c], "plain") for c in plain]
    jobs += [("batch", b, "thinking") for b in batches(thinking)] + [("batch", b, "plain") for b in batches(plain)]
    out_dir.mkdir(parents=True, exist_ok=True)

    def one(job):
        mode, batch, kind = job
        return run_single(key, batch[0], kind) if mode == "single" else run_batch(key, batch, kind)

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(one, jobs))
    with (out_dir / "rows.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    result = summary(rows, cases)
    (out_dir / "summary.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
