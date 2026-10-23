from __future__ import annotations

import json
import threading
from contextlib import asynccontextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from PIL import Image

from pipeline import elitellm, jobs
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


class _FakeFiletrans:
    """Alibaba's task API on 127.0.0.1: scripted answers for the submit, each
    poll and the transcript download, with every request kept."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str], bytes]] = []
        self.submit = (200, {"output": {"task_id": "task-1"}})
        self.polls: list[tuple[int, dict]] = []
        self.transcript = (200, {"transcripts": []})
        self.url = ""

    def succeeded(self) -> tuple[int, dict]:
        result = {
            "subtask_status": "SUCCEEDED",
            "transcription_url": f"{self.url}/result.json",
        }
        return 200, {"output": {"task_status": "SUCCEEDED", "results": [result]}}

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
    monkeypatch.setattr(source_text, "_FILETRANS_POLL_S", 0)
    yield fake
    server.shutdown()
    server.server_close()


@pytest.mark.asyncio
async def test_filetrans_submits_polls_and_reads_the_transcript(filetrans) -> None:
    filetrans.polls = [
        (200, {"output": {"task_status": "RUNNING"}}),
        filetrans.succeeded(),
    ]
    first = {
        "begin_time": 0,
        "end_time": 3900,
        "text": " First  one. ",
        "speaker_id": 0,
    }
    second = {"begin_time": 4200, "end_time": 6100, "text": "第二句", "speaker_id": 1}
    blank = {"begin_time": 6100, "end_time": 6300, "text": "  "}
    filetrans.transcript = (
        200,
        {"transcripts": [{"channel_id": 0, "sentences": [second, first, blank]}]},
    )
    context = "Workspace: Bio\nFile: a.mp3"

    sentences = await source_text._filetrans(_SOURCE_URL, context)

    assert sentences == [
        {"start_ms": 0, "end_ms": 3900, "speaker": 0, "text": "First one."},
        {"start_ms": 4200, "end_ms": 6100, "speaker": 1, "text": "第二句"},
    ]
    (method, path, headers, body), *polls, (_, result_path, result_headers, _) = (
        filetrans.requests
    )
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
    assert [poll[1] for poll in polls] == ["/api/v1/tasks/task-1"] * 2
    assert all(poll[2]["Authorization"] == "Bearer test-key" for poll in polls)
    # The result link is Alibaba's own signed URL: no API key goes with it.
    assert result_path == "/result.json" and "Authorization" not in result_headers


def _failed(code: str, subtask: bool = False) -> tuple[int, dict]:
    if subtask:
        result = {"subtask_status": "FAILED", "code": code}
        return 200, {"output": {"task_status": "SUCCEEDED", "results": [result]}}
    return 200, {"output": {"task_status": "FAILED", "code": code}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("submit", "poll", "retryable"),
    [
        # Retried once by the ingest job, then terminal.
        ((429, {"code": "Throttling.RateQuota"}), None, True),
        ((503, {}), None, True),
        (None, _failed("InternalError.Timeout"), True),
        # Terminal at once: a refused request, a link or file the task cannot use.
        ((400, {"code": "InvalidParameter"}), None, False),
        (None, _failed("InvalidFile.DownloadFailed"), False),
        (None, _failed("InvalidFile.AudioFormatUnsupported", subtask=True), False),
    ],
)
async def test_filetrans_failures_retry_once_or_stop(
    filetrans, submit, poll, retryable
) -> None:
    if submit is not None:
        filetrans.submit = submit
    if poll is not None:
        filetrans.polls = [poll]

    with pytest.raises(source_text.FiletransError) as failure:
        await source_text._filetrans(_SOURCE_URL, "context")

    assert jobs.is_retryable(failure.value) is retryable
    assert jobs.POLICIES["ingest"].max_attempts == 2
    # Statuses and provider codes only: never the signed source link.
    assert "Signature" not in str(failure.value)


def _audio_flow(monkeypatch, *, duration: float = 60.2, transcribe=None):
    """transcribe_audio_source with its database, bucket and provider faked.
    Returns the list its accounting calls and Filetrans tasks land in."""
    events: list[tuple] = []
    cache: dict[str, bytes] = {}

    @asynccontextmanager
    async def no_lock(_identity):
        yield

    async def open_call(_call_id, **kwargs):
        events.append(("open", kwargs["capacity"], kwargs["provider_timeout_s"]))

    async def settle_units(**kwargs):
        events.append(
            ("settle", kwargs["units"], kwargs["unit"], kwargs["credit_micros"])
        )

    async def abandon_call(_call_id, exc=None):
        events.append(("abandon", type(exc).__name__))

    async def release_call(_call_id):
        events.append(("release",))

    async def filetrans(url, _context):
        events.append(("task", url))
        if transcribe is not None:
            return transcribe()
        return [{"start_ms": 0, "end_ms": 900, "speaker": 0, "text": "Hello."}]

    def write(key, data, _content_type):
        cache[key] = bytes(data)

    monkeypatch.setattr(source_text, "_source_lock", no_lock)
    monkeypatch.setattr(source_text.blobstore, "read_bytes", cache.get)
    monkeypatch.setattr(source_text.blobstore, "write_bytes", write)
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda key, expires: f"signed:{key}:{expires}",
    )
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: duration)
    monkeypatch.setattr(source_text, "_filetrans", filetrans)
    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)
    monkeypatch.setattr(source_text.accounting, "release_call", release_call)
    return events


async def _transcribe():
    return await source_text.transcribe_audio_source(
        local_path="lecture.mp3",
        source_sha256="ab" * 32,
        blob_path="sources/lecture.mp3",
        context="Workspace: Bio",
        second_rate_micros=16_667,
    )


@pytest.mark.asyncio
async def test_audio_settles_whole_seconds_once_then_reads_the_cache(monkeypatch):
    events = _audio_flow(monkeypatch)

    sentences, key, size = await _transcribe()
    again = await _transcribe()

    assert again == (sentences, key, size) and size > 0
    assert key == f"derived-text/{'ab' * 32}/qwen-audio-3.1-filetrans.json"
    # One task under the 12-task gate, its source link living as long as the
    # task may run, charged ceil(60.2) seconds; the cached rerun calls nothing.
    assert events == [
        ("open", ("filetrans", 12), 900),
        ("task", "signed:sources/lecture.mp3:900"),
        ("settle", 61, "seconds", 61 * 16_667),
        ("release",),
    ]


@pytest.mark.asyncio
async def test_a_failed_audio_task_is_abandoned_uncharged_and_uncached(monkeypatch):
    def fail():
        raise source_text.FiletransRetryableError("InternalError")

    events = _audio_flow(monkeypatch, transcribe=fail)

    with pytest.raises(source_text.FiletransRetryableError):
        await _transcribe()

    assert [event[0] for event in events] == ["open", "task", "abandon", "release"]
    key = source_text.audio_artifact_key("ab" * 32)
    assert source_text.blobstore.read_bytes(key) is None


@pytest.mark.asyncio
async def test_audio_over_two_hours_is_an_index_limit_before_any_task(monkeypatch):
    events = _audio_flow(monkeypatch, duration=2 * 60 * 60 + 0.5)

    with pytest.raises(jobs.InputLimitError) as limit:
        await _transcribe()

    assert limit.value.code == "audio_duration_limit"
    assert events == []


@pytest.mark.asyncio
async def test_a_full_task_gate_waits_for_capacity(monkeypatch):
    events = _audio_flow(monkeypatch)

    async def full(_call_id, **_kwargs):
        raise elitellm.ProviderBusy("gate full", retry_after=5.0)

    monkeypatch.setattr(source_text.accounting, "open_call", full)

    with pytest.raises(jobs.CapacityWait):
        await _transcribe()
    assert events == []


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
