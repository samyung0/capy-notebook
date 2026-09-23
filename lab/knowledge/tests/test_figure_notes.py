"""Book agents' figure notes on the corpus: the figures.json applier, their
survival across refresh-figures, the search text they add and the corpus
identity they enter."""

import copy

import knowledge_base_library as library
import knowledge_base_pilot as pilot
import pytest
import transcribe
from knowledge_base_batch import PilotError, digest, read_json, save_json

BOOK = {
    "id": "b",
    "edition": "1st",
    "sha256": "ab" * 32,
    "source_url": "https://b.test",
    "license": "CC BY 4.0",
}
BLOCKS = [
    {"type": "image", "bbox": [0, 0, 500, 500], "page_idx": 0, "image_caption": []},
    {"type": "image", "bbox": [0, 600, 500, 900], "page_idx": 0, "image_caption": []},
]
NOTES = {
    "label": "Figure 1.1 Sleep",
    "description": "A curve.",
    "credit": "CC BY 4.0",
    "decorative": False,
}


@pytest.fixture
def run(tmp_path):
    identity = pilot.book_identity(BOOK)
    figures = pilot.figure_records(BLOCKS, identity, [])
    chunks = [
        {
            "id": "c0",
            "text": "Sleep has stages.",
            "section_path": "1 Sleep",
            "indexed_text": "1 Sleep\n\nSleep has stages.",
            "page_start": 1,
            "page_end": 1,
            "regions": [{"page": 1, "bbox": [0, 0, 1000, 1000]}],
            "reference": False,
            "confidence": 1.0,
            "confidence_reasons": [],
        }
    ]
    corpus = {
        "book": {**BOOK, "pages": 1},
        "source_id": identity,
        "content_hash": "h",
        "chunks": chunks,
        "excerpts": pilot.build_excerpts(chunks, identity, figures),
        "figures": figures,
        "metrics": {"parse_seconds": 1.0},
    }
    transcribe.refresh(corpus)
    save_json(tmp_path / "manifest.json", {"books": [BOOK]})
    save_json(tmp_path / "books/b/corpus.json", corpus)
    save_json(tmp_path / "books/b/parsed/content_list.json", BLOCKS)
    save_json(
        tmp_path / "books/b/parsed/manifest.json",
        {"parse_receipt": {"measurements": {"_server_parse_ms": 900}}},
    )
    return tmp_path


def notes_for(run, **overrides):
    path = run / "books/b/corpus.json"
    figures = read_json(path)["figures"]
    entries = [{"figure_id": f["id"], "page": f["page"], **NOTES} for f in figures]
    entries[1].update(label="", description="Header band.", credit="", decorative=True)
    return {
        "book_id": "b",
        "corpus_sha256": pilot.sha_file(path),
        "model_provenance": {"model": "m"},
        "figures": entries,
        **overrides,
    }


def noted(run, notes=None):
    """The run's corpus with its figures.json applied, as figure-notes does."""
    path = run / "books/b/corpus.json"
    corpus = read_json(path)
    count = pilot.apply_figure_notes(
        corpus, pilot.sha_file(path), notes or notes_for(run)
    )
    return corpus, count


def test_applier_writes_the_four_fields_and_nothing_else(run):
    before = read_json(run / "books/b/corpus.json")
    after, count = noted(run)
    assert count == 2
    assert after["figures"][0] == {**before["figures"][0], **NOTES}
    assert after["figures"][1]["decorative"] is True
    for figure in after["figures"]:
        for key in pilot.FIGURE_NOTES:
            figure.pop(key)
    assert after == before


@pytest.mark.parametrize(
    "broken",
    [
        lambda n: n.update(corpus_sha256="0" * 64),
        lambda n: n.update(book_id="other"),
        lambda n: n["figures"].pop(),  # a record left out
        lambda n: n["figures"].append(dict(n["figures"][0])),  # one named twice
        lambda n: n["figures"][0].update(figure_id="fig_unknown"),
        lambda n: n["figures"][0].update(page=2),
        lambda n: n["figures"][0].update(decorative="no"),
        lambda n: n["figures"][0].update(page=True),
        lambda n: n["figures"][0].pop("credit"),
        lambda n: n["figures"][0].update(evidence="p1"),
    ],
)
def test_applier_refuses_a_figures_json_that_does_not_fit_the_corpus(run, broken):
    notes = notes_for(run)
    broken(notes)
    with pytest.raises(PilotError):
        noted(run, notes)


