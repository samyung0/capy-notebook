"""Worker-side derived text for non-document source files.

Images, audio, and delimited tables need searchable text but do not belong in
the MinerU document parser. The worker already owns the source download,
so it derives that text locally and caches provider-backed results by the
server-computed source SHA.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import io
import json
import logging
import math
import mimetypes
import subprocess
import warnings
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from itertools import islice
from pathlib import Path
from typing import Any

import httpx

from ..config import cfg
from ..jobs import CapacityWait, RetryableError, TerminalError
from ..prompts.captioning import IMAGE_PROMPT
from ..retrieval import accounting
from ..store import blobstore, db

log = logging.getLogger("capy.worker.source_text")

_AUDIO_CAPACITY_LEASE_SECONDS = 300
_AUDIO_CAPACITY_RENEW_SECONDS = 60

# A compressed object-size limit is not a useful allocation bound for CSV: a
# delimiter-heavy row becomes one Python object per cell, and repeating long
# headers can make the searchable projection much larger than the source. Keep
# those two independent expansions bounded before the chunker sees them.
_TABULAR_MAX_CELLS = 100_000
_TABULAR_MAX_FIELD_CHARS = 8 << 20
_TABULAR_MAX_OUTPUT_CHARS = 64 << 20


class ElevenLabsNotCalledError(TerminalError):
    """Configuration prevented the request before ElevenLabs could receive it."""

    provider_not_called = True


class ElevenLabsRetryableResponseError(RetryableError):
    def __init__(self, status_code: int):
        super().__init__(f"ElevenLabs transcription failed temporarily ({status_code})")
        self.status_code = status_code


class ElevenLabsTerminalResponseError(TerminalError):
    def __init__(self, status_code: int):
        super().__init__(f"ElevenLabs transcription was refused ({status_code})")
        self.status_code = status_code


class ElevenLabsInvalidResponseError(RetryableError):
    """ElevenLabs answered successfully, but no usable transcript was returned."""


def extension(name: str) -> str:
    return Path(name).suffix.lower().lstrip(".")


def artifact_key(source_sha256: str, direct: str) -> str:
    if direct == "audio":
        return f"derived-text/{source_sha256}/elevenlabs.json"
    return ""


def _load_artifact(key: str) -> dict[str, Any] | None:
    if not key:
        return None
    try:
        raw = blobstore.read_bytes(key)
    except Exception:
        # This object is only a reuse cache. The local source is still enough
        # to run the transformation, so a cache outage must behave like a miss.
        log.warning("could not read derived-text cache %s", key, exc_info=True)
        return None
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not str(value.get("text") or "").strip():
        return None
    return value


def _save_artifact(key: str, payload: dict[str, Any]) -> int | None:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    try:
        blobstore.write_bytes(key, data, "application/json")
    except Exception:
        # Provider output remains usable by this ingest. Missing the cache only
        # means a later upload may need to pay for the transformation again.
        log.warning("could not write derived-text cache %s", key, exc_info=True)
        return None
    return len(data)


@asynccontextmanager
async def _source_lock(identity: str) -> AsyncIterator[None]:
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


def _frame_indices(frame_count: int, maximum: int = 9) -> list[int]:
    if frame_count <= maximum:
        return list(range(frame_count))
    return sorted(
        {
            min(frame_count - 1, round(index * (frame_count - 1) / (maximum - 1)))
            for index in range(maximum)
        }
    )


def _encode_image(path: Path, name: str) -> str:
    """Normalize supported raster images; retain SVG as its original payload."""
    if extension(name) == "svg":
        return _raw_data_url(path, name)

    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                frame_count = int(getattr(source, "n_frames", 1) or 1)
                frames = []
                total_pixels = 0
                for index in _frame_indices(frame_count):
                    source.seek(index)
                    width, height = source.size
                    pixels = width * height
                    if pixels <= 0 or pixels > cfg.image_max_pixels:
                        raise TerminalError("image exceeds the decoded-pixel limit")
                    total_pixels += pixels
                    if total_pixels > cfg.image_max_pixels:
                        raise TerminalError(
                            "animated image exceeds the decoded-pixel limit"
                        )
                    frame = ImageOps.exif_transpose(source.copy()).convert("RGBA")
                    frame.thumbnail(
                        (cfg.caption_max_edge, cfg.caption_max_edge),
                        Image.Resampling.LANCZOS,
                    )
                    flattened = Image.new("RGB", frame.size, "white")
                    flattened.paste(frame, mask=frame.getchannel("A"))
                    frames.append(flattened)
    except TerminalError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise TerminalError("image exceeds the decoded-pixel limit") from exc
    except (OSError, UnidentifiedImageError, ValueError):
        # Some provider-supported formats may not be compiled into the local
        # Pillow build. Sending their original MIME payload preserves support
        # without routing the source through the Go gateway.
        return _raw_data_url(path, name)

    if len(frames) == 1:
        output = frames[0]
    else:
        columns = min(3, len(frames))
        rows = math.ceil(len(frames) / columns)
        cell_width = max(frame.width for frame in frames)
        cell_height = max(frame.height for frame in frames)
        output = Image.new("RGB", (cell_width * columns, cell_height * rows), "white")
        for index, frame in enumerate(frames):
            x = (index % columns) * cell_width + (cell_width - frame.width) // 2
            y = (index // columns) * cell_height + (cell_height - frame.height) // 2
            output.paste(frame, (x, y))

    buffer = io.BytesIO()
    output.save(buffer, format="JPEG", quality=85, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/jpeg;base64,{encoded}"


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
        best_effort=False,
        require_source_job=True,
    )
    if not result[0]:
        raise RetryableError("image captioning produced no searchable text")
    return result


def audio_duration_seconds(path: Path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            check=True,
            text=True,
            timeout=30,
        )
        duration = float(result.stdout.strip())
    except (FileNotFoundError, subprocess.SubprocessError, ValueError) as exc:
        raise TerminalError("audio duration could not be read") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise TerminalError("audio duration could not be read")
    return duration


def audio_concurrency_units(duration_seconds: float) -> int:
    """Return ElevenLabs Starter weighted concurrency for one audio file."""
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise TerminalError("audio duration could not be read")
    return min(4, math.ceil(duration_seconds / 480))


def _reserve_audio_capacity(lease_id: str, units: int) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        reserved = db.acquire_provider_capacity(
            cur,
            lease_id=lease_id,
            provider="elevenlabs:scribe_v2",
            units=units,
            capacity=cfg.elevenlabs_concurrency_units,
            lease_seconds=_AUDIO_CAPACITY_LEASE_SECONDS,
        )
        conn.commit()
        return reserved


def _release_audio_capacity(lease_id: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.release_provider_capacity(cur, lease_id)
        conn.commit()


def _renew_audio_capacity(lease_id: str) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        renewed = db.renew_provider_capacity(
            cur, lease_id, _AUDIO_CAPACITY_LEASE_SECONDS
        )
        conn.commit()
        return renewed


async def _maintain_audio_capacity(lease_id: str) -> None:
    """Keep a long request's short crash-reclaimable lease live or fail closed."""
    loop = asyncio.get_running_loop()
    expires_at = loop.time() + _AUDIO_CAPACITY_LEASE_SECONDS
    while True:
        await asyncio.sleep(_AUDIO_CAPACITY_RENEW_SECONDS)
        try:
            remaining = expires_at - loop.time()
            if remaining <= 0:
                raise TimeoutError
            renewed = await asyncio.wait_for(
                asyncio.to_thread(_renew_audio_capacity, lease_id),
                timeout=remaining,
            )
        except TimeoutError as exc:
            raise RetryableError(
                "ElevenLabs capacity lease expired while request was active"
            ) from exc
        except Exception:
            log.warning("could not renew ElevenLabs capacity lease", exc_info=True)
            if loop.time() >= expires_at:
                raise RetryableError(
                    "ElevenLabs capacity lease expired while request was active"
                )
            continue
        if not renewed:
            raise RetryableError(
                "ElevenLabs capacity lease expired while request was active"
            )
        expires_at = loop.time() + _AUDIO_CAPACITY_LEASE_SECONDS


