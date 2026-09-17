"""Bounded GLM-5.3-Flash (Tencent TokenHub) arm over the frozen recovery crops, no retries."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from tempfile import TemporaryDirectory

import httpx
from dotenv import dotenv_values
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "bench/parsers/reports/local/2026-09-16-selective-recovery/r2"
SOURCE = BASE / "normal-structured-explicit/batch/input.jsonl"
# Same gateway and thinking contract as production pipeline/elitellm/client.py.
URL = "https://tokenhub.tencentcloudmaas.com/v1/chat/completions"
MODEL = "glm-5.3-flash"
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
from knowledge_base_batch import PilotError, digest, lock, read_json, save_json


def read_rows(path):
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def convert(row, effort):
    """Frozen Qwen chat body -> TokenHub body; JSON-object output, schema checked locally."""
    source = row["body"]
    schema = source["response_format"]["json_schema"]["schema"]
    Draft202012Validator.check_schema(schema)
    body = {
        "model": MODEL,
        "messages": source["messages"],
        "reasoning_effort": effort,
        "temperature": source["temperature"],
        "response_format": {"type": "json_object"},
        "max_tokens": 8192,
    }
    return {
        "custom_id": row["custom_id"],
        "source_request_sha256": digest(row),
        "source_messages_sha256": digest(source["messages"]),
        "schema": schema,
        "body": body,
    }


def freeze(directory, rows, effort):
    payload = (
        b"\n".join(
            json.dumps(r, ensure_ascii=False, allow_nan=False).encode() for r in rows
        )
        + b"\n"
    )
    manifest = {
        "input_sha256": hashlib.sha256(payload).hexdigest(),
        "request_ids": [r["custom_id"] for r in rows],
        "model": MODEL,
        "url": URL,
        "reasoning_effort": effort,
        "source_path": str(SOURCE.relative_to(ROOT)),
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    }
    path = directory / "manifest.json"
    if path.exists():
        if (
            read_json(path) != manifest
            or (directory / "input.jsonl").read_bytes() != payload
        ):
            raise PilotError("Frozen comparison input changed; use a new directory")
        return
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "input.jsonl").write_bytes(payload)
    save_json(path, manifest)


def validate(record, row):
    response = record.get("response", {})
    body = response.get("body", {})
    if record["status"] != "received":
        return {"error": record.get("error", {"kind": record["status"]})}
    if response["status_code"] != 200:
        return {"error": {"kind": "http_error", "status_code": response["status_code"]}}
    choices = body.get("choices") or []
    message = (choices[0].get("message") or {}) if choices else {}
    text = message.get("content") or ""
    finish = choices[0].get("finish_reason") if choices else None
    if finish != "stop":
        return {"error": {"kind": "unfinished", "finish_reason": finish}, "text": text}
    try:
        value = json.loads(text)
    except ValueError:
        return {"error": {"kind": "invalid_output_json"}, "text": text}
    errors = [
        {"path": list(e.absolute_path), "validator": e.validator, "message": e.message}
        for e in Draft202012Validator(row["schema"]).iter_errors(value)
    ]
    outcome = {"value": value, "text": text, "schema_errors": errors}
    if message.get("reasoning_content"):
        outcome["reasoning_chars"] = len(message["reasoning_content"])
    if errors:
        outcome["error"] = {"kind": "invalid_schema"}
    return outcome


USAGE = ("prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_tokens")


def usage_metrics(tokens):
    tokens = tokens or {}
    return {
        "prompt_tokens": tokens.get("prompt_tokens"),
        "completion_tokens": tokens.get("completion_tokens"),
        "reasoning_tokens": (tokens.get("completion_tokens_details") or {}).get(
            "reasoning_tokens"
        ),
        "cached_tokens": (tokens.get("prompt_tokens_details") or {}).get(
            "cached_tokens"
        ),
    }


def summarize(directory, rows, records, elapsed):
    result = {"success": {}, "failed": {}, "missing": []}
    usage = dict.fromkeys(USAGE)
    reported = dict.fromkeys(USAGE, 0)
    missing_usage, latencies = 0, []
    for row in rows:
        key = row["custom_id"]
        if key not in records:
            result["missing"].append(key)
            continue
        record = records[key]
        outcome = validate(record, row)
        outcome["seconds"] = record.get("seconds")
        tokens = record.get("response", {}).get("body", {}).get("usage")
        outcome["usage"] = tokens
        metrics = usage_metrics(tokens)
        if any(
            type(metrics[k]) is not int for k in ("prompt_tokens", "completion_tokens")
        ):
            missing_usage += 1
        for field, value in metrics.items():
            if type(value) is int and value >= 0:
                usage[field] = (usage[field] or 0) + value
                reported[field] += 1
        if record.get("seconds") is not None:
            latencies.append(record["seconds"])
        if "error" in outcome:
            result["failed"][key] = outcome
            continue
        result["success"][key] = outcome
        if not key.replace("-", "").replace("_", "").isalnum():
            raise PilotError("Unsafe transcript ID")
        target = directory / "transcripts" / f"{key}.md"
        target.parent.mkdir(exist_ok=True)
        target.write_text(outcome["value"]["markdown"], encoding="utf-8")
    save_json(directory / "results.json", result)
    summary = {
        "model": MODEL,
        "collection": {k: len(v) for k, v in result.items()},
        "elapsed_seconds": elapsed,
        "request_seconds": sum(latencies),
        "median_seconds": statistics.median(latencies) if latencies else None,
        "usage": usage,
        "usage_reported_requests": reported,
        "usage_missing_requests": missing_usage,
    }
    save_json(directory / "summary.json", summary)
    return summary


def run(directory, key, workers, timeout, transport=None):
    with lock(directory / "command.lock"):
        rows = read_rows(directory / "input.jsonl")
        manifest = read_json(directory / "manifest.json")
        if (
            hashlib.sha256((directory / "input.jsonl").read_bytes()).hexdigest()
            != manifest["input_sha256"]
        ):
            raise PilotError("Frozen comparison input changed")
        previous = (
            read_json(directory / "summary.json")
            if (directory / "summary.json").exists()
            else None
        )
        cached = all(
            (directory / "records" / f"{digest(r['custom_id'])}.json").exists()
            for r in rows
        )
        started = time.time()
        records = {}
        with httpx.Client(
            headers={"Authorization": f"Bearer {key}"},
            timeout=timeout,
            transport=transport,
        ) as client:

            def execute(row):
                key = row["custom_id"]
                path = directory / "records" / f"{digest(key)}.json"
                if path.exists():
                    record = read_json(path)
                    if record["request_sha256"] != digest(row["body"]):
                        raise PilotError("Saved request identity changed")
                    return record
                request = client.build_request("POST", URL, json=row["body"])
                record = {
                    "custom_id": key,
                    "request_sha256": digest(row["body"]),
                    "request_body": row["body"],
                    "request_wire_sha256": hashlib.sha256(request.content).hexdigest(),
                    "url": URL,
                    "status": "sending",
                    "started_at": time.time(),
                }
                save_json(path, record)
                try:
                    response = client.send(request)
                    record.update(
                        status="received",
                        response={
                            "status_code": response.status_code,
                            "request_id": response.headers.get("x-request-id"),
                            "raw_text": response.text,
                        },
                    )
                    try:
                        record["response"]["body"] = response.json()
                    except ValueError:
                        record["status"] = "invalid_http_json"
                except httpx.HTTPError as exc:
                    record.update(
                        status="uncertain", error={"kind": type(exc).__name__}
                    )
                record.update(
                    finished_at=time.time(), seconds=time.time() - record["started_at"]
                )
                save_json(path, record)
                print(
                    json.dumps(
                        {
                            "id": key,
                            "status": record["status"],
                            "seconds": record["seconds"],
                        }
                    ),
                    flush=True,
                )
                return record

            with ThreadPoolExecutor(max_workers=workers) as pool:
                for future in as_completed([pool.submit(execute, r) for r in rows]):
                    record = future.result()
                    records[record["custom_id"]] = record
                    elapsed = (
                        previous["elapsed_seconds"]
                        if cached and previous
                        else time.time() - started
                    )
                    summary = summarize(directory, rows, records, elapsed)
        print(json.dumps(summary), flush=True)
        return summary


def check():
    schema = {
        "type": "object",
        "properties": {"markdown": {"type": "string"}, "uncertain": {"type": "array"}},
        "required": ["markdown", "uncertain"],
        "additionalProperties": False,
    }
    row = convert(
        {
            "custom_id": "test",
            "body": {
                "model": "qwen3.8-flash",
                "enable_thinking": False,
                "messages": [{"role": "user", "content": "unchanged"}],
                "temperature": 0,
                "response_format": {"json_schema": {"name": "t", "schema": schema}},
            },
        },
        "low",
    )
    assert row["body"]["model"] == MODEL and "enable_thinking" not in row["body"]
    assert row["body"]["reasoning_effort"] == "low"
    assert row["body"]["response_format"] == {"type": "json_object"}
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": '{"markdown": "x", "uncertain": "bad"}',
                            "reasoning_content": "thought",
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 2,
                    "completion_tokens_details": {"reasoning_tokens": 1},
                },
            },
        )

    with TemporaryDirectory() as tmp:
        directory = Path(tmp)
        freeze(directory, [row], "low")
        first = run(directory, "test-key", 1, 1, httpx.MockTransport(handler))
        assert first["usage"]["reasoning_tokens"] == 1
        assert first["usage"]["cached_tokens"] is None
        failed = read_json(directory / "results.json")["failed"]["test"]
        assert failed["error"]["kind"] == "invalid_schema"
        assert failed["reasoning_chars"] == 7
        replay = run(directory, "test-key", 1, 1, httpx.MockTransport(handler))
        assert replay["elapsed_seconds"] == first["elapsed_seconds"]
        assert len(calls) == 1, "An existing invalid output must never be retried"
    print("TokenHub conversion, usage, schema rejection and no-retry checks passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["prepare", "crops", "check"])
    parser.add_argument("--reasoning", choices=["low", "high", "max"], default="high")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.stage == "check":
        check()
        return
    if not 1 <= args.workers <= 4 or not 1 <= args.timeout <= 600:
        raise PilotError("Use 1-4 workers and a timeout of 1-600 seconds")
    directory = BASE / f"tokenhub-{MODEL}-{args.reasoning}" / "crops"
    rows = read_rows(SOURCE)
    if len(rows) != 16:
        raise PilotError("Unexpected frozen crop count")
    freeze(directory, [convert(r, args.reasoning) for r in rows], args.reasoning)
    if args.stage == "prepare":
        print(f"Frozen inputs saved to {directory}")
        return
    key = dotenv_values(ROOT / ".env.local").get("TOKENHUB")
    if not key:
        raise PilotError("Missing TOKENHUB in the project-root .env.local")
    run(directory, key, args.workers, args.timeout)


if __name__ == "__main__":
    try:
        main()
    except PilotError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
