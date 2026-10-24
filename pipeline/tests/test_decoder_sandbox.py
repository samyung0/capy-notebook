"""The decoder sandbox (pipeline/capy_sandbox.py) and the ingest decode helper
it runs (pipeline/pipeline/ingest/decode.py), human/deployment-runbook.md
2026-10-20 S0. Each security regression test fails when its rule is removed."""

from __future__ import annotations

import errno
import gzip
import hashlib
import io
import json
import os
import signal
import socket
import subprocess
import sys
import textwrap
import threading
import time
import uuid
from pathlib import Path

import capy_sandbox
import pytest

from pipeline.ingest import decode

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"
linux = pytest.mark.skipif(
    sys.platform != "linux", reason="seccomp, Landlock and rlimits are Linux"
)

# Run inside a sandboxed child: what it can still do. argv: a file it must not
# read, then a file it may read. LC_CTYPE is Python's own locale coercion.
PROBE = textwrap.dedent(
    r"""
    import ctypes, json, mmap, os, resource, socket, sys

    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    out = {"env": sorted(name for name in os.environ if name != "LC_CTYPE")}


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


    def syscall(*args):
        if libc.syscall(*args) < 0:
            raise OSError(ctypes.get_errno(), "syscall")


    class IOVec(ctypes.Structure):
        _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


    def read_own_memory():
        source, target = ctypes.create_string_buffer(8), ctypes.create_string_buffer(8)
        local = IOVec(ctypes.cast(target, ctypes.c_void_p), 8)
        remote = IOVec(ctypes.cast(source, ctypes.c_void_p), 8)
        pid = os.getpid()
        if libc.process_vm_readv(pid, ctypes.byref(local), 1, ctypes.byref(remote), 1, 0) < 0:
            raise OSError(ctypes.get_errno(), "process_vm_readv")


    params = ctypes.create_string_buffer(120)
    attempt("inet_socket", lambda: socket.socket(socket.AF_INET).close())
    attempt("unix_socket", lambda: socket.socket(socket.AF_UNIX).close())
    attempt("io_uring", lambda: syscall(425, 1, params))
    attempt("process_vm_readv", read_own_memory)
    attempt("pidfd_getfd", lambda: syscall(438, -1, 0, 0))
    attempt("process_madvise", lambda: syscall(440, -1, 0, 0, 0, 0))
    attempt("fork", fork)
    attempt("setpgid", lambda: os.setpgid(0, 0))
    attempt("read_outside", lambda: open(sys.argv[1], "rb").close())
    attempt("read_input", lambda: open(sys.argv[2], "rb").close())
    out["no_new_privs"] = libc.prctl(39, 0, 0, 0, 0)
    out["seccomp"] = libc.prctl(21, 0, 0, 0, 0)
    out["limits"] = {
        name: list(resource.getrlimit(getattr(resource, "RLIMIT_" + name)))
        for name in ("AS", "DATA", "CPU", "NOFILE", "FSIZE", "CORE")
    }
    print(json.dumps(out))
    """
)


def _probe(
    policy: capy_sandbox.Policy, outside: Path, inside: Path, run=capy_sandbox.run
) -> dict:
    completed = run(
        [sys.executable, "-c", PROBE, str(outside), str(inside)],
        policy,
        max_output=1 << 16,
    )
    assert completed.returncode == 0, completed.stderr.decode()
    return json.loads(completed.stdout)


def _running(marker: str, *, started: bool = False) -> list[int]:
    """Live processes whose command line carries ``marker`` (``started``: and
    no longer the trampoline, so the target itself runs)."""
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
            state = (entry / "stat").read_text().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if started and b"capy_sandbox.py" in command:
            continue
        if marker.encode() in command and state != "Z":
            found.append(int(entry.name))
    return found


