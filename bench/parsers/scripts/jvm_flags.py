"""The parser's Java phase under other JVM flags, inside a parser image.

    python jvm_flags.py one VARIANT ID          one JVM, in this process
    python jvm_flags.py each LABEL V1,V2,...    every PDF alone, the variants side by side
    python jvm_flags.py pass LABEL VARIANT N    every PDF once, N JVMs at a time

Runs ``odl.java.run`` as the image has it (sandbox, heap cap, the CPU count
from the container's quota) with the variant's flags in place of the parser's
own ``JVM_FLAGS``. Reads /pdfs/<ID>.pdf, works in /work and adds a row per JVM
to /results/LABEL.jsonl: wall seconds, the JVM's CPU seconds over all its
threads, its peak resident memory and the SHA-256 of the JSON it returned. A
pass ends with the container's CPU seconds and peak memory.
bench/parsers/README.md has the container to run it in.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import resource
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

VARIANTS = {
    "default": [],  # G1 and both compilers: the parser before it had a flag.
    "serial": ["-XX:+UseSerialGC"],
    "c1": ["-XX:TieredStopAtLevel=1"],
    "serial-c1": ["-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1"],
    "serial-c1-1536m": ["-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-Xmx1536m"],
    "default-1536m": ["-Xmx1536m"],
    "parallel1-c1": [
        "-XX:+UseParallelGC",
        "-XX:ParallelGCThreads=1",
        "-XX:TieredStopAtLevel=1",
    ],
}
PDFS, WORK, RESULTS = Path("/pdfs"), Path("/work"), Path("/results")
SEED = 20261110


def one(variant: str, ident: str) -> None:
    import capy_sandbox
    from odl import java

    flags, real = VARIANTS[variant], capy_sandbox.run

    def run(command, policy, **kwargs):
        # An image from before the parser had flags of its own has none to drop.
        mine = getattr(java, "JVM_FLAGS", ())
        # The last -Xmx wins, so a variant's heap replaces the parser's.
        heap = any(flag.startswith("-Xmx") for flag in flags)
        own = [
            part
            for part in command[1:]
            if part not in mine and not (heap and part.startswith("-Xmx"))
        ]
        return real([command[0], *flags, *own], policy, **kwargs)

    capy_sandbox.run = run
    work = WORK / f"{ident}-{os.getpid()}"
    out = work / "native"
    out.mkdir(parents=True)
    try:
        pdf = work / "document.pdf"
        shutil.copy(PDFS / f"{ident}.pdf", pdf)
        started = time.perf_counter()
        try:
            native, error = java.run(pdf, out, timeout_s=600), None
        except Exception as exc:
            native, error = None, f"{type(exc).__name__}: {exc}"[:300]
        seconds = time.perf_counter() - started
        used = resource.getrusage(resource.RUSAGE_CHILDREN)
        row = {
            "variant": variant,
            "id": ident,
            "seconds": round(seconds, 3),
            "cpu": round(used.ru_utime + used.ru_stime, 3),
            "peak_mib": round(used.ru_maxrss / 1024),  # Linux counts KiB.
            "cpus": java.CPUS,
            "sha": native
            and hashlib.sha256(
                json.dumps(native, sort_keys=True).encode()
            ).hexdigest()[:16],
            "error": error,
        }
        print(json.dumps(row), flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def spawn(variant: str, ident: str, started: float) -> dict:
    """One JVM from a fresh process, as a parse child starts it."""
    at = time.perf_counter() - started
    done = subprocess.run(
        [sys.executable, __file__, "one", variant, ident],
        capture_output=True,
        text=True,
    )
    lines = [line for line in done.stdout.splitlines() if line.startswith("{")]
    if not lines:
        return {"variant": variant, "id": ident, "error": done.stderr[-300:]}
    return {**json.loads(lines[-1]), "at": round(at, 2)}


def container() -> dict:
    stat = dict(
        line.split() for line in Path("/sys/fs/cgroup/cpu.stat").read_text().splitlines()
    )
    peak = Path("/sys/fs/cgroup/memory.peak").read_text()
    return {
        "container_cpu": round(int(stat["usage_usec"]) / 1e6, 1),
        "container_peak_mib": round(int(peak) / (1 << 20)),
    }


def main() -> None:
    if sys.argv[1] == "one":
        one(sys.argv[2], sys.argv[3])
        return
    mode, label = sys.argv[1], sys.argv[2]
    # macOS tar leaves ._name.pdf files beside the PDFs it packs.
    idents = sorted(p.stem for p in PDFS.glob("*.pdf") if not p.name.startswith("."))
    started = time.perf_counter()
    with (RESULTS / f"{label}.jsonl").open("a") as handle:

        def keep(row: dict) -> None:
            handle.write(json.dumps({"label": label, **row}) + "\n")
            handle.flush()

        if mode == "each":
            variants = sys.argv[3].split(",")
            for n, ident in enumerate(idents):
                # Rotated, so no variant always runs first on a PDF.
                turn = n % len(variants)
                for variant in variants[turn:] + variants[:turn]:
                    keep(spawn(variant, ident, started))
            return
        variant, workers = sys.argv[3], int(sys.argv[4])
        random.Random(SEED).shuffle(idents)
        with ThreadPoolExecutor(workers) as pool:
            for row in pool.map(lambda i: spawn(variant, i, started), idents):
                keep(row)
        keep(
            {
                "variant": variant,
                "summary": True,
                "workers": workers,
                "pass_seconds": round(time.perf_counter() - started, 1),
                **container(),
            }
        )


if __name__ == "__main__":
    main()
