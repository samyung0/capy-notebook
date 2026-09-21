"""Offline batch transport, frozen review inputs and advisory collection."""

import json

import httpx
import pytest
import qwen_batch as reviews


def prepared(tmp_path, count=1, *, thinking=True):
    paths = []
    for number in range(count):
        packet = reviews.samples.load_case("02-book-control")
        packet["case_id"] = f"case-{number}"
        path = tmp_path / f"source-{number}.json"
        reviews.batch.save_json(path, packet)
        paths.append(path)
    directory = tmp_path / "batch"
    manifest = reviews.prepare(directory, paths, thinking=thinking)
    return directory, manifest


def response(directory, entry):
    packet = reviews.batch.read_json(directory / entry["packet"])
    review = {
        "case_id": entry["case_id"],
        "review_status": "pass",
        "reviewed_ids": packet["assignment"]["target_ids"],
        "findings": [],
        "missing_evidence": [],
    }
    return {
        "custom_id": entry["custom_id"],
        "error": None,
        "response": {
            "status_code": 200,
            "request_id": "request-1",
            "body": {
                "model": "qwen3.8-max",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {
                            "content": json.dumps(review),
                            "reasoning_content": "saved reasoning",
                        },
                    }
                ],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50},
            },
        },
    }


@pytest.mark.parametrize("thinking", [False, True])
def test_prepare_offline_freezes_packets_prompt_and_uncapped_strict_requests(
    tmp_path, monkeypatch, thinking
):
    def forbidden(*args, **kwargs):
        pytest.fail("Preparation touched credentials or network")

    monkeypatch.setattr(reviews, "dotenv_values", forbidden)
    monkeypatch.setattr(httpx, "Client", forbidden)
    directory, manifest = prepared(tmp_path, 2, thinking=thinking)
    rows = [
        json.loads(line)
        for line in (directory / "input.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert len({row["custom_id"] for row in rows}) == 2
    assert reviews.batch.read_json(directory / "state.json")["model"] == "qwen3.8-max"
    for row, entry in zip(rows, manifest["requests"]):
        body = row["body"]
        assert body["enable_thinking"] is thinking
        assert (
            not {"max_tokens", "max_completion_tokens", "thinking_budget"} & body.keys()
        )
        assert body["response_format"]["json_schema"]["strict"] is True
        assert json.loads(body["messages"][1]["content"]) == reviews.batch.read_json(
            directory / entry["packet"]
        )
        assert "must_find" not in json.dumps(body)
    # An async job never consults mutable original packet paths again.
    (tmp_path / "source-0.json").write_text("changed", encoding="utf-8")
    assert reviews.verify_inputs(directory) == manifest
    with pytest.raises(FileExistsError):
        reviews.prepare(directory, [tmp_path / "source-1.json"], thinking=thinking)
    (directory / "prompt/system-prompt.txt").write_text("changed", encoding="utf-8")
    with pytest.raises(reviews.batch.PilotError, match="Frozen batch input changed"):
        reviews.verify_inputs(directory)


def test_batch_rejects_mixed_models_and_thinking(tmp_path):
    rows = [reviews.batch.request("a", [], 50), reviews.batch.request("b", [], 50)]
    rows[1]["body"]["model"] = "qwen3.8-max"
    with pytest.raises(reviews.batch.PilotError, match="one model"):
        reviews.batch.prepare(tmp_path, rows)
    rows[1]["body"]["model"] = rows[0]["body"]["model"]
    rows[1]["body"]["enable_thinking"] = True
    with pytest.raises(reviews.batch.PilotError, match="one thinking"):
        reviews.batch.prepare(tmp_path, rows)


def test_submit_once_and_resume_from_saved_batch_id(tmp_path, monkeypatch):
    directory, _ = prepared(tmp_path)
    calls = []

    def handler(request):
        calls.append(request)
        assert request.method == "POST" and request.url.path.endswith("/batches")
        assert json.loads(request.content)["completion_window"] == "24h"
        return httpx.Response(200, json={"id": "batch-1", "status": "validating"})

    def client_for(*args):
        client = reviews.batch.BatchClient(
            "test", transport=httpx.MockTransport(handler)
        )
        monkeypatch.setattr(
            client, "upload", lambda payload, filename: {"id": "file-1"}
        )
        return client

    monkeypatch.setattr(reviews, "client_for", client_for)
    assert reviews.main(["submit", "--run", str(directory)]) == 0
    assert reviews.main(["submit", "--run", str(directory)]) == 0
    assert len(calls) == 1
    assert reviews.batch.read_json(directory / "batch.json")["id"] == "batch-1"


@pytest.mark.parametrize("status", ["completed", "expired", "failed", "cancelled"])
def test_poll_stores_out_of_order_partial_responses_and_warnings(
    tmp_path, monkeypatch, status
):
    directory, manifest = prepared(tmp_path, 4)
    entries = manifest["requests"]
    state = reviews.batch.read_json(directory / "state.json")
    state.update(batch_id="batch-1", status="in_progress")
    reviews.batch.save_json(directory / "state.json", state)
    clean = response(directory, entries[0])
    warning = response(directory, entries[1])
    value = json.loads(warning["response"]["body"]["choices"][0]["message"]["content"])
    value["reviewed_ids"] = ["wrong-target"]
    warning["response"]["body"]["choices"][0]["message"]["content"] = json.dumps(value)
    failure = {
        "custom_id": entries[2]["custom_id"],
        "response": None,
        "error": {"code": "input_error"},
    }
    downloads = []

    def handler(request):
        assert request.method == "GET"
        if request.url.path.endswith("/batches/batch-1"):
            return httpx.Response(
                200,
                json={
                    "id": "batch-1",
                    "status": status,
                    "output_file_id": "output",
                    "error_file_id": "errors",
                    "errors": {"data": []},
                },
            )
        downloads.append(request.url.path)
        rows = (
            [warning, clean]
            if request.url.path.endswith("/output/content")
            else [failure]
        )
        return httpx.Response(200, text="\n".join(json.dumps(row) for row in rows))

    def client_for(*args):
        return reviews.batch.BatchClient("test", transport=httpx.MockTransport(handler))

    monkeypatch.setattr(reviews, "client_for", client_for)
    assert reviews.main(["poll", "--run", str(directory)]) == 1
    assert len(downloads) == 2
    summary = reviews.batch.read_json(directory / "summary.json")
    assert summary["counts"] == {"returned": 2, "provider_error": 1, "missing": 1}
    assert summary["contract_warnings"] == 1
    assert all(row["adjudication"] == "pending" for row in summary["responses"])
    for entry in entries[:2]:
        saved = directory / "responses" / entry["custom_id"]
        assert (
            reviews.batch.read_json(saved / "review.json")["case_id"]
            == entry["case_id"]
        )
        assert (
            reviews.batch.read_json(saved / "response.json")["response"]["body"][
                "choices"
            ][0]["message"]["reasoning_content"]
            == "saved reasoning"
        )
    # Collection can be repeated offline using the frozen schema even after the
    # repo's current prompt folder or credentials are unavailable.
    monkeypatch.setattr(reviews.samples, "FIXTURES", tmp_path / "absent")
    monkeypatch.setattr(
        reviews, "client_for", lambda *args: pytest.fail("already collected")
    )
    assert reviews.main(["poll", "--run", str(directory)]) == 1


@pytest.mark.parametrize("interruption", ["timeout", 429, 503])
def test_watch_reads_every_ten_minutes_and_retains_advice(
    tmp_path, monkeypatch, interruption
):
    directory, manifest = prepared(tmp_path)
    state = reviews.batch.read_json(directory / "state.json")
    state.update(batch_id="batch-1", status="in_progress")
    reviews.batch.save_json(directory / "state.json", state)
    row = response(directory, manifest["requests"][0])
    value = json.loads(row["response"]["body"]["choices"][0]["message"]["content"])
    # A content suggestion is not a failed batch and never triggers a repair.
    value.update(
        review_status="incomplete",
        missing_evidence=[
            {
                "target_ids": value["reviewed_ids"],
                "required": "An optional clarification for a later reviewer.",
            }
        ],
    )
    row["response"]["body"]["choices"][0]["message"]["content"] = json.dumps(value)
    calls, sleeps = [], []

    def handler(request):
        assert request.method == "GET"
        calls.append(request.url.path)
        if len(calls) == 1:
            if interruption == "timeout":
                raise httpx.ReadTimeout("temporary", request=request)
            return httpx.Response(interruption, json={"error": {"code": "Unavailable"}})
        if len(calls) == 2:
            return httpx.Response(200, json={"id": "batch-1", "status": "in_progress"})
        if len(calls) == 3:
            return httpx.Response(
                200,
                json={
                    "id": "batch-1",
                    "status": "completed",
                    "output_file_id": "output",
                },
            )
        return httpx.Response(200, text=json.dumps(row))

    monkeypatch.setattr(reviews.time, "sleep", sleeps.append)
    monkeypatch.setattr(
        reviews,
        "client_for",
        lambda *args: reviews.batch.BatchClient(
            "test", transport=httpx.MockTransport(handler)
        ),
    )
    assert reviews.main(["poll", "--run", str(directory), "--watch"]) == 0
    assert sleeps == [600, 600]
    summary = reviews.batch.read_json(directory / "summary.json")
    assert summary["responses"][0]["review_status"] == "incomplete"
    assert reviews.batch.read_json(directory / "poll.json")["next_poll_seconds"] is None


def test_watch_stops_on_permanent_rejection_and_never_retries_submit(
    tmp_path, monkeypatch
):
    directory, _ = prepared(tmp_path)
    state = reviews.batch.read_json(directory / "state.json")
    state.update(batch_id="batch-1", status="in_progress")
    reviews.batch.save_json(directory / "state.json", state)
    calls = []

    def handler(request):
        calls.append(request.method)
        return httpx.Response(
            401 if request.method == "GET" else 503,
            json={"error": {"code": "Rejected"}},
        )

    monkeypatch.setattr(
        reviews.time, "sleep", lambda _: pytest.fail("permanent error retried")
    )
    client = reviews.batch.BatchClient("test", transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(reviews.batch.PilotError, match="401"):
            reviews.poll(directory, client, watch=True)
        assert calls == ["GET"]
        with pytest.raises(reviews.batch.PilotError) as rejected:
            client.call("POST", "/batches")
        assert not isinstance(rejected.value, reviews.batch.BatchTransportError)
    finally:
        client.close()


def test_saved_endpoint_cannot_drift(tmp_path, monkeypatch):
    directory, _ = prepared(tmp_path)
    monkeypatch.setenv("ALIBABA_API_KEY", "test-key")
    monkeypatch.setenv("ALIBABA_BASE_URL", "https://example.test/v1/")
    client = reviews.client_for(directory, None)
    client.close()
    assert (
        reviews.batch.read_json(directory / "state.json")["base_url"]
        == "https://example.test/v1"
    )
    monkeypatch.setenv("ALIBABA_BASE_URL", "https://other.test/v1")
    with pytest.raises(reviews.batch.PilotError, match="saved endpoint"):
        reviews.client_for(directory, None)
    assert "test-key" not in (directory / "state.json").read_text()
