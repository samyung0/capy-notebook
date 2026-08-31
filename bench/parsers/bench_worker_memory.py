"""Measure ingest-worker memory for large parsed content lists.

The fixture builder streams JSON to disk so its allocations do not contaminate
the worker cgroup measurement. Run the ``load`` command in a fresh pipeline
container with the candidate memory limit.
"""

from __future__ import annotations

import argparse
import gc
import json
import resource
import time
from pathlib import Path


def build_fixture(output: Path, target_mib: int) -> None:
    target_bytes = target_mib * 1024 * 1024
    text = "A cell uses this synthetic paragraph to exercise chunking memory. " * 64
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        handle.write("[")
        block_number = 0
        while handle.tell() < target_bytes:
            if block_number:
                handle.write(",")
            json.dump(
                {
                    "type": "text",
                    "text": f"Block {block_number}. {text}",
                    "bbox": [40, 60, 920, 940],
                    "page_idx": block_number // 8,
                },
                handle,
                ensure_ascii=True,
                separators=(",", ":"),
            )
            block_number += 1
        handle.write("]")
    print(
        json.dumps(
            {
                "blocks": block_number,
                "bytes": output.stat().st_size,
                "path": str(output),
            },
            separators=(",", ":"),
        )
    )


def load_fixture(source: Path, hold_seconds: float) -> None:
    from pipeline.ingest.worker import chunk_content_list

    started = time.perf_counter()
    content = json.loads(source.read_text(encoding="utf-8"))
    loaded = time.perf_counter()
    chunks = chunk_content_list(content)
    chunked = time.perf_counter()
    print(
        json.dumps(
            {
                "blocks": len(content),
                "chunks": len(chunks),
                "file_bytes": source.stat().st_size,
                "json_load_s": round(loaded - started, 3),
                "chunk_s": round(chunked - loaded, 3),
                "max_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                * 1024,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    if hold_seconds:
        time.sleep(hold_seconds)
    del chunks
    del content
    gc.collect()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build")
    build.add_argument("--output", type=Path, required=True)
    build.add_argument("--target-mib", type=int, required=True)

    load = subparsers.add_parser("load")
    load.add_argument("--input", type=Path, required=True)
    load.add_argument("--hold-seconds", type=float, default=0)

    args = parser.parse_args()
    if args.command == "build":
        build_fixture(args.output, args.target_mib)
    else:
        load_fixture(args.input, args.hold_seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
