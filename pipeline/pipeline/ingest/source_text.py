"""Worker-side derived text for non-document source files.

Images, audio and delimited tables need searchable text but do not belong in
the document parser. The worker already owns the source download, so it
derives that text locally; image captions and audio transcripts are cached by
the server-computed source SHA.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import json
import logging
import math
import mimetypes
import re
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import urlsplit, urlunsplit

import httpx
import requests

from .. import elitellm
from ..config import MODELSTUDIO_BASE_PATH, cfg
from ..generated.limits import AUDIO_MAX_DURATION_SECONDS
from ..jobs import CapacityWait, InputLimitError, RetryableError, TerminalError
from ..prompts.captioning import IMAGE_PROMPT
from ..retrieval import accounting
from ..retrieval.chunking import estimate_tokens
from ..store import blobstore, db
from . import decode

log = logging.getLogger("capy.worker.source_text")

# csv.reader streams rows, but it builds a whole row before its width can be
# read: one 30 MiB row of short fields peaks above 500 MiB, and the widest row
# sets the header list. So each row's raw delimiters (quoted ones too, an upper
# bound on its columns) are counted as its lines reach the reader, and a row
# over the cap is refused before it is parsed. Repeating headers make the
# searchable projection several times the source, so its estimated tokens are
# capped while it is built, before anything is chunked or embedded. With no
# overlap that is 2,500 to 5,000 chunks (2,700 for 11 short columns, one chunk
# per row once a row passes half a chunk), roughly a 1,400-page PDF or more.
_TABULAR_MAX_COLUMNS = 1_000
_TABULAR_MAX_FIELD_CHARS = 8 << 20
_TABULAR_MAX_TOKENS = 1_000_000
# Whitespace runs in a cell, line breaks inside quoted cells included, become
# one space, so each row stays one line. Only runs that aren't already a single
# space match: re.sub keeps every match's segment until it joins them, so a cell
# of ordinary single-spaced text then allocates nothing per word.
_WHITESPACE = re.compile(r"\s{2,}|[^\S ]")


def extension(name: str) -> str:
    return Path(name).suffix.lower().lstrip(".")


def _mime_type(name: str) -> str:
    known = {
        "avif": "image/avif",
        "heic": "image/heic",
        "heif": "image/heif",
        "jp2": "image/jp2",
        "svg": "image/svg+xml",
    }
    return (
        known.get(extension(name))
        or mimetypes.guess_type(name)[0]
        or "application/octet-stream"
    )


def _raw_data_url(path: Path, name: str) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode()
    return f"data:{_mime_type(name)};base64,{encoded}"


def _encode_image(path: Path, name: str) -> str:
    """Normalize supported raster images (decoded by the sandboxed helper,
    ingest/decode.py); retain SVG as its original payload."""
    if extension(name) == "svg":
        return _raw_data_url(path, name)
    try:
        jpeg = decode.caption_jpeg(
            path, max_edge=cfg.caption_max_edge, max_pixels=cfg.image_max_pixels
        )
    except decode.PixelLimit as exc:
        raise InputLimitError("image_pixel_limit", str(exc)) from exc
    if jpeg is None:
        # Some provider-supported formats may not be compiled into the local
        # Pillow build. Sending their original MIME payload preserves support
        # without routing the source through the Go gateway.
        return _raw_data_url(path, name)
    return f"data:image/jpeg;base64,{base64.b64encode(jpeg).decode()}"


async def caption_image_source(
    *, local_path: str, name: str, source_sha256: str, file_id: str
) -> tuple[str, str, int, bool]:
    from ..parse import caption_cache

    async def encode() -> str:
        return await asyncio.to_thread(_encode_image, Path(local_path), name)

    result = await caption_cache.caption(
        file_id=file_id,
        image_sha256=source_sha256,
        data_url=encode,
        prompt=IMAGE_PROMPT,
    )
    if not result[0]:
        raise RetryableError("image captioning produced no searchable text")
    return result


def tabular_text(path: str, name: str) -> str:
    """Turn CSV/TSV rows into explicit field/value text for semantic search."""
    delimiter = "\t" if extension(name) == "tsv" else ","
    csv.field_size_limit(_TABULAR_MAX_FIELD_CHARS)
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as source:
        row_delimiters = 0

        def lines() -> Iterator[str]:
            # The reader pulls lines only until its row ends, so the count
            # since the last row covers exactly the row being built.
            nonlocal row_delimiters
            for line in source:
                row_delimiters += line.count(delimiter)
                if row_delimiters >= _TABULAR_MAX_COLUMNS:
                    raise InputLimitError(
                        "tabular_column_limit",
                        "delimited table exceeds the column limit",
                    )
                yield line

        sample_rows: list[list[str]] = []
        width = 0
        for row in csv.reader(lines(), delimiter=delimiter):
            row_delimiters = 0
            if len(sample_rows) < 20:
                sample_rows.append(row)
            width = max(width, len(row))
    if not sample_rows or width == 0:
        return ""

    sample = "\n".join(delimiter.join(row) for row in sample_rows)
    try:
        has_header = csv.Sniffer().has_header(sample)
    except csv.Error:
        has_header = False
    headers = (
        sample_rows[0]
        if has_header
        else [f"Column {index + 1}" for index in range(width)]
    )
    headers = [
        (_WHITESPACE.sub(" ", headers[index]).strip() if index < len(headers) else "")
        or f"Column {index + 1}"
        for index in range(width)
    ]

    parts: list[str] = []
    tokens = 0

    def append(line: str) -> None:
        nonlocal tokens
        # A character costs at least a quarter token, so a line whose length
        # alone passes the cap is refused before the slower estimate.
        if tokens + len(line) // 4 <= _TABULAR_MAX_TOKENS:
            tokens += estimate_tokens(line)
            if tokens <= _TABULAR_MAX_TOKENS:
                parts.append(line)
                return
        raise InputLimitError(
            "tabular_text_limit",
            "delimited table exceeds the searchable-text limit",
        )

    append("Columns: " + " | ".join(headers))
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as source:
        reader = csv.reader(source, delimiter=delimiter)
        if has_header:
            next(reader, None)
        for row_number, row in enumerate(reader, start=2 if has_header else 1):
            values = []
            for index, raw_value in enumerate(row):
                value = _WHITESPACE.sub(" ", raw_value).strip()
                if value:
                    values.append(f"{headers[index]}={value}")
            if values:
                append(f"Row {row_number}: " + " | ".join(values))
    # A blank line between rows makes each row its own paragraph, so the
    # chunker packs whole rows and never splits one table-sized block.
    return "\n\n".join(parts)


# ------------------------------------------------------------------ audio
#
# Uploaded audio goes to Alibaba Model Studio's Filetrans: an async task that
# fetches the source through a presigned link. One job claim submits the task
# and stores it in the job's payload (``filetrans``), then the job re-pends
# without spending an attempt; each later claim polls the task once
# (``poll_task``, before the claim fetches or hashes the source) and re-pends
# again until the task ends. A worker that dies mid-claim leaves the task
# stored, so the job's next claim polls it instead of submitting another.
# Log lines and error messages name statuses and provider error codes only,
# never transcript text or a signed link.

FILETRANS_MODEL = "qwen-audio-3.1-asr-flash-filetrans"
# At most this many tasks in flight per environment, across every worker and
# every re-pended job: a task's lease is held from its submit to its end. A
# full gate re-pends the job without spending an attempt.
FILETRANS_CAPACITY = ("filetrans", 12)
# How long a task's call and gate lease are held, renewed by every poll
# claim: past the longest re-pend delay plus the queue's wait for a free
# ingest worker (one claim may run CAPY_INGEST_TIMEOUT, 20 minutes), so the
# lease of a job that died frees itself within the hour. A task whose call
# ran out unpolled (the host was down) is still polled, and takes a new call
# under the gate if it runs on or succeeded.
FILETRANS_HOLD_S = 60 * 60
# A stored task older than this is lost (Alibaba keeps a task's result 24 h).
FILETRANS_RESUME_S = 12 * 60 * 60
# The source link only has to last until Alibaba fetches the file.
FILETRANS_LINK_S = 10 * 60
# Re-pend delay before each poll: 2 s, then half again as long each time, up
# to 30 s.
_POLL_FIRST_S = 2
_POLL_MAX_S = 30
_FILETRANS_REQUEST_TIMEOUT_S = 30.0
# Provider failures (a refused submit, a failed or lost task) before the file
# fails: the first is retried with a new task.
_PROVIDER_FAILURES_MAX = 2
# Failed reads of a succeeded task's result link before it counts as one
# provider failure; the earlier ones poll and read it again.
_DOWNLOAD_FAILURES_MAX = 5


class _PollsAtDebug(logging.Filter):
    """httpx logs every request at INFO; a task poll goes out at DEBUG."""

    def filter(self, record: logging.LogRecord) -> bool:
        if "/api/v1/tasks/" not in record.getMessage():
            return True
        record.levelno, record.levelname = logging.DEBUG, "DEBUG"
        return logging.getLogger("httpx").isEnabledFor(logging.DEBUG)


logging.getLogger("httpx").addFilter(_PollsAtDebug())


class FiletransError(Exception):
    """A Filetrans answer without a transcript, named by its HTTP status or
    the task's error code."""

    def __init__(self, reason: int | str) -> None:
        super().__init__(f"audio transcription failed ({reason})")
        self.reason = reason
        if isinstance(reason, int):
            self.status_code = reason


