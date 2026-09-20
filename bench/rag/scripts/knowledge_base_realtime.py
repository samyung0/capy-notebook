"""Resumable normal chat-completions calls over frozen pilot request files.

`run` takes the endpoint (`base_url`, `model`, `key`); the frozen request rows
carry the messages and the response schema, which is checked locally. A retry
with `retry_failed` may use another endpoint: records are keyed by the frozen
request, and each record names the endpoint that answered it."""

from __future__ import annotations

import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from jsonschema import Draft202012Validator
from knowledge_base_batch import (
    PilotError,
    digest,
    lock,
    read_json,
    request,
    save_json,
    validate_records,
)


# Waits between the four attempts a request gets when the endpoint answers 429.
RATE_LIMIT_BACKOFF = (5, 20, 60)


def object_schema(properties):
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def structured_request(custom_id, messages, name, schema):
    Draft202012Validator.check_schema(schema)
    row = request(custom_id, messages, 1)
    # Alibaba recommends omitting max_tokens for structured output to avoid truncation.
    del row["body"]["max_tokens"]
    row["body"]["response_format"] = {
        "type": "json_schema",
        "json_schema": {"name": name, "strict": True, "schema": schema},
    }
    return row


def validate_output_schema(result, rows):
    for row in rows:
        schema = row["body"].get("response_format", {}).get("json_schema")
        key = row["custom_id"]
        if schema and key in result["success"]:
            validator = Draft202012Validator(schema["schema"])
            if not validator.is_valid(result["success"][key]["value"]):
                del result["success"][key]
                result["failed"][key] = {"kind": "invalid_schema"}
    return result


def stage_results(directory: Path):
    """Normal results take precedence; historical Batch receipts stay intact."""
    normal = directory / "realtime"
    chosen = normal if (normal / "state.json").exists() else directory
    return read_json(chosen / "state.json"), read_json(chosen / "results.json")


