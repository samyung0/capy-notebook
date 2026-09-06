"""Resumable local model screening using the production quiz-grading prompt."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import socket
import statistics
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "grading-benchmark"
PROMPT_FILE = ROOT / "pipeline/pipeline/prompts/quiz.py"
spec = importlib.util.spec_from_file_location("capy_quiz_grade", PROMPT_FILE)
assert spec and spec.loader
grade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(grade)

SETTINGS = {"n_ctx": 1024, "max_tokens": 80, "temperature": 0.1, "seed": 20260905,
            "chat_template_kwargs": {"enable_thinking": False}, "cache_prompt": False}
MODELS = {
    "bonsai-1.7b-q1": "prism-ml--Bonsai-1.7B-gguf/Bonsai-1.7B-Q1_0.gguf",
    "bonsai-4b-q1": "prism-ml--Bonsai-4B-gguf/Bonsai-4B-Q1_0.gguf",
    "qwen3.5-2b-q4": "unsloth--Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf",
    "gemma4-e2b-q4": "unsloth--gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf",
    "lfm2.5-1.2b-q4": "LiquidAI--LFM2.5-1.2B-Instruct-GGUF/LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
    "engsaf-qwen2.5-1.5b-q4": "engsaf/Qwen2.5-1.5B-Instruct-EngSaf-211K-Q4_K_M.gguf",
}
LANGUAGES = {"en", "es", "fr", "ja", "ko", "zh-Hans", "zh-Hant"}


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def check_batch(rows: list[dict], configuration: dict, batch: str) -> None:
    configuration_id = digest(configuration)
    if any(digest(row["config"]) == configuration_id and row.get("batch") != batch for row in rows):
        raise ValueError("Use a separate output file when changing dataset coverage or case order with the same configuration")


def read_results(path: Path, *, repair_tail: bool = False) -> list[dict]:
    """Preserve an interrupted final write before repairing an append-only run."""
    if not path.exists():
        return []
    data = path.read_bytes()
    rows = []
    offset = 0
    lines = data.splitlines(keepends=True)
    for index, line in enumerate(lines):
        try:
            rows.append(json.loads(line))
        except (ValueError, UnicodeError):
            if index != len(lines) - 1 or line.endswith(b"\n"):
                raise ValueError(f"Invalid result record: {path}:{index + 1}") from None
            print(f"Interrupted final record in {path}; {len(line)} bytes excluded", flush=True)
            if repair_tail:
                backup = path.with_name(path.name + f".interrupted-{time.time_ns()}")
                backup.write_bytes(line)
                with path.open("r+b") as out:
                    out.truncate(offset)
            return rows
        offset += len(line)
    if repair_tail and data and not data.endswith(b"\n"):
        with path.open("ab") as out:
            out.write(b"\n")
    return rows


def read_cases(path: Path) -> list[dict]:
    """Expand authored question records, preserving family and label provenance."""
    cases = []
    ids: set[str] = set()
    splits: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        question = json.loads(line)
        assert question["language"] in LANGUAGES, question["id"]
        assert question["rubrics"] and question["model_answer"].strip(), question["id"]
        family = question["family"]
        assert splits.setdefault(family, question["split"]) == question["split"], "Family split leakage"
        assert question["label_source"] in {"codex-authored", "codex-reviewed", "human-reviewed"}
        for index, answer in enumerate(question["answers"]):
            case = {k: v for k, v in question.items() if k != "answers"}
            case["id"] = f"{question['id']}:{index}"
            assert case["id"] not in ids, "Duplicate case id"
            ids.add(case["id"])
            assert type(answer["score"]) in {int, float} and answer["score"] in {0, 0.5, 1}
            assert answer["text"].strip() and answer["rationale"].strip()
            case.update(user_answer=answer["text"], expected=answer["score"],
                        expected_reason=answer["rationale"], answer_kind=answer["kind"])
            if "label_exception_review" in answer:
                case["label_exception_review"] = answer["label_exception_review"]
            case["label_ambiguous"] = answer.get("ambiguous", False)
            case["grade_prompt"] = grade.build_grade_prompt(
                prompt=case["prompt"], hints=case.get("hints", []), rubrics=case["rubrics"],
                model_answer=case["model_answer"], user_answer=case["user_answer"])
            case["case_sha256"] = digest(case)
            cases.append(case)
    assert cases, "Empty dataset"
    return cases


def parse_output(text: str) -> dict:
    """Keep format/score failures distinct from a legitimate zero grade."""
    start, end = text.find("{"), text.rfind("}")
    try:
        raw = json.loads(text[start:end + 1]) if start >= 0 and end > start else None
    except ValueError:
        raw = None
    if not isinstance(raw, dict):
        return {"valid_score": False, "valid_output": False, "failure": "invalid_json", "score": None}
    score = raw.get("score")
    valid = type(score) in {int, float} and score in {0, 0.5, 1}
    reason = raw.get("reason")
    has_reason = isinstance(reason, str) and bool(reason.strip())
    return {"valid_score": valid, "valid_output": valid and has_reason,
            "strict_json": text.strip() == text[start:end + 1],
            "score": score if valid else None, "reason": reason if has_reason else None,
            "failure": None if valid and has_reason else "invalid_score" if not valid else "missing_reason"}


def request_json(url: str, body: dict | None = None, timeout: float = 180) -> dict:
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def run(args: argparse.Namespace) -> None:
    cases = read_cases(args.dataset)
    if args.shuffle_seed is not None:
        random.Random(args.shuffle_seed).shuffle(cases)
    if args.limit:
        cases = cases[:args.limit]
    settings = dict(SETTINGS, n_ctx=args.context, max_tokens=args.tokens, parallel=args.parallel)
    output = args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    provenance = {"settings": settings, "runtime": "llama.cpp-b10809-cuda12.4-native",
                  "case_order_seed": args.shuffle_seed,
                  "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  "prompt_sha256": hashlib.sha256(PROMPT_FILE.read_bytes()).hexdigest()}
    old = read_results(output, repair_tail=True)
    for suffix in (".manifest.jsonl", ".events.jsonl", ".failures.jsonl"):
        read_results(output.with_suffix(suffix), repair_tail=True)
    completed = {r["run_key"] for r in old if r.get("run_key")}
    executable = next((DATA / "llama.cpp/b10809").rglob("llama-server.exe"))
    for model in args.models:
        path = DATA / "models" / MODELS[model]
        if not path.is_file():
            print(f"Unavailable model artifact: {model}", flush=True)
            with output.with_suffix(".failures.jsonl").open("a", encoding="utf-8") as failures:
                failures.write(json.dumps({"model": model, "error": "missing_model_artifact",
                                           "expected_cases": len(cases)}) + "\n")
            continue
        source_path = path.with_suffix(path.suffix + ".source.json")
        source = json.loads(source_path.read_text(encoding="utf-8"))
        run_config = dict(provenance, model=model, model_source=source)
        batch = digest({"config": run_config, "cases": [c["case_sha256"] for c in cases]})
        check_batch(old, run_config, batch)
        with output.with_suffix(".manifest.jsonl").open("a", encoding="utf-8") as manifest:
            manifest.write(json.dumps({"batch": batch, "config": run_config,
                                       "dataset": str(args.dataset), "expected_cases": len(cases),
                                       "case_hashes": [c["case_sha256"] for c in cases]}) + "\n")
        pending = [(c, digest({"case": c["case_sha256"], "config": run_config})) for c in cases]
        pending = [(c, key) for c, key in pending if key not in completed]
        if not pending:
            continue
        log_path = output.parent / (output.stem + "." + model + ".server.log")
        command = [str(executable), "--model", str(path), "--host", "127.0.0.1", "--port", str(args.port),
                   "--ctx-size", str(args.context * args.parallel), "--parallel", str(args.parallel), "--n-gpu-layers", "99",
                   "--threads", "4", "--jinja", "--no-webui"]
        print(f"Loading {model}; {len(pending)} pending cases", flush=True)
        try:
            occupied = socket.create_connection(("127.0.0.1", args.port), timeout=5)
        except ConnectionRefusedError:
            pass
        else:
            occupied.close()
            raise RuntimeError(f"Port {args.port} is already in use; refusing to risk grading with another server")
        started = time.perf_counter()
        with log_path.open("w", encoding="utf-8") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                url = f"http://127.0.0.1:{args.port}"
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError(f"Model exited with {process.returncode}; see {log_path}")
                    try:
                        if request_json(url + "/health", timeout=2).get("status") == "ok":
                            break
                    except (OSError, ValueError):
                        time.sleep(0.5)
                else:
                    raise TimeoutError("Model load timed out")
                loaded = time.perf_counter() - started
                grading_started = time.perf_counter()
                def execute(pair):
                    case, key = pair
                    start = time.perf_counter()
                    body = {k: v for k, v in settings.items() if k not in {"n_ctx", "parallel"}}
                    body["messages"] = [{"role": "system", "content": grade.GRADE_SYSTEM},
                                        {"role": "user", "content": case["grade_prompt"]}]
                    record = {"run_key": key, "case_id": case["id"], "case_sha256": case["case_sha256"],
                              "family": case["family"], "language": case["language"], "domain": case["domain"],
                              "split": case["split"], "expected": case["expected"], "label_source": case["label_source"],
                              "answer_kind": case["answer_kind"], "config": run_config, "load_seconds": loaded,
                              "label_ambiguous": case["label_ambiguous"],
                              "source_kind": case.get("source_kind", "unspecified"),
                              "matched_across_languages": case.get("matched_across_languages", False),
                              "challenge": case.get("challenge", "core"),
                              "answer_language": case.get("answer_language", case["language"]),
                              "batch": batch,
                              "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                    try:
                        response = request_json(url + "/v1/chat/completions", body)
                        text = response["choices"][0]["message"].get("content") or ""
                        record.update(parse_output(text), raw=text, response=response)
                    except urllib.error.HTTPError as exc:
                        record.update(valid_score=False, valid_output=False, score=None, failure="inference_error",
                                      error=str(exc), error_status=exc.code,
                                      error_body=exc.read(65536).decode("utf-8", errors="replace"))
                    except (OSError, ValueError, KeyError, IndexError) as exc:
                        record.update(valid_score=False, valid_output=False, score=None, failure="inference_error", error=str(exc))
                    record["seconds"] = time.perf_counter() - start
                    return record

                with output.open("a", encoding="utf-8") as out, ThreadPoolExecutor(max_workers=args.parallel) as pool:
                    for i, record in enumerate(pool.map(execute, pending), 1):
                        out.write(json.dumps(record, ensure_ascii=False) + "\n")
                        out.flush()
                        if i % (100 if len(pending) > 100 else 10) == 0 or i == len(pending):
                            print(f"{model}: {i}/{len(pending)}; last={record['seconds']:.2f}s", flush=True)
                with output.with_suffix(".events.jsonl").open("a", encoding="utf-8") as events:
                    events.write(json.dumps({"type": "native_model_finished", "model": model, "batch": batch,
                                             "cases": len(pending), "grading_seconds": time.perf_counter() - grading_started,
                                             "load_seconds": loaded}) + "\n")
            except (OSError, RuntimeError, TimeoutError) as exc:
                with output.with_suffix(".failures.jsonl").open("a", encoding="utf-8") as failures:
                    failures.write(json.dumps({"model": model, "error": str(exc), "config": run_config,
                                               "batch": batch, "expected_cases": len(cases)}) + "\n")
                print(str(exc), flush=True)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    report(output)


def metrics(group: list[dict]) -> dict:
    valid = [r for r in group if r["valid_score"]]
    labels = Counter(r["expected"] for r in group)
    f1, recalls = [], []
    for label in (0, 0.5, 1):
        tp = sum(r["score"] == label and r["expected"] == label for r in valid)
        fp = sum(r["score"] == label and r["expected"] != label for r in valid)
        fn = labels[label] - tp
        f1.append(2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0)
        if labels[label]:
            recalls.append(tp / labels[label])
    seconds = sorted(r["seconds"] for r in group)
    return {"cases": len(group), "families": len({r["family"] for r in group}),
            "agreement": sum(r["score"] == r["expected"] for r in valid) / len(group),
            "valid_output_agreement": sum(r["valid_output"] and r["score"] == r["expected"] for r in group) / len(group),
            "majority_baseline": max(labels.values()) / len(group), "expected_distribution": dict(labels),
            "macro_f1": statistics.mean(f1), "balanced_accuracy": statistics.mean(recalls),
            "invalid_outputs": sum(not r["valid_output"] for r in group),
            "non_strict_json": sum(not r.get("strict_json", False) for r in group),
            "truncated": sum(r.get("response", {}).get("choices", [{}])[0].get("finish_reason") == "length" for r in group),
            "overgraded": sum(r["score"] > r["expected"] for r in valid),
            "undergraded": sum(r["score"] < r["expected"] for r in valid),
            "mae_valid_scores": statistics.mean(abs(r["score"] - r["expected"]) for r in valid) if valid else None,
            "median_seconds": statistics.median(seconds), "p95_seconds": seconds[max(0, (95 * len(seconds) + 99) // 100 - 1)],
            "label_sources": dict(Counter(r["label_source"] for r in group)),
            "failures": dict(Counter(r["failure"] for r in group if r.get("failure")))}


def family_interval(group: list[dict]) -> list[float]:
    """Resample source families, keeping translations and answer variants together."""
    families = defaultdict(list)
    for row in group:
        families[row["family"]].append(row)
    blocks = [(sum(r["valid_score"] and r["score"] == r["expected"] for r in rows), len(rows))
              for rows in families.values()]
    rng = random.Random(20260905)
    estimates = []
    for _ in range(1000):
        sample = rng.choices(blocks, k=len(blocks))
        estimates.append(sum(x[0] for x in sample) / sum(x[1] for x in sample))
    estimates.sort()
    return [estimates[24], estimates[974]]


def report(path: Path) -> None:
    rows = read_results(path)
    seen = {}
    unique = []
    for row in rows:
        key = (digest(row["config"]), row.get("batch", "legacy"), row["case_id"])
        if key in seen:
            if seen[key]["case_sha256"] != row["case_sha256"]:
                raise ValueError("Revised cases mixed in a legacy run. Report the separate original files.")
            continue
        seen[key] = row
        unique.append(row)
    groups: dict[tuple, list] = defaultdict(list)
    for row in unique:
        config = digest(row["config"])
        batch = row.get("batch", "legacy")
        for language, domain in {("all", "all"), (row["language"], "all"), ("all", row["domain"]),
                                 (row["language"], row["domain"])}:
            groups[(config, batch, language, domain, "all")].append(row)
        groups[(config, batch, "all", "all", row["answer_kind"])].append(row)
        if row["answer_kind"] != "reference_anchor":
            groups[(config, batch, "all", "all", "without_reference_anchors")].append(row)
            if not row.get("label_ambiguous", False):
                for language, domain in {("all", "all"), (row["language"], "all"), ("all", row["domain"]),
                                         (row["language"], row["domain"])}:
                    groups[(config, batch, language, domain, "primary")].append(row)
                    if row.get("matched_across_languages"):
                        groups[(config, batch, language, domain, "primary_matched")].append(row)
                    if row.get("source_kind") == "native":
                        groups[(config, batch, language, domain, "primary_native")].append(row)
        if row.get("label_ambiguous", False):
            groups[(config, batch, "all", "all", "ambiguous_labels")].append(row)
        if row.get("challenge", "core") != "core":
            groups[(config, batch, "all", "all", "challenge_" + row["challenge"])].append(row)
            groups[(config, batch, row["language"], "all", "challenge_" + row["challenge"])].append(row)
    summary = []
    for (config, batch, language, domain, kind), group in sorted(groups.items()):
        result = {"model": group[0]["config"]["model"], "config_id": config, "batch": batch,
                  "language": language, "domain": domain, "answer_kind": kind, **metrics(group)}
        if language == domain == "all" and kind in {"all", "without_reference_anchors", "primary", "primary_matched", "primary_native"}:
            result["family_bootstrap_95"] = family_interval(group)
        summary.append(result)
    path.with_suffix(".summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    manifests = {r["batch"]: r for r in read_results(path.with_suffix(".manifest.jsonl"))}
    observed = defaultdict(set)
    for row in unique:
        observed[digest(row["config"])].add(row["case_sha256"])
    coverage = [{"batch": batch, "model": entry["config"]["model"], "expected_cases": entry["expected_cases"],
                 "observed_cases": len(observed[digest(entry["config"])] & set(entry["case_hashes"]))}
                for batch, entry in manifests.items()]
    audit = {"duplicate_rows_excluded": len(rows) - len(unique), "coverage": coverage,
             "model_failures": read_results(path.with_suffix(".failures.jsonl")),
             "events": read_results(path.with_suffix(".events.jsonl"))}
    path.with_suffix(".audit.json").write_text(json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps([s for s in summary if s["language"] == s["domain"] == s["answer_kind"] == "all"], indent=2), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    runner = sub.add_parser("run")
    runner.add_argument("--dataset", type=Path, required=True)
    runner.add_argument("--output", type=Path, required=True)
    runner.add_argument("--models", choices=MODELS, nargs="+", required=True)
    runner.add_argument("--limit", type=int)
    runner.add_argument("--shuffle-seed", type=int, help="Deterministically mix domains and languages before any limit")
    runner.add_argument("--context", type=int, default=1024)
    runner.add_argument("--tokens", type=int, default=80)
    runner.add_argument("--port", type=int, default=18891)
    runner.add_argument("--parallel", type=int, choices=range(1, 33), default=1,
                        help="Concurrent grading requests; use 1 for individual-request latency measurements")
    summary = sub.add_parser("report")
    summary.add_argument("path", type=Path)
    validate = sub.add_parser("validate")
    validate.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "run":
        run(args)
    elif args.command == "report":
        report(args.path)
    else:
        cases = read_cases(args.path)
        print(json.dumps({"cases": len(cases), "coverage": dict(Counter(f"{c['language']}/{c['domain']}" for c in cases))}, indent=2))


if __name__ == "__main__":
    main()
