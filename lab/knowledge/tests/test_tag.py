import json

import batches
import httpx
import knowledge_base_pilot as pilot
import llm
import pytest
import store
import tag
from knowledge_base_batch import BatchClient, read_json, save_json

SHA = "cd" * 32
TOPICS = [
    {
        "id": "t1",
        "label": "Topic one",
        "aliases": ["one"],
        "scope": "",
        "source_sections": "",
    },
    {
        "id": "t2",
        "label": "Topic two",
        "aliases": [],
        "scope": "",
        "source_sections": "",
    },
]


def excerpt(i, text):
    return {
        "id": f"e{i}",
        "section_path": "1 Intro",
        "chunk_ids": [f"c{i}"],
        "text": text,
        "pages": [i + 1],
        "regions": [],
        "figure_ids": [],
    }


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    """A one-book run with ten excerpts (two groups of eight and two)."""
    monkeypatch.setattr(tag, "GROUP", 8)
    book = {
        "id": "b",
        "sha256": SHA,
        "title": "B",
        "edition": "",
        "source_url": "https://b.test",
        "license": "CC BY 4.0",
        "subject_id": "physics",
        "pages": 10,
    }
    excerpts = [
        excerpt(i, f"Excerpt number {i} says that the speed is {i} m/s here.")
        for i in range(10)
    ]
    corpus = {
        "book": {"id": "b"},
        "source_id": pilot.book_identity(book),
        "chunks": [{"id": f"c{i}", "text": e["text"]} for i, e in enumerate(excerpts)],
        "excerpts": excerpts,
        "figures": [],
    }
    run = tmp_path / "runs/b"
    save_json(run / "manifest.json", {"books": [book]})
    save_json(run / "books/b/corpus.json", corpus)
    save_json(run / "topics.json", {"subject_id": "physics", "topics": TOPICS})
    store.add_book(SHA, "b", book, str(run))
    monkeypatch.setenv("ALIBABA_API_KEY", "key")
    monkeypatch.setenv("ALIBABA_BASE_URL", "https://alibaba.test/v1")
    return run


def sent_ids(messages):
    return [e["id"] for e in json.loads(messages[1]["content"])["excerpts"]]


def entry(excerpt_id, evidence):
    return {
        "id": excerpt_id,
        "roles": ["formal"],
        "topic_ids": ["t1"],
        "confidence": 0.9,
        "evidence": evidence,
        "synopsis": "one line",
    }


def answer(messages, skip=(), evidence=None):
    ids = sent_ids(messages)
    return {
        "excerpts": [
            entry(i, evidence or f"the SPEED is {i[1:]}  m/s")
            for i in ids
            if i not in skip
        ]
    }


def fake_live(monkeypatch, make_value):
    calls = []

    def alibaba(messages, schema, *, stage, sha256, thinking):
        calls.append((thinking, sent_ids(messages)))
        return llm.Result(
            make_value(messages),
            "qwen3.8-flash",
            "https://alibaba.test/v1/chat/completions",
            f"req-{len(calls)}",
            {"prompt_tokens": 100, "completion_tokens": 10, "reasoning_tokens": 0},
        )

    monkeypatch.setattr(batches.llm, "alibaba", alibaba)
    return calls


# --- verifier -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("evidence", "verified"),
    [
        ("the speed is 3 m/s", True),
        ("The  SPEED is 3 M/S", True),  # case and whitespace
        (
            "Excerpt number 3 ... the speed is 3 m/s",
            True,
        ),  # ellipsis, every piece verbatim
        ("Excerpt number 3 … speed is 3 m/s here", True),
        ("Excerpt number 3 ... the speed is 4 m/s", False),  # one piece off
        ("the speed was 3 m/s", False),
        ("...", False),
        ("", False),
        (None, False),
    ],
)
def test_tolerant_verifier_table(evidence, verified):
    text = "Excerpt number 3 says that\nthe speed is 3 m/s here."
    assert pilot.evidence_verified(evidence, text) is verified


# --- live path, batching, ceiling ---------------------------------------------


def test_eight_per_request_and_a_missing_excerpt_is_resent_singly(run_dir, monkeypatch):
    calls = fake_live(
        monkeypatch,
        lambda m: answer(m, skip=("e3",)) if len(sent_ids(m)) > 1 else answer(m),
    )
    assert tag.run(run_dir, "b", live=True) == 0
    assert calls == [
        (False, [f"e{i}" for i in range(8)]),
        (False, ["e8", "e9"]),
        (False, ["e3"]),
    ]
    tags = read_json(run_dir / "tags.json")
    assert sorted(tags["tags"]) == [f"e{i}" for i in range(10)]
    assert all(t["evidence_verified"] for t in tags["tags"].values())
    assert tags["model_transport"] == "live" and tags["batch_id"] is None
    assert tags["failed_tags"] == {} and tags["review_items"] == []
    assert read_json(run_dir / "topics.json")["excerpts"] == {"t1": 10, "t2": 0}
    receipt = batches.latest_receipt(run_dir, "tag")
    assert receipt["groups"] == 2 and receipt["sent_live"] == 3
    assert (
        receipt["tagged"] == 10
        and receipt["verified_rate"] == 1
        and receipt["failed"] == 0
    )
    assert receipt["usage"]["prompt_tokens"] == 300
    state = read_json(run_dir / "models/tag/state.json")
    assert (
        state["transport"] == "live"
        and state["normal_requests"] == 3
        and state["complete"]
    )
    # the prompt: candidates in the system prefix, corrected text in the user turn
    system = json.loads((run_dir / "models/tag/live.json").read_text(encoding="utf-8"))
    assert system["success"]["b:e3"]["value"]["excerpts"][0]["id"] == "e3"
    # a re-run sends nothing
    calls.clear()
    assert tag.run(run_dir, "b", live=True) == 0 and calls == []

    # tags.json: byte-for-byte the shape apply_tags writes from the same outputs
    other = run_dir.parent / "pilot"
    corpus = read_json(run_dir / "books/b/corpus.json")
    save_json(other / "manifest.json", read_json(run_dir / "manifest.json"))
    save_json(other / "books/b/corpus.json", corpus)
    save_json(other / "topics.json", {"subject_id": "physics", "topics": TOPICS})
    outputs = {
        e["id"]: {
            k: v
            for k, v in entry(e["id"], f"the SPEED is {e['id'][1:]}  m/s").items()
            if k != "id"
        }
        for e in corpus["excerpts"]
    }
    save_json(
        other / "models/tags/state.json",
        {
            "complete": True,
            "transport": "live",
            "batch_id": None,
            "request_ids": list(outputs),
        },
    )
    save_json(
        other / "models/tags/results.json",
        {
            "success": {k: {"value": v} for k, v in outputs.items()},
            "failed": {},
            "missing": [],
        },
    )
    theirs = pilot.apply_tags(read_json(other / "manifest.json"), other)
    assert tags == json.loads(json.dumps(theirs))


