"""Client for the persistent remote parse service.

The service never receives document bytes from this process: it is handed a
presigned GET for the source and a presigned PUT for the result, and it streams
between them. What comes back is a zip containing ``content_list.json``
(one entry per layout block, with page index and bounding box) plus the images
it extracted. That block list is what makes page-accurate citations and figure
captioning possible.

The live route supports Marker-only, selective RapidOCR, and all-page
RapidOCR. Unknown parse modes fail and each mode has a separate artifact
fingerprint.

Artifacts are addressed by a fingerprint over (source object, etag, size, parse
options, route, parser version). Re-ingesting the same document — a retry, a
re-upload, a cloned workspace — hits the cached zip instead of Modal.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any

import requests

from .. import obs
from ..config import cfg
from ..store import blobstore

log = logging.getLogger("evo.parse.modal")

SOURCE_DESCRIPTOR_SCHEMA = "evo-b2-source-v1"
ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"

ROUTE_FAST = "fast"

# Must match the constants in modal/parse_common.py: the service rejects a request
# whose parser_version it does not serve, so a version bump on either side fails
# loudly instead of writing a bundle nobody can read back.
PARSER_VERSIONS = {ROUTE_FAST: "marker-2-vm-hybrid-v2"}


class ModalParseError(RuntimeError):
    """Compatibility name for a remote parser contract failure."""


def _record_measurement(payload: object) -> None:
    if not isinstance(payload, dict):
        return
    pages = max(0, int(payload.get("_page_count") or 0))
    ocr_pages = max(0, int(payload.get("_ocr_page_count") or 0))
    cpu_milliseconds = max(0, int(payload.get("_worker_cpu_ms") or 0))
    elapsed_milliseconds = max(0, int(payload.get("_server_parse_ms") or 0))
    if not (pages or cpu_milliseconds or elapsed_milliseconds):
        return
    obs.record_parse_usage(
        pages=pages,
        ocr_pages=ocr_pages,
        cpu_milliseconds=cpu_milliseconds,
        elapsed_milliseconds=elapsed_milliseconds,
        queue_milliseconds=max(0, int(payload.get("_queue_ms") or 0)),
        download_milliseconds=max(0, int(payload.get("_download_ms") or 0)),
        upload_milliseconds=max(0, int(payload.get("_upload_ms") or 0)),
        worker_rss_bytes=max(0, int(payload.get("_worker_rss_bytes") or 0)),
        worker_pss_bytes=max(0, int(payload.get("_worker_pss_bytes") or 0)),
        io_read_bytes=max(0, int(payload.get("_worker_io_read_bytes") or 0)),
        io_write_bytes=max(0, int(payload.get("_worker_io_write_bytes") or 0)),
        method=str(payload.get("_parse_method") or ""),
        source_format=str(payload.get("_source_format") or ""),
    )


def parser_version(route: str) -> str:
    try:
        return PARSER_VERSIONS[route]
    except KeyError:
        raise ModalParseError(f"unknown parse route {route!r}") from None


def _route(descriptor: Mapping[str, Any]) -> str:
    """The route the descriptor was built with.

    A missing route is a caller bug, not a request for the fast route: it would
    silently price and version the artifact against a parser nobody asked for.
    """
    return str(descriptor.get("route") or "")


def _endpoint() -> str:
    url = cfg.parser_url
    if not url:
        raise ModalParseError("PARSER_URL is not configured")
    return url


def source_descriptor(
    *, blob_path: str, source_sha256: str, route: str
) -> dict[str, Any]:
    return {
        "schema": SOURCE_DESCRIPTOR_SCHEMA,
        "blob_path": blob_path,
        "source_sha256": source_sha256,
        "route": route,
    }


def artifact_identity(descriptor: Mapping[str, Any]) -> tuple[str, str]:
    route = _route(descriptor)
    version = parser_version(route)
    source_sha256 = str(descriptor.get("source_sha256") or "")
    identity = f"{source_sha256}:{cfg.parse_method}:{route}:{version}"
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    return f"parsed/{source_sha256}/{version}/{fingerprint}.zip", fingerprint


def _request_artifact(
    descriptor: Mapping[str, Any], upload_name: str
) -> dict[str, Any]:
    """Ensure the parsed artifact exists in B2 and return its descriptor.

    Isolated from unzipping so tests can record/replay this single network call —
    the only expensive, non-deterministic step. See pipeline/tests/README.md.
    """
    route = _route(descriptor)
    version = parser_version(route)
    endpoint = _endpoint()

    artifact_key, fingerprint = artifact_identity(descriptor)
    cached = blobstore.object_info(artifact_key)
    if cached is not None:
        log.info(
            "parse artifact cache hit key=%s bytes=%s", artifact_key, cached["size"]
        )
        return {
            "key": artifact_key,
            "size": cached["size"],
            "etag": cached["etag"],
            "fingerprint": fingerprint,
            "cached": True,
        }

    headers = {"Content-Type": "application/json"}
    # Forward the trace so parser logs can be lined up with the ingest job.
    headers.update(obs.outbound_headers())
    if cfg.parser_token:
        headers["Authorization"] = f"Bearer {cfg.parser_token}"
    resp = requests.post(
        endpoint,
        headers=headers,
        json={
            "source_url": blobstore.presign_get(str(descriptor["blob_path"])),
            "output_url": blobstore.presign_put(artifact_key, "application/zip"),
            "output_key": artifact_key,
            "filename": upload_name,
            "parse_method": cfg.parse_method,
            "artifact_schema": ARTIFACT_SCHEMA,
            "parser_version": version,
            "source_fingerprint": fingerprint,
        },
        timeout=cfg.parser_timeout,
    )
    try:
        payload = resp.json()
    except (TypeError, ValueError):
        payload = None
    _record_measurement(payload)
    if resp.status_code >= 300:
        detail = payload.get("detail") if isinstance(payload, dict) else resp.text[:500]
        raise ModalParseError(f"remote parse {resp.status_code}: {detail}")
    if not isinstance(payload, dict):
        raise ModalParseError("parser returned an invalid JSON response")
    artifact = payload.get("artifact") or {}
    if artifact.get("key") != artifact_key:
        raise ModalParseError("parser returned an unexpected artifact key")
    artifact["fingerprint"] = fingerprint
    # Wall time remains useful for latency. The charge uses page counts, and
    # _worker_cpu_ms is the dedicated Marker child process's actual CPU time.
    parse_seconds = payload.get("_server_parse_s")
    log.info(
        "parser published %s artifact key=%s bytes=%s parse_s=%s cpu_ms=%s pages=%s ocr_pages=%s queue_ms=%s",
        route,
        artifact_key,
        artifact.get("size"),
        parse_seconds,
        payload.get("_worker_cpu_ms"),
        payload.get("_page_count"),
        payload.get("_ocr_page_count"),
        payload.get("_queue_ms"),
    )
    return artifact


def _extract(artifact: Mapping[str, Any], raw_dir: Path, version: str) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix="evo_parse_", suffix=".zip")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        blobstore.download_to(str(artifact["key"]), tmp)
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        expected = str(artifact.get("sha256") or "")
        if expected and digest != expected:
            raise ModalParseError("parsed artifact checksum mismatch")
        with zipfile.ZipFile(tmp) as archive:
            names = set(archive.namelist())
            if "manifest.json" not in names or "content_list.json" not in names:
                raise ModalParseError(
                    "parsed artifact is missing its manifest or content list"
                )
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("schema") != ARTIFACT_SCHEMA:
                raise ModalParseError("unsupported parsed artifact schema")
            if manifest.get("parser_version") != version:
                raise ModalParseError("parsed artifact version mismatch")
            fingerprint = str(artifact.get("fingerprint") or "")
            if fingerprint and manifest.get("source_fingerprint") != fingerprint:
                raise ModalParseError("parsed artifact source mismatch")
            for info in archive.infolist():
                path = PurePosixPath(info.filename)
                if path.is_absolute() or ".." in path.parts:
                    raise ModalParseError("unsafe path in parsed artifact")
                if info.is_dir():
                    continue
                destination = raw_dir.joinpath(*path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as src, destination.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def parse_to_bundle(
    descriptor: Mapping[str, Any], upload_name: str, raw_dir: Path
) -> tuple[list[dict[str, Any]], str, str]:
    """Parse one source and return ``(content_list, artifact_key, fingerprint)``.

    Blocking (requests + file IO); call via ``asyncio.to_thread``.
    """
    version = parser_version(_route(descriptor))
    raw_dir.mkdir(parents=True, exist_ok=True)
    artifact = _request_artifact(descriptor, upload_name)
    try:
        _extract(artifact, raw_dir, version)
    except Exception:
        if not artifact.get("cached"):
            raise
        # A cached artifact that will not open is worse than no cache: every
        # retry would fail the same way until someone deletes it by hand.
        log.warning("discarding corrupt cached parse artifact %s", artifact["key"])
        blobstore.delete(str(artifact["key"]))
        shutil.rmtree(raw_dir, ignore_errors=True)
        raw_dir.mkdir(parents=True, exist_ok=True)
        artifact = _request_artifact(descriptor, upload_name)
        _extract(artifact, raw_dir, version)

    content_list = json.loads(
        (raw_dir / "content_list.json").read_text(encoding="utf-8")
    )
    if not isinstance(content_list, list):
        raise ModalParseError("content_list.json is not a list of blocks")
    return content_list, str(artifact["key"]), str(artifact.get("fingerprint") or "")
