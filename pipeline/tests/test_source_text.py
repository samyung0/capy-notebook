from __future__ import annotations

import json
import logging
import os
import shutil
import struct
import subprocess
import threading
import time
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from PIL import Image

from pipeline import config, elitellm, jobs
from pipeline.ingest import source_text
from pipeline.jobs import TerminalError
from pipeline.parse import caption_cache
from pipeline.retrieval import chunking
from pipeline.retrieval.search import Passage


def test_tabular_text_preserves_headers_values_and_formulas(tmp_path) -> None:
    source = tmp_path / "grades.csv"
    source.write_text(
        'Student," Final \t score ",Formula\nAda,98,"=B2/100"\nLin,87,"=B3/100"\n',
        encoding="utf-8",
    )

    text = source_text.tabular_text(str(source), source.name)

    # Whitespace runs in a header collapse like a cell's.
    assert text.split("\n\n") == [
        "Columns: Student | Final score | Formula",
        "Row 2: Student=Ada | Final score=98 | Formula==B2/100",
        "Row 3: Student=Lin | Final score=87 | Formula==B3/100",
    ]

    # A line break inside a quoted cell must not split its row.
    notes = tmp_path / "notes.csv"
    notes.write_text('a,"two\n\n  lines"\n', encoding="utf-8")
    assert source_text.tabular_text(str(notes), notes.name).split("\n\n")[1:] == [
        "Row 1: Column 1=a | Column 2=two lines"
    ]


