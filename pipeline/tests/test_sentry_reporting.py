"""Real SDK counts, with an in-memory transport and no Sentry network calls."""

import sentry_sdk
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sentry_sdk.transport import Transport

from pipeline import obs
from pipeline.retrieval.workflows import GenerateEmpty
from pipeline.retrieve.service import (
    generate_empty_handler,
    http_error_handler,
    unexpected_error_handler,
)


class LocalTransport(Transport):
    def __init__(self, options):
        super().__init__(options)
        self.events = []

    def capture_envelope(self, envelope):
        for item in envelope.items:
            if item.type == "event":
                self.events.append(item.payload.json)


def test_http_and_stream_failure_ownership(monkeypatch):
    original_init = sentry_sdk.init
    monkeypatch.setenv("SENTRY_DSN", "https://test@example.invalid/1")
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0")
    monkeypatch.setattr(
        sentry_sdk,
        "init",
        lambda **kwargs: original_init(**kwargs, transport=LocalTransport),
    )
    obs.init_sentry("retrieval")
    client = sentry_sdk.get_client()
    transport = client.transport
    app = FastAPI()
    app.add_exception_handler(Exception, unexpected_error_handler)
    app.add_exception_handler(HTTPException, http_error_handler)
    app.add_exception_handler(GenerateEmpty, generate_empty_handler)

    @app.get("/failure/{kind}")
    async def failure(kind: str):
        if kind == "empty":
            raise GenerateEmpty("no output")
        if kind == "handled":
            try:
                raise RuntimeError("provider failed")
            except RuntimeError as exc:
                raise HTTPException(502, {"code": "provider_error"}) from exc
        if kind == "busy":
            raise HTTPException(503, {"code": "provider_busy"})
        if kind == "invalid":
            raise HTTPException(422, "invalid")
        if kind == "upstream":
            raise obs.with_event_id(RuntimeError("already reported"), "a" * 32)
        raise RuntimeError("unexpected")

    try:
        with TestClient(app, raise_server_exceptions=False) as http:
            for kind, status, count in [
                ("empty", 502, 1),
                ("handled", 502, 1),
                ("unexpected", 500, 1),
                ("busy", 503, 0),
                ("invalid", 422, 0),
                ("upstream", 500, 0),
            ]:
                transport.events.clear()
                response = http.get(
                    f"/failure/{kind}", headers={"X-Pipeline-Secret": "private"}
                )
                assert response.status_code == status
                assert len(transport.events) == count, (kind, transport.events)
                for event in transport.events:
                    headers = event.get("request", {}).get("headers", {})
                    assert not any(
                        name.lower() == "x-pipeline-secret" for name in headers
                    )
                    for value in event.get("exception", {}).get("values", []):
                        assert all(
                            not frame.get("vars")
                            for frame in value.get("stacktrace", {}).get("frames", [])
                        )
                if count:
                    assert (
                        response.headers[obs.ERROR_EVENT_HEADER]
                        == transport.events[0]["event_id"]
                    )
                if kind == "upstream":
                    assert response.headers[obs.ERROR_EVENT_HEADER] == "a" * 32
        transport.events.clear()
        primary = RuntimeError("stream failed")
        event = obs.reported_event({"type": "error"}, primary)
        obs.capture_error(primary)
        wrapped = RuntimeError("relay")
        wrapped.__cause__ = primary
        obs.capture_error(wrapped)
        obs.capture_error(RuntimeError("cleanup failed"))
        assert len(transport.events) == 2
        assert event["sentryEventId"] == transport.events[0]["event_id"]
    finally:
        client.close()
        sentry_sdk.get_global_scope().set_client(None)