async def _stop_audio_capacity(
    lease_id: str, capacity_heartbeat: asyncio.Task[None]
) -> None:
    capacity_heartbeat.cancel()
    await asyncio.gather(capacity_heartbeat, return_exceptions=True)
    try:
        await asyncio.to_thread(_release_audio_capacity, lease_id)
    except Exception:
        # The lease cannot remain live for more than five minutes. Provider
        # receipt settlement and ingest output must not be lost because eager
        # cleanup was unavailable after the HTTP request had already closed.
        log.warning("could not release ElevenLabs capacity lease", exc_info=True)


def _elevenlabs_headers() -> dict[str, str]:
    if not cfg.elevenlabs_api_key:
        raise ElevenLabsNotCalledError("ElevenLabs is not configured")
    return {"xi-api-key": cfg.elevenlabs_api_key}


async def _transcribe_audio(source_url: str) -> dict[str, Any]:
    # ElevenLabs requires multipart form fields even when the source is a URL.
    # A plain ``data=`` mapping sends application/x-www-form-urlencoded.
    fields = {
        "model_id": (None, "scribe_v2"),
        "source_url": (None, source_url),
    }
    async with asyncio.timeout(cfg.elevenlabs_sync_timeout_s):
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(cfg.elevenlabs_sync_timeout_s)
        ) as client:
            response = await client.post(
                cfg.elevenlabs_base_url.rstrip("/") + "/v1/speech-to-text",
                headers=_elevenlabs_headers(),
                files=fields,
            )
    if response.status_code in (408, 425, 429) or response.status_code >= 500:
        raise ElevenLabsRetryableResponseError(response.status_code)
    if response.status_code >= 400:
        raise ElevenLabsTerminalResponseError(response.status_code)
    try:
        payload = response.json()
    except ValueError as exc:
        raise ElevenLabsInvalidResponseError(
            "ElevenLabs returned an invalid transcription"
        ) from exc
    if not isinstance(payload, dict) or not str(payload.get("text") or "").strip():
        raise ElevenLabsInvalidResponseError(
            "ElevenLabs returned an empty transcription"
        )
    return payload


