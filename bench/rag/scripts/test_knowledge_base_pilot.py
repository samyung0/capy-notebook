"""Offline checks for the local pilot's new batch/provenance boundaries."""

import json
import sys
from pathlib import Path
import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import knowledge_base_pilot as pilot
from knowledge_base_batch import (
    BatchClient,
    PilotError,
    prepare,
    read_json,
    request,
    save_json,
    shard_unsubmitted,
    validate_records,
)
from knowledge_base_pilot import (
    book_identity,
    build_excerpts,
    drawing_records,
    figure_records,
    query_topics,
    sha_file,
    validate_material,
)


def test_provider_dispatch_uses_the_endpoint_and_its_key(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("TOKENHUB", "tokenhub-test")
    monkeypatch.setattr(
        pilot, "run_normal", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    pilot.run_model_stage({"model_provider": "ollama"}, tmp_path, workers=4)
    pilot.run_model_stage({"model_provider": "ollama"}, tmp_path, "tokenhub", workers=2)
    assert calls == [
        (
            (tmp_path, ""),
            {
                "workers": 4,
                "base_url": "http://127.0.0.1:11434/v1",
                "model": "glm-5.3-flash:cloud",
            },
        ),
        (
            (tmp_path, "tokenhub-test"),
            {
                "workers": 2,
                "base_url": "https://tokenhub.tencentcloudmaas.com/v1",
                "model": "glm-5.3-flash",
            },
        ),
    ]
    with pytest.raises(PilotError, match="Unknown pilot model"):
        pilot.run_model_stage({"model_provider": "unknown"}, tmp_path, workers=4)


def test_run_topics_prefers_the_topics_stage_output(tmp_path):
    manifest = {"topics": [{"id": "frozen"}]}
    assert pilot.run_topics(manifest, tmp_path) == [{"id": "frozen"}]
    save_json(tmp_path / "topics.json", {"topics": [{"id": "derived"}]})
    assert pilot.run_topics(manifest, tmp_path) == [{"id": "derived"}]


ENDPOINT = {"base_url": "http://model.test/v1", "model": "glm-test"}


def response(key="a", content=None, finish="stop", status=200):
    return {
        "custom_id": key,
        "response": {
            "status_code": status,
            "body": {
                "choices": [
                    {
                        "finish_reason": finish,
                        "message": {"content": json.dumps(content or {"ok": True})},
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 3},
            },
        },
    }


def test_normal_api_reuses_success_and_disables_thinking(tmp_path):
    from knowledge_base_realtime import run, stage_results

    prepare(
        tmp_path,
        [request(k, [{"role": "user", "content": "JSON"}], 100) for k in ["a", "b"]],
    )
    save_json(tmp_path / "results.json", validate_records(["a", "b"], [response("a")]))
    calls = []

    def handle(req):
        body = json.loads(req.content)
        assert req.url.path.endswith("/chat/completions")
        assert "enable_thinking" not in body and body["stream"] is False
        assert body["model"] == "glm-test" and body["reasoning_effort"] == "low"
        calls.append(body)
        return httpx.Response(200, json=response("b")["response"]["body"])

    for _ in range(2):
        state = run(
            tmp_path,
            "test",
            workers=1,
            transport=httpx.MockTransport(handle),
            **ENDPOINT,
        )
    assert len(calls) == 1 and state["inherited_successes"] == 1
    assert state["usage"]["completion_tokens"] == 3
    assert state["usage"]["reasoning_tokens"] is None
    assert set(stage_results(tmp_path)[1]["success"]) == {"a", "b"}
    save_json(
        tmp_path / "results.json",
        validate_records(["a", "b"], [response("a"), response("b")]),
    )
    run(tmp_path, "test", workers=1, transport=httpx.MockTransport(handle), **ENDPOINT)
    assert len(calls) == 1  # Later Batch collection cannot invalidate a normal run.
    # A changed frozen input must not inherit old results.
    with (tmp_path / "input.jsonl").open("ab") as stream:
        stream.write(b"\n")
    with pytest.raises(PilotError, match="input changed"):
        run(
            tmp_path,
            "test",
            workers=1,
            transport=httpx.MockTransport(handle),
            **ENDPOINT,
        )


def test_normal_api_keeps_uncertain_attempt_without_resending(tmp_path):
    from knowledge_base_realtime import run

    prepare(tmp_path, [request("a", [], 100)])
    calls = []

    def handle(req):
        calls.append(req)
        raise httpx.ReadTimeout("uncertain", request=req)

    with pytest.raises(PilotError, match="failed or uncertain"):
        run(
            tmp_path,
            "test",
            workers=1,
            transport=httpx.MockTransport(handle),
            **ENDPOINT,
        )
    with pytest.raises(PilotError, match="Uncertain normal request"):
        run(
            tmp_path,
            "test",
            workers=1,
            transport=httpx.MockTransport(handle),
            **ENDPOINT,
        )
    assert len(calls) == 1

    def succeed(req):
        calls.append(req)
        return httpx.Response(200, json=response()["response"]["body"])

    state = run(
        tmp_path,
        "test",
        workers=1,
        retry_failed=True,
        timeout_seconds=300,
        transport=httpx.MockTransport(succeed),
        base_url="http://other.test/v1",
        model="glm-other",
    )
    assert len(calls) == 2 and state["complete"]
    assert state["normal_requests"] == 2 and state["usage_missing_attempts"] == 1
    assert len(list((tmp_path / "realtime/attempts").glob("*.json"))) == 1
    # The retry went to another endpoint; the record names it.
    record = read_json(next((tmp_path / "realtime/records").glob("*.json")))
    assert record["model"] == "glm-other" and state["model"] == "glm-other"


def test_normal_api_waits_out_a_429_before_recording_it(tmp_path, monkeypatch):
    import knowledge_base_realtime as realtime

    prepare(tmp_path, [request("a", [], 100)])
    waits, calls = [], []
    monkeypatch.setattr(realtime.time, "sleep", waits.append)
    monkeypatch.setattr(realtime, "RATE_LIMIT_BACKOFF", (1, 2))

    def throttle(req):
        calls.append(req)
        if len(calls) < 3:
            return httpx.Response(429, headers={"retry-after": "7"})
        return httpx.Response(200, json=response()["response"]["body"])

    state = realtime.run(
        tmp_path, "k", workers=1, transport=httpx.MockTransport(throttle), **ENDPOINT
    )
    assert state["complete"] and len(calls) == 3 and waits == [7.0, 7.0]

    def always(req):
        return httpx.Response(429)

    prepare(tmp_path / "b", [request("a", [], 100)])
    with pytest.raises(PilotError, match="failed or uncertain"):
        realtime.run(
            tmp_path / "b",
            "k",
            workers=1,
            transport=httpx.MockTransport(always),
            **ENDPOINT,
        )
    record = read_json(next((tmp_path / "b/realtime/records").glob("*.json")))
    assert record["response"]["status_code"] == 429


def test_prepare_tags_leaves_proposed_topic_optional(tmp_path, monkeypatch):
    corpus = {"excerpts": [{"id": "e1", "section_path": "1 › 1.1", "text": "body"}]}
    monkeypatch.setattr(pilot, "corpora", lambda *_: [corpus])
    save_json(tmp_path / "topics.json", {"topics": [{"id": "t1", "label": "T"}]})
    pilot.prepare_tags({}, tmp_path)
    row = json.loads((tmp_path / "models/tags/input.jsonl").read_text(encoding="utf-8"))
    schema = row["body"]["response_format"]["json_schema"]["schema"]
    assert "proposed_topic" in schema["properties"]
    assert "proposed_topic" not in schema["required"] and "roles" in schema["required"]
    assert schema["properties"]["topic_ids"]["items"]["enum"] == ["t1"]


def test_normal_api_preserves_non_json_http_receipt(tmp_path):
    from knowledge_base_realtime import run

    prepare(tmp_path, [request("a", [], 100)])

    def handle(req):
        return httpx.Response(
            502, text="gateway failure", headers={"x-request-id": "receipt-1"}
        )

    with pytest.raises(PilotError, match="failed or uncertain"):
        run(
            tmp_path,
            "test",
            workers=1,
            transport=httpx.MockTransport(handle),
            **ENDPOINT,
        )
    record = read_json(next((tmp_path / "realtime/records").glob("*.json")))
    assert record["status"] == "received"
    assert record["response"]["status_code"] == 502
    assert record["response"]["request_id"] == "receipt-1"


def test_batch_success_partial_failure_and_identity():
    rows = [response(), response("b", status=429), response("c", finish="length")]
    result = validate_records(["a", "b", "c", "d"], rows)
    assert list(result["success"]) == ["a"]
    assert result["success"]["a"]["usage"]["prompt_tokens"] == 12
    assert set(result["failed"]) == {"b", "c"}
    assert result["missing"] == ["d"]
    for invalid in ([response("unknown")], [response(), response()]):
        with pytest.raises(PilotError, match="unknown or duplicate"):
            validate_records(["a"], invalid)


def test_batch_rejects_invalid_json():
    row = response()
    row["response"]["body"]["choices"][0]["message"]["content"] = "incomplete {"
    assert validate_records(["a"], [row])["failed"]["a"]["kind"] == "invalid_json"


def test_submit_resume_and_collect(tmp_path, monkeypatch):
    requests = [request("a", [{"role": "user", "content": "source excerpt"}], 100)]
    prepare(tmp_path, requests)
    calls = []

    def handler(req):
        calls.append((req.method, req.url.path))
        path = req.url.path
        if path.endswith("/files"):
            return httpx.Response(200, json={"id": "file1"})
        if path.endswith("/batches"):
            return httpx.Response(200, json={"id": "batch1", "status": "validating"})
        if path.endswith("/batches/batch1"):
            return httpx.Response(
                200,
                json={"id": "batch1", "status": "completed", "output_file_id": "out1"},
            )
        if path.endswith("/files/out1/content"):
            return httpx.Response(200, text=json.dumps(response()) + "\n")
        raise AssertionError(path)

    client = BatchClient("dummy", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(
        "knowledge_base_batch.requests.post",
        lambda url, **kwargs: client.http.post(
            "/files", data=kwargs["data"], files=kwargs["files"]
        ),
    )
    try:
        assert client.submit(tmp_path)["batch_id"] == "batch1"
        assert client.submit(tmp_path)["batch_id"] == "batch1"
        assert len(calls) == 2
        assert client.collect(tmp_path)["complete"]
        assert client.collect(tmp_path)["complete"]
        assert sum(path.endswith("/content") for _, path in calls) == 1
        assert not any(path.endswith("/chat/completions") for _, path in calls)
    finally:
        client.close()


def test_uncertain_submission_recovers_without_resubmit(tmp_path):
    state = prepare(tmp_path, [request("a", [], 50)])
    state.update(status="submitting", input_file_id="file1")
    save_json(tmp_path / "state.json", state)
    calls = []

    def handler(req):
        calls.append(req.method)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "existing",
                        "status": "in_progress",
                        "metadata": {"input_sha256": state["input_sha256"]},
                    }
                ],
                "has_more": False,
            },
        )

    client = BatchClient("dummy", transport=httpx.MockTransport(handler))
    try:
        assert client.submit(tmp_path)["batch_id"] == "existing"
        assert calls == ["GET"]
    finally:
        client.close()