class FiletransRetryableError(FiletransError, RetryableError):
    pass


class FiletransTerminalError(FiletransError, TerminalError):
    pass


class AudioCreditsRefused(TerminalError):
    """The measured task would cost more than the account's credits admit:
    refused before any task or charge."""


class FiletransWait(CapacityWait):
    """The job's task was submitted or is still running: the job re-pends
    without spending an attempt and polls it after ``delay_s``."""

    def __init__(self, delay_s: int) -> None:
        super().__init__(f"audio transcription task running; next poll in {delay_s} s")
        self.delay_s = delay_s


def _poll_delay(polls: int) -> int:
    return min(_POLL_MAX_S, round(_POLL_FIRST_S * 1.5**polls))


def audio_artifact_key(source_sha256: str) -> str:
    return f"derived-text/{source_sha256}/qwen-audio-3.1-filetrans.json"


def _load_artifact(key: str) -> dict[str, Any] | None:
    try:
        raw = blobstore.read_bytes(key)
    except Exception:
        # Only a reuse cache: the local source can still be transcribed.
        log.warning("could not read derived-text cache %s", key, exc_info=True)
        return None
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not value.get("sentences"):
        return None
    return value


def _save_artifact(key: str, payload: dict[str, Any]) -> int | None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    try:
        blobstore.write_bytes(key, data, "application/json")
    except Exception:
        # The transcript in memory still indexes this file; a retry of this
        # job transcribes again at no charge (see settle_ingest_provider_call).
        log.warning("could not write derived-text cache %s", key, exc_info=True)
        return None
    return len(data)


