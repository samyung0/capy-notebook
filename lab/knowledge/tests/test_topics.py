import json
import sys

import pytest
import topics
from jsonschema import ValidationError


def test_review_context_preserves_full_notes_without_old_topic_assignments():
    excerpt = {"id": "e", "pages": [1], "chunk_ids": ["c"], "section_path": "Intro"}
    notes = {
        "roles": ["formal"],
        "synopsis": "Full summary " * 100,
        "evidence": "source words",
        "topic_ids": ["old"],
        "retrieval": {
            "summary": "A concept",
            "scope": "An explicit context",
            "context_excerpt_ids": [],
        },
    }
    context = topics.reviewed_context(
        {"excerpts": [excerpt]}, {"corrected_excerpts": [excerpt], "tags": {"e": notes}}
    )
    assert context[0]["synopsis"] == notes["synopsis"]
    assert context[0]["retrieval"] == notes["retrieval"]
    assert "topic_ids" not in context[0]
    with pytest.raises(ValueError, match="exactly once"):
        topics.reviewed_context(
            {"excerpts": [excerpt]}, {"corrected_excerpts": [], "tags": {}}
        )
    with pytest.raises(ValueError, match="boundary"):
        topics.reviewed_context(
            {"excerpts": [excerpt]},
            {"corrected_excerpts": [{**excerpt, "pages": [2]}], "tags": {"e": notes}},
        )


EXISTING = [
    {
        "id": "sampling",
        "label": "Sampling and bias",
        "aliases": ["population", "random sample"],
        "scope": "s",
        "source_sections": "x",
    },
    {
        "id": "data-types",
        "label": "Variables and measurement",
        "aliases": ["categorical", "numerical"],
        "scope": "s",
        "source_sections": "x",
    },
]


def proposal(id, label, aliases=()):
    return {
        "id": id,
        "label": label,
        "aliases": list(aliases),
        "scope": "one sentence",
        "source_sections": "1.1",
    }


def test_merge_by_id_label_and_alias():
    answer = {
        "reused": ["sampling", "unknown-id", "sampling"],
        "proposed": [
            proposal("data-types", "Data types"),  # id clash -> existing
            proposal(
                "random-sampling", "Random sample"
            ),  # alias clash -> existing sampling
            proposal(
                "kinds-of-variables", "Kinds of variables", ["Categorical"]
            ),  # alias clash on an existing alias
            proposal("regression", "Linear regression", ["least squares"]),
            proposal(
                "regression-2", "Least squares", []
            ),  # clashes with the proposal above
        ],
    }
    merged = topics.merge(EXISTING, answer, "statistics")
    assert merged["reused"] == ["sampling", "data-types"]
    assert [t["id"] for t in merged["proposed"]] == ["regression"]
    assert [t["id"] for t in merged["topics"]] == [
        "sampling",
        "data-types",
        "regression",
    ]
    assert {m["proposed"]: m["existing"] for m in merged["mapped"]} == {
        "data-types": "data-types",
        "random-sampling": "sampling",
        "kinds-of-variables": "data-types",
        "regression-2": "regression",
    }
    assert merged["subject_total"] == 3


def test_a_proposed_id_equal_to_a_subject_id_is_renamed_before_merging():
    answer = {
        "reused": [],
        "proposed": [
            proposal("probability", "Probability basics", ["chance"]),
            proposal("statistics", "Sampling and bias"),  # renamed, then alias clash
        ],
    }
    merged = topics.merge(EXISTING, answer, "statistics", {"probability", "statistics"})
    assert [t["id"] for t in merged["proposed"]] == ["probability-basics"]
    assert merged["renamed"] == [
        {"proposed": "probability", "id": "probability-basics"},
        {"proposed": "statistics", "id": "statistics-basics"},
    ]
    assert merged["mapped"] == [
        {"proposed": "statistics-basics", "existing": "sampling"}
    ]
    assert merged["reused"] == ["sampling"]


def test_merge_stops_at_96_allows_76_and_rejects_bad_ids():
    existing = [proposal(f"t-{i}", f"Topic {i}") for i in range(95)]
    answer = {
        "reused": [],
        "proposed": [proposal("new-1", "New one"), proposal("new-2", "New two")],
    }
    with pytest.raises(SystemExit, match="split the subject"):
        topics.merge(existing, answer, "statistics")
    assert (
        topics.merge(
            existing, {"reused": [], "proposed": [proposal("new-1", "New one")]}, "s"
        )["subject_total"]
        == 96
    )
    assert (
        topics.merge(
            [proposal(f"t-{i}", f"Topic {i}") for i in range(62)],
            {
                "reused": [],
                "proposed": [proposal(f"new-{i}", f"New {i}") for i in range(14)],
            },
            "linguistics",
        )["subject_total"]
        == 76
    )
    with pytest.raises(SystemExit, match="kebab-case"):
        topics.merge([], {"reused": [], "proposed": [proposal("Bad_Id", "Bad")]}, "s")