def test_unknown_submission_is_not_retried(tmp_path):
    state = prepare(tmp_path, [request("a", [], 50)])
    state["status"] = "submitting"
    save_json(tmp_path / "state.json", state)
    client = BatchClient(
        "dummy",
        transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"data": None, "has_more": False})
        ),
    )
    try:
        with pytest.raises(PilotError, match="0 matching"):
            client.submit(tmp_path)
        assert read_json(tmp_path / "state.json")["status"] == "submitting"
    finally:
        client.close()


def test_failed_and_partial_job_never_mark_complete(tmp_path):
    state = prepare(tmp_path, [request("a", [], 50), request("b", [], 50)])
    state.update(batch_id="batch1", status="in_progress")
    save_json(tmp_path / "state.json", state)
    for status in ("failed", "expired", "completed"):

        def handler(req, status=status):
            if req.url.path.endswith("/content"):
                return httpx.Response(200, text=json.dumps(response()) + "\n")
            return httpx.Response(
                200, json={"status": status, "output_file_id": "out1"}
            )

        client = BatchClient("dummy", transport=httpx.MockTransport(handler))
        try:
            final = client.collect(tmp_path)
            assert not final["complete"]
            assert final["collection"] == {"success": 1, "failed": 0, "missing": 1}
            assert client.submit(tmp_path)["batch_id"] == "batch1"
        finally:
            client.close()