def run(
    directory: Path,
    key: str,
    *,
    workers: int,
    base_url: str,
    model: str,
    transport=None,
    retry_failed=False,
    timeout_seconds=120,
):
    if not 1 <= workers <= 8:
        raise PilotError("Normal API needs an explicit worker count from 1 to 8")
    if not 1 <= timeout_seconds <= 600:
        raise PilotError("Normal API timeout must be between 1 and 600 seconds")
    payload = (directory / "input.jsonl").read_bytes()
    source = read_json(directory / "state.json")
    if hashlib.sha256(payload).hexdigest() != source["input_sha256"]:
        raise PilotError("Frozen model input changed")
    rows = [json.loads(line) for line in payload.splitlines() if line.strip()]
    expected = [row["custom_id"] for row in rows]
    if len(set(expected)) != len(expected) or expected != source["request_ids"]:
        raise PilotError("Model input IDs differ from the frozen manifest")
    normal = directory / "realtime"
    with lock(normal / "command.lock"):
        snapshot = normal / "inherited-results.json"
        if not snapshot.exists():
            inherited = (
                read_json(directory / "results.json")
                if (directory / "results.json").exists()
                else {"success": {}}
            )
            save_json(snapshot, inherited)
        inherited = read_json(snapshot)
        success = inherited["success"]
        if not set(success) <= set(expected):
            raise PilotError("Inherited results contain unknown request IDs")
        if validate_output_schema({"success": dict(success), "failed": {}}, rows)[
            "failed"
        ]:
            raise PilotError("Inherited output violates the request schema")
        identity = digest({"input": source["input_sha256"], "inherited": success})
        state_path = normal / "state.json"
        if state_path.exists():
            previous = read_json(state_path)
            if previous["identity"] != identity:
                raise PilotError(
                    "Normal request/reuse identity changed; use a new directory"
                )
            if previous["complete"]:
                if not (normal / "results.json").exists():
                    raise PilotError("Completed normal results are missing")
                return previous
        started = time.time()
        state = {
            "identity": identity,
            "transport": "normal-api",
            "reasoning_effort": "low",
            "model": model,
            "base_url": base_url,
            "batch_id": source.get("batch_id"),
            "inherited_successes": len(success),
            "started_at": started,
            "complete": False,
            "status": "running",
        }
        save_json(state_path, state)
        with httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {key}"} if key else {},
            timeout=timeout_seconds,
            transport=transport,
        ) as client:

            def execute(row):
                request_id = row["custom_id"]
                path = normal / "records" / f"{digest(request_id)}.json"
                # The frozen row decides the request identity; the endpoint may
                # differ between attempts (Ollama first, TokenHub on retry).
                body = {**row["body"], "model": model, "stream": False}
                body.pop("enable_thinking", None)
                body["reasoning_effort"] = "low"
                if row["method"] != "POST" or row["url"] != "/v1/chat/completions":
                    raise PilotError("Unexpected frozen model request")
                request_hash = digest(row["body"])
                if path.exists():
                    record = read_json(path)
                    if record["request_sha256"] != request_hash:
                        raise PilotError("Saved normal request identity changed")
                    uncertain = record["status"] in {"sending", "uncertain"}
                    failed = uncertain or bool(
                        validate_output_schema(
                            validate_records([request_id], [record]), [row]
                        )["failed"]
                    )
                    if failed and retry_failed:
                        archive = (
                            normal
                            / "attempts"
                            / f"{digest(request_id)}-{time.time_ns()}.json"
                        )
                        archive.parent.mkdir(exist_ok=True)
                        path.rename(archive)
                    elif uncertain:
                        raise PilotError(
                            "Uncertain normal request retained; inspect its receipt before retrying"
                        )
                    else:
                        return record
                record = {
                    "custom_id": request_id,
                    "request_sha256": request_hash,
                    "status": "sending",
                    "started_at": time.time(),
                    "model": model,
                    "base_url": base_url,
                    "reasoning_effort": "low",
                }
                save_json(path, record)
                try:
                    for pause in (*RATE_LIMIT_BACKOFF, None):
                        response = client.post("/chat/completions", json=body)
                        if response.status_code != 429 or pause is None:
                            break
                        # Throttled: wait for the endpoint before the receipt
                        # becomes a provider_error.
                        time.sleep(float(response.headers.get("retry-after") or pause))
                    record.update(
                        status="received",
                        response={
                            "status_code": response.status_code,
                            "body": {},
                            "request_id": response.headers.get("x-request-id"),
                        },
                    )
                    try:
                        record["response"]["body"] = response.json()
                    except ValueError:
                        record["error"] = {"kind": "invalid_http_json"}
                except httpx.HTTPError as exc:
                    record.update(
                        status="uncertain", error={"kind": type(exc).__name__}
                    )
                record.update(
                    finished_at=time.time(), seconds=time.time() - record["started_at"]
                )
                save_json(path, record)
                return record

            pending = [row for row in rows if row["custom_id"] not in success]
            with ThreadPoolExecutor(max_workers=workers) as pool:
                records = list(pool.map(execute, pending))
        result = validate_output_schema(
            validate_records([row["custom_id"] for row in pending], records), pending
        )
        result["success"].update(success)
        save_json(normal / "results.json", result)
        attempts = records + [
            read_json(p) for p in (normal / "attempts").glob("*.json")
        ]
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "reasoning_tokens": None}
        missing_usage = 0
        reasoning_records = 0
        for record in attempts:
            tokens = (record.get("response") or {}).get("body", {}).get("usage") or {}
            missing_usage += not all(
                k in tokens for k in ("prompt_tokens", "completion_tokens")
            )
            for field in ("prompt_tokens", "completion_tokens"):
                usage[field] += tokens.get(field, 0)
            reasoning = (tokens.get("completion_tokens_details") or {}).get(
                "reasoning_tokens"
            )
            if reasoning is not None:
                reasoning_records += 1
                usage["reasoning_tokens"] = (usage["reasoning_tokens"] or 0) + reasoning
        state.update(
            status="completed"
            if not result["failed"] and not result["missing"]
            else "failed",
            complete=not result["failed"] and not result["missing"],
            finished_at=time.time(),
            collection={k: len(result[k]) for k in ("success", "failed", "missing")},
            normal_requests=len(attempts),
            usage_missing_attempts=missing_usage,
            reasoning_usage_records=reasoning_records,
            new_requests=sum(r["started_at"] >= started for r in records),
            summed_request_seconds=sum(r.get("seconds", 0) for r in attempts),
            elapsed_seconds=time.time() - started,
            usage=usage,
        )
        save_json(state_path, state)
        print(
            json.dumps(
                {
                    k: state[k]
                    for k in (
                        "transport",
                        "status",
                        "collection",
                        "normal_requests",
                        "inherited_successes",
                        "usage",
                        "elapsed_seconds",
                    )
                }
            ),
            flush=True,
        )
        if not state["complete"]:
            raise PilotError(
                "Normal API stage has failed or uncertain responses; inspect saved receipts"
            )
        return state
