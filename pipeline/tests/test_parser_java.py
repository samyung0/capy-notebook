"""The JVM's sandbox, and a page-tree failure gets one isolated rewrite within
the Java deadline."""

from __future__ import annotations

import errno
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl import java, refine

# A fake JVM runs under the JVM's own sandbox, which reads only system trees:
# a Python there, not this test's interpreter.
SYSTEM_PYTHON = shutil.which("python3", path="/usr/local/bin:/usr/bin")


def _fake_run(result):
    """Stands in for capy_sandbox.run: records the command, answers ``result``."""
    commands = []

    def run(command, policy, **_kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(command, *result)

    return run, commands


@pytest.fixture
def jars(tmp_path, monkeypatch):
    monkeypatch.setattr(java, "jar_path", lambda: tmp_path / "parser.jar")
    (tmp_path / "capy-odl.jar").write_bytes(b"")
    monkeypatch.setattr(java, "ENTRY_JAR", tmp_path / "capy-odl.jar")
    monkeypatch.setattr(java.shutil, "which", lambda _name: "/usr/bin/java")


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("SEVERE: unknown type of page tree node", java.JavaPageTreeError),
        ("Incorrect xref section", RuntimeError),
        ("OutOfMemoryError", RuntimeError),
    ],
)
def test_java_classifies_only_the_demonstrated_reader_failure(
    tmp_path, monkeypatch, jars, output, expected
):
    run, _ = _fake_run((1, output.encode()))
    monkeypatch.setattr(java.capy_sandbox, "run", run)
    with pytest.raises(expected) as caught:
        java.run(tmp_path / "document.pdf", tmp_path, timeout_s=60)
    assert type(caught.value) is expected


def test_java_keeps_its_temporary_files_in_the_output_dir(tmp_path, monkeypatch, jars):
    run, commands = _fake_run((1, b"failed"))
    monkeypatch.setattr(java.capy_sandbox, "run", run)
    out_dir = tmp_path / "native"
    with pytest.raises(RuntimeError):
        java.run(tmp_path / "document.pdf", out_dir, timeout_s=60)
    assert f"-Djava.io.tmpdir={out_dir}" in commands[0]


def test_java_sizes_its_threads_by_the_containers_cpu_quota(
    tmp_path, monkeypatch, jars
):
    """The sandboxed JVM cannot read its cgroup, so the parser passes the
    quota (rounded up, at most the CPUs it may run on) as its CPU count."""
    cpu_max = tmp_path / "cpu.max"
    monkeypatch.setattr(java, "_CPU_MAX", cpu_max)
    if hasattr(os, "sched_getaffinity"):
        available = len(os.sched_getaffinity(0))
        cpu_max.write_text("150000 100000\n")
        assert java._container_cpus() == min(2, available)
        cpu_max.write_text("max 100000\n")
        assert java._container_cpus() == available

    run, commands = _fake_run((1, b"failed"))
    monkeypatch.setattr(java.capy_sandbox, "run", run)
    with pytest.raises(RuntimeError):
        java.run(tmp_path / "document.pdf", tmp_path, timeout_s=60)
    assert f"-XX:ActiveProcessorCount={java.CPUS}" in commands[0]


# A fake JVM: it leaves, as the native JSON ODL would write, what it could
# and could not do.
_PROBE = """#!{python} -I
import ctypes, json, os, resource, socket, sys
from pathlib import Path

libc = ctypes.CDLL(None, use_errno=True)
pdf = Path(sys.argv[sys.argv.index("capy.odl.CapyMain") + 1])
out_dir = Path(sys.argv[sys.argv.index("--output-dir") + 1])
out = {{"env": sorted(k for k in os.environ if k != "LC_CTYPE")}}

def attempt(name, action):
    try:
        action()
        out[name] = "ok"
    except OSError as exc:
        out[name] = exc.errno

def fork():
    pid = os.fork()
    if pid == 0:
        os._exit(0)
    os.waitpid(pid, 0)

attempt("inet_socket", lambda: socket.socket(socket.AF_INET).close())
attempt("fork", fork)
attempt("setpgid", lambda: os.setpgid(0, 0))
attempt("read_pdf", pdf.read_bytes)
attempt("read_outside", lambda: (out_dir.parent / "other-job.pdf").read_bytes())
out["no_new_privs"] = libc.prctl(39, 0, 0, 0, 0)
out["seccomp"] = libc.prctl(21, 0, 0, 0, 0)
out["limits"] = {{
    name: list(resource.getrlimit(getattr(resource, "RLIMIT_" + name)))
    for name in ("AS", "DATA", "CPU", "NOFILE", "FSIZE", "CORE")
}}
(out_dir / (pdf.stem + ".json")).write_text(json.dumps(out))
"""