def _kill(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _gone(marker: str) -> bool:
    deadline = time.monotonic() + 5
    while _running(marker) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not _running(marker)


@linux
def test_the_decode_helper_runs_with_only_its_python_path_and_its_limits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(security regression: S2 decode helper) The worker's secrets stay out of
    the helper's environment; it opens no network socket, starts no process,
    reaches no other process and reads only its input beyond its own code."""
    monkeypatch.setenv("CAPY_CANARY_SECRET", "worker-secret")
    outside = tmp_path / "other-upload"
    outside.write_bytes(b"another user's file")
    source = tmp_path / "upload.png"
    source.write_bytes(b"this job's file")

    report = _probe(decode._policy(source), outside, source)

    assert set(report["env"]) <= {"PYTHONPATH"}
    assert report["limits"]["DATA"] == [768 << 20] * 2
    assert report["limits"]["CPU"] == [120, 120]
    assert report["limits"]["NOFILE"] == [64, 64]
    assert report["limits"]["FSIZE"] == [0, 0]
    assert report["limits"]["CORE"] == [0, 0]
    assert report["no_new_privs"] == 1 and report["seccomp"] == 2
    assert report["inet_socket"] == errno.EACCES
    assert report["unix_socket"] == "ok"
    assert report["io_uring"] == errno.ENOSYS
    assert report["process_vm_readv"] == errno.EPERM
    assert report["pidfd_getfd"] == errno.EPERM
    assert report["process_madvise"] == errno.EPERM
    assert report["fork"] == errno.EPERM
    assert report["setpgid"] == errno.EPERM
    assert report["read_input"] == "ok"
    assert report["read_outside"] == errno.EACCES


@linux
def test_the_audio_probe_runs_under_the_decode_helpers_policy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(security regression: audio probe) ffmpeg reads an uploaded recording
    in the decoder sandbox: the worker's provider key stays out of its
    environment, it opens no network socket and reads no file but its input."""
    monkeypatch.setenv("ALIBABA_MODELSTUDIO_KEY", "worker-secret")
    outside = tmp_path / "other-upload"
    outside.write_bytes(b"another user's file")
    source = tmp_path / "upload.m4a"
    source.write_bytes(b"this job's file")
    run = capy_sandbox.run
    reports = []

    def in_ffmpegs_place(argv, policy, **_kwargs):
        # The probe runs under the policy ffmpeg was given.
        reports.append(_probe(policy, outside, source, run=run))
        progress = b"out_time_us=61000000\nprogress=end\n"
        return subprocess.CompletedProcess(argv, 0, progress, b"")

    monkeypatch.setattr(capy_sandbox, "run", in_ffmpegs_place)
    monkeypatch.setattr(decode.shutil, "which", lambda _name: "/usr/bin/ffmpeg")

    assert decode.audio_seconds(source) == 61.0
    (report,) = reports
    assert set(report["env"]) <= {"PYTHONPATH"}
    assert report["no_new_privs"] == 1 and report["seccomp"] == 2
    assert report["inet_socket"] == errno.EACCES
    assert report["fork"] == errno.EPERM
    assert report["read_input"] == "ok"
    assert report["read_outside"] == errno.EACCES


FORKER = textwrap.dedent(
    """
    import os, sys, time
    if os.fork() == 0:
        try:
            os.setsid()  # Leave the group the timeout kills.
        except OSError:
            pass
        for descriptor in (0, 1, 2):  # Let the launcher's read end.
            os.close(descriptor)
        time.sleep(600)
        os._exit(0)
    time.sleep(600)
    """
)


@linux
def test_a_converter_calling_setsid_is_still_killed_at_the_timeout() -> None:
    """(security regression: S1 group kill) A child that may start processes
    (as the parse child does) cannot move one out of its process group, so
    the timeout's group kill ends them all."""
    marker = f"capy-setsid-{uuid.uuid4().hex}"
    policy = capy_sandbox.Policy(
        limits={},
        blocked=frozenset({"setsid"}),
        read=(*capy_sandbox.python_paths(), "/usr", "/lib", "/lib64", "/etc"),
        timeout_s=1,
    )
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            capy_sandbox.run(
                [sys.executable, "-c", FORKER, marker], policy, max_output=None
            )
        assert _gone(marker)
    finally:
        _kill(_running(marker))


@linux
def test_a_child_dies_with_the_process_that_started_it(tmp_path: Path) -> None:
    """(security regression: S1/S2 death with the parent) A decoder never
    outlives the parser or worker process that launched it."""
    marker = f"capy-orphan-{uuid.uuid4().hex}"
    launcher = textwrap.dedent(
        f"""
        import sys
        sys.path.insert(0, {str(ROOT / "pipeline")!r})
        import capy_sandbox
        policy = capy_sandbox.Policy(
            limits={{}},
            blocked=frozenset(),
            read=(*capy_sandbox.python_paths(), "/usr", "/lib", "/lib64", "/etc"),
            timeout_s=60,
        )
        capy_sandbox.run(
            [sys.executable, "-c", "import time; time.sleep(60)", {marker!r}],
            policy,
            max_output=None,
        )
        """
    )
    parent = subprocess.Popen([sys.executable, "-c", launcher])
    try:
        deadline = time.monotonic() + 10
        while not _running(marker, started=True) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert _running(marker, started=True)
        parent.kill()
        parent.wait()
        assert _gone(marker)
    finally:
        parent.kill()
        _kill(_running(marker))


def _plain(timeout_s: float) -> capy_sandbox.Policy:
    return capy_sandbox.Policy(
        limits={},
        blocked=frozenset(),
        read=(*capy_sandbox.python_paths(), "/usr", "/lib", "/lib64", "/etc"),
        timeout_s=timeout_s,
    )


def test_a_child_past_its_output_cap_is_killed_and_refused() -> None:
    """(security regression: S2 decode answers) The parent reads a child's
    stdout only up to the cap its caller sets: past it the group is killed at
    once, long before the timeout, and only stderr's tail is kept."""
    flood = "import sys, time\nsys.stdout.buffer.write(bytes(8 << 20))\ntime.sleep(60)"
    started = time.monotonic()
    with pytest.raises(capy_sandbox.OutputLimit):
        capy_sandbox.run([sys.executable, "-c", flood], _plain(20), max_output=1 << 20)
    assert time.monotonic() - started < 10

    noisy = "import sys\nsys.stderr.write('x' * (1 << 20) + 'END')"
    completed = capy_sandbox.run(
        [sys.executable, "-c", noisy], _plain(60), max_output=1024
    )
    assert completed.returncode == 0
    assert len(completed.stderr) == capy_sandbox.STDERR_TAIL
    assert completed.stderr.endswith(b"END")


def test_output_just_past_the_cap_is_refused_however_late_it_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S2 decode answers) A child that writes just past
    the cap and exits at once, before the parent has read its pipe, is still
    refused: the cap is checked once its output is all in."""
    read = os.read
    readers: set[int] = set()

    def late(descriptor: int, size: int) -> bytes:
        # Each reader thread's first read comes well after the child exited.
        if (
            threading.current_thread() is not threading.main_thread()
            and threading.get_ident() not in readers
        ):
            readers.add(threading.get_ident())
            time.sleep(1.5)
        return read(descriptor, size)

    monkeypatch.setattr(capy_sandbox.os, "read", late)
    with pytest.raises(capy_sandbox.OutputLimit):
        capy_sandbox.run(
            [sys.executable, "-c", "import sys; sys.stdout.buffer.write(bytes(1025))"],
            _plain(20),
            max_output=1024,
        )


class _NoThreads:
    """capy_sandbox's threading, with threads that cannot start."""

    Event = threading.Event

    class Thread(threading.Thread):
        def start(self) -> None:
            raise RuntimeError("can't start new thread")


