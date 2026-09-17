"""Bounded native DeepSeek comparison over frozen Qwen requests, without retries."""

from __future__ import annotations

import argparse
import base64
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
PILOT = ROOT / "data/knowledge-base-pilot/run"
MODEL = "deepseek-flash"
URL = "https://api.deepseek.com/responses"
PAGE_PROMPT = "Describe this page from a study document so a student's search can find the information it carries. Extract all visible raw facts such as text, tables, formulas, data, labels, etc. Caption any images in brief and simple sentence. Do not add any text that is not visible in the page or depicted in the images. Do not duplicate information. Do not add any unnecessary summary, title, line breaks, the response is processed automatically by a RAG pipeline. "
REGION_PROMPT = "Describe this cropped region from a study document so a student's search can find the information it carries. Extract all visible raw facts such as text, tables, formulas, data, labels, etc. Preserve the exact wording, numbers, symbols, conditions and table row/column associations. Write formulas in LaTeX, with explicit grouping for fractions, square roots, exponents and subscripts. Do not correct printed errors or complete clipped text. Caption any images in a brief and simple sentence, separate from transcribed text. Do not add any text that is not visible in the region or depicted in the images. Do not duplicate information. Do not add any unnecessary summary or title. Keep line breaks needed for formulas and table structure; the response is processed automatically by a RAG pipeline."
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
from knowledge_base_batch import PilotError, digest, lock, read_json, save_json


def read_rows(path):
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def convert(row, mode, effort="none"):
    source = row["body"]
    schema = source["response_format"]["json_schema"]
    Draft202012Validator.check_schema(schema["schema"])
    messages = []
    for message in source["messages"]:
        content = message["content"]
        if isinstance(content, list):
            parts = []
            for part in content:
                if part["type"] == "text":
                    parts.append({"type": "input_text", "text": part["text"]})
                elif part["type"] == "image_url":
                    parts.append(
                        {"type": "input_image", "image_url": part["image_url"]["url"]}
                    )
                    if "detail" in part["image_url"]:
                        parts[-1]["detail"] = part["image_url"]["detail"]
                else:
                    raise PilotError("Unexpected frozen content type")
            content = parts
        messages.append({"role": message["role"], "content": content})
    output_format = {"type": "json_object"}
    if mode in {"schema", "schema-strict"}:
        output_format = {
            "type": "json_schema",
            "name": schema["name"],
            "schema": schema["schema"],
        }
        if mode == "schema-strict":
            output_format["strict"] = True
    body = {
        "model": MODEL,
        "input": messages,
        "reasoning": {"effort": effort},
        "temperature": source["temperature"],
        "stream": False,
        "text": {"format": output_format},
    }
    if "max_tokens" in source:
        body["max_output_tokens"] = source["max_tokens"]
    return {
        "custom_id": row["custom_id"],
        "source_request_sha256": digest(row),
        "source_messages_sha256": digest(source["messages"]),
        "schema": schema["schema"],
        "body": body,
    }


def selected_tags(rows, tags):
    selected, counts = [], {False: 0, True: 0}
    for row in rows:
        verified = tags[row["custom_id"]]["evidence_verified"]
        if type(verified) is not bool:
            raise PilotError("Missing Qwen evidence outcome")
        if counts[verified] < 6:
            selected.append(row)
            counts[verified] += 1
    if counts != {False: 6, True: 6}:
        raise PilotError("Need six frozen tag cases in each Qwen evidence stratum")
    return selected


