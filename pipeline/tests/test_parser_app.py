"""Offline tests for the parser service runtime: parse slots over one bounded
FIFO, per-slot deadline/OOM isolation and quarantine, the page renders for the
ingest worker's VLM, the receipt keys the worker bills from, and the bundle
contract."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import importlib.util
import io
import json
import multiprocessing
import os
import pickle
import sys
import threading
import time
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_DIR = REPO_ROOT / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))
# The compose files set them; the module refuses to load without them.
os.environ.setdefault("CAPY_PARSE_WORKERS", "1")
os.environ.setdefault("CAPY_PARSE_MAX_PAGES", "1400")
# The module takes it out of the environment at import.
os.environ.setdefault("PARSER_TOKEN", "test-parser-token-of-thirty-two-chars")

spec = importlib.util.spec_from_file_location("app", PARSER_DIR / "app.py")
assert spec is not None and spec.loader is not None
parser_app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = parser_app
spec.loader.exec_module(parser_app)


@pytest.fixture(autouse=True)
def _work_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path / "work")


def _result(pages: int = 1, vlm: list[int] | None = None) -> dict:
    return {
        "content_list": [{"type": "text", "text": "a", "page_idx": 0}],
        "_vlm_pages": vlm or [],
        "_page_count": pages,
        "_source_format": "pdf",
        "_parse_lane": "vlm" if vlm else "digital",
        "_phases": {"java": 0.5, "repairs": 0.25},
    }


class FakeChild:
    """A parse or admission child: ``handler`` does the work, and ``terminate()``
    ends it the way SIGKILL ends a real child (its pipe closes, code -9)."""

    def __init__(self, handler) -> None:
        self.handler = handler
        self.starts = self.terminations = 0
        self.exitcode: int | None = None

    def start(self) -> None:
        self.starts += 1
        self.exitcode = None
        self._killed = asyncio.Event()

    @property
    def alive(self) -> bool:
        return self.starts > 0 and self.exitcode is None

    async def _until_killed(self, work):
        task = asyncio.ensure_future(work)
        killed = asyncio.ensure_future(self._killed.wait())
        await asyncio.wait({task, killed}, return_when="FIRST_COMPLETED")
        killed.cancel()
        if not self._killed.is_set():
            return task.result()
        task.cancel()
        raise parser_app._ChildExited("child was killed", self.exitcode)

    async def run(self, document, result_path):
        """A parse child: the handler's result goes to the result file."""
        result = await self._until_killed(self.handler(document))
        parser_app._write_worker_result(result_path, result)

    def terminate(self) -> None:
        self.terminations += 1
        if self.exitcode is None:
            self.exitcode = -9
            self._killed.set()

    def stop(self) -> None:
        pass


def _runtime(monkeypatch, handler, *, workers=1, depth=4):
    monkeypatch.setattr(parser_app, "PARSE_WORKERS", workers)
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", depth)
    children = [FakeChild(handler) for _ in range(workers)]
    runtime = parser_app.ParserRuntime(lambda index: children[index])
    return runtime, children


async def _until(predicate) -> None:
    for _ in range(400):
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition not reached")


def test_parse_workers_must_fit_the_queue_depth(monkeypatch) -> None:
    monkeypatch.setenv("CAPY_PARSE_QUEUE_DEPTH", "2")
    for workers in ("", "0", "3"):
        monkeypatch.setenv("CAPY_PARSE_WORKERS", workers)
        spec = importlib.util.spec_from_file_location(
            "app_check", PARSER_DIR / "app.py"
        )
        assert spec is not None and spec.loader is not None
        with pytest.raises(RuntimeError, match="CAPY_PARSE_WORKERS"):
            spec.loader.exec_module(importlib.util.module_from_spec(spec))


@pytest.mark.asyncio
async def test_parse_child_is_persistent_and_contains_document_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    unlink = parser_app._unlink

    def slow_unlink(*paths: Path) -> None:
        # A slow CI filesystem: close() must still leave no transfer file.
        time.sleep(0.2)
        unlink(*paths)

    monkeypatch.setattr(parser_app, "_unlink", slow_unlink)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    child = runtime._slots[0].process._process
    assert child is not None
    try:
        for name in ("first.txt", "second.txt"):
            # An unsupported format is one of the API's own kinds.
            with pytest.raises(
                parser_app.SourceUnreadable,
                match="document parsing supports PDF and Office files",
            ):
                await runtime.parse(parser_app.Document(b"not a document", name))
            assert runtime.ready
            assert runtime._slots[0].process._process is child
    finally:
        await runtime.close()

    assert not list(tmp_path.glob("transfer-*"))