@linux
def test_a_child_is_killed_when_its_readers_cannot_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the parent cannot start the threads that read a child (its own
    memory limit, say), it kills the child's group rather than wait on it."""
    marker = f"capy-nothreads-{uuid.uuid4().hex}"
    monkeypatch.setattr(capy_sandbox, "threading", _NoThreads)
    outcome = []

    def call() -> None:
        try:
            capy_sandbox.run(
                [sys.executable, "-c", "import time; time.sleep(60)", marker],
                _plain(60),
                max_output=1024,
            )
        except RuntimeError as exc:
            outcome.append(exc)

    caller = threading.Thread(target=call, daemon=True)
    try:
        caller.start()
        caller.join(10)
        assert not caller.is_alive(), "waited on a child nothing reads"
        assert outcome and "can't start" in str(outcome[0])
    finally:
        _kill(_running(marker))


@linux
def test_the_group_is_killed_before_the_child_is_reaped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The exited child still holds its process group id when the group is
    killed, so no other process can have been given it."""
    states = []
    killpg = os.killpg

    def recording(group: int, sig: int) -> None:
        try:
            stat = Path(f"/proc/{group}/stat").read_text()
            states.append(stat.rsplit(")", 1)[1].split()[0])
        except FileNotFoundError:
            states.append("reaped")
        killpg(group, sig)

    monkeypatch.setattr(capy_sandbox.os, "killpg", recording)
    capy_sandbox.run([sys.executable, "-c", "pass"], _plain(60), max_output=1024)

    assert states == ["Z"]


@pytest.mark.parametrize("abi", [0, 5])
def test_a_deployed_host_without_landlock_abi_6_refuses_to_run_decoders(
    monkeypatch: pytest.MonkeyPatch, abi: int
) -> None:
    """(security regression: S0 Landlock requirement) APP_ENV production (UAT
    and production render it) refuses without Landlock or without ABI 6's
    signal and socket scoping; local and e2e run with what they have."""
    monkeypatch.setattr(capy_sandbox, "landlock_abi", lambda: abi)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="Landlock"):
        capy_sandbox.landlock_available()
    monkeypatch.setenv("APP_ENV", "development")
    assert capy_sandbox.landlock_available() is (abi >= 1)
    monkeypatch.setattr(capy_sandbox, "landlock_abi", lambda: 6)
    monkeypatch.setenv("APP_ENV", "production")
    assert capy_sandbox.landlock_available() is True


@linux
def test_every_decoder_ruleset_scopes_signals_and_abstract_sockets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S2 Landlock scoping) From ABI 6 the ruleset every
    decoder gets scopes signals and abstract Unix sockets to its own domain:
    no decoder signals the parser, the worker or another job's process."""
    calls = []

    class Libc:
        def syscall(self, number, *args):
            calls.append((number, args))
            return os.open(os.devnull, os.O_RDONLY) if number == 444 else 0

    monkeypatch.setattr(capy_sandbox, "_libc", Libc)
    monkeypatch.setattr(capy_sandbox, "landlock_abi", lambda: 6)
    capy_sandbox._landlock(("/usr",), ())

    number, (attr, size, flags) = calls[0]
    assert number == 444 and size.value == 24 and flags.value == 0
    # LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL
    assert attr._obj.scoped == 0b11
    assert [call[0] for call in calls] == [444, 445, 446]