def freeze(directory, rows, provenance):
    payload = (
        b"\n".join(
            json.dumps(row, ensure_ascii=False, allow_nan=False).encode()
            for row in rows
        )
        + b"\n"
    )
    manifest = {
        "input_sha256": hashlib.sha256(payload).hexdigest(),
        "request_ids": [row["custom_id"] for row in rows],
        "model": MODEL,
        "url": URL,
        **provenance,
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


def prepare(directory, mode, effort="none"):
    tags_path = PILOT / "models/tags/input.jsonl"
    tags = read_json(PILOT / "tags.json")["tags"]
    sources = {
        "crops": BASE / "normal-structured-explicit/batch/input.jsonl",
        "tags": tags_path,
        "summaries": PILOT / "models/summaries/input.jsonl",
    }
    for stage, path in sources.items():
        rows = read_rows(path)
        if stage == "tags":
            rows = selected_tags(rows, tags)
        expected = {"crops": 16, "tags": 12, "summaries": 3}[stage]
        if len(rows) != expected:
            raise PilotError("Unexpected frozen comparison size")
        provenance = {
            "source_path": str(path.relative_to(ROOT)),
            "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "mode": mode,
            "reasoning_effort": effort,
        }
        if stage == "tags":
            provenance["selection"] = (
                "First six false and first six true evidence_verified cases in frozen Qwen request order, merged in request order."
            )
            provenance["qwen_tags"] = {
                row["custom_id"]: tags[row["custom_id"]] for row in rows
            }
        freeze(
            directory / stage, [convert(row, mode, effort) for row in rows], provenance
        )
    schema = {
        "type": "object",
        "properties": {"marker": {"type": "string", "enum": ["schema_wins"]}},
        "required": ["marker"],
        "additionalProperties": False,
    }
    probe = {
        "custom_id": "schema-conflict-probe",
        "body": {
            "messages": [
                {
                    "role": "user",
                    "content": 'Return exactly this JSON object: {"marker":"prompt_wins","extra":1}. Do not change it.',
                }
            ],
            "response_format": {
                "json_schema": {"name": "schema_conflict_probe", "schema": schema}
            },
            "temperature": 0,
            "max_tokens": 128,
        },
    }
    freeze(
        directory / "probe",
        [convert(probe, mode)],
        {
            "mode": mode,
            "purpose": "Conflicting prompt probes observed schema enforcement; one case is not proof of universal enforcement.",
        },
    )


def page_request(custom_id, image_url, prompt=PAGE_PROMPT):
    return {
        "custom_id": custom_id,
        "output_kind": "text",
        "body": {
            "model": MODEL,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_image", "image_url": image_url},
                        {"type": "input_text", "text": prompt},
                    ],
                }
            ],
            "reasoning": {"effort": "none"},
            "temperature": 0,
            "stream": False,
            "text": {"format": {"type": "text"}},
        },
    }


def prepare_page_prompt(directory, mode):
    import pymupdf

    source = BASE / "normal-structured-explicit/batch/input.jsonl"
    prompt = REGION_PROMPT if mode == "region-prompt" else PAGE_PROMPT
    crops = []
    for row in read_rows(source):
        images = [
            part["image_url"]["url"]
            for message in row["body"]["messages"]
            if isinstance(message["content"], list)
            for part in message["content"]
            if part["type"] == "image_url"
        ]
        if len(images) != 1:
            raise PilotError("Expected one frozen crop image")
        crops.append(page_request(row["custom_id"], images[0], prompt))
    provenance = {"mode": mode, "prompt": prompt}
    freeze(
        directory / "crops",
        crops,
        {
            **provenance,
            "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        },
    )
    if mode == "region-prompt":
        return
    fixture = ROOT / "bench/parsers/fixtures/page-prompt-cases.json"
    pages, sources = [], []
    for case in read_json(fixture)["cases"]:
        source = ROOT / case["source"]
        target = directory / "images" / f"{case['id']}.png"
        with pymupdf.open(source) as document:
            page = document[case["page"] - 1]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(2.5, 2.5), alpha=False)
            payload = pix.tobytes("png")
        if target.exists() and target.read_bytes() != payload:
            raise PilotError("Frozen full-page image changed")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        sources.append(
            {
                **case,
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "image_sha256": hashlib.sha256(payload).hexdigest(),
                "pixels": [pix.width, pix.height],
            }
        )
        pages.append(
            page_request(
                case["id"],
                "data:image/png;base64," + base64.b64encode(payload).decode("ascii"),
            )
        )
    freeze(
        directory / "pages",
        pages,
        {
            **provenance,
            "fixture_sha256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
            "sources": sources,
        },
    )