@pytest.mark.asyncio
async def test_a_child_whose_answer_was_over_the_limit_is_replaced_before_the_next(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An oversized answer closes the answer pipe before the SIGKILL lands (here
    it never does); the slot replaces that child for the next document instead
    of reading a closed pipe."""
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    slot = runtime._slots[0]
    first = slot.process._process
    monkeypatch.setattr(slot.process, "terminate", lambda: None)
    try:
        monkeypatch.setattr(parser_app, "MESSAGE_MAX_BYTES", 8)
        with pytest.raises(parser_app.ParserRuntimeFailure, match="invalid answer"):
            await runtime.parse(parser_app.Document(b"not a document", "first.txt"))
        monkeypatch.setattr(parser_app, "MESSAGE_MAX_BYTES", 1 << 24)
        with pytest.raises(parser_app.SourceUnreadable, match="PDF and Office"):
            await runtime.parse(parser_app.Document(b"not a document", "second.txt"))
        assert slot.process._process is not first
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_slots_take_documents_in_arrival_order_up_to_the_worker_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started: list[str] = []
    active = peak = 0

    async def handler(document):
        nonlocal active, peak
        started.append(document.name)
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return _result()

    runtime, _ = _runtime(monkeypatch, handler, workers=2)
    await runtime.start()
    try:
        results = await asyncio.gather(
            *(
                runtime.parse(parser_app.Document(b"pdf", f"{n}.pdf"))
                for n in ("first", "second", "third", "fourth")
            )
        )
    finally:
        await runtime.close()

    assert started == ["first.pdf", "second.pdf", "third.pdf", "fourth.pdf"]
    assert peak == 2
    assert all(queue_ms >= 0 for _result, queue_ms in results)
    assert runtime.documents_completed == 4


@pytest.mark.asyncio
async def test_depth_counts_executing_and_waiting_documents_across_slots(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = asyncio.Event()

    async def handler(_document):
        await release.wait()
        return _result()

    runtime, _ = _runtime(monkeypatch, handler, workers=2, depth=4)
    await runtime.start()
    try:
        held = [
            asyncio.create_task(runtime.parse(parser_app.Document(b"pdf", f"{n}.pdf")))
            for n in range(4)
        ]
        await _until(lambda: runtime.health()["executing_jobs"] == 2)
        assert runtime.active_jobs == 4 and runtime.health()["queued_jobs"] == 2
        with pytest.raises(parser_app.ParserCapacity):
            await runtime.parse(parser_app.Document(b"pdf", "fifth.pdf"))
        release.set()
        await asyncio.gather(*held)
    finally:
        await runtime.close()
    assert runtime.active_jobs == 0


@pytest.mark.asyncio
async def test_cancelling_a_queued_request_removes_only_that_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    executed: list[str] = []

    async def handler(document):
        executed.append(document.name)
        if document.name == "first.pdf":
            first_started.set()
            await release_first.wait()
        return _result()

    runtime, _ = _runtime(monkeypatch, handler, depth=2)
    await runtime.start()
    try:
        first = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "first.pdf"))
        )
        await first_started.wait()
        cancelled = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "cancelled.pdf"))
        )
        await asyncio.sleep(0)
        assert runtime.active_jobs == 2

        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        await _until(lambda: runtime.active_jobs == 1)
        assert runtime.health()["queued_jobs"] == 0

        replacement = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "replacement.pdf"))
        )
        await asyncio.sleep(0)
        assert runtime.active_jobs == 2
        release_first.set()
        await asyncio.gather(first, replacement)
    finally:
        release_first.set()
        await runtime.close()

    assert executed == ["first.pdf", "replacement.pdf"]
    assert runtime.active_jobs == 0


@pytest.mark.asyncio
async def test_cancelling_an_executing_request_keeps_deadline_and_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "PARSE_DOCUMENT_TIMEOUT_S", 0.05)
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    started = asyncio.Event()

    async def handler(_document):
        started.set()
        await asyncio.Event().wait()

    runtime, (child,) = _runtime(monkeypatch, handler, depth=1)
    await runtime.start()
    try:
        request = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "cancelled.pdf"))
        )
        await started.wait()
        owned_future = runtime._slots[0].work.future

        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert runtime.active_jobs == 1
        assert not owned_future.done()
        with pytest.raises(parser_app.ParserCapacity):
            await runtime.parse(parser_app.Document(b"", "over-admitted.pdf"))

        await _until(lambda: runtime.active_jobs == 0)
        assert isinstance(owned_future.exception(), parser_app.ParseHardTimeout)
        assert child.terminations == 1 and runtime.state == "ready"
        assert not (tmp_path / "quarantine").exists()
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_hard_deadline_quarantines_and_replaces_only_that_slot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deadline starts when the document leaves the queue; the executing
    fingerprint is quarantined, its child replaced, and the other slot and
    the queue keep running."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "PARSE_DOCUMENT_TIMEOUT_S", 1.0)
    monkeypatch.setattr(
        parser_app, "_schedule_restart_backstop", lambda: pytest.fail("restart")
    )
    release = asyncio.Event()

    async def handler(document):
        if document.name == "slow.pdf":
            await asyncio.Event().wait()
        await release.wait()
        return _result()

    runtime, children = _runtime(monkeypatch, handler, workers=2)
    await runtime.start()
    try:
        slow = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "slow.pdf", "slow-fp"))
        )
        # other's deadline falls 0.5 s after slow's, room for a slow CI runner
        await asyncio.sleep(0.5)
        other = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "other.pdf", "other-fp"))
        )
        queued = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "next.pdf", "next-fp"))
        )
        with pytest.raises(parser_app.ParseHardTimeout):
            await slow
        release.set()
        await asyncio.gather(other, queued)
        assert runtime.state == "ready"
        assert sorted(c.terminations for c in children) == [0, 1]
        assert sorted(c.starts for c in children) == [1, 2]
    finally:
        await runtime.close()

    marker = json.loads((tmp_path / "quarantine" / "slow-fp.json").read_text())
    assert marker["reason"] == "parse_hard_timeout"
    assert marker["parser_version"] == parser_app.PARSER_VERSION
    assert sorted(p.name for p in (tmp_path / "quarantine").iterdir()) == [
        "slow-fp.json"
    ]


@pytest.mark.asyncio
async def test_java_timeout_is_a_hard_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)

    async def handler(_document):
        raise parser_app.JavaTimeout("OpenDataLoader exceeded 600 seconds")

    runtime, (child,) = _runtime(monkeypatch, handler)
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParseHardTimeout):
            await runtime.parse(parser_app.Document(b"pdf", "a.pdf", fingerprint="fp"))
    finally:
        await runtime.close()
    assert (tmp_path / "quarantine" / "fp.json").exists()
    assert child.terminations == 1


@pytest.mark.parametrize(
    ("death", "oom_kills", "expected"),
    [
        ("child", 1, "parse_oom"),
        ("java", 1, "parse_oom"),
        # LibreOffice's launcher hides the kill: any failed conversion counts.
        ("office", 1, "parse_oom"),
        # SIGKILL without a cgroup OOM kill, or an ordinary crash during one:
        # a runtime failure with the ordinary retry, nothing quarantined.
        ("child", 0, "runtime"),
        ("crash", 1, "runtime"),
        # A failed conversion without one keeps its own error.
        ("office", 0, "office"),
    ],
)
@pytest.mark.asyncio
async def test_oom_kill_is_attributed_to_the_document_whose_process_died(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, death, oom_kills, expected
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    kills = 0
    monkeypatch.setattr(parser_app, "_cgroup_event_value", lambda _name: kills)
    other_started = asyncio.Event()
    release = asyncio.Event()

    async def handler(document):
        nonlocal kills
        if document.name == "other.pdf":
            other_started.set()
            await release.wait()
            return _result()
        await other_started.wait()
        kills += oom_kills
        if death == "java":
            raise parser_app.JavaKilled("OpenDataLoader was killed")
        if death == "office":
            raise parser_app.OfficeConversionFailed("LibreOffice could not convert")
        raise parser_app._ChildExited("exited", -9 if death == "child" else 1)

    runtime, children = _runtime(monkeypatch, handler, workers=2)
    await runtime.start()
    try:
        other = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "other.pdf", "other-fp"))
        )
        victim = runtime.parse(parser_app.Document(b"", "big.pdf", "big-fp"))
        error = {
            "parse_oom": parser_app.ParseOOM,
            "runtime": parser_app.ParserRuntimeFailure,
            "office": parser_app.OfficeConversionFailed,
        }[expected]
        with pytest.raises(error):
            await victim
        release.set()
        assert (await other)[0] == _result()
    finally:
        await runtime.close()

    quarantined = sorted(p.name for p in tmp_path.glob("quarantine/*.json"))
    assert quarantined == (["big-fp.json"] if expected == "parse_oom" else [])
    # Only the victim's child is stopped, and only for an OOM.
    assert sum(c.terminations for c in children) == (expected == "parse_oom")


def _parsed(data: bytes, textless: list[int], preview: bool = False):
    """``run_document``'s inputs for ``data``: the normalised document and the
    parse output, with ``textless`` as the pages without a text layer."""
    from types import SimpleNamespace

    normalized = SimpleNamespace(
        data=data,
        preview_pdf=data if preview else None,
        source_format="docx" if preview else "pdf",
    )
    output = SimpleNamespace(
        content_list=[{"type": "text", "text": "Source text", "page_idx": 0}],
        textless_pages=textless,
        page_count=2,
        phases={},
        stages={},
        repaired_fonts=[],
        furniture=[],
        parsed_pdf=None,
        drawing_steps=0,
        drawings_stopped_at=None,
    )
    return normalized, output


def _two_pages() -> bytes:
    import pymupdf

    with pymupdf.open() as pdf:
        pdf.new_page(width=600, height=800).insert_text((50, 100), "Source text")
        pdf.new_page(width=600, height=800).draw_rect((50, 50, 300, 300))
        return pdf.tobytes()


@pytest.mark.parametrize("office", [False, True], ids=["pdf", "office"])
def test_text_less_pages_go_into_the_bundle_as_grey_renders_for_the_vlm(
    monkeypatch: pytest.MonkeyPatch, office: bool
) -> None:
    """Each page without a text layer becomes ``vlm/<page>.jpg``, a grey JPEG
    with a 1,280 px long edge, and is counted for billing. Office evidence
    comes from the parsed blocks alone."""
    from odl import document, refine
    from PIL import Image

    data = _two_pages()
    normalized, output = _parsed(data, [1], preview=office)
    monkeypatch.setattr(document, "normalize_document", lambda *_args: normalized)
    monkeypatch.setattr(refine, "parse_pdf", lambda *_args, **_kwargs: output)

    result = parser_app.run_document(parser_app.Document(b"source", "scan.pdf"))
    assert result["_parse_lane"] == "vlm" and "vlm_render" in result["_phases"]
    if office:
        assert result["_page_evidence"]["page_texts"][0].strip() == "Source text"
    path = parser_app.WORK_DIR / "transfer.result"
    parser_app._write_worker_result(path, result)
    measurements = parser_app._measurements(result, 1.0, 0)
    assert measurements["_ocr_page_count"] == 1
    bundle = parser_app._bundle_bytes(
        parser_app._read_worker_result(path), "fp", "aa" * 32, "job", measurements
    )
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        assert archive.getinfo("vlm/1.jpg").compress_type == zipfile.ZIP_STORED
        render = archive.read("vlm/1.jpg")
        assert "vlm/0.jpg" not in archive.namelist()
    with Image.open(io.BytesIO(render)) as image:
        assert (image.format, image.mode, image.size) == ("JPEG", "L", (960, 1280))


def test_a_drawing_step_backstop_trip_is_logged_and_counted(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Once per parse: the page where the steps ran out, the steps and the
    fingerprint; the receipt counts the steps."""
    from odl import document, refine

    normalized, output = _parsed(_two_pages(), [])
    output.drawing_steps, output.drawings_stopped_at = 20_000_123, 1
    monkeypatch.setattr(document, "normalize_document", lambda *_args: normalized)
    monkeypatch.setattr(refine, "parse_pdf", lambda *_args, **_kwargs: output)
    result = parser_app.run_document(parser_app.Document(b"%PDF", "a.pdf", "fp-1"))

    assert (
        capsys.readouterr().out.count(
            "drawing clusters stopped on page 1 after 20000123 steps: fp-1"
        )
        == 1
    )
    assert parser_app._measurements(result, 1.0, 0)["_drawing_steps"] == 20_000_123


def test_a_document_over_the_scanned_page_cap_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from odl import document, refine

    monkeypatch.setattr(parser_app, "SCANNED_PAGE_CAP", 1)
    normalized, output = _parsed(_two_pages(), [0, 1])
    monkeypatch.setattr(document, "normalize_document", lambda *_args: normalized)
    monkeypatch.setattr(refine, "parse_pdf", lambda *_args, **_kwargs: output)
    with pytest.raises(parser_app.ParseTooManyScannedPages, match="at most 1"):
        parser_app.run_document(parser_app.Document(b"source", "scan.pdf"))


@pytest.mark.parametrize(
    "renders",
    [
        {"_vlm_pages": [2], "_vlm_images": [b"\xff\xd8\xffjpeg"]},
        {"_vlm_pages": [0], "_vlm_images": [b"\x89PNG\r\n\x1a\n"]},
        {"_vlm_pages": [0, 1], "_vlm_images": [b"\xff\xd8\xffjpeg"]},
    ],
    ids=["past-the-last-page", "not-a-jpeg", "unpaired"],
)
def test_bundle_refuses_page_renders_it_cannot_vouch_for(renders: dict) -> None:
    with pytest.raises(ValueError, match="page renders are invalid"):
        parser_app._bundle_bytes(
            {"content_list": [], "_page_count": 2, **renders},
            "fp",
            "aa" * 32,
            "job",
            {},
        )


def _three_page_pdf() -> bytes:
    import pymupdf

    with pymupdf.open() as document:
        document.new_page().insert_text((50, 50), "native text " * 8)
        document.new_page()
        document.new_page().insert_text((50, 50), "short")
        return document.tobytes()


_three_page_pdf_bytes = _three_page_pdf()


@pytest.mark.asyncio
async def test_the_api_process_opens_no_pdf_with_mupdf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A PDF request reaches its parse child without the API process opening
    it: there is no admission count, the child counts the pages."""
    import pymupdf

    def not_in_the_api(*_args, **_kwargs):
        raise AssertionError("MuPDF opened a source in the API process")

    async def parsed(document):
        assert document.data == _three_page_pdf_bytes
        return _result(3)

    monkeypatch.setattr(pymupdf, "open", not_in_the_api)
    monkeypatch.setattr(pymupdf, "Document", not_in_the_api)
    runtime, (child,) = _runtime(monkeypatch, parsed)
    monkeypatch.setattr(parser_app, "runtime", runtime)
    await runtime.start()
    try:
        _parsed, measurements = await parser_app._run(
            parser_app.Document(_three_page_pdf_bytes, "lecture.pdf")
        )
    finally:
        await runtime.close()
    assert measurements["_page_count"] == 3 and child.starts == 1


_UNPICKLED: list[str] = []


def _record_unpickled(label: str) -> None:
    _UNPICKLED.append(label)


class _CallsOnLoad:
    def __reduce__(self):
        return (_record_unpickled, ("loaded",))


@pytest.mark.asyncio
async def test_child_answers_are_read_as_data_never_unpickled(tmp_path: Path) -> None:
    """A parse child's answer and a parse result file are
    JSON and length-framed bytes; a pickle in either is refused unread."""
    child = parser_app._Child(_record_unpickled, name="test child")
    reader, writer = multiprocessing.Pipe(duplex=False)
    child._responses = reader
    writer.send(("ok", _CallsOnLoad()))
    with pytest.raises(ValueError):
        await child.recv()
    reader.close()
    writer.close()

    result_path = tmp_path / "transfer.result"
    result_path.write_bytes(pickle.dumps({"content_list": [], "x": _CallsOnLoad()}))
    with pytest.raises(ValueError):
        parser_app._read_worker_result(result_path)

    assert _UNPICKLED == []


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (parser_app.JavaTimeout("too slow"), parser_app.JavaTimeout),
        (parser_app.JavaKilled("killed"), parser_app.JavaKilled),
        (
            parser_app.OfficeConversionFailed("no PDF"),
            parser_app.OfficeConversionFailed,
        ),
        (
            parser_app.OfficeFormatMismatch("not a .docx"),
            parser_app.OfficeFormatMismatch,
        ),
        (parser_app.ParseTooManyPages("1500 pages"), parser_app.ParseTooManyPages),
        (
            parser_app.TooManyElements("more than 2,000 table rows"),
            parser_app.TooManyElements,
        ),
        (
            parser_app.ParseTooManyScannedPages("501 pages have no text layer"),
            parser_app.ParseTooManyScannedPages,
        ),
        (
            parser_app.OfficeConversionTimeout("conversion exceeded 180 seconds"),
            parser_app.OfficeConversionTimeout,
        ),
        (parser_app.SourceUnreadable("no pages"), parser_app.SourceUnreadable),
        (parser_app.ParseOOM("past the address space"), parser_app.ParseOOM),
        (ValueError("broken PDF"), RuntimeError),
    ],
)
@pytest.mark.asyncio
async def test_child_errors_keep_the_kind_the_api_classifies(error, kind) -> None:
    """Deadline, OOM and refusal handling tell child errors apart by kind;
    any other error arrives as a RuntimeError naming its type."""
    child = parser_app._Child(_record_unpickled, name="test child")
    reader, writer = multiprocessing.Pipe(duplex=False)
    child._responses = reader
    parser_app._send_error(writer, error)
    with pytest.raises(kind, match=str(error)) as raised:
        parser_app._unwrap(await child.recv())
    assert type(raised.value) is kind
    reader.close()
    writer.close()


@pytest.mark.asyncio
async def test_an_answer_over_the_pipe_limit_ends_the_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "MESSAGE_MAX_BYTES", 16)
    child = parser_app._Child(_record_unpickled, name="test child")
    ended: list[str] = []
    monkeypatch.setattr(child, "terminate", lambda: ended.append("terminated"))
    reader, writer = multiprocessing.Pipe(duplex=False)
    child._responses = reader
    writer.send_bytes(b'["ok", "' + b"x" * 16 + b'"]')
    with pytest.raises(parser_app.ParserRuntimeFailure, match="invalid answer"):
        await child.recv()
    assert ended == ["terminated"]
    reader.close()
    writer.close()


def test_a_result_file_is_refused_when_truncated_or_oversized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "transfer.result"
    parser_app._write_worker_result(path, {**_result(), "_parsed_pdf": b"%PDF-1.7"})
    whole = path.read_bytes()
    path.write_bytes(whole[:-3])
    with pytest.raises(ValueError, match="invalid result file"):
        parser_app._read_worker_result(path)

    path.write_bytes(whole)
    monkeypatch.setattr(parser_app, "MAX_ARTIFACT_EXPANDED_BYTES", len(whole) - 1)
    with pytest.raises(ValueError, match="oversized result file"):
        parser_app._read_worker_result(path)


@pytest.mark.parametrize(
    ("oom_kills", "code"), [(0, "parse_hard_timeout"), (1, "parse_oom")]
)
@pytest.mark.asyncio
async def test_a_conversion_past_its_timeout_is_final_like_the_parse_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, oom_kills: int, code: str
) -> None:
    """A LibreOffice conversion past its timeout is a hard timeout: the
    fingerprint is quarantined and the child replaced. An OOM kill counted
    meanwhile still makes it parse_oom."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    kills = 0
    monkeypatch.setattr(parser_app, "_cgroup_event_value", lambda _name: kills)

    async def handler(_document):
        nonlocal kills
        kills += oom_kills
        raise parser_app.OfficeConversionTimeout(
            "LibreOffice conversion exceeded 180 seconds"
        )

    runtime, (child,) = _runtime(monkeypatch, handler)
    await runtime.start()
    try:
        with pytest.raises(
            (parser_app.ParseHardTimeout, parser_app.ParseOOM)
        ) as raised:
            await runtime.parse(parser_app.Document(b"PK", "deck.pptx", "deck-fp"))
    finally:
        await runtime.close()

    assert json.loads(parser_app._failure_response(raised.value).body)["code"] == code
    marker = json.loads((tmp_path / "quarantine" / "deck-fp.json").read_text())
    assert marker["reason"] == code and child.terminations == 1
    if code == "parse_hard_timeout":
        assert "LibreOffice conversion exceeded 180 seconds" in str(raised.value)


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_AS is Linux")
@pytest.mark.asyncio
async def test_a_parse_child_runs_under_its_address_space_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    try:
        # The child sets it first thing; a parse round trip is past that.
        with pytest.raises(parser_app.SourceUnreadable):
            await runtime.parse(parser_app.Document(b"not a document", "a.txt"))
        pid = runtime._slots[0].process._process.pid
        limits = Path(f"/proc/{pid}/limits").read_text()
    finally:
        await runtime.close()
    [line] = [line for line in limits.splitlines() if "Max address space" in line]
    assert line.split()[3:5] == [str(parser_app.PARSE_CHILD_MAX_BYTES), "unlimited"]


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (MemoryError(), "ParseOOM"),
        (OSError(errno.ENOMEM, "Cannot allocate memory"), "ParseOOM"),
        (RuntimeError("code=2: malloc (400000000 bytes) failed"), "ParseOOM"),
        # Java's output tail is not MuPDF's allocation failure.
        (
            RuntimeError("OpenDataLoader exited 1: malloc (8 bytes) failed"),
            "RuntimeError",
        ),
    ],
    ids=["python", "enomem", "mupdf", "java-output"],
)
def test_a_parse_past_the_address_space_answers_parse_oom(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception, kind: str
) -> None:
    """In the child, a failed allocation (Python's, the OS's or MuPDF's)
    becomes ParseOOM; other errors keep their kind."""

    def fails(_document):
        raise error

    monkeypatch.setattr(parser_app, "run_document", fails)
    # Not this test process's own limits.
    monkeypatch.setattr(parser_app, "_limit_address_space", lambda _limit: None)
    monkeypatch.setattr(parser_app, "_set_oom_score_adj", lambda _value: None)
    monkeypatch.setattr(parser_app, "_sandbox_parse_child", lambda _work_dir: None)
    monkeypatch.setattr(parser_app.os, "setsid", lambda: None, raising=False)
    child_requests, requests = multiprocessing.Pipe(duplex=False)
    responses, child_responses = multiprocessing.Pipe(duplex=False)
    source = tmp_path / "a.pdf"
    source.write_bytes(b"%PDF")
    requests.send((str(source), str(tmp_path / "a.result"), "a.pdf", "fp", None))
    requests.send(None)
    parser_app._parse_worker_main(child_requests, child_responses, str(tmp_path))
    assert json.loads(responses.recv_bytes())[1][0] == kind