def test_tabular_rows_are_packed_whole_with_one_block_per_row(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(chunking.cfg, "chunk_tokens", 80)
    source = tmp_path / "scores.csv"
    # Every row renders to 29 characters (8 tokens): the padding shrinks as the
    # row number grows.
    source.write_text(
        "Score,Note\n"
        + "".join(f"1,{'x' * (8 - len(str(n)))}\n" for n in range(2, 1002)),
        encoding="utf-8",
    )

    text = source_text.tabular_text(str(source), source.name)
    blocks = text.split("\n\n")
    # Tables chunk with no overlap, as the delimited route does.
    chunks = chunking.chunk_markdown(text, overlap_tokens=0)

    assert len(blocks) == 1001
    assert blocks[1] == "Row 2: Score=1 | Note=xxxxxxx"
    # The 6-token column line and 9 rows fill the first chunk, then 10 rows each.
    assert len(chunks) == 101
    assert [b for chunk in chunks for b in chunk.text.split("\n\n")] == blocks


def test_tabular_text_caps_columns_per_row_not_cells(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(source_text, "_TABULAR_MAX_COLUMNS", 4)
    tall = tmp_path / "tall.csv"
    tall.write_text("a,b,c,d\n" + "1,2,3,4\n" * 500, encoding="utf-8")
    assert "Row 501: a=1 | b=2 | c=3 | d=4" in source_text.tabular_text(
        str(tall), tall.name
    )

    # Quoted newlines split this five-column row over lines of two delimiters.
    wide = tmp_path / "wide.csv"
    wide.write_text('a,b,c,d\n1,"x\ny",2,"z\nw",3\n', encoding="utf-8")
    with pytest.raises(TerminalError, match="column limit") as error:
        source_text.tabular_text(str(wide), wide.name)
    assert error.value.code == "tabular_column_limit"


def test_tabular_text_caps_the_estimated_tokens_of_its_projection(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "rows.csv"
    source.write_text("LongHeader\na\nb\nc\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_TOKENS", 12)

    with pytest.raises(TerminalError, match="searchable-text limit") as error:
        source_text.tabular_text(str(source), source.name)
    assert error.value.code == "tabular_text_limit"


def test_tabular_text_refuses_a_line_whose_length_passes_the_cap_unestimated(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "wide.csv"
    source.write_text("Student,Notes\nAda," + "x" * 400 + "\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_TOKENS", 50)
    estimated: list[str] = []
    estimate = source_text.estimate_tokens
    monkeypatch.setattr(
        source_text,
        "estimate_tokens",
        lambda line: estimated.append(line) or estimate(line),
    )

    with pytest.raises(TerminalError, match="searchable-text limit"):
        source_text.tabular_text(str(source), source.name)
    assert estimated
    assert all("x" * 400 not in line for line in estimated)


@pytest.mark.asyncio
async def test_image_source_routes_authoritative_file_and_sha_to_caption_cache(
    monkeypatch, tmp_path
):
    source = tmp_path / "diagram.png"
    Image.new("RGB", (32, 32), "white").save(source)
    seen = {}

    async def caption(**kwargs):
        seen.update(kwargs)
        assert (await kwargs["data_url"]()).startswith("data:image/jpeg;base64,")
        return "A diagram.", "shared-caption", 42, True

    monkeypatch.setattr(caption_cache, "caption", caption)
    result = await source_text.caption_image_source(
        local_path=str(source),
        name=source.name,
        source_sha256="ab" * 32,
        file_id="file-1",
    )
    assert seen["file_id"] == "file-1" and seen["image_sha256"] == "ab" * 32
    assert result == ("A diagram.", "shared-caption", 42, True)


# ------------------------------------------------------------------ audio

_SOURCE_URL = "https://b2.test/sources/lecture.mp3?X-Amz-Signature=secret"
# The real poll, for the claim-cycle tests that answer it from the fake server.
_REAL_POLL = source_text._poll


class _FakeFiletrans:
    """Alibaba's task API on 127.0.0.1: scripted answers for the submit, each
    poll and the transcript download, with every request kept."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str], bytes]] = []
        self.submit = (200, {"output": {"task_id": "task-1"}})
        self.polls: list[tuple[int, dict]] = []
        self.transcript = (200, {"transcripts": []})
        self.url = ""

    def handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                fake.requests.append(
                    (self.command, self.path, dict(self.headers), body)
                )
                if self.path == "/api/v1/services/audio/asr/transcription":
                    status, payload = fake.submit
                elif self.path == "/api/v1/tasks/task-1":
                    status, payload = fake.polls.pop(0)
                else:
                    status, payload = fake.transcript
                data = json.dumps(payload).encode()
                self.send_response(status)
                if 300 <= status < 400:
                    self.send_header("Location", "/elsewhere.json")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _answer

            def log_message(self, *_args) -> None:
                pass

        return Handler


@pytest.fixture
def filetrans(monkeypatch):
    fake = _FakeFiletrans()
    server = ThreadingHTTPServer(("127.0.0.1", 0), fake.handler())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(source_text.cfg, "alibaba_modelstudio_key", "test-key")
    monkeypatch.setattr(
        source_text.cfg, "alibaba_modelstudio_url", f"{fake.url}/compatible-mode/v1"
    )
    yield fake
    server.shutdown()
    server.server_close()


@pytest.mark.asyncio
async def test_a_submit_carries_the_link_the_options_and_the_context(
    filetrans, caplog
) -> None:
    caplog.set_level(logging.INFO)
    context = "Workspace: Bio\nFile: a.mp3"

    assert await source_text._submit(_SOURCE_URL, context) == "task-1"

    ((method, path, headers, body),) = filetrans.requests
    assert (method, path) == ("POST", "/api/v1/services/audio/asr/transcription")
    assert headers["Authorization"] == "Bearer test-key"
    assert headers["X-DashScope-Async"] == "enable"
    assert json.loads(body) == {
        "model": "qwen-audio-3.1-asr-flash-filetrans",
        "input": {
            "file_urls": [_SOURCE_URL],
            "context": [
                {"role": "user", "content": [{"type": "input_text", "text": context}]}
            ],
        },
        "parameters": {
            "channel_id": [0],
            "keep_dialect": True,
            "diarization_enabled": True,
        },
    }
    # The submit is logged at INFO (a poll only at DEBUG, below).
    logged = [record.getMessage() for record in caplog.records]
    assert any("/api/v1/services/audio/asr/transcription" in line for line in logged)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("answer", "retryable"),
    [
        ((429, {"code": "Throttling.RateQuota"}), True),
        ((503, {}), True),
        ((400, {"code": "InvalidParameter"}), False),
    ],
)
async def test_a_refused_submit_is_retryable_or_terminal(
    filetrans, answer, retryable
) -> None:
    filetrans.submit = answer

    with pytest.raises(source_text.FiletransError) as failure:
        await source_text._submit(_SOURCE_URL, "context")

    assert jobs.is_retryable(failure.value) is retryable
    # Statuses and provider codes only: never the signed source link.
    assert "Signature" not in str(failure.value)


@pytest.mark.asyncio
async def test_a_poll_reads_the_task_once_and_a_passing_error_is_no_answer(
    filetrans, caplog
) -> None:
    caplog.set_level(logging.INFO)
    filetrans.polls = [
        (200, {"output": {"task_status": "RUNNING"}}),
        (503, {}),
        (429, {"code": "Throttling"}),
        (401, {"code": "InvalidApiKey"}),
    ]

    assert await source_text._poll("task-1") == {"task_status": "RUNNING"}
    assert await source_text._poll("task-1") is None
    assert await source_text._poll("task-1") is None
    with pytest.raises(source_text.FiletransTerminalError):
        await source_text._poll("task-1")

    assert all(
        request[2]["Authorization"] == "Bearer test-key"
        for request in filetrans.requests
    )
    assert not any("/api/v1/tasks/" in r.getMessage() for r in caplog.records)


def test_the_transcript_link_is_read_over_https_from_alibabas_result_buckets():
    host = "dashscope-result-sgp.oss-ap-southeast-1.aliyuncs.com"
    signed = "/prod/r.json?Expires=1&OSSAccessKeyId=id&Signature=sig"

    assert source_text._transcript_url(f"http://{host}{signed}") == (
        f"https://{host}{signed}"
    )
    assert source_text._transcript_url(f"https://{host}{signed}") == (
        f"https://{host}{signed}"
    )
    for link in [
        f"https://{host}.example.com{signed}",
        f"https://{host}:8443{signed}",
        f"https://user@{host}{signed}",
        f"ftp://{host}{signed}",
        f"https://bucket.oss-ap-southeast-1.aliyuncs.com{signed}",
        "http://127.0.0.1:8080/r.json?Signature=sig",
        "http://[::1/r.json",
    ]:
        with pytest.raises(source_text.FiletransTerminalError) as refused:
            source_text._transcript_url(link)
        assert "Signature" not in str(refused.value)


def test_a_transcript_download_takes_no_key_and_follows_no_redirect(
    filetrans,
) -> None:
    filetrans.transcript = (302, {})

    with pytest.raises(source_text.FiletransRetryableError) as failure:
        source_text._download_transcript(f"{filetrans.url}/result.json")

    assert failure.value.status_code == 302
    ((_, path, headers, _),) = filetrans.requests
    # The result link is Alibaba's own signed URL: no API key goes with it.
    assert path == "/result.json" and "Authorization" not in headers


def test_transcript_sentences_come_in_time_order_with_speakers() -> None:
    first = {
        "begin_time": 0,
        "end_time": 3900,
        "text": " First  one. ",
        "speaker_id": 0,
    }
    second = {"begin_time": 4200, "end_time": 6100, "text": "第二句", "speaker_id": 1}
    blank = {"begin_time": 6100, "end_time": 6300, "text": "  "}

    assert source_text._sentences(
        {"transcripts": [{"channel_id": 0, "sentences": [second, first, blank]}]}
    ) == [
        {"start_ms": 0, "end_ms": 3900, "speaker": 0, "text": "First one."},
        {"start_ms": 4200, "end_ms": 6100, "speaker": 1, "text": "第二句"},
    ]


# ------------------------------------------------------- the claim cycle


_SUCCEEDED = {
    "task_status": "SUCCEEDED",
    "results": [
        {
            "subtask_status": "SUCCEEDED",
            "transcription_url": "https://dashscope-result-sgp.oss-ap-southeast-1"
            ".aliyuncs.com/r.json",
        }
    ],
}
_RUNNING = {"task_status": "RUNNING"}
_HELLO = {
    "transcripts": [
        {"sentences": [{"begin_time": 0, "end_time": 900, "text": "Hello."}]}
    ]
}


def _failed(code: str) -> dict:
    return {"task_status": "FAILED", "code": code}


class _Flow:
    """transcribe_audio_source with its database, bucket, gate and provider
    faked. ``payload`` is the job's stored ``filetrans``; ``events`` what the
    claims did, in order."""

    def __init__(self, monkeypatch, *, duration: float = 60.2) -> None:
        self.events: list[tuple] = []
        self.payload: dict = {}
        self.polls: list[dict | None] = []
        self.transcripts: list = []
        self.calls: dict[str, str] = {}
        self.leases: set[str] = set()
        self.cache: dict[str, bytes] = {}
        self.gate_full = False
        self.in_flight = False
        events = self.events

        @asynccontextmanager
        async def no_lock(_identity):
            yield

        async def open_call(call_id, **kwargs):
            if self.gate_full:
                raise elitellm.ProviderBusy("gate full", retry_after=5.0)
            self.calls[call_id] = "open"
            self.leases.add(call_id)
            events.append(("open", kwargs["capacity"], kwargs["provider_timeout_s"]))

        async def renew_call(call_id, key, seconds):
            events.append(("renew", key, seconds))
            return self.calls.get(call_id, "")

        async def release_lease(call_id):
            self.leases.discard(call_id)
            events.append(("release",))

        async def abandon_call(call_id, exc=None):
            if self.calls.get(call_id) == "open":
                self.calls[call_id] = "abandoned"
            events.append(("abandon",))

        async def settle_units(**kwargs):
            self.calls[kwargs["call_id"]] = "applied"
            events.append(
                ("settle", kwargs["units"], kwargs["unit"], kwargs["credit_micros"])
            )

        def presign(key, expires):
            events.append(("presign", key, expires))
            return f"signed:{key}"

        async def submit(url, _context):
            events.append(("submit", url))
            return f"task-{sum(event[0] == 'submit' for event in events)}"

        async def poll(task_id):
            events.append(("poll", task_id))
            return self.polls.pop(0)

        def download(_url):
            answer = self.transcripts.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        def store(_job_id, attempt, state):
            assert attempt == 1
            self.payload = dict(state)
            return True

        monkeypatch.setattr(source_text.cfg, "alibaba_modelstudio_key", "test-key")
        monkeypatch.setattr(source_text, "_source_lock", no_lock)
        monkeypatch.setattr(source_text.blobstore, "read_bytes", self.cache.get)
        monkeypatch.setattr(
            source_text.blobstore,
            "write_bytes",
            lambda key, data, _type: self.cache.__setitem__(key, bytes(data)),
        )
        monkeypatch.setattr(source_text.blobstore, "presign_get", presign)
        monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _p: duration)
        monkeypatch.setattr(source_text, "_task_in_flight", lambda *_a: self.in_flight)
        monkeypatch.setattr(source_text, "_store_state", store)
        monkeypatch.setattr(source_text, "_submit", submit)
        monkeypatch.setattr(source_text, "_poll", poll)
        monkeypatch.setattr(source_text, "_download_transcript", download)
        monkeypatch.setattr(source_text.accounting, "open_call", open_call)
        monkeypatch.setattr(source_text.accounting, "renew_call", renew_call)
        monkeypatch.setattr(source_text.accounting, "release_lease", release_lease)
        monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)
        monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)

    async def claim(self, transcript_url: str = ""):
        """One job claim with the job's stored state."""
        return await source_text.transcribe_audio_source(
            job_id="job_1",
            attempt=1,
            stored=self.payload or None,
            local_path="lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/lecture.mp3",
            context="Workspace: Bio",
            second_rate_micros=16_667,
            transcript_url=transcript_url,
        )

    def stored_task(self, call: str = "open", **state) -> None:
        """The job holds task-1 under call pc_1 (``call``: its state; empty
        when it ran out unpolled)."""
        self.payload = {
            "taskId": "task-1",
            "callId": "pc_1",
            "submittedAt": time.time(),
            "seconds": 60.2,
            "sha256": "ab" * 32,
            "providerFailures": 0,
            **state,
        }
        if call:
            self.calls["pc_1"] = call
            self.leases.add("pc_1")

    async def run(self):
        """Claims until the job ends; the re-pend delays they asked for."""
        delays = []
        while True:
            try:
                return await self.claim(), delays
            except source_text.FiletransWait as wait:
                delays.append(wait.delay_s)

    def kinds(self) -> list[str]:
        return [event[0] for event in self.events]


@pytest.mark.asyncio
async def test_a_first_claim_submits_stores_the_task_and_re_pends(monkeypatch):
    flow = _Flow(monkeypatch)

    with pytest.raises(source_text.FiletransWait) as wait:
        await flow.claim()

    assert wait.value.delay_s == 2
    # One task under the 12-task gate, held for the hour its polls renew,
    # with a source link for the ten minutes Alibaba has to fetch it.
    assert flow.events == [
        ("open", ("filetrans", 12), 3600),
        ("presign", "sources/lecture.mp3", 600),
        ("submit", "signed:sources/lecture.mp3"),
    ]
    assert flow.payload == {
        "providerFailures": 0,
        "taskId": "task-1",
        "callId": next(iter(flow.calls)),
        "submittedAt": flow.payload["submittedAt"],
        "seconds": 60.2,
        "sha256": "ab" * 32,
        "polls": 0,
    }
    # The task runs: its lease stays.
    assert flow.leases == {flow.payload["callId"]}


@pytest.mark.asyncio
async def test_a_running_task_re_pends_with_growing_delays_then_settles_once(
    monkeypatch,
):
    flow = _Flow(monkeypatch)
    flow.polls = [_RUNNING, None, _RUNNING, _SUCCEEDED]
    flow.transcripts = [_HELLO]

    (sentences, key, size), delays = await flow.run()

    assert [sentence["text"] for sentence in sentences] == ["Hello."]
    assert key == f"derived-text/{'ab' * 32}/qwen-audio-3.1-filetrans.json"
    assert size > 0 and key in flow.cache
    # Submitted once; every poll claim renews the task's call and lease for
    # the hour plus nothing more, and an unanswered poll is a running task.
    assert delays == [2, 3, 4, 7]
    assert flow.kinds().count("submit") == 1
    assert flow.events.count(("renew", "filetrans", 3600)) == 4
    # Charged ceil(60.2) seconds once, then the lease is freed.
    assert flow.events[-2:] == [("settle", 61, "seconds", 61 * 16_667), ("release",)]
    assert flow.leases == set()

    # The cached transcript serves the next claim with no task or charge.
    flow.payload = {}
    assert await flow.claim() == (sentences, key, size)
    assert flow.kinds().count("settle") == 1


@pytest.mark.asyncio
async def test_a_claim_after_a_crash_polls_the_stored_task(monkeypatch):
    """A worker that died mid-claim left the task stored: the job's next
    claim polls it, with no new submit and no provider failure counted."""
    flow = _Flow(monkeypatch)
    with pytest.raises(source_text.FiletransWait):
        await flow.claim()
    # The claim that would have polled died; the reclaimed job polls again.
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [_HELLO]

    sentences, _key, _size = await flow.claim()

    assert sentences and flow.kinds().count("submit") == 1
    assert flow.kinds().count("settle") == 1

    # A crash after the settlement but before the job ended: the call is
    # applied, the next claim reads the result again and settles the same
    # receipt, which the database applies once.
    flow.cache.clear()
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [_HELLO]
    await flow.claim()
    settles = [event for event in flow.events if event[0] == "settle"]
    assert settles == [("settle", 61, "seconds", 61 * 16_667)] * 2
    assert flow.kinds().count("submit") == 1


@pytest.mark.asyncio
async def test_a_failed_task_is_submitted_once_more_then_fails_the_file(
    monkeypatch,
):
    flow = _Flow(monkeypatch)
    flow.polls = [_failed("InternalError.Timeout"), _failed("InternalError.Timeout")]

    with pytest.raises(source_text.FiletransTerminalError) as failure:
        await flow.run()

    assert not jobs.is_retryable(failure.value)
    assert "InternalError.Timeout" in str(failure.value)
    # Two tasks, each abandoned uncharged with its lease freed.
    assert flow.kinds().count("submit") == 2
    assert flow.kinds().count("abandon") == 2
    assert "settle" not in flow.kinds()
    assert flow.leases == set()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ended",
    [
        _failed("InternalError"),
        {"task_status": "CANCELED"},
        {"task_status": "UNKNOWN"},
        {"task_status": "SUCCEEDED", "results": [{"subtask_status": "FAILED"}]},
    ],
)
async def test_a_task_ended_without_a_transcript_is_one_provider_failure(
    monkeypatch, ended
):
    flow = _Flow(monkeypatch)
    flow.payload = {
        "taskId": "task-1",
        "callId": "pc_1",
        "submittedAt": time.time(),
        "seconds": 60.2,
        "providerFailures": 0,
    }
    flow.calls["pc_1"] = "open"
    flow.polls = [ended]

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()

    # Stored with the count and no task: the next claim submits a new one.
    assert flow.payload == {"providerFailures": 1}
    assert flow.kinds() == ["renew", "poll", "abandon", "release"]


@pytest.mark.asyncio
async def test_a_file_the_task_cannot_use_fails_at_once(monkeypatch):
    flow = _Flow(monkeypatch)
    flow.polls = [_failed("InvalidFile.DownloadFailed")]

    with pytest.raises(source_text.FiletransTerminalError):
        await flow.run()

    assert flow.kinds().count("submit") == 1
    assert flow.leases == set()


@pytest.mark.asyncio
async def test_a_lost_task_counts_one_provider_failure(monkeypatch):
    """A task past Alibaba's keeping, or whose call ran out unpolled, is
    lost: one provider failure, and the job submits again."""
    flow = _Flow(monkeypatch)
    old = time.time() - source_text.FILETRANS_RESUME_S - 1
    flow.payload = {
        "taskId": "task-1",
        "callId": "pc_1",
        "submittedAt": old,
        "seconds": 60.2,
        "providerFailures": 0,
    }
    flow.calls["pc_1"] = "open"

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()
    assert flow.payload == {"providerFailures": 1}
    assert "poll" not in flow.kinds()


@pytest.mark.asyncio
async def test_a_task_whose_call_ran_out_unpolled_is_polled_and_settles_once(
    monkeypatch,
):
    """The host was down past the hour: the task's call and lease ran out,
    but Alibaba finished the task. The claim polls it, takes a new call under
    the gate and settles that once, with no second task."""
    flow = _Flow(monkeypatch)
    flow.stored_task(call="", submittedAt=time.time() - 3 * 60 * 60)
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [_HELLO]

    sentences, _key, _size = await flow.claim()

    assert [sentence["text"] for sentence in sentences] == ["Hello."]
    assert flow.kinds() == ["renew", "poll", "open", "settle", "release"]
    (new_call,) = flow.calls
    assert new_call != "pc_1" and flow.calls[new_call] == "applied"
    # Stored before the settlement, so a crash after it renews the new call.
    assert flow.payload["callId"] == new_call
    assert flow.leases == set()


@pytest.mark.asyncio
async def test_a_running_task_whose_call_ran_out_waits_for_a_slot_under_a_new_call(
    monkeypatch,
):
    flow = _Flow(monkeypatch)
    flow.stored_task(call="")
    flow.polls = [_RUNNING, _RUNNING, _SUCCEEDED]
    flow.transcripts = [_HELLO]

    # The gate is full: the job waits for a slot with its state as it was.
    flow.gate_full = True
    with pytest.raises(jobs.CapacityWait) as full:
        await flow.claim()
    assert not isinstance(full.value, source_text.FiletransWait)
    assert flow.payload["callId"] == "pc_1" and not flow.calls

    flow.gate_full = False
    with pytest.raises(source_text.FiletransWait):
        await flow.claim()
    (new_call,) = flow.calls
    assert flow.payload["callId"] == new_call and flow.leases == {new_call}

    await flow.claim()
    assert flow.kinds().count("settle") == 1 and "submit" not in flow.kinds()
    assert flow.calls[new_call] == "applied" and flow.leases == set()


@pytest.mark.asyncio
async def test_a_task_alibaba_does_not_know_is_lost(monkeypatch, filetrans):
    """A 404 on the poll: one provider failure (the job submits again), the
    second fails the file; the call ends and its lease is freed each time."""
    flow = _Flow(monkeypatch)
    monkeypatch.setattr(source_text, "_poll", _REAL_POLL)
    filetrans.polls = [(404, {"code": "NotFound"}), (404, {"code": "NotFound"})]
    flow.stored_task()

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()
    assert flow.payload == {"providerFailures": 1}
    assert flow.calls == {"pc_1": "abandoned"} and flow.leases == set()

    flow.stored_task(providerFailures=1)
    with pytest.raises(source_text.FiletransTerminalError, match="task lost"):
        await flow.claim()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403])
async def test_a_poll_refused_otherwise_ends_the_call_before_failing(
    monkeypatch, filetrans, status
):
    flow = _Flow(monkeypatch)
    monkeypatch.setattr(source_text, "_poll", _REAL_POLL)
    filetrans.polls = [(status, {"code": "InvalidApiKey"})]
    flow.stored_task()

    with pytest.raises(source_text.FiletransTerminalError) as failure:
        await flow.claim()

    assert failure.value.status_code == status
    # The gate slot is free at once, not when the lease runs out.
    assert flow.calls == {"pc_1": "abandoned"} and flow.leases == set()


@pytest.mark.asyncio
async def test_an_unreadable_result_is_read_again_and_a_broken_one_is_a_failure(
    monkeypatch,
):
    flow = _Flow(monkeypatch)
    flow.payload = {
        "taskId": "task-1",
        "callId": "pc_1",
        "submittedAt": time.time(),
        "seconds": 60.2,
        "providerFailures": 0,
        "polls": 3,
    }
    flow.calls["pc_1"] = "open"
    flow.polls = [_SUCCEEDED, _SUCCEEDED]
    flow.transcripts = [
        source_text.FiletransRetryableError(503),
        {"transcripts": [{"sentences": [{"text": "no times"}]}]},
    ]

    with pytest.raises(source_text.FiletransWait) as wait:
        await flow.claim()
    assert wait.value.delay_s == 10 and flow.payload["polls"] == 4
    assert flow.payload["providerFailures"] == 0
    assert flow.payload["downloadFailures"] == 1

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()
    assert flow.payload == {"providerFailures": 1}


@pytest.mark.asyncio
async def test_the_fifth_failed_result_read_is_a_provider_failure(monkeypatch):
    flow = _Flow(monkeypatch)
    flow.stored_task(downloadFailures=4)
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [source_text.FiletransRetryableError(403)]

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()

    assert flow.payload == {"providerFailures": 1}
    assert flow.calls == {"pc_1": "abandoned"} and flow.leases == set()


@pytest.mark.asyncio
async def test_a_cached_transcript_ends_this_jobs_own_open_call(monkeypatch):
    """Another job cached the same bytes while this one's task ran: this
    task's call ends uncharged and its lease is freed. One settled before the
    cache was written stays settled."""
    flow = _Flow(monkeypatch)
    flow.cache[source_text.audio_artifact_key("ab" * 32)] = json.dumps(
        {"sentences": [{"start_ms": 0, "end_ms": 900, "text": "Hello."}]}
    ).encode()
    flow.stored_task()

    sentences, _key, _size = await flow.claim()

    assert [sentence["text"] for sentence in sentences] == ["Hello."]
    assert flow.kinds() == ["abandon", "release"]
    assert flow.calls == {"pc_1": "abandoned"} and flow.leases == set()

    flow.stored_task(call="applied")
    await flow.claim()
    assert flow.calls == {"pc_1": "applied"} and "settle" not in flow.kinds()


@pytest.mark.asyncio
async def test_a_task_the_worker_found_succeeded_is_not_polled_again(monkeypatch):
    flow = _Flow(monkeypatch)
    flow.stored_task()
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [_HELLO]

    state, url = await source_text.poll_task(flow.payload, job_id="job_1", attempt=1)
    flow.payload = state
    await flow.claim(transcript_url=url)

    assert flow.kinds() == ["renew", "poll", "settle", "release"]


@pytest.mark.asyncio
async def test_a_claim_that_loses_its_job_before_storing_the_task_orphans_it(
    monkeypatch,
):
    """The job ended or was reclaimed between the submit and the store: the
    task is never polled, the call this claim opened is abandoned and its
    lease freed at once (nothing else names it), and a reclaimed job's next
    claim submits again and settles that task once."""
    flow = _Flow(monkeypatch)
    kept = source_text._store_state
    monkeypatch.setattr(source_text, "_store_state", lambda *_a: False)

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()
    assert flow.payload == {}
    (orphan,) = flow.calls
    assert flow.calls[orphan] == "abandoned" and flow.leases == set()

    monkeypatch.setattr(source_text, "_store_state", kept)
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [_HELLO]
    await flow.run()

    assert flow.kinds().count("submit") == 2
    assert flow.kinds().count("settle") == 1 and flow.leases == set()


@pytest.mark.asyncio
async def test_a_new_call_for_a_task_whose_job_ended_meanwhile_is_freed(
    monkeypatch,
):
    """A claim reopening a run-out call finds its job gone when it stores the
    new call: that call ends at once and the claim stops."""
    flow = _Flow(monkeypatch)
    flow.stored_task(call="")
    flow.polls = [_SUCCEEDED]
    monkeypatch.setattr(source_text, "_store_state", lambda *_a: False)

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()

    (new_call,) = flow.calls
    assert flow.calls[new_call] == "abandoned" and flow.leases == set()
    assert "settle" not in flow.kinds()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("refusal", "keeps_lease"),
    [
        (source_text.FiletransRetryableError(503), False),
        (httpx.ConnectError("lost"), True),
    ],
)
async def test_a_refused_submit_is_one_provider_failure(
    monkeypatch, refusal, keeps_lease
):
    flow = _Flow(monkeypatch)

    async def refused(_url, _context):
        raise refusal

    monkeypatch.setattr(source_text, "_submit", refused)

    with pytest.raises(source_text.FiletransWait):
        await flow.claim()

    assert flow.payload == {"providerFailures": 1}
    assert "abandon" in flow.kinds()
    # A lost answer may have made a task: its lease runs out on its own.
    assert bool(flow.leases) is keeps_lease