SCOPED_PROBE = textwrap.dedent(
    """
    import json, os, socket, sys

    out = {}
    try:
        os.kill(int(sys.argv[1]), 0)
        out["signal"] = "ok"
    except OSError as exc:
        out["signal"] = exc.errno
    client = socket.socket(socket.AF_UNIX)
    try:
        client.connect("\\0" + sys.argv[2])
        out["abstract_socket"] = "ok"
    except OSError as exc:
        out["abstract_socket"] = exc.errno
    print(json.dumps(out))
    """
)


@linux
@pytest.mark.skipif(
    capy_sandbox.landlock_abi() < capy_sandbox.SCOPED_ABI,
    reason="needs Landlock ABI 6 (the deployed hosts have it)",
)
def test_a_decoder_cannot_signal_or_reach_a_process_outside_it(
    tmp_path: Path,
) -> None:
    """(security regression: S2 Landlock scoping) On a kernel with ABI 6 a
    decoder cannot signal the process that started it or connect to an
    abstract Unix socket another process listens on."""
    name = f"capy-scope-{uuid.uuid4().hex}"
    listener = socket.socket(socket.AF_UNIX)
    listener.bind("\0" + name)
    listener.listen(1)
    source = tmp_path / "upload.png"
    source.write_bytes(b"this job's file")
    try:
        completed = capy_sandbox.run(
            [sys.executable, "-c", SCOPED_PROBE, str(os.getpid()), name],
            decode._policy(source),
            max_output=1 << 16,
        )
    finally:
        listener.close()

    assert completed.returncode == 0, completed.stderr.decode()
    assert json.loads(completed.stdout) == {
        "signal": errno.EPERM,
        "abstract_socket": errno.EPERM,
    }


