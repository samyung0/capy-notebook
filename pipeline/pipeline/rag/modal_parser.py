"""Custom LightRAG parser engine backed by the Modal-hosted MineRU GPU service.

LightRAG v1.5 (post RAG-Anything merge) routes document parsing through a
parser registry. This module registers an ``evo "modal"`` engine that:

1. POSTs the source upload to Modal's ``/file_parse`` endpoint (a thin
   wrapper around GPU MineRU, defined in ``modal/mineru_app.py``), which
   returns ``{"content_list": [...], "images": {name: b64}, "md": "..."}``;
2. materializes that response as a MinerU-style raw bundle on disk
   (``content_list.json`` + ``images/``), so
3. ``build_ir`` can reuse LightRAG's own :class:`MinerUIRBuilder` verbatim —
   headings, tables, equations, images and page/bbox positions all flow into
   the standard sidecar and from there into the i/t/e multimodal pipeline.

The engine plugs into :class:`ExternalParserBase`, which supplies the shared
raw-bundle cache / sidecar / full_docs persistence template used by the
built-in MinerU and Docling engines.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import shutil
import tempfile
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

import requests
from lightrag.parser.external._base import ExternalParserBase
from lightrag.parser.registry import ParserSpec, register_parser

from ..config import cfg
from ..store import blobstore

if TYPE_CHECKING:
    from lightrag.sidecar.ir import IRDoc

log = logging.getLogger("evo.rag.modal_parser")

PARSER_ENGINE_MODAL = "modal"
_SIGNATURE_FILENAME = "evo_modal_signature.json"
SOURCE_DESCRIPTOR_SCHEMA = "evo-b2-source-v1"
ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
PARSER_VERSION = "mineru-3.4-hybrid-v1"

# Everything the Modal MineRU service can rasterize/OCR. Plain text formats
# (txt/md) never reach this engine — the worker inserts those as RAW text.
_MODAL_SUFFIXES = frozenset(
    {
        "pdf",
        "doc",
        "docx",
        "ppt",
        "pptx",
        "xls",
        "xlsx",
        "png",
        "jpg",
        "jpeg",
        "jp2",
        "webp",
        "gif",
        "bmp",
    }
)


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


def _read_source_descriptor(source_path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(data, dict) and data.get("schema") == SOURCE_DESCRIPTOR_SCHEMA:
        return data
    return None


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


def _bundle_signature(source_path: Path) -> dict[str, Any]:
    """Cache signature for a raw bundle: source identity + parse params."""
    descriptor = _read_source_descriptor(source_path)
    if descriptor is not None:
        artifact_key, fingerprint = artifact_identity(descriptor)
        return {
            "source_fingerprint": fingerprint,
            "artifact_key": artifact_key,
            "parse_method": cfg.parse_method,
            "url": cfg.modal_parse_url,
            "parser_version": PARSER_VERSION,
        }
    stat = source_path.stat()
    return {
        "source_size": stat.st_size,
        "source_mtime_ns": stat.st_mtime_ns,
        "parse_method": cfg.parse_method,
        "url": cfg.modal_parse_url,
    }


def _request_payload(source_path: Path, upload_name: str) -> dict[str, Any]:
    """POST the source to Modal and return the parsed JSON payload.

    Isolated from bundle writing so tests can record/replay this single
    network call (the only expensive, non-deterministic step) by patching this
    function — see ``pipeline/tests/README.md``.
    """
    if not cfg.modal_parse_url:
        raise ModalParseError("MODAL_PARSE_URL is not configured")

    headers = {}
    if cfg.modal_parse_token:
        headers["Authorization"] = f"Bearer {cfg.modal_parse_token}"

    descriptor = _read_source_descriptor(source_path)
    if descriptor is not None:
        artifact_key, fingerprint = artifact_identity(descriptor)
        cached = blobstore.object_info(artifact_key)
        if cached is not None:
            log.info(
                "parse artifact cache hit key=%s bytes=%s",
                artifact_key,
                cached["size"],
            )
            return {
                "artifact": {
                    "key": artifact_key,
                    "size": cached["size"],
                    "etag": cached["etag"],
                    "fingerprint": fingerprint,
                    "cached": True,
                }
            }
        source_url = blobstore.presign_get(str(descriptor["blob_path"]))
        output_url = blobstore.presign_put(artifact_key, "application/zip")
        resp = requests.post(
            cfg.modal_parse_url,
            headers={**headers, "Content-Type": "application/json"},
            json={
                "source_url": source_url,
                "output_url": output_url,
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
        return payload

    with open(source_path, "rb") as fh:
        resp = requests.post(
            cfg.modal_parse_url,
            headers=headers,
            files={"file": (upload_name, fh)},
            data={"parse_method": cfg.parse_method, "filename": upload_name},
            timeout=cfg.modal_parse_timeout,
        )
    if resp.status_code >= 300:
        raise ModalParseError(f"modal parse {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def _extract_artifact(
    artifact_key: str,
    raw_dir: Path,
    expected_sha256: str | None = None,
    expected_fingerprint: str | None = None,
) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix="evo_parse_", suffix=".zip")
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        blobstore.download_to(artifact_key, tmp)
        log.info(
            "downloading parse artifact key=%s bytes=%d",
            artifact_key,
            tmp.stat().st_size,
        )
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if expected_sha256 and digest != expected_sha256:
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
            if (
                expected_fingerprint
                and manifest.get("source_fingerprint") != expected_fingerprint
            ):
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


def _fetch_bundle_sync(source_path: Path, upload_name: str, raw_dir: Path) -> None:
    """Fetch the Modal payload and write a MinerU-style raw bundle into ``raw_dir``.

    Blocking (requests + file IO); run via ``asyncio.to_thread``.
    """
    payload = _request_payload(source_path, upload_name)
    artifact = payload.get("artifact")
    if isinstance(artifact, dict) and artifact.get("key"):
        try:
            _extract_artifact(
                str(artifact["key"]),
                raw_dir,
                str(artifact.get("sha256") or "") or None,
                str(artifact.get("fingerprint") or "") or None,
            )
        except Exception:
            if not artifact.get("cached"):
                raise
            log.warning("discarding corrupt cached parse artifact %s", artifact["key"])
            blobstore.delete(str(artifact["key"]))
            for child in raw_dir.iterdir():
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            payload = _request_payload(source_path, upload_name)
            artifact = payload.get("artifact") or {}
            _extract_artifact(
                str(artifact["key"]),
                raw_dir,
                str(artifact.get("sha256") or "") or None,
                str(artifact.get("fingerprint") or "") or None,
            )
        (raw_dir / _SIGNATURE_FILENAME).write_text(
            json.dumps(_bundle_signature(source_path)), encoding="utf-8"
        )
        return

    content_list: list[dict[str, Any]] = payload.get("content_list") or []
    images: dict[str, str] = payload.get("images") or {}

    images_dir = raw_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    written: set[str] = set()
    for name, b64 in images.items():
        safe = os.path.basename(name)
        if not safe:
            continue
        try:
            (images_dir / safe).write_bytes(base64.b64decode(b64))
            written.add(safe)
        except Exception:
            log.warning("failed writing extracted image %s", name, exc_info=True)

    # Point every image block at the bundle-relative location we just wrote so
    # MinerUIRBuilder's safe asset resolver finds the bytes inside raw_dir.
    for item in content_list:
        if isinstance(item, dict) and item.get("type") == "image":
            img = item.get("img_path")
            if isinstance(img, str) and img:
                basename = os.path.basename(img)
                if basename in written:
                    item["img_path"] = f"images/{basename}"

    (raw_dir / "content_list.json").write_text(
        json.dumps(content_list, ensure_ascii=False), encoding="utf-8"
    )
    (raw_dir / _SIGNATURE_FILENAME).write_text(
        json.dumps(_bundle_signature(source_path)), encoding="utf-8"
    )
    log.info(
        "parsed %s -> %d blocks, %d images",
        upload_name,
        len(content_list),
        len(written),
    )


class ModalParser(ExternalParserBase):
    """MinerU-on-Modal engine speaking our custom ``/file_parse`` contract."""

    engine_name = PARSER_ENGINE_MODAL
    raw_dir_suffix = ".modal_raw"
    force_reparse_env = "EVO_FORCE_REPARSE_MODAL"

    def is_bundle_valid(
        self,
        raw_dir: Path,
        source_path: Path,
        *,
        engine_params: Mapping[str, Any] | None = None,
    ) -> bool:
        if not (raw_dir / "content_list.json").is_file():
            return False
        sig_path = raw_dir / _SIGNATURE_FILENAME
        try:
            recorded = json.loads(sig_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return recorded == _bundle_signature(source_path)

    async def download_into(
        self,
        raw_dir: Path,
        source_path: Path,
        *,
        upload_name: str,
        engine_params: Mapping[str, Any] | None = None,
    ) -> None:
        await asyncio.to_thread(_fetch_bundle_sync, source_path, upload_name, raw_dir)

    def build_ir(self, raw_dir: Path, document_name: str) -> IRDoc:
        from lightrag.parser.external.mineru import MinerUIRBuilder

        return MinerUIRBuilder().normalize_from_workdir(
            raw_dir, document_name=document_name
        )


def register_modal_parser() -> None:
    """Register the engine with LightRAG's parser registry (idempotent)."""
    register_parser(
        ParserSpec(
            engine_name=PARSER_ENGINE_MODAL,
            impl="pipeline.rag.modal_parser:ModalParser",
            suffixes=_MODAL_SUFFIXES,
            queue_group=PARSER_ENGINE_MODAL,
            concurrency=int(os.getenv("MAX_PARALLEL_PARSE_MODAL", "2")),
            endpoint_configured=lambda: bool(cfg.modal_parse_url),
            endpoint_requirement=lambda: "MODAL_PARSE_URL",
        )
    )