async def _transcribe_while_capacity_is_live(
    source_url: str,
    capacity_heartbeat: asyncio.Task[None],
) -> tuple[
    dict[str, Any] | None,
    ElevenLabsInvalidResponseError | None,
    bool,
]:
    provider = asyncio.create_task(_transcribe_audio(source_url))

    def completed_outcome(cancelled: bool):
        try:
            return provider.result(), None, cancelled
        except ElevenLabsInvalidResponseError as exc:
            return None, exc, cancelled

    try:
        try:
            done, _ = await asyncio.wait(
                {provider, capacity_heartbeat},
                return_when=asyncio.FIRST_COMPLETED,
            )
        except asyncio.CancelledError:
            # asyncio.wait can be cancelled after the provider task has already
            # produced its response but before it hands the done set back. The
            # exact receipt is known at that point and must cross the same
            # settlement/cache boundary as any other completed response.
            if provider.done() and not provider.cancelled():
                return completed_outcome(True)
            raise
        if provider in done:
            return completed_outcome(False)
        # Capacity admission is no longer valid. Close the active HTTP request
        # before releasing the lease so a successor cannot overlap it locally.
        provider.cancel()
        await asyncio.gather(provider, return_exceptions=True)
        error = capacity_heartbeat.exception()
        if error is not None:
            raise error
        raise RetryableError(
            "ElevenLabs capacity lease expired while request was active"
        )
    finally:
        if not provider.done():
            provider.cancel()
            await asyncio.gather(provider, return_exceptions=True)


def _audio_artifact_payload(
    response: dict[str, Any],
    *,
    duration_seconds: float,
    billable_seconds: int,
) -> dict[str, Any]:
    return {
        "billableSeconds": billable_seconds,
        "duration": duration_seconds,
        "kind": "audio_transcript",
        "languageCode": response.get("language_code"),
        "words": response.get("words")
        if isinstance(response.get("words"), list)
        else [],
        "text": str(response["text"]).strip(),
    }


