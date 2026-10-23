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
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
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
# fetches the source through a presigned link, which this attempt submits and
# polls to the end. Nothing about the task outlives the attempt; a retried
# attempt submits again. Log lines and error messages name statuses and
# provider error codes only, never transcript text or the signed link.

FILETRANS_MODEL = "qwen-audio-3.1-asr-flash-filetrans"
# At most this many tasks in flight across every ingest worker; a full gate
# re-pends the job without spending an attempt.
FILETRANS_CAPACITY = ("filetrans", 12)
# One task's wall budget: submit, poll, read the result. The source link lives
# as long, since nothing waits for the task after it.
FILETRANS_TIMEOUT_S = 15 * 60
# The first poll's wait, growing by half after each poll up to the maximum.
_FILETRANS_POLL_S = 2.0
_FILETRANS_POLL_MAX_S = 10.0
_FILETRANS_REQUEST_TIMEOUT_S = 30.0


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
        if isinstance(reason, int):
            self.status_code = reason


class FiletransRetryableError(FiletransError, RetryableError):
    pass


class FiletransTerminalError(FiletransError, TerminalError):
    pass


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


async def _filetrans(source_url: str, context: str) -> list[dict[str, Any]]:
    """Run one Filetrans task to its end and return its sentences.

    A 408, 429 or 5xx answer to the submit, or a task that ended without a
    transcript for another reason, is retryable (the ingest job's one retry
    submits again); any other refused request, or a file the task could not
    fetch or decode (``InvalidFile.*``), is terminal. While the task runs, a
    poll that gets a 408, 429, 5xx or no answer polls again: only the wall
    budget around this call ends the wait.
    """
    host = cfg.alibaba_modelstudio_url.removesuffix(MODELSTUDIO_BASE_PATH)
    auth = {"Authorization": f"Bearer {cfg.alibaba_modelstudio_key}"}
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
            f"{host}/api/v1/services/audio/asr/transcription",
            headers={**auth, "X-DashScope-Async": "enable"},
            json=body,
        )
        _raise_for_status(response)
        task_id = str((_json(response).get("output") or {}).get("task_id") or "")
        if not task_id:
            raise FiletransRetryableError("no task id")
        delay = _FILETRANS_POLL_S
        while True:
            await asyncio.sleep(delay)
            delay = min(delay * 1.5, _FILETRANS_POLL_MAX_S)
            try:
                response = await client.get(
                    f"{host}/api/v1/tasks/{task_id}", headers=auth
                )
            except httpx.TransportError:
                continue
            if _transient(response.status_code):
                continue
            _raise_for_status(response)
            output = _json(response).get("output") or {}
            status = output.get("task_status")
            if status not in ("PENDING", "RUNNING"):
                break
    if status not in ("SUCCEEDED", "FAILED"):
        # CANCELED, UNKNOWN or a state this code does not know: over, with
        # no transcript.
        raise FiletransRetryableError(f"task {status}"[:80])
    result = (output.get("results") or [{}])[0]
    url = result.get("transcription_url")
    if status == "FAILED" or result.get("subtask_status") == "FAILED" or not url:
        code = str(result.get("code") or output.get("code") or "task failed")[:80]
        if code.startswith("InvalidFile"):
            raise FiletransTerminalError(code)
        raise FiletransRetryableError(code)
    transcript = await asyncio.to_thread(
        _download_transcript, _transcript_url(str(url))
    )
    try:
        return _sentences(transcript)
    except (KeyError, TypeError, ValueError):
        raise FiletransRetryableError("invalid transcript") from None


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


async def transcribe_audio_source(
    *,
    local_path: str,
    source_sha256: str,
    blob_path: str,
    context: str,
    second_rate_micros: int,
) -> tuple[list[dict[str, Any]], str, int]:
    """The source's transcript sentences, its cache key and the key's size.

    A cached transcript of the same bytes is reused. Otherwise the measured
    duration is checked against the two-hour limit, one Filetrans task runs
    under the 12-task gate, and only a usable transcript is charged: whole
    seconds of the measured duration or the last sentence's end, whichever
    is later, at the job's snapshotted rate.
    """
    key = audio_artifact_key(source_sha256)
    async with _source_lock(f"filetrans:{source_sha256}"):
        cached = await asyncio.to_thread(_load_artifact, key)
        if cached:
            size = len(
                json.dumps(cached, ensure_ascii=False, separators=(",", ":")).encode()
            )
            return list(cached["sentences"]), key, size

        if not cfg.alibaba_modelstudio_key:
            raise TerminalError("audio transcription is not configured")
        duration = await asyncio.to_thread(audio_duration_seconds, Path(local_path))
        if duration > AUDIO_MAX_DURATION_SECONDS:
            raise InputLimitError(
                "audio_duration_limit", "audio is longer than the two-hour limit"
            )
        call_id = accounting.new_call_id()
        try:
            await accounting.open_call(
                call_id,
                kind=accounting.KIND_AUDIO,
                purpose="transcription",
                provider="alibaba",
                model=FILETRANS_MODEL,
                capacity=FILETRANS_CAPACITY,
                provider_timeout_s=FILETRANS_TIMEOUT_S,
            )
        except elitellm.ProviderBusy as exc:
            raise CapacityWait("audio transcription tasks are at their cap") from exc
        # Whether a submitted task may still be running at Alibaba (timed
        # out, cancelled, or a submit whose answer was lost): its lease then
        # stays until the receipt window ends, so the tasks running there
        # stay within the gate.
        running = False
        try:
            # Read-only, this one object, and no longer than the task may run.
            source_url = await asyncio.to_thread(
                blobstore.presign_get, blob_path, FILETRANS_TIMEOUT_S
            )
            running = True
            try:
                async with asyncio.timeout(FILETRANS_TIMEOUT_S):
                    sentences = await _filetrans(source_url, context)
            except FiletransError:
                running = False
                raise
            except (TimeoutError, httpx.TransportError) as exc:
                raise RetryableError(
                    "audio transcription is temporarily unavailable"
                ) from exc
            running = False
            if sentences:
                # Where the speech ends is a floor under the measured length
                # (an edit list can shorten what ffmpeg reads; the provider
                # may not apply it). Speech past two hours is the same limit,
                # uncharged.
                spoken = max(sentence["end_ms"] for sentence in sentences) / 1000
                if spoken > AUDIO_MAX_DURATION_SECONDS:
                    raise InputLimitError(
                        "audio_duration_limit",
                        "audio is longer than the two-hour limit",
                    )
                seconds = math.ceil(max(duration, spoken))
                credit_micros = seconds * second_rate_micros
            else:
                # A finished task that heard no speech: the call succeeded,
                # and nothing is charged.
                seconds, credit_micros = math.ceil(duration), 0
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
        except (asyncio.CancelledError, accounting.SettlementError):
            # Cancelled: the task may still run, so the call stays open for
            # its receipt window. A settlement error leaves it to the sweep.
            raise
        except BaseException as exc:
            await accounting.abandon_call(call_id, exc)
            raise
        finally:
            if not running:
                await accounting.release_call(call_id)
        if not sentences:
            # Ready and unindexed, with its own reason: not a failure.
            raise InputLimitError("no_speech", "no speech was found in the recording")

        payload = {
            "kind": "audio_transcript",
            "model": FILETRANS_MODEL,
            "durationSeconds": duration,
            "sentences": sentences,
        }
        size = await asyncio.to_thread(_save_artifact, key, payload)
        return sentences, key if size is not None else "", size or 0
