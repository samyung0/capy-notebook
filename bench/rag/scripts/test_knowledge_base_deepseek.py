"""Offline native Responses conversion, durable replay and retry-accounting checks."""

import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from knowledge_base_batch import PilotError, digest, prepare, read_json, save_json
from knowledge_base_deepseek import run
from knowledge_base_realtime import object_schema, stage_results, structured_request


def fixture(directory, ids=("one",)):
    rows = [
        structured_request(
            key,
            [
                {"role": "system", "content": "Keep source wording."},
                {"role": "user", "content": "Exact source passage: α = 2."},
            ],
            "pilot_test",
            object_schema({"x": {"type": "integer"}}),
        )
        for key in ids
    ]
    prepare(directory, rows)
    return rows


def response(value=None, usage=None, status="completed"):
    return httpx.Response(
        200,
        json={
            "id": "resp-1",
            "model": "deepseek-flash",
            "status": status,
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": json.dumps(
                                value if value is not None else {"x": 2}
                            ),
                        }
                    ],
                }
            ],
            "usage": usage
            if usage is not None
            else {
                "input_tokens": 11,
                "output_tokens": 7,
                "output_tokens_details": {"reasoning_tokens": 0},
            },
        },
        headers={"x-request-id": "request-1"},
    )


def test_native_conversion_shape_and_cached_replay(tmp_path):
    rows = fixture(tmp_path)
    calls = []

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://api.deepseek.com/responses"
        body = json.loads(request.content)
        assert body["model"] == "deepseek-flash"
        assert body["reasoning"] == {"effort": "none"}
        assert body["input"] == rows[0]["body"]["messages"]
        assert body["text"]["format"] == {
            "type": "json_schema",
            "name": "pilot_test",
            "schema": rows[0]["body"]["response_format"]["json_schema"]["schema"],
        }
        assert "response_format" not in body and "enable_thinking" not in body
        assert body["stream"] is False and body["temperature"] == 0
        return response()

    transport = httpx.MockTransport(handler)
    first = run(tmp_path, "dummy", 1, transport=transport)
    assert first["complete"] and first["inherited_successes"] == 0
    state, results = stage_results(tmp_path)
    assert state == first
    entry = results["success"]["one"]
    assert entry["value"] == {"x": 2}
    assert entry["usage"]["prompt_tokens"] == 11
    assert entry["provider_usage"]["input_tokens"] == 11
    assert first["usage"]["reasoning_tokens"] == 0
    assert first["usage"]["cached_tokens"] is None
    native = tmp_path / "realtime/native"
    converted = json.loads((native / "input.jsonl").read_text(encoding="utf8"))
    assert converted["source_request_sha256"] == digest(rows[0])
    assert converted["source_messages_sha256"] == digest(rows[0]["body"]["messages"])
    manifest = read_json(native / "manifest.json")
    assert (
        manifest["source_sha256"]
        == hashlib.sha256((tmp_path / "input.jsonl").read_bytes()).hexdigest()
    )
    receipt = read_json(native / "records" / f"{digest('one')}.json")
    assert (
        receipt["request_wire_sha256"] == hashlib.sha256(calls[0].content).hexdigest()
    )
    assert "dummy" not in json.dumps(receipt)
    assert run(tmp_path, "dummy", 1, transport=transport) == first
    assert len(calls) == 1
    (native / "input.jsonl").write_text("changed", encoding="utf8")
    with pytest.raises(PilotError, match="Frozen comparison input changed"):
        run(tmp_path, "dummy", 1, transport=transport)
    assert len(calls) == 1


