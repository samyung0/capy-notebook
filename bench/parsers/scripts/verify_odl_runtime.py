"""Measure an explicitly supplied LOCAL parser: one document or a FIFO burst.

The caller owns the disposable container and its limits. This script never
starts services or changes a host. Each run writes a new evidence directory.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import urlparse

import pymupdf
import requests


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", required=True)
    p.add_argument("--spool", type=Path, required=True)
    p.add_argument("--pdf", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--container", required=True)
    p.add_argument(
        "--mode", choices=["single", "queue", "timeout", "oom"], required=True
    )
    args = p.parse_args()
    if urlparse(args.url).hostname not in {"127.0.0.1", "localhost", "::1"}:
        p.error("only a loopback parser is allowed")
    args.output.mkdir(parents=True, exist_ok=False)
    base = args.url.rstrip("/")
    health = requests.get(base + "/healthz", timeout=5).json()
    assert health["ok"], health
    version = health["parser_version"]
    depth = health["queue_depth"]
    schema = "capy-parser-bundle-v3"
    (args.output / "initial-health.json").write_text(json.dumps(health, indent=2))
    source = args.pdf.read_bytes()
    with pymupdf.open(stream=source, filetype="pdf") as doc:
        pages = len(doc)

    def body(number):
        data = source
        if args.mode == "queue":
            with pymupdf.open(stream=source, filetype="pdf") as doc:
                doc.set_metadata({"title": f"Queue check {args.output.name} {number}"})
                data = doc.tobytes()
        digest = hashlib.sha256(data).hexdigest()
        fingerprint = hashlib.sha256(
            f"{digest}:fast:{version}:{schema}".encode()
        ).hexdigest()
        key = f"sources/{digest}.pdf"
        path = args.spool / key
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        return {
            "source_key": key,
            "source_sha256": digest,
            "output_key": f"artifacts/{fingerprint}.zip",
            "filename": args.pdf.name,
            "artifact_schema": schema,
            "parser_version": version,
            "source_fingerprint": fingerprint,
            "request_id": f"local-{args.output.name}-{number}",
        }

    bodies = [body(i) for i in range(depth + 1 if args.mode == "queue" else 1)]
    (args.output / "requests.json").write_text(json.dumps(bodies, indent=2))
    samples = []
    stopped = threading.Event()

    def sample():
        while not stopped.is_set():
            try:
                samples.append(
                    {
                        "at": time.time(),
                        **requests.get(base + "/healthz", timeout=2).json(),
                    }
                )
            except requests.RequestException:
                pass
            stopped.wait(0.25)

    monitor = threading.Thread(target=sample, daemon=True)
    monitor.start()

    def send(request):
        started = time.monotonic()
        try:
            response = requests.post(base + "/file_parse", json=request, timeout=2500)
            return {
                "status": response.status_code,
                "body": response.json(),
                "seconds": time.monotonic() - started,
            }
        except requests.RequestException as exc:
            return {
                "status": 0,
                "error": str(exc),
                "seconds": time.monotonic() - started,
            }

    results = []
    try:
        if args.mode == "queue":
            with concurrent.futures.ThreadPoolExecutor(max_workers=depth + 1) as pool:
                pending = []
                for index, request in enumerate(bodies[:depth]):
                    pending.append(pool.submit(send, request))
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        state = requests.get(base + "/healthz", timeout=5).json()
                        if state["active_jobs"] == index + 1:
                            break
                        if pending[0].done():
                            raise AssertionError(
                                "queue fixture completed before the queue filled"
                            )
                        time.sleep(0.02)
                    else:
                        raise AssertionError("queue did not reach expected depth")
                refused = send(bodies[depth])
                results = [future.result() for future in pending] + [refused]
        else:
            results = [send(bodies[0])]
    finally:
        stopped.set()
        monitor.join(3)
        (args.output / "health-samples.json").write_text(json.dumps(samples, indent=2))
        (args.output / "responses.json").write_text(json.dumps(results, indent=2))
        for name, command in (
            ("container.json", ["docker", "inspect", args.container]),
            ("container.log", ["docker", "logs", args.container]),
            (
                "cgroup.txt",
                [
                    "docker",
                    "exec",
                    args.container,
                    "sh",
                    "-c",
                    "cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.swap.peak /sys/fs/cgroup/memory.events",
                ],
            ),
        ):
            receipt = subprocess.run(
                command, capture_output=True, text=True, timeout=15, check=False
            )
            (args.output / name).write_text(receipt.stdout + receipt.stderr)
    if args.mode in {"timeout", "oom"}:
        marker = args.spool / "quarantine" / (bodies[0]["source_fingerprint"] + ".json")
        value = json.loads(marker.read_text())
        expected_reason = "parse_oom" if args.mode == "oom" else "parse_hard_timeout"
        assert value["reason"] == expected_reason, value
        assert not (args.spool / bodies[0]["output_key"]).exists()
        (args.output / "quarantine.json").write_text(json.dumps(value, indent=2))
    else:
        accepted = results[:depth] if args.mode == "queue" else results
        bundle_audits = []
        for request, result in zip(bodies, accepted):
            assert result["status"] == 200, result
            with zipfile.ZipFile(args.spool / request["output_key"]) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                blocks = json.loads(archive.read("content_list.json"))
                assert manifest["parse_receipt"]["request_id"] == request["request_id"]
                assert result["body"]["_page_count"] == pages
                assert blocks and "refinement.json" in archive.namelist()
                image_names = {n for n in archive.namelist() if n.startswith("images/")}
                references = [b["img_path"] for b in blocks if b.get("img_path")]
                assert all(name in image_names for name in references)
                bundle_audits.append(
                    {
                        "request_id": request["request_id"],
                        "entries": len(archive.namelist()),
                        "blocks": len(blocks),
                        "image_references": len(references),
                        "image_entries": len(image_names),
                        "distinct_image_hashes": len(
                            {
                                hashlib.sha256(archive.read(n)).hexdigest()
                                for n in image_names
                            }
                        ),
                        "artifact_bytes": (args.spool / request["output_key"])
                        .stat()
                        .st_size,
                    }
                )
        (args.output / "bundle-audits.json").write_text(
            json.dumps(bundle_audits, indent=2)
        )
        if args.mode == "queue":
            assert (
                results[depth]["status"] == 429
                and results[depth]["body"]["code"] == "parser_capacity"
            ), results[depth]
            assert max(s["executing_jobs"] for s in samples) == 1
            assert max(s["queued_jobs"] for s in samples) == depth - 1
            waits = [r["body"]["_queue_ms"] for r in accepted]
            assert waits == sorted(waits), waits
    print(
        json.dumps(
            {
                "mode": args.mode,
                "pages": pages,
                "statuses": [r["status"] for r in results],
                "seconds": [r["seconds"] for r in results],
                "output": str(args.output),
            }
        )
    )


if __name__ == "__main__":
    main()