@linux
def test_the_worker_is_not_dumpable_and_a_deployed_one_needs_landlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S2 worker) Its decoders run with its uid, so no
    process may read its memory or environment; a deployed worker on a host
    without Landlock refuses to start."""
    import ctypes

    from pipeline.ingest import worker

    libc = ctypes.CDLL("libc.so.6")
    started = []
    monkeypatch.setattr(worker, "require_parse_timeouts", lambda: None)
    monkeypatch.setattr(
        worker.asyncio, "run", lambda job: (job.close(), started.append(True))
    )
    try:
        worker.main()
        assert started and libc.prctl(3, 0, 0, 0, 0) == 0  # PR_GET_DUMPABLE
        monkeypatch.setattr(capy_sandbox, "landlock_abi", lambda: 0)
        monkeypatch.setenv("APP_ENV", "production")
        with pytest.raises(RuntimeError, match="Landlock"):
            worker.main()
        assert len(started) == 1
    finally:
        libc.prctl(capy_sandbox.PR_SET_DUMPABLE, 1, 0, 0, 0)


def test_both_images_carry_the_one_launcher() -> None:
    """The parser and pipeline images copy the launcher from one source file,
    so they carry identical bytes."""
    parser = (ROOT / "parser/Dockerfile").read_text(encoding="utf-8")
    pipeline = (ROOT / "pipeline/Dockerfile").read_text(encoding="utf-8")

    assert (
        "COPY --chmod=644 pipeline/capy_sandbox.py ./parser/capy_sandbox.py" in parser
    )
    assert "COPY pipeline ./pipeline" in pipeline
    assert 'PYTHONPATH="/app/pipeline"' in pipeline
    assert not list((ROOT / "parser").rglob("capy_sandbox.py"))


def test_the_pipeline_image_carries_heif_dec_without_an_encoder() -> None:
    """Q353: libheif's decode-only tool and its libde265 plugin (LGPL-3.0),
    installed without recommends, so no x265 (GPL) encoder plugin comes."""
    pipeline = (ROOT / "pipeline/Dockerfile").read_text(encoding="utf-8")
    line = next(
        line
        for line in pipeline.splitlines()
        if "install" in line and "libheif" in line
    )
    assert "--no-install-recommends" in line and "libheif-plugin-libde265" in line
    assert "x265" not in pipeline.replace("no x265", "")


# The ingest outputs before the decodes moved into the helper (origin/main
# df56b54a3, in-process MuPDF): chunks with their retained headings and
# confidence, as JSON.
HONGKONG_CHUNKS = "5e80e2e86a425cb0e60ceceef1da370d846f2aeae056a06b30ce851fa17654d5"
CCL_CHUNKS = "30226c5f821083b2b474e33dd003ef64364ff1b67be1a026d510e038675ad901"

WORKER_WITHOUT_DECODERS = textwrap.dedent(
    r"""
    import gzip, hashlib, io, json, sys
    from dataclasses import asdict
    from pathlib import Path

    # The worker process cannot import a decoder: only its helper can.
    for name in ("pymupdf", "fitz", "PIL"):
        sys.modules[name] = None

    from pipeline.ingest import plan, source_text, thumbnail, worker
    from pipeline.retrieval.chunking import Chunk, Region
    from pipeline.retrieval.confidence import score_chunks
    from pipeline.ingest import decode

    fixtures, work = Path(sys.argv[1]), Path(sys.argv[2])
    out = {}
    folder = fixtures / "odl-hongkong-figures"
    with gzip.open(folder / "content_list.json.gz", "rt", encoding="utf-8") as f:
        blocks = json.load(f)
    (work / "refinement.json").write_text((folder / "refinement.json").read_text())
    chunks = worker._page_chunks(blocks, work, folder / "source.pdf")
    out["hongkong"] = [asdict(c) for c in chunks]

    folder = fixtures / "odl-ccl-feedback-p1"
    chunks = [
        Chunk(
            text=c["text"], section_path=c["section_path"], page_start=c["page_start"],
            page_end=c["page_end"], regions=[Region(r["page"], r["bbox"]) for r in c["regions"]],
        )
        for c in json.loads((folder / "chunks.json").read_text(encoding="utf-8"))
    ]
    evidence = decode.page_evidence(folder / "source.pdf", [])
    score_chunks(chunks, page_texts=evidence["page_texts"])
    out["ccl"] = [asdict(c) for c in chunks]

    image = work / "image.png"
    image.write_bytes(bytes.fromhex(sys.argv[3]))
    out["caption"] = source_text._encode_image(image, "image.png")[:23]
    card = thumbnail.render(
        plan.ProcessingPlan(
            version=2, format="png", route=plan.IMAGE_CAPTION, parser_route="",
            caption_mode="standalone", office=False, stages=(), resources=(),
        ),
        image, None,
    )
    out["thumbnail"] = card[8:12].decode()
    out["page"] = thumbnail.decode.page_webp(bytes.fromhex(sys.argv[3]))[8:12].decode()
    print(json.dumps(out))
    """
)


def _png(width: int, height: int) -> bytes:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "PNG")
    return buffer.getvalue()


def _digest(chunks: list[dict]) -> str:
    return hashlib.sha256(json.dumps(chunks, sort_keys=True).encode()).hexdigest()


@linux  # The worker imports fcntl.
def test_ingest_decodes_without_mupdf_or_pillow_in_the_worker_process(
    tmp_path: Path,
) -> None:
    """(security regression: S2 decode helper) The worker process itself
    imports neither decoder; every decode runs in the helper, and its outputs
    are byte-identical to the in-process decodes they replaced."""
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            WORKER_WITHOUT_DECODERS,
            str(FIXTURES),
            str(tmp_path),
            _png(200, 120).hex(),
        ],
        capture_output=True,
        timeout=300,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr.decode()[-3000:]
    out = json.loads(completed.stdout)

    assert len(out["hongkong"]) == 204
    assert _digest(out["hongkong"]) == HONGKONG_CHUNKS
    assert _digest(out["ccl"]) == CCL_CHUNKS
    assert out["caption"] == "data:image/jpeg;base64,"
    assert out["thumbnail"] == out["page"] == "WEBP"


def _pattern(width: int, height: int):
    from PIL import Image

    a = Image.linear_gradient("L").resize((width, height))
    b = Image.radial_gradient("L").resize((width, height))
    return Image.merge("RGB", (a, b, a.transpose(Image.Transpose.FLIP_LEFT_RIGHT)))


# The caption JPEGs (data URLs) before the move, for images below twice the
# caption edge: the helper changes nothing there.
CAPTIONS = {
    "rotated.png": "410dceb4b0e7678527c0e0c17b43c44947bbaff16460ad358e65cb04c6fde44c",
    "photo.jpg": "20e6050f45a76e0891cc1ad646026cb697a824ccdca95bc83e8ef1c0219237c6",
    "wide.jpg": "d65b8f3129e64f6b5fd040504a5053c5af8f60c0d0d5cb4e20a614fc024b5516",
    "spin.gif": "e0fb01381bd2fefc78f1d285af49020dc38a24b48a2a25014f158c4c6e92f515",
    # Pillow 13 quantizes this generated fixture differently (same palette,
    # other indices); the caption path itself is unchanged.
    "palette.png": "6c33c958ca5d39a6d730ef8c832466f57c2d6223beae22719af1a50ccd362dde",
}


@linux
def test_captions_are_byte_identical_below_twice_the_caption_edge(
    tmp_path: Path,
) -> None:
    from PIL import Image

    from pipeline.ingest import source_text

    rgba = _pattern(800, 400).convert("RGBA")
    rgba.putalpha(Image.linear_gradient("L").resize((800, 400)))
    exif = Image.Exif()
    exif[0x0112] = 6
    rgba.save(tmp_path / "rotated.png", "PNG", exif=exif)
    _pattern(640, 480).save(tmp_path / "photo.jpg", "JPEG", quality=90)
    _pattern(3000, 2000).save(tmp_path / "wide.jpg", "JPEG", quality=90)
    frames = [_pattern(120, 90).rotate(angle) for angle in (0, 90, 180, 270)]
    frames[0].save(
        tmp_path / "spin.gif", save_all=True, append_images=frames[1:], duration=100
    )
    palette = _pattern(300, 200).convert("P", palette=Image.Palette.ADAPTIVE, colors=16)
    palette.save(tmp_path / "palette.png", transparency=0)

    for name, expected in CAPTIONS.items():
        url = source_text._encode_image(tmp_path / name, name)
        assert hashlib.sha256(url.encode()).hexdigest() == expected, name


def test_a_large_image_shrinks_while_it_decodes(monkeypatch) -> None:
    """A JPEG decodes at a reduced DCT scale and any other image is reduced by
    a whole factor before a full-size copy, so the helper fits 768 MiB."""
    from PIL import Image

    big = _pattern(6000, 4000)
    buffer = io.BytesIO()
    big.save(buffer, "JPEG", quality=80)
    with Image.open(io.BytesIO(buffer.getvalue())) as jpeg:
        assert decode._decoded(jpeg, 1280).size == (3000, 2000)
    copies = []
    monkeypatch.setattr(Image.Image, "copy", lambda self: copies.append(self))
    assert decode._decoded(big, 1280).size == (2000, 1334)
    assert copies == []


def test_a_decode_answer_past_its_cap_is_a_failed_decode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S2 decode answers) The worker reads at most
    ``_MAX_ANSWER`` bytes of the helper's answer."""
    monkeypatch.setattr(decode, "_MAX_ANSWER", 1024)
    with pytest.raises(decode.DecodeFailed, match="over 1024 bytes"):
        decode.page_evidence(FIXTURES / "odl-ccl-feedback-p1" / "source.pdf", [])


