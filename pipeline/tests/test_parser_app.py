"""Offline tests for the parser service runtime: parse slots over one bounded
FIFO, per-slot deadline/OOM isolation and quarantine, the page renders for the
ingest worker's VLM, the receipt keys the worker bills from, and the bundle
contract."""

from __future__ import annotations

import asyncio
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

    async def page_count(self, pdf):
        return await self._until_killed(self.handler(self, pdf))

    def terminate(self) -> None:
        self.terminations += 1
        if self.exitcode is None:
            self.exitcode = -9
            self._killed.set()

    def stop(self) -> None:
        pass


async def _no_count(_child, _pdf):
    raise AssertionError("no admission count expected")


def _runtime(monkeypatch, handler, *, workers=1, depth=4, count=_no_count):
    monkeypatch.setattr(parser_app, "PARSE_WORKERS", workers)
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", depth)
    children = [FakeChild(handler) for _ in range(workers)]
    counter = FakeChild(count)
    runtime = parser_app.ParserRuntime(lambda index: children[index], lambda: counter)
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
    runtime = parser_app.ParserRuntime(admission_process=lambda: FakeChild(_no_count))
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


def test_admission_counts_pages_without_reading_page_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Admission reads the page tree only; the text-less count comes from the
    parse child at the handoff."""
    import pymupdf

    def no_page_content(*_args, **_kwargs):
        raise AssertionError("admission read page content")

    pdf = tmp_path / "source.pdf"
    pdf.write_bytes(_three_page_pdf())
    monkeypatch.setattr(pymupdf.Document, "load_page", no_page_content)
    monkeypatch.setattr(pymupdf.Page, "get_text", no_page_content)

    assert parser_app._count_pdf_pages(str(pdf)) == 3


@pytest.mark.asyncio
async def test_admission_counts_pdf_pages_outside_the_api_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The API process opens no source with MuPDF: a spawned admission process
    counts, and an Office source is counted after LibreOffice instead."""
    import pymupdf

    data = _three_page_pdf()

    def not_in_the_api(*_args, **_kwargs):
        raise AssertionError("MuPDF opened a source in the API process")

    monkeypatch.setattr(pymupdf, "open", not_in_the_api)
    monkeypatch.setattr(pymupdf, "Document", not_in_the_api)
    runtime, _ = _runtime(monkeypatch, None)
    runtime._admission = parser_app._AdmissionProcess()
    await runtime.start()
    try:
        assert await runtime.page_count(data) == 3
        assert await runtime.page_count(b"PK\x03\x04 office zip") == 0
    finally:
        await runtime.close()
    assert not list(parser_app.WORK_DIR.glob("transfer-*"))


@pytest.mark.asyncio
async def test_a_stuck_admission_count_admits_uncounted_and_replaces_the_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "ADMISSION_TIMEOUT_S", 0.05)
    calls = 0

    async def count(_child, _pdf):
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.Event().wait()
        return 3

    runtime, _ = _runtime(monkeypatch, None, count=count)
    counter = runtime._admission
    await runtime.start()
    try:
        assert await runtime.page_count(b"%PDF-1.7 stuck") == 0
        assert (counter.terminations, counter.starts) == (1, 1)
        # The next count starts a fresh process; nothing is left in the pipe.
        assert await runtime.page_count(b"%PDF-1.7 next") == 3
        assert counter.starts == 2
    finally:
        await runtime.close()
    assert not list(parser_app.WORK_DIR.glob("transfer-*"))


_UNPICKLED: list[str] = []


def _record_unpickled(label: str) -> None:
    _UNPICKLED.append(label)


class _CallsOnLoad:
    def __reduce__(self):
        return (_record_unpickled, ("loaded",))


@pytest.mark.asyncio
async def test_child_answers_are_read_as_data_never_unpickled(tmp_path: Path) -> None:
    """A parse or admission child's answer and a parse result file are
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
            parser_app.ParseTooManyScannedPages("501 pages have no text layer"),
            parser_app.ParseTooManyScannedPages,
        ),
        (parser_app.SourceUnreadable("no pages"), parser_app.SourceUnreadable),
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


@pytest.mark.asyncio
async def test_a_count_that_fails_admits_uncounted_and_keeps_the_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def count(_child, _pdf):
        raise RuntimeError("FzErrorFormat: no objects found")

    runtime, _ = _runtime(monkeypatch, None, count=count)
    counter = runtime._admission
    await runtime.start()
    try:
        assert await runtime.page_count(b"%PDF-1.7 broken") == 0
        assert (counter.terminations, counter.starts) == (0, 1)
    finally:
        await runtime.close()
    assert not list(parser_app.WORK_DIR.glob("transfer-*"))


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
        libc.prctl(parser_app.PR_SET_DUMPABLE, 1, 0, 0, 0)


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


@pytest.mark.asyncio
async def test_page_cap_refuses_pdfs_at_admission_and_office_after_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pymupdf
    from odl import document as odl_document

    monkeypatch.setattr(parser_app, "MAX_PAGES", 2)

    async def never_parsed(_document):
        raise AssertionError("refused before a parse child")

    runtime, _ = _runtime(monkeypatch, never_parsed)
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParseTooManyPages, match="at most 2 pages"):
            await runtime.parse(parser_app.Document(b"", "long.pdf"), pages=3)
        assert runtime.active_jobs == 0
    finally:
        await runtime.close()

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
    "prefix", [b"\x00", b"\xef\xbb\xbf", b"garbage line\n"], ids=["nul", "bom", "text"]
)
def test_the_parse_child_checks_the_page_cap_of_every_document(
    monkeypatch: pytest.MonkeyPatch, prefix: bytes
) -> None:
    """A PDF that admission does not count (its bytes do not start like a
    PDF) is still refused over the cap, before the parse."""
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
    assert not data.lstrip().startswith(b"%PDF")
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