def validate(record, row):
    response = record.get("response", {})
    body = response.get("body", {})
    if record["status"] != "received":
        return {"error": record.get("error", {"kind": record["status"]})}
    if response["status_code"] != 200:
        return {"error": {"kind": "http_error", "status_code": response["status_code"]}}
    if body.get("status") != "completed":
        return {"error": {"kind": "incomplete_response", "status": body.get("status")}}
    text = "".join(
        part["text"]
        for item in body.get("output", [])
        if item.get("type") == "message"
        for part in item.get("content", [])
        if part.get("type") == "output_text"
    )
    if row.get("output_kind") == "text":
        if not text.strip():
            return {"error": {"kind": "empty_text"}, "text": text}
        return {"value": {"markdown": text}, "text": text, "output_kind": "text"}
    try:
        value = json.loads(text)
    except ValueError:
        return {"error": {"kind": "invalid_output_json"}, "text": text}
    errors = [
        {
            "path": list(error.absolute_path),
            "validator": error.validator,
            "message": error.message,
        }
        for error in Draft202012Validator(row["schema"]).iter_errors(value)
    ]
    result = {"value": value, "text": text, "schema_errors": errors}
    if errors:
        result["error"] = {"kind": "invalid_schema"}
    return result


def evidence_check(value, source):
    evidence = value["evidence"]
    return {
        "evidence": evidence,
        "exact_contiguous": bool(evidence) and evidence in source,
        "whitespace_contiguous": bool(evidence.strip())
        and " ".join(evidence.split()) in " ".join(source.split()),
        "literal_ellipsis": "..." in evidence or "…" in evidence,
    }


def summarize(directory, rows, records, elapsed):
    result = {"success": {}, "failed": {}, "missing": []}
    manifest = read_json(directory / "manifest.json")
    usage = dict.fromkeys(
        ("input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens")
    )
    reported = dict.fromkeys(usage, 0)
    missing_usage = 0
    latencies = []
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
        tokens = tokens or {}
        metrics = {
            "input_tokens": tokens.get("input_tokens"),
            "output_tokens": tokens.get("output_tokens"),
            "reasoning_tokens": (tokens.get("output_tokens_details") or {}).get(
                "reasoning_tokens"
            ),
            "cached_tokens": (tokens.get("input_tokens_details") or {}).get(
                "cached_tokens"
            ),
        }
        if any(type(metrics[k]) is not int for k in ("input_tokens", "output_tokens")):
            missing_usage += 1
        for field, value in metrics.items():
            if type(value) is int and value >= 0:
                usage[field] = (usage[field] or 0) + value
                reported[field] += 1
        if record.get("seconds") is not None:
            latencies.append(record["seconds"])
        if (
            "qwen_tags" in manifest
            and isinstance(outcome.get("value"), dict)
            and isinstance(outcome["value"].get("evidence"), str)
        ):
            source = json.loads(row["body"]["input"][1]["content"])["source_text"]
            outcome["evidence_check"] = evidence_check(outcome["value"], source)
            outcome["qwen_evidence_check"] = evidence_check(
                manifest["qwen_tags"][key], source
            )
        if "error" in outcome:
            result["failed"][key] = outcome
        else:
            result["success"][key] = outcome
            if "markdown" in outcome["value"]:
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
        "request_span_seconds": max(
            (r.get("finished_at", r["started_at"]) for r in records.values()), default=0
        )
        - min((r["started_at"] for r in records.values()), default=0),
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
        records = {}
        previous = (
            read_json(directory / "summary.json")
            if (directory / "summary.json").exists()
            else None
        )
        cached = all(
            (directory / "records" / f"{digest(row['custom_id'])}.json").exists()
            for row in rows
        )
        started = time.time()
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
                            "stage": directory.name,
                            "id": key,
                            "status": record["status"],
                            "seconds": record["seconds"],
                        }
                    ),
                    flush=True,
                )
                return record

            with ThreadPoolExecutor(max_workers=workers) as pool:
                for future in as_completed([pool.submit(execute, row) for row in rows]):
                    record = future.result()
                    records[record["custom_id"]] = record
                    elapsed = (
                        previous["elapsed_seconds"]
                        if cached and previous
                        else time.time() - started
                    )
                    summary = summarize(directory, rows, records, elapsed)
        print(json.dumps({"stage": directory.name, **summary}), flush=True)
        return summary