@asynccontextmanager
async def _source_lock(identity: str) -> AsyncIterator[None]:
    """One producer per source SHA: an identical upload on another worker
    waits, then reads the finished transcript."""
    connection = None
    try:
        while connection is None:
            connection = await db.try_source_artifact_lock_async(identity)
            if connection is None:
                await asyncio.sleep(max(0.1, cfg.poll_interval))
        yield
    finally:
        if connection is not None:
            await asyncio.to_thread(
                db.release_source_artifact_lock, connection, identity
            )


def audio_duration_seconds(path: Path) -> float:
    """The source's length from its packets, read by ffmpeg in the decoder
    sandbox (ingest/decode.py)."""
    try:
        duration = decode.audio_seconds(path)
    except decode.DecodeFailed as exc:
        raise TerminalError("audio duration could not be read") from exc
    if duration <= 0:
        raise TerminalError("audio duration could not be read")
    return duration


def _transient(status: int) -> bool:
    return status in (408, 429) or status >= 500


def _raise_for_status(response: httpx.Response) -> None:
    status = response.status_code
    if status < 400:
        return
    if _transient(status):
        raise FiletransRetryableError(status)
    raise FiletransTerminalError(status)


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise FiletransRetryableError("invalid response")
    return value


def _sentences(transcript: dict[str, Any]) -> list[dict[str, Any]]:
    """Every channel's sentences in time order, whitespace collapsed so a
    sentence stays one line of chunk text."""
    sentences = []
    for track in transcript.get("transcripts") or []:
        for sentence in track.get("sentences") or []:
            text = " ".join(str(sentence.get("text") or "").split())
            if not text:
                continue
            speaker = sentence.get("speaker_id")
            sentences.append(
                {
                    "start_ms": int(sentence["begin_time"]),
                    "end_ms": int(sentence["end_time"]),
                    "speaker": speaker if isinstance(speaker, int) else None,
                    "text": text,
                }
            )
    sentences.sort(key=lambda sentence: sentence["start_ms"])
    return sentences


