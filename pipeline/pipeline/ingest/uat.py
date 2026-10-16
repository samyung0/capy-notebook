"""UAT only: ingest outcomes the UAT journeys choose through the file name.

Both switches are ``config.uat_only_flag``s: exactly ``true`` or unset, refused
unless SENTRY_ENVIRONMENT is ``uat`` (the process does not start), scoped to uat
in ``deploy/env-manifest.json`` and refused by the deployment renderer for
production. Without its switch a marker is ordinary file-name text.

- ``CAPY_UAT_FAIL_PARTS=true``: a file whose name contains :data:`FAIL_SUMMARY`
  gets a descriptor failure, and one containing :data:`FAIL_PAGES` a failure on
  every VLM page read, each with no provider call.
- ``INGEST_UAT_SCRIPTED_VLM=true``: a file whose name contains
  :data:`SCRIPTED_VLM` has each text-less page read as :func:`scripted_page`,
  with no provider call but the normal ``vlm_ingest_page`` charge.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from ..config import cfg

FAIL_SUMMARY = "[uat-fail-summary]"
FAIL_PAGES = "[uat-fail-pages]"
SCRIPTED_VLM = "[uat-scripted-vlm]"


def fail_summary(name: str) -> bool:
    return cfg.uat_fail_parts and FAIL_SUMMARY in name


def fail_pages(name: str) -> bool:
    return cfg.uat_fail_parts and FAIL_PAGES in name


def scripted_token(name: str) -> str | None:
    """The run token a scripted page read carries: the file name without its
    extension and the markers, whitespace collapsed. None when the file's pages
    are read by the VLM."""
    if not cfg.uat_scripted_vlm or SCRIPTED_VLM not in name:
        return None
    stem = PurePosixPath(name).stem
    for marker in (FAIL_SUMMARY, FAIL_PAGES, SCRIPTED_VLM):
        stem = stem.replace(marker, " ")
    return " ".join(stem.split())


def scripted_page(token: str, page: int) -> str:
    """The text of a scripted read of 1-based ``page``."""
    return f"UAT scripted page {page}: {token}"
