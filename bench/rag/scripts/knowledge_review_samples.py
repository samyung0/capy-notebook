"""Build or send one text-only Qwen book review; no library writes or retries."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values
from jsonschema import validate

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "knowledge-review-v2"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_case(case_id: str) -> dict:
    if case_id not in read_json(FIXTURES / "manifest.json")["case_ids"]:
        raise ValueError(f"Unknown case: {case_id}")
    return read_json(FIXTURES / "cases" / f"{case_id}.json")


def build_request(
    packet: dict, fixtures: Path = FIXTURES, *, enable_thinking: bool | None = None
) -> dict:
    """The answer key is deliberately not loaded into a request."""
    settings = read_json(fixtures / "request-settings.json")
    if enable_thinking is not None:
        settings["enable_thinking"] = enable_thinking
    schema = read_json(fixtures / "response-schema.json")
    schema["properties"]["findings"]["items"]["properties"]["category"]["enum"] = (
        packet["assignment"]["fields"]
    )
    prompt = (fixtures / "system-prompt.txt").read_text(encoding="utf-8")
    return {
        **settings,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "book_review", "strict": True, "schema": schema},
        },
        "messages": [
            {
                "role": "system",
                "content": prompt + "\nResponse JSON schema:\n" + json.dumps(schema),
            },
            {"role": "user", "content": json.dumps(packet, ensure_ascii=False)},
        ],
    }


def validate_review(review: dict, packet: dict, fixtures: Path = FIXTURES) -> None:
    validate(review, read_json(fixtures / "response-schema.json"))
    if review["case_id"] != packet["case_id"]:
        raise ValueError("Review belongs to a different case")
    targets = set(packet["assignment"]["target_ids"])
    if set(review["reviewed_ids"]) != targets or len(review["reviewed_ids"]) != len(
        targets
    ):
        raise ValueError("Review must account for every assigned target")
    excerpts = {
        excerpt["excerpt_id"]: excerpt["text"]
        for excerpt in packet["source"]["excerpts"]
    }
    for row in review["findings"] + review["missing_evidence"]:
        if len(row["target_ids"]) != len(set(row["target_ids"])):
            raise ValueError("Duplicate finding or missing-evidence targets")
    for finding in review["findings"]:
        if finding["category"] not in packet["assignment"]["fields"]:
            raise ValueError("Finding category is outside assigned fields")
        if not set(finding["target_ids"]).issubset(targets):
            raise ValueError("Unknown finding target")
        for evidence in finding["evidence"]:
            source_text = excerpts.get(evidence["excerpt_id"])
            if source_text is None or evidence["quote"] not in source_text:
                raise ValueError("Evidence must quote a supplied source excerpt")
    for missing in review["missing_evidence"]:
        if not set(missing["target_ids"]).issubset(targets):
            raise ValueError("Unknown missing-evidence target")
    expected_status = (
        "incomplete"
        if review["missing_evidence"]
        else "needs_changes"
        if review["findings"]
        else "pass"
    )
    if review["review_status"] != expected_status:
        raise ValueError("Status must agree with findings and missing evidence")


def write_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--case")
    source.add_argument("--packet", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument(
        "--thinking", action="store_const", const=True, default=None,
        help="Enable thinking for this comparison; leave fixture settings unchanged.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--send", action="store_true")
    args = parser.parse_args(argv)
    packet = read_json(args.packet) if args.packet else load_case(args.case)
    body = build_request(packet, enable_thinking=args.thinking)
    args.output.mkdir(parents=True, exist_ok=False)
    write_json(args.output / "request.json", body)
    request_hash = hashlib.sha256(
        (args.output / "request.json").read_bytes()
    ).hexdigest()
    receipt = {
        "case_id": packet["case_id"],
        "request_sha256": request_hash,
        "sent": False,
    }
    if args.dry_run:
        write_json(args.output / "receipt.json", receipt)
        print(
            f"Dry run: {args.output / 'request.json'}; no credentials read or request sent."
        )
        return 0

    config = dict(dotenv_values(args.env_file)) if args.env_file else {}
    config.update(
        {
            key: os.environ[key]
            for key in ("ALIBABA_API_KEY", "ALIBABA_BASE_URL")
            if key in os.environ
        }
    )
    key = config.get("ALIBABA_API_KEY")
    base = config.get("ALIBABA_BASE_URL")
    if not key or not base:
        raise ValueError(
            "Provide ALIBABA_API_KEY and ALIBABA_BASE_URL through --env-file or environment"
        )
    started = time.monotonic()
    receipt.update(attempted=True, sent=None)
    write_json(args.output / "receipt.json", receipt)
    try:
        with httpx.Client(timeout=600, follow_redirects=False) as client:
            response = client.post(
                base.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json=body,
            )
    except httpx.HTTPError as exc:
        receipt.update(
            error=type(exc).__name__, elapsed_seconds=time.monotonic() - started
        )
        write_json(args.output / "receipt.json", receipt)
        raise RuntimeError(
            "Provider request failed; receipt saved; no retry was attempted"
        ) from None
    receipt.update(
        sent=True,
        status_code=response.status_code,
        elapsed_seconds=time.monotonic() - started,
    )
    write_json(args.output / "receipt.json", receipt)
    if response.is_error:
        (args.output / "provider-error.txt").write_text(
            response.text.replace(key, "[REDACTED]"), encoding="utf-8"
        )
        raise RuntimeError(
            f"Provider returned HTTP {response.status_code}; no retry or model fallback was attempted"
        )
    result = response.json()
    write_json(args.output / "response.json", result)
    receipt.update(model=result.get("model"), usage=result.get("usage"))
    write_json(args.output / "receipt.json", receipt)
    review = json.loads(result["choices"][0]["message"]["content"])
    validate_review(review, packet)
    write_json(args.output / "review.json", review)
    print(
        f"Saved {args.output / 'review.json'}. Schema/coverage checked; compare against expected-findings.json yourself."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
