"""Provider import stage: move one Drive/OneDrive file into B2.

The gateway created the import row, its upload reservation, and this queue job
in one transaction. Each attempt asks the gateway for a download grant, streams
the bytes into the attempt's incoming object with the worker's own B2
credentials, then reports completion so the gateway finalizes the file and
enqueues the ordinary parse or ingest job. A parse or ingest job therefore only
exists once the bytes are durably in B2.

Retry scheduling is the ``jobs`` row's; the gateway's attempt lease only fences
stale callbacks. A retryable error releases that lease before the requeue so
the next claim acquires immediately instead of waiting for it to expire.
"""

from __future__ import annotations

import asyncio
import json
import logging
from urllib.parse import urlsplit

import requests

from ..config import cfg
from ..jobs import CapacityWait, RetryableError, TerminalError
from ..store import blobstore, db
from . import pinned_http, telemetry

log = logging.getLogger("evo.import")

_GATEWAY_TIMEOUT_S = 30
_LEASE_WAIT_BACKOFF_S = 30
_RETRY_STATUSES = {408, 425, 429}
_GOOGLE_RATE_LIMIT_REASONS = ("rateLimitExceeded", "userRateLimitExceeded")
_TOKEN_KEY = "_importAttemptToken"


class ImportRetry(RetryableError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ImportFailure(TerminalError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ImportWait(CapacityWait):
    """Return the claim without spending an attempt.

    ``release`` asks the gateway to drop this attempt's lease first, so the
    next claim acquires at once instead of polling a lease it cannot take.
    """

    def __init__(self, code: str, backoff_s: int, *, release: bool) -> None:
        super().__init__("import")
        self.code = code
        self.backoff_s = backoff_s
        self.release = release


def _gateway(path: str, body: dict) -> tuple[int, dict]:
    if not cfg.gateway_url or not cfg.pipeline_secret:
        raise ImportFailure(
            "gateway_unconfigured",
            "GATEWAY_URL and PIPELINE_SECRET are required for provider imports",
        )
    try:
        response = requests.post(
            cfg.gateway_url.rstrip("/") + path,
            json=body,
            headers={"X-Pipeline-Secret": cfg.pipeline_secret},
            timeout=_GATEWAY_TIMEOUT_S,
        )
    except (requests.Timeout, requests.ConnectionError) as exc:
        raise ImportRetry(
            "gateway_unreachable", f"gateway request failed: {exc}"
        ) from exc
    payload: object = {}
    if response.content:
        try:
            payload = response.json()
        except ValueError:
            payload = {}
    payload = payload if isinstance(payload, dict) else {}
    retry_after = response.headers.get("Retry-After", "")
    if retry_after.isdigit():
        payload.setdefault("retryAfterSeconds", int(retry_after))
    return response.status_code, payload


def _raise_for_gateway(status: int, payload: dict, what: str) -> None:
    code = str(payload.get("code") or f"gateway_http_{status}")
    if status == 409 and code == "import_not_ready":
        # Another attempt still holds the gateway lease (a reaped worker whose
        # lease has not expired). Wait out the remaining lease without
        # spending an attempt.
        raise ImportWait(
            code,
            int(payload.get("retryAfterSeconds") or _LEASE_WAIT_BACKOFF_S),
            release=False,
        )
    if status == 409 and code == "import_lease_lost":
        raise ImportRetry(code, f"{what}: this attempt's lease is no longer live")
    if status == 429 and code == "too_many_ingest_leases":
        # The host is saturated, not this import. Keep the attempt budget for
        # real failures, release the gateway lease, and wait out Retry-After;
        # the bytes are already promoted, so the next claim resumes at
        # completion without downloading again.
        raise ImportWait(
            code,
            int(payload.get("retryAfterSeconds") or _LEASE_WAIT_BACKOFF_S),
            release=True,
        )
    if status in _RETRY_STATUSES or status >= 500:
        raise ImportRetry(code, f"{what} answered {status}")
    raise ImportFailure(code, f"{what} answered {status}")


def _raise_for_provider(response: object) -> None:
    status = int(getattr(response, "status", 0))
    body = b""
    try:
        body = response.read(64 * 1024) or b""  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - the status already decides the outcome
        body = b""
    if status == 403:
        try:
            reasons = {
                str(item.get("reason") or "")
                for item in json.loads(body).get("error", {}).get("errors", [])
            }
        except (ValueError, AttributeError, TypeError):
            reasons = set()
        if reasons.intersection(_GOOGLE_RATE_LIMIT_REASONS):
            raise ImportRetry(
                "provider_rate_limited", "provider rate limited the download"
            )
    if status in _RETRY_STATUSES or status >= 500:
        raise ImportRetry(f"provider_http_{status}", f"provider answered {status}")
    if status in {401, 403}:
        raise ImportFailure(
            "provider_download_refused", f"provider refused the download ({status})"
        )
    if status in {404, 410}:
        raise ImportFailure(
            "provider_file_unavailable", f"provider file is unavailable ({status})"
        )
    raise ImportFailure(f"provider_http_{status}", f"provider answered {status}")


def _download(grant: dict, max_bytes: int) -> bytearray:
    url = str(grant.get("url") or "")
    headers: dict[str, str] = {}
    if grant.get("kind") == "bearer":
        if urlsplit(url).hostname != "www.googleapis.com":
            raise ImportFailure(
                "provider_download_refused", "bearer grant is not a Drive API URL"
            )
        headers["Authorization"] = "Bearer " + str(grant.get("token") or "")
    try:
        download = pinned_http.open_download(
            url,
            headers=headers,
            allowed_hosts=cfg.import_download_hosts,
            timeout=cfg.import_job_timeout,
        )
    except pinned_http.DownloadRefused as exc:
        raise ImportFailure("provider_download_refused", str(exc)) from exc
    except Exception as exc:
        raise ImportRetry(
            "provider_network", f"provider connection failed: {exc}"
        ) from exc
    body = bytearray()
    try:
        response = download.response
        if response.status >= 400:
            _raise_for_provider(response)
        try:
            # ponytail: whole file buffered once; plan limits cap imports at
            # 30 MiB. Switch to a multipart upload if that ceiling moves.
            for chunk in response.stream(1 << 20):
                if len(body) + len(chunk) > max_bytes:
                    raise ImportFailure(
                        "file_too_large", "provider file exceeds the import limit"
                    )
                body += chunk
        except ImportFailure:
            raise
        except Exception as exc:
            raise ImportRetry(
                "provider_network", f"provider download interrupted: {exc}"
            ) from exc
    finally:
        download.close()
    if not body:
        raise ImportFailure("provider_file_empty", "provider returned an empty file")
    return body


def _run(job: dict) -> None:
    payload = job.get("payload") or {}
    import_id = str(payload.get("importJobId") or "")
    if not import_id:
        raise ImportFailure("invalid_payload", "import job names no importJobId")

    telemetry.stage("acquire")
    status, acquired = _gateway("/api/internal/import/acquire", {"jobId": import_id})
    if status != 200:
        _raise_for_gateway(status, acquired, "acquire")
    state = str(acquired.get("status") or "")
    if state == "succeeded":
        log.info("import %s already finalized", import_id)
        return
    if state in {"failed", "cancelled", "expired"}:
        raise ImportFailure(f"import_{state}", f"import is already {state}")
    token = str(acquired.get("attemptToken") or "")
    object_path = str(acquired.get("attemptObjectPath") or "")
    max_bytes = int(acquired.get("maxBytes") or 0)
    if state != "acquired" or not token or not object_path or max_bytes <= 0:
        raise ImportRetry("acquire_invalid", "acquire response is incomplete")
    job[_TOKEN_KEY] = token

    if acquired.get("resumeComplete"):
        actual = int(acquired.get("declaredSize") or 0)
    else:
        telemetry.stage("download")
        data = _download(acquired.get("download") or {}, max_bytes)
        telemetry.stage("upload")
        try:
            blobstore.write_bytes(
                object_path,
                data,
                str(acquired.get("contentType") or "application/octet-stream"),
            )
        except Exception as exc:
            raise ImportRetry("b2_upload_failed", f"B2 upload failed: {exc}") from exc
        actual = len(data)
        telemetry.record(source_bytes=actual)

    telemetry.stage("complete")
    status, completed = _gateway(
        "/api/internal/import/complete",
        {"jobId": import_id, "attemptToken": token, "actualSize": actual},
    )
    if status != 200:
        _raise_for_gateway(status, completed, "complete")
    if completed.get("status") != "succeeded":
        raise ImportRetry(
            "complete_invalid", "complete answered 200 without a finalized file"
        )
    job.pop(_TOKEN_KEY, None)
    log.info(
        "import %s stored %s bytes as file %s",
        import_id,
        actual,
        completed.get("fileId"),
    )


def _yield_for_wait(job: dict, wait: ImportWait) -> None:
    """Return the claim without spending an attempt."""
    if wait.release:
        report(job, wait, True)
    attempt = int(job.get("attempts") or 1)
    with db.connect() as conn, conn.cursor() as cur:
        if not db.claim_is_current(cur, job["id"], attempt):
            return
        db.release_job_for_capacity(cur, job["id"], attempt, backoff_s=wait.backoff_s)
        cur.execute("SELECT not_before FROM jobs WHERE id=%s", (job["id"],))
        row = cur.fetchone()
        db.finish_job_attempt(
            cur,
            attempt_id=telemetry.current_attempt_id(),
            outcome="capacity_wait",
            snapshot=telemetry.snapshot(),
            error_category="capacity",
            error_code=wait.code,
            next_retry_at=row[0] if row else None,
        )
        conn.commit()


async def process(job: dict) -> None:
    try:
        await asyncio.to_thread(_run, job)
    except ImportWait as wait:
        try:
            await asyncio.to_thread(_yield_for_wait, job, wait)
        except Exception as exc:
            # A failed yield must not close the queue row while the import row
            # stays pending; let the ordinary retry path keep both in step.
            raise ImportRetry(
                "yield_failed", f"import wait could not be recorded: {exc}"
            ) from exc
        raise


def report(job: dict, exc: BaseException, retryable: bool) -> None:
    """Tell the gateway how this attempt ended. Best effort: the gateway's
    lease expiry and upload-session sweeper are the backstop."""
    payload = job.get("payload") or {}
    import_id = str(payload.get("importJobId") or "")
    token = str(job.get(_TOKEN_KEY) or "")
    if not import_id or (retryable and not token):
        return
    code = str(
        getattr(exc, "code", "")
        or ("import_retry" if retryable else "attempts_exhausted")
    )
    try:
        status, body = _gateway(
            "/api/internal/import/fail",
            {
                "jobId": import_id,
                "attemptToken": token,
                "code": code[:64],
                "retryable": retryable,
            },
        )
    except (ImportRetry, ImportFailure) as failure:
        log.warning("import %s failure report not delivered: %s", import_id, failure)
        return
    if status >= 300:
        log.warning("import %s failure report answered %s %s", import_id, status, body)
