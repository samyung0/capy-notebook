"""Durable Alibaba Batch submit/collect. Never issues synchronous model calls."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
from pathlib import Path

import httpx
import requests

MODEL = "qwen3.8-flash"
BASE_URL = "https://ws-4xvo9o0v8ridgyd8.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
TERMINAL = {"completed", "failed", "expired", "cancelled"}


class PilotError(RuntimeError):
    """Safe-to-print errors, without provider request bodies or credentials."""


class BatchTransportError(PilotError):
    """An uncertain transport outcome; only read operations may be polled again."""


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


@contextlib.contextmanager
def lock(path: Path):
    """A crashed process leaves a visible lock; do not guess whether it is safe."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise PilotError(
            f"Concurrent or interrupted command: inspect {path} before removing its lock"
        ) from None
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        path.unlink(missing_ok=True)


def request(custom_id: str, messages: list[dict], max_tokens: int) -> dict:
    return {
        "custom_id": custom_id,
        "method": "POST",
        "url": "/v1/chat/completions",
        "body": {
            "model": MODEL,
            "messages": messages,
            "enable_thinking": False,
            "temperature": 0,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        },
    }


def prepare(directory: Path, requests: list[dict]) -> dict:
    if not requests or len(requests) > 50000:
        raise PilotError("A batch needs 1–50,000 requests")
    ids = [row["custom_id"] for row in requests]
    if len(ids) != len(set(ids)) or any(len(x) > 256 for x in ids):
        raise PilotError("Batch custom IDs must be unique and at most 256 characters")
    lines = [
        json.dumps(row, ensure_ascii=False, allow_nan=False).encode()
        for row in requests
    ]
    if any(len(line) > 1_000_000 for line in lines):
        raise PilotError("A batch line exceeds Alibaba's 1 MB limit")
    payload = b"\n".join(lines) + b"\n"
    if len(payload) > 500_000_000:
        raise PilotError("Batch exceeds Alibaba's 500 MB limit")
    fingerprint = hashlib.sha256(payload).hexdigest()
    state_path = directory / "state.json"
    if state_path.exists():
        state = read_json(state_path)
        if state["input_sha256"] != fingerprint:
            raise PilotError(
                "Batch input changed. Use a new stage directory; existing jobs are immutable"
            )
        return state
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "input.jsonl").write_bytes(payload)
    state = {
        "input_sha256": fingerprint,
        "request_ids": ids,
        "status": "prepared",
        "model": MODEL,
        "base_url": BASE_URL,
    }
    save_json(state_path, state)
    return state