def test_changed_batch_input_refuses_existing_job(tmp_path):
    prepare(tmp_path, [request("a", [], 50)])
    with pytest.raises(PilotError, match="input changed"):
        prepare(tmp_path, [request("b", [], 50)])


def test_credentials_do_not_escape_error():
    client = BatchClient(
        "secret-value",
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                401,
                json={"error": {"code": "InvalidApiKey", "message": "secret-value"}},
            )
        ),
    )
    try:
        with pytest.raises(PilotError) as error:
            client.call("GET", "/batches")
        assert "secret-value" not in str(error.value)
        assert "401" in str(error.value)
    finally:
        client.close()


def test_source_edition_geometry_captions_and_excerpts():
    book = {
        "id": "book",
        "edition": "1",
        "sha256": "abc",
        "source_url": "https://publisher/book",
        "license": "CC BY 4.0",
    }
    assert book_identity(book) != book_identity(dict(book, edition="2"))
    assert book_identity(book) != book_identity(dict(book, sha256="different"))
    blocks = [
        {"type": "text", "text_level": 1, "text": "Probability"},
        {
            "type": "image",
            "page_idx": 4,
            "bbox": [100, 100, 300, 300],
            "image_caption": ["Figure 1. Original author caption."],
        },
    ]
    figures = figure_records(
        blocks, book_identity(book), [{"page": 5, "reason": "cover"}]
    )
    assert figures[0]["page"] == 5 and figures[0]["excluded"]
    assert figures[0]["original_caption"] == ["Figure 1. Original author caption."]
    chunks = [
        {
            "id": "c1",
            "section_path": "Probability",
            "text": "Complete worked example",
            "regions": [
                {"page": 5, "bbox": [100, 100, 300, 300], "space": "page-1000-topleft"}
            ],
        }
    ]
    excerpts = build_excerpts(chunks, book_identity(book), figures)
    assert excerpts[0]["figure_ids"] == [figures[0]["id"]]
    assert excerpts[0]["regions"] == chunks[0]["regions"]
    assert chunks[0]["excerpt_id"] == excerpts[0]["id"]
    blocks[1]["bbox"][0] = float("nan")
    with pytest.raises(PilotError, match="geometry"):
        figure_records(blocks, "id", [])