@pytest.mark.skipif(
    sys.platform != "linux" or SYSTEM_PYTHON is None,
    reason="needs Linux and a python3 under /usr",
)
def test_java_runs_sandboxed_with_only_its_allowlisted_env(tmp_path, monkeypatch):
    """(security regression: S1 Java) The JVM starts through the sandbox: an
    explicit environment (no parser secret), a 2 GiB data cap with the parse
    child's soft address-space limit lifted, no network, no new processes or
    groups, and no file outside its PDF and output folder."""
    import os
    import resource

    monkeypatch.setattr(java, "jar_path", lambda: tmp_path / "parser.jar")
    (tmp_path / "capy-odl.jar").write_bytes(b"")
    monkeypatch.setattr(java, "ENTRY_JAR", tmp_path / "capy-odl.jar")
    fake = tmp_path / "bin" / "java"
    fake.parent.mkdir()
    fake.write_text(_PROBE.format(python=SYSTEM_PYTHON))
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake.parent}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("PARSER_TOKEN", "parser-secret")
    pdf = tmp_path / "document.pdf"
    pdf.write_bytes(b"%PDF-1.7")
    (tmp_path / "other-job.pdf").write_bytes(b"%PDF-1.7 another user's")
    out_dir = tmp_path / "native"
    out_dir.mkdir()
    read, write = os.pipe()
    pid = os.fork()
    if pid == 0:  # a child with the parse child's soft limit
        try:
            _, hard = resource.getrlimit(resource.RLIMIT_AS)
            resource.setrlimit(resource.RLIMIT_AS, (2 << 30, hard))
            os.write(write, json.dumps(java.run(pdf, out_dir, timeout_s=60)).encode())
        finally:
            os._exit(0)
    os.close(write)
    with os.fdopen(read) as answer:
        report = json.loads(answer.read())
    os.waitpid(pid, 0)

    assert set(report["env"]) <= {"PATH", "HOME", "LANG"}
    assert report["limits"] == {
        "AS": [-1, -1],
        "DATA": [2 << 30] * 2,
        "CPU": [2400, 2400],
        "NOFILE": [256, 256],
        "FSIZE": [512 << 20] * 2,
        "CORE": [0, 0],
    }
    assert report["no_new_privs"] == 1 and report["seccomp"] == 2
    assert report["inet_socket"] == errno.EACCES
    assert report["fork"] == errno.EPERM
    assert report["setpgid"] == errno.EPERM
    assert report["read_pdf"] == "ok"
    assert report["read_outside"] == errno.EACCES


@pytest.fixture
def source(monkeypatch):
    monkeypatch.setattr(refine.fonts, "repair_fonts", lambda data: (data, 0))
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text(
            (50, 100),
            "The original source has enough native prose to need no page OCR.",
        )
        document.set_toc([[1, "Source chapter", 1]])
        return (
            document.tobytes(
                encryption=pymupdf.PDF_ENCRYPT_RC4_128,
                owner_pw="test-owner",
                user_pw="",
                permissions=pymupdf.PDF_PERM_PRINT,
            )
            + b"\n% trailing source comment\n"
        )


def test_reader_retry_preserves_source_encryption_in_a_fresh_directory(
    tmp_path, monkeypatch, source
):
    clock = [0.0]
    calls = []
    monkeypatch.setattr(refine.time, "perf_counter", lambda: clock[0])

    def run(pdf, out_dir, *, timeout_s):
        calls.append((pdf.read_bytes(), out_dir.name, timeout_s))
        if len(calls) == 1:
            clock[0] = 2.0
            raise java.JavaPageTreeError("unknown type of page tree node")
        (out_dir / "capy-images.json").write_text("{}")
        return {"number of pages": 1, "kids": []}

    monkeypatch.setattr(java, "run", run)
    result = refine.parse_pdf(source, tmp_path, java_timeout_s=60)
    assert [(name, timeout) for _, name, timeout in calls] == [
        ("native", 60),
        ("native-retry", 58),
    ]
    assert calls[0][0] == source
    assert result.parsed_pdf == calls[1][0]
    assert "java_structure_retry" in result.phases
    with (
        pymupdf.open(stream=source, filetype="pdf") as original,
        pymupdf.open(stream=result.parsed_pdf, filetype="pdf") as repaired,
    ):
        assert repaired.permissions == original.permissions
        assert repaired.metadata["encryption"] == original.metadata["encryption"]
        assert repaired.get_toc() == original.get_toc()
        assert repaired[0].get_text() == original[0].get_text()
        assert repaired[0].get_pixmap().samples == original[0].get_pixmap().samples


@pytest.mark.parametrize(
    "outcome", ["success", "other-error", "timeout", "retry-error", "budget"]
)
def test_reader_retry_is_bounded_and_leaves_other_outcomes_alone(
    tmp_path, monkeypatch, source, outcome
):
    clock = [0.0]
    calls = []
    monkeypatch.setattr(refine.time, "perf_counter", lambda: clock[0])

    def run(pdf, out_dir, *, timeout_s):
        calls.append(out_dir.name)
        if outcome == "success":
            (out_dir / "capy-images.json").write_text("{}")
            return {"number of pages": 1, "kids": []}
        if outcome == "other-error":
            raise RuntimeError("unrelated parser failure")
        if outcome == "timeout":
            raise java.JavaTimeout("original timeout")
        if outcome == "budget":
            clock[0] = 61.0
        raise java.JavaPageTreeError("unknown type of page tree node")

    monkeypatch.setattr(java, "run", run)
    if outcome == "success":
        result = refine.parse_pdf(source, tmp_path, java_timeout_s=60)
        assert result.parsed_pdf is None
        assert "java_structure_retry" not in result.phases
    else:
        expected = (
            java.JavaTimeout if outcome in {"timeout", "budget"} else RuntimeError
        )
        with pytest.raises(expected):
            refine.parse_pdf(source, tmp_path, java_timeout_s=60)
    assert calls == (
        ["native", "native-retry"] if outcome == "retry-error" else ["native"]
    )
