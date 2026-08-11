"""Client for the Modal-hosted MinerU GPU parse service ('advanced' mode).

The service never receives document bytes from this process: it is handed a
presigned GET for the source and a presigned PUT for the result, and it streams
between them. What comes back is a zip containing MinerU's ``content_list.json``
(one entry per layout block, with page index and bounding box) plus the images
it extracted. That block list is what makes page-accurate citations possible, so
this is the only parse route that produces them.

Artifacts are addressed by a fingerprint over (source object, etag, size, parse
options, parser version). Re-ingesting the same document — a retry, a re-upload,
a cloned workspace — hits the cached zip instead of the GPU.
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

from ..config import cfg
from ..store import blobstore

log = logging.getLogger("evo.parse.modal")

SOURCE_DESCRIPTOR_SCHEMA = "evo-b2-source-v1"
ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
PARSER_VERSION = "mineru-3.4-hybrid-v1"


class ModalParseError(RuntimeError):
    pass


def source_descriptor(
    *, blob_path: str, file_id: str, source_etag: str, source_size: int
) -> dict[str, Any]:
    return {
        "schema": SOURCE_DESCRIPTOR_SCHEMA,
        "blob_path": blob_path,
        "file_id": file_id,
        "source_etag": source_etag,
        "source_size": source_size,
    }


def artifact_identity(descriptor: Mapping[str, Any]) -> tuple[str, str]:
    identity = ":".join(
        [
            str(descriptor.get("blob_path") or ""),
            str(descriptor.get("source_etag") or ""),
            str(descriptor.get("source_size") or ""),
            cfg.parse_method,
            PARSER_VERSION,
        ]
    )
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    file_id = str(descriptor.get("file_id") or "unknown")
    return f"parsed/{file_id}/{PARSER_VERSION}/{fingerprint}.zip", fingerprint


def _request_artifact(
    descriptor: Mapping[str, Any], upload_name: str
) -> dict[str, Any]:
    """Ensure the parsed artifact exists in B2 and return its descriptor.

    Isolated from unzipping so tests can record/replay this single network call —
    the only expensive, non-deterministic step. See pipeline/tests/README.md.
    """
    if not cfg.modal_parse_url:
        raise ModalParseError("MODAL_PARSE_URL is not configured")

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
    if cfg.modal_parse_token:
        headers["Authorization"] = f"Bearer {cfg.modal_parse_token}"
    resp = requests.post(
        cfg.modal_parse_url,
        headers=headers,
        json={
            "source_url": blobstore.presign_get(str(descriptor["blob_path"])),
            "output_url": blobstore.presign_put(artifact_key, "application/zip"),
            "output_key": artifact_key,
            "filename": upload_name,
            "parse_method": cfg.parse_method,
            "artifact_schema": ARTIFACT_SCHEMA,
            "parser_version": PARSER_VERSION,
            "source_fingerprint": fingerprint,
        },
        timeout=cfg.modal_parse_timeout,
    )
    if resp.status_code >= 300:
        raise ModalParseError(f"modal parse {resp.status_code}: {resp.text[:500]}")
    payload = resp.json()
    artifact = payload.get("artifact") or {}
    if artifact.get("key") != artifact_key:
        raise ModalParseError("modal returned an unexpected artifact key")
    artifact["fingerprint"] = fingerprint
    log.info(
        "modal published parse artifact key=%s bytes=%s parse_s=%s",
        artifact_key,
        artifact.get("size"),
        payload.get("_server_parse_s"),
    )
    return artifact


def _extract(artifact: Mapping[str, Any], raw_dir: Path) -> None:
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
            if manifest.get("parser_version") != PARSER_VERSION:
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
    raw_dir.mkdir(parents=True, exist_ok=True)
    artifact = _request_artifact(descriptor, upload_name)
    try:
        _extract(artifact, raw_dir)
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
        _extract(artifact, raw_dir)

    content_list = json.loads(
        (raw_dir / "content_list.json").read_text(encoding="utf-8")
    )
    if not isinstance(content_list, list):
        raise ModalParseError("content_list.json is not a list of blocks")
    return content_list, str(artifact["key"]), str(artifact.get("fingerprint") or "")
