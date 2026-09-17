"""Native DeepSeek pilot adapter; immutable inputs and explicit retries only.

run(stage_directory, key, workers, retry_failed=False, timeout_seconds=120)
consumes the pilot's frozen Chat-schema input.jsonl/state.json. Native Responses
requests and raw receipts live in realtime/native; compatible validated results
live in realtime/results.json for knowledge_base_realtime.stage_results.
No Qwen output is inherited. Retry permission applies only to saved failed or
uncertain attempts; those receipts remain in native/attempts with their usage.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

from knowledge_base_batch import PilotError, digest, lock, read_json, save_json

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "bench/parsers/scripts"))
import compare_deepseek_recovery as native

TRANSPORT = "deepseek-responses"


def outcome(record, row):
    """Keep malformed provider bodies as explicit failures, with raw receipt intact."""
    try:
        return native.validate(record, row)
    except (KeyError, TypeError, AttributeError):
        return {"error": {"kind": "invalid_response_shape"}}


def token_metrics(record):
    body = (record.get("response") or {}).get("body")
    usage = body.get("usage") if isinstance(body, dict) else None
    usage = usage if isinstance(usage, dict) else {}
    inputs = usage.get("input_tokens_details") or {}
    outputs = usage.get("output_tokens_details") or {}
    values = {
        "prompt_tokens": usage.get("input_tokens"),
        "completion_tokens": usage.get("output_tokens"),
        "reasoning_tokens": outputs.get("reasoning_tokens")
        if isinstance(outputs, dict)
        else None,
        "cached_tokens": inputs.get("cached_tokens")
        if isinstance(inputs, dict)
        else None,
    }
    return {
        key: value if type(value) is int and value >= 0 else None
        for key, value in values.items()
    }


def publish(directory, rows, state, started):
    normal = directory / "realtime"
    destination = normal / "native"
    result = {"success": {}, "failed": {}, "missing": []}
    records = []
    for row in rows:
        request_id = row["custom_id"]
        path = destination / "records" / f"{digest(request_id)}.json"
        if not path.exists():
            result["missing"].append(request_id)
            continue
        record = read_json(path)
        records.append(record)
        value = outcome(record, row)
        metrics = token_metrics(record)
        value["usage"] = {
            key: tokens for key, tokens in metrics.items() if tokens is not None
        }
        body = (record.get("response") or {}).get("body")
        value["provider_usage"] = body.get("usage") if isinstance(body, dict) else None
        value["request_id"] = (record.get("response") or {}).get("request_id")
        value["source_request_sha256"] = row["source_request_sha256"]
        value["request_sha256"] = record["request_sha256"]
        result["failed" if "error" in value else "success"][request_id] = value
    save_json(normal / "results.json", result)
    attempts = records + [
        read_json(path) for path in (destination / "attempts").glob("*.json")
    ]
    usage = dict.fromkeys(
        ("prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_tokens")
    )
    reported = dict.fromkeys(usage, 0)
    missing = 0
    for record in attempts:
        metrics = token_metrics(record)
        missing += (
            metrics["prompt_tokens"] is None or metrics["completion_tokens"] is None
        )
        for key, value in metrics.items():
            if value is not None:
                usage[key] = (usage[key] or 0) + value
                reported[key] += 1
    complete = (
        not result["failed"]
        and not result["missing"]
        and not state.get("execution_error")
    )
    state.update(
        complete=complete,
        status="completed" if complete else "failed",
        finished_at=time.time(),
        collection={key: len(value) for key, value in result.items()},
        normal_requests=len(attempts),
        new_requests=sum(record["started_at"] >= started for record in records),
        usage=usage,
        usage_reported_attempts=reported,
        usage_missing_attempts=missing,
        reasoning_usage_records=reported["reasoning_tokens"],
        summed_request_seconds=sum(record.get("seconds", 0) for record in attempts),
        elapsed_seconds=time.time() - started,
    )
    save_json(normal / "state.json", state)
    return state


def run(
    directory: Path,
    key: str,
    workers: int,
    retry_failed=False,
    timeout_seconds=120,
    transport=None,
):
    if not key or type(workers) is not int or not 1 <= workers <= 8:
        raise PilotError(
            "DeepSeek needs a key and an explicit worker count from 1 to 8"
        )
    if not isinstance(timeout_seconds, (int, float)) or not 1 <= timeout_seconds <= 600:
        raise PilotError("DeepSeek timeout must be between 1 and 600 seconds")
    payload = (directory / "input.jsonl").read_bytes()
    source = read_json(directory / "state.json")
    if hashlib.sha256(payload).hexdigest() != source["input_sha256"]:
        raise PilotError("Frozen model input changed")
    original = [json.loads(line) for line in payload.splitlines() if line.strip()]
    expected = [row["custom_id"] for row in original]
    if (
        not expected
        or len(set(expected)) != len(expected)
        or expected != source["request_ids"]
    ):
        raise PilotError("Model input IDs differ from the frozen manifest")
    for row in original:
        if row.get("method") != "POST" or row.get("url") != "/v1/chat/completions":
            raise PilotError("Expected frozen pilot Chat-schema requests")
    rows = [native.convert(row, "schema") for row in original]
    normal = directory / "realtime"
    destination = normal / "native"
    identity = digest(
        {
            "source_sha256": source["input_sha256"],
            "requests": rows,
            "url": native.URL,
            "model": native.MODEL,
        }
    )
    with lock(normal / "command.lock"):
        state_path = normal / "state.json"
        previous = read_json(state_path) if state_path.exists() else None
        if previous and (
            previous.get("identity") != identity
            or previous.get("transport") != TRANSPORT
            or previous.get("model") != native.MODEL
        ):
            raise PilotError(
                "Existing model identity differs; use a fresh DeepSeek stage directory"
            )
        if (normal / "inherited-results.json").exists() or (
            normal / "records"
        ).exists():
            raise PilotError(
                "Qwen normal receipts cannot be reused as DeepSeek results"
            )
        native.freeze(
            destination,
            rows,
            {
                "source_sha256": source["input_sha256"],
                "mode": "schema",
                "reasoning": {"effort": "none"},
            },
        )
        failed, missing = [], []
        for row in rows:
            path = destination / "records" / f"{digest(row['custom_id'])}.json"
            if path.exists():
                record = read_json(path)
                if record["request_sha256"] != digest(row["body"]):
                    raise PilotError("Saved native request identity changed")
                if "error" in outcome(record, row):
                    failed.append(path)
            else:
                missing.append(path)
        if previous and previous.get("complete"):
            if failed or missing or not (normal / "results.json").exists():
                raise PilotError("Completed DeepSeek output is missing or invalid")
            return previous
        if retry_failed:
            for path in failed:
                target = destination / "attempts" / f"{path.stem}-{time.time_ns()}.json"
                target.parent.mkdir(exist_ok=True)
                path.rename(target)
        started = time.time()
        state = {
            "identity": identity,
            "transport": TRANSPORT,
            "model": native.MODEL,
            "url": native.URL,
            "enable_thinking": False,
            "reasoning": {"effort": "none"},
            "batch_id": None,
            "inherited_successes": 0,
            "source_input_sha256": source["input_sha256"],
            "native_input_sha256": read_json(destination / "manifest.json")[
                "input_sha256"
            ],
            "started_at": previous["started_at"] if previous else started,
            "status": "running",
            "complete": False,
        }
        save_json(state_path, state)
        try:
            native.run(destination, key, workers, timeout_seconds, transport)
        except Exception as exc:  # noqa: BLE001 - save sanitized status and raw receipts
            state["execution_error"] = (
                str(exc) if isinstance(exc, PilotError) else type(exc).__name__
            )
        state = publish(directory, rows, state, started)
        if not state["complete"]:
            raise PilotError(
                "DeepSeek stage has failed or uncertain outputs; inspect receipts before explicit retry"
            )
        return state
