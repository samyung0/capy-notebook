import copy
import hashlib
import json

import enrich
import knowledge_base_pilot as pilot
import pytest

from pipeline.retrieval.knowledge_metadata import indexed_text, validate_metadata


def test_review_import_preserves_full_notes_and_refuses_stale_or_invalid_context(
    tmp_path,
    monkeypatch,
):
    corpus_dir = tmp_path / "books/book"
    corpus_dir.mkdir(parents=True)
    excerpts = [
        {"id": "objectives", "text": "Learning objectives", "pages": [1]},
        {"id": "solution", "text": "The solution uses R.", "pages": [2]},
    ]
    (corpus_dir / "corpus.json").write_text(
        json.dumps({"book": {"sha256": "sha", "pages": 2}, "excerpts": excerpts})
    )
    notes = "Full existing synopsis " * 500
    tag = {
        "roles": ["introduction"],
        "topic_ids": ["stats"],
        "confidence": 0.95,
        "synopsis": notes,
        "evidence": "Learning objectives",
    }
    original = {
        "tags": {"objectives": tag, "solution": {"keep": "unchanged"}},
        "failed_tags": {},
        "review_items": [],
        "topics": [{"id": "stats"}],
    }
    raw = json.dumps(original).encode()
    (tmp_path / "tags.json").write_bytes(raw)
    (tmp_path / "topics.json").write_text(json.dumps({"topics": [{"id": "stats"}]}))
    metadata = {
        "summary": "Lists objectives",
        "scope": "No explanation of statistics.",
        "context_excerpt_ids": [],
    }
    reviewed = {
        **tag,
        "roles": ["non_teaching"],
        "topic_ids": [],
        "retrieval": metadata,
    }
    artifact = {
        "book_id": "book",
        "source_sha256": "sha",
        "base_tags_sha256": hashlib.sha256(raw).hexdigest(),
        "model_provenance": {"model": "gpt-5.6-sol"},
        "inspection_records": [
            {
                "pdf_page": 1,
                "rendered_page_path": "page1.png",
                "observation": "Only objectives are present.",
            }
        ],
        "tags": {"objectives": reviewed},
    }
    updated, receipt = enrich.validate(tmp_path, artifact)
    assert updated["tags"]["solution"] == original["tags"]["solution"]
    assert updated["tags"]["objectives"]["synopsis"] == notes
    assert updated["review_items"] == [] and receipt["non_teaching"] == 1
    assert (tmp_path / "tags.json").read_bytes() == raw, (
        "validation alone cannot mutate the run"
    )
    with pytest.raises(ValueError, match="tags changed"):
        enrich.validate(tmp_path, {**artifact, "base_tags_sha256": "stale"})
    with pytest.raises(ValueError, match="erase full existing notes"):
        enrich.validate(
            tmp_path,
            {**artifact, "tags": {"objectives": {**reviewed, "synopsis": " "}}},
        )
    for records in (
        [],
        [{"pdf_page": 3, "rendered_page_path": "p.png", "observation": "Outside book"}],
        [
            {
                "pdf_page": 2,
                "rendered_page_path": "p.png",
                "observation": "Outside reviewed scope",
            }
        ],
    ):
        with pytest.raises(ValueError, match="inspection"):
            enrich.validate(tmp_path, {**artifact, "inspection_records": records})
    for links in (["objectives"], ["other-book"], ["solution", "solution"]):
        with pytest.raises(ValueError, match="context"):
            validate_metadata(
                {**metadata, "context_excerpt_ids": links},
                "objectives",
                {e["id"] for e in excerpts},
            )
    mixed = copy.deepcopy(reviewed)
    mixed["roles"].append("exercise")
    with pytest.raises(pilot.PilotError, match="schema"):
        pilot.tag_outputs(
            {"objectives": mixed}, {e["id"]: e for e in excerpts}, {"stats"}
        )
    with pytest.raises(pilot.PilotError, match="schema"):
        pilot.tag_outputs(
            {"objectives": {**tag, "roles": ["formal", "formal"]}},
            {e["id"]: e for e in excerpts},
            {"stats"},
        )
    text = "Original corrected source"
    assert indexed_text(text, None) == text
    assert indexed_text(text, metadata).startswith(text)
    assert metadata["scope"] in indexed_text(text, metadata)

    artifact_path = tmp_path / "review.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
    monkeypatch.setattr(
        "sys.argv",
        ["enrich", "--run", str(tmp_path), "--artifact", str(artifact_path), "--apply"],
    )
    enrich.main()
    saved_notes = json.loads((tmp_path / "reviewed-notes.json").read_text())
    assert saved_notes["tags"]["objectives"]["synopsis"] == notes
    assert saved_notes["tags"]["objectives"]["retrieval"] == metadata


@pytest.mark.asyncio
async def test_index_refuses_final_topic_assignment_that_drops_review(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(pilot, "corpora", lambda *_: [])
    tag = {
        "synopsis": "Full reviewed notes to preserve",
        "retrieval": {
            "summary": "Teaches a method",
            "scope": "General",
            "context_excerpt_ids": [],
        },
    }
    pilot.save_json(tmp_path / "reviewed-notes.json", {"tags": {"excerpt": tag}})
    for field in ("retrieval", "synopsis"):
        shortened = {key: value for key, value in tag.items() if key != field}
        pilot.save_json(tmp_path / "tags.json", {"tags": {"excerpt": shortened}})
        with pytest.raises(pilot.PilotError, match="Final tags lost or changed"):
            await pilot.index_books({}, {}, tmp_path)
