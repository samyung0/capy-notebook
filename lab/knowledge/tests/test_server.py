import json

import pytest
import scrape
import store

import server

SHA = "d" * 64


@pytest.fixture
def books_json(tmp_path, monkeypatch):
    path = tmp_path / "books.json"
    path.write_text(
        json.dumps({"books": [{"id": "physics", "sha256": "e" * 64, "title": "P"}]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(store, "BOOKS_JSON", path)
    return path


def test_slug_avoids_builder_rows_books_json_and_library_ids(books_json, monkeypatch):
    store.add_book("a" * 64, "physics-2", {"id": "physics-2"}, "runs/x")
    monkeypatch.setattr(server, "library_query", lambda sql: {"physics-3", "algebra"})
    assert server.slug("Physics!") == "physics-4"
    assert server.slug("Algebra") == "algebra-2"
    assert server.slug("Chemistry") == "chemistry"
    monkeypatch.setattr(server, "library_query", lambda sql: None)
    with pytest.raises(ValueError, match="library is unreachable"):
        server.slug("Chemistry")


def test_add_book_takes_an_optional_edition_and_a_pdf_page_as_evidence(
    books_json, monkeypatch
):
    store.SOURCES.mkdir(parents=True)
    (store.SOURCES / f"{SHA}.pdf").write_bytes(b"%PDF-1.4 x")
    monkeypatch.setattr(scrape, "page_count", lambda path: 12)
    monkeypatch.setattr(server, "library_query", lambda sql: set())
    payload = {
        "sha256": SHA,
        "title": "Open Physics",
        "authors": ["A", " "],
        "source_url": "https://b.test/book",
        "license": "CC BY 4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "subject_id": "physics",
    }
    with pytest.raises(ValueError, match="licence evidence URL or the PDF page"):
        server.add_book(payload)
    book = server.add_book({**payload, "license_evidence_pdf_page": "2"})
    entry = book["manifest"]
    assert book["book_id"] == "open-physics" and entry["edition"] == ""
    assert entry["license_evidence_pdf_page"] == 2 and entry["pages"] == 12
    assert entry["license_evidence_url"] == "" and entry["authors"] == ["A"]
    assert entry["attribution"] == "Open Physics, A. CC BY 4.0. https://b.test/book"
    assert entry["first_content_page"] is None
    exported = json.loads(books_json.read_text(encoding="utf-8"))["books"]
    assert [b["id"] for b in exported] == ["open-physics", "physics"]
    assert (store.RUNS / "open-physics/manifest.json").exists()
    with pytest.raises(ValueError, match="already in the ingestion queue"):
        server.add_book({**payload, "license_evidence_url": "https://b.test/licence"})


def test_authorless_book_requires_review_and_preserves_attribution(
    books_json, monkeypatch
):
    import knowledge_base_library as library
    import knowledge_base_pilot as pilot

    store.SOURCES.mkdir(parents=True)
    (store.SOURCES / f"{SHA}.pdf").write_bytes(b"%PDF-1.4 x")
    monkeypatch.setattr(scrape, "page_count", lambda path: 12)
    monkeypatch.setattr(server, "library_query", lambda sql: set())
    payload = {
        "sha256": SHA,
        "title": "Physics",
        "authors": [],
        "source_url": "https://b.test/book",
        "license": "CC BY 4.0",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "subject_id": "physics",
        "license_evidence_pdf_page": "2",
    }
    for fields in [
        {},
        {"attribution_reviewed": True},
        {"attribution": "Supplied notices"},
        {"attribution_reviewed": "true", "attribution": "Supplied notices"},
    ]:
        with pytest.raises(ValueError, match="confirm attribution review"):
            server.add_book({**payload, **fields})
    reviewed = {
        **payload,
        "attribution_reviewed": True,
        "attribution": "Physics. CC BY 4.0. https://b.test/book. Supplied copyright notice.",
    }
    with pytest.raises(ValueError, match="Free Courseware"):
        server.add_book({**reviewed, "title": "Physics (Free Courseware)"})
    book = server.add_book(reviewed)
    path = store.RUNS / book["book_id"] / "manifest.json"
    entry = pilot.load_manifest(path)["books"][0]
    assert entry["authors"] == [] and entry["attribution"] == reviewed["attribution"]
    entry["attribution_reviewed"] = False
    path.write_text(json.dumps({"books": [entry]}), encoding="utf8")
    with pytest.raises(pilot.PilotError, match="attribution review"):
        pilot.load_manifest(path)
    with pytest.raises(pilot.PilotError, match="attribution review before publication"):
        library.publish_book(
            None,
            None,
            run=path.parent,
            book=entry,
            book_corpus={},
            topics=[],
            tags={},
            captures={},
            model_runs=[],
            identity="",
            note="",
        )