@pytest.mark.asyncio
async def test_parse_oom_from_the_child_is_quarantined_and_the_child_replaced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)

    async def handler(document):
        if document.name == "big.pdf":
            raise parser_app.ParseOOM("past the address space")
        return _result()

    runtime, (child,) = _runtime(monkeypatch, handler)
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParseOOM) as raised:
            await runtime.parse(parser_app.Document(b"", "big.pdf", "big-fp"))
        await runtime.parse(parser_app.Document(b"", "next.pdf", "next-fp"))
    finally:
        await runtime.close()
    assert json.loads(parser_app._failure_response(raised.value).body)["code"] == (
        "parse_oom"
    )
    marker = json.loads((tmp_path / "quarantine" / "big-fp.json").read_text())
    assert marker["reason"] == "parse_oom"
    # It answered, so it is replaced before the next document, not killed.
    assert child.terminations == 0 and child.starts == 2


@pytest.mark.skipif(sys.platform != "linux", reason="prctl is Linux")
@pytest.mark.asyncio
async def test_the_api_process_is_not_dumpable_once_started(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Children run as the same user; none may trace the API or read its
    memory and environment."""
    import ctypes

    libc = ctypes.CDLL("libc.so.6")
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)

    async def nothing() -> None:
        pass

    monkeypatch.setattr(parser_app.runtime, "start", nothing)
    monkeypatch.setattr(parser_app.runtime, "close", nothing)
    try:
        async with parser_app.lifespan(parser_app.app):
            assert libc.prctl(3, 0, 0, 0, 0) == 0  # PR_GET_DUMPABLE
    finally:
        libc.prctl(parser_app.capy_sandbox.PR_SET_DUMPABLE, 1, 0, 0, 0)


@pytest.mark.asyncio
async def test_the_parser_holds_its_token_out_of_every_childs_reach(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """(security regression: S1 parser token) The token lives in the module,
    not the environment children inherit; the parser refuses to start without
    one and no request passes without it."""

    class Request:
        def __init__(self, header: str) -> None:
            self.headers = {"authorization": header} if header else {}

    assert parser_app.PARSER_TOKEN and "PARSER_TOKEN" not in os.environ
    assert parser_app._authorized(Request(f"Bearer {parser_app.PARSER_TOKEN}"))
    assert not parser_app._authorized(Request(""))
    assert not parser_app._authorized(Request("Bearer wrong"))
    monkeypatch.setattr(parser_app, "PARSER_TOKEN", "")
    assert not parser_app._authorized(Request("Bearer "))
    with pytest.raises(RuntimeError, match="PARSER_TOKEN"):
        async with parser_app.lifespan(parser_app.app):
            pass


@pytest.mark.asyncio
@pytest.mark.parametrize("app_env", ["production", None])
async def test_the_parser_refuses_a_short_token_outside_development(
    app_env: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(security regression: rate-limit audit M4) A token under 32 characters
    stops the parser unless APP_ENV is development or e2e; a missing APP_ENV
    is checked."""
    monkeypatch.setattr(parser_app, "PARSER_TOKEN", "t" * 31)
    if app_env is None:
        monkeypatch.delenv("APP_ENV", raising=False)
    else:
        monkeypatch.setenv("APP_ENV", app_env)
    with pytest.raises(RuntimeError, match="at least 32 characters"):
        async with parser_app.lifespan(parser_app.app):
            pass


@pytest.mark.skipif(sys.platform != "linux", reason="prctl is Linux")
@pytest.mark.asyncio
async def test_a_deployed_parser_refuses_to_start_without_landlock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(security regression: S0 Landlock requirement)"""
    import ctypes

    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app.capy_sandbox, "landlock_abi", lambda: 0)
    monkeypatch.setenv("APP_ENV", "production")
    try:
        with pytest.raises(RuntimeError, match="Landlock"):
            async with parser_app.lifespan(parser_app.app):
                pass
    finally:
        ctypes.CDLL("libc.so.6").prctl(
            parser_app.capy_sandbox.PR_SET_DUMPABLE, 1, 0, 0, 0
        )


@pytest.mark.skipif(sys.platform != "linux", reason="prctl is Linux")
@pytest.mark.asyncio
async def test_a_parser_whose_work_folder_cannot_hold_the_pipe_refuses_to_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A CAPY_PARSE_WORK_DIR too long for LibreOffice's pipe path stops the
    parser at startup, not at its first Office document."""
    import ctypes

    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "WORK_DIR", Path("/run/" + "w" * 40))
    monkeypatch.setattr(parser_app.office.os, "access", lambda _path, _mode: False)
    try:
        with pytest.raises(RuntimeError, match="CAPY_PARSE_WORK_DIR"):
            async with parser_app.lifespan(parser_app.app):
                pass
    finally:
        ctypes.CDLL("libc.so.6").prctl(
            parser_app.capy_sandbox.PR_SET_DUMPABLE, 1, 0, 0, 0
        )