def test_thin_image_blocks_are_not_figures():
    blocks = [
        # A square-root bar the parser reports as an image block.
        {"type": "image", "page_idx": 10, "bbox": [511.9, 359.5, 763.9, 360.2]},
        {"type": "image", "page_idx": 10, "bbox": [100, 100, 300, 300]},
    ]
    assert [f["id"] for f in figure_records(blocks, "source", [])] == ["fig_source_1"]


def test_vector_diagram_is_a_figure_but_text_frames_rules_and_glyphs_are_not(tmp_path):
    import pymupdf

    pdf = pymupdf.open()
    page = pdf.new_page(width=600, height=800)
    page.draw_line((50, 30), (550, 30))  # running-head rule
    page.draw_circle((300, 250), 60)  # diagram: a circle and two angled lines
    page.draw_line((220, 330), (380, 170))
    page.draw_line((220, 170), (380, 330))
    page.draw_rect((60, 450, 540, 560))  # callout box around text
    page.insert_textbox(
        (70, 460, 530, 550), "Remember: a frame around text is not a figure. " * 5
    )
    # A fraction set as glyph outlines: small filled shapes around a filled bar.
    page.draw_rect((200, 669, 320, 670), color=None, fill=(0, 0, 0))
    for x in (215, 245, 275, 305):
        for y in (655, 684):
            page.draw_circle((x, y), 8, color=None, fill=(0, 0, 0))
    path = tmp_path / "book.pdf"
    pdf.save(path)
    book = {"id": "book", "pdf_path": str(path), "sha256": sha_file(path)}
    blocks = [
        {"type": "text", "text_level": 1, "text": "Circles", "page_idx": 0},
        {"type": "text", "text": "Intro", "page_idx": 0, "bbox": [80, 100, 900, 150]},
        {
            "type": "text",
            "text": "Remember",
            "page_idx": 0,
            "bbox": [117, 575, 883, 687],
        },
    ]
    [figure] = drawing_records(book, blocks, "source", [])
    assert figure["geometry_kind"] == "vector_drawing"
    assert (figure["page"], figure["block_index"]) == (1, 1)
    assert figure["section_path"] == "Circles"
    x0, y0, x1, y1 = figure["bbox"]
    assert abs(x0 - 367) < 3 and abs(y0 - 212) < 3 and abs(x1 - 633) < 3
    assert abs(y1 - 412) < 3
    assert figure["id"] == f"fig_source_p1_{round(x0)}_{round(y0)}"
    region = {"page": 1, "bbox": [80, 100, 900, 150]}
    chunks = [
        {"id": "c", "section_path": "Circles", "text": "Intro", "regions": [region]}
    ]
    assert build_excerpts(chunks, "source", [figure])[0]["figure_ids"] == [figure["id"]]


