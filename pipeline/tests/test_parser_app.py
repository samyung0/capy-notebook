"""Offline tests for the parser service runtime: parse slots over one bounded
FIFO, per-slot deadline/OOM isolation and quarantine, the shared OCR queue, the
receipt keys the worker bills from, and the bundle contract."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import io
import json
import os
import pickle
import sys
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


def _result(pages: int = 1, ocr: list[int] | None = None) -> dict:
    return {
        "content_list": [{"type": "text", "text": "a", "page_idx": 0}],
        "_ocr_pages": ocr or [],
        "_page_count": pages,
        "_source_format": "pdf",
        "_parse_lane": "ocr" if ocr else "digital",
        "_phases": {"java": 0.5, "repairs": 0.25},
    }


class FakeChild:
    """A parse or OCR child: ``handler`` does the work, and ``terminate()``
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

    async def run(self, document, result_path, _ocr_path):
        """A parse child: the handler's result goes to the result file, and its
        ``_ocr_pages`` are what the stage hands to OCR."""
        result = await self._until_killed(self.handler(document))
        result_path.write_bytes(pickle.dumps(result))
        return result.get("_ocr_pages") or []

    async def page(self, pdf, page_idx):
        return await self._until_killed(self.handler(self, pdf, page_idx))

    def terminate(self) -> None:
        self.terminations += 1
        if self.exitcode is None:
            self.exitcode = -9
            self._killed.set()

    def stop(self) -> None:
        pass


async def _no_ocr(_child, _pdf, _page_idx):
    raise AssertionError("no OCR expected")


def _scan(name: str, pages: int) -> dict:
    """A parse result with ``pages`` text-less pages left for the OCR stage."""
    return {
        **_result(pages),
        "content_list": [
            {"type": "text", "text": f"{name} native {p}", "page_idx": p}
            for p in range(pages)
        ],
        "_ocr_pages": list(range(pages)),
    }


def _runtime(monkeypatch, handler, *, workers=1, depth=4, ocr=_no_ocr):
    monkeypatch.setattr(parser_app, "PARSE_WORKERS", workers)
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", depth)
    children = [FakeChild(handler) for _ in range(workers)]
    reader = FakeChild(ocr)
    runtime = parser_app.ParserRuntime(lambda index: children[index], lambda: reader)
    return runtime, children, reader


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
            with pytest.raises(
                ValueError, match="document parsing supports PDF and Office files"
            ):
                await runtime.parse(parser_app.Document(b"not a document", name))
            assert runtime.ready
            assert runtime._slots[0].process._process is child
    finally:
        await runtime.close()

    assert not list(tmp_path.glob("transfer-*"))


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

    runtime, _, _ = _runtime(monkeypatch, handler, workers=2)
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

    runtime, _, _ = _runtime(monkeypatch, handler, workers=2, depth=4)
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

    runtime, _, _ = _runtime(monkeypatch, handler, depth=2)
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

    runtime, (child,), _ = _runtime(monkeypatch, handler, depth=1)
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

    runtime, children, _ = _runtime(monkeypatch, handler, workers=2)
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

    runtime, (child,), _ = _runtime(monkeypatch, handler)
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
        # SIGKILL without a cgroup OOM kill, or an ordinary crash during one:
        # a runtime failure with the ordinary retry, nothing quarantined.
        ("child", 0, "runtime"),
        ("crash", 1, "runtime"),
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
        raise parser_app._ChildExited("exited", -9 if death == "child" else 1)

    runtime, children, _ = _runtime(monkeypatch, handler, workers=2)
    await runtime.start()
    try:
        other = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "other.pdf", "other-fp"))
        )
        victim = runtime.parse(parser_app.Document(b"", "big.pdf", "big-fp"))
        error = (
            parser_app.ParseOOM
            if expected == "parse_oom"
            else parser_app.ParserRuntimeFailure
        )
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


