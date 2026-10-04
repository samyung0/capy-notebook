"""Paired Jev question-context ablation on exactly 96 archived essay answers.

Uses only the standard library. --check is offline; live runs require a fresh
output directory and a credential from stdin or TYPESAFE_API_KEY. No retries.
"""

from __future__ import annotations

import argparse
import copy
import getpass
import hashlib
import http.client
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from typesafe_math import URL

ROOT = Path(__file__).resolve().parents[3]
MODEL = "jev-latest"
CLEF_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}"
# provider -> (endpoint, model). Clef speaks the same SystemOne shape on Workers AI,
# wrapped in Cloudflare's {"result": ...} envelope; {account} is filled at call time.
PROVIDERS = {
    "jev": (URL, MODEL),
    "clef": (CLEF_URL.format(account="{account}", model="clef"), "clef"),
    "clef-flash": (CLEF_URL.format(account="{account}", model="clef-flash"), "clef-flash"),
}
VARIANTS = ("with_question", "without_question")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def award(flags):
    return 1 if all(flags) else 0.5 if any(flags) else 0


def prepare(rows):
    essays = [
        row
        for row in rows
        if row["suite"] == "rubric" and row["baseline"]["set"] == "essay"
    ]
    if len(essays) != 96 or len({row["id"] for row in essays}) != 96:
        raise ValueError("Expected exactly 96 unique essay answers")
    jobs = []
    for row in essays:
        if (
            not row["truth"]
            or len(row["truth"]) != len(row["keys"])
            or set(row["keys"]) != set(row["questions"])
            or any(value not in (0, 1) for value in row["truth"])
        ):
            raise ValueError("Expected nonempty binary per-item gold and matching keys")
        for variant in VARIANTS:
            state = copy.deepcopy(row["state"])
            if variant == "without_question":
                del state["question"]
            jobs.append(
                {
                    "id": row["id"],
                    "variant": variant,
                    "domain": row["baseline"]["domain"],
                    "label": row["baseline"]["label"],
                    "state": state,
                    "questions": copy.deepcopy(row["questions"]),
                    "keys": row["keys"][:],
                    "truth": row["truth"][:],
                }
            )
    return jobs


def safe_response(value, key):
    """Preserve the JSON body while excluding header fields and secret echoes."""
    if isinstance(value, dict):
        return {
            name: safe_response(item, key)
            for name, item in value.items()
            if "header" not in name.lower()
            and name.lower() not in ("authorization", "api_key", "apikey")
        }
    if isinstance(value, list):
        return [safe_response(item, key) for item in value]
    if isinstance(value, str):
        return value.replace(key, "[redacted]")
    return value