def test_query_tags_use_catalog_aliases_only():
    topics = [
        {
            "id": "ci",
            "label": "confidence interval",
            "aliases": ["confidence intervals"],
        }
    ]
    assert query_topics("I want confidence intervals for proportions", topics) == ["ci"]
    assert query_topics("I want prediction intervals", topics) == []


def test_vector_chart_caption_keeps_whole_page_capture_and_exact_caption_box():
    blocks = [
        {
            "type": "text",
            "text": "Figure 2.6: A histogram of interest rate.",
            "page_idx": 49,
            "bbox": [200, 810, 790, 850],
        }
    ]
    figure = figure_records(blocks, "source", [])[0]
    assert figure["geometry_kind"] == "caption_page_reference"
    assert figure["bbox"] == [0, 0, 1000, 1000]
    assert figure["caption_bbox"] == [200, 810, 790, 850]
    assert figure["original_caption"] == [blocks[0]["text"]]
    chunks = [
        {
            "id": "caption",
            "section_path": "",
            "text": blocks[0]["text"],
            "regions": [{"page": 50, "bbox": [200, 810, 790, 850]}],
        },
        {
            "id": "unrelated",
            "section_path": "Other",
            "text": "Unrelated text on same page",
            "regions": [{"page": 50, "bbox": [20, 20, 300, 90]}],
        },
    ]
    excerpts = build_excerpts(chunks, "source", [figure])
    assert excerpts[0]["figure_ids"] == [figure["id"]]
    assert excerpts[1]["figure_ids"] == []
    assert (
        figure_records(
            [dict(blocks[0], text="Figure 2.6 shows a histogram.")], "source", []
        )
        == []
    )


