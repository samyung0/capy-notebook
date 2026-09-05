"""Read and write durable B2 objects used by the ingest pipeline.

The Go gateway records a B2 object key in ``files.blob_path`` and echoes it
into each ingest job as ``blobPath``. The worker downloads that object once
into the Netcup ingest host's shared spool while calculating its trusted SHA-256. The
parser container reads the same local file.

``fetch_local`` is synchronous (boto3 + file IO block); the worker calls it via
``asyncio.to_thread`` so the event loop is never blocked.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import tempfile
import time
from collections.abc import Callable
from pathlib import Path, PurePosixPath

from ..config import cfg

log = logging.getLogger("evo.blob")

_client = None
_WRITE_ATTEMPTS = 3


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


def fetch_local_hashed(
    blob_path: str, shared_dir: str
) -> tuple[str, str, str, Callable[[], None]]:
    """Download once into the shared spool and hash the bytes as they arrive.

    Returns ``(local_path, source_key, sha256, cleanup)``. ``source_key`` is the
    relative identifier passed to the parser, never an arbitrary host path.
    """
    root = Path(shared_dir).resolve()
    source_dir = root / "sources"
    source_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="source-", dir=source_dir)
    os.close(fd)
    path = Path(tmp)
    digest = hashlib.sha256()
    body = None
    try:
        try:
            response = _s3_client().get_object(Bucket=cfg.b2_bucket, Key=blob_path)
        except Exception as exc:
            from botocore.exceptions import ClientError

            if isinstance(exc, ClientError):
                code = str(exc.response.get("Error", {}).get("Code", ""))
                if code in {"404", "NoSuchKey", "NotFound"}:
                    raise FileNotFoundError(blob_path) from exc
            raise
        body = response["Body"]
        with path.open("wb") as handle:
            while chunk := body.read(1024 * 1024):
                digest.update(chunk)
                handle.write(chunk)
        # The production spool directory is setgid to the parser's group. Keep
        # each source private to the worker/parser pair while allowing the
        # unprivileged parser container to read it.
        path.chmod(0o640)
    except Exception:
        _safe_unlink(str(path))
        raise
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()

    def _cleanup() -> None:
        _safe_unlink(str(path))

    source_key = path.relative_to(root).as_posix()
    log.info("downloaded and hashed blob %s -> %s", blob_path, source_key)
    return str(path), source_key, digest.hexdigest(), _cleanup


def reuse_local_hashed(
    source_key: str, expected_sha256: str, shared_dir: str
) -> tuple[str, str, str, Callable[[], None]]:
    """Open a job's prior spool source after verifying its key and checksum."""
    relative = PurePosixPath(source_key)
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != "sources"
        or relative.parts[1] in {"", ".", ".."}
        or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256)
    ):
        raise ValueError("invalid local source descriptor")
    root = Path(shared_dir).resolve()
    path = root.joinpath(*relative.parts).resolve()
    if root not in path.parents:
        raise ValueError("invalid local source descriptor")

    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    if not hmac.compare_digest(digest.hexdigest(), expected_sha256):
        _safe_unlink(str(path))
        raise ValueError("local source checksum mismatch")
    try:
        path.touch()
    except OSError:
        log.debug("could not touch local source %s", source_key, exc_info=True)

    def _cleanup() -> None:
        _safe_unlink(str(path))

    log.info("reused local source %s", source_key)
    return str(path), source_key, expected_sha256, _cleanup


def cleanup_local_source(source_key: str, shared_dir: str) -> None:
    """Remove a previously persisted source descriptor if it is well formed."""
    relative = PurePosixPath(source_key)
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != "sources"
        or relative.parts[1] in {"", ".", ".."}
    ):
        return
    root = Path(shared_dir).resolve()
    path = root.joinpath(*relative.parts).resolve()
    if root in path.parents:
        _safe_unlink(str(path))


def presign_get(blob_path: str, expires: int = 900) -> str:
    return _s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": cfg.b2_bucket, "Key": blob_path},
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
    return _object_info_from_head(out)


def _object_info_from_head(out: dict) -> dict:
    return {
        "size": int(out.get("ContentLength") or 0),
        "etag": str(out.get("ETag") or "").strip('"'),
        "content_type": str(out.get("ContentType") or ""),
    }


def read_bytes(blob_path: str, max_bytes: int | None = None) -> bytes | None:
    """Read a small object, optionally refusing a body over ``max_bytes``."""
    from botocore.exceptions import ClientError

    try:
        out = _s3_client().get_object(Bucket=cfg.b2_bucket, Key=blob_path)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    body = out["Body"]
    try:
        if max_bytes is None:
            return body.read()
        if max_bytes <= 0:
            raise ValueError("B2 read limit must be positive")
        data = body.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("B2 cache object exceeds configured byte limit")
        return data
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()


def write_bytes(blob_path: str, data: bytes | bytearray, content_type: str) -> None:
    for attempt in range(1, _WRITE_ATTEMPTS + 1):
        try:
            _s3_client().put_object(
                Bucket=cfg.b2_bucket,
                Key=blob_path,
                Body=data,
                ContentType=content_type,
            )
            return
        except Exception:
            if attempt == _WRITE_ATTEMPTS:
                raise
            log.warning(
                "B2 cache write failed for %s; retrying (%s/%s)",
                blob_path,
                attempt,
                _WRITE_ATTEMPTS,
                exc_info=True,
            )
            time.sleep(0.1 * attempt)


def write_file(blob_path: str, local_path: str, content_type: str) -> None:
    """Upload a cache file with the same three-attempt policy as byte writes."""
    for attempt in range(1, _WRITE_ATTEMPTS + 1):
        try:
            with open(local_path, "rb") as body:
                _s3_client().put_object(
                    Bucket=cfg.b2_bucket,
                    Key=blob_path,
                    Body=body,
                    ContentType=content_type,
                )
            return
        except Exception:
            if attempt == _WRITE_ATTEMPTS:
                raise
            log.warning(
                "B2 cache write failed for %s; retrying (%s/%s)",
                blob_path,
                attempt,
                _WRITE_ATTEMPTS,
                exc_info=True,
            )
            time.sleep(0.1 * attempt)


def download_file(
    blob_path: str, local_path: str, max_bytes: int
) -> tuple[int, str] | None:
    """Download a bounded cache object and return its size and SHA-256."""
    from botocore.exceptions import ClientError

    try:
        out = _s3_client().get_object(Bucket=cfg.b2_bucket, Key=blob_path)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    body = out["Body"]
    digest = hashlib.sha256()
    size = 0
    try:
        with open(local_path, "wb") as destination:
            while chunk := body.read(min(1024 * 1024, max_bytes - size + 1)):
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("B2 cache object exceeds configured byte limit")
                digest.update(chunk)
                destination.write(chunk)
    except Exception:
        _safe_unlink(local_path)
        raise
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    if size <= 0:
        _safe_unlink(local_path)
        raise ValueError("B2 cache object is empty")
    return size, digest.hexdigest()


def delete(blob_path: str) -> None:
    _s3_client().delete_object(Bucket=cfg.b2_bucket, Key=blob_path)


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        log.debug("could not remove temp blob %s", path, exc_info=True)
