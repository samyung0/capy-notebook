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
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path
from typing import Any

import httpx

from ..config import cfg
from ..jobs import ExternalWait, RetryableError, TerminalError
from ..retrieval import accounting, models
from ..store import blobstore, db

log = logging.getLogger("evo.worker.source_text")

# A compressed object-size limit is not a useful allocation bound for CSV: a
# delimiter-heavy row becomes one Python object per cell, and repeating long
# headers can make the searchable projection much larger than the source. Keep
# those two independent expansions bounded before the chunker sees them.
_TABULAR_MAX_CELLS = 100_000
_TABULAR_MAX_FIELD_CHARS = 8 << 20
_TABULAR_MAX_OUTPUT_CHARS = 64 << 20

_IMAGE_PROMPT = """Describe this image as a faithful, searchable record of everything visibly communicated.

Include all readable text. Transcribe every title, label, legend, annotation, table cell, number, unit, date, axis, data point, and formula that is legible. State equations and mathematical notation precisely in plain text or LaTeX. Explain diagrams, charts, spatial relationships, trends, and comparisons. Preserve uncertainty: call out text or values that are unclear instead of guessing. Do not add facts that are not visible. Return coherent plain text, not JSON."""


class ElevenLabsNotCalledError(TerminalError):
    """Configuration prevented the request before ElevenLabs could receive it."""


class ElevenLabsSubmissionUncertain(Exception):
    """The request may have been accepted; wait for its correlation webhook."""


def extension(name: str) -> str:
    return Path(name).suffix.lower().lstrip(".")


def artifact_key(source_sha256: str, direct: str) -> str:
    if direct == "image":
        return f"derived-text/{source_sha256}/image-{cfg.caption_version}.json"
    if direct == "audio":
        return (
            f"derived-text/{source_sha256}/elevenlabs-"
            f"{cfg.elevenlabs_transcript_version}.json"
        )
    return ""


def _load_artifact(key: str) -> dict[str, Any] | None:
    if not key:
        return None
    raw = blobstore.read_bytes(key)
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or not str(value.get("text") or "").strip():
        return None
    return value


def _save_artifact(key: str, payload: dict[str, Any]) -> int:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    blobstore.write_bytes(key, data, "application/json")
    return len(data)


@asynccontextmanager
async def _source_lock(identity: str) -> AsyncIterator[None]:
    connection = None
    try:
        while connection is None:
            connection = await asyncio.to_thread(db.try_source_artifact_lock, identity)
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
    *, local_path: str, name: str, source_sha256: str
) -> tuple[str, str, int, bool]:
    """Return caption text, artifact path, byte size, and cache-hit state."""
    key = artifact_key(source_sha256, "image")
    identity = f"image-caption:{source_sha256}:{cfg.caption_version}"
    async with _source_lock(identity):
        cached = await asyncio.to_thread(_load_artifact, key)
        if cached:
            return (
                str(cached["text"]),
                key,
                len(
                    json.dumps(
                        cached, ensure_ascii=False, separators=(",", ":")
                    ).encode()
                ),
                True,
            )
        data_url = await asyncio.to_thread(_encode_image, Path(local_path), name)
        text = (await models.caption_image(data_url, _IMAGE_PROMPT)).strip()
        if not text:
            raise RetryableError("image captioning produced no searchable text")
        payload = {
            "kind": "image_caption",
            "text": text,
            "version": cfg.caption_version,
        }
        size = await asyncio.to_thread(_save_artifact, key, payload)
        return text, key, size, False


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


def _audio_state(job_id: str) -> dict[str, Any] | None:
    with db.connect() as conn, conn.cursor() as cur:
        return db.audio_transcription(cur, job_id)


def audio_state(job_id: str) -> dict[str, Any] | None:
    """Return durable provider state before the worker decides to fetch B2."""
    return _audio_state(job_id)


def _reserve_audio_state(**fields: Any) -> bool:
    with db.connect() as conn, conn.cursor() as cur:
        reserved = db.create_audio_transcription(cur, **fields)
        conn.commit()
        return reserved


