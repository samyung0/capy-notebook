"""Run the OpenDataLoader CLI jar on one PDF with a hard deadline."""

from __future__ import annotations

import json
import os
import subprocess
from importlib import resources
from pathlib import Path

# The lab configuration: cluster table detection, header and footer blocks kept,
# images written beside the JSON, one Java worker thread.
ODL_FLAGS = (
    "--format",
    "json,markdown",
    "--image-output",
    "external",
    "--markdown-with-html",
    "--threads",
    "1",
    "--table-method",
    "cluster",
    "--include-header-footer",
)
JVM_MAX_HEAP = os.environ.get("CAPY_PARSER_JVM_MAX_HEAP", "3g")


class JavaTimeout(RuntimeError):
    pass


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

    The jar is invoked directly rather than through the package's console
    script so the heap cap and the deadline are ours.
    """
    command = [
        "java",
        f"-Xmx{JVM_MAX_HEAP}",
        "-Djava.awt.headless=true",
        "-jar",
        str(jar_path()),
        str(pdf),
        "--output-dir",
        str(out_dir),
        *ODL_FLAGS,
    ]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=timeout_s,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise JavaTimeout(f"OpenDataLoader exceeded {timeout_s:.0f} seconds") from exc
    if completed.returncode != 0:
        raise RuntimeError(
            f"OpenDataLoader exited {completed.returncode}: {completed.stdout[-2000:]}"
        )
    native_path = out_dir / f"{pdf.stem}.json"
    return json.loads(native_path.read_text(encoding="utf-8"))
