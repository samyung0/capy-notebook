"""The layout prototype's Docker health check: exit 0 when ``/healthz`` answers.

With ``--kill-after N`` it also ends a hung instance itself: after N failed
checks in a row it sends the serving process SIGKILL, so the container exits and
its restart policy starts it again. A restart policy cannot see a process that
is alive but not answering; this needs no watchdog on the host.
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import urllib.request
from pathlib import Path

COUNT = Path("/tmp/layout-health-failures")


def serving_pid() -> int | None:
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                command = (entry / "cmdline").read_bytes().split(b"\0")
                # PID 1, the init, names the script too.
                if b"python" in command[0] and b"layout_service.py" in b" ".join(
                    command
                ):
                    return int(entry.name)
            except OSError:
                continue
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--timeout", type=float, default=2.0)
    parser.add_argument("--kill-after", type=int, default=0)
    args = parser.parse_args()
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:80/healthz", timeout=args.timeout
        ) as response:
            healthy = response.status == 200
    except OSError:
        healthy = False
    if healthy:
        COUNT.unlink(missing_ok=True)
        return
    failures = int(COUNT.read_text()) + 1 if COUNT.exists() else 1
    COUNT.write_text(str(failures))
    if args.kill_after and failures >= args.kill_after:
        pid = serving_pid()
        if pid:
            COUNT.unlink(missing_ok=True)
            os.kill(pid, signal.SIGKILL)
    sys.exit(1)


if __name__ == "__main__":
    main()