@pytest.mark.asyncio
async def test_a_recording_with_no_speech_is_ready_unindexed_and_free(monkeypatch):
    """No speech is not a failure: the call settles at zero credits (not
    abandoned), nothing is cached, and the file ends ready and unindexed
    with its own reason."""
    flow = _Flow(monkeypatch)
    flow.polls = [_SUCCEEDED]
    flow.transcripts = [{"transcripts": []}]

    with pytest.raises(jobs.InputLimitError) as outcome:
        await flow.run()

    assert outcome.value.code == "no_speech"
    assert flow.events[-2:] == [("settle", 61, "seconds", 0), ("release",)]
    assert "abandon" not in flow.kinds() and not flow.cache


@pytest.mark.asyncio
async def test_speech_past_the_measured_length_is_billed_to_its_end(monkeypatch):
    flow = _Flow(monkeypatch)
    flow.polls = [_SUCCEEDED]
    late = {"begin_time": 0, "end_time": 90_400, "text": "Hello."}
    flow.transcripts = [{"transcripts": [{"sentences": [late]}]}]

    await flow.run()

    # Measured 60.2 s, speech ends at 90.4 s: 91 seconds are charged.
    assert ("settle", 91, "seconds", 91 * 16_667) in flow.events


@pytest.mark.asyncio
async def test_speech_past_two_hours_is_the_index_limit_uncharged(monkeypatch):
    flow = _Flow(monkeypatch)
    flow.polls = [_SUCCEEDED]
    end = (2 * 60 * 60 + 1) * 1000
    flow.transcripts = [
        {
            "transcripts": [
                {"sentences": [{"begin_time": 0, "end_time": end, "text": "Hi."}]}
            ]
        }
    ]

    with pytest.raises(jobs.InputLimitError) as limit:
        await flow.run()

    assert limit.value.code == "audio_duration_limit"
    assert "settle" not in flow.kinds() and "abandon" in flow.kinds()
    assert flow.leases == set() and not flow.cache


