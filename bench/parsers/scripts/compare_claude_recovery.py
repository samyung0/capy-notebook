"""Headless Claude Code (subscription login) arm over the frozen recovery crops, no retries."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from tempfile import TemporaryDirectory

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "bench/parsers/reports/local/2026-09-16-selective-recovery/r2"
SOURCE = BASE / "normal-structured-explicit/batch/input.jsonl"
MODEL = "claude-sonnet-4-6"
EFFORT = "medium"
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
from knowledge_base_batch import PilotError, digest, lock, read_json, save_json


def read_rows(path):
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def convert(row):
    """Frozen OpenAI-style request -> Claude Code stream-json user event plus CLI args."""
    body = row["body"]
    schema = body["response_format"]["json_schema"]["schema"]
    Draft202012Validator.check_schema(schema)
    system = [m["content"] for m in body["messages"] if m["role"] == "system"]
    users = [m for m in body["messages"] if m["role"] == "user"]
    if len(system) != 1 or len(users) != 1:
        raise PilotError("Expected one system and one user message")
    content, image_sha256 = [], []
    for part in users[0]["content"]:
        if part["type"] == "text":
            content.append({"type": "text", "text": part["text"]})
        elif part["type"] == "image_url":
            media, data = part["image_url"]["url"].split(";base64,")
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media.removeprefix("data:"),
                        "data": data,
                    },
                }
            )
            image_sha256.append(hashlib.sha256(base64.b64decode(data)).hexdigest())
        else:
            raise PilotError("Unexpected frozen content type")
    return {
        "custom_id": row["custom_id"],
        "source_request_sha256": digest(row),
        "image_sha256": image_sha256,
        "schema": schema,
        "system": system[0],
        "event": {"type": "user", "message": {"role": "user", "content": content}},
    }


FLAGS = [
    "-p",
    "--model",
    MODEL,
    "--effort",
    EFFORT,
    "--tools",
    "",
    # Built-in tools off is not enough: the login's claude.ai connectors are
    # loaded as MCP servers and their schemas inflate every request after the first.
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
]


def command(row):
    return [
        "claude",
        *FLAGS,
        "--system-prompt",
        row["system"],
        "--json-schema",
        json.dumps(row["schema"]),
    ]


def child_env():
    # The arm is defined as the subscription login; any token or base URL in the
    # environment would take precedence over it.
    env = dict(os.environ)
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
        env.pop(name, None)
    return env


def freeze(directory, rows):
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
        "effort": EFFORT,
        "cli_flags": FLAGS,
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


def parse_events(stdout):
    events = []
    for line in stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def validate(record, row):
    if record["status"] != "received":
        return {"error": record.get("error", {"kind": record["status"]})}
    result = record.get("result")
    if not result:
        return {"error": {"kind": "missing_result_event"}}
    if result.get("is_error"):
        return {"error": {"kind": "cli_error", "detail": result.get("result")}}
    value = result.get("structured_output")
    if value is None:
        return {
            "error": {"kind": "missing_structured_output"},
            "text": result.get("result"),
        }
    errors = [
        {"path": list(e.absolute_path), "validator": e.validator, "message": e.message}
        for e in Draft202012Validator(row["schema"]).iter_errors(value)
    ]
    outcome = {"value": value, "schema_errors": errors}
    if errors:
        outcome["error"] = {"kind": "invalid_schema"}
    return outcome


def api_usage(events):
    """Per-API-call usage from assistant events, deduplicated by message id."""
    seen, out = set(), []
    for event in events:
        message = event.get("message") if event.get("type") == "assistant" else None
        if message and message.get("id") not in seen and message.get("usage"):
            seen.add(message.get("id"))
            out.append(message["usage"])
    return out


USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


def summarize(directory, rows, records, elapsed):
    result = {"success": {}, "failed": {}, "missing": []}
    per_call = dict.fromkeys(USAGE_FIELDS, 0)
    cli_total = dict.fromkeys(USAGE_FIELDS, 0)
    cost, latencies, api_calls = 0.0, [], 0
    for row in rows:
        key = row["custom_id"]
        if key not in records:
            result["missing"].append(key)
            continue
        record = records[key]
        outcome = validate(record, row)
        outcome["seconds"] = record.get("seconds")
        outcome["api_call_usage"] = record.get("api_call_usage")
        outcome["cli_usage"] = (record.get("result") or {}).get("usage")
        outcome["cli_cost_usd"] = (record.get("result") or {}).get("total_cost_usd")
        for usage in record.get("api_call_usage") or []:
            api_calls += 1
            for f in USAGE_FIELDS:
                per_call[f] += usage.get(f) or 0
        for f in USAGE_FIELDS:
            cli_total[f] += (outcome["cli_usage"] or {}).get(f) or 0
        cost += outcome["cli_cost_usd"] or 0
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
        "effort": EFFORT,
        "collection": {k: len(v) for k, v in result.items()},
        "elapsed_seconds": elapsed,
        "request_seconds": sum(latencies),
        "median_seconds": statistics.median(latencies) if latencies else None,
        "api_calls": api_calls,
        "usage_per_api_call_sum": per_call,
        "usage_cli_result_sum": cli_total,
        "cli_cost_usd_sum": cost,
        "note": "usage_cli_result_sum is the CLI aggregate; it exceeded the per-call sum in probes, so both are kept.",
    }
    save_json(directory / "summary.json", summary)
    return summary


def run(directory, workers, timeout, runner=None):
    runner = runner or (
        lambda row: subprocess.run(
            command(row),
            input=json.dumps(row["event"]) + "\n",
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout,
            env=child_env(),
            check=False,
        )
    )
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

        def execute(row):
            key = row["custom_id"]
            path = directory / "records" / f"{digest(key)}.json"
            if path.exists():
                record = read_json(path)
                if record["request_sha256"] != digest(row):
                    raise PilotError("Saved request identity changed")
                return record
            record = {
                "custom_id": key,
                "request_sha256": digest(row),
                "command": command(row),
                "status": "sending",
                "started_at": time.time(),
            }
            save_json(path, record)
            try:
                proc = runner(row)
                events = parse_events(proc.stdout)
                record.update(
                    status="received",
                    exit_code=proc.returncode,
                    stderr=proc.stderr,
                    events=events,
                    result=next((e for e in events if e.get("type") == "result"), None),
                    api_call_usage=api_usage(events),
                )
            except (subprocess.SubprocessError, OSError) as exc:
                record.update(status="uncertain", error={"kind": type(exc).__name__})
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
                "messages": [
                    {"role": "system", "content": "keep me"},
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": "data:image/png;base64,AAAA"},
                            },
                            {"type": "text", "text": "unchanged"},
                        ],
                    },
                ],
                "response_format": {"json_schema": {"name": "t", "schema": schema}},
            },
        }
    )
    assert row["system"] == "keep me"
    assert row["event"]["message"]["content"][0]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": "AAAA",
    }
    assert row["event"]["message"]["content"][1] == {
        "type": "text",
        "text": "unchanged",
    }
    assert "--json-schema" in command(row) and "--tools" in command(row)
    assert "ANTHROPIC_AUTH_TOKEN" not in child_env()
    calls = []
    usage = {"input_tokens": 1, "output_tokens": 2}
    events = [
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"id": "m1", "usage": usage}},
        {"type": "assistant", "message": {"id": "m1", "usage": usage}},
        {
            "type": "result",
            "is_error": False,
            "structured_output": {"markdown": "x", "uncertain": "bad"},
            "usage": {"input_tokens": 9},
            "total_cost_usd": 0.5,
        },
    ]

    class Proc:
        returncode, stderr = 0, ""
        stdout = "\n".join(json.dumps(e) for e in events)

    def fake(row):
        calls.append(row)
        return Proc()

    with TemporaryDirectory() as tmp:
        directory = Path(tmp)
        freeze(directory, [row])
        first = run(directory, 1, 1, fake)
        assert first["api_calls"] == 1
        assert first["usage_per_api_call_sum"]["input_tokens"] == 1
        assert first["usage_cli_result_sum"]["input_tokens"] == 9
        failed = read_json(directory / "results.json")["failed"]
        assert failed["test"]["error"]["kind"] == "invalid_schema"
        replay = run(directory, 1, 1, fake)
        assert replay["elapsed_seconds"] == first["elapsed_seconds"]
        assert len(calls) == 1, "An existing invalid output must never be retried"
    print("Claude conversion, usage dedup, schema rejection and no-retry checks passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["prepare", "crops", "check"])
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.stage == "check":
        check()
        return
    if not 1 <= args.workers <= 4 or not 1 <= args.timeout <= 600:
        raise PilotError("Use 1-4 workers and a timeout of 1-600 seconds")
    directory = BASE / f"{MODEL}-{EFFORT}-nomcp" / "crops"
    rows = read_rows(SOURCE)
    if len(rows) != 16:
        raise PilotError("Unexpected frozen crop count")
    freeze(directory, [convert(r) for r in rows])
    if args.stage == "prepare":
        print(f"Frozen inputs saved to {directory}")
        return
    run(directory, args.workers, args.timeout)


if __name__ == "__main__":
    try:
        main()
    except PilotError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
