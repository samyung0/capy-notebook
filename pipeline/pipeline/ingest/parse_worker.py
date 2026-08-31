"""Supervise the fixed document-parse coordinator pool.

Each child claims one parse job at a time. A timed-out child exits after it has
durably requeued its claim; the supervisor replaces only that child while the
other coordinators continue waiting on MinerU.
"""

from __future__ import annotations

import multiprocessing
import signal
import time
from types import FrameType

from ..config import cfg
from . import worker


def _run_child() -> None:
    worker.main(job_type="parse")


def main() -> None:
    context = multiprocessing.get_context("spawn")
    stopping = False
    children: list[multiprocessing.Process] = []

    def stop(_signum: int, _frame: FrameType | None) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def start_child(index: int) -> multiprocessing.Process:
        child = context.Process(
            target=_run_child,
            name=f"parse-coordinator-{index}",
        )
        child.start()
        return child

    children = [
        start_child(index) for index in range(cfg.parse_coordinator_concurrency)
    ]
    try:
        while not stopping:
            for index, child in enumerate(children):
                if child.is_alive():
                    continue
                child.join()
                children[index] = start_child(index)
            time.sleep(1)
    finally:
        for child in children:
            if child.is_alive():
                child.terminate()
        for child in children:
            child.join(timeout=10)


if __name__ == "__main__":
    main()
