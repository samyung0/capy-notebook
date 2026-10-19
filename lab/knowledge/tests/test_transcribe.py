import base64

import knowledge_base_pilot as pilot
import llm
import pytest
import stages
import store
import transcribe
from knowledge_base_common import read_json, save_json

SHA = "ab" * 32
PAGE_2 = (
    "2 • Motion 14\n\nThe speed is 10 m/s and the time is 2 s, so the distance is 20 m.\n\n"
    "fine passage\n\n[Graph Image]\nFIGURE 1.2 Distance against time"
)


def chunk(i, text, page, page_end=None):
    return {
        "id": f"c{i}",
        "chunk_idx": i,
        "text": text,
        "section_path": "1 Intro",
        "indexed_text": f"1 Intro\n\n{text}",
        "page_start": page,
        "page_end": page_end or page,
        "regions": [
            {"page": page, "bbox": [0, 0, 1000, 100], "space": "page-1000-topleft"}
        ],
        "reference": False,
        "confidence": 1.0,
        "confidence_reasons": [],
        "excerpt_id": None,
    }


def excerpt(i, chunks, corpus_chunks, figure_ids=()):
    by_id = {c["id"]: c for c in corpus_chunks}
    pages = sorted(
        {p for c in chunks for p in (by_id[c]["page_start"], by_id[c]["page_end"])}
    )
    for c in chunks:
        by_id[c]["excerpt_id"] = f"e{i}"
    return {
        "id": f"e{i}",
        "section_path": "1 Intro",
        "chunk_ids": chunks,
        "text": "\n\n".join(by_id[c]["text"] for c in chunks),
        "pages": pages,
        "regions": [],
        "figure_ids": list(figure_ids),
    }


def figure(i, page, block, caption=()):
    return {
        "id": f"f{i}",
        "block_index": block,
        "page": page,
        "bbox": [0, 0, 10, 10],
        "caption_bbox": None,
        "out_of_page_bounds": False,
        "geometry_kind": "parser_image",
        "space": "page-1000-topleft",
        "original_caption": list(caption),
        "original_footnote": [],
        "section_path": "1 Intro",
        "excluded": False,
        "exclusion_evidence": [],
    }


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    """A one-book run: six chunks on pages 1-4 (c4 spans 3-4), two figures on
    page 2, no stage state."""
    book = {
        "id": "b",
        "title": "B",
        "authors": ["A"],
        "edition": "1st",
        "source_url": "https://b.test",
        "license": "CC BY 4.0",
        "license_url": "https://cc",
        "attribution": "B, A, 1st. CC BY 4.0. https://b.test",
        "pdf_path": str(tmp_path / "b.pdf"),
        "sha256": SHA,
        "subject_id": "physics",
        "pages": 4,
    }
    chunks = [
        chunk(0, "Contents 1.1 Motion", 1),  # short TOC fragment
        chunk(1, "The speed is m/s and the time is s, so the distance is m.", 2),
        chunk(2, "fine passage", 2),
        chunk(
            3,
            "A glossary entry with many words in it that the page does not carry at all",
            3,
        ),
        chunk(4, "Work is force times distance. Power is work over time here.", 3, 4),
        chunk(5, "tail of the book", 4),
    ]
    excerpts = [
        excerpt(0, ["c0"], chunks),
        excerpt(1, ["c1", "c2"], chunks, ["f1", "f2"]),
        excerpt(2, ["c3"], chunks),
        excerpt(3, ["c4", "c5"], chunks),
    ]
    corpus = {
        "book": {"id": "b", "pages": 4},
        "source_id": pilot.book_identity(book),
        "content_hash": "old",
        "chunks": chunks,
        "excerpts": excerpts,
        "figures": [
            figure(1, 2, 3),
            figure(2, 2, 5, ["Figure 1.2 Distance against time"]),
        ],
    }
    run = tmp_path / "runs/b"
    save_json(run / "manifest.json", {"books": [book]})
    save_json(run / "books/b/corpus.json", corpus)
    save_json(run / "models/review/state.json", {"transport": "batch", "model": "old"})
    store.add_book(SHA, "b", book, str(run))

    def fake_render(pdf, pages_dir, pages):
        pages_dir.mkdir(parents=True, exist_ok=True)
        for p in pages:
            (pages_dir / f"{p}.jpg").write_bytes(b"jpg" + bytes([p]))
        return len(pages)

    monkeypatch.setattr(transcribe, "render_pages", fake_render)
    monkeypatch.setenv("ALIBABA_API_KEY", "key")
    monkeypatch.setenv("ALIBABA_BASE_URL", "https://alibaba.test/v1")
    return run


