"""Replay the archived Jev requests on Alibaba's decision-model-preview API.

Uses a persistent HTTPS connection per worker, with no retries. Keys stay in
memory. Responses, usage and client/server latency are saved one request per
line. The CPU replay's prepared dataset and score calculations are reused.
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from laya_cpu import digest, read_rows, report, select


def load_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def run(args):
    values = load_env(args.env)
    key = values[args.key_var]
    endpoint = values[args.url_var].rstrip("/") + "/systemone"
    url = urlsplit(endpoint)
    if (
        url.scheme != "https"
        or not url.hostname
        or not url.hostname.endswith(".maas.aliyuncs.com")
        or url.path != "/compatible-mode/v1/systemone"
        or url.query
        or url.username
    ):
        raise ValueError(
            "Expected the documented Alibaba workspace System One endpoint"
        )
    if not key:
        raise ValueError("The selected API key is empty")
    jobs = select(read_rows(args.dataset), args.suite, args.pilot, args.limit)
    if not jobs:
        raise ValueError("No requests selected")
    connections = []
    local = threading.local()
    tls = ssl.create_default_context()

    def call(job):
        start = time.perf_counter()
        try:
            if not hasattr(local, "connection"):
                local.connection = http.client.HTTPSConnection(
                    url.hostname, timeout=60, context=tls
                )
                connections.append(local.connection)
            body = json.dumps(
                {
                    "model": "decision-model-preview",
                    "state": job["state"],
                    "questions": job["questions"],
                },
                ensure_ascii=False,
            ).encode("utf-8")
            local.connection.request(
                "POST",
                url.path,
                body=body,
                headers={
                    "Authorization": "Bearer " + key,
                    "Content-Type": "application/json",
                },
            )
            response = local.connection.getresponse()
            raw = response.read()
            elapsed = time.perf_counter() - start
            if response.status != 200:
                raise ValueError(
                    f"HTTP {response.status}: {raw.decode(errors='replace')[:1000]}"
                )
            payload = json.loads(raw)
            if set(payload["answers"]) != set(job["questions"]):
                raise ValueError("Response question ids do not match the request")
            scores = [payload["answers"][k]["noul"] for k in job["keys"]]
            if not all(
                type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1
                for v in scores
            ):
                raise ValueError("Invalid probability")
            return {
                "type": "result",
                "id": job["id"],
                "scores": scores,
                "latency_s": elapsed,
                "response": payload,
            }
        except Exception as error:  # noqa: BLE001 - record the failure, without retrying it.
            if hasattr(local, "connection"):
                local.connection.close()
                del local.connection
            return {
                "type": "result",
                "id": job["id"],
                "latency_s": time.perf_counter() - start,
                "error": str(error).replace(key, "[redacted]"),
            }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    try:
        with args.output.open("x", encoding="utf-8", buffering=1) as handle:
            manifest = {
                "type": "manifest",
                "model": "decision-model-preview",
                "endpoint": endpoint,
                "started_utc": datetime.now(timezone.utc).isoformat(),
                "parallel": args.parallel,
                "planned": len(jobs),
                "dataset_sha256": digest(args.dataset),
                "script_sha256": digest(Path(__file__)),
                "retries": 0,
                "client": "stdlib http.client, one persistent TLS connection per worker",
            }
            handle.write(json.dumps(manifest) + "\n")
            failures = 0
            with ThreadPoolExecutor(max_workers=args.parallel) as pool:
                for i, result in enumerate(pool.map(call, jobs), 1):
                    failures += "error" in result
                    handle.write(json.dumps(result, ensure_ascii=False) + "\n")
                    if i % 100 == 0:
                        print(
                            json.dumps(
                                {
                                    "done": i,
                                    "total": len(jobs),
                                    "failures": failures,
                                    "wall_s": round(time.perf_counter() - start, 1),
                                }
                            ),
                            flush=True,
                        )
            handle.write(
                json.dumps(
                    {
                        "type": "complete",
                        "completed": len(jobs),
                        "failures": failures,
                        "wall_s": time.perf_counter() - start,
                        "finished_utc": datetime.now(timezone.utc).isoformat(),
                    }
                )
                + "\n"
            )
    finally:
        for connection in connections:
            connection.close()
    report(args.dataset, args.output, candidate_label="alibaba")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--key-var", required=True)
    parser.add_argument("--url-var", required=True)
    parser.add_argument("--parallel", type=int, choices=range(1, 9), required=True)
    parser.add_argument(
        "--suite", choices=("rubric", "route", "math", "equiv", "units", "algebra")
    )
    parser.add_argument("--pilot", action="store_true")
    parser.add_argument("--limit", type=int)
    run(parser.parse_args())


if __name__ == "__main__":
    main()