@pytest.mark.parametrize(
    ("call", "answer"),
    [
        ("evidence", b"not json"),
        ("evidence", b'{"page_texts": "text", "visible_headings": []}'),
        ("evidence", b'{"page_texts": [], "visible_headings": [true]}'),
        ("evidence", b'{"page_texts": [], "visible_headings": [], "more": 1}'),
        ("caption", b'{"raw": false}'),
        ("caption", b'{"limit": "forged\\nlog line"}'),
        ("caption", b'{"jpeg": "not base64!"}'),
        ("thumbnail", b'{"webp": 7}'),
        ("page", b"[]"),
        ("source_image", b'{"image": "AA==", "format": "webp"}'),
        ("source_image", b'{"keep": true, "image": "AA=="}'),
    ],
)
def test_a_decode_answer_off_its_modes_shape_is_a_failed_decode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, call: str, answer: bytes
) -> None:
    """(security regression: S2 decode answers) Only the shapes a mode
    answers pass; any other answer from the helper fails the decode."""
    monkeypatch.setattr(
        decode.capy_sandbox,
        "run",
        lambda argv, _policy, **_kwargs: subprocess.CompletedProcess(
            argv, 0, answer, b""
        ),
    )
    source = tmp_path / "upload.png"
    calls = {
        "evidence": lambda: decode.page_evidence(source, []),
        "caption": lambda: decode.caption_jpeg(source, max_edge=8, max_pixels=64),
        "thumbnail": lambda: decode.thumbnail_webp(source, "png", max_pixels=64),
        "page": lambda: decode.page_webp(b""),
        "source_image": lambda: decode.source_image(b"", max_bytes=1, max_pixels=64),
    }
    with pytest.raises(decode.DecodeFailed):
        calls[call]()


