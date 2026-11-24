"""Marking an uploaded paper: the read call, grading batches and the /paper route."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from pipeline.retrieval import capture, extraction, grading, paper, store

ITEMS = [{"text": "Names the mitochondrion", "marks": 1.0}]


def part(id, type, items=()):
    return paper.Part(id, type, f"{id} ({type}): Q{id}", f"Q{id}", list(items))


def graded(*ids, choice="full"):
    return json.dumps(
        {
            "parts": [
                {
                    "part": id,
                    "steps": [],
                    "vocabulary_only": False,
                    "injection_suspected": False,
                    "comment": "",
                    "items": [
                        {"id": "m0", "quote": "", "reason": "", "choice": choice}
                    ],
                }
                for id in ids
            ]
        }
    )


@pytest.fixture
def pdf(monkeypatch):
    """A paper file of `pages.count` PDF pages, rendered as a fake JPEG."""
    pages = SimpleNamespace(count=3, rendered=[])

    async def source(workspace_id, file_id):
        return {"kind": "pdf"}

    async def pdf_path(workspace_id, file_id):
        return file_id

    async def render(workspace_id, file_id, page, bbox, edge):
        pages.rendered.append((file_id, page, edge))
        return b"jpeg", [0, 0, 1000, 1000], (edge, edge)

    monkeypatch.setattr(store, "file_page_source", source)
    monkeypatch.setattr(capture, "pdf_path", pdf_path)
    monkeypatch.setattr(capture, "render_file", render)
    monkeypatch.setattr(extraction, "_page_count", lambda path: pages.count)
    return pages


def calls_with(monkeypatch, replies):
    """Records each model call and answers it by its system prompt."""
    calls = []

    async def complete(messages, **kwargs):
        calls.append((messages, kwargs))
        reply = replies(messages)
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(content=reply)

    monkeypatch.setattr(paper.models, "complete", complete)
    return calls


FILES = [{"fileId": "f1", "name": "a.pdf"}, {"fileId": "f2", "name": "b.pdf"}]


async def test_read_then_grade(monkeypatch, pdf):
    parts = [part("1", "choice"), part("2", "choice"), part("3", "open", ITEMS)]
    read = {
        "parts": [
            {"part": "1", "pages": [1, 1, 9], "answer": ["B"]},
            {"part": "2", "pages": [], "answer": ["C"]},
            {"part": "3", "pages": [5, 4]},
        ]
    }
    calls = calls_with(
        monkeypatch,
        lambda m: json.dumps(read) if m[0]["content"] == paper.R else graded("3"),
    )
    out = await paper.mark(FILES, parts, None, model=None)
    assert out["pageCount"] == 6
    assert out["parts"] == [
        {"id": "1", "pages": [1], "answer": ["B"]},
        {"id": "2", "pages": []},
        {"id": "3", "pages": [5, 4], "shares": [1.0], "comment": "", "flag": ""},
    ]
    (read_messages, read_kwargs), (grade_messages, grade_kwargs) = calls
    assert read_messages[0]["content"] == paper.R
    assert grade_kwargs["reasoning"] is False and grade_kwargs["max_tokens"] == 2000
    assert read_messages[1]["content"][0]["text"].startswith(
        "Question parts:\n1 (choice)"
    )
    assert read_kwargs["reasoning"] is False and read_kwargs["max_tokens"] == 6000
    # Pages have no faded layer: the first line as benched for them.
    assert grade_messages[0]["content"] == (
        grading.SYSTEM_PROMPT + grading.PAGE_DRAWN_SECTION + paper.P1 + paper.B
    )
    grade_content = grade_messages[1]["content"]
    assert '<part id="3">' in grade_content[0]["text"]
    assert [c.get("text") for c in grade_content[1:]] == [
        "Page 4:",
        None,
        "Page 5:",
        None,
    ]
    # Pages run on across files; every page at 1,024, the graded ones at 1,568.
    assert ("f2", 2, 1568) in pdf.rendered and len(pdf.rendered) == 8


async def test_manual_marking_reads_and_grades_nothing(monkeypatch, pdf):
    """Q716: under manual marking the read maps the open part to its pages and
    no batch grades it."""
    parts = [part("1", "choice"), part("2", "open", ITEMS)]
    read = {
        "parts": [
            {"part": "1", "pages": [1], "answer": ["A"]},
            {"part": "2", "pages": [2]},
        ]
    }
    calls = calls_with(monkeypatch, lambda m: json.dumps(read))
    out = await paper.mark(FILES, parts, None, model=None, grade=False)
    assert len(calls) == 1 and calls[0][0][0]["content"] == paper.R
    assert out["parts"] == [
        {"id": "1", "pages": [1], "answer": ["A"]},
        {"id": "2", "pages": [2]},
    ]


async def test_given_pages_skip_the_read(monkeypatch, pdf):
    parts = [part("1", "choice"), part("2", "open", ITEMS), part("3", "open", ITEMS)]
    calls = calls_with(monkeypatch, lambda m: graded("2"))
    out = await paper.mark(FILES, parts, {"2": [2]}, model=None)
    assert len(calls) == 1 and calls[0][0][0]["content"] != paper.R
    assert out["parts"][1] == {
        "id": "2",
        "pages": [2],
        "shares": [1.0],
        "comment": "",
        "flag": "",
    }
    assert out["parts"][2] == {"id": "3", "pages": []}


async def test_a_failed_batch_marks_only_its_parts(monkeypatch, pdf):
    parts = [part(str(n), "open", ITEMS) for n in range(1, 6)]
    given = {p.id: [1] for p in parts}

    def reply(messages):
        if '<part id="5">' in messages[1]["content"][0]["text"]:
            return "not json"
        return graded("1", "2", "3", "4")

    calls_with(monkeypatch, reply)
    out = await paper.mark(FILES, parts, given, model=None)
    assert [p.get("shares") for p in out["parts"][:4]] == [[1.0]] * 4
    assert out["parts"][4] == {"id": "5", "pages": [1], "error": "error"}


async def test_more_than_fifteen_pages_are_refused(pdf):
    pdf.count = 8
    with pytest.raises(paper.TooManyPages):
        await paper.mark(FILES, [part("1", "open", ITEMS)], None, model=None)


def test_the_route_refuses_too_many_pages(monkeypatch, pdf):
    from fastapi.testclient import TestClient

    from pipeline.retrieve import service

    secret = "s" * 32
    monkeypatch.setattr(service.cfg, "pipeline_secret", secret)
    monkeypatch.setattr(service.models, "resolve_query_model", lambda *a, **k: None)
    monkeypatch.setattr(service, "_bind_accounting", lambda session: None)
    pdf.count = 16
    body = {
        "thinking": "low",
        "spendSessionId": "ps_1",
        "files": [{"fileId": "f1", "name": "a.pdf"}],
        "parts": [{"id": "1", "type": "choice", "label": "1 (choice): Q"}],
        "pages": None,
    }
    http = TestClient(service.app)  # no lifespan: no database
    refused = http.post("/paper", json=body, headers={"X-Pipeline-Secret": secret})
    assert refused.status_code == 422
    assert refused.json()["detail"]["code"] == "too_many_pages"


async def test_a_pdf_that_will_not_open_is_unreadable(monkeypatch, pdf):
    """Q730: Go shows Can't read file for this refusal, on every part."""

    def broken(path):
        raise RuntimeError("cannot open broken document")

    monkeypatch.setattr(extraction, "_page_count", broken)
    with pytest.raises(extraction.ExtractionRefused) as refused:
        await paper.mark(FILES, [part("1", "open", ITEMS)], None, model=None)
    assert refused.value.code == paper.UNREADABLE
    pdf.count = 0
    monkeypatch.setattr(extraction, "_page_count", lambda path: pdf.count)
    with pytest.raises(extraction.ExtractionRefused) as refused:
        await paper.mark(FILES, [part("1", "open", ITEMS)], None, model=None)
    assert refused.value.code == paper.UNREADABLE