def _task_url(path: str) -> str:
    return cfg.alibaba_modelstudio_url.removesuffix(MODELSTUDIO_BASE_PATH) + path


def _auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {cfg.alibaba_modelstudio_key}"}


async def _submit(source_url: str, context: str) -> str:
    """Submit one Filetrans task and return its id. A 408, 429 or 5xx answer
    is retryable; any other refusal is terminal."""
    body = {
        "model": FILETRANS_MODEL,
        "input": {
            "file_urls": [source_url],
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
    async with httpx.AsyncClient(timeout=_FILETRANS_REQUEST_TIMEOUT_S) as client:
        response = await client.post(
            _task_url("/api/v1/services/audio/asr/transcription"),
            headers={**_auth(), "X-DashScope-Async": "enable"},
            json=body,
        )
    _raise_for_status(response)
    task_id = str((_json(response).get("output") or {}).get("task_id") or "")
    if not task_id:
        raise FiletransRetryableError("no task id")
    return task_id


async def _poll(task_id: str) -> dict[str, Any] | None:
    """The task's ``output``, or None when the poll got a 408, 429 or 5xx,
    no answer or no JSON: the task runs on and the job polls again later.
    Any other refusal is terminal."""
    try:
        async with httpx.AsyncClient(timeout=_FILETRANS_REQUEST_TIMEOUT_S) as client:
            response = await client.get(
                _task_url(f"/api/v1/tasks/{task_id}"), headers=_auth()
            )
    except httpx.TransportError:
        return None
    if _transient(response.status_code):
        return None
    _raise_for_status(response)
    try:
        return _json(response).get("output") or {}
    except FiletransRetryableError:
        return None


# Alibaba's result buckets, one per region
# (dashscope-result-<region>.oss-<region>.aliyuncs.com).
_RESULT_HOST = re.compile(r"dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com")


def _transcript_url(raw: str) -> str:
    """The task's result link, on Alibaba's result buckets only and always
    over https: tasks answer http links, and OSS serves the same signed link
    on either scheme."""
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise FiletransTerminalError("transcript link refused") from None
    host = (parts.hostname or "").lower()
    if (
        parts.scheme not in ("http", "https")
        or parts.username
        or parts.password
        or port is not None
        or not _RESULT_HOST.fullmatch(host)
    ):
        raise FiletransTerminalError("transcript link refused")
    return urlunsplit(("https", host, parts.path, parts.query, ""))


def _download_transcript(url: str) -> dict[str, Any]:
    """The result JSON behind Alibaba's signed link, which takes no API key.

    Fetched with requests, which logs no URL at INFO as httpx does, with no
    redirect followed, and with the cause dropped from errors, whose text
    would carry the link.
    """
    try:
        response = requests.get(
            url, timeout=_FILETRANS_REQUEST_TIMEOUT_S, allow_redirects=False
        )
    except requests.RequestException:
        raise FiletransRetryableError("transcript download failed") from None
    if response.status_code != 200:
        raise FiletransRetryableError(response.status_code)
    try:
        value = response.json()
    except ValueError:
        value = None
    if not isinstance(value, dict):
        raise FiletransRetryableError("invalid transcript")
    return value


def _store_state(job_id: str, attempt: int, state: dict[str, Any]) -> bool:
    """Whether the state was stored: False when this claim lost the job
    (ended, or reclaimed by another worker)."""
    with db.connect() as conn, conn.cursor() as cur:
        stored = db.set_job_filetrans(cur, job_id, attempt, state)
        conn.commit()
    if not stored:
        log.warning("job %s lost its claim before its task state was stored", job_id)
    return stored


async def _store_new_call(job_id: str, attempt: int, state: dict[str, Any]) -> None:
    """Store a state naming a call this claim just opened. A job that ended
    meanwhile has nothing that could free that call's lease (its end freed
    the stored one), so it is ended here and the claim stops."""
    if not await asyncio.to_thread(_store_state, job_id, attempt, state):
        await _end_call(str(state["callId"]), None)
        raise FiletransWait(_POLL_FIRST_S)


def _task_in_flight(source_sha256: str, job_id: str) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        return db.filetrans_task_in_flight(cur, source_sha256, job_id)


def _credits_cover(user_id: str, cost_micros: int) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        covered = db.actor_has_credits(cur, user_id, cost_micros)
        # The check may start an armed auto-reload (claim_credit_reload).
        conn.commit()
    return covered


async def _provider_failure(
    state: dict[str, Any], job_id: str, attempt: int, reason: int | str
) -> NoReturn:
    """Count a refused submit or a task that ended without a transcript. The
    second fails the file; the first is stored and the job re-pends, and its
    next claim submits a new task."""
    failures = int(state.get("providerFailures") or 0) + 1
    if failures >= _PROVIDER_FAILURES_MAX:
        raise FiletransTerminalError(reason)
    await asyncio.to_thread(
        _store_state, job_id, attempt, {"providerFailures": failures}
    )
    raise FiletransWait(_POLL_FIRST_S)


async def _end_call(call_id: str, exc: BaseException | None) -> None:
    """The task is over without a charge: abandon its call (a no-op once it
    was settled), free its lease."""
    await accounting.abandon_call(call_id, exc)
    await accounting.release_lease(call_id)


async def _open_task_call() -> str:
    """A call and one of the gate's leases for a task. A full gate re-pends
    the job without spending an attempt."""
    call_id = accounting.new_call_id()
    try:
        await accounting.open_call(
            call_id,
            kind=accounting.KIND_AUDIO,
            purpose="transcription",
            provider="alibaba",
            model=FILETRANS_MODEL,
            capacity=FILETRANS_CAPACITY,
            provider_timeout_s=FILETRANS_HOLD_S,
        )
    except elitellm.ProviderBusy as exc:
        raise CapacityWait("audio transcription tasks are at their cap") from exc
    return call_id


async def _submit_task(
    state: dict[str, Any],
    *,
    job_id: str,
    attempt: int,
    local_path: str,
    source_sha256: str,
    blob_path: str,
    context: str,
    second_rate_micros: int,
    credit_user_id: str | None,
) -> NoReturn:
    """Measure the source, check its cost against the account's credits,
    take a gate lease, submit one task and store it with the job, which then
    re-pends."""
    if not cfg.alibaba_modelstudio_key:
        raise TerminalError("audio transcription is not configured")
    if await asyncio.to_thread(_task_in_flight, source_sha256, job_id):
        # Another job is transcribing the same bytes: its transcript will be
        # cached, and this job reads it then, with nothing measured meanwhile.
        raise FiletransWait(_POLL_MAX_S)
    duration = await asyncio.to_thread(audio_duration_seconds, Path(local_path))
    if duration > AUDIO_MAX_DURATION_SECONDS:
        raise InputLimitError(
            "audio_duration_limit", "audio is longer than the two-hour limit"
        )
    if credit_user_id is not None and not await asyncio.to_thread(
        _credits_cover, credit_user_id, math.ceil(duration) * second_rate_micros
    ):
        # The browser upload's credit gate on the measured length, which also
        # holds an import (Drive, OneDrive) that no browser measured.
        raise AudioCreditsRefused("audio transcription would pass the credits left")
    call_id = await _open_task_call()
    try:
        # Read-only, this one object, and long enough for Alibaba to fetch it.
        source_url = await asyncio.to_thread(
            blobstore.presign_get, blob_path, FILETRANS_LINK_S
        )
        task_id = await _submit(source_url, context)
    except asyncio.CancelledError:
        # A task may have been created: its call and lease run out on their own.
        raise
    except FiletransRetryableError as exc:
        await _end_call(call_id, exc)
        await _provider_failure(state, job_id, attempt, exc.reason)
    except httpx.TransportError as exc:
        # The answer was lost and a task may run: the lease stays until it
        # expires.
        await accounting.abandon_call(call_id, exc)
        await _provider_failure(state, job_id, attempt, "submit unanswered")
    except BaseException as exc:
        await _end_call(call_id, exc)
        raise
    await _store_new_call(
        job_id,
        attempt,
        {
            "providerFailures": int(state.get("providerFailures") or 0),
            "taskId": task_id,
            "callId": call_id,
            "submittedAt": time.time(),
            "seconds": duration,
            "sha256": source_sha256,
            "polls": 0,
        },
    )
    raise FiletransWait(_poll_delay(0))


async def _wait_again(state: dict[str, Any], job_id: str, attempt: int) -> NoReturn:
    polls = int(state.get("polls") or 0) + 1
    await asyncio.to_thread(_store_state, job_id, attempt, {**state, "polls": polls})
    raise FiletransWait(_poll_delay(polls))


async def poll_task(
    stored: dict[str, Any], *, job_id: str, attempt: int
) -> tuple[dict[str, Any], str]:
    """Poll the job's stored task once; the worker calls this before it
    fetches or hashes the source. Still running, or no answer: the job
    re-pends. Ended without a transcript, or unknown to Alibaba: a provider
    failure. Succeeded: the state to finish it with and its result link.

    A task whose call ran out unpolled is not lost while Alibaba keeps it:
    running or succeeded, it takes a new call and gate lease (or waits for
    one), so the 12-task cap holds again and it is charged once."""
    state = dict(stored)
    call_id = str(state["callId"])
    call = await accounting.renew_call(call_id, FILETRANS_CAPACITY[0], FILETRANS_HOLD_S)
    age = time.time() - float(state["submittedAt"])
    if call != "applied" and age > FILETRANS_RESUME_S:
        # Lost: Alibaba no longer keeps it. An applied call was settled
        # before a crash: its result is read again.
        await _end_call(call_id, FiletransRetryableError("task lost"))
        await _provider_failure(state, job_id, attempt, "task lost")
    try:
        output = await _poll(str(state["taskId"]))
    except FiletransTerminalError as exc:
        await _end_call(call_id, exc)
        if exc.reason == 404:
            # Alibaba does not know the task: lost.
            await _provider_failure(state, job_id, attempt, "task lost")
        raise
    if output is None:
        await _wait_again(state, job_id, attempt)
    status = output.get("task_status")
    running = status in ("PENDING", "RUNNING")
    result = (output.get("results") or [{}])[0]
    url = result.get("transcription_url")
    if not running and (
        status != "SUCCEEDED" or result.get("subtask_status") == "FAILED" or not url
    ):
        # FAILED, CANCELED, UNKNOWN or a state this code does not know.
        code = str(result.get("code") or output.get("code") or f"task {status}")[:80]
        await _end_call(call_id, FiletransRetryableError(code))
        if code.startswith("InvalidFile"):
            raise FiletransTerminalError(code)
        await _provider_failure(state, job_id, attempt, code)
    if not call:
        # Its call ran out unpolled (the host was down past the hour): the
        # sweep abandons it, and the task carries on under a new one.
        state["callId"] = await _open_task_call()
        await _store_new_call(job_id, attempt, state)
    if running:
        await _wait_again(state, job_id, attempt)
    return state, str(url)


async def _finish_task(
    state: dict[str, Any],
    url: str,
    *,
    job_id: str,
    attempt: int,
    second_rate_micros: int,
) -> list[dict[str, Any]]:
    """Read a succeeded task's result and charge it once: its sentences."""
    call_id = str(state["callId"])
    try:
        transcript = await asyncio.to_thread(_download_transcript, _transcript_url(url))
    except FiletransTerminalError as exc:
        await _end_call(call_id, exc)
        raise
    except FiletransRetryableError as exc:
        # Alibaba keeps the result for a day: poll and read it again later,
        # until the fifth failed read counts as a provider failure.
        failures = int(state.get("downloadFailures") or 0) + 1
        if failures >= _DOWNLOAD_FAILURES_MAX:
            await _end_call(call_id, exc)
            await _provider_failure(state, job_id, attempt, "transcript unreadable")
        await _wait_again({**state, "downloadFailures": failures}, job_id, attempt)
    try:
        sentences = _sentences(transcript)
    except (KeyError, TypeError, ValueError):
        await _end_call(call_id, FiletransRetryableError("invalid transcript"))
        await _provider_failure(state, job_id, attempt, "invalid transcript")
    duration = float(state["seconds"])
    if sentences:
        # Where the speech ends is a floor under the measured length (an edit
        # list can shorten what ffmpeg reads; the provider may not apply it).
        # Speech past two hours is the same limit, uncharged.
        spoken = max(sentence["end_ms"] for sentence in sentences) / 1000
        if spoken > AUDIO_MAX_DURATION_SECONDS:
            limit = InputLimitError(
                "audio_duration_limit", "audio is longer than the two-hour limit"
            )
            await _end_call(call_id, limit)
            raise limit
        seconds = math.ceil(max(duration, spoken))
        credit_micros = seconds * second_rate_micros
    else:
        # A finished task that heard no speech: the call succeeded, and
        # nothing is charged.
        seconds, credit_micros = math.ceil(duration), 0
    # After a crash between this settlement and the job's end, the next claim
    # settles the same receipt again, which applies once.
    await accounting.settle_units(
        call_id=call_id,
        kind=accounting.KIND_AUDIO,
        purpose="transcription",
        provider="alibaba",
        model=FILETRANS_MODEL,
        units=seconds,
        unit="seconds",
        credit_micros=credit_micros,
    )
    await accounting.release_lease(call_id)
    if not sentences:
        # Ready and unindexed, with its own reason: not a failure.
        raise InputLimitError("no_speech", "no speech was found in the recording")
    return sentences


async def transcribe_audio_source(
    *,
    job_id: str,
    attempt: int,
    stored: dict[str, Any] | None,
    local_path: str,
    source_sha256: str,
    blob_path: str,
    context: str,
    second_rate_micros: int,
    credit_user_id: str | None,
    transcript_url: str = "",
) -> tuple[list[dict[str, Any]], str, int]:
    """The source's transcript sentences, its cache key and the key's size,
    or ``FiletransWait`` while its task runs.

    A cached transcript of the same bytes is reused. Otherwise a job with no
    stored task (``stored``, the payload's ``filetrans``) measures the source
    against the two-hour limit and, unless the job is system-paid
    (``credit_user_id`` None), its cost against the actor's credits, and
    submits one task under the 12-task gate,
    and a job with one polls it, unless the worker's ``poll_task`` already
    found it succeeded (``stored`` is then its state and ``transcript_url``
    its result link). Only a usable transcript is charged: whole seconds of
    the measured duration or the last sentence's end, whichever is later, at
    the job's snapshotted rate.
    """
    key = audio_artifact_key(source_sha256)
    state = dict(stored or {})
    async with _source_lock(f"filetrans:{source_sha256}"):
        cached = await asyncio.to_thread(_load_artifact, key)
        if cached:
            if state.get("callId"):
                # This job's task was not needed (or was settled before the
                # cache was written): its call ends uncharged unless it was
                # settled, and its lease is freed.
                await _end_call(str(state["callId"]), None)
            size = len(
                json.dumps(cached, ensure_ascii=False, separators=(",", ":")).encode()
            )
            return list(cached["sentences"]), key, size
        if not state.get("taskId"):
            await _submit_task(
                state,
                job_id=job_id,
                attempt=attempt,
                local_path=local_path,
                source_sha256=source_sha256,
                blob_path=blob_path,
                context=context,
                second_rate_micros=second_rate_micros,
                credit_user_id=credit_user_id,
            )
        if not transcript_url:
            state, transcript_url = await poll_task(
                state, job_id=job_id, attempt=attempt
            )
        sentences = await _finish_task(
            state,
            transcript_url,
            job_id=job_id,
            attempt=attempt,
            second_rate_micros=second_rate_micros,
        )
        payload = {
            "kind": "audio_transcript",
            "model": FILETRANS_MODEL,
            "durationSeconds": state["seconds"],
            "sentences": sentences,
        }
        size = await asyncio.to_thread(_save_artifact, key, payload)
        return sentences, key if size is not None else "", size or 0