def test_a_pixel_limit_carries_the_workers_own_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S2 decode answers) The caption helper names only
    which limit applied; the error carries the worker's fixed message."""
    for limit, message in decode._PIXEL_LIMITS.items():
        answer = json.dumps({"limit": limit}).encode()
        monkeypatch.setattr(
            decode.capy_sandbox,
            "run",
            lambda argv, _policy, answer=answer, **_kwargs: subprocess.CompletedProcess(
                argv, 0, answer, b""
            ),
        )
        with pytest.raises(decode.PixelLimit) as caught:
            decode.caption_jpeg(Path("image.png"), max_edge=8, max_pixels=64)
        assert str(caught.value) == message


@pytest.mark.parametrize(
    "answer",
    [b'{"image": "AA==", "format": "webp"}', b'{"keep": true, "image": "AA=="}', b"[]"],
)
def test_an_office_picture_answer_off_its_shape_removes_the_picture(
    monkeypatch: pytest.MonkeyPatch, answer: bytes
) -> None:
    """(security regression: S2 decode answers; Q347) A picture whose helper
    answers off the mode's shape, or fails, is removed like an unreadable one."""
    monkeypatch.setattr(
        decode.capy_sandbox,
        "run",
        lambda argv, _policy, **_kwargs: subprocess.CompletedProcess(
            argv, 0, answer, b""
        ),
    )
    assert decode.office_picture(b"", image_max_bytes=1, max_pixels=64) == "unreadable"


