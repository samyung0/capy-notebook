"""Read and write durable B2 objects used by the ingest pipeline.

The Go gateway records a B2 object key in ``files.blob_path`` and echoes it
into each ingest job as ``blobPath``. The worker downloads that object once
into the Netcup VM's shared spool while calculating its trusted SHA-256. The
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
from collections.abc import Callable
from pathlib import Path, PurePosixPath

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


def read_bytes(blob_path: str) -> bytes | None:
    """Read a small object, or None when it does not exist."""
    from botocore.exceptions import ClientError

    try:
        out = _s3_client().get_object(Bucket=cfg.b2_bucket, Key=blob_path)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    return out["Body"].read()


def write_bytes(blob_path: str, data: bytes, content_type: str) -> None:
    _s3_client().put_object(
        Bucket=cfg.b2_bucket, Key=blob_path, Body=data, ContentType=content_type
    )


def delete(blob_path: str) -> None:
    _s3_client().delete_object(Bucket=cfg.b2_bucket, Key=blob_path)


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        log.debug("could not remove temp blob %s", path, exc_info=True)
