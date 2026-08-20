"""Join a ProcessPoolExecutor so Modal does not sit on its manager thread.

``shutdown(wait=False)`` returns while the executor manager thread is still
reaping workers. That thread is not a daemon. Modal's runner then waits up
to 30s after ``@modal.exit`` ("Thread-2 still running").

Kill the workers first, then ``shutdown(wait=True)``. The manager thread
exits before the exit hook returns.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ProcessPoolExecutor


def close_process_pool(pool: ProcessPoolExecutor, *, join_s: float = 8.0) -> str:
    """Terminate pool workers, then join the manager thread.

    Returns a short status for container logs.
    """
    procs = list(getattr(pool, "_processes", {}).values())
    for proc in procs:
        try:
            if proc.is_alive():
                proc.terminate()
        except OSError:
            pass
    deadline = time.monotonic() + min(3.0, join_s)
    for proc in procs:
        try:
            proc.join(timeout=max(0.0, deadline - time.monotonic()))
        except Exception:
            pass
        if proc.is_alive():
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.join(timeout=1.0)
            except Exception:
                pass

    mgr = getattr(pool, "_executor_manager_thread", None)
    done = threading.Event()
    error: list[str] = []

    def _join() -> None:
        try:
            pool.shutdown(wait=True, cancel_futures=True)
        except Exception as exc:  # noqa: BLE001
            error.append(f"{type(exc).__name__}: {exc}")
        finally:
            done.set()

    threading.Thread(target=_join, name="pool-shutdown", daemon=True).start()
    if done.wait(join_s):
        if error:
            return f"joined ({error[0]})"
        return "joined"
    if mgr is not None and mgr.is_alive():
        mgr.daemon = True
        return "manager still alive; marked daemon"
    return "shutdown timed out; manager already gone"