async def transcribe_audio_source(
    *,
    local_path: str,
    source_sha256: str,
    blob_path: str,
    audio_rate: dict[str, Any],
) -> tuple[str, str, int]:
    """Synchronously transcribe, settle usage, then cache the result."""
    key = artifact_key(source_sha256, "audio")
    identity = f"elevenlabs:{source_sha256}"
    async with _source_lock(identity):
        cached = await asyncio.to_thread(_load_artifact, key)
        if cached:
            size = len(
                json.dumps(cached, ensure_ascii=False, separators=(",", ":")).encode()
            )
            return str(cached["text"]), key, size

        duration = await asyncio.to_thread(audio_duration_seconds, Path(local_path))
        if duration > cfg.audio_max_duration_seconds:
            raise TerminalError("audio exceeds the 10-hour duration limit")
        billable_seconds = math.ceil(duration)
        concurrency_units = audio_concurrency_units(duration)
        lease_id = db.uid("pcl")
        reserved = await asyncio.to_thread(
            _reserve_audio_capacity, lease_id, concurrency_units
        )
        if not reserved:
            raise CapacityWait("ElevenLabs Starter concurrency is full")
        capacity_heartbeat = asyncio.create_task(_maintain_audio_capacity(lease_id))
        capacity_stopped = False

        call_id = accounting.new_call_id()
        try:
            # Resolve the signed source URL before the accounting stub. From
            # the stub onward, failure is either a sent provider attempt, a
            # definitive response, or the explicit not-configured case.
            source_url = await asyncio.to_thread(
                blobstore.presign_get,
                blob_path,
                cfg.elevenlabs_sync_timeout_s,
            )
            await accounting.open_call(
                call_id,
                kind=accounting.KIND_AUDIO,
                purpose="transcription",
                provider="elevenlabs",
                model="scribe_v2",
            )
            response: dict[str, Any] | None = None
            completed_error: ElevenLabsInvalidResponseError | None = None
            cancelled_after_response = False
            try:
                (
                    response,
                    completed_error,
                    cancelled_after_response,
                ) = await _transcribe_while_capacity_is_live(
                    source_url, capacity_heartbeat
                )
            except (TimeoutError, httpx.TimeoutException, httpx.NetworkError) as exc:
                raise RetryableError(
                    "ElevenLabs transcription is temporarily unavailable"
                ) from exc

            async def finish_completed_response() -> tuple[str, str, int] | None:
                nonlocal capacity_stopped
                try:
                    await _stop_audio_capacity(lease_id, capacity_heartbeat)
                finally:
                    capacity_stopped = True
                await accounting.settle_units(
                    call_id=call_id,
                    kind=accounting.KIND_AUDIO,
                    purpose="transcription",
                    provider="elevenlabs",
                    model="scribe_v2",
                    units=billable_seconds,
                    unit="seconds",
                    credit_micros=(
                        billable_seconds * int(audio_rate["creditMicrosPerUnit"])
                    ),
                )
                if completed_error is not None:
                    return None
                assert response is not None
                payload = _audio_artifact_payload(
                    response,
                    duration_seconds=duration,
                    billable_seconds=billable_seconds,
                )
                size = await asyncio.to_thread(_save_artifact, key, payload)
                return (
                    str(payload["text"]),
                    key if size is not None else "",
                    size or 0,
                )

            # Once the provider response is known, cancellation may stop neither
            # its exact receipt nor persistence of a reusable successful result.
            result = await accounting._finish_known_receipt(finish_completed_response())
            if cancelled_after_response:
                raise asyncio.CancelledError
            if completed_error is not None:
                raise completed_error
            assert result is not None
            return result
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            if not isinstance(exc, accounting.SettlementError) and (
                accounting.definitive_provider_failure(exc)
            ):
                await accounting.abandon_call(call_id, exc)
            raise
        finally:
            if not capacity_stopped:
                await _stop_audio_capacity(lease_id, capacity_heartbeat)


def tabular_text(path: str, name: str) -> str:
    """Turn CSV/TSV rows into explicit field/value text for semantic search."""
    delimiter = "\t" if extension(name) == "tsv" else ","
    delimiter_byte = delimiter.encode()
    cell_count = 1
    with open(path, "rb") as raw:
        while block := raw.read(1 << 20):
            cell_count += block.count(delimiter_byte)
            if cell_count > _TABULAR_MAX_CELLS:
                raise TerminalError("delimited table exceeds the cell limit")

    csv.field_size_limit(_TABULAR_MAX_FIELD_CHARS)
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as source:
        reader = csv.reader(source, delimiter=delimiter)
        sample_rows = list(islice(reader, 20))
        width = max((len(row) for row in sample_rows), default=0)
        for row in reader:
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
        (headers[index].strip() if index < len(headers) else "")
        or f"Column {index + 1}"
        for index in range(width)
    ]

    parts: list[str] = []
    output_chars = 0

    def append(line: str) -> None:
        nonlocal output_chars
        extra = len(line) + (1 if parts else 0)
        if output_chars + extra > _TABULAR_MAX_OUTPUT_CHARS:
            raise TerminalError("delimited table exceeds the searchable-text limit")
        parts.append(line)
        output_chars += extra

    append("Columns: " + " | ".join(headers))
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as source:
        reader = csv.reader(source, delimiter=delimiter)
        if has_header:
            next(reader, None)
        for row_number, row in enumerate(reader, start=2 if has_header else 1):
            values = []
            for index, raw_value in enumerate(row):
                value = raw_value.strip()
                if value:
                    values.append(f"{headers[index]}={value}")
            if values:
                append(f"Row {row_number}: " + " | ".join(values))
    return "\n".join(parts)