def test_material_questions_cannot_escape_declared_provenance():
    context = {
        "excerpt_ids": ["e1", "e2"],
        "figure_ids": ["f2"],
        "figures_by_excerpt": {"e1": [], "e2": ["f2"]},
    }
    value = {
        "title": "Supported study note",
        "limitations": [],
        "answerable": True,
        "excerpt_ids": ["e1"],
        "figure_ids": [],
        "note_markdown": "Supported note",
        "questions": [{"question": "What?", "answer": "This.", "excerpt_ids": ["e1"]}],
    }
    validate_material(value, context)
    value["figure_ids"] = ["f2"]
    with pytest.raises(PilotError, match="figure"):
        validate_material(value, context)
    value["figure_ids"] = []
    for field, bad in (("title", 123), ("limitations", [False])):
        changed = dict(value, **{field: bad})
        with pytest.raises(PilotError, match="schema"):
            validate_material(changed, context)
    for key in ("e2", "unknown"):
        value["questions"][0]["excerpt_ids"] = [key]
        with pytest.raises(PilotError, match="unattributed"):
            validate_material(value, context)
    value["questions"] = []
    value["excerpt_ids"] = []
    with pytest.raises(PilotError, match="provenance"):
        validate_material(value, context)


def test_upload_recovery_does_not_create_a_batch(tmp_path):
    state = prepare(tmp_path, [request("a", [], 50)])
    state["status"] = "uploading"
    save_json(tmp_path / "state.json", state)
    calls = []

    def handler(req):
        calls.append(req.method)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "uploaded",
                        "filename": f"capy-kb-{state['input_sha256']}.jsonl",
                    }
                ]
            },
        )

    client = BatchClient("dummy", transport=httpx.MockTransport(handler))
    try:
        recovered = client.submit(tmp_path)
        assert (
            recovered["input_file_id"] == "uploaded"
            and recovered["status"] == "prepared"
        )
        assert calls == ["GET"]
    finally:
        client.close()


