"""The UAT-only ingest switches (``pipeline/ingest/uat.py``).

``CAPY_UAT_FAIL_PARTS`` fails a marked file's descriptor or VLM page reads and
``INGEST_UAT_SCRIPTED_VLM`` scripts a marked file's page reads, each with no
provider call. The gate test is the security boundary: neither switch may
start a process outside UAT (the renderer's half is in
``scripts/env/test_config.py``).
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pipeline import elitellm, registry
from pipeline.ingest import uat, worker
from pipeline.registry import ModelConfig
from pipeline.retrieval import indexing, models
from pipeline.retrieval.chunking import Chunk
from pipeline.retrieval.usage_extract import NormalizedUsage

SWITCHES = {
    "CAPY_UAT_FAIL_PARTS": "uat_fail_parts",
    "INGEST_UAT_SCRIPTED_VLM": "uat_scripted_vlm",
}
RATE = 1_000_000


def _start(switch: str, environment: str) -> subprocess.CompletedProcess:
    """Start a pipeline process's configuration with one switch set."""
    env = {k: v for k, v in os.environ.items() if k not in SWITCHES}
    env.update({switch: "true", "SENTRY_ENVIRONMENT": environment})
    return subprocess.run(
        [
            sys.executable,
            "-c",
            f"from pipeline.config import cfg; assert cfg.{SWITCHES[switch]}",
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("switch", SWITCHES)
def test_the_ingest_switches_start_only_in_uat(switch):
    """Security gate: outside UAT a pipeline process refuses to start."""
    refused = _start(switch, "production")
    assert refused.returncode != 0
    assert f"{switch} is allowed only with SENTRY_ENVIRONMENT=uat" in refused.stderr
    assert _start(switch, "uat").returncode == 0


async def test_a_marked_file_gets_a_descriptor_failure_without_a_provider_call(
    monkeypatch,
):
    async def summarize(_name, _chunks):
        return "A descriptor."

    monkeypatch.setattr(indexing, "summarize_file", summarize)
    chunks = [Chunk(text="Osmosis moves water across membranes.")]
    name = f"report {uat.FAIL_SUMMARY}.pdf"
    # Without the switch the marker is ordinary file-name text.
    assert await indexing._descriptor(name, chunks, None) == (
        "A descriptor.",
        0.0,
        None,
    )

    async def forbidden(_name, _chunks):
        pytest.fail("a marked file's descriptor must not reach the provider")

    monkeypatch.setattr(indexing, "summarize_file", forbidden)
    monkeypatch.setattr(uat.cfg, "uat_fail_parts", True)
    descriptor, share, error = await indexing._descriptor(name, chunks, None)
    assert (descriptor, share) == (None, 0.0)
    assert uat.FAIL_SUMMARY in str(error)


def _spec() -> ModelConfig:
    return ModelConfig(
        version=1,
        provider_name="Relace",
        model_name="VLM",
        provider_slug="relace",
        model_slug="vlm",
        platform_enabled=True,
        byok_enabled=False,
        thinking_levels=("instant",),
        default_thinking="instant",
        context_window_tokens=100_000,
    )


@pytest.fixture
def pages(monkeypatch, tmp_path: Path):
    """Two text-less page renders, the caption cache as a pass-through to the
    read it is given, and the provider and accounting boundaries recorded."""
    seen: dict[str, list] = {"keys": [], "provider": [], "opened": [], "settled": []}
    (tmp_path / "vlm").mkdir()
    for page in (0, 2):
        (tmp_path / "vlm" / f"{page}.jpg").write_bytes(f"render {page}".encode())

    async def caption(*, image_sha256, data_url, read, exclusive, **_kwargs):
        seen["keys"].append(image_sha256)
        return (await read(data_url)) or "", "", 0, False

    async def complete(*_args, **_kwargs):
        seen["provider"].append("complete")
        return elitellm.chat_response(
            {"role": "assistant", "content": "Read by the model."},
            finish_reason="stop",
            usage={"prompt_tokens": 1, "completion_tokens": 1},
        )

    async def open_call(*_args, **kwargs):
        seen["opened"].append(kwargs["purpose"])

    async def settle(**kwargs):
        seen["settled"].append(
            (kwargs["purpose"], kwargs["credit_micros"], kwargs["usage"])
        )

    async def release(*_args, **_kwargs):
        return None

    registry.bind_request_llm(paid_by="platform")
    monkeypatch.setattr(worker.caption_cache, "caption", caption)
    monkeypatch.setattr(models.registry, "captioning_spec", _spec)
    monkeypatch.setattr(models.obs, "record_completion", lambda *a, **k: None)
    monkeypatch.setattr(models.elitellm, "complete", complete)
    monkeypatch.setattr(models.accounting, "open_call", open_call)
    monkeypatch.setattr(models.accounting, "settle", settle)
    monkeypatch.setattr(models.accounting, "release_call", release)
    token = worker._resource_rates.set(
        {worker._RESOURCE_VLM_PAGE: {"version": 1, "creditMicrosPerUnit": RATE}}
    )
    yield tmp_path, seen
    worker._resource_rates.reset(token)


async def test_an_unmarked_file_reads_its_pages_with_the_model(pages):
    raw_dir, seen = pages
    blocks, unread = await worker._read_vlm_pages([], raw_dir, "f_1", "scan.pdf")

    assert [b["text"] for b in blocks] == ["Read by the model."] * 2 and unread == []
    assert seen["provider"] == ["complete", "complete"]
    assert seen["keys"][0] == hashlib.sha256(b"vlm-page\0render 0").hexdigest()


async def test_markers_without_their_switches_read_for_real(pages):
    """Security regression: with the UAT switches off (production), a file
    named with the markers is read by the model under the ordinary cache key."""
    raw_dir, seen = pages
    name = f"scan {uat.FAIL_PAGES} {uat.SCRIPTED_VLM} UAT_ab12.pdf"

    blocks, unread = await worker._read_vlm_pages([], raw_dir, "f_1", name)

    assert [b["text"] for b in blocks] == ["Read by the model."] * 2 and unread == []
    assert seen["provider"] == ["complete", "complete"]
    assert seen["keys"] == [
        hashlib.sha256(b"vlm-page\0render " + page).hexdigest() for page in (b"0", b"2")
    ]


async def test_a_scripted_file_is_read_and_charged_without_a_provider_call(
    monkeypatch, pages
):
    raw_dir, seen = pages
    monkeypatch.setattr(uat.cfg, "uat_scripted_vlm", True)
    name = f"scan {uat.SCRIPTED_VLM} UAT_ab12.pdf"

    blocks, unread = await worker._read_vlm_pages([], raw_dir, "f_1", name)

    assert [b["text"] for b in blocks] == [
        "UAT scripted page 1: scan UAT_ab12",
        "UAT scripted page 3: scan UAT_ab12",
    ]
    assert unread == [] and seen["provider"] == []
    # Each read opens and settles a vlm_page call at the page rate: the
    # vlm_ingest_page usage row a real read writes.
    assert seen["opened"] == ["vlm_page", "vlm_page"]
    assert seen["settled"] == [("vlm_page", RATE, NormalizedUsage())] * 2
    # Its own cache key: a real read of the same render never meets it.
    assert hashlib.sha256(b"vlm-page\0render 0").hexdigest() not in seen["keys"]


async def test_a_failed_pages_file_leaves_every_page_unread(monkeypatch, pages):
    raw_dir, seen = pages
    monkeypatch.setattr(uat.cfg, "uat_fail_parts", True)
    monkeypatch.setattr(uat.cfg, "uat_scripted_vlm", True)
    name = f"scan {uat.FAIL_PAGES} {uat.SCRIPTED_VLM} UAT_ab12.pdf"

    blocks, unread = await worker._read_vlm_pages(
        [{"type": "text", "text": "Cover", "page_idx": 1}], raw_dir, "f_1", name
    )

    assert [b["text"] for b in blocks] == ["Cover"] and unread == [1, 3]
    assert seen["provider"] == [] and seen["settled"] == []
