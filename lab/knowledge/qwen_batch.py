"""Optional Qwen book reviews: freeze packets, submit once, poll and save advice.

No library writes, automatic repairs, model fallback or synchronous inference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from dotenv import dotenv_values
from jsonschema import ValidationError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
import knowledge_base_batch as batch
import knowledge_review_samples as samples

POLL_SECONDS = 600
PROMPT_FILES = ("system-prompt.txt", "request-settings.json", "response-schema.json")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def prepare(directory: Path, packets: list[Path], *, thinking: bool) -> dict:
    """Offline preparation. Originals may subsequently change or disappear."""
    if not packets:
        raise batch.PilotError("Supply at least one saved book-review packet")
    directory.mkdir(parents=True, exist_ok=False)
    frozen = directory / "prompt"
    frozen.mkdir()
    bindings = {}
    for name in PROMPT_FILES:
        data = (samples.FIXTURES / name).read_bytes()
        (frozen / name).write_bytes(data)
        bindings[f"prompt/{name}"] = sha256(data)
    rows, entries, cases = [], [], set()
    (directory / "packets").mkdir()
    for number, path in enumerate(packets, 1):
        data = path.read_bytes()
        packet = json.loads(data)
        case_id = packet["case_id"]
        if not isinstance(case_id, str) or not case_id or case_id in cases:
            raise batch.PilotError("Packet case IDs must be nonempty and unique")
        cases.add(case_id)
        custom_id = f"review-{number:06d}-{sha256(data)[:12]}"
        relative = f"packets/{custom_id}.json"
        (directory / relative).write_bytes(data)
        bindings[relative] = sha256(data)
        body = samples.build_request(packet, frozen, enable_thinking=thinking)
        if body["model"] != "qwen3.8-max" or any(
            key in body
            for key in ("max_tokens", "max_completion_tokens", "thinking_budget")
        ):
            raise batch.PilotError(
                "Book review requires Qwen3.8-Max without caller token caps"
            )
        rows.append(
            {
                "custom_id": custom_id,
                "method": "POST",
                "url": "/v1/chat/completions",
                "body": body,
            }
        )
        entries.append({"custom_id": custom_id, "case_id": case_id, "packet": relative})
    state = batch.prepare(directory, rows, base_url="")
    bindings["input.jsonl"] = state["input_sha256"]
    manifest = {
        "format": "qwen-book-review-batch-v1",
        "created_at": time.time(),
        "model": state["model"],
        "enable_thinking": thinking,
        "advisory_only": True,
        "requests": entries,
        "sha256": bindings,
    }
    batch.save_json(directory / "manifest.json", manifest)
    return manifest


def verify_inputs(directory: Path) -> dict:
    manifest = batch.read_json(directory / "manifest.json")
    if manifest["format"] != "qwen-book-review-batch-v1":
        raise batch.PilotError("Unknown review batch format")
    for name, expected in manifest["sha256"].items():
        if sha256((directory / name).read_bytes()) != expected:
            raise batch.PilotError(
                f"Frozen batch input changed: {name}; use a new directory"
            )
    state = batch.read_json(directory / "state.json")
    if state["input_sha256"] != manifest["sha256"]["input.jsonl"] or state[
        "request_ids"
    ] != [row["custom_id"] for row in manifest["requests"]]:
        raise batch.PilotError("Batch state does not match its frozen manifest")
    return manifest


def client_for(directory: Path, env_file: Path | None) -> batch.BatchClient:
    config = dict(dotenv_values(env_file)) if env_file else {}
    config.update(
        {
            key: os.environ[key]
            for key in ("ALIBABA_API_KEY", "ALIBABA_BASE_URL")
            if key in os.environ
        }
    )
    key, base = config.get("ALIBABA_API_KEY"), config.get("ALIBABA_BASE_URL")
    if not key or not base:
        raise batch.PilotError(
            "Provide ALIBABA_API_KEY and ALIBABA_BASE_URL through --env-file or environment"
        )
    base = base.rstrip("/")
    state = batch.read_json(directory / "state.json")
    if state["base_url"] and state["base_url"] != base:
        raise batch.PilotError(
            "ALIBABA_BASE_URL differs from this batch's saved endpoint"
        )
    if not state["base_url"]:
        state["base_url"] = base
        batch.save_json(directory / "state.json", state)
    return batch.BatchClient(key, base_url=base)


def collect_reviews(directory: Path, manifest: dict) -> dict:
    """Keep every response, including invalid or incomplete advice, for later triage."""
    state = batch.read_json(directory / "state.json")
    results = batch.read_json(directory / "results.json")
    records = {}
    for name in ("output.jsonl", "errors.jsonl"):
        path = directory / name
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    record = json.loads(line)
                    records[record["custom_id"]] = record
    rows = []
    for entry in manifest["requests"]:
        cid = entry["custom_id"]
        record = records.get(cid)
        folder = directory / "responses" / cid
        folder.mkdir(parents=True, exist_ok=True)
        receipt = {**entry, "adjudication": "pending", "usage": None}
        if record is None:
            receipt.update(result="missing", contract_check="not_checked")
        else:
            batch.save_json(folder / "response.json", record)
            body = (record.get("response") or {}).get("body") or {}
            receipt["usage"] = body.get("usage")
            receipt["model"] = body.get("model")
            receipt["result"] = (
                "returned"
                if cid in results["success"]
                else results["failed"][cid]["kind"]
            )
            receipt["contract_check"] = "not_checked"
            try:
                review = json.loads(body["choices"][0]["message"]["content"])
            except (KeyError, IndexError, TypeError, ValueError):
                review = None
            if review is not None:
                batch.save_json(folder / "review.json", review)
                try:
                    samples.validate_review(
                        review,
                        batch.read_json(directory / entry["packet"]),
                        directory / "prompt",
                    )
                except (ValidationError, ValueError) as exc:
                    receipt.update(
                        contract_check="warning",
                        contract_warning=str(
                            exc.message if isinstance(exc, ValidationError) else exc
                        ),
                    )
                else:
                    receipt.update(
                        contract_check="passed",
                        review_status=review["review_status"],
                        findings=len(review["findings"]),
                    )
        batch.save_json(folder / "receipt.json", receipt)
        rows.append(receipt)
    summary = {
        "batch_id": state["batch_id"],
        "provider_status": state["status"],
        "advisory_only": True,
        "responses": rows,
        "counts": {
            kind: sum(r["result"] == kind for r in rows)
            for kind in {r["result"] for r in rows}
        },
        "contract_warnings": sum(r["contract_check"] == "warning" for r in rows),
    }
    batch.save_json(directory / "summary.json", summary)
    return summary


def poll(directory: Path, client: batch.BatchClient, *, watch: bool) -> dict:
    manifest = verify_inputs(directory)
    while True:
        try:
            state = client.collect(directory)
        except batch.BatchTransportError as exc:
            batch.save_json(
                directory / "poll.json",
                {
                    "checked_at": time.time(),
                    "error": str(exc),
                    "next_poll_seconds": POLL_SECONDS if watch else None,
                },
            )
            if not watch:
                raise
            print(
                f"Status check failed; next read in {POLL_SECONDS} seconds.", flush=True
            )
        else:
            batch.save_json(
                directory / "poll.json",
                {
                    "checked_at": time.time(),
                    "status": state["status"],
                    "request_counts": state.get("request_counts"),
                    "next_poll_seconds": POLL_SECONDS
                    if watch and state["status"] not in batch.TERMINAL
                    else None,
                },
            )
            print(
                json.dumps(
                    {
                        "batch_id": state["batch_id"],
                        "status": state["status"],
                        "request_counts": state.get("request_counts"),
                    }
                ),
                flush=True,
            )
            if state["status"] in batch.TERMINAL:
                collect_reviews(directory, manifest)
                return state
            if not watch:
                return state
        time.sleep(POLL_SECONDS)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser(
        "prepare", help="Freeze saved packets and strict JSON requests offline"
    )
    prep.add_argument("--packets", type=Path, nargs="+", required=True)
    prep.add_argument("--run", type=Path, required=True)
    mode = prep.add_mutually_exclusive_group(required=True)
    mode.add_argument("--thinking", dest="thinking", action="store_true")
    mode.add_argument("--no-thinking", dest="thinking", action="store_false")
    for name in ("submit", "poll"):
        sub = commands.add_parser(name)
        sub.add_argument("--run", type=Path, required=True)
        sub.add_argument("--env-file", type=Path)
        if name == "poll":
            sub.add_argument(
                "--watch",
                action="store_true",
                help="Poll every 600 seconds until terminal; Ctrl+C stops local polling",
            )
    args = parser.parse_args(argv)
    if args.command == "prepare":
        manifest = prepare(args.run, args.packets, thinking=args.thinking)
        print(
            f"Prepared {len(manifest['requests'])} reviews in {args.run}; nothing sent."
        )
        return 0
    with batch.lock(args.run / "review-command.lock"):
        manifest = verify_inputs(args.run)
        state = batch.read_json(args.run / "state.json")
        if (
            args.command == "poll"
            and state["status"] in batch.TERMINAL
            and "collection" in state
        ):
            collect_reviews(args.run, manifest)
        else:
            client = client_for(args.run, args.env_file)
            try:
                if args.command == "submit":
                    state = client.submit(args.run)
                    print(
                        json.dumps(
                            {
                                "batch_id": state.get("batch_id"),
                                "status": state["status"],
                            }
                        ),
                        flush=True,
                    )
                else:
                    state = poll(args.run, client, watch=args.watch)
            finally:
                client.close()
    # Content findings and contract warnings remain advice. Only failed/missing
    # provider output makes collection unsuccessful.
    return int(
        args.command == "poll"
        and state["status"] in batch.TERMINAL
        and not state.get("complete")
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (batch.PilotError, FileExistsError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        print(
            "Local polling stopped; the remote batch is unchanged. Rerun poll --watch to resume.",
            file=sys.stderr,
        )
        raise SystemExit(130) from None
