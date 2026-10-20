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
import subprocess
import sys
import textwrap
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


def _probe(policy: capy_sandbox.Policy, outside: Path, inside: Path) -> dict:
    completed = capy_sandbox.run(
        [sys.executable, "-c", PROBE, str(outside), str(inside)], policy
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
    assert report["fork"] == errno.EPERM
    assert report["setpgid"] == errno.EPERM
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
            capy_sandbox.run([sys.executable, "-c", FORKER, marker], policy)
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
            limits={{}}, blocked=frozenset(), read=capy_sandbox.python_paths(),
            timeout_s=60,
        )
        capy_sandbox.run(
            [sys.executable, "-c", "import time; time.sleep(60)", {marker!r}], policy
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


def test_a_deployed_host_without_landlock_refuses_to_run_decoders(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S0 Landlock requirement) APP_ENV production (UAT
    and production render it) refuses; local and e2e run without it."""
    monkeypatch.setattr(capy_sandbox, "landlock_abi", lambda: 0)
    monkeypatch.setenv("APP_ENV", "production")
    with pytest.raises(RuntimeError, match="Landlock"):
        capy_sandbox.landlock_available()
    monkeypatch.setenv("APP_ENV", "development")
    assert capy_sandbox.landlock_available() is False


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
    "palette.png": "92322ced792a0bc63a8431e733cc60ded9aaaa832c65ab0c1c8cecdbad01df2e",
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
