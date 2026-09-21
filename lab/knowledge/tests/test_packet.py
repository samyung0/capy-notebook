import hashlib
import json
from pathlib import Path

import pytest
from packet import build_packet


def test_packet_freezes_source_notes_and_linked_context(tmp_path):
    def save(name, value):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    book = {"id": "book", "title": "Test", "sha256": "source-hash"}
    save("manifest.json", {"books": [book]})
    source = [
        {"id": eid, "text": text, "pages": [i], "section_path": "Section"}
        for i, (eid, text) in enumerate(
            [
                ("e1", "Solution without givens."),
                ("e2", "The necessary givens."),
                ("e3", "Unrelated material."),
            ],
            1,
        )
    ]
    corpus = save("books/book/corpus.json", {"book": book, "excerpts": source})
    notes = save(
        "reviewed-notes.json",
        {"tags": {"e1": {"synopsis": "Complete original note. " * 20}}},
    )
    tag = {
        "synopsis": "A shortened candidate to review.",
        "roles": ["worked_example"],
        "topic_ids": ["topic"],
        "retrieval": {
            "summary": "A solution",
            "scope": "Needs the givens in e2",
            "context_excerpt_ids": ["e2"],
        },
    }
    review = save(
        "review.json",
        {
            "source_sha256": "source-hash",
            "reviewed_excerpt_ids": ["e1"],
            "tags": {"e1": tag},
        },
    )
    catalog = save("catalog.json", [{"id": "topic"}])
    original_notes = notes.read_bytes()
    kwargs = {
        "run": tmp_path,
        "review": review,
        "catalog": catalog,
        "case_id": "test",
        "baseline_notes": notes,
        "baseline_sha256": hashlib.sha256(original_notes).hexdigest(),
    }
    packet = build_packet(**kwargs)
    assert packet["assignment"]["target_ids"] == ["e1"]
    assert packet["assignment"]["outside_assignment_ids"] == ["e2", "e3"]
    assert [e["excerpt_id"] for e in packet["source"]["excerpts"]] == ["e1", "e2"]
    assert packet["full_reviewed_notes"]["e1"] == "Complete original note. " * 20
    assert packet["final_tags"][0]["synopsis"] == tag["synopsis"]
    frozen = json.dumps(packet)
    corpus.write_text("{}", encoding="utf-8")
    notes.write_text("{}", encoding="utf-8")
    assert "The necessary givens." in frozen
    assert len(packet["provenance"]["bindings"]["corpus"]["sha256"]) == 64
    save("books/book/corpus.json", {"book": book, "excerpts": source})
    save("reviewed-notes.json", {"tags": {"e1": {"synopsis": "Full note"}}})
    with pytest.raises(ValueError, match="baseline hash"):
        build_packet(**kwargs)
    notes.write_bytes(original_notes)
    tag["retrieval"]["context_excerpt_ids"] = ["unknown"]
    save("review.json", {"source_sha256": "source-hash", "tags": {"e1": tag}})
    with pytest.raises(ValueError):
        build_packet(**kwargs)
    save("review.json", {"source_sha256": "other-source", "tags": {"e1": tag}})
    with pytest.raises(ValueError, match="source hash"):
        build_packet(**kwargs)


def test_documented_packet_works_with_review_request_without_sending():
    from knowledge_review_samples import build_request, validate_review

    example = Path(__file__).resolve().parents[1] / "examples/book-review-packet.json"
    packet = json.loads(example.read_text(encoding="utf-8"))
    request = build_request(packet)
    assert json.loads(request["messages"][1]["content"]) == packet
    assert request["enable_thinking"] is False
    assert "max_tokens" not in request
    validate_review(
        {
            "case_id": packet["case_id"],
            "review_status": "pass",
            "reviewed_ids": ["e-solution"],
            "findings": [],
            "missing_evidence": [],
        },
        packet,
    )