@pytest.mark.asyncio
async def test_handoff_frees_the_slot_and_merges_ocr_lines_in_page_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A scan's slot takes the next document while its pages wait for OCR;
    the deadline covers only the parse stage."""
    monkeypatch.setattr(parser_app, "PARSE_DOCUMENT_TIMEOUT_S", 0.05)
    read = asyncio.Event()

    async def handler(document):
        return _scan("scan", 3) if document.name == "scan.pdf" else _result()

    async def ocr(_child, _pdf, page_idx):
        await read.wait()
        return [{"type": "text", "text": f"ocr {page_idx}", "page_idx": page_idx}]

    runtime, _, _ = _runtime(monkeypatch, handler, ocr=ocr)
    await runtime.start()
    try:
        scan = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "scan.pdf"), ocr_pages=3)
        )
        await _until(lambda: runtime.health()["ocr_stage_jobs"] == 1)
        # One worker: the native document parses while the scan waits for OCR.
        await runtime.parse(parser_app.Document(b"", "native.pdf"))
        health = runtime.health()
        assert health["executing_jobs"] == 0 and health["ocr_queued_pages"] == 3
        await asyncio.sleep(0.1)  # past the parse deadline: the OCR stage has none
        read.set()
        result, _ = await scan
    finally:
        await runtime.close()

    assert [b["text"] for b in result["content_list"]] == [
        "scan native 0",
        "ocr 0",
        "scan native 1",
        "ocr 1",
        "scan native 2",
        "ocr 2",
    ]
    assert result["_phases"]["ocr"] > 0
    assert not list(parser_app.WORK_DIR.glob("transfer-*"))


@pytest.mark.asyncio
async def test_ocr_reads_one_page_per_waiting_document_per_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    served: list[tuple[str, int]] = []
    active = peak = 0

    async def handler(document):
        if document.name == "small.pdf":
            await asyncio.sleep(0.005)  # arrives while the scan's first page runs
            return _scan("small", 2)
        return _scan("big", 4)

    async def ocr(_child, pdf, page_idx):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        name = "small" if "small" in served_names[pdf] else "big"
        served.append((name, page_idx))
        return []

    served_names: dict[str, str] = {}
    run = FakeChild.run

    async def remember(self, document, result_path, ocr_path):
        served_names[str(ocr_path)] = document.name
        return await run(self, document, result_path, ocr_path)

    monkeypatch.setattr(FakeChild, "run", remember)
    runtime, _, reader = _runtime(monkeypatch, handler, workers=2, ocr=ocr)
    await runtime.start()
    try:
        await asyncio.gather(
            runtime.parse(parser_app.Document(b"", "big.pdf")),
            runtime.parse(parser_app.Document(b"", "small.pdf")),
        )
    finally:
        await runtime.close()

    assert peak == 1 and reader.starts == 1
    assert served == [
        ("big", 0),
        ("small", 0),
        ("big", 1),
        ("small", 1),
        ("big", 2),
        ("big", 3),
    ]


@pytest.mark.parametrize("stuck", [False, True])
@pytest.mark.asyncio
async def test_a_page_past_its_limit_quarantines_only_its_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stuck
) -> None:
    """Queue wait is free: the other document's pages wait out the slow page
    and still pass. The OCR process restarts only if it never answers."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "OCR_PAGE_TIMEOUT_S", 0.2)

    async def handler(document):
        return _scan(document.name, 1 if document.name == "slow.pdf" else 2)

    async def ocr(_child, pdf, _page_idx):
        if pdf == slow_pdf[0]:
            await asyncio.sleep(3600 if stuck else 0.3)
        else:
            await asyncio.sleep(0.01)
        return []

    slow_pdf: list[str] = []
    run = FakeChild.run

    async def remember(self, document, result_path, ocr_path):
        if document.name == "slow.pdf":
            slow_pdf.append(str(ocr_path))
        return await run(self, document, result_path, ocr_path)

    monkeypatch.setattr(FakeChild, "run", remember)
    runtime, _, reader = _runtime(monkeypatch, handler, workers=2, ocr=ocr)
    await runtime.start()
    try:
        slow = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "slow.pdf", "slow-fp"))
        )
        await _until(lambda: runtime.health()["ocr_stage_jobs"] == 1)
        other = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "other.pdf", "other-fp"))
        )
        with pytest.raises(parser_app.ParseHardTimeout, match="OCR of page 1"):
            await slow
        await other
        assert runtime.state == "ready"
        assert (reader.terminations, reader.starts) == ((1, 2) if stuck else (0, 1))
    finally:
        await runtime.close()
    marker = json.loads((tmp_path / "quarantine" / "slow-fp.json").read_text())
    assert marker["reason"] == "parse_hard_timeout"
    assert not (tmp_path / "quarantine" / "other-fp.json").exists()


