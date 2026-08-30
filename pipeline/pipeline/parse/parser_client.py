"""Client for the persistent parse service on the ingest VM.

The worker downloads each source from B2 once. This client gives the parser a
relative key in their shared local spool, and the parser publishes its bundle
back to that volume atomically. The zip contains ``content_list.json``
(one entry per layout block, with page index and bounding box) plus the images
it extracted. That block list is what makes page-accurate citations and figure
captioning possible.

The live route supports Marker-only, selective RapidOCR, and all-page
RapidOCR. Unknown parse modes fail and each mode has a separate artifact
fingerprint.

Artifacts are addressed by a fingerprint over the source object, parse options,
route, parser version, and artifact schema. A retry, re-upload, or workspace
clone of the same document hits the cached zip instead of parsing again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any

import requests

from .. import obs
from ..config import cfg

log = logging.getLogger("evo.parse.client")

SOURCE_DESCRIPTOR_SCHEMA = "evo-local-source-v1"
ARTIFACT_SCHEMA = "evo-parser-bundle-v3"

ROUTE_FAST = "fast"

# Must match parser-vm/app.py. The implementation generation and exact release
# SHA form one identity, so rebuilt parser output cannot masquerade as an older
# artifact even when the source and parse mode are unchanged.
PARSER_IMPLEMENTATIONS = {ROUTE_FAST: "marker-2-vm-hybrid-v3"}
OFFICE_SUFFIXES = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})


class ParserClientError(RuntimeError):
    """The remote parser violated its request or artifact contract."""


class ParserHardTimeoutError(ParserClientError):
    """This exact parser fingerprint is quarantined after a hard timeout."""


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
        receipt_id=str(payload.get("_receipt_id") or ""),
    )


def parser_version(route: str) -> str:
    try:
        implementation = PARSER_IMPLEMENTATIONS[route]
    except KeyError:
        raise ParserClientError(f"unknown parse route {route!r}") from None
    return f"{implementation}+{cfg.release_sha}"


def _route(descriptor: Mapping[str, Any]) -> str:
    """The route the descriptor was built with.

    A missing route is a caller bug, not a request for the fast route: it would
    silently price and version the artifact against a parser nobody asked for.
    """
    return str(descriptor.get("route") or "")


def _endpoint() -> str:
    url = cfg.parser_url
    if not url:
        raise ParserClientError("PARSER_URL is not configured")
    return url


def source_descriptor(
    *, source_key: str, source_sha256: str, route: str
) -> dict[str, Any]:
    return {
        "schema": SOURCE_DESCRIPTOR_SCHEMA,
        "source_key": source_key,
        "source_sha256": source_sha256,
        "route": route,
    }


def artifact_identity(descriptor: Mapping[str, Any]) -> tuple[str, str]:
    route = _route(descriptor)
    version = parser_version(route)
    source_sha256 = str(descriptor.get("source_sha256") or "")
    identity = f"{source_sha256}:{cfg.parse_method}:{route}:{version}:{ARTIFACT_SCHEMA}"
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    return f"artifacts/{fingerprint}.zip", fingerprint


def _shared_path(key: str) -> Path:
    relative = PurePosixPath(key)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ParserClientError("invalid shared spool key")
    root = Path(cfg.parse_shared_dir).resolve()
    path = root.joinpath(*relative.parts).resolve()
    if path == root or root not in path.parents:
        raise ParserClientError("invalid shared spool key")
    return path


def _artifact_receipt(path: Path, fingerprint: str, request_id: str) -> dict[str, Any]:
    if not request_id:
        return {}
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("manifest.json")
            if info.file_size <= 0 or info.file_size > 64 << 10:
                return {}
            manifest = json.loads(archive.read(info))
    except (KeyError, OSError, ValueError, zipfile.BadZipFile):
        return {}
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != ARTIFACT_SCHEMA
        or manifest.get("source_fingerprint") != fingerprint
    ):
        return {}
    receipt = manifest.get("parse_receipt")
    if (
        not isinstance(receipt, dict)
        or receipt.get("id") != fingerprint
        or receipt.get("request_id") != request_id
        or not isinstance(receipt.get("measurements"), dict)
    ):
        return {}
    return {"_receipt_id": fingerprint, **receipt["measurements"]}


def _local_artifact(
    key: str, fingerprint: str, request_id: str
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    path = _shared_path(key)
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return None
    if size <= 0 or size > cfg.parse_artifact_max_bytes:
        log.warning(
            "discarding invalid local parse artifact key=%s bytes=%s", key, size
        )
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return None
    digest = _sha256_file(path)
    try:
        path.touch()
    except OSError:
        log.debug("could not touch local parse artifact %s", key, exc_info=True)
    return (
        {
            "key": key,
            "size": size,
            "sha256": digest,
            "fingerprint": fingerprint,
            "cached": True,
        },
        _artifact_receipt(path, fingerprint, request_id),
    )


def _local_quarantine(fingerprint: str) -> str:
    path = _shared_path(f"quarantine/{fingerprint}.json")
    try:
        value = json.loads(path.read_bytes())
    except (FileNotFoundError, OSError, ValueError):
        return ""
    if (
        not isinstance(value, dict)
        or value.get("reason") != "parse_hard_timeout"
        or value.get("source_fingerprint") != fingerprint
        or value.get("parser_version") != parser_version(ROUTE_FAST)
    ):
        return ""
    return str(value.get("detail") or "parse exceeded its hard deadline")


def _request_artifact(
    descriptor: Mapping[str, Any], upload_name: str, request_id: str
) -> dict[str, Any]:
    """Ensure the parsed artifact exists in the shared spool.

    Isolated from unzipping so tests can record/replay this single network call —
    the only expensive, non-deterministic step. See pipeline/tests/README.md.
    """
    route = _route(descriptor)
    version = parser_version(route)

    artifact_key, fingerprint = artifact_identity(descriptor)
    if detail := _local_quarantine(fingerprint):
        raise ParserHardTimeoutError(detail)
    cached = _local_artifact(artifact_key, fingerprint, request_id)
    if cached is not None:
        artifact, receipt = cached
        _record_measurement(receipt)
        log.info(
            "parse artifact cache hit key=%s bytes=%s", artifact_key, artifact["size"]
        )
        return artifact
    endpoint = _endpoint()

    headers = {"Content-Type": "application/json"}
    # Forward the trace so parser logs can be lined up with the ingest job.
    headers.update(obs.outbound_headers())
    if cfg.parser_token:
        headers["Authorization"] = f"Bearer {cfg.parser_token}"
    try:
        resp = requests.post(
            endpoint,
            headers=headers,
            json={
                "source_key": str(descriptor["source_key"]),
                "source_sha256": str(descriptor["source_sha256"]),
                "output_key": artifact_key,
                "filename": upload_name,
                "parse_method": cfg.parse_method,
                "artifact_schema": ARTIFACT_SCHEMA,
                "parser_version": version,
                "source_fingerprint": fingerprint,
                "request_id": request_id,
            },
            timeout=cfg.parser_timeout,
        )
    except requests.RequestException:
        # The parser publishes before sending JSON. If the connection died
        # after that atomic rename, recover the creator-owned receipt now —
        # especially on the job's final allowed attempt.
        recovered = _local_artifact(artifact_key, fingerprint, request_id)
        if recovered is None:
            raise
        artifact, receipt = recovered
        _record_measurement(receipt)
        return artifact
    try:
        payload = resp.json()
    except (TypeError, ValueError):
        payload = None
    _record_measurement(payload)
    if resp.status_code >= 300:
        detail = payload.get("detail") if isinstance(payload, dict) else resp.text[:500]
        if (
            resp.status_code == 422
            and isinstance(payload, dict)
            and payload.get("code") == "parse_hard_timeout"
        ):
            raise ParserHardTimeoutError(str(detail))
        raise ParserClientError(f"remote parse {resp.status_code}: {detail}")
    if not isinstance(payload, dict):
        raise ParserClientError("parser returned an invalid JSON response")
    artifact = payload.get("artifact") or {}
    if artifact.get("key") != artifact_key:
        raise ParserClientError("parser returned an unexpected artifact key")
    try:
        artifact_size = int(artifact.get("size") or 0)
    except (TypeError, ValueError) as exc:
        raise ParserClientError("parser returned an invalid artifact size") from exc
    if artifact_size <= 0 or artifact_size > cfg.parse_artifact_max_bytes:
        raise ParserClientError("parser artifact exceeds configured byte limit")
    if not str(artifact.get("sha256") or ""):
        raise ParserClientError("parser returned no artifact checksum")
    artifact["fingerprint"] = fingerprint
    # Wall time remains useful for latency. The charge uses page counts, and
    # _worker_cpu_ms is the dedicated Marker child process's actual CPU time.
    parse_seconds = payload.get("_server_parse_s")
    log.info(
        "parser published %s local artifact key=%s bytes=%s parse_s=%s cpu_ms=%s pages=%s ocr_pages=%s queue_ms=%s",
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


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _entry_limit(info: zipfile.ZipInfo) -> int:
    if info.filename == "content_list.json":
        return min(cfg.parse_artifact_max_entry_bytes, cfg.parse_content_max_bytes)
    if info.filename == "manifest.json":
        return min(cfg.parse_artifact_max_entry_bytes, 64 << 10)
    if info.filename == "preview.pdf":
        return min(cfg.parse_artifact_max_entry_bytes, cfg.office_preview_max_bytes)
    if info.filename.startswith("images/"):
        return min(cfg.parse_artifact_max_entry_bytes, cfg.parse_image_max_bytes)
    return cfg.parse_artifact_max_entry_bytes


def _validated_entries(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    infos = archive.infolist()
    if len(infos) > cfg.parse_artifact_max_entries:
        raise ParserClientError("parsed artifact contains too many entries")
    names = [info.filename for info in infos]
    if len(names) != len(set(names)):
        raise ParserClientError("parsed artifact contains duplicate entries")
    if "manifest.json" not in names or "content_list.json" not in names:
        raise ParserClientError(
            "parsed artifact is missing its manifest or content list"
        )

    expanded = 0
    image_bytes = 0
    for info in infos:
        path = PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts:
            raise ParserClientError("unsafe path in parsed artifact")
        if info.flag_bits & 0x1:
            raise ParserClientError("encrypted parsed artifact entries are unsupported")
        if info.is_dir():
            continue
        if info.file_size < 0 or info.file_size > _entry_limit(info):
            raise ParserClientError(
                "parsed artifact entry exceeds configured byte limit"
            )
        expanded += info.file_size
        if expanded > cfg.parse_artifact_max_expanded_bytes:
            raise ParserClientError(
                "parsed artifact expands beyond configured byte limit"
            )
        if info.filename.startswith("images/"):
            image_bytes += info.file_size
            if image_bytes > cfg.parse_images_max_bytes:
                raise ParserClientError(
                    "parsed artifact images exceed configured byte limit"
                )
    return infos


def _read_entry(
    archive: zipfile.ZipFile, info: zipfile.ZipInfo, destination: Path
) -> None:
    limit = _entry_limit(info)
    written = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(info) as src, destination.open("wb") as dst:
        while chunk := src.read(min(1024 * 1024, limit - written + 1)):
            written += len(chunk)
            if written > limit:
                raise ParserClientError(
                    "parsed artifact entry exceeds configured byte limit"
                )
            dst.write(chunk)


def _extract(
    artifact: Mapping[str, Any],
    raw_dir: Path,
    version: str,
    *,
    require_office_preview: bool = False,
) -> None:
    try:
        declared_size = int(artifact.get("size") or 0)
    except (TypeError, ValueError) as exc:
        raise ParserClientError("parsed artifact has an invalid size") from exc
    if declared_size <= 0 or declared_size > cfg.parse_artifact_max_bytes:
        raise ParserClientError("parsed artifact exceeds configured byte limit")
    archive_path = _shared_path(str(artifact["key"]))
    try:
        actual_size = archive_path.stat().st_size
    except FileNotFoundError as exc:
        raise ParserClientError("parsed artifact is missing from shared spool") from exc
    if actual_size != declared_size:
        raise ParserClientError("parsed artifact size mismatch")
    digest = _sha256_file(archive_path)
    expected = str(artifact.get("sha256") or "")
    if not expected or digest != expected:
        raise ParserClientError("parsed artifact checksum mismatch")
    with zipfile.ZipFile(archive_path) as archive:
        infos = _validated_entries(archive)
        manifest_info = archive.getinfo("manifest.json")
        _read_entry(archive, manifest_info, raw_dir / "manifest.json")
        manifest = json.loads((raw_dir / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("schema") != ARTIFACT_SCHEMA:
            raise ParserClientError("unsupported parsed artifact schema")
        if manifest.get("parser_version") != version:
            raise ParserClientError("parsed artifact version mismatch")
        fingerprint = str(artifact.get("fingerprint") or "")
        if fingerprint and manifest.get("source_fingerprint") != fingerprint:
            raise ParserClientError("parsed artifact source mismatch")
        for info in infos:
            if info.is_dir():
                continue
            path = PurePosixPath(info.filename)
            destination = raw_dir.joinpath(*path.parts)
            if destination == raw_dir / "manifest.json":
                continue
            _read_entry(archive, info, destination)
    if require_office_preview:
        preview = raw_dir / "preview.pdf"
        if not preview.is_file():
            raise ParserClientError("Office parse artifact is missing preview.pdf")
        with preview.open("rb") as handle:
            if handle.read(4) != b"%PDF":
                raise ParserClientError("Office parse artifact is missing preview.pdf")


def parse_to_bundle(
    descriptor: Mapping[str, Any],
    upload_name: str,
    raw_dir: Path,
    require_office_preview: bool | None = None,
    request_id: str = "",
) -> tuple[list[dict[str, Any]], str, str]:
    """Parse one source and return ``(content_list, artifact_key, fingerprint)``.

    Blocking (requests + file IO); call via ``asyncio.to_thread``.
    """
    version = parser_version(_route(descriptor))
    if not request_id:
        raise ParserClientError("parser request id is required")
    if require_office_preview is None:
        require_office_preview = Path(upload_name).suffix.lower() in OFFICE_SUFFIXES
    raw_dir.mkdir(parents=True, exist_ok=True)
    artifact = _request_artifact(descriptor, upload_name, request_id)
    try:
        _extract(
            artifact,
            raw_dir,
            version,
            require_office_preview=require_office_preview,
        )
    except Exception:
        if not artifact.get("cached"):
            raise
        # A cached artifact that will not open is worse than no cache: every
        # retry would fail the same way until someone deletes it by hand.
        log.warning("discarding corrupt cached parse artifact %s", artifact["key"])
        try:
            _shared_path(str(artifact["key"])).unlink()
        except FileNotFoundError:
            pass
        shutil.rmtree(raw_dir, ignore_errors=True)
        raw_dir.mkdir(parents=True, exist_ok=True)
        artifact = _request_artifact(descriptor, upload_name, request_id)
        _extract(
            artifact,
            raw_dir,
            version,
            require_office_preview=require_office_preview,
        )

    content_path = raw_dir / "content_list.json"
    if content_path.stat().st_size > cfg.parse_content_max_bytes:
        raise ParserClientError("content_list.json exceeds configured byte limit")
    content_list = json.loads(content_path.read_text(encoding="utf-8"))
    if not isinstance(content_list, list):
        raise ParserClientError("content_list.json is not a list of blocks")
    if len(content_list) > cfg.parse_content_max_blocks:
        raise ParserClientError("content_list.json contains too many blocks")
    return content_list, str(artifact["key"]), str(artifact.get("fingerprint") or "")


def sweep_local_spool() -> dict[str, int]:
    """Delete abandoned sources and expired local parse bundles."""
    now = time.time()
    removed = {"sources": 0, "artifacts": 0}
    policies = (
        ("sources", cfg.parse_source_ttl_hours * 60 * 60),
        ("artifacts", cfg.parse_zip_ttl_hours * 60 * 60),
    )
    root = Path(cfg.parse_shared_dir).resolve()
    for directory_name, ttl_s in policies:
        directory = root / directory_name
        try:
            entries = tuple(directory.iterdir())
        except FileNotFoundError:
            continue
        for path in entries:
            try:
                if not path.is_file() or now - path.stat().st_mtime < ttl_s:
                    continue
                path.unlink()
                removed[directory_name] += 1
            except FileNotFoundError:
                continue
            except OSError:
                log.warning("could not sweep local spool file %s", path, exc_info=True)
    return removed
