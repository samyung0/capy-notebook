"""Process-pool teardown must join the executor manager thread."""

from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODAL_DIR = REPO_ROOT / "modal"
if str(MODAL_DIR) not in sys.path:
    sys.path.insert(0, str(MODAL_DIR))

from pool_shutdown import close_process_pool


def _sleep_worker() -> None:
    time.sleep(60)


def test_close_kills_workers_and_joins_the_manager_thread() -> None:
    before = {id(t) for t in threading.enumerate()}
    pool = ProcessPoolExecutor(max_workers=2)
    fut = pool.submit(_sleep_worker)
    # Give the manager thread and child process time to start.
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not getattr(pool, "_processes", {}):
        time.sleep(0.05)
    started = [
        t
        for t in threading.enumerate()
        if id(t) not in before and t.is_alive() and not t.daemon
    ]
    assert started, "ProcessPoolExecutor should have a non-daemon manager thread"

    t0 = time.perf_counter()
    status = close_process_pool(pool)
    elapsed = time.perf_counter() - t0
    assert elapsed < 12, f"close took {elapsed:.1f}s, should terminate the sleeper"
    assert status == "joined", status
    leftover = [t for t in started if t.is_alive()]
    assert leftover == [], f"manager thread still running: {[t.name for t in leftover]}"
    assert fut.done()
