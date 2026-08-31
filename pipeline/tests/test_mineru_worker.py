"""Offline tests for MinerU page slicing and deterministic result merging."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_DIR = REPO_ROOT / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

spec = importlib.util.spec_from_file_location(
    "mineru_worker", PARSER_DIR / "mineru_worker.py"
)
assert spec is not None and spec.loader is not None
mineru_worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mineru_worker
spec.loader.exec_module(mineru_worker)


def test_610_pages_become_24_independent_26_page_slices():
    slices = mineru_worker.page_slices(610, 26)

    assert len(slices) == 24
    assert slices[0] == mineru_worker.PageSlice(0, 25)
    assert slices[1] == mineru_worker.PageSlice(26, 51)
    assert slices[-1] == mineru_worker.PageSlice(598, 609)


def test_slice_page_indices_are_restored_before_merging():
    content = [
        {
            "type": "table",
            "page_idx": 0,
            "nested": {"page_idx": 1},
        }
    ]

    mineru_worker._offset_page_indices(content, 26)

    assert content[0]["page_idx"] == 26
    assert content[0]["nested"]["page_idx"] == 27


def test_merge_is_page_ordered_and_deduplicates_identical_images():
    later = mineru_worker.SliceResult(
        page_slice=mineru_worker.PageSlice(26, 27),
        content_list=[{"type": "text", "text": "later", "page_idx": 26}],
        markdown="later",
        images={"same.jpg": b"image"},
        ocr_enabled=True,
    )
    earlier = mineru_worker.SliceResult(
        page_slice=mineru_worker.PageSlice(0, 25),
        content_list=[{"type": "text", "text": "earlier", "page_idx": 0}],
        markdown="earlier",
        images={"same.jpg": b"image"},
        ocr_enabled=False,
    )

    merged = mineru_worker.merge_slices([later, earlier])

    assert [item["text"] for item in merged["content_list"]] == [
        "earlier",
        "later",
    ]
    assert merged["md"] == "earlier\n\nlater"
    assert merged["_ocr_pages"] == [26, 27]
    assert set(merged["images"]) == {"same.jpg"}


def test_merge_rejects_same_image_name_with_different_bytes():
    def result(page: int, body: bytes):
        return mineru_worker.SliceResult(
            page_slice=mineru_worker.PageSlice(page, page),
            content_list=[],
            markdown="",
            images={"collision.jpg": body},
            ocr_enabled=False,
        )

    with pytest.raises(ValueError, match="image name collision"):
        mineru_worker.merge_slices([result(0, b"a"), result(1, b"b")])
