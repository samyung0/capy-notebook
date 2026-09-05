"""Run one parser-client job inside an ingest-worker container.

The host-side stress harness starts four copies of this script in separate
pipeline containers. Each copy exercises the production shared-spool request,
artifact verification, extraction, and content-list load without requiring a
database or provider credentials.
"""

from __future__ import annotations

import argparse
import json
import resource
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pipeline.ingest import worker as _ingest_worker
from pipeline.parse import figures, parser_client


def _directory_bytes(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-key", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--hold-seconds", type=float, default=0)
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()

    raw_dir = Path(tempfile.mkdtemp(prefix="capy_worker_bench_"))
    started = time.perf_counter()
    try:
        content, artifact_key, fingerprint = parser_client.parse_to_bundle(
            parser_client.source_descriptor(
                source_key=args.source_key,
                source_sha256=args.source_sha256,
                route=parser_client.ROUTE_FAST,
            ),
            args.filename,
            raw_dir,
            require_office_preview=False,
            request_id=args.request_id,
        )
        selected = figures.select_figures(content, raw_dir)
        with ThreadPoolExecutor(
            max_workers=max(1, parser_client.cfg.caption_concurrency)
        ) as pool:
            encoded = list(
                pool.map(lambda figure: figures._encode(figure.path), selected)
            )
        chunks = _ingest_worker.chunk_content_list(content)
        result = {
            "artifact_key": artifact_key,
            "blocks": len(content),
            "caption_input_bytes": sum(len(item or "") for item in encoded),
            "caption_inputs": len(selected),
            "chunks": len(chunks),
            "elapsed_s": round(time.perf_counter() - started, 3),
            "extracted_bytes": _directory_bytes(raw_dir),
            "fingerprint": fingerprint,
            "max_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            "request_id": args.request_id,
        }
        print(json.dumps(result, separators=(",", ":")), flush=True)
        if args.hold_seconds > 0:
            time.sleep(args.hold_seconds)
        return 0
    except Exception as exc:  # noqa: BLE001 - benchmark must preserve the failure
        print(
            json.dumps(
                {
                    "elapsed_s": round(time.perf_counter() - started, 3),
                    "error": f"{type(exc).__name__}: {exc}",
                    "request_id": args.request_id,
                },
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1
    finally:
        shutil.rmtree(raw_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