def test_table_of_contents_keeps_the_top_two_levels_in_order():
    corpus = {
        "chunks": [
            {"section_path": "1 Data › 1.1 Case study › Example"},
            {"section_path": "1 Data › 1.1 Case study"},
            {"section_path": "1 Data › 1.2 Sampling"},
            {"section_path": ""},
            {"section_path": "2 Probability"},
        ]
    }
    assert topics.table_of_contents(corpus) == [
        "1 Data › 1.1 Case study",
        "1 Data › 1.2 Sampling",
        "2 Probability",
    ]


def test_table_of_contents_drops_headings_shared_by_the_whole_book():
    chunks = [{"section_path": "Contents › CHAPTER 1"}] + [
        {"section_path": f"Contents › PREFACE › Chapter {c} › {c}.{s} Topic"}
        for c in range(1, 6)
        for s in range(1, 5)
    ]
    assert topics.shared_prefix([c["section_path"] for c in chunks]) == [
        "Contents",
        "PREFACE",
    ]
    toc = topics.table_of_contents({"chunks": chunks})
    assert (
        toc[:3] == ["CHAPTER 1", "Chapter 1 › 1.1 Topic", "Chapter 1 › 1.2 Topic"]
        and len(toc) == 21
    )


def test_delegated_topics_export_import_and_stale_review(tmp_path, monkeypatch):
    book = {
        "id": "book",
        "subject_id": "statistics",
        "sha256": "a" * 64,
        "title": "Statistics",
        "edition": "1",
    }
    excerpt = {"id": "e", "pages": [1], "chunk_ids": ["c"], "section_path": "Sampling"}
    corpus = {"chunks": [{"section_path": "Sampling"}], "excerpts": [excerpt]}
    folder = tmp_path / "books" / "book"
    folder.mkdir(parents=True)
    (folder / "corpus.json").write_text(json.dumps(corpus), encoding="utf-8")
    (tmp_path / "manifest.json").write_text(
        json.dumps({"books": [book]}), encoding="utf-8"
    )
    review = tmp_path / "review.json"
    notes = {
        "roles": ["formal"],
        "synopsis": "Full notes " * 200,
        "evidence": "Source words",
    }
    review.write_text(
        json.dumps({"corrected_excerpts": [excerpt], "tags": {"e": notes}}),
        encoding="utf-8",
    )
    context_path = tmp_path / "context.json"
    proposal_path = tmp_path / "proposal.json"
    output = tmp_path / "candidate.json"
    base = [
        "topics.py",
        "--run",
        str(tmp_path),
        "--book",
        "book",
        "--review-context",
        str(review),
    ]
    monkeypatch.setattr(topics, "library_topics", lambda subject: EXISTING)

    def no_model_call(*args, **kwargs):
        pytest.fail("Delegated topics must not call another model")

    monkeypatch.setattr(topics.llm, "complete", no_model_call)
    monkeypatch.setattr(sys, "argv", [*base, "--export-context", str(context_path)])
    topics.main()
    context = json.loads(context_path.read_text(encoding="utf-8"))
    assert context["reviewed_excerpts"][0]["synopsis"] == notes["synopsis"]
    assert context["input"]["subject_id"] == "statistics"
    artifact = {
        "input": context["input"],
        "model_provenance": {
            "model": "gpt-5.6-sol",
            "reasoning_effort": "medium",
            "agent_id": "trial",
        },
        "reused": ["sampling"],
        "proposed": [proposal("regression", "Linear regression")],
    }
    proposal_path.write_text(json.dumps(artifact), encoding="utf-8")
    monkeypatch.setattr(
        sys, "argv", [*base, "--proposal", str(proposal_path), "--output", str(output)]
    )
    topics.main()
    candidate = json.loads(output.read_text(encoding="utf-8"))
    assert [t["id"] for t in candidate["topics"]] == ["sampling", "regression"]
    assert candidate["model"]["endpoint"] == "codex-subagent"
    assert candidate["model"]["usage"] is None
    assert not (tmp_path / "topics.json").exists()
    reviewed_bytes = review.read_bytes()
    review.write_bytes(reviewed_bytes + b"\n")
    with pytest.raises(ValueError, match="current book, corpus and review"):
        topics.main()
    review.write_bytes(reviewed_bytes)
    artifact["reused"] = ["missing"]
    proposal_path.write_text(json.dumps(artifact), encoding="utf-8")
    with pytest.raises(ValueError, match="unknown IDs"):
        topics.main()
    artifact["reused"] = ["sampling"]
    artifact["proposed"] = [{"id": "incomplete"}]
    proposal_path.write_text(json.dumps(artifact), encoding="utf-8")
    with pytest.raises(ValidationError):
        topics.main()