def _mark_audio_submitting(transcription_id: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.mark_audio_submitting(cur, transcription_id)
        conn.commit()


def _mark_audio_pending(transcription_id: str, provider_id: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.mark_audio_pending(cur, transcription_id, provider_id)
        conn.commit()


def _complete_audio(transcription_id: str, result: dict[str, Any]) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.complete_audio_transcription(cur, transcription_id, result)
        conn.commit()


def _fail_audio(
    transcription_id: str, error: str, *, cleanup_requested: bool = False
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.fail_audio_transcription(
            cur,
            transcription_id,
            error,
            cleanup_requested=cleanup_requested,
        )
        conn.commit()


def _discard_audio(transcription_id: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.delete_audio_transcription(cur, transcription_id)
        conn.commit()


def _finalize_audio(transcription_id: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.finalize_audio_transcription(cur, transcription_id)
        conn.commit()


def _request_audio_cleanup(transcription_id: str, error: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.request_audio_cleanup(cur, transcription_id, error)
        conn.commit()


def _elevenlabs_headers() -> dict[str, str]:
    if not cfg.elevenlabs_api_key:
        raise ElevenLabsNotCalledError("ElevenLabs is not configured")
    return {"xi-api-key": cfg.elevenlabs_api_key}


def _submit_audio(transcription_id: str, source_url: str) -> str:
    data = {
        "model_id": "scribe_v2",
        "source_url": source_url,
        "webhook": "true",
        "webhook_metadata": json.dumps(
            {"audioTranscriptionId": transcription_id}, separators=(",", ":")
        ),
    }
    if cfg.elevenlabs_webhook_id:
        data["webhook_id"] = cfg.elevenlabs_webhook_id
    response = httpx.post(
        cfg.elevenlabs_base_url.rstrip("/") + "/v1/speech-to-text",
        headers=_elevenlabs_headers(),
        data=data,
        timeout=cfg.ingest_provider_timeout_s,
    )
    if response.status_code == 429 or response.status_code >= 500:
        raise RetryableError(
            f"ElevenLabs transcription failed temporarily ({response.status_code})"
        )
    if response.status_code >= 400:
        raise TerminalError(
            f"ElevenLabs transcription was refused ({response.status_code})"
        )
    try:
        payload = response.json()
    except ValueError as exc:
        raise ElevenLabsSubmissionUncertain from exc
    request_id = str(payload.get("request_id") or payload.get("transcription_id") or "")
    if not request_id:
        raise ElevenLabsSubmissionUncertain
    return request_id


def _retrieve_audio(provider_id: str) -> dict[str, Any] | None:
    try:
        response = httpx.get(
            cfg.elevenlabs_base_url.rstrip("/")
            + "/v1/speech-to-text/transcripts/"
            + provider_id,
            headers=_elevenlabs_headers(),
            timeout=cfg.ingest_provider_timeout_s,
        )
    except (httpx.TimeoutException, httpx.NetworkError):
        return None
    if response.status_code in {404, 409, 422, 429} or response.status_code >= 500:
        return None
    if response.status_code >= 400:
        raise TerminalError(
            f"ElevenLabs transcript retrieval was refused ({response.status_code})"
        )
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict) or not str(payload.get("text") or "").strip():
        return None
    return payload


def delete_provider_audio(provider_id: str) -> bool:
    if not provider_id:
        return True
    try:
        response = httpx.delete(
            cfg.elevenlabs_base_url.rstrip("/")
            + "/v1/speech-to-text/transcripts/"
            + provider_id,
            headers=_elevenlabs_headers(),
            timeout=cfg.ingest_provider_timeout_s,
        )
        if response.status_code not in {200, 204, 404}:
            log.warning(
                "could not delete ElevenLabs transcript %s: status %s",
                provider_id,
                response.status_code,
            )
            return False
        return True
    except Exception:
        log.warning(
            "could not delete ElevenLabs transcript %s", provider_id, exc_info=True
        )
        return False


async def _delete_or_queue_provider_audio(
    provider_id: str, transcription_id: str
) -> bool:
    """Delete provider state, retaining a durable retry row on failure."""
    deleted = await asyncio.to_thread(delete_provider_audio, provider_id)
    if not transcription_id:
        return deleted
    if deleted:
        await asyncio.to_thread(_finalize_audio, transcription_id)
    else:
        await asyncio.to_thread(
            _request_audio_cleanup,
            transcription_id,
            "provider transcript deletion failed after successful ingest",
        )
    return deleted


def _audio_artifact_payload(
    response: dict[str, Any],
    *,
    provider_call_id: str,
    billable_seconds: int,
    accounting_status: str,
) -> dict[str, Any]:
    return {
        "accountingStatus": accounting_status,
        "billableSeconds": billable_seconds,
        "duration": response.get("duration"),
        "kind": "audio_transcript",
        "languageCode": response.get("language_code"),
        "providerCallId": provider_call_id,
        "words": response.get("words")
        if isinstance(response.get("words"), list)
        else [],
        "text": str(response["text"]).strip(),
        "version": cfg.elevenlabs_transcript_version,
    }


async def _settle_pending_audio_artifact(
    key: str, payload: dict[str, Any]
) -> tuple[dict[str, Any], int]:
    if payload.get("accountingStatus") != "pending":
        return payload, len(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        )
    call_id = str(payload.get("providerCallId") or "")
    try:
        seconds = int(payload.get("billableSeconds") or 0)
    except (TypeError, ValueError) as exc:
        raise TerminalError("cached audio transcript has invalid accounting") from exc
    if not call_id or seconds <= 0:
        raise TerminalError("cached audio transcript has invalid accounting")
    if "creditMicrosPerSecond" not in payload:
        raise TerminalError("cached audio transcript has no rate snapshot")
    try:
        rate = int(payload["creditMicrosPerSecond"])
    except (TypeError, ValueError) as exc:
        raise TerminalError(
            "cached audio transcript has invalid rate snapshot"
        ) from exc
    if rate < 0:
        raise TerminalError("cached audio transcript has invalid rate snapshot")
    await accounting.settle_units(
        call_id=call_id,
        kind=accounting.KIND_AUDIO,
        purpose="transcription",
        provider="elevenlabs",
        model="scribe_v2",
        units=seconds,
        unit="seconds",
        credit_micros=seconds * rate,
    )
    payload["accountingStatus"] = "settled"
    return payload, await asyncio.to_thread(_save_artifact, key, payload)


async def transcribe_audio_source(
    *,
    local_path: str | None,
    source_sha256: str,
    blob_path: str,
    file_id: str,
    job_id: str,
    audio_rate: dict[str, Any],
) -> tuple[str, str, int]:
    """Return transcript text, artifact path, and serialized byte size."""
    key = artifact_key(source_sha256, "audio")
    identity = f"elevenlabs:{source_sha256}:{cfg.elevenlabs_transcript_version}"
    async with _source_lock(identity):
        cached = await asyncio.to_thread(_load_artifact, key)
        if cached:
            cached, size = await _settle_pending_audio_artifact(key, cached)
            await _delete_or_queue_provider_audio(
                str(cached.get("providerTranscriptionId") or ""),
                str(cached.get("audioTranscriptionId") or ""),
            )
            return (
                str(cached["text"]),
                key,
                size,
            )
        state = await asyncio.to_thread(_audio_state, job_id)
        if state is None:
            if not local_path:
                raise RetryableError("audio source is missing before submission")
            duration = await asyncio.to_thread(audio_duration_seconds, Path(local_path))
            if duration > cfg.audio_max_duration_seconds:
                raise TerminalError("audio exceeds the 10-hour duration limit")
            billable_seconds = math.ceil(duration)
            concurrency_units = audio_concurrency_units(duration)
            call_id = accounting.new_call_id()
            await accounting.open_call(
                call_id, kind=accounting.KIND_AUDIO, purpose="transcription"
            )
            transcription_id = db.uid("at")
            reserved = await asyncio.to_thread(
                _reserve_audio_state,
                transcription_id=transcription_id,
                job_id=job_id,
                file_id=file_id,
                source_sha256=source_sha256,
                duration_seconds=duration,
                billable_seconds=billable_seconds,
                concurrency_units=concurrency_units,
                rate_version=int(audio_rate["version"]),
                credit_micros_per_second=int(audio_rate["creditMicrosPerUnit"]),
                provider_call_id=call_id,
                capacity=cfg.elevenlabs_concurrency_units,
            )
            if not reserved:
                await accounting.abandon_call(call_id)
                raise ExternalWait("ElevenLabs Starter concurrency is full")
            state = await asyncio.to_thread(_audio_state, job_id)
        if state is None:
            raise RetryableError("audio transcription state was not persisted")
        if state["status"] == "failed":
            raise TerminalError(str(state.get("error") or "audio transcription failed"))
        if state["status"] == "submitting":
            submitted_at = state.get("submitted_at")
            if submitted_at is not None:
                age = datetime.now(timezone.utc) - submitted_at
                if age.total_seconds() < 12 * 60 * 60:
                    raise ExternalWait("waiting for the ElevenLabs webhook")
                await asyncio.to_thread(
                    _fail_audio,
                    state["id"],
                    "ElevenLabs submission could not be reconciled",
                    cleanup_requested=True,
                )
                raise TerminalError("ElevenLabs submission could not be reconciled")
            await asyncio.to_thread(_mark_audio_submitting, state["id"])
            try:
                source_url = await asyncio.to_thread(
                    blobstore.presign_get, blob_path, 60 * 60
                )
                provider_id = await asyncio.to_thread(
                    _submit_audio, state["id"], source_url
                )
            except ElevenLabsNotCalledError:
                await accounting.abandon_call(state["provider_call_id"])
                await asyncio.to_thread(_discard_audio, state["id"])
                raise
            except RetryableError:
                await asyncio.to_thread(_discard_audio, state["id"])
                await accounting.abandon_call(state["provider_call_id"])
                raise
            except ElevenLabsSubmissionUncertain:
                raise ExternalWait("waiting for the ElevenLabs webhook") from None
            except TerminalError as exc:
                await asyncio.to_thread(_fail_audio, state["id"], str(exc))
                await accounting.abandon_call(state["provider_call_id"])
                raise
            except (httpx.ConnectTimeout, httpx.ConnectError) as exc:
                await asyncio.to_thread(_discard_audio, state["id"])
                await accounting.abandon_call(state["provider_call_id"])
                raise RetryableError(
                    "ElevenLabs transcription is temporarily unavailable"
                ) from exc
            except (httpx.ReadTimeout, httpx.ReadError):
                raise ExternalWait("waiting for the ElevenLabs webhook") from None
            await asyncio.to_thread(_mark_audio_pending, state["id"], provider_id)
            raise ExternalWait("ElevenLabs is transcribing the audio")
        if state["status"] == "pending":
            provider_id = str(state.get("provider_transcription_id") or "")
            if provider_id:
                result = await asyncio.to_thread(_retrieve_audio, provider_id)
                if result is not None:
                    await asyncio.to_thread(_complete_audio, state["id"], result)
                    state = await asyncio.to_thread(_audio_state, job_id)
            if state is None or state["status"] != "completed":
                raise ExternalWait("ElevenLabs is transcribing the audio")
        response = state.get("result")
        if (
            not isinstance(response, dict)
            or not str(response.get("text") or "").strip()
        ):
            raise RetryableError("ElevenLabs returned an empty transcription")
        payload = _audio_artifact_payload(
            response,
            provider_call_id=state["provider_call_id"],
            billable_seconds=state["billable_seconds"],
            accounting_status="pending",
        )
        payload["duration"] = state["duration_seconds"]
        payload["creditMicrosPerSecond"] = state["credit_micros_per_second"]
        payload["providerTranscriptionId"] = state.get("provider_transcription_id")
        payload["audioTranscriptionId"] = state["id"]
        await asyncio.to_thread(_save_artifact, key, payload)
        await accounting.settle_units(
            call_id=state["provider_call_id"],
            kind=accounting.KIND_AUDIO,
            purpose="transcription",
            provider="elevenlabs",
            model="scribe_v2",
            units=state["billable_seconds"],
            unit="seconds",
            credit_micros=(
                state["billable_seconds"] * state["credit_micros_per_second"]
            ),
        )
        payload["accountingStatus"] = "settled"
        size = await asyncio.to_thread(_save_artifact, key, payload)
        await _delete_or_queue_provider_audio(
            str(state.get("provider_transcription_id") or ""), state["id"]
        )
        return str(payload["text"]), key, size


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