def shard_unsubmitted(directory: Path, size: int) -> dict:
    """Split an upload failure before any create request could have occurred."""
    with lock(directory / "command.lock"):
        state = read_json(directory / "state.json")
        if (
            state.get("batch_id")
            or state.get("input_file_id")
            or state["status"] not in {"prepared", "uploading"}
        ):
            raise PilotError(
                "Only an unsubmitted batch without a file receipt may be sharded"
            )
        if size <= 0:
            raise PilotError("Shard size must be positive")
        rows = [
            json.loads(line)
            for line in (directory / "input.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        shards = []
        for start in range(0, len(rows), size):
            name = f"part-{start // size:03d}"
            prepare(directory / name, rows[start : start + size])
            shards.append(name)
        save_json(directory / "pre-shard-state.json", state)
        state.update(shards=shards, status="prepared_shards")
        save_json(directory / "state.json", state)
        return state


class BatchClient:
    def __init__(self, key: str, *, transport=None):
        if not key:
            raise PilotError("Missing ALIBABA_API_KEY in the local secrets file")
        self.http = httpx.Client(
            base_url=BASE_URL,
            headers={"Authorization": f"Bearer {key}"},
            timeout=120,
            transport=transport,
        )

    def close(self):
        self.http.close()

    def call(self, method: str, path: str, **kwargs):
        try:
            response = self.http.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise BatchTransportError(
                f"Alibaba transport failed: {type(exc).__name__}; inspect saved batch state"
            ) from None
        return self.checked_response(response)

    @staticmethod
    def checked_response(response):
        if response.status_code >= 300:
            # Provider error messages may echo requests; only expose a bounded code.
            code = "unknown"
            try:
                raw = response.json().get("error", {}).get("code", "unknown")
                if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", str(raw)):
                    code = str(raw)
            except (ValueError, AttributeError):
                pass
            raise PilotError(f"Alibaba HTTP {response.status_code}, code {code}")
        return response

    def upload(self, payload: bytes, filename: str) -> dict:
        # requests completed the same payload that timed out through httpx in
        # the local diagnostic. Network errors remain explicit and resumable.
        try:
            response = requests.post(
                BASE_URL + "/files",
                headers={"Authorization": self.http.headers["Authorization"]},
                data={"purpose": "batch"},
                files={"file": (filename, payload, "application/jsonl")},
                timeout=(30, 180),
            )
        except requests.RequestException as exc:
            raise BatchTransportError(
                f"Alibaba upload failed: {type(exc).__name__}; inspect saved upload state"
            ) from None
        return self.checked_response(response).json()

    def recover(self, directory: Path) -> dict:
        """Only attach a matching existing job; never infer permission to resubmit."""
        state = read_json(directory / "state.json")
        if state.get("shards"):
            for name in state["shards"]:
                child = directory / name
                child_state = read_json(child / "state.json")
                if child_state["status"] in {"uploading", "submitting"}:
                    self.recover(child)
            return state
        if state.get("batch_id"):
            return state
        if state["status"] == "uploading" and not state.get("input_file_id"):
            files = self.call("GET", "/files", params={"purpose": "batch"}).json()
            matches = [
                row
                for row in files.get("data") or []
                if row.get("filename") == f"capy-kb-{state['input_sha256']}.jsonl"
            ]
            if len(matches) != 1 or files.get("has_more"):
                raise PilotError(
                    "Interrupted upload could not be uniquely reconciled; no file or job resubmitted"
                )
            state.update(input_file_id=matches[0]["id"], status="prepared")
            save_json(directory / "state.json", state)
            return state
        matches, after = [], None
        while True:
            params = {"limit": 100}
            if after:
                params["after"] = after
            page = self.call("GET", "/batches", params=params).json()
            for row in page.get("data") or []:
                metadata = row.get("metadata") or {}
                same_hash = (
                    metadata.get("ds_description", metadata.get("input_sha256"))
                    == state["input_sha256"]
                )
                same_file = row.get("input_file_id") == state.get(
                    "input_file_id"
                ) and bool(state.get("input_file_id"))
                if (same_hash or same_file) and row.get(
                    "endpoint", "/v1/chat/completions"
                ) == "/v1/chat/completions":
                    matches.append(row)
            if not page.get("has_more"):
                break
            rows = page.get("data") or []
            if not rows or rows[-1]["id"] == after:
                raise PilotError("Batch listing pagination did not advance")
            after = rows[-1]["id"]
        if len(matches) != 1:
            raise PilotError(
                f"Reconciliation found {len(matches)} matching jobs; no job resubmitted"
            )
        state.update(batch_id=matches[0]["id"], status=matches[0]["status"])
        save_json(directory / "state.json", state)
        return state

    def submit(self, directory: Path) -> dict:
        with lock(directory / "command.lock"):
            path = directory / "state.json"
            state = read_json(path)
            if state.get("shards"):
                jobs = [self.submit(directory / name) for name in state["shards"]]
                state.update(
                    status="submitted_shards"
                    if all(job.get("batch_id") for job in jobs)
                    else "awaiting_shards",
                    batch_ids=[job["batch_id"] for job in jobs if job.get("batch_id")],
                    batch_id=f"shards-{state['input_sha256'][:16]}",
                )
                save_json(path, state)
                return state
            if state.get("batch_id"):
                return state
            if state["status"] in {"submitting", "uploading"}:
                return self.recover(directory)
            if state["status"] != "prepared":
                raise PilotError(f"Cannot submit stage with status {state['status']}")
            payload = (directory / "input.jsonl").read_bytes()
            if hashlib.sha256(payload).hexdigest() != state["input_sha256"]:
                raise PilotError("Batch input checksum changed")
            if not state.get("input_file_id"):
                state["status"] = "uploading"
                save_json(path, state)
                uploaded = self.upload(
                    payload, f"capy-kb-{state['input_sha256']}.jsonl"
                )
                state.update(input_file_id=uploaded["id"], status="prepared")
                save_json(path, state)
            state["status"] = "submitting"
            save_json(path, state)
            try:
                created = self.call(
                    "POST",
                    "/batches",
                    json={
                        "input_file_id": state["input_file_id"],
                        "endpoint": "/v1/chat/completions",
                        "completion_window": "24h",
                        "metadata": {
                            "ds_name": f"capy-kb-{directory.name}-{state['input_sha256'][:12]}",
                            "ds_description": state["input_sha256"],
                        },
                    },
                ).json()
                if (
                    not isinstance(created, dict)
                    or not created.get("id")
                    or not created.get("status")
                ):
                    raise PilotError("Alibaba create response omitted batch id/status")
            except PilotError as exc:
                state["submission_error"] = str(exc)
                save_json(path, state)
                raise
            state.update(batch_id=created["id"], status=created["status"])
            save_json(path, state)
            return state

    def collect(self, directory: Path) -> dict:
        with lock(directory / "command.lock"):
            path = directory / "state.json"
            state = read_json(path)
            if state.get("shards"):
                jobs = [self.collect(directory / name) for name in state["shards"]]
                combined = {"success": {}, "failed": {}, "missing": []}
                for name in state["shards"]:
                    result_path = directory / name / "results.json"
                    if result_path.exists():
                        values = read_json(result_path)
                        for kind in ("success", "failed"):
                            if set(combined[kind]) & set(values[kind]):
                                raise PilotError(
                                    "Duplicate request across batch shards"
                                )
                            combined[kind].update(values[kind])
                combined["missing"] = sorted(
                    set(state["request_ids"])
                    - set(combined["success"])
                    - set(combined["failed"])
                )
                save_json(directory / "results.json", combined)
                complete = all(job.get("complete") for job in jobs)
                failed = any(
                    job["status"] in TERMINAL and not job.get("complete")
                    for job in jobs
                )
                state.update(
                    complete=complete,
                    status="completed"
                    if complete
                    else "failed_shards"
                    if failed
                    else "in_progress_shards",
                    collection={key: len(combined[key]) for key in combined},
                    shard_statuses=[
                        {
                            "name": name,
                            "status": job["status"],
                            "request_counts": job.get("request_counts", {}),
                        }
                        for name, job in zip(state["shards"], jobs)
                    ],
                )
                save_json(path, state)
                return state
            if not state.get("batch_id"):
                raise PilotError(
                    "No recorded batch ID; submit or reconcile the stage first"
                )
            job = self.call("GET", f"/batches/{state['batch_id']}").json()
            state.update(
                status=job["status"], request_counts=job.get("request_counts", {})
            )
            for key in (
                "output_file_id",
                "error_file_id",
                "created_at",
                "completed_at",
                "failed_at",
                "expires_at",
            ):
                if job.get(key) is not None:
                    state[key] = job[key]
            save_json(path, state)
            if state["status"] not in TERMINAL:
                return state
            records = []
            for key, filename in (
                ("output_file_id", "output.jsonl"),
                ("error_file_id", "errors.jsonl"),
            ):
                if job.get(key):
                    dest = directory / filename
                    if not dest.exists():
                        payload = self.call("GET", f"/files/{job[key]}/content").content
                        tmp = dest.with_suffix(".tmp")
                        tmp.write_bytes(payload)
                        tmp.replace(dest)
                    records.extend(
                        json.loads(line)
                        for line in dest.read_text(encoding="utf-8").splitlines()
                        if line.strip()
                    )
            validation = validate_records(state["request_ids"], records)
            save_json(directory / "results.json", validation)
            state["collection"] = {
                key: len(validation[key]) for key in ("success", "failed", "missing")
            }
            state["complete"] = (
                state["status"] == "completed"
                and not validation["failed"]
                and not validation["missing"]
            )
            save_json(path, state)
            return state


def validate_records(expected: list[str], records: list[dict]) -> dict:
    wanted, seen = set(expected), set()
    result = {"success": {}, "failed": {}, "missing": []}
    for row in records:
        custom_id = row.get("custom_id")
        if custom_id not in wanted or custom_id in seen:
            raise PilotError("Batch returned an unknown or duplicate custom ID")
        seen.add(custom_id)
        response = row.get("response") or {}
        body = response.get("body") or {}
        choices = body.get("choices") or []
        if row.get("error") or response.get("status_code") != 200 or not choices:
            result["failed"][custom_id] = {
                "status_code": response.get("status_code"),
                "kind": "provider_error",
            }
            continue
        choice = choices[0]
        if choice.get("finish_reason") != "stop":
            result["failed"][custom_id] = {
                "kind": "incomplete_output",
                "finish_reason": choice.get("finish_reason"),
            }
            continue
        try:
            value = json.loads(choice["message"]["content"])
            if not isinstance(value, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            result["failed"][custom_id] = {"kind": "invalid_json"}
            continue
        result["success"][custom_id] = {
            "value": value,
            "usage": body.get("usage", {}),
            "request_id": response.get("request_id"),
        }
    result["missing"] = sorted(wanted - seen)
    return result
