"""The shared knowledge-base bucket: deployed services hold only the reader key.

The bucket is shared by UAT and production, so the services' key is read-only
and the writer key lives only in the developer PC's `.env.local`
(openwiki/deployment-runbook.md 4.1, Epo 2026-10-19).
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_no_deploy_file_carries_the_library_writer_key() -> None:
    declared = [
        path.relative_to(ROOT).as_posix()
        for folder in (ROOT / "deploy", ROOT / ".github")
        for path in folder.rglob("*")
        if path.is_file()
        and "KNOWLEDGE_BASE_B2_WRITER"
        in path.read_text(encoding="utf-8", errors="ignore")
    ]
    assert declared == []


def test_the_service_only_reads_the_library_bucket() -> None:
    writes = re.compile(
        r"library_client\(\)\s*\.\s*(upload_\w+|put_object|delete_\w+|copy\w*|create_multipart_upload)"
    )
    found = [
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "pipeline/pipeline").rglob("*.py")
        if writes.search(path.read_text(encoding="utf-8"))
    ]
    assert found == []