@pytest.mark.asyncio
async def test_audio_over_two_hours_is_an_index_limit_before_any_task(monkeypatch):
    flow = _Flow(monkeypatch, duration=2 * 60 * 60 + 0.5)

    with pytest.raises(jobs.InputLimitError) as limit:
        await flow.claim()

    assert limit.value.code == "audio_duration_limit"
    assert flow.events == []


@pytest.mark.asyncio
async def test_a_full_gate_or_another_jobs_task_waits_without_a_task(monkeypatch):
    flow = _Flow(monkeypatch)
    flow.gate_full = True
    with pytest.raises(jobs.CapacityWait) as full:
        await flow.claim()
    assert not isinstance(full.value, source_text.FiletransWait)

    # Another job is transcribing the same bytes: wait for its transcript,
    # with nothing measured.
    def measure(_path):
        raise AssertionError("measured while another job's task runs")

    monkeypatch.setattr(source_text, "audio_duration_seconds", measure)
    flow.gate_full, flow.in_flight = False, True
    with pytest.raises(source_text.FiletransWait) as wait:
        await flow.claim()
    assert wait.value.delay_s == 30
    assert flow.events == [] and flow.payload == {}


@pytest.mark.asyncio
async def test_unconfigured_transcription_fails_before_measuring(monkeypatch):
    flow = _Flow(monkeypatch)
    monkeypatch.setattr(source_text.cfg, "alibaba_modelstudio_key", "")

    def measure(_path):
        raise AssertionError("measured without a provider to send to")

    monkeypatch.setattr(source_text, "audio_duration_seconds", measure)

    with pytest.raises(TerminalError, match="not configured"):
        await flow.claim()
    assert flow.events == []