def test_shards_resume_and_collect_without_duplicate_calls(tmp_path, monkeypatch):
    prepare(tmp_path, [request("a", [], 50), request("b", [], 50)])
    shard_unsubmitted(tmp_path, 1)
    uploads = []
    creates = []

    def handler(req):
        path = req.url.path
        if req.method == "POST" and path.endswith("/files"):
            uploads.append(req.content)
            return httpx.Response(200, json={"id": f"file{len(uploads)}"})
        if req.method == "POST":
            creates.append(req.content)
            return httpx.Response(
                200, json={"id": f"batch{len(creates)}", "status": "in_progress"}
            )
        if "/batches/" in path:
            return httpx.Response(
                200,
                json={"status": "completed", "output_file_id": path.rsplit("/", 1)[-1]},
            )
        key = "a" if "batch1" in path else "b"
        return httpx.Response(200, text=json.dumps(response(key)) + "\n")

    client = BatchClient("dummy", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(
        "knowledge_base_batch.requests.post",
        lambda url, **kwargs: client.http.post(
            "/files", data=kwargs["data"], files=kwargs["files"]
        ),
    )
    try:
        assert len(client.submit(tmp_path)["batch_ids"]) == 2
        client.submit(tmp_path)
        assert len(uploads) == len(creates) == 2
        assert client.collect(tmp_path)["complete"]
        assert set(read_json(tmp_path / "results.json")["success"]) == {"a", "b"}
        with pytest.raises(PilotError, match="unsubmitted"):
            shard_unsubmitted(tmp_path, 1)
    finally:
        client.close()


def test_normal_driver_stops_before_downstream_on_model_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(pilot, "prepare_tags", lambda *args: None)

    def fail(*args, **kwargs):
        raise PilotError("model failed")

    monkeypatch.setattr(pilot, "run_normal", fail)
    with pytest.raises(PilotError, match="model failed"):
        pilot.finish_normal(
            {},
            {"model_provider": "ollama"},
            tmp_path,
            tmp_path / "questions.json",
            workers=1,
        )
    state = read_json(tmp_path / "realtime-driver.json")
    assert state["status"] == "failed" and state["steps"] == ["prepare-tags"]


def test_accepted_schema_failures_stay_failed_and_never_become_tags(
    tmp_path, monkeypatch
):
    state = {"complete": False, "status": "failed"}
    results = {
        "success": {},
        "failed": {"toc": {"error": {"kind": "invalid_schema"}}},
        "missing": [],
    }
    monkeypatch.setattr(pilot, "stage_results", lambda *_: (state, results))
    monkeypatch.setattr(pilot, "corpora", lambda *_: [])
    save_json(tmp_path / "models/tags/state.json", {"request_ids": ["toc"]})
    with pytest.raises(PilotError, match="incomplete"):
        pilot.tag_stage_results(tmp_path)
    save_json(tmp_path / "accepted-tag-failures.json", {"request_ids": ["toc"]})
    exported = pilot.apply_tags({"topics": []}, tmp_path)
    assert exported["tags"] == {} and exported["failed_tags"] == results["failed"]
    assert state == {"complete": False, "status": "failed"}
    # Any failure kind is accepted once listed; an unlisted or missing id is not.
    results["failed"]["toc"] = {"kind": "provider_error"}
    pilot.tag_stage_results(tmp_path)
    results["failed"]["other"] = {"kind": "invalid_schema"}
    with pytest.raises(PilotError, match="incomplete"):
        pilot.tag_stage_results(tmp_path)
    del results["failed"]["other"]
    results["missing"] = ["another"]
    with pytest.raises(PilotError, match="incomplete"):
        pilot.tag_stage_results(tmp_path)


def test_normal_api_validates_schema_and_preserves_failed_attempt(tmp_path):
    from knowledge_base_realtime import object_schema, run, structured_request

    schema = object_schema({"role": {"type": "string", "enum": ["formal"]}})
    prepare(tmp_path, [structured_request("a", [], "test_schema", schema)])
    calls = []

    def handle(req):
        body = json.loads(req.content)
        assert body["response_format"]["json_schema"] == {
            "name": "test_schema",
            "strict": True,
            "schema": schema,
        }
        assert "max_tokens" not in body
        calls.append(body)
        value = {"role": "graphs" if len(calls) == 1 else "formal"}
        return httpx.Response(200, json=response(content=value)["response"]["body"])

    transport = httpx.MockTransport(handle)
    with pytest.raises(PilotError, match="failed or uncertain"):
        run(tmp_path, "test", workers=1, transport=transport, **ENDPOINT)
    assert (
        read_json(tmp_path / "realtime/results.json")["failed"]["a"]["kind"]
        == "invalid_schema"
    )
    with pytest.raises(PilotError, match="failed or uncertain"):
        run(tmp_path, "test", workers=1, transport=transport, **ENDPOINT)
    assert len(calls) == 1
    state = run(
        tmp_path, "test", workers=1, transport=transport, retry_failed=True, **ENDPOINT
    )
    assert state["complete"] and state["normal_requests"] == 2


def test_material_export_records_bad_attribution_without_publishing_it(
    tmp_path, monkeypatch
):
    value = {
        "title": "Out of scope",
        "answerable": False,
        "note_markdown": "Insufficient source evidence.",
        "questions": [],
        "excerpt_ids": [],
        "figure_ids": [],
        "limitations": [],
    }
    invalid = dict(value, figure_ids=["figure"])
    results = {"success": {"valid": {"value": value}, "invalid": {"value": invalid}}}
    monkeypatch.setattr(
        pilot, "stage_results", lambda *_: ({"complete": True}, results)
    )
    monkeypatch.setattr(pilot, "corpora", lambda *_: [])
    context = {
        "excerpt_ids": ["excerpt"],
        "figure_ids": ["figure"],
        "figures_by_excerpt": {"excerpt": ["figure"]},
    }
    save_json(
        tmp_path / "material-contexts.json", {"valid": context, "invalid": context}
    )
    report = pilot.export_materials({}, tmp_path)
    assert report == {
        "exported": ["valid"],
        "errors": {"invalid": "Material figure has no attributed source excerpt"},
    }
    assert (tmp_path / "materials/valid.json").exists()
    assert not (tmp_path / "materials/invalid.json").exists()
    assert invalid["figure_ids"] == ["figure"]