PAGES = {
    1: {"text": "Preface\n\nThis book is open.", "figures": []},
    2: {
        "text": PAGE_2,
        "figures": [
            {"label": "", "description": "a photo of a train"},
            {"label": "Figure 1.2", "description": "a line from (0, 0) to (70, 140)"},
        ],
    },
    3: {"text": "Glossary\n\nWork is force times", "figures": []},
    4: {
        "text": "distance. Power is work over time here.\n\ntail of the book",
        "figures": [],
    },
}


def fake_live(monkeypatch, pages=PAGES, fail=()):
    """The live endpoint answering each page from `pages`; `fail` pages raise."""
    calls = []

    def alibaba(messages, schema, *, stage, sha256):
        # the data URL carries the fake JPEG b"jpg" + page byte
        url = messages[0]["content"][1]["image_url"]["url"]
        page = base64.b64decode(url.split(",", 1)[1])[-1]
        calls.append(page)
        if page in fail:
            raise llm.LLMError("boom")
        return llm.Result(
            pages[page],
            "qwen3.8-flash",
            "https://alibaba.test/v1/chat/completions",
            f"req-{page}",
            {"prompt_tokens": 100, "completion_tokens": 10, "reasoning_tokens": 0},
        )

    monkeypatch.setattr(stages.llm, "alibaba", alibaba)
    return calls


# --- alignment ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("original", "page", "outcome", "span"),
    [
        # exact
        (
            "fine passage here",
            "x\n\nfine passage here\n\ny",
            "apply",
            "fine passage here",
        ),
        # dropped numbers restored
        (
            "The speed is m/s and the time is s, so the distance is m.",
            PAGE_2,
            "apply",
            "The speed is 10 m/s and the time is 2 s, so the distance is 20 m.",
        ),
        # coverage below 0.9 held
        (
            "A glossary entry with many words in it that the page does not carry at all",
            PAGE_2,
            "hold",
            "",
        ),
        # the original's halves far apart on the page: the span held by ratio
        ("a b c d e f g h", "a b c d " + "z " * 40 + "e f g h", "hold", None),
        # short fragment skipped
        ("Contents 1.1 Motion", PAGE_2, "short", ""),
    ],
)
def test_alignment_table(original, page, outcome, span):
    verdict = transcribe.judge(original, page)
    assert verdict["outcome"] == outcome
    if span is not None:
        assert verdict["span"] == span
    if outcome == "hold":
        assert verdict["reason"].startswith(("coverage", "length ratio"))


def test_short_blocks_in_a_tight_gap_extend_the_span():
    # "Fnet" glued by the parser never matches "F_net"; the answer list still
    # rides along two words at a time, the next question does not.
    span, coverage = transcribe.align(
        "How do you express that no force acts? a. Fnet = 1 b. Fnet = 0",
        "6. How do you express that no force acts?\na. F_net = -1\nb. F_net = 0\n\n7. Next one",
    )
    assert span == "How do you express that no force acts?\na. F_net = -1\nb. F_net = 0"
    assert round(coverage, 3) == round(12 / 14, 3)


def test_escaped_newlines_unescape_except_latex_commands():
    escaped = "a\\nb\\n\\nc \\neq d \\nabla e \\nu f\\nNewton \\nthe"
    text, n = transcribe.ESCAPED_NEWLINE.subn("<nl>", escaped)
    assert (
        text == "a<nl>b<nl><nl>c \\neq d \\nabla e \\nu f<nl>Newton <nl>the" and n == 5
    )


def test_page_spanning_chunk_aligns_across_its_pages():
    original = "Work is force times distance. Power is work over time here."
    page = "\n".join(PAGES[p]["text"] for p in (3, 4))
    span, coverage = transcribe.align(original, page)
    assert coverage == 1
    assert span == "Work is force times\ndistance. Power is work over time here."


