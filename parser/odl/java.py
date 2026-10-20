"""Run OpenDataLoader on one PDF with a hard deadline.

ODL runs as a library under ``parser/java/CapyMain.java`` (built by
``parser/java/build.sh``; the image sets ``CAPY_ODL_ENTRY_JAR``): the same
options and JSON as ODL's CLI, plus the facts the JSON leaves out.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
from importlib import resources
from pathlib import Path

import capy_sandbox

# The lab configuration: cluster table detection, header and footer blocks kept,
# one Java worker thread (more threads gave the same output and no speed). JSON
# only and no image files: decoding and re-encoding every picture was 85% of
# ODL's time on a figure-heavy textbook, and the parser reads none.
ODL_FLAGS = (
    "--format",
    "json",
    "--image-output",
    "off",
    "--threads",
    "1",
    "--table-method",
    "cluster",
    "--include-header-footer",
)
JVM_MAX_HEAP = os.environ.get("CAPY_PARSER_JVM_MAX_HEAP", "1g")
ENTRY_JAR = Path(
    os.environ.get("CAPY_ODL_ENTRY_JAR")
    or Path(__file__).resolve().parents[1] / "java" / "build" / "capy-odl.jar"
)
# What the JVM reads besides its jars, executable and PDF: libraries,
# configuration, fonts and the random device (seeding blocks without it).
READ = (
    "/usr",
    "/lib",
    "/lib64",
    "/etc",
    "/var/cache/fontconfig",
    "/dev/urandom",
    "/dev/random",
)
# -Xmx bounds the heap; the data cap bounds the rest (1.24 GiB measured at
# -Xmx1g). The address space is lifted: the JVM reserves far more than it
# uses. CPU is a backstop behind the wall-clock deadline (about 4x wall).
_LIMITS = {
    "DATA": 2 << 30,
    "AS": -1,  # RLIM_INFINITY
    "CPU": 2400,
    "NOFILE": 256,
    "FSIZE": 512 << 20,
    "CORE": 0,
}


class JavaTimeout(RuntimeError):
    pass


class JavaPageTreeError(RuntimeError):
    """The reader could not resolve the PDF's page tree."""


class JavaKilled(RuntimeError):
    """SIGKILL ended the JVM; in the parser container that is the OOM killer."""


def jar_path() -> Path:
    return Path(
        str(
            resources.files("opendataloader_pdf").joinpath(
                "jar", "opendataloader-pdf-cli.jar"
            )
        )
    )


def run(pdf: Path, out_dir: Path, *, timeout_s: float) -> dict:
    """Parse ``pdf`` into ``out_dir`` and return the native JSON tree.

    The JVM is started directly rather than through the package's console
    script so the heap cap and the deadline are ours. It runs sandboxed
    (capy_sandbox): writing only ``out_dir``, no network or new processes,
    and its own process group, killed whole at the deadline.
    """
    if not ENTRY_JAR.is_file():
        raise FileNotFoundError(f"{ENTRY_JAR} is missing: run parser/java/build.sh")
    found = shutil.which("java")
    if found is None:
        raise FileNotFoundError("java is not on PATH")
    executable = os.path.realpath(found)
    classpath = [str(jar_path()), str(ENTRY_JAR)]
    command = [
        executable,
        f"-Xmx{JVM_MAX_HEAP}",
        "-Djava.awt.headless=true",
        # The JVM ignores TMPDIR: keep its temporary files on the work volume,
        # not the small RAM-backed /tmp.
        f"-Djava.io.tmpdir={out_dir}",
        "-cp",
        os.pathsep.join(classpath),
        "capy.odl.CapyMain",
        str(pdf),
        "--output-dir",
        str(out_dir),
        *ODL_FLAGS,
    ]
    policy = capy_sandbox.Policy(
        limits=_LIMITS,
        blocked=frozenset({"setsid", "setpgid", "fork"}),
        read=(*READ, executable, *classpath, str(pdf)),
        write=(str(out_dir), "/dev/null"),
        env={
            key: os.environ[key]
            for key in ("PATH", "HOME", "LANG")
            if key in os.environ
        },
        timeout_s=timeout_s,
    )
    try:
        completed = capy_sandbox.run(command, policy, stderr=subprocess.STDOUT)
    except subprocess.TimeoutExpired as exc:
        raise JavaTimeout(f"OpenDataLoader exceeded {timeout_s:.0f} seconds") from exc
    output = completed.stdout.decode(errors="replace")
    if completed.returncode == -signal.SIGKILL:
        raise JavaKilled(f"OpenDataLoader was killed: {output[-2000:]}")
    if completed.returncode != 0:
        error = (
            JavaPageTreeError
            if "unknown type of page tree node" in output.lower()
            else RuntimeError
        )
        raise error(f"OpenDataLoader exited {completed.returncode}: {output[-2000:]}")
    native_path = out_dir / f"{pdf.stem}.json"
    return json.loads(native_path.read_text(encoding="utf-8"))


def image_objects(out_dir: Path) -> dict[int, int]:
    """JSON element id -> PDF object number of the image a picture draws
    (inline images have none), as CapyMain wrote it."""
    raw = json.loads((out_dir / "capy-images.json").read_text(encoding="utf-8"))
    return {int(key): value for key, value in raw.items()}