def test_each_office_picture_and_heic_gets_its_own_ten_seconds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """(security regression: Q347, Q353) One picture's helper, and libheif's
    tool, run with 10 s of CPU and a 10 s deadline, not the file's 120 s."""
    policies = []

    def run(argv, policy, **_kwargs):
        policies.append(policy)
        if argv[-1].endswith("out.jpg"):
            Path(argv[-1]).write_bytes(b"\xff\xd8\xff")
        return subprocess.CompletedProcess(argv, 0, b'{"keep": true}', b"")

    monkeypatch.setattr(decode.capy_sandbox, "run", run)
    monkeypatch.setattr(decode.shutil, "which", lambda _name: "/usr/bin/heif-dec")
    assert decode.office_picture(b"", image_max_bytes=1, max_pixels=64) == "keep"
    assert decode.heic_jpeg(b"heic") == b"\xff\xd8\xff"
    assert [(p.limits["CPU"], p.timeout_s) for p in policies] == [(10, 10), (10, 10)]
    assert policies[1].limits["FSIZE"] > 0 and "/dev/null" in policies[1].write


@linux
def test_the_image_rules_run_in_the_helper() -> None:
    """A picture of an imported Office file is compressed, and an image
    source shrunk to 5 megapixels, inside the decode helper (Epo 2026-10-24)."""
    images = ROOT / "e2e/fixtures/files/images"
    picture, kind = decode.office_picture(
        (images / "photo.jpg").read_bytes(),
        image_max_bytes=2 << 20,
        max_pixels=100_000_000,
    )
    assert kind == "jpeg" and picture[:3] == b"\xff\xd8\xff"
    shrunk, kind = decode.source_image(
        (images / "photo.jpg").read_bytes(), max_bytes=30 << 20, max_pixels=100_000_000
    )
    assert kind == "jpeg" and shrunk[:3] == b"\xff\xd8\xff"
    assert (
        decode.source_image(
            (images / "photo.heic").read_bytes(),
            max_bytes=30 << 20,
            max_pixels=100_000_000,
        )
        == "unreadable"
    )


@linux
def test_the_caption_helper_answers_the_pixel_limit(tmp_path: Path) -> None:
    from PIL import Image

    path = tmp_path / "wide.png"
    Image.new("RGB", (100, 100), "white").save(path)

    with pytest.raises(decode.PixelLimit, match="exceeds the decoded-pixel limit"):
        decode.caption_jpeg(path, max_edge=8, max_pixels=99)


def _blank_png(path: Path, width: int, height: int) -> None:
    """A transparent RGBA PNG written row by row, never held as pixels."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        size = struct.pack(">I", len(data))
        return size + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    compressor = zlib.compressobj()
    row = bytes(1 + 4 * width)
    data = b"".join(compressor.compress(row) for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", data + compressor.flush())
        + chunk(b"IEND", b"")
    )


@linux
def test_a_thumbnail_near_the_pixel_limit_fits_the_helper(tmp_path: Path) -> None:
    """A non-JPEG image near the largest Pillow opens (89 Mpx) shrinks while
    it decodes, so its thumbnail fits the helper's 768 MiB (measured: 694 MiB
    for this 88 Mpx RGBA PNG, over 1 GiB when decoded at full size first)."""
    path = tmp_path / "large.png"
    _blank_png(path, 9_400, 9_400)

    webp = decode.thumbnail_webp(path, "png", max_pixels=100_000_000)

    assert webp[8:12] == b"WEBP"


def test_page_chunks_bundle_evidence_matches_the_helper(tmp_path: Path) -> None:
    """The evidence the helper reads from a PDF is the parser's frozen Office
    evidence for the same blocks (parser/odl/evidence.py)."""
    parser_dir = ROOT / "parser"
    if str(parser_dir) not in sys.path:
        sys.path.insert(0, str(parser_dir))
    from odl.evidence import page_evidence

    folder = FIXTURES / "odl-hongkong-figures"
    with gzip.open(folder / "content_list.json.gz", "rt", encoding="utf-8") as f:
        blocks = json.load(f)
    frozen = page_evidence((folder / "source.pdf").read_bytes(), blocks)

    assert decode.page_evidence(folder / "source.pdf", blocks) == frozen