@pytest.mark.skipif(sys.platform != "linux", reason="Landlock and seccomp are Linux")
@pytest.mark.asyncio
async def test_a_parse_child_reads_only_its_slot_and_holds_no_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(security regression: S1 parse child sandbox) A parse child confines
    itself after its setsid: it cannot read the spool (another job's source),
    it inherited no PARSER_TOKEN, and its limits, no_new_privs and seccomp
    filter are in place."""
    spool = tmp_path / "spool" / "sources"
    spool.mkdir(parents=True)
    other = spool / "source-other-job"
    other.write_bytes(b"%PDF-1.7 another user's upload")
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path / "work")
    child = parser_app._ParseWorkerProcess(0)
    child.start()
    try:
        await child.send(
            (str(other), str(child.work_dir / "transfer.result"), "a.pdf", "", None)
        )
        status, (kind, _detail) = await child.recv()
        pid = child._process.pid
        environ = Path(f"/proc/{pid}/environ").read_bytes()
        limits = Path(f"/proc/{pid}/limits").read_text()
        proc_status = Path(f"/proc/{pid}/status").read_text()
    finally:
        await asyncio.to_thread(child.stop)

    assert (status, kind) == ("error", "PermissionError")
    assert b"PARSER_TOKEN=" not in environ
    assert parser_app.PARSER_TOKEN.encode() not in environ
    rows = {line[:26].strip(): line[26:].split()[:2] for line in limits.splitlines()}
    assert rows["Max open files"] == ["256", "256"]
    assert rows["Max file size"] == [str(512 << 20)] * 2
    assert rows["Max core file size"] == ["0", "0"]
    assert "NoNewPrivs:	1" in proc_status and "Seccomp:	2" in proc_status


def test_a_parse_result_file_round_trips_blocks_and_bytes(tmp_path: Path) -> None:
    result = {
        **_result(3, vlm=[0, 2]),
        "_parsed_pdf": b"%PDF-1.7 repaired",
        "_page_image": b"\x89PNG\r\n\x1a\nimage",
        "_vlm_images": [b"\xff\xd8\xffpage 1", b"\xff\xd8\xffpage 3"],
    }
    path = tmp_path / "transfer.result"
    parser_app._write_worker_result(path, result)
    assert parser_app._read_worker_result(path) == result

    del result["_parsed_pdf"], result["_page_image"], result["_vlm_images"]
    result["_vlm_pages"] = []
    parser_app._write_worker_result(path, result)
    assert parser_app._read_worker_result(path) == result


def test_the_page_cap_refuses_an_office_document_after_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pymupdf
    from odl import document as odl_document

    monkeypatch.setattr(parser_app, "MAX_PAGES", 2)

    with pymupdf.open() as rendered:
        for _ in range(3):
            rendered.new_page()
        pdf = rendered.tobytes()
    monkeypatch.setattr(
        odl_document,
        "normalize_document",
        lambda *_args: odl_document.NormalizedDocument(
            pdf, "deck.pdf", "pptx", preview_pdf=pdf
        ),
    )
    with pytest.raises(parser_app.ParseTooManyPages, match="3 pages"):
        parser_app.run_document(parser_app.Document(b"PK", "deck.pptx"))


@pytest.mark.parametrize(
    "prefix",
    [b"", b"\x00", b"\xef\xbb\xbf", b"garbage line\n"],
    ids=["plain", "nul", "bom", "text"],
)
def test_the_parse_child_checks_the_page_cap_of_every_document(
    monkeypatch: pytest.MonkeyPatch, prefix: bytes
) -> None:
    """The parse child counts every PDF's pages, a leading NUL, BOM or line
    of text included, and refuses one over the cap before the Java run."""
    import pymupdf
    from odl import refine

    monkeypatch.setattr(parser_app, "MAX_PAGES", 2)

    def parsed(*_args, **_kwargs):
        raise AssertionError("parsed past the page cap")

    monkeypatch.setattr(refine, "parse_pdf", parsed)
    with pymupdf.open() as document:
        for _ in range(3):
            document.new_page()
        data = prefix + document.tobytes()
    with pytest.raises(parser_app.ParseTooManyPages, match="3 pages"):
        parser_app.run_document(parser_app.Document(data, "long.pdf"))


def test_startup_empties_the_work_dir() -> None:
    work = parser_app.WORK_DIR
    (work / "doc-1").mkdir(parents=True)
    (work / "doc-1" / "document.pdf").write_bytes(b"%PDF")
    for name in ("transfer-1.result", ".ses", "mat-debug-10.log"):
        (work / name).write_bytes(b"")

    parser_app._clear_work_dir()

    assert list(work.iterdir()) == []


def test_receipt_keeps_the_metering_keys_and_counts_vlm_pages() -> None:
    """Billing reads _page_count and _ocr_page_count; the other keys keep their
    names for usage_events and Ops even though documents are no longer sliced."""
    values = parser_app._measurements(_result(pages=40, vlm=[3, 7]), 1.5, 120)

    assert values["_page_count"] == 40
    assert values["_ocr_page_count"] == 2
    assert values["_slice_count"] == 1
    assert values["_queue_ms"] == 120
    assert values["_server_parse_ms"] == 1500
    assert values["_execution_ms"] == 750
    assert values["_parse_lane"] == "vlm"
    assert values["_source_format"] == "pdf"
    for key in (
        "_worker_cpu_ms",
        "_worker_rss_bytes",
        "_worker_pss_bytes",
        "_worker_io_read_bytes",
        "_worker_io_write_bytes",
        "_parse_method",
    ):
        assert key in values


@pytest.mark.asyncio
async def test_health_keeps_slice_keys_as_zeros(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, _ = _runtime(monkeypatch, None)
    await runtime.start()
    try:
        health = runtime.health()
    finally:
        await runtime.close()
    for key in ("active_slices", "queued_slices"):
        assert health[key] == 0
    for key in ("oldest_active_slice_s", "oldest_queued_slice_s"):
        assert health[key] == 0.0
    assert health["last_slice_completed_age_s"] is None
    assert health["cgroup_oom_kill_events"] == 0


@pytest.mark.asyncio
async def test_same_artifact_fingerprint_shares_inflight_parse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = 0
    release = asyncio.Event()

    async def _produce(_body, _source, _source_read_ms):
        nonlocal started
        started += 1
        await release.wait()
        return {"artifact": {"key": "artifacts/result.zip"}}, 200

    monkeypatch.setattr(parser_app, "_produce_artifact", _produce)
    parser_app._artifact_tasks.clear()
    body = {"source_fingerprint": "same"}

    first, retry = await asyncio.gather(
        parser_app._artifact_task("same", body, b"source", 1),
        parser_app._artifact_task("same", body, b"source", 1),
    )

    assert first is retry
    assert started == 1
    release.set()
    assert await first == ({"artifact": {"key": "artifacts/result.zip"}}, 200)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert "same" not in parser_app._artifact_tasks


@pytest.mark.asyncio
async def test_concurrent_artifact_waiter_does_not_receive_creator_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "_quarantine", lambda _fingerprint: None)
    monkeypatch.setattr(parser_app, "_artifact_descriptor", lambda *_args: None)
    monkeypatch.setattr(parser_app, "_read_source", lambda *_args: b"source")

    async def _result_task():
        return (
            {
                "artifact": {"key": "artifacts/fp.zip"},
                "_receipt_request_id": "creator-job",
                "_receipt_id": "fp",
                "_page_count": 3,
            },
            200,
        )

    async def _task(*_args):
        return asyncio.create_task(_result_task())

    monkeypatch.setattr(parser_app, "_artifact_task", _task)
    response = await parser_app._artifact_parse(
        {
            "source_key": "sources/source-1",
            "source_sha256": "a" * 64,
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "waiting-job",
            "artifact_schema": parser_app.ARTIFACT_SCHEMA,
            "parser_version": parser_app.PARSER_VERSION,
        }
    )

    assert json.loads(response.body) == {"artifact": {"key": "artifacts/fp.zip"}}


@pytest.mark.asyncio
async def test_artifact_request_rejects_a_foreign_parser_version() -> None:
    response = await parser_app._artifact_parse(
        {
            "source_key": "sources/source-1",
            "source_sha256": "a" * 64,
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "job",
            "artifact_schema": parser_app.ARTIFACT_SCHEMA,
            "parser_version": "some-other-parser-v1+" + "0" * 40,
        }
    )
    assert response.status_code == 400


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (parser_app.ParseHardTimeout("too slow"), "parse_hard_timeout"),
        # Refused before LibreOffice; nothing to retry.
        (parser_app.OfficeFormatMismatch("not a .docx"), "parse_format_mismatch"),
        (parser_app.TooManyElements("more than 2,000 rows"), "parse_too_many_elements"),
        # Broken, zero-page or open-password PDFs and LibreOffice refusals.
        (parser_app.SourceUnreadable("not a PDF"), "parse_unreadable"),
        (parser_app.OfficeConversionFailed("no PDF"), "parse_unreadable"),
    ],
)
@pytest.mark.asyncio
async def test_terminal_failures_answer_422_with_their_code(
    monkeypatch: pytest.MonkeyPatch, error: Exception, code: str
) -> None:
    async def failed(_document):
        raise error

    monkeypatch.setattr(parser_app, "_run", failed)
    payload, status = await parser_app._produce_artifact(
        {
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "job-1",
        },
        b"source",
        1,
    )

    assert (status, payload["code"]) == (422, code)
    # The multipart and capture routes answer the same.
    response = parser_app._failure_response(error)
    assert (response.status_code, json.loads(response.body)["code"]) == (422, code)


@pytest.mark.asyncio
async def test_restart_backstop_does_not_depend_on_response_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exits = 0
    terminated = asyncio.Event()

    def terminate() -> None:
        nonlocal exits
        exits += 1
        terminated.set()

    monkeypatch.setattr(parser_app, "RESTART_BACKSTOP_S", 0)
    monkeypatch.setattr(parser_app, "_terminate_process", terminate)

    parser_app._schedule_restart_backstop()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)

    assert exits == 1


def test_shared_source_is_verified_before_parse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    source = tmp_path / "sources" / "source-1"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"document")

    assert (
        parser_app._read_source(
            "sources/source-1", hashlib.sha256(b"document").hexdigest()
        )
        == b"document"
    )
    with pytest.raises(ValueError, match="checksum mismatch"):
        parser_app._read_source("sources/source-1", "0" * 64)


def test_artifact_write_is_local_atomic_and_path_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)

    parser_app._write_artifact("artifacts/fingerprint.zip", b"zip")

    assert (tmp_path / "artifacts" / "fingerprint.zip").read_bytes() == b"zip"
    assert not list((tmp_path / "artifacts").glob("*.tmp"))
    with pytest.raises(ValueError, match="shared spool key"):
        parser_app._write_artifact("artifacts/../../outside", b"bad")


def test_a_cached_bundle_is_served_only_as_this_process_wrote_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The spool is served from the API's own record: the bundle it published,
    unchanged, with its creator's receipt. A changed file, or any file after a
    restart, is deleted so the document is parsed again."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_published", {})
    key, path = "artifacts/fp.zip", tmp_path / "artifacts" / "fp.zip"
    bundle = parser_app._bundle_bytes(
        {"content_list": []}, "fp", "aa" * 32, "job-1", {"_page_count": 3}
    )
    parser_app._record_bundle(
        "fp", hashlib.sha256(bundle).hexdigest(), "job-1", {"_page_count": 3}
    )
    parser_app._write_artifact(key, bundle)

    cached = parser_app._artifact_descriptor(key, "fp")
    assert cached["sha256"] == hashlib.sha256(bundle).hexdigest()
    assert parser_app._artifact_receipt("fp", "job-1") == {
        "_receipt_id": "fp",
        "_page_count": 3,
    }
    assert parser_app._artifact_receipt("fp", "another-job") == {}

    parser_app._write_artifact(key, bundle + b"changed")
    assert parser_app._artifact_descriptor(key, "fp") is None
    assert not path.exists()
    assert parser_app._artifact_receipt("fp", "job-1") == {}

    # A restart forgets what was published.
    parser_app._record_bundle("fp", hashlib.sha256(bundle).hexdigest(), "job-1", {})
    parser_app._write_artifact(key, bundle)
    monkeypatch.setattr(parser_app, "_published", {})
    assert parser_app._artifact_descriptor(key, "fp") is None
    assert not path.exists()


def _publish(fingerprint: str, bundle: bytes) -> None:
    """What a producer does: the record first, then the file."""
    digest = hashlib.sha256(bundle).hexdigest()
    parser_app._record_bundle(fingerprint, digest, "job-1", {})
    parser_app._write_artifact(f"artifacts/{fingerprint}.zip", bundle)


@pytest.mark.parametrize("moment", ["before the open", "after the open"])
def test_a_bundle_published_during_a_cache_check_is_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, moment: str
) -> None:
    """A cache check running while the same bundle is published neither
    deletes the bundle nor forgets its record: the record is read after the
    hash, and only the file that was hashed is ever removed."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_published", {})
    key, path = "artifacts/fp.zip", tmp_path / "artifacts" / "fp.zip"
    bundle = parser_app._bundle_bytes(
        {"content_list": []}, "fp", "aa" * 32, "job-1", {}
    )
    if moment == "after the open":
        parser_app._write_artifact(key, b"left by an earlier parser")
    opener = parser_app._open_spool_file

    def publishing(file_path):
        if moment == "before the open":
            _publish("fp", bundle)
            return opener(file_path)
        opened = opener(file_path)
        _publish("fp", bundle)
        return opened

    monkeypatch.setattr(parser_app, "_open_spool_file", publishing)
    during = parser_app._artifact_descriptor(key, "fp")
    monkeypatch.setattr(parser_app, "_open_spool_file", opener)

    assert path.read_bytes() == bundle
    after = parser_app._artifact_descriptor(key, "fp")
    assert after["sha256"] == hashlib.sha256(bundle).hexdigest()
    # Before the open the check hashed the new bundle; after it, the old file.
    assert (during is not None) == (moment == "before the open")


