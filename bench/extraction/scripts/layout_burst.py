"""One PP-DocLayout_plus-L instance working through a stream of 40-page bursts.

Runs in a throwaway container, started by ``layout_capacity.py``. Instances of
a pass share one page counter, so two instances split each burst between them,
as two workers taking pages from one queue would:

    python layout_burst.py --name layout-1 --threads 2 --model /models/plus-l \
        --pages /pages --run /run-dir

The instance loads the model, writes ``<run>/<name>.ready``, waits for
``<run>/go`` and then takes pages until ``<run>/stop`` appears. A page's time
runs from opening its JPEG to the model's regions, and each page is one line of
``<run>/<name>.jsonl`` as it finishes, so a killed instance keeps its record.
Pages come in one fixed shuffled order of the scan and born-digital images;
page ``k`` belongs to burst ``k // 40``.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import random
import resource
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout_detect import PaddleOnnx

BURST = 40


def claim(counter: Path) -> int:
    """The next page number from the file the instances share."""
    with counter.open("r+") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        k = int(handle.read() or 0)
        handle.seek(0)
        handle.write(str(k + 1))
        handle.truncate()
    return k


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--name", required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--pages", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--nice", type=int, default=0)
    parser.add_argument("--no-spin", action="store_true")
    args = parser.parse_args()
    if args.nice:
        os.nice(args.nice)

    from PIL import Image

    started = time.perf_counter()
    model = PaddleOnnx(args.model, args.threads, spin=not args.no_spin)
    load_s = time.perf_counter() - started
    order = sorted(args.pages.glob("*.jpg"))
    random.Random(20261104).shuffle(order)

    run = args.run
    (run / f"{args.name}.ready").write_text(str(load_s))
    while not (run / "go").exists():
        time.sleep(0.02)
    counter, stop = run / "counter", run / "stop"
    with (run / f"{args.name}.jsonl").open("w", buffering=1) as log:
        while not stop.exists():
            k = claim(counter)
            path = order[k % len(order)]
            start, cpu = time.time(), time.process_time()
            with Image.open(path) as opened:
                image = opened.convert("RGB")
            regions = model(image)
            line = {
                "k": k,
                "burst": k // BURST,
                "page": path.stem,
                "start": start,
                "end": time.time(),
                "cpu": time.process_time() - cpu,
                "regions": len(regions),
            }
            log.write(json.dumps(line) + "\n")
    (run / f"{args.name}.done").write_text(
        json.dumps(
            {
                "load_s": round(load_s, 3),
                "max_rss_mb": round(
                    resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1
                ),
                "cpu_s": round(time.process_time(), 1),
            }
        )
    )


if __name__ == "__main__":
    main()
