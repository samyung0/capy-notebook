from __future__ import annotations

from pipeline.parse import mineru_lite


class _Response:
    def __init__(self, status_code: int, text: str = ""):
        self.status_code = status_code
        self.text = text


def test_parse_blob_relays_and_retries_once(monkeypatch):
    from pipeline.store import blobstore

    monkeypatch.setattr(mineru_lite.cfg, "mineru_relay_url", "https://relay.example")
    monkeypatch.setattr(mineru_lite.cfg, "mineru_relay_token", "secret")
    monkeypatch.setattr(mineru_lite.cfg, "mineru_relay_timeout", 10)
    monkeypatch.setattr(
        mineru_lite, "_create_task", lambda _name: ("task-1", "https://upload.example")
    )
    monkeypatch.setattr(mineru_lite, "_poll_result", lambda task, _cb: f"done:{task}")
    monkeypatch.setattr(
        blobstore, "presign_get", lambda *_args: "https://b2.example/source"
    )
    monkeypatch.setattr(mineru_lite.time, "sleep", lambda _seconds: None)

    responses = iter([_Response(502, "temporary"), _Response(200)])
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return next(responses)

    monkeypatch.setattr(mineru_lite.requests, "post", fake_post)
    result = mineru_lite.parse_blob("sources/blob.pdf", "doc.pdf")

    assert result == "done:task-1"
    assert len(calls) == 2
    assert calls[0][1]["headers"]["Authorization"] == "Bearer secret"
    assert calls[0][1]["json"]["maxBytes"] == 10 << 20


def test_parse_blob_uses_legacy_local_path_without_relay(monkeypatch):
    from pipeline.store import blobstore

    cleaned = []
    monkeypatch.setattr(mineru_lite.cfg, "mineru_relay_url", "")
    monkeypatch.setattr(
        blobstore,
        "fetch_local",
        lambda _path: ("local.pdf", lambda: cleaned.append(True)),
    )
    monkeypatch.setattr(
        mineru_lite,
        "parse_file",
        lambda path, name, _cb: f"{path}:{name}",
    )

    assert mineru_lite.parse_blob("sources/blob.pdf", "doc.pdf") == "local.pdf:doc.pdf"
    assert cleaned == [True]