def check():
    schema = {
        "type": "object",
        "properties": {"x": {"type": "integer"}},
        "required": ["x"],
        "additionalProperties": False,
    }
    row = {
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
            "temperature": 0,
            "response_format": {"json_schema": {"name": "test", "schema": schema}},
        },
    }
    converted = convert(row, "schema")
    assert converted["body"]["input"][0]["content"] == "keep me"
    assert converted["body"]["input"][1]["content"] == [
        {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
        {"type": "input_text", "text": "unchanged"},
    ]
    assert converted["body"]["reasoning"] == {"effort": "none"}
    plain = page_request("page", "data:image/png;base64,AAAA")
    assert len(plain["body"]["input"]) == 1
    assert plain["body"]["input"][0]["content"][1]["text"] == PAGE_PROMPT
    assert plain["body"]["text"]["format"] == {"type": "text"}
    assert plain["body"]["reasoning"] == {"effort": "none"}
    region = page_request("crop", "data:image/png;base64,AAAA", REGION_PROMPT)
    assert region["body"]["input"][0]["content"][1]["text"] == REGION_PROMPT
    assert (
        region["body"]["input"][0]["content"][0]
        == plain["body"]["input"][0]["content"][0]
    )
    record = {
        "status": "received",
        "response": {
            "status_code": 200,
            "body": {
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": "raw facts"}],
                    }
                ],
            },
        },
    }
    assert validate(record, plain)["value"]["markdown"] == "raw facts"
    record["response"]["body"]["output"][0]["content"][0]["text"] = " "
    assert validate(record, plain)["error"]["kind"] == "empty_text"
    assert not evidence_check({"evidence": "a ... b"}, "a first b")["exact_contiguous"]
    assert evidence_check({"evidence": "a b"}, "a\nb")["whitespace_contiguous"]
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "content": [{"type": "output_text", "text": '{"x":"wrong"}'}],
                    }
                ],
                "usage": {"input_tokens": 1, "output_tokens": 2},
            },
        )

    with TemporaryDirectory() as tmp:
        directory = Path(tmp)
        freeze(directory, [converted], {"mode": "schema"})
        first = run(directory, "test-key", 1, 1, httpx.MockTransport(handler))
        assert first["usage"]["reasoning_tokens"] is None
        assert first["usage_reported_requests"]["reasoning_tokens"] == 0
        assert first["usage"]["cached_tokens"] is None
        assert (
            read_json(directory / "results.json")["failed"]["test"]["error"]["kind"]
            == "invalid_schema"
        )
        replay = run(directory, "test-key", 1, 1, httpx.MockTransport(handler))
        assert replay["elapsed_seconds"] == first["elapsed_seconds"]
        assert replay["request_span_seconds"] == first["request_span_seconds"]
        assert len(calls) == 1, "An existing invalid output must never be retried"
    print(
        "DeepSeek conversion, exact evidence, schema validation and no-retry checks passed"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "stage",
        choices=["prepare", "probe", "crops", "tags", "summaries", "pages", "check"],
    )
    parser.add_argument(
        "--mode",
        choices=[
            "schema",
            "schema-strict",
            "json-object",
            "page-prompt",
            "region-prompt",
        ],
        default="schema",
    )
    parser.add_argument(
        "--reasoning",
        choices=["none", "low", "high", "max"],
        default="none",
        help="DeepSeek Responses reasoning.effort; thinking is off by default",
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.stage == "check":
        check()
        return
    if not 1 <= args.workers <= 4 or not 1 <= args.timeout <= 600:
        raise PilotError("Use 1–4 workers and a timeout of 1–600 seconds")
    directory = BASE / f"deepseek-{args.mode}"
    if args.reasoning != "none":
        directory = BASE / f"deepseek-{args.mode}-think-{args.reasoning}"
    if args.mode in {"page-prompt", "region-prompt"}:
        if args.stage not in {"prepare", "crops", "pages"}:
            raise PilotError("Page prompt supports prepare, crops and pages only")
        if args.mode == "region-prompt" and args.stage == "pages":
            raise PilotError("Region prompt uses the frozen crops only")
        prepare_page_prompt(directory, args.mode)
    else:
        if args.stage == "pages":
            raise PilotError("Full pages require page-prompt mode")
        prepare(directory, args.mode, args.reasoning)
    if args.stage == "prepare":
        print(f"Frozen inputs saved to {directory}")
        return
    key = dotenv_values(ROOT / "data/knowledge-base-pilot/secrets.env").get(
        "DEEPSEEK_API_KEY"
    )
    if not key:
        raise PilotError("Missing DEEPSEEK_API_KEY in local secrets file")
    run(directory / args.stage, key, args.workers, args.timeout)


if __name__ == "__main__":
    try:
        main()
    except PilotError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