# The pipeline image installs ffmpeg, and so does CI; elsewhere these skip.
needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None and "CI" not in os.environ,
    reason="ffmpeg is not installed",
)


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", *args], check=True, timeout=60
    )


def _header_seconds(path: Path) -> str:
    """What ffprobe reads from the container's header."""
    return subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration"]
        + ["-of", "default=nw=1:nk=1", str(path)],
        capture_output=True,
        check=True,
        text=True,
        timeout=60,
    ).stdout.strip()


def _shorten_header(path: Path, factor: int) -> None:
    """Divide the duration in an MP4's mvhd, tkhd and mdhd boxes (version
    0) by ``factor``, leaving every sample in place."""
    data = bytearray(path.read_bytes())
    offsets = {b"mvhd": 16, b"tkhd": 20, b"mdhd": 16}

    def walk(start: int, end: int) -> None:
        while start + 8 <= end:
            size, kind = struct.unpack(">I4s", data[start : start + 8])
            if kind in (b"moov", b"trak", b"mdia"):
                walk(start + 8, start + size)
            elif kind in offsets:
                assert data[start + 8] == 0, "version 0 box expected"
                at = start + 8 + offsets[kind]
                (duration,) = struct.unpack(">I", data[at : at + 4])
                data[at : at + 4] = struct.pack(">I", duration // factor)
            start += size

    walk(0, len(data))
    path.write_bytes(data)


@needs_ffmpeg
def test_a_recording_without_a_duration_is_measured_from_its_packets(tmp_path):
    """A browser recorder's WebM names no duration in its header."""
    source = tmp_path / "recording.webm"
    _ffmpeg(
        "-f", "lavfi", "-i", "sine=duration=30", "-c:a", "libopus",
        "-f", "webm", "-live", "1", str(source),
    )  # fmt: skip

    assert _header_seconds(source) == "N/A"
    assert 29.9 < source_text.audio_duration_seconds(source) < 30.1


@needs_ffmpeg
def test_an_mp4_header_naming_a_shorter_duration_is_not_believed(tmp_path):
    source = tmp_path / "lecture.m4a"
    _ffmpeg("-f", "lavfi", "-i", "sine=duration=30", "-c:a", "aac", str(source))
    _shorten_header(source, 60)

    assert float(_header_seconds(source)) < 1
    assert 29.9 < source_text.audio_duration_seconds(source) < 30.1


def test_a_file_without_an_audio_stream_has_no_duration(tmp_path):
    source = tmp_path / "notes.mp3"
    source.write_bytes(b"not audio at all")

    with pytest.raises(TerminalError, match="duration could not be read"):
        source_text.audio_duration_seconds(source)


def test_the_model_studio_url_must_name_the_compatible_mode_base() -> None:
    config.require_modelstudio_url("")
    config.require_modelstudio_url(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
    )
    for url in [
        "https://dashscope-intl.aliyuncs.com",
        "https://dashscope-intl.aliyuncs.com/api/v1",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/",
    ]:
        with pytest.raises(ValueError, match="compatible-mode/v1"):
            config.require_modelstudio_url(url)


def test_transcript_chunks_hold_sentences_and_times_apart(monkeypatch) -> None:
    monkeypatch.setattr(chunking.cfg, "chunk_tokens", 16)
    sentences = [
        {"start_ms": 0, "end_ms": 2000, "speaker": 0, "text": "one two three four"},
        {"start_ms": 2100, "end_ms": 4000, "speaker": 0, "text": "five six seven"},
        # A new speaker past half the chunk: the chunk ends here.
        {"start_ms": 4100, "end_ms": 6000, "speaker": 1, "text": "nine ten"},
        {"start_ms": 6000, "end_ms": 9000, "speaker": 1, "text": "eleven twelve"},
    ]

    chunks = chunking.chunk_transcript(sentences)

    assert [chunk.text for chunk in chunks] == [
        "one two three four\nfive six seven",
        "nine ten\neleven twelve",
    ]
    assert [region.as_dict() for region in chunks[1].regions] == [
        {"start_ms": 4100, "end_ms": 6000, "speaker": 1, "space": "audio-ms"},
        {"start_ms": 6000, "end_ms": 9000, "speaker": 1, "space": "audio-ms"},
    ]
    assert all(chunk.page_start is None and chunk.page_end is None for chunk in chunks)
    # Search sees speech alone; the reader gets the times and speakers back.
    passage = Passage(
        chunk_id="c",
        file_id="f",
        file_name="lecture.mp3",
        chunk_idx=1,
        section_path="",
        text=chunks[1].text,
        regions=[region.as_dict() for region in chunks[1].regions],
    )
    assert passage.location() == "lecture.mp3 › 0:04–0:09"
    assert passage.reading_text() == "[0:04 · Speaker 2] nine ten\neleven twelve"