def call(job, key, provider="jev", account=None):
    result = dict(job)
    start = time.perf_counter()
    url, model = PROVIDERS[provider]
    endpoint = urlsplit(url.format(account=account))
    connection = http.client.HTTPSConnection(endpoint.hostname, timeout=60)
    try:
        connection.request(
            "POST",
            endpoint.path,
            body=json.dumps(
                {"model": model, "state": job["state"], "questions": job["questions"]},
                ensure_ascii=False,
            ).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + key,
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        result["http_status"] = response.status
        # Fixtures have four answers per call; cap malformed response bodies.
        raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise ValueError("Response exceeded size limit")
        payload = json.loads(raw)
        if provider != "jev" and response.status == 200:
            payload = payload["result"]
        result["response"] = safe_response(payload, key)
        if response.status != 200:
            raise ValueError("Non-success HTTP status")
        if set(payload["answers"]) != set(job["questions"]):
            raise ValueError("Unexpected question ids")
        scores = [payload["answers"][name]["noul"] for name in job["keys"]]
        if not all(
            type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
            for value in scores
        ):
            raise ValueError("Invalid noul probability")
        result["scores"] = scores
        result["returned_model"] = safe_response(payload.get("model"), key)
        result["usage"] = safe_response(payload.get("usage"), key)
    except Exception as error:  # noqa: BLE001 - preserve failure, never retry.
        # Exception messages may embed request information. Save only their class.
        result["error"] = type(error).__name__
    finally:
        connection.close()
        result["latency_s"] = time.perf_counter() - start
    return result


def summarize(rows):
    report = {"threshold": 0.5, "variants": {}}
    for variant in VARIANTS:
        group = [row for row in rows if row["variant"] == variant]
        valid = [row for row in group if "scores" in row and "error" not in row]
        point_correct = sum(
            (score >= 0.5) == truth
            for row in valid
            for score, truth in zip(row["scores"], row["truth"])
        )
        report["variants"][variant] = {
            "requests": len(group),
            "failures": len(group) - len(valid),
            "point_correct": point_correct,
            "point_planned": sum(len(row["truth"]) for row in group),
            "point_valid": sum(len(row["truth"]) for row in valid),
            "aggregate_award_correct": sum(
                award([score >= 0.5 for score in row["scores"]]) == award(row["truth"])
                for row in valid
            ),
            "aggregate_award_planned": len(group),
            "aggregate_award_valid": len(valid),
        }
    by_id = {}
    for row in rows:
        by_id.setdefault(row["id"], {})[row["variant"]] = row
    changes = []
    paired = point_changes = award_changes = 0
    for identity, pair in by_id.items():
        if any(
            name not in pair or "scores" not in pair[name] or "error" in pair[name]
            for name in VARIANTS
        ):
            continue
        before, after = (pair[name] for name in VARIANTS)
        left, right = ([p >= 0.5 for p in row["scores"]] for row in (before, after))
        paired += 1
        point_changes += sum(a != b for a, b in zip(left, right))
        award_changes += award(left) != award(right)
        if left != right:
            changes.append(
                {
                    "id": identity,
                    "truth": before["truth"],
                    "with_question": left,
                    "without_question": right,
                }
            )
    report["paired"] = {
        "complete_pairs": paired,
        "incomplete_pairs": len(by_id) - paired,
        "point_decision_changes": point_changes,
        "aggregate_award_changes": award_changes,
        "changes": changes,
    }
    report["interpretation"] = (
        "AI-authored/reviewed binary item gold. Aggregate awards use all/some/none "
        "= 1/0.5/0. This does not measure item-level half-credit accuracy. "
        "Failures remain failures and count against planned-denominator agreement."
    )
    return report


def check():
    template = {
        "suite": "rubric",
        "baseline": {"set": "essay", "domain": "test", "label": "partial"},
        "state": {"question": "Why?", "user_answer": "A", "extra": ["kept"]},
        "questions": {"r0": {"type": "noul"}, "r1": {"type": "noul"}},
        "keys": ["r0", "r1"],
        "truth": [1, 0],
    }
    rows = [{**copy.deepcopy(template), "id": str(i)} for i in range(96)]
    original = copy.deepcopy(rows)
    jobs = prepare(rows)
    assert len(jobs) == 192 and rows == original
    assert jobs[0]["state"] == original[0]["state"]
    assert jobs[1]["state"] == {"user_answer": "A", "extra": ["kept"]}
    assert jobs[0]["questions"] == jobs[1]["questions"] == template["questions"]
    assert [award(x) for x in ([False, False], [True, False], [True, True])] == [
        0,
        0.5,
        1,
    ]
    result = summarize(
        [{**jobs[0], "scores": [0.9, 0.1]}, {**jobs[1], "error": "TimeoutError"}]
    )
    assert result["variants"]["with_question"]["aggregate_award_correct"] == 1
    assert result["variants"]["without_question"]["failures"] == 1
    assert result["variants"]["without_question"]["point_valid"] == 0
    assert result["paired"]["incomplete_pairs"] == 1
    changed = summarize(
        [{**jobs[0], "scores": [0.9, 0.1]}, {**jobs[1], "scores": [0.9, 0.8]}]
    )
    assert changed["paired"]["point_decision_changes"] == 1
    assert changed["paired"]["aggregate_award_changes"] == 1
    assert safe_response({"headers": {"x": "secret"}, "v": "secret"}, "secret") == {
        "v": "[redacted]"
    }
    print(
        "Offline check passed: 192 calls planned, immutable pairs, awards and failures verified."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--key-stdin", action="store_true")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT / "data/grading-benchmark/laya-20260927/requests.jsonl",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    args = parser.parse_args()
    if args.check:
        check()
        return 0
    if args.output is None:
        parser.error("--output must name a fresh directory")
    if args.output.exists():
        parser.error("Output already exists; choose a fresh directory")
    jobs = prepare(
        [
            json.loads(line)
            for line in args.dataset.read_text(encoding="utf-8").splitlines()
        ]
    )
    if args.key_stdin:
        key = (
            getpass.getpass("Jev key: ") if sys.stdin.isatty() else sys.stdin.readline()
        ).strip()
    else:
        key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        parser.error("Provide a credential through --key-stdin or TYPESAFE_API_KEY")
    args.output.mkdir(parents=True, exist_ok=False)
    manifest = {
        "model": MODEL,
        "endpoint": URL,
        "planned_calls": len(jobs),
        "workers": args.workers,
        "timeout_s": 60,
        "retries": 0,
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "dataset_sha256": digest(args.dataset),
        "runner_sha256": digest(Path(__file__)),
        "request_definitions_sha256": digest(
            Path(__file__).with_name("typesafe_math.py")
        ),
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    rows = []
    with (
        (args.output / "results.jsonl").open(
            "x", encoding="utf-8", buffering=1
        ) as handle,
        ThreadPoolExecutor(max_workers=args.workers) as pool,
    ):
        for result in pool.map(lambda job: call(job, key), jobs):
            rows.append(result)
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")
    report = summarize(rows)
    (args.output / "summary.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))
    return int(any("error" in row for row in rows))


if __name__ == "__main__":
    raise SystemExit(main())