def test_invalid_output_is_not_retried_and_explicit_retry_preserves_usage(tmp_path):
    fixture(tmp_path, ("good", "bad"))
    calls = []

    def handler(request):
        calls.append(request)
        return response({"x": 2} if len(calls) != 2 else {"x": "wrong"})

    transport = httpx.MockTransport(handler)
    for _ in range(2):
        with pytest.raises(PilotError, match="failed or uncertain"):
            run(tmp_path, "dummy", 1, transport=transport)
    assert len(calls) == 2
    state, result = stage_results(tmp_path)
    assert set(result["success"]) == {"good"}
    assert result["failed"]["bad"]["error"]["kind"] == "invalid_schema"
    assert state["usage"]["prompt_tokens"] == 22
    complete = run(tmp_path, "dummy", 1, retry_failed=True, transport=transport)
    assert len(calls) == 3 and complete["complete"]
    assert complete["normal_requests"] == 3 and complete["new_requests"] == 1
    assert complete["usage"]["prompt_tokens"] == 33
    assert complete["usage"]["completion_tokens"] == 21
    archived = list((tmp_path / "realtime/native/attempts").glob("*.json"))
    assert len(archived) == 1 and read_json(archived[0])["custom_id"] == "bad"
    assert run(tmp_path, "dummy", 1, retry_failed=True, transport=transport) == complete
    assert len(calls) == 3


def test_uncertain_retry_keeps_unknown_usage_and_sanitizes_errors(tmp_path):
    fixture(tmp_path)
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ReadTimeout("sensitive dummy credential text", request=request)
        return response(usage={"input_tokens": 5, "output_tokens": 3})

    transport = httpx.MockTransport(handler)
    for _ in range(2):
        with pytest.raises(PilotError) as caught:
            run(tmp_path, "dummy", 1, transport=transport)
        assert "sensitive" not in str(caught.value)
    assert len(calls) == 1
    state, _ = stage_results(tmp_path)
    assert state["usage"]["prompt_tokens"] is None
    assert state["usage_missing_attempts"] == 1
    complete = run(tmp_path, "dummy", 1, retry_failed=True, transport=transport)
    assert len(calls) == 2 and complete["complete"]
    assert complete["normal_requests"] == 2
    assert complete["usage_missing_attempts"] == 1
    assert complete["usage"]["prompt_tokens"] == 5
    assert complete["usage"]["completion_tokens"] == 3
    assert complete["usage"]["reasoning_tokens"] is None
    assert complete["usage_reported_attempts"]["prompt_tokens"] == 1
    receipt = read_json(next((tmp_path / "realtime/native/attempts").glob("*.json")))
    assert receipt["status"] == "uncertain"
    assert receipt["error"] == {"kind": "ReadTimeout"}


@pytest.mark.parametrize(
    "kind", ["incomplete", "invalid_http_json", "invalid_shape", "missing_usage"]
)
def test_response_boundaries_preserve_receipts_without_implicit_retry(tmp_path, kind):
    fixture(tmp_path)
    calls = []

    def handler(request):
        calls.append(request)
        if kind == "incomplete":
            return response(status="incomplete")
        if kind == "invalid_http_json":
            return httpx.Response(200, text="not JSON")
        if kind == "invalid_shape":
            return httpx.Response(200, json=[])
        return response(usage={})

    transport = httpx.MockTransport(handler)
    for _ in range(2):
        if kind == "missing_usage":
            state = run(tmp_path, "dummy", 1, transport=transport)
            assert state["complete"] and state["usage_missing_attempts"] == 1
            assert state["usage"]["prompt_tokens"] is None
        else:
            with pytest.raises(PilotError, match="failed or uncertain"):
                run(tmp_path, "dummy", 1, transport=transport)
    assert len(calls) == 1
    assert len(list((tmp_path / "realtime/native/records").glob("*.json"))) == 1


def test_foreign_outputs_and_changed_identity_cannot_be_reused(tmp_path):
    fixture(tmp_path)
    save_json(tmp_path / "results.json", {"success": {"one": {"value": {"x": 999}}}})
    calls = []
    transport = httpx.MockTransport(lambda request: calls.append(request) or response())
    run(tmp_path, "dummy", 1, transport=transport)
    assert stage_results(tmp_path)[1]["success"]["one"]["value"] == {"x": 2}
    assert len(calls) == 1
    state_path = tmp_path / "realtime/state.json"
    state = read_json(state_path)
    state["model"] = "qwen3.8-flash"
    save_json(state_path, state)
    with pytest.raises(PilotError, match="identity differs"):
        run(tmp_path, "dummy", 1, transport=transport)
    assert len(calls) == 1