def test_more_than_two_percent_untagged_fails_without_tags_json(run_dir, monkeypatch):
    calls = fake_live(
        monkeypatch, lambda m: answer(m, skip=("e3",), evidence="nowhere")
    )
    assert tag.run(run_dir, "b", live=True) == 1
    assert [c[1] for c in calls][-1] == ["e3"]
    assert not (run_dir / "tags.json").exists()
    receipt = batches.latest_receipt(run_dir, "tag")
    assert (
        receipt["failed"] == 1
        and receipt["failed_ids"] == ["e3"]
        and receipt["tagged"] == 9
    )
    assert receipt["verified"] == 0 and receipt["review_items"] == 9


def test_messages_carry_candidates_in_the_prefix_and_the_evidence_rule():
    messages = tag.messages([excerpt(1, "text one")], TOPICS)
    assert messages[0]["role"] == "system"
    assert "contiguous span of 5 to 30 words copied exactly" in messages[0]["content"]
    assert json.loads(messages[0]["content"].split("\n")[-1]) == [
        {"id": "t1", "label": "Topic one", "aliases": ["one"]},
        {"id": "t2", "label": "Topic two", "aliases": []},
    ]
    assert json.loads(messages[1]["content"]) == {
        "excerpts": [{"id": "e1", "section_path": "1 Intro", "source_text": "text one"}]
    }
    assert tag.schema(["t1"])["properties"]["excerpts"]["items"]["properties"][
        "topic_ids"
    ]["items"]["enum"] == ["t1"]


# --- batch path ---------------------------------------------------------------


def test_batch_path_collects_then_resends_missing_singly(run_dir, monkeypatch):
    job = {
        "id": "batch-1",
        "status": "in_progress",
        "request_counts": {"total": 2, "completed": 0, "failed": 0},
    }
    output = []

    def handler(request):
        path = request.url.path
        if path.endswith("/files") and request.method == "POST":
            return httpx.Response(200, json={"id": "file-in"})
        if path.endswith("/batches") and request.method == "POST":
            return httpx.Response(200, json={"id": "batch-1", "status": "validating"})
        if path.endswith("/batches/batch-1"):
            return httpx.Response(200, json=job)
        if path.endswith("/files/file-out/content"):
            return httpx.Response(
                200, text="".join(json.dumps(r) + "\n" for r in output)
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
    live = fake_live(monkeypatch, answer)

    assert tag.run(run_dir, "b") == batches.WAITING
    task = store.review_task(SHA, "tag")
    assert task["batch_id"] == "batch-1" and task["requests"] == 2
    rows = [
        json.loads(l)
        for l in (run_dir / "models/tag/input.jsonl").read_text().splitlines()
    ]
    assert [r["custom_id"] for r in rows] == ["b:g0", "b:g1"]
    assert (
        rows[0]["body"]["enable_thinking"] is True
        and rows[0]["body"]["thinking_budget"] == 4096
    )
    assert sent_ids(rows[0]["body"]["messages"]) == [f"e{i}" for i in range(8)]
    with pytest.raises(Exception, match="batch task is open"):
        tag.run(run_dir, "b", live=True)

    job.update(
        status="completed", output_file_id="file-out", created_at=1, completed_at=5
    )
    output.append(
        {
            "custom_id": "b:g0",
            "response": {
                "status_code": 200,
                "request_id": "r0",
                "body": {
                    "choices": [
                        {
                            "finish_reason": "stop",
                            "message": {
                                "content": json.dumps(
                                    answer(rows[0]["body"]["messages"], skip=("e5",))
                                )
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 1000, "completion_tokens": 300},
                },
            },
        }
    )
    output.append(
        {
            "custom_id": "b:g1",
            "response": {"status_code": 500, "body": {}},
            "error": {"code": "x"},
        }
    )
    assert tag.run(run_dir, "b") == 0
    assert [c[1] for c in live] == [["e5"], ["e8"], ["e9"]]
    tags = read_json(run_dir / "tags.json")
    assert tags["batch_id"] == "batch-1" and tags["model_transport"] == "batch"
    assert sorted(tags["tags"]) == [f"e{i}" for i in range(10)]
    receipt = batches.latest_receipt(run_dir, "tag")
    assert receipt["usage"] == {
        "prompt_tokens": 1300,
        "completion_tokens": 330,
        "reasoning_tokens": 0,
    }
    assert receipt["sent_live"] == 3
    assert store.llm_usage(0)["https://alibaba.test/v1/batches"]["calls"] == 1
    live.clear()
    assert tag.run(run_dir, "b") == 0 and live == []