@pytest.mark.asyncio
async def test_admission_caps_the_ocr_backlog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "OCR_PAGE_CAP", 5)
    release = asyncio.Event()

    async def handler(document):
        await release.wait()
        # An Office source counts no pages on arrival: its parse finds 6.
        return _scan("office", 6) if document.name == "deck.pptx" else _result()

    runtime, _, _ = _runtime(monkeypatch, handler, workers=2, depth=8)
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParseTooManyScannedPages, match="at most 5"):
            await runtime.parse(parser_app.Document(b"", "huge.pdf"), ocr_pages=6)
        held = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "four.pdf"), ocr_pages=4)
        )
        await _until(lambda: runtime.active_jobs == 1)
        with pytest.raises(parser_app.ParserCapacity, match="OCR backlog"):
            await runtime.parse(parser_app.Document(b"", "two.pdf"), ocr_pages=2)
        fits = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "one.pdf"), ocr_pages=1)
        )
        deck = asyncio.create_task(runtime.parse(parser_app.Document(b"", "deck.pptx")))
        await _until(lambda: runtime.active_jobs == 3)
        release.set()
        await asyncio.gather(held, fits)
        with pytest.raises(parser_app.ParseTooManyScannedPages, match="6 pages"):
            await deck
    finally:
        await runtime.close()
    assert runtime.active_jobs == 0


@pytest.mark.asyncio
async def test_ocr_process_death_fails_only_the_ocr_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(
        parser_app, "_schedule_restart_backstop", lambda: pytest.fail("restart")
    )
    native_release = asyncio.Event()
    calls = 0

    async def ocr(child, _pdf, _page_idx):
        nonlocal calls
        calls += 1
        if calls == 1:
            await asyncio.sleep(0.02)  # the second scan joins the stage
            child.terminate()
            await asyncio.sleep(0)
        return [{"type": "text", "text": "ocr", "page_idx": 0}]

    async def handler(document):
        if document.name == "native.pdf":
            await native_release.wait()
            return _result()
        return _scan(document.name, 1)

    runtime, children, reader = _runtime(monkeypatch, handler, workers=3, ocr=ocr)
    await runtime.start()
    try:
        native = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "native.pdf", "native-fp"))
        )
        first, second = await asyncio.gather(
            runtime.parse(parser_app.Document(b"", "scan-a.pdf", "a-fp")),
            runtime.parse(parser_app.Document(b"", "scan-b.pdf", "b-fp")),
            return_exceptions=True,
        )
        assert isinstance(first, parser_app.ParserRuntimeFailure)
        assert isinstance(second, parser_app.ParserRuntimeFailure)
        # A fresh OCR process serves the next page; parse children are kept.
        later, _ = await runtime.parse(parser_app.Document(b"", "scan-c.pdf", "c-fp"))
        assert [b["text"] for b in later["content_list"]] == [
            "scan-c.pdf native 0",
            "ocr",
        ]
        native_release.set()
        await native
        assert runtime.state == "ready" and reader.starts == 2
        assert all(c.terminations == 0 for c in children)
    finally:
        await runtime.close()
    assert not (tmp_path / "quarantine").exists()


@pytest.mark.asyncio
async def test_repeated_ocr_process_deaths_restart_the_parser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    restarts: list[int] = []
    monkeypatch.setattr(
        parser_app, "_schedule_restart_backstop", lambda: restarts.append(1)
    )

    async def ocr(child, _pdf, _page_idx):
        child.terminate()
        await asyncio.sleep(0)

    async def handler(document):
        return _scan(document.name, 1)

    runtime, _, reader = _runtime(monkeypatch, handler, ocr=ocr)
    await runtime.start()
    try:
        for n in range(parser_app.OCR_DEATH_LIMIT):
            with pytest.raises(parser_app.ParserRuntimeFailure):
                await runtime.parse(parser_app.Document(b"", f"{n}.pdf"))
        await _until(lambda: runtime.state == "failed")
        assert restarts == [1] and reader.starts == parser_app.OCR_DEATH_LIMIT
    finally:
        await runtime.close()


def test_merge_matches_reading_ocr_inside_parse_pdf(
    tmp_path: Path, monkeypatch
) -> None:
    """The OCR stage's result equals ``ocr.add_ocr_text`` in the parse child,
    Office evidence included."""
    import pymupdf
    from odl import layout, ocr
    from odl.evidence import page_evidence

    pdf = tmp_path / "document.pdf"
    with pymupdf.open() as document:
        document.new_page().insert_text((50, 50), "native heading text " * 4)
        document.new_page().draw_rect(pymupdf.Rect(20, 20, 200, 90), fill=(0, 0, 0))
        document.new_page()
        document.save(pdf)

    def lines(image):
        ink = image.convert("L").tobytes().count(0)
        box = [[10, 10], [60, 10], [60, 30], [10, 30]]
        return [{"box": box, "text": f"ink {ink}", "score": 0.9}]

    monkeypatch.setattr(ocr, "ocr_lines", lines)
    monkeypatch.setattr(layout, "regions", lambda image, path: [])
    native = [{"type": "text", "text": "native", "page_idx": 0, "bbox": [0, 0, 1, 1]}]
    with pymupdf.open(pdf) as document:
        expected, pages = ocr.add_ocr_text(native, document)
    result_path = tmp_path / "result.pickle"
    result_path.write_bytes(
        pickle.dumps(
            {"content_list": native, "_ocr_pages": pages, "_evidence_pending": True}
        )
    )
    read = {page: ocr.read_page(str(pdf), page) for page in reversed(pages)}
    merged = parser_app._merge_ocr(result_path, pdf, read)
    assert merged["content_list"] == expected and pages == [1, 2]
    assert merged["_page_evidence"] == page_evidence(pdf.read_bytes(), expected)