async def test_a_batch_failed_for_credits_says_so(monkeypatch, pdf):
    monkeypatch.setattr(
        paper.accounting, "current", lambda: SimpleNamespace(credits_exhausted=True)
    )
    calls_with(monkeypatch, lambda m: RuntimeError("only a terminal call is allowed"))
    out = await paper.mark(FILES, [part("1", "open", ITEMS)], {"1": [1]}, model=None)
    assert out["parts"] == [{"id": "1", "pages": [1], "error": "credits"}]


def test_a_batch_holds_at_most_24_images():
    """Up to four parts a call, packed in order under 24 images (Epo
    2026-11-23); a part that would pass 24 starts the next call."""
    pages = [paper.Page(n, "f1") for n in range(1, 16)]
    parts = [part(str(n), "drawing", ITEMS) for n in range(1, 4)]
    figures = [f"data:image/jpeg;base64,{n:04d}" for n in range(10)]
    parts[0].figures, parts[0].sample = figures[:5], figures[5]
    parts[1].figures = figures[6:8]
    parts[2].figures = figures[8:10]
    pages_of = {"1": list(range(1, 16)), "2": [1], "3": [2]}
    batches = paper.pack(parts, pages_of, pages)
    # 15 pages, 5 figures and a sample (21), then 2 figures (23); the third's
    # page is shown already, but its 2 figures would make 25.
    assert [[p.id for p in b] for b in batches] == [["1", "2"], ["3"]]


def test_a_paper_call_sends_each_image_once():
    """Epo's count (2026-11-23): one question of two canvas parts, a stem
    canvas, a canvas each and one drawn sample, on two pages. The stem's
    canvas goes once, with the first part; the call holds 4 question images
    and 2 pages."""
    stem, own_a, own_b, sample = (
        f"data:image/jpeg;base64,{name}"
        for name in ("U1RFTQ==", "QQ==", "Qg==", "Uw==")
    )
    a, b = part("1a", "drawing", ITEMS), part("1b", "drawing", ITEMS)
    a.figures, a.sample = [stem, own_a], sample
    b.figures = [stem, own_b]
    pages = [paper.Page(n, "f1") for n in (1, 2)]
    pages_of = {"1a": [1], "1b": [2]}
    assert paper._images([a, b], pages_of, pages) == 6
    shown = [
        c.get("text") or c["image_url"]["url"] for c in paper._batch_message([a, b])
    ]
    assert sum(text.startswith("data:") for text in shown) == 4
    i = shown.index(f'<part id="1b">\n{grading._question_and_items("Q1b", ITEMS)}')
    assert shown[i + 1 : i + 4] == [
        "Figure 1: the same image as Figure 1 in part 1a.",
        "Figure 2:",
        own_b,
    ]


def test_a_canvas_parts_sample_follows_its_figures():
    """A canvas part's drawn sample answer goes inside its <part>, after the
    question's images (Epo 2026-11-23)."""
    canvas = part("1", "drawing", ITEMS)
    canvas.figures, canvas.sample = (
        ["data:image/png;base64,Rg=="],
        "data:image/png;base64,Uw==",
    )
    content = paper._batch_message([canvas, part("2", "open", ITEMS)])
    shown = [c.get("text") or c["image_url"]["url"] for c in content]
    i = shown.index("Sample answer:")
    assert shown[i - 1].endswith("Rg==") and shown[i + 1].endswith("Uw==")
    assert shown[i + 2] == "</part>"
