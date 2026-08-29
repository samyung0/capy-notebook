from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_VM_DIR = REPO_ROOT / "parser-vm"
if str(PARSER_VM_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_VM_DIR))

spec = importlib.util.spec_from_file_location("parser_vm_app", PARSER_VM_DIR / "app.py")
assert spec is not None and spec.loader is not None
parser_vm_app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = parser_vm_app
spec.loader.exec_module(parser_vm_app)


@pytest.mark.asyncio
async def test_same_artifact_fingerprint_shares_inflight_parse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = 0
    release = asyncio.Event()

    async def _produce(_body):
        nonlocal started
        started += 1
        await release.wait()
        return {"artifact": {"key": "parsed/result.zip"}}, 200

    monkeypatch.setattr(parser_vm_app, "_produce_artifact", _produce)
    parser_vm_app._artifact_tasks.clear()
    body = {"source_fingerprint": "same"}

    first, retry = await asyncio.gather(
        parser_vm_app._artifact_task("same", body),
        parser_vm_app._artifact_task("same", body),
    )

    assert first is retry
    assert started == 1
    release.set()
    assert await first == ({"artifact": {"key": "parsed/result.zip"}}, 200)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert "same" not in parser_vm_app._artifact_tasks