def test_notes_reach_the_search_text_at_refresh_and_nothing_else_moves(run):
    """figure-notes refreshes after applying, so a figure-only cleanup
    republishes the new notes without the decorative one."""
    before = read_json(run / "books/b/corpus.json")
    corpus, _ = noted(run)
    transcribe.refresh(corpus)
    assert corpus["chunks"][0]["indexed_text"] == (
        "1 Sleep\n\nSleep has stages.\n\n[Figure Figure 1.1 Sleep] A curve."
    )
    assert corpus["content_hash"] == before["content_hash"]
    assert corpus["excerpts"] == before["excerpts"]


def test_refresh_figures_keeps_the_notes_and_applies_exclusions(run, monkeypatch):
    # No source PDF: no drawings, so figure_records' output comes back as is.
    monkeypatch.setattr(pilot, "drawing_records", lambda *args: args[-1])
    path = run / "books/b/corpus.json"
    corpus, _ = noted(run)
    noted_figures = copy.deepcopy(corpus["figures"])
    corpus["book"]["figure_exclusions"] = [{"page": 1, "bbox": BLOCKS[1]["bbox"]}]
    save_json(path, corpus)
    pilot.refresh_figures(read_json(run / "manifest.json"), run)
    refreshed = read_json(path)["figures"]
    assert [f["excluded"] for f in refreshed] == [False, True]
    for old, new in zip(noted_figures, refreshed):
        assert {k: new[k] for k in pilot.FIGURE_NOTES} == {
            k: old[k] for k in pilot.FIGURE_NOTES
        }


def test_search_text_skips_decorative_figures_and_keeps_excluded_ones():
    def figure(i, **fields):
        return {"id": f"f{i}", "excluded": False, "description": f"shows {i}", **fields}

    corpus = {
        "chunks": [{"id": "c0", "section_path": "1 Sleep", "text": "Stages."}],
        "excerpts": [{"chunk_ids": ["c0"], "figure_ids": ["f1", "f2", "f3", "f4"]}],
        "figures": [
            figure(1, label="Figure 1.1 Sleep"),
            figure(2, decorative=True),
            figure(3, excluded=True, label="Figure 1.3"),
            figure(4),
        ],
    }
    transcribe.rebuild_indexed_text(corpus)
    assert corpus["chunks"][0]["indexed_text"] == (
        "1 Sleep\n\nStages.\n\n[Figure Figure 1.1 Sleep] shows 1"
        "\n\n[Figure Figure 1.3] shows 3\n\n[Figure] shows 4"
    )


PIN = {"embedding_model_slug": "Qwen"}
TAGS = {"tags": {"e1": {"roles": ["formal"]}}}


def identity_corpus(figures):
    return {
        "source_id": "s",
        "content_hash": "h",
        "parser_fingerprint": "fp",
        "chunker_version": "v10",
        "release_sha": "sha",
        "excerpts": [{"id": "e1"}],
        "figures": figures,
    }


def test_identity_of_a_book_without_figure_notes_is_unchanged():
    """The digest published versions were stored under, byte for byte, also for
    a book whose figures carry transcribe's label and description."""
    before = digest(
        {
            "source_id": "s",
            "content_hash": "h",
            "parser_fingerprint": "fp",
            "chunker_version": "v10",
            "release_sha": "sha",
            "pin": PIN,
            "tags": {"e1": {"roles": ["formal"]}},
        }
    )
    transcribed = {"id": "f1", "excluded": False, "label": "FIG 1", "description": "x"}
    for figures in ([], [{"id": "f1", "excluded": True}], [transcribed]):
        assert library.corpus_identity(identity_corpus(figures), PIN, TAGS) == before


def test_identity_of_a_noted_book_covers_its_notes_and_exclusions():
    figure = {"id": "f1", "excluded": False, **NOTES}
    base = library.corpus_identity(identity_corpus([figure]), PIN, TAGS)
    unnoted = library.corpus_identity(identity_corpus([]), PIN, TAGS)
    assert base != unnoted, "a figure-only cleanup republishes"
    for change in (
        {"credit": "CC BY-SA 4.0"},
        {"decorative": True},
        {"label": ""},
        {"description": "A line."},
        {"excluded": True},
    ):
        changed = identity_corpus([figure | change])
        assert library.corpus_identity(changed, PIN, TAGS) != base, change
    assert library.corpus_identity(identity_corpus([dict(figure)]), PIN, TAGS) == base
    # a transcribe --redo pops label and description and keeps credit and decorative
    redone = {k: v for k, v in figure.items() if k not in ("label", "description")}
    assert library.corpus_identity(identity_corpus([redone]), PIN, TAGS) != base
