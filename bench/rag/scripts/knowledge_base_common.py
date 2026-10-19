"""Small helpers the pilot, loader, builder and frozen bench scripts share."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path


class PilotError(RuntimeError):
    """Safe-to-print errors, without provider request bodies or credentials."""


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)


def digest(value) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


@contextlib.contextmanager
def lock(path: Path):
    """A crashed process leaves a visible lock; do not guess whether it is safe."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise PilotError(
            f"Concurrent or interrupted command: inspect {path} before removing its lock"
        ) from None
    try:
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        yield
    finally:
        path.unlink(missing_ok=True)