def test_recording_a_bundle_keeps_the_records_of_bundles_still_being_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(
        parser_app,
        "_published",
        {"writing": ("d1", "job-1", {}), "gone": ("d2", "job-2", {})},
    )
    monkeypatch.setattr(parser_app, "_artifact_tasks", {"writing": object()})

    parser_app._record_bundle("next", "d3", "job-3", {})

    assert set(parser_app._published) == {"writing", "next"}


def _finishes(call, *args):
    """Run ``call`` in a thread and return what it returned, failing the test
    if it is still blocked after a few seconds."""
    outcome: list = []
    thread = threading.Thread(target=lambda: outcome.append(call(*args)), daemon=True)
    thread.start()
    thread.join(5)
    assert not thread.is_alive(), "blocked on a spool file"
    return outcome[0]


@pytest.mark.skipif(sys.platform != "linux", reason="FIFOs and links: Linux")
@pytest.mark.parametrize("kind", ["fifo", "link"])
def test_a_fifo_or_link_in_the_spool_is_refused_promptly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    """A bundle or quarantine marker that is not a regular file is never read:
    a FIFO does not block, a link is not followed, and the bundle's link is
    removed itself."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    for directory in ("artifacts", "quarantine", "sources"):
        (tmp_path / directory).mkdir()
    bundle = tmp_path / "artifacts" / "fp.zip"
    marker = tmp_path / "quarantine" / "fp.json"
    kept = tmp_path / "sources" / "kept"
    kept.write_bytes(b"kept")
    valid = tmp_path / "sources" / "marker.json"
    valid.write_text(
        json.dumps(
            {
                "reason": "parse_oom",
                "source_fingerprint": "fp",
                "parser_version": parser_app.PARSER_VERSION,
            }
        )
    )
    # Following the link would find a bundle the record matches.
    monkeypatch.setattr(
        parser_app, "_published", {"fp": (hashlib.sha256(b"kept").hexdigest(), "", {})}
    )
    if kind == "fifo":
        os.mkfifo(bundle)
        os.mkfifo(marker)
    else:
        bundle.symlink_to(kept)
        marker.symlink_to(valid)

    assert _finishes(parser_app._artifact_descriptor, "artifacts/fp.zip", "fp") is None
    assert not os.path.lexists(bundle) and kept.exists()
    assert _finishes(parser_app._quarantine, "fp") is None


def _read_result(path: Path) -> object:
    try:
        return parser_app._read_worker_result(path)
    except OSError as exc:
        return exc


@pytest.mark.skipif(sys.platform != "linux", reason="FIFOs and links: Linux")
@pytest.mark.parametrize("kind", ["fifo", "link"])
def test_a_result_file_the_child_swapped_is_refused_promptly(
    tmp_path: Path, kind: str
) -> None:
    """(security regression: S1 transfer files) A parse child may write its
    slot folder, so the API reads a result there only as a regular file: a
    FIFO does not block the slot, a link is not followed."""
    elsewhere = tmp_path / "another-slot.result"
    parser_app._write_worker_result(elsewhere, {"content_list": []})
    result = tmp_path / "transfer.result"
    if kind == "fifo":
        os.mkfifo(result)
    else:
        result.symlink_to(elsewhere)

    assert isinstance(_finishes(_read_result, result), OSError)


@pytest.mark.skipif(sys.platform != "linux", reason="links: Linux")
@pytest.mark.asyncio
async def test_the_api_writes_a_source_only_through_the_file_it_made(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """(security regression: S1 transfer files) A link the parse child puts
    in place of the next source file is never written through: the API writes
    the document only through the descriptor it created."""
    victim = tmp_path / "victim"
    victim.write_bytes(b"kept")
    mkstemp = parser_app.tempfile.mkstemp

    def swapped(*args, **kwargs):
        descriptor, name = mkstemp(*args, **kwargs)
        os.unlink(name)
        os.symlink(victim, name)
        return descriptor, name

    async def send(_message) -> None:
        pass

    async def recv() -> list:
        return ["ok", None]

    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path / "work")
    monkeypatch.setattr(parser_app.tempfile, "mkstemp", swapped)
    monkeypatch.setattr(
        parser_app._ParseWorkerProcess, "alive", property(lambda _self: True)
    )
    child = parser_app._ParseWorkerProcess(0)
    monkeypatch.setattr(child, "send", send)
    monkeypatch.setattr(child, "recv", recv)

    await child.run(
        parser_app.Document(b"%PDF-1.7 the next user's upload", "a.pdf"),
        tmp_path / "transfer.result",
    )

    assert victim.read_bytes() == b"kept"


@pytest.mark.asyncio
async def test_a_full_queue_answers_429_before_the_source_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    def unread(*_args):
        raise AssertionError("the source was read")

    monkeypatch.setattr(parser_app, "_artifact_descriptor", lambda *_args: None)
    monkeypatch.setattr(parser_app, "_quarantine", lambda _fingerprint: None)
    monkeypatch.setattr(parser_app, "_read_source", unread)
    monkeypatch.setattr(
        parser_app,
        "runtime",
        SimpleNamespace(active_jobs=parser_app.QUEUE_DEPTH),
    )

    response = await parser_app._artifact_parse(
        {
            "source_key": "sources/source-1",
            "source_sha256": "a" * 64,
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "job",
            "artifact_schema": parser_app.ARTIFACT_SCHEMA,
            "parser_version": parser_app.PARSER_VERSION,
        }
    )

    assert response.status_code == 429
    assert json.loads(response.body) == {
        "code": "parser_capacity",
        "detail": "parser document queue is full",
    }


def test_bundle_rejects_content_beyond_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "MAX_CONTENT_BYTES", 64)

    with pytest.raises(ValueError, match="content list exceeds"):
        parser_app._bundle_bytes(
            {"content_list": [{"type": "text", "text": "x" * 128}]},
            "fp",
            "aa" * 32,
            "job-1",
            {},
        )


def test_bundle_carries_only_what_ingest_reads() -> None:
    """The capy-parser-bundle-v6 entries the worker validates and extracts;
    ``parsed.pdf`` rides along only when font repair changed the bytes."""
    bundle = parser_app._bundle_bytes(
        {
            "content_list": [
                {"type": "image"},
                {"type": "text", "text": "body", "page_idx": 0},
            ],
            "_page_evidence": {"page_texts": ["body"], "visible_headings": []},
            "_parsed_pdf": b"%PDF-1.7 repaired",
            "_furniture": ["Running header", "p."],
        },
        "fp",
        "aa" * 32,
        "job-1",
        {"_page_count": 3, "_server_parse_ms": 100},
    )

    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        names = sorted(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        content = json.loads(archive.read("content_list.json"))
        assert archive.read("parsed.pdf") == b"%PDF-1.7 repaired"
        assert json.loads(archive.read("refinement.json")) == {
            "furniture": ["Running header", "p."],
            "page_evidence": {"page_texts": ["body"], "visible_headings": []},
        }
    assert names == [
        "content_list.json",
        "manifest.json",
        "parsed.pdf",
        "refinement.json",
    ]
    assert manifest["schema"] == "capy-parser-bundle-v6"
    assert manifest["parser_version"] == parser_app.PARSER_VERSION
    assert manifest["source_fingerprint"] == "fp"
    assert manifest["source_sha256"] == "aa" * 32
    assert manifest["parse_receipt"] == {
        "id": "fp",
        "request_id": "job-1",
        "measurements": {"_page_count": 3, "_server_parse_ms": 100},
    }
    assert content[0] == {"type": "image"}


def test_bundle_without_font_repair_carries_no_parsed_pdf() -> None:
    bundle = parser_app._bundle_bytes(
        {"content_list": [], "_furniture": []},
        "fp",
        "aa" * 32,
        "job-1",
        {},
    )
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        assert sorted(archive.namelist()) == [
            "content_list.json",
            "manifest.json",
            "refinement.json",
        ]


def test_office_evidence_preserves_chunks_after_pdf_is_removed(tmp_path):
    """Source proof is frozen once, then reused by uncached and cached ingestion."""
    from dataclasses import asdict

    import pymupdf
    from odl.evidence import page_evidence

    from pipeline.ingest.worker import _page_chunks

    pdf = tmp_path / "converted.pdf"
    blocks = []
    with pymupdf.open() as doc:
        for text, invisible in (
            ("Wetland conservation", False),
            ("Invisible heading", True),
        ):
            page = doc.new_page(width=400, height=600)
            page.insert_text(
                (50, 100), text, fontsize=18, render_mode=3 if invisible else 0
            )
            box = page.search_for(text)[0]
            blocks.append(
                {
                    "type": "text",
                    "text": text,
                    "text_level": 1,
                    "page_idx": len(doc) - 1,
                    "bbox": [
                        box.x0 / 400 * 1000,
                        box.y0 / 600 * 1000,
                        box.x1 / 400 * 1000,
                        box.y1 / 600 * 1000,
                    ],
                }
            )
        doc.save(pdf)
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    refinement = bundle / "refinement.json"
    refinement.write_text(json.dumps({"furniture": []}))
    before = _page_chunks(blocks, bundle, pdf)
    evidence = page_evidence(pdf.read_bytes(), blocks)
    assert evidence["visible_headings"] == [0]
    refinement.write_text(json.dumps({"furniture": [], "page_evidence": evidence}))
    pdf.unlink()
    after = _page_chunks(blocks, bundle, pdf)
    assert [asdict(c) for c in after] == [asdict(c) for c in before]


def test_office_run_keeps_only_evidence_in_bundle(monkeypatch, tmp_path):
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    from types import SimpleNamespace

    import pymupdf
    from odl import document, refine

    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((50, 100), "Source text")
        data = pdf.tobytes()
    monkeypatch.setattr(
        document,
        "normalize_document",
        lambda *_args: SimpleNamespace(
            data=data, preview_pdf=data, source_format="docx"
        ),
    )
    monkeypatch.setattr(
        refine,
        "parse_pdf",
        lambda *_args, **_kwargs: SimpleNamespace(
            content_list=[{"type": "text", "text": "Source text", "page_idx": 0}],
            markdown="Source text",
            textless_pages=[],
            page_count=1,
            phases={},
            stages={},
            repaired_fonts=[],
            furniture=[],
            drawing_steps=0,
            drawings_stopped_at=None,
            parsed_pdf=data,
        ),
    )
    result = parser_app.run_document(parser_app.Document(b"office", "example.docx"))
    assert result["_page_evidence"]["page_texts"][0].strip() == "Source text"
    assert "thumbnail" in result["_phases"]
    bundle = parser_app._bundle_bytes(result, "fingerprint", "aa" * 32, "request", {})
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        assert not any(name.lower().endswith(".pdf") for name in archive.namelist())
        assert json.loads(archive.read("manifest.json"))["source_format"] == "docx"
        page = archive.read("page1.png")
    # Page 1 of the conversion in hand, so ingest never converts it again.
    from PIL import Image

    with Image.open(io.BytesIO(page)) as image:
        # An A4 page 200 px wide; PyMuPDF rounds 283.03 up.
        assert (image.format, image.size) == ("PNG", (200, 284))


def test_a_pdf_parse_bundles_page_one_from_its_repaired_bytes(monkeypatch, tmp_path):
    """PDFs get their thumbnail from the parse as Office files do, so the
    ingest worker never renders a document itself."""
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    from types import SimpleNamespace

    import pymupdf
    from odl import document, refine
    from PIL import Image

    def pdf(width: float, height: float) -> bytes:
        with pymupdf.open() as doc:
            doc.new_page(width=width, height=height).insert_text((40, 60), "Page")
            return doc.tobytes()

    monkeypatch.setattr(
        document,
        "normalize_document",
        lambda *_args: SimpleNamespace(
            data=pdf(595, 842), preview_pdf=None, source_format="pdf"
        ),
    )
    monkeypatch.setattr(
        refine,
        "parse_pdf",
        lambda *_args, **_kwargs: SimpleNamespace(
            content_list=[{"type": "text", "text": "Page", "page_idx": 0}],
            markdown="Page",
            textless_pages=[],
            page_count=1,
            phases={},
            stages={},
            repaired_fonts=["F1"],
            furniture=[],
            drawing_steps=0,
            drawings_stopped_at=None,
            parsed_pdf=pdf(800, 400),
        ),
    )
    result = parser_app.run_document(parser_app.Document(b"%PDF", "lecture.pdf"))
    bundle = parser_app._bundle_bytes(result, "fingerprint", "aa" * 32, "request", {})
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        page = archive.read("page1.png")
    with Image.open(io.BytesIO(page)) as image:
        # The repaired 800 x 400 page, not the 595 x 842 source.
        assert (image.format, image.size) == ("PNG", (200, 100))


def test_a_failed_page_render_leaves_the_parse_and_bundle_intact(monkeypatch, tmp_path):
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    from types import SimpleNamespace

    import pymupdf
    from odl import capture, document, refine

    with pymupdf.open() as pdf:
        pdf.new_page().insert_text((50, 100), "Source text")
        data = pdf.tobytes()
    monkeypatch.setattr(
        document,
        "normalize_document",
        lambda *_args: SimpleNamespace(
            data=data, preview_pdf=data, source_format="pptx"
        ),
    )
    monkeypatch.setattr(
        refine,
        "parse_pdf",
        lambda *_args, **_kwargs: SimpleNamespace(
            content_list=[{"type": "text", "text": "Source text", "page_idx": 0}],
            markdown="Source text",
            textless_pages=[],
            page_count=1,
            phases={},
            stages={},
            repaired_fonts=[],
            furniture=[],
            drawing_steps=0,
            drawings_stopped_at=None,
            parsed_pdf=None,
        ),
    )

    def broken(_pdf):
        raise RuntimeError("render failed")

    monkeypatch.setattr(capture, "page_thumbnail", broken)
    result = parser_app.run_document(parser_app.Document(b"office", "deck.pptx"))
    assert "_page_image" not in result
    bundle = parser_app._bundle_bytes(result, "fingerprint", "aa" * 32, "request", {})
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        assert "page1.png" not in archive.namelist()


@pytest.mark.asyncio
async def test_capture_uses_the_bounded_runtime_without_a_parse_receipt(monkeypatch):
    from types import SimpleNamespace

    import httpx

    calls = []

    async def parse(document):
        calls.append(document)
        return {"jpeg": "image", "box": [0, 0, 1000, 1000], "size": [100, 100]}, 0

    monkeypatch.setattr(
        parser_app, "runtime", SimpleNamespace(active_jobs=0, parse=parse)
    )
    monkeypatch.setattr(parser_app, "_authorized", lambda _: True)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=parser_app.app), base_url="http://parser.test"
    ) as client:
        response = await client.post(
            "/capture_page",
            files={"file": ("source.docx", b"office")},
            data={
                "filename": "source.docx",
                "page": "2",
                "max_edge": "200",
                "bbox": "[0,0,500,500]",
            },
        )
        assert response.status_code == 200
        assert "parse_receipt" not in response.json()
        assert calls[0].capture == {
            "page": 2,
            "bbox": [0, 0, 500, 500],
            "max_edge": 200,
        }
        bad = await client.post(
            "/capture_page",
            files={"file": ("source.docx", b"office")},
            data={
                "filename": "source.docx",
                "page": "2",
                "max_edge": "200",
                "bbox": "[NaN,0,500,500]",
            },
        )
        assert bad.status_code == 400 and len(calls) == 1
