"""Download a B2 job blob to a readable local file.

The Go gateway records a B2 object key in ``files.blob_path`` and echoes it
into each ingest job as ``blobPath``. This module downloads the object to a
temporary file so existing readers (``open(...)``) and the Modal parse client
keep working untouched, then deletes it once ingest is done.

``fetch_local`` is synchronous (boto3 + file IO block); the worker calls it via
``asyncio.to_thread`` so the event loop is never blocked.
"""

from __future__ import annotations

import logging
import os
import tempfile
from collections.abc import Callable
from pathlib import Path

from ..config import cfg

log = logging.getLogger("evo.blob")

_client = None


def _s3_client():
    global _client
    if _client is None:
        import boto3  # imported lazily to defer client initialization

        _client = boto3.client(
            "s3",
            endpoint_url=cfg.b2_endpoint or None,
            region_name=cfg.b2_region or None,
            aws_access_key_id=cfg.b2_key_id or None,
            aws_secret_access_key=cfg.b2_app_key or None,
        )
    return _client


def fetch_local(blob_path: str) -> tuple[str, Callable[[], None]]:
    """Return ``(local_path, cleanup)`` for ``blob_path``.

    Downloads the B2 object to a temp file; ``cleanup`` deletes it.
    """
    fd, tmp = tempfile.mkstemp(prefix="evo_blob_")
    os.close(fd)
    try:
        _s3_client().download_file(cfg.b2_bucket, blob_path, tmp)
    except Exception:
        _safe_unlink(tmp)
        raise

    def _cleanup() -> None:
        _safe_unlink(tmp)

    log.info("downloaded blob %s -> %s", blob_path, tmp)
    return tmp, _cleanup


def presign_get(blob_path: str, expires: int = 900) -> str:
    return _s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": cfg.b2_bucket, "Key": blob_path},
        ExpiresIn=expires,
    )


def presign_put(blob_path: str, content_type: str, expires: int = 900) -> str:
    return _s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": cfg.b2_bucket,
            "Key": blob_path,
            "ContentType": content_type,
        },
        ExpiresIn=expires,
    )


def object_info(blob_path: str) -> dict | None:
    from botocore.exceptions import ClientError

    try:
        out = _s3_client().head_object(Bucket=cfg.b2_bucket, Key=blob_path)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    return {
        "size": int(out.get("ContentLength") or 0),
        "etag": str(out.get("ETag") or "").strip('"'),
        "content_type": str(out.get("ContentType") or ""),
    }


def download_to(blob_path: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    _s3_client().download_file(cfg.b2_bucket, blob_path, str(destination))


def delete(blob_path: str) -> None:
    _s3_client().delete_object(Bucket=cfg.b2_bucket, Key=blob_path)


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        log.debug("could not remove temp blob %s", path, exc_info=True)
