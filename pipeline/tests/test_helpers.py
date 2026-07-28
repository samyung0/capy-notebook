"""Offline unit tests for pure helper logic in the retrieval service and config
(no network, no database)."""

from __future__ import annotations

import pipeline.retrieve.service as svc
from pipeline.rag.clone import _graph_name


class _Req:
    """Minimal stand-in for GenerateReq (only the fields the helpers read)."""

    def __init__(self, levels=None, difficulty=None):
        self.levels = levels
        self.difficulty = difficulty


def test_extract_json_plain():
    assert svc._extract_json('[{"a": 1}]') == [{"a": 1}]


def test_extract_json_fenced():
    text = 'here you go:\n```json\n{"x": 2}\n```\nthanks'
    assert svc._extract_json(text) == {"x": 2}


def test_extract_json_embedded_array():
    assert svc._extract_json("prefix [1, 2, 3] suffix") == [1, 2, 3]


def test_extract_json_garbage_returns_none():
    assert svc._extract_json("no json here") is None
    assert svc._extract_json("") is None


def test_strip_fence_mermaid():
    assert (
        svc._strip_fence("```mermaid\nflowchart LR\n A-->B\n```")
        == "flowchart LR\n A-->B"
    )


def test_strip_fence_passthrough():
    assert svc._strip_fence("flowchart LR\n A-->B") == "flowchart LR\n A-->B"


def test_cognitive_levels_from_levels():
    assert svc._cognitive_levels(_Req(levels=["recall", "analysis"])) == [
        "recall",
        "analysis",
    ]


def test_cognitive_levels_legacy_difficulty():
    assert svc._cognitive_levels(_Req(difficulty=["easy", "hard"])) == [
        "recall",
        "analysis",
    ]


def test_cognitive_levels_default():
    assert svc._cognitive_levels(_Req()) == ["recall", "application"]


def test_new_srs_shape():
    srs = svc._new_srs()
    assert srs["state"] == 0 and srs["reps"] == 0
    assert set(srs) == {
        "due",
        "stability",
        "difficulty",
        "elapsed_days",
        "scheduled_days",
        "reps",
        "lapses",
        "state",
        "learning_steps",
    }


def test_clone_graph_name_matches_lightrag_sanitizing():
    assert _graph_name("ws_123") == "ws_123_chunk_entity_relation"
    assert _graph_name("shared-workspace") == "shared_workspace_chunk_entity_relation"


def test_config_seeds_input_dir():
    """pipeline.config derives INPUT_DIR from WORKING_DIR at import (conftest)."""
    import os

    assert os.environ.get("INPUT_DIR")