def test_admission_counts_pages_and_uses_the_ocr_test(tmp_path: Path) -> None:
    import pymupdf

    with pymupdf.open() as document:
        document.new_page().insert_text((50, 50), "native text " * 8)
        document.new_page()
        document.new_page().insert_text((50, 50), "short")
        data = document.tobytes()
    assert parser_app._admission_pages(data) == (3, 2)
    assert parser_app._admission_pages(b"PK\x03\x04 office zip") == (0, 0)


@pytest.mark.asyncio
async def test_page_cap_refuses_pdfs_at_admission_and_office_after_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import pymupdf
    from odl import document as odl_document

    monkeypatch.setattr(parser_app, "MAX_PAGES", 2)

    async def never_parsed(_document):
        raise AssertionError("refused before a parse child")

    runtime, _, _ = _runtime(monkeypatch, never_parsed)
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
        lambda data, name: odl_document.NormalizedDocument(
            pdf, "deck.pdf", "pptx", preview_pdf=pdf
        ),
    )
    with pytest.raises(parser_app.ParseTooManyPages, match="3 pages"):
        parser_app.run_document(parser_app.Document(b"PK", "deck.pptx"))


def test_receipt_keeps_the_metering_keys_and_counts_ocr_routed_pages() -> None:
    """Billing reads _page_count and _ocr_page_count; the other keys keep their
    names for usage_events and Ops even though documents are no longer sliced."""
    values = parser_app._measurements(_result(pages=40, ocr=[3, 7]), 1.5, 120)

    assert values["_page_count"] == 40
    assert values["_ocr_page_count"] == 2
    assert values["_slice_count"] == 1
    assert values["_queue_ms"] == 120
    assert values["_server_parse_ms"] == 1500
    assert values["_execution_ms"] == 750
    assert values["_parse_lane"] == "ocr"
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
    runtime, _, _ = _runtime(monkeypatch, None)
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


@pytest.mark.asyncio
async def test_hard_timeout_response_carries_its_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def timed_out(_document):
        raise parser_app.ParseHardTimeout("too slow")

    monkeypatch.setattr(parser_app, "_run", timed_out)
    payload, status = await parser_app._produce_artifact(
        {
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "job-1",
        },
        b"source",
        1,
    )

    assert status == 422
    assert payload["code"] == "parse_hard_timeout"


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


def test_bundle_rejects_content_beyond_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "MAX_CONTENT_BYTES", 64)

    with pytest.raises(ValueError, match="content list exceeds"):
        parser_app._bundle_bytes(
            {"content_list": [{"type": "text", "text": "x" * 128}]},
            "fp",
            "job-1",
            {},
        )


def test_bundle_carries_only_what_ingest_reads() -> None:
    """The capy-parser-bundle-v5 entries the worker validates and extracts;
    ``parsed.pdf`` rides along only when font repair changed the bytes. Image
    files and ODL Markdown never enter the bundle."""
    bundle = parser_app._bundle_bytes(
        {
            "content_list": [
                {"type": "image", "img_path": "document_images/imageFile1.png"},
                {"type": "text", "text": "body", "page_idx": 0},
            ],
            "_page_evidence": {"page_texts": ["body"], "visible_headings": []},
            "_parsed_pdf": b"%PDF-1.7 repaired",
            "_furniture": ["Running header", "p."],
        },
        "fp",
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
    assert manifest["schema"] == "capy-parser-bundle-v5"
    assert manifest["parser_version"] == parser_app.PARSER_VERSION
    assert manifest["source_fingerprint"] == "fp"
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
            ocr_pages=[],
            page_count=1,
            phases={},
            repaired_fonts=[],
            furniture=[],
            parsed_pdf=data,
        ),
    )
    result = parser_app.run_document(parser_app.Document(b"office", "example.docx"))
    assert result["_page_evidence"]["page_texts"][0].strip() == "Source text"
    bundle = parser_app._bundle_bytes(result, "fingerprint", "request", {})
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        assert not any(name.lower().endswith(".pdf") for name in archive.namelist())
        assert json.loads(archive.read("manifest.json"))["source_format"] == "docx"


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
