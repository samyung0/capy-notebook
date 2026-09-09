"""Warm 1/4-document bursts on one isolated parser container.

MinerU uses Capy's shared-model thread lanes. OpenDataLoader uses
one JVM per document with one shared or four independent hybrid servers. Inputs must fit in a
single production 26-page slice. Run competing configurations sequentially.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import time
from pathlib import Path

from compare_opendataloader import CONFIGS, Hybrid, Sampler, measured, save


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--config", required=True, choices=CONFIGS)
    parser.add_argument("--id", required=True)
    parser.add_argument("--run", required=True)
    parser.add_argument("--parallel", type=int, choices=[1, 4], required=True)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--java-threads", type=int, default=2)
    parser.add_argument("--hybrid-workers", type=int, choices=[1, 4], default=1)
    args = parser.parse_args()
    args.slice_workers = 1
    config = CONFIGS[args.config]
    if args.hybrid_workers > 1 and (not config.get("hybrid") or args.parallel != 4):
        parser.error("four hybrid workers require four clients and hybrid mode")
    entries = json.loads((args.root / "corpus.json").read_text())["entries"]
    entry = next(e for e in entries if e["id"] == args.id)
    if entry["pages"] > 26:
        parser.error("capacity fixture must have at most 26 pages")
    output = args.root / "results" / args.run
    output.mkdir(parents=True, exist_ok=False)
    save(
        output / "run.json",
        {
            "kind": "capacity",
            "args": vars(args) | {"root": str(args.root)},
            "input": entry,
            "config": config,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "converter_sha256": hashlib.sha256(
                (Path(__file__).parent / "compare_opendataloader.py").read_bytes()
            ).hexdigest(),
            "environment": {
                key: os.environ.get(key)
                for key in [
                    "OMP_NUM_THREADS",
                    "MKL_NUM_THREADS",
                    "OPENBLAS_NUM_THREADS",
                ]
            },
        },
    )
    hybrids = [
        Hybrid(args.root, config, output, port=5002 + index)
        for index in range(args.hybrid_workers)
    ]
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel)

    def submit(index: int, target: Path):
        request_args = argparse.Namespace(
            **(vars(args) | {"hybrid_port": 5002 + index % args.hybrid_workers})
        )
        return executor.submit(measured, args.root, entry, target, config, request_args)

    try:
        for hybrid in hybrids:
            hybrid.ensure(entry)
        warmup = [submit(i, output / f"_warmup-{i}") for i in range(args.parallel)]
        if any(f.result()["state"] != "ok" for f in warmup):
            raise RuntimeError("warmup failed; capacity measurement cancelled")
        bursts = []
        for repeat in range(args.repeats):
            result = {
                "repeat": repeat,
                "state": "running",
                "pages_requested": entry["pages"] * args.parallel,
            }
            bursts.append(result)
            save(output / "bursts.json", bursts)
            sampler = Sampler(output / f"resources-{repeat}.csv")
            sampler.thread.start()
            start = time.monotonic()
            futures = [
                submit(i, output / f"repeat-{repeat}-copy-{i}")
                for i in range(args.parallel)
            ]
            try:
                records = [future.result() for future in futures]
            except Exception as error:
                result.update(
                    state="error",
                    error=repr(error),
                    wall_s=time.monotonic() - start,
                    peak_memory_bytes=sampler.peak_memory,
                    peak_swap_bytes=sampler.peak_swap,
                    peak_anon_bytes=sampler.peak_anon,
                    peak_file_bytes=sampler.peak_file,
                )
                save(output / "bursts.json", bursts)
                raise
            finally:
                sampler.stop.set()
                sampler.thread.join()
            wall = time.monotonic() - start
            ok = all(r["state"] == "ok" for r in records)
            result.update(
                {
                    "state": "ok" if ok else "error",
                    "repeat": repeat,
                    "wall_s": wall,
                    "pages": entry["pages"] * args.parallel,
                    "pages_per_second": entry["pages"] * args.parallel / wall
                    if ok
                    else None,
                    "peak_memory_bytes": sampler.peak_memory,
                    "peak_swap_bytes": sampler.peak_swap,
                    "peak_anon_bytes": sampler.peak_anon,
                    "peak_file_bytes": sampler.peak_file,
                    "states": [r["state"] for r in records],
                    "request_wall_s": [r["wall_s"] for r in records],
                }
            )
            save(output / "bursts.json", bursts)
            print(json.dumps(result), flush=True)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)
        for hybrid in hybrids:
            hybrid.close()
        save(
            output / "backend-starts.json",
            [start for hybrid in hybrids for start in hybrid.starts],
        )
        save(
            output / "cgroup-final.json",
            {
                name: (Path("/sys/fs/cgroup") / name).read_text()
                for name in ["memory.peak", "memory.events", "memory.stat", "cpu.stat"]
            },
        )


if __name__ == "__main__":
    main()
