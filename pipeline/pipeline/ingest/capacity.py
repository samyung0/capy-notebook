"""Host-wide job capacity shared by isolated queue consumers."""

from __future__ import annotations

import fcntl
import os
from pathlib import Path
from typing import BinaryIO

from ..config import cfg


class CapacityLease:
    """An acquired role lock. Closing the descriptor releases it after a crash."""

    def __init__(self, handle: BinaryIO | None) -> None:
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def try_acquire(job_type: str) -> CapacityLease | None:
    """Acquire one shared import, parse or ingest slot without waiting.

    An unset lock directory preserves the per-process production behavior.
    Non-production queue consumers mount the same directory, so their locks
    apply across Compose services and release automatically when a process dies.
    """

    if job_type not in {"import", "parse", "ingest"}:
        raise ValueError(f"unsupported capacity role {job_type!r}")
    if not cfg.shared_capacity_lock_dir:
        return CapacityLease(None)

    root = Path(cfg.shared_capacity_lock_dir)
    if not root.is_dir():
        raise RuntimeError(f"shared capacity lock directory does not exist: {root}")

    descriptor = os.open(root / f"{job_type}.lock", os.O_CREAT | os.O_RDWR, 0o660)
    handle = os.fdopen(descriptor, "a+b", buffering=0)
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return CapacityLease(handle)
