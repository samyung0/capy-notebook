"""capture_page: render a cited source page, or a box on it, for the chat model.

The pixels have to be inside the provider request the agent builds mid-turn,
so the retrieval host keeps a size-bounded copy of each source PDF (keyed by
the stored object's path) and renders with PyMuPDF. Office sources convert temporarily through the parser queue; text and store-only sources have no
page model and refuse. The JPEG rides in a user message placed after the tool
results of its step, because chat-completions tool messages carry text only.
Images live on the turn's ``ToolContext`` and are never persisted.

``capture_knowledge_page`` renders a library book the same way, from the
knowledge-base bucket and keyed in the same cache by its object key.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import math
import os
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

from ..config import cfg
from ..store import blobstore
from . import store

log = logging.getLogger("capy.retrieval.capture")

JPEG_QUALITY = 80


class CaptureUnavailable(Exception):
    """The file has no page-addressable PDF or its bytes cannot be read."""

    def __init__(self, message: str, code: str = "unsupported_format") -> None:
        super().__init__(message)
        self.code = code


def patch_tokens(width: int, height: int) -> int:
    """Image tokens on a 28-pixel patch grid (GLM, Qwen); shown in telemetry."""
    return -(-width // 28) * -(-height // 28)


# ------------------------------------------------------------------ PDF cache


def _cache_dir() -> Path:
    path = Path(cfg.capture_cache_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _evict(cache: Path, budget: int) -> None:
    """Least recently used first, until the directory fits the byte budget."""
    files = [p for p in cache.glob("*.pdf") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    for path in sorted(files, key=lambda p: p.stat().st_atime):
        if total <= budget:
            break
        try:
            total -= path.stat().st_size
            path.unlink()
        except OSError:
            log.debug("could not evict capture cache file %s", path, exc_info=True)


def _download(blob_path: str, target: Path, max_bytes: int, download=None) -> None:
    cache = target.parent
    fd, temporary = tempfile.mkstemp(prefix=".", suffix=".part", dir=cache)
    os.close(fd)
    try:
        downloaded = (download or blobstore.download_file)(
            blob_path, temporary, max_bytes
        )
        if downloaded is None:
            raise CaptureUnavailable(
                "the source object is missing", "unavailable_target"
            )
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    _evict(cache, cfg.capture_cache_max_bytes)


def cache_name(blob_path: str) -> str:
    """Cache file for one stored object. Keyed by the blob path, not the source
    SHA, so a replaced source cannot reuse a stale rendering."""
    return hashlib.sha256(blob_path.encode("utf-8")).hexdigest() + ".pdf"


async def pdf_path(workspace_id: str, file_id: str) -> Path:
    """The local PDF for ``file_id``, downloaded once per stored object."""
    row = await store.file_page_source(workspace_id, file_id)
    if row is None:
        raise CaptureUnavailable("the file is not available", "unavailable_target")
    if row.get("kind") != "pdf" or row.get("parse_mode") == "none":
        raise CaptureUnavailable("this source has no retained PDF")
    blob = str(row.get("blob_path") or "")
    if not blob:
        raise CaptureUnavailable("the source has no stored bytes", "unavailable_target")
    target = _cache_dir() / cache_name(blob)
    if target.is_file():
        os.utime(target)
        return target
    max_bytes = int(row.get("size_bytes") or 0)
    await asyncio.to_thread(_download, blob, target, max_bytes)
    return target


async def knowledge_pdf_path(object_key: str, max_bytes: int) -> Path:
    """The local copy of a library book, downloaded once per object key."""
    if not object_key:
        raise CaptureUnavailable(
            "this book has no stored PDF in the knowledge-base bucket",
            "unavailable_target",
        )
    target = _cache_dir() / cache_name(object_key)
    if target.is_file():
        os.utime(target)
        return target
    await asyncio.to_thread(
        _download, object_key, target, max_bytes, blobstore.library_download_file
    )
    return target


async def render_knowledge(
    object_key: str, max_bytes: int, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    pdf = await knowledge_pdf_path(object_key, max_bytes)
    return await asyncio.to_thread(render, pdf, page, bbox, max_edge)


def _office_capture(
    row: dict, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    if not cfg.parser_url:
        raise CaptureUnavailable(
            "the Office converter is unavailable", "unavailable_target"
        )
    endpoint = urlsplit(cfg.parser_url)
    url = urlunsplit((endpoint.scheme, endpoint.netloc, "/capture_page", "", ""))
    headers = (
        {"Authorization": f"Bearer {cfg.parser_token}"} if cfg.parser_token else {}
    )
    try:
        with tempfile.TemporaryDirectory(prefix="capy-office-capture-") as directory:
            source = Path(directory) / "source"
            downloaded = blobstore.download_file(
                str(row["blob_path"]), str(source), int(row["size_bytes"])
            )
            if (
                downloaded is None
                or downloaded[0] != int(row["size_bytes"])
                or (row.get("source_sha256") and downloaded[1] != row["source_sha256"])
            ):
                raise CaptureUnavailable(
                    "the source bytes are unavailable", "unavailable_target"
                )
            with (
                source.open("rb") as handle,
                requests.post(
                    url,
                    headers=headers,
                    files={
                        "file": (str(row["name"]), handle, "application/octet-stream")
                    },
                    data={
                        "filename": row["name"],
                        "page": str(page),
                        "bbox": json.dumps(bbox),
                        "max_edge": str(max_edge),
                    },
                    timeout=cfg.parser_timeout,
                    stream=True,
                ) as response,
            ):
                response.raise_for_status()
                body = bytearray()
                for chunk in response.iter_content(64 << 10):
                    body.extend(chunk)
                    if len(body) > 8 << 20:
                        raise CaptureUnavailable("the capture exceeds its byte limit")
                result = json.loads(body)
        jpeg = base64.b64decode(result["jpeg"], validate=True)
        box, size = result["box"], result["size"]
        if (
            not jpeg.startswith(b"\xff\xd8")
            or not isinstance(box, list)
            or len(box) != 4
            or any(
                type(v) not in (int, float)
                or not math.isfinite(v)
                or not 0 <= v <= 1000
                for v in box
            )
            or box[0] >= box[2]
            or box[1] >= box[3]
            or not isinstance(size, list)
            or len(size) != 2
            or not all(type(v) is int and 0 < v <= max_edge + 1 for v in size)
        ):
            raise ValueError("invalid capture dimensions")
        return jpeg, box, (size[0], size[1])
    except (requests.RequestException, OSError, ValueError, KeyError, TypeError) as exc:
        raise CaptureUnavailable(
            "the temporary Office capture could not be rendered", "unavailable_target"
        ) from exc


async def render_file(
    workspace_id: str, file_id: str, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    row = await store.file_page_source(workspace_id, file_id)
    if row is None:
        raise CaptureUnavailable("the file is not available", "unavailable_target")
    office_format = {"doc": "docx", "sheet": "xlsx", "slides": "pptx"}.get(
        row.get("kind")
    )
    if (
        office_format
        and row.get("ever_parsed_successfully")
        and row.get("parse_mode") != "none"
    ):
        if not row.get("blob_path"):
            raise CaptureUnavailable(
                "the source has no stored bytes", "unavailable_target"
            )
        return await asyncio.to_thread(
            _office_capture,
            {**row, "name": f"source.{office_format}"},
            page,
            bbox,
            max_edge,
        )
    pdf = await pdf_path(workspace_id, file_id)
    return await asyncio.to_thread(render, pdf, page, bbox, max_edge)


# --------------------------------------------------------------------- render


def render(
    pdf: Path, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    """JPEG of the page or box, the box actually rendered on the 0-1000 grid,
    and the pixel size."""
    import pymupdf

    with pymupdf.open(pdf) as doc:
        if not 1 <= page <= len(doc):
            raise ValueError(f"page must be between 1 and {len(doc)}")
        pg = doc[page - 1]
        rect = pg.rect
        if bbox:
            x0, y0, x1, y1 = bbox
            if not (x0 < x1 and y0 < y1):
                raise ValueError(
                    "bbox must be [x0, y0, x1, y1] with x0 < x1 and y0 < y1"
                )
            clip = pymupdf.Rect(
                rect.x0 + rect.width * x0 / 1000,
                rect.y0 + rect.height * y0 / 1000,
                rect.x0 + rect.width * x1 / 1000,
                rect.y0 + rect.height * y1 / 1000,
            )
        else:
            clip, bbox = rect, [0, 0, 1000, 1000]
        scale = max_edge / max(clip.width, clip.height)
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
    from PIL import Image

    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue(), [float(v) for v in bbox], (pix.width, pix.height)


def data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()


# ------------------------------------------------------------- image transport


def image_part(url: str, provider_slug: str) -> dict[str, Any]:
    if provider_slug == "anthropic":
        header, data = url.split(",", 1)
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": header[5:].split(";")[0],
                "data": data,
            },
        }
    return {"type": "image_url", "image_url": {"url": url}}


def inject_images(
    messages: list[dict[str, Any]],
    images: dict[str, tuple[str, str]],
    provider_slug: str = "",
) -> list[dict[str, Any]]:
    """Attach captured images after the tool-result block that produced them.

    Every tool result of one assistant step must stay contiguous, so the images
    ride in one user message placed after the last tool message of that step.
    """
    if not images:
        return messages
    out: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []
    for i, message in enumerate(messages):
        out.append(message)
        if message.get("role") == "tool" and message.get("tool_call_id") in images:
            pending.append(images[message["tool_call_id"]])
        following = messages[i + 1] if i + 1 < len(messages) else None
        if pending and (following is None or following.get("role") != "tool"):
            content: list[dict[str, Any]] = [
                {"type": "text", "text": "Images from the capture_page calls above:"}
            ]
            for label, url in pending:
                content.append({"type": "text", "text": label})
                content.append(image_part(url, provider_slug))
            out.append({"role": "user", "content": content})
            pending = []
    return out


def _image_bytes(part: dict[str, Any]) -> bytes | None:
    """The encoded image of an ``image_url`` (data URL) or Anthropic ``image`` part."""
    if part.get("type") == "image_url":
        url = str((part.get("image_url") or {}).get("url") or "")
        if url.startswith("data:") and "," in url:
            return base64.b64decode(url.split(",", 1)[1], validate=False)
        return None
    if part.get("type") == "image":
        data = (part.get("source") or {}).get("data")
        return base64.b64decode(data, validate=False) if isinstance(data, str) else None
    return None


def split_images(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Messages without their image parts, plus the images' token estimate.

    Context telemetry and the compaction budget count tokens from the JSON
    text; a base64 JPEG would count as ~100k of them. Images are measured as
    :func:`patch_tokens` of their pixel size instead.
    """
    from PIL import Image

    out: list[dict[str, Any]] = []
    tokens = 0
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list) or not any(
            isinstance(p, dict) and p.get("type") in ("image_url", "image")
            for p in content
        ):
            out.append(message)
            continue
        kept = []
        for part in content:
            data = _image_bytes(part) if isinstance(part, dict) else None
            if data is None:
                kept.append(part)
                continue
            try:
                with Image.open(io.BytesIO(data)) as image:
                    width, height = image.size
            except (OSError, ValueError):
                # Not an image PIL can read: measured as the text it is.
                kept.append(part)
                continue
            tokens += patch_tokens(width, height)
        out.append({**message, "content": kept})
    return out, tokens


def image_tokens(
    captures: list[dict[str, Any]], messages: list[dict[str, Any]] | None = None
) -> int:
    """Tokens the turn's captures add to the next request.

    A capture rides after its tool result, so once live compaction folds that
    exchange into the turn note the image leaves the request. Only captures
    whose tool result is still in ``messages`` count; no ``messages`` counts all.
    """
    if messages is not None:
        live = {m.get("tool_call_id") for m in messages if m.get("role") == "tool"}
        captures = [record for record in captures if record["callId"] in live]
    return sum(int(record["estimatedImageTokens"]) for record in captures)


def record(
    *,
    call_id: str,
    file_id: str,
    page: int,
    box: list[float],
    jpeg: bytes,
    size: tuple[int, int],
    started: float,
) -> dict[str, Any]:
    width, height = size
    return {
        "callId": call_id,
        "fileId": file_id,
        "page": page,
        "bbox": [int(v) for v in box],
        "bytes": len(jpeg),
        "pixels": [width, height],
        "estimatedImageTokens": patch_tokens(width, height),
        "elapsedMs": round((time.perf_counter() - started) * 1000),
    }