# --- figures ------------------------------------------------------------------


def test_figures_match_by_label_then_by_order():
    figs = [figure(1, 2, 3), figure(2, 2, 5, ["Figure 1.2 Distance"]), figure(3, 2, 9)]
    returned = [
        {"label": "FIGURE 1.2", "description": "a line"},
        {"label": "", "description": "a photo"},
        {"label": "", "description": "a table"},
    ]
    pairs = transcribe.match_figures(returned, figs)
    assert [(c["id"], r["description"]) for c, r in pairs] == [
        ("f2", "a line"),
        ("f1", "a photo"),
        ("f3", "a table"),
    ]
    # more returned than corpus figures: the extra is dropped
    assert len(transcribe.match_figures(returned, figs[:1])) == 1
    assert transcribe.label_number("fig. 4.10 Forces") == "4.10"
    assert transcribe.label_number("a photo") is None


def test_descriptions_land_on_the_first_chunk_of_the_excerpt_indexed_text(run_dir):
    corpus = read_json(run_dir / "books/b/corpus.json")
    texts = {2: {**PAGES[2], "model": "m", "request_id": "r"}}
    assert transcribe.describe_figures(corpus, texts) == 2
    by_id = {f["id"]: f for f in corpus["figures"]}
    assert by_id["f2"]["description"] == "a line from (0, 0) to (70, 140)"
    assert by_id["f2"]["label"] == "Figure 1.2" and by_id["f1"]["label"] == ""
    transcribe.rebuild_indexed_text(corpus)
    c1, c2 = corpus["chunks"][1], corpus["chunks"][2]
    assert c1["indexed_text"] == (
        "1 Intro\n\n" + c1["text"] + "\n\n[Figure] a photo of a train"
        "\n\n[Figure Figure 1.2] a line from (0, 0) to (70, 140)"
    )
    assert c2["indexed_text"] == "1 Intro\n\nfine passage"  # never on the text
    assert "[Figure" not in c1["text"]


# --- live path, apply, held ledger ---------------------------------------------


def test_live_path_aligns_holds_skips_and_describes(run_dir, monkeypatch):
    calls = fake_live(monkeypatch)
    assert transcribe.run(run_dir, "b") == 0
    assert calls == [1, 2, 3, 4]
    corpus = read_json(run_dir / "books/b/corpus.json")
    c = {x["id"]: x for x in corpus["chunks"]}
    assert (
        c["c1"]["text"]
        == "The speed is 10 m/s and the time is 2 s, so the distance is 20 m."
    )
    assert c["c1"]["recovery"]["method"] == "align"
    assert c["c1"]["recovery"]["original_text"].startswith("The speed is m/s")
    assert (
        c["c1"]["recovery"]["request_id"] == "req-2"
        and c["c1"]["recovery"]["coverage"] == 1
    )
    assert (
        c["c2"]["text"] == "fine passage" and "recovery" not in c["c2"]
    )  # two words: no anchor
    assert (
        c["c4"]["text"]
        == "Work is force times\ndistance. Power is work over time here."
    )
    assert c["c4"]["recovery"]["request_id"] == "req-3"  # the first page's answer
    assert c["c0"]["text"] == "Contents 1.1 Motion" and c["c3"]["text"].startswith(
        "A glossary"
    )
    assert corpus["excerpts"][1]["text"] == c["c1"]["text"] + "\n\nfine passage"
    assert corpus["content_hash"] != "old" and len(corpus["content_hash"]) == 64
    assert c["c1"]["indexed_text"].endswith(
        "[Figure Figure 1.2] a line from (0, 0) to (70, 140)"
    )
    for page in (1, 2, 3, 4):
        saved = read_json(run_dir / "pages" / f"{page}.json")
        assert saved["text"] == PAGES[page]["text"] and saved["source"] == "live"
    held = transcribe.ledger(run_dir)["held"]
    assert [h["chunk_id"] for h in held] == ["c3"] and held[0]["decision"] is None
    assert held[0]["reason"].startswith("coverage 0.") and held[0]["pages"] == [3]
    assert (
        held[0]["transcription"] == PAGES[3]["text"] and held[0]["aligned_text"] == ""
    )
    assert transcribe.undecided(run_dir) == held
    receipt = stages.latest_receipt(run_dir, "transcribe")
    assert receipt["pages"] == 4 and receipt["pages_transcribed"] == 4
    assert receipt["aligned"] == 3 and receipt["changed"] == 2 and receipt["held"] == 1
    assert receipt["unaligned_short"] == 2 and receipt["unaligned_short_ids"] == [
        "c0",
        "c2",
    ]
    assert receipt["figures_described"] == 2 and receipt["untranscribed"] == 0
    assert receipt["usage"] == {
        "prompt_tokens": 400,
        "completion_tokens": 40,
        "reasoning_tokens": 0,
    }
    state = read_json(run_dir / "models/transcribe/state.json")
    assert state["transport"] == "live" and state["collection"]["success"] == 4
    assert state["normal_requests"] == 4 and state["complete"]
    # the review-stage model directory left the loader's walk
    assert not (run_dir / "models/review").exists()
    assert [p.name.split("-")[0] for p in (run_dir / "archive").iterdir()] == ["review"]

    # a re-run re-aligns from the saved transcriptions without a call
    calls.clear()
    assert transcribe.run(run_dir, "b") == 0 and calls == []
    assert len(transcribe.ledger(run_dir)["held"]) == 1

    # accept applies nothing for an empty span; reject records, then stays
    with pytest.raises(ValueError, match="aligned to nothing"):
        transcribe.decide(run_dir, "b", "c3", accept=True)
    transcribe.decide(run_dir, "b", "c3", accept=False)
    assert transcribe.run(run_dir, "b") == 0
    assert transcribe.ledger(run_dir)["held"][0]["decision"] == "rejected"
    assert transcribe.undecided(run_dir) == []
    with pytest.raises(ValueError, match="already rejected"):
        transcribe.decide(run_dir, "b", "c3", accept=True)


