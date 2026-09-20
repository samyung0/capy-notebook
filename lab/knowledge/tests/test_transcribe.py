import base64
import json

import batches
import httpx
import knowledge_base_pilot as pilot
import llm
import pytest
import store
import transcribe
from knowledge_base_batch import BatchClient, read_json, save_json

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
    page 2, no batch state."""
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

    def alibaba(messages, schema, *, stage, sha256, thinking):
        # the data URL carries the fake JPEG b"jpg" + page byte
        url = messages[0]["content"][1]["image_url"]["url"]
        page = base64.b64decode(url.split(",", 1)[1])[-1]
        calls.append((thinking, page))
        if page in fail:
            raise llm.LLMError("boom")
        return llm.Result(
            pages[page],
            "qwen3.8-flash",
            "https://alibaba.test/v1/chat/completions",
            f"req-{page}",
            {"prompt_tokens": 100, "completion_tokens": 10, "reasoning_tokens": 0},
        )

    monkeypatch.setattr(batches.llm, "alibaba", alibaba)
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
    assert transcribe.run(run_dir, "b", live=True) == 0
    assert calls == [(False, 1), (False, 2), (False, 3), (False, 4)]
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
    receipt = batches.latest_receipt(run_dir, "transcribe")
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
    assert transcribe.run(run_dir, "b", live=True) == 0 and calls == []
    assert len(transcribe.ledger(run_dir)["held"]) == 1

    # accept applies nothing for an empty span; reject records, then stays
    with pytest.raises(ValueError, match="aligned to nothing"):
        transcribe.decide(run_dir, "b", "c3", accept=True)
    transcribe.decide(run_dir, "b", "c3", accept=False)
    assert transcribe.run(run_dir, "b", live=True) == 0
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
    assert transcribe.run(run_dir, "b", live=True) == 0
    held = transcribe.ledger(run_dir)["held"]
    assert [h["chunk_id"] for h in held] == ["c3"]
    assert held[0]["aligned_text"] == "A glossary entry with many words in it."
    item = transcribe.decide(run_dir, "b", "c3", accept=True)
    assert item["decision"] == "accepted"
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][3]["text"] == "A glossary entry with many words in it."
    assert corpus["chunks"][3]["recovery"]["request_id"] == "req-3"
    assert corpus["excerpts"][2]["text"] == "A glossary entry with many words in it."
    assert transcribe.run(run_dir, "b", live=True) == 0
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][3]["text"] == "A glossary entry with many words in it."
    assert batches.latest_receipt(run_dir, "transcribe")["accepted"] == 1


def test_a_page_failing_both_live_passes_fails_the_stage(run_dir, monkeypatch):
    calls = fake_live(monkeypatch, fail={3})
    assert transcribe.run(run_dir, "b", live=True) == 1
    assert [p for t, p in calls] == [1, 2, 3, 4, 3]
    receipt = batches.latest_receipt(run_dir, "transcribe")
    assert receipt["pages_failed"] == [3] and receipt["untranscribed_ids"] == [
        "c3",
        "c4",
    ]
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][1]["text"].startswith("The speed is 10")  # the rest applied


# --- batch path ---------------------------------------------------------------


def batch_fake(monkeypatch, job, output_lines):
    """A BatchClient over a mock transport: upload, create, status, content."""
    calls = []

    def handler(request):
        path = request.url.path
        calls.append((request.method, path))
        if path.endswith("/files") and request.method == "POST":
            return httpx.Response(200, json={"id": "file-in"})
        if path.endswith("/batches") and request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1", "status": "validating"})
        if path.endswith("/batches/batch-1"):
            return httpx.Response(200, json=job)
        if path.endswith("/files/file-out/content"):
            return httpx.Response(
                200, text="".join(json.dumps(r) + "\n" for r in output_lines)
            )
        raise AssertionError(path)

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        batches,
        "client",
        lambda: BatchClient(
            "key", base_url="https://alibaba.test/v1", transport=transport
        ),
    )
    uploads = httpx.Client(base_url="https://alibaba.test/v1", transport=transport)
    monkeypatch.setattr(
        "knowledge_base_batch.requests.post",
        lambda url, **kwargs: uploads.post(
            "/files", data=kwargs["data"], files=kwargs["files"]
        ),
    )
    monkeypatch.setattr(
        transcribe,
        "upload_pages",
        lambda pages_dir, sha, pages: {p: f"https://b2.test/{p}.jpg" for p in pages},
    )
    return calls


def output_line(cid, value, usage=None, request_id="r"):
    return {
        "custom_id": cid,
        "response": {
            "status_code": 200,
            "request_id": request_id,
            "body": {
                "choices": [
                    {"finish_reason": "stop", "message": {"content": json.dumps(value)}}
                ],
                "usage": usage or {"prompt_tokens": 1000, "completion_tokens": 300},
            },
        },
    }


def test_batch_path_submits_waits_collects_retries_live_and_records_the_task(
    run_dir, monkeypatch
):
    job = {
        "id": "batch-1",
        "status": "in_progress",
        "request_counts": {"total": 4, "completed": 1, "failed": 0},
    }
    output = []
    calls = batch_fake(monkeypatch, job, output)
    live = fake_live(monkeypatch)

    assert transcribe.run(run_dir, "b") == batches.WAITING
    task = store.review_task(SHA, "transcribe")
    assert task["batch_id"] == "batch-1" and task["requests"] == 4
    assert task["status"] == "validating" and task["input_file_id"] == "file-in"
    rows = [
        json.loads(line)
        for line in (run_dir / "models/transcribe/input.jsonl").read_text().splitlines()
    ]
    assert [r["custom_id"] for r in rows] == ["b:p1", "b:p2", "b:p3", "b:p4"]
    body = rows[1]["body"]
    assert body["enable_thinking"] is False and "thinking_budget" not in body
    assert body["temperature"] == 0 and body["model"] == "qwen3.8-flash"
    assert body["response_format"]["json_schema"] == {
        "name": "review",
        "strict": True,
        "schema": transcribe.SCHEMA,
    }
    content = body["messages"][0]["content"]
    assert content[0]["text"].startswith("Describe this page from a study document")
    assert content[1]["image_url"]["url"] == "https://b2.test/2.jpg"

    # still in flight: the stage keeps waiting, the task row records the check
    assert transcribe.run(run_dir, "b") == batches.WAITING
    assert store.review_task(SHA, "transcribe")["done"] == 1 and live == []
    # the worker's poll sees the terminal state
    job.update(
        status="completed",
        output_file_id="file-out",
        created_at=100,
        completed_at=160,
        request_counts={"total": 4, "completed": 3, "failed": 1},
    )
    assert batches.poll(SHA, "transcribe") == "completed"
    assert store.review_task(SHA, "transcribe")["failed"] == 1

    # collection: pages 1, 2 and 4 answered, page 3 a provider error
    output.extend(
        [
            output_line("b:p1", PAGES[1], request_id="r1"),
            output_line(
                "b:p2",
                {
                    **PAGES[2],
                    "text": PAGES[2]["text"].replace("\n\nfine", "\\n\\nfine"),
                },
                {
                    "prompt_tokens": 1000,
                    "completion_tokens": 300,
                    "completion_tokens_details": {"reasoning_tokens": 200},
                },
                request_id="r2",
            ),
            {
                "custom_id": "b:p3",
                "response": {"status_code": 500, "body": {}},
                "error": {"code": "x"},
            },
            output_line("b:p4", PAGES[4], request_id="r4"),
        ]
    )
    assert transcribe.run(run_dir, "b") == 0
    assert live == [(False, 3)]  # one live retry, thinking off
    saved = read_json(run_dir / "pages/2.json")
    assert saved["request_id"] == "r2" and saved["source"] == "batch"
    assert saved["escaped_newlines"] == 2 and saved["text"] == PAGE_2
    assert saved["endpoint"] == "https://alibaba.test/v1/batches/batch-1"
    assert read_json(run_dir / "pages/3.json")["source"] == "live"
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert corpus["chunks"][1]["recovery"]["request_id"] == "r2"
    assert corpus["chunks"][2]["text"] == "fine passage"
    receipt = batches.latest_receipt(run_dir, "transcribe")
    assert receipt["usage"] == {
        "prompt_tokens": 3100,
        "completion_tokens": 910,
        "reasoning_tokens": 200,
    }
    assert receipt["pages_sent_live"] == 1 and receipt["escaped_newlines"] == 1
    state = read_json(run_dir / "models/transcribe/state.json")
    assert state["transport"] == "batch" and state["recorded"] and state["complete"]
    assert state["collection"] == {"success": 4, "failed": 0, "missing": 0}
    assert store.llm_usage(0)["https://alibaba.test/v1/batches"] == {
        "endpoint": "https://alibaba.test/v1/batches",
        "calls": 1,
        "ok": 1,
        "input_tokens": 3000,
        "output_tokens": 900,
    }
    assert sum(1 for m, p in calls if p.endswith("/content")) == 1

    # idempotent: a re-run collects nothing new and sends nothing
    live.clear()
    assert transcribe.run(run_dir, "b") == 0 and live == []
    assert store.llm_usage(0)["https://alibaba.test/v1/batches"]["calls"] == 1
    # --live is refused while the batch state is open
    with pytest.raises(Exception, match="batch task is open"):
        transcribe.run(run_dir, "b", live=True)

    # --redo reverts, archives the state, drops the transcriptions and submits anew
    assert transcribe.run(run_dir, "b", redo=True) == batches.WAITING
    corpus = read_json(run_dir / "books/b/corpus.json")
    assert "recovery" not in corpus["chunks"][1]
    assert corpus["chunks"][1]["text"].startswith("The speed is m/s")
    assert "description" not in corpus["figures"][1]
    assert not (run_dir / "pages/2.json").exists()
    assert sorted(p.name.split("-")[0] for p in (run_dir / "archive").iterdir()) == [
        "review",
        "transcribe",
    ]
    assert transcribe.ledger(run_dir)["held"] == []


def test_poll_records_a_missing_key_instead_of_raising(monkeypatch):
    store.add_book(SHA, "b", {"id": "b"}, "runs/b")
    store.set_review_task(
        SHA,
        "tag",
        batch_id="batch-9",
        status="in_progress",
        submitted_at=1.0,
        requests=2,
    )
    monkeypatch.delenv("ALIBABA_API_KEY", raising=False)
    monkeypatch.delenv("ALIBABA_BASE_URL", raising=False)
    assert batches.poll(SHA, "tag") == "in_progress"
    assert "ALIBABA_BASE_URL" in store.review_task(SHA, "tag")["error"]