def test_accepting_a_held_span_applies_it_and_survives_a_rerun(run_dir, monkeypatch):
    pages = {
        **PAGES,
        3: {
            "text": "Glossary\n\nA glossary entry with many words in it. Work is force times",
            "figures": [],
        },
    }
    fake_live(monkeypatch, pages)
    monkeypatch.setattr(transcribe, "COVERAGE", 0.99)  # holds c3 at 0.5 coverage
    assert transcribe.run(run_dir, "b") == 0
    held = transcribe.ledger(run_dir)["held"]
    assert [h["chunk_id"] for h in held] == ["c3"]
    assert held[0]["aligned_text"] == "A glossary entry with many words in it."
    item = transcribe.decide(run_dir, "b", "c3", accept=True)
    assert item["decision"] == "accepted"
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][3]["text"] == "A glossary entry with many words in it."
    assert corpus["chunks"][3]["recovery"]["request_id"] == "req-3"
    assert corpus["excerpts"][2]["text"] == "A glossary entry with many words in it."
    assert transcribe.run(run_dir, "b") == 0
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][3]["text"] == "A glossary entry with many words in it."
    assert stages.latest_receipt(run_dir, "transcribe")["accepted"] == 1


def test_a_page_failing_both_live_passes_fails_the_stage(run_dir, monkeypatch):
    calls = fake_live(monkeypatch, fail={3})
    assert transcribe.run(run_dir, "b") == 1
    assert calls == [1, 2, 3, 4, 3]
    receipt = stages.latest_receipt(run_dir, "transcribe")
    assert receipt["pages_failed"] == [3] and receipt["untranscribed_ids"] == [
        "c3",
        "c4",
    ]
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][1]["text"].startswith("The speed is 10")  # the rest applied


def test_redo_reverts_and_sends_every_page_again(run_dir, monkeypatch):
    calls = fake_live(monkeypatch)
    assert transcribe.run(run_dir, "b") == 0
    calls.clear()
    assert transcribe.run(run_dir, "b", redo=True) == 0
    assert calls == [1, 2, 3, 4]
    assert sorted(p.name.split("-")[0] for p in (run_dir / "archive").iterdir()) == [
        "review",
        "transcribe",
    ]
